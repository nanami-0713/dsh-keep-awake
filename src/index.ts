/**
 * @dsh-external/dsh-keep-awake — host half。
 *
 * 负责：
 *   1. 把用户开关意图持久化到 $DSH_HOME/plugins/dsh-keep-awake/config.json；
 *   2. 执行 `pmset -a disablesleep 0/1`（免密 sudo → osascript 授权框 依次回退）；
 *   3. 在 webserver 上注册同源 API，供设置页「通用」里的开关行读写状态。
 *
 * 安全边界：
 *   - 只接受 POST application/json，且 Host 头必须是回环地址；
 *   - 提权命令全部由固定参数数组构成，值只能是 0/1，绝不经过 shell 拼接；
 *   - 卸载/重启插件不会擅自把系统改回休眠：只有用户明确点“关”才执行 0。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { KeepAwakeError, PowerManager } from './power.js'
import {
  DEFAULT_CONFIG,
  PLUGIN_ID,
  SET_API_PATH,
  STATE_API_PATH,
  SYNC_API_PATH,
  normalizeConfig,
  type ApiEnvelope,
  type KeepAwakeConfig,
  type KeepAwakeState,
} from './shared.js'

export const name = PLUGIN_ID
export const inject = ['webServer']

/** POST body 上限：只需要一个布尔字段，4KB 已经非常宽裕。 */
const MAX_BODY_BYTES = 4 * 1024

const manager = new PowerManager()

let lastSyncError: string | undefined

/** 同一时刻只允许一个写系统设置的操作在跑。 */
let operationTail: Promise<unknown> = Promise.resolve()
let busy = false
/** 插件被卸载/热重载后，已排队但未启动的系统写操作直接取消。 */
let disposed = false

function pluginDataDir(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'plugins', 'dsh-keep-awake')
}

function configPath(): string {
  return join(pluginDataDir(), 'config.json')
}

async function loadConfig(): Promise<KeepAwakeConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    return normalizeConfig(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function saveConfig(config: KeepAwakeConfig): Promise<void> {
  const file = configPath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    if (disposed) throw new KeepAwakeError('DISPOSED', '插件已卸载，本次系统操作已取消')
    busy = true
    try {
      return await task()
    } finally {
      busy = false
    }
  }
  const promise = operationTail.then(run, run)
  operationTail = promise.then(
    () => undefined,
    () => undefined,
  )
  return promise
}

async function buildState(): Promise<KeepAwakeState> {
  const config = await loadConfig()
  const supported = manager.isSupported()
  const state: KeepAwakeState = {
    platform: process.platform,
    supported,
    enabled: config.enabled,
    actual: null,
    updating: busy,
    privilege: { root: manager.isRoot(), passwordlessSudo: false, osascript: manager.hasOsascript() },
    battery: { source: 'unknown', percent: null },
    message: '',
  }

  if (!supported) {
    state.message = '合盖不休眠仅支持 macOS；当前系统不会执行 pmset 命令。'
    return state
  }

  try {
    state.actual = await manager.readSleepDisabled()
  } catch (error) {
    state.actual = null
    state.error = error instanceof Error ? error.message : String(error)
  }

  state.battery = await manager.readBattery()
  state.privilege.passwordlessSudo = await manager.canUsePasswordlessSudo()

  if (busy) {
    state.message = '正在应用系统设置（如需授权请在弹出的 macOS 对话框中确认）…'
  } else if (state.error) {
    state.message = '系统状态读取失败，请检查 pmset 是否可用。'
  } else if (config.enabled && state.actual) {
    state.message = '系统已保持唤醒：合盖不会休眠，agent 任务与手机遥控持续在线。'
  } else if (config.enabled && !state.actual) {
    state.message = '开关已开启，但系统尚未生效（等待授权或重启后需要重新授权）。'
    state.error = lastSyncError
  } else if (!config.enabled && state.actual) {
    state.message = lastSyncError
      ? '开关已关闭，但系统尚未恢复休眠：关闭操作未生效。'
      : '开关已关闭，但系统当前仍被保持唤醒（可能是其他工具设置，本插件不会擅自关闭）。'
    state.error = lastSyncError
  } else {
    state.message = '已关闭：合盖后按 macOS 正常策略休眠。'
  }
  return state
}

/**
 * 把系统状态对齐到 target，并持久化用户意图。
 * 先保存意图再执行：即使这次授权被取消，重启后插件仍会继续尝试对齐。
 */
async function applyTarget(target: boolean): Promise<KeepAwakeState> {
  try {
    // 保存意图 + 改系统状态放在同一个串行队列里，连续快速切换时按请求到达顺序生效。
    await enqueue(async () => {
      const config = await loadConfig()
      config.enabled = target
      await saveConfig(config)
      await manager.setSleepDisabled(target)
    })
    lastSyncError = undefined
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error)
  }
  return buildState()
}

/**
 * 启动后/点击“重新授权”时调用：只负责把“已开启”的意图重新对齐到系统。
 * 意图为“关闭”时不动系统——避免覆盖其他工具设置的 disablesleep。
 */
async function syncToConfig(): Promise<KeepAwakeState> {
  try {
    await enqueue(async () => {
      // 在队列里重新读意图，避免用户刚把开关关掉时，排队中的 sync 又把系统打开。
      const config = await loadConfig()
      if (config.enabled) await manager.setSleepDisabled(true)
    })
    lastSyncError = undefined
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error)
  }
  return buildState()
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, message: string, state?: KeepAwakeState): void {
  const envelope: ApiEnvelope<KeepAwakeState> = { ok: false, error: message, code, state }
  sendJson(res, status, envelope)
}

function readBodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体超过大小上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 这些 API 只服务本机回环地址：Host 头 + 实际连接两端都要是回环。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false
  const remote = req.socket.remoteAddress
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** 严格 JSON 判定：application/json 可带参数，但拒绝 application/jsonp 之类前缀。 */
export function isJsonRequest(req: IncomingMessage): boolean {
  return /^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))
}

async function handleState(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    sendError(res, 403, 'FORBIDDEN', '只允许本机回环地址访问')
    return
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    sendError(res, 405, 'METHOD_NOT_ALLOWED', '只允许 GET')
    return
  }
  const state = await buildState()
  sendJson(res, 200, { ok: true, state } satisfies ApiEnvelope<KeepAwakeState>)
}

async function handleSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    sendError(res, 403, 'FORBIDDEN', '只允许本机回环地址访问')
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    sendError(res, 405, 'METHOD_NOT_ALLOWED', '只允许 POST')
    return
  }
  // 强制 JSON：普通表单无法伪造该 content-type，浏览器会先发 CORS preflight，
  // 而本服务不返回任何 CORS 许可，第三方网页无法跨源触发开关。
  if (!isJsonRequest(req)) {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json')
    return
  }

  let parsed: unknown
  try {
    const body = await readBodyBuffer(req, MAX_BODY_BYTES)
    parsed = JSON.parse(body.toString('utf8'))
  } catch (error) {
    sendError(res, 400, 'INVALID_JSON', error instanceof Error ? error.message : '请求体不是合法 JSON')
    return
  }

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { enabled?: unknown }).enabled !== 'boolean') {
    sendError(res, 400, 'INVALID_ARGUMENT', 'enabled 必须是布尔值')
    return
  }

  try {
    const state = await applyTarget((parsed as { enabled: boolean }).enabled)
    if (state.error) {
      sendError(res, 409, 'APPLY_FAILED', state.error, state)
      return
    }
    sendJson(res, 200, { ok: true, state } satisfies ApiEnvelope<KeepAwakeState>)
  } catch (error) {
    const state = await buildState()
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof KeepAwakeError ? error.code : 'INTERNAL'
    sendError(res, 500, code, message, state)
  }
}

async function handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    sendError(res, 403, 'FORBIDDEN', '只允许本机回环地址访问')
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    sendError(res, 405, 'METHOD_NOT_ALLOWED', '只允许 POST')
    return
  }
  if (!isJsonRequest(req)) {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 application/json')
    return
  }
  const state = await syncToConfig()
  if (state.error) {
    sendError(res, 409, 'SYNC_FAILED', state.error, state)
    return
  }
  sendJson(res, 200, { ok: true, state } satisfies ApiEnvelope<KeepAwakeState>)
}

export function apply(ctx: Context): void {
  // 同一模块实例可能被停止后再次 apply（重载不走模块缓存清空时）：重置生命周期标志。
  disposed = false
  ctx.inject(['webServer'], (httpCtx) => {
    const web: WebServer = httpCtx.webServer
    httpCtx.effect(() => {
      const disposeState = web.register({
        kind: 'exact',
        path: STATE_API_PATH,
        handler: (req, res) => handleState(req, res),
      })
      const disposeSet = web.register({
        kind: 'exact',
        path: SET_API_PATH,
        handler: (req, res) => handleSet(req, res),
      })
      const disposeSync = web.register({
        kind: 'exact',
        path: SYNC_API_PATH,
        handler: (req, res) => handleSync(req, res),
      })
      ctx.logger?.info?.(`[${PLUGIN_ID}] API ready: ${STATE_API_PATH} / ${SET_API_PATH} / ${SYNC_API_PATH}`)

      // 延迟到应用就绪后再对齐，避免和启动抢资源；若弹出授权框用户会看到原因。
      const timer = setTimeout(() => {
        void syncToConfig().then((state) => {
          if (state.enabled && !state.actual) {
            ctx.logger?.warn?.(`[${PLUGIN_ID}] enabled but system not awake yet: ${state.error ?? 'awaiting authorization'}`)
          }
        })
      }, 2500)
      timer.unref?.()

      return () => {
        disposed = true
        clearTimeout(timer)
        manager.abort()
        disposeState()
        disposeSet()
        disposeSync()
      }
    }, `${PLUGIN_ID}: http api`)
  })
}
