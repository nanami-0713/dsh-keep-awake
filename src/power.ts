/**
 * @dsh-external/dsh-keep-awake — macOS 电源管理（host 专用）。
 *
 * 唯一的目标系统开关是 `pmset -a disablesleep 0/1`（kernel 的
 * SleepDisabled 标志）。普通 caffeinate / IOKit power assertion 只能挡“空闲
 * 休眠”，无法挡“合盖”这个硬件触发；`disablesleep` 才能让合盖后继续运行。
 *
 * 提权路径（按顺序）：
 *   1. 后端进程本身是 root → 直接执行 pmset；
 *   2. 用户安装过 scripts/install-sudoers.sh → `sudo -n` 免密执行；
 *   3. 否则用 osascript `do shell script ... with administrator privileges`
 *      弹出 macOS 授权框（每次切换都需要用户输密码/指纹）。
 *
 * 所有命令都用参数数组构造，不经过 shell 拼接。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { BatteryStatus } from './shared.js'

export const PMSET = '/usr/bin/pmset'
export const SUDO = '/usr/bin/sudo'
export const OSASCRIPT = '/usr/bin/osascript'

/** 状态读取超时：pmset -g 是本地只读命令。 */
export const STATUS_TIMEOUT_MS = 10_000
/** 提权后的写命令超时：sudo/osascript 都可能等待用户。 */
export const APPLY_TIMEOUT_MS = 10 * 60_000

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOptions {
  timeoutMs?: number
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: RunOptions,
) => Promise<CommandResult>

function runSpawn(
  file: string,
  args: string[],
  options: RunOptions | undefined,
  onChild?: (child: ChildProcess) => void,
): Promise<CommandResult> {
  const timeoutMs = options?.timeoutMs ?? STATUS_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    onChild?.(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** 生产 runner：spawn 子进程、收集 stdout/stderr、超时 kill。 */
export const defaultRunner: CommandRunner = (file, args, options = {}) =>
  runSpawn(file, args, options)

export class KeepAwakeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KeepAwakeError'
    this.code = code
  }
}

/**
 * 解析 `pmset -g` 里的 SleepDisabled 行。
 * 返回 1/0；某些 macOS 只在值为 1 时打印该行，所以“没有该行”按 0 处理。
 */
export function parseSleepDisabled(stdout: string): 0 | 1 {
  // pmset -g 的键列左对齐但整行有一个前导空格，且用 tab 对齐，所以允许前导空白。
  const match = stdout.match(/^\s*SleepDisabled\s+([01])\s*$/m)
  return match?.[1] === '1' ? 1 : 0
}

/** 解析 `pmset -g batt` 的电源来源与电量百分比。 */
export function parseBattery(stdout: string): BatteryStatus {
  const sourceMatch = stdout.match(/Now drawing from '([^']+)'/i)
  const sourceText = sourceMatch?.[1]?.toLowerCase() ?? ''
  let source: BatteryStatus['source'] = 'unknown'
  if (sourceText.includes('ac')) source = 'ac'
  else if (sourceText.includes('battery')) source = 'battery'
  else if (sourceText.includes('ups')) source = 'ups'

  const percentMatch = stdout.match(/(\d{1,3})%/)
  const percentValue = percentMatch ? Number.parseInt(percentMatch[1], 10) : null
  const percent =
    percentValue === null || !Number.isFinite(percentValue) || percentValue < 0 || percentValue > 100
      ? null
      : percentValue

  return { source, percent }
}

/** 单实例进程内缓存 `sudo -n` 探测结果，避免每个请求都 spawn 一次。 */
export class PowerManager {
  private sudoCache: { value: boolean; at: number } | null = null
  private activeChildren = new Set<ChildProcess>()
  private readonly platform: NodeJS.Platform
  private readonly run: CommandRunner

  constructor(platform: NodeJS.Platform = process.platform, run?: CommandRunner) {
    this.platform = platform
    // 生产环境走带句柄跟踪的 runner，插件被热重载/卸载时可以杀掉挂起的授权框。
    this.run = run ?? ((file, args, options) => runSpawn(file, args, options, (child) => {
      this.activeChildren.add(child)
      child.once('close', () => {
        this.activeChildren.delete(child)
      })
      child.once('error', () => {
        this.activeChildren.delete(child)
      })
    }))
  }

  /** 终止所有仍在运行的子进程（授权框挂着、插件被卸载/热重载时调用）。 */
  abort(): void {
    for (const child of [...this.activeChildren]) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
    this.activeChildren.clear()
  }

  isSupported(): boolean {
    return this.platform === 'darwin' && existsSync(PMSET)
  }

  hasOsascript(): boolean {
    return this.platform === 'darwin' && existsSync(OSASCRIPT)
  }

  isRoot(): boolean {
    return typeof process.getuid === 'function' && process.getuid() === 0
  }

  async readSleepDisabled(): Promise<boolean> {
    const result = await this.run(PMSET, ['-g'], { timeoutMs: STATUS_TIMEOUT_MS })
    if (result.code !== 0) {
      const detail = result.timedOut ? '读取超时' : result.stderr.trim() || `exit ${result.code}`
      throw new KeepAwakeError('STATUS_FAILED', `pmset -g 失败：${detail}`)
    }
    return parseSleepDisabled(result.stdout) === 1
  }

  async readBattery(): Promise<BatteryStatus> {
    try {
      const result = await this.run(PMSET, ['-g', 'batt'], { timeoutMs: STATUS_TIMEOUT_MS })
      if (result.code === 0) return parseBattery(result.stdout)
    } catch {
      /* battery status is advisory only */
    }
    return { source: 'unknown', percent: null }
  }

  async canUsePasswordlessSudo(): Promise<boolean> {
    const now = Date.now()
    if (this.sudoCache && now - this.sudoCache.at < 30_000) return this.sudoCache.value
    let value = false
    try {
      // 优先快速探测：用户有更宽的免密 sudo 时一步到位。
      const probe = await this.run(SUDO, ['-n', '/usr/bin/true'], { timeoutMs: STATUS_TIMEOUT_MS })
      value = probe.code === 0
      if (!value) {
        // 再识别本插件安装的“仅两条固定 pmset 命令”窄规则：
        // sudo -n /usr/bin/true 会被窄规则拒绝，但 sudo -l 会列出 NOPASSWD 条目。
        // 注意 sudo -l 把同一条规则的两个命令合并成一行：
        //   (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
        // 因此按“同一行同时含 NOPASSWD: 与两条固定命令”判断。
        const listing = await this.run(SUDO, ['-n', '-l'], { timeoutMs: STATUS_TIMEOUT_MS })
        value =
          listing.code === 0 &&
          listing.stdout.split('\n').some(
            (line) =>
              line.includes('NOPASSWD:') &&
              line.includes('/usr/bin/pmset -a disablesleep 0') &&
              line.includes('/usr/bin/pmset -a disablesleep 1'),
          )
      }
    } catch {
      value = false
    }
    this.sudoCache = { value, at: now }
    return value
  }

  /**
   * 把 SleepDisabled 设置成 target。
   * 已在目标值上时直接返回，不触发任何提权（这也是测试/幂等的关键）。
   */
  async setSleepDisabled(target: boolean): Promise<{ changed: boolean; method: string }> {
    if (!this.isSupported()) {
      throw new KeepAwakeError('UNSUPPORTED_PLATFORM', '合盖不休眠仅支持 macOS')
    }

    const before = await this.readSleepDisabled()
    if (before === target) return { changed: false, method: 'no-op' }

    const value = target ? '1' : '0'
    let method = 'pmset'

    try {
      if (this.isRoot()) {
        method = 'root'
        const result = await this.run(PMSET, ['-a', 'disablesleep', value], { timeoutMs: APPLY_TIMEOUT_MS })
        if (result.code !== 0) {
          throw new KeepAwakeError(
            'COMMAND_FAILED',
            result.timedOut ? 'pmset 执行超时' : `pmset 失败：${result.stderr.trim() || `exit ${result.code}`}`,
          )
        }
      } else if (await this.canUsePasswordlessSudo()) {
        method = 'sudo-n'
        const result = await this.run(SUDO, ['-n', PMSET, '-a', 'disablesleep', value], { timeoutMs: APPLY_TIMEOUT_MS })
        if (result.code !== 0) {
          throw new KeepAwakeError(
            'COMMAND_FAILED',
            result.timedOut ? 'sudo -n 执行超时' : `sudo -n 失败：${result.stderr.trim() || `exit ${result.code}`}`,
          )
        }
      } else if (this.hasOsascript()) {
        method = 'osascript'
        const script = `do shell script "/usr/bin/pmset -a disablesleep ${value}" with administrator privileges`
        const result = await this.run(OSASCRIPT, ['-e', script], { timeoutMs: APPLY_TIMEOUT_MS })
        if (result.code !== 0) {
          const detail = result.timedOut ? '授权超时' : result.stderr.trim() || `exit ${result.code}`
          if (/canceled|user canceled|-128/i.test(detail)) {
            throw new KeepAwakeError('AUTH_CANCELLED', '已取消管理员授权')
          }
          throw new KeepAwakeError('AUTH_FAILED', `管理员授权失败：${detail}`)
        }
      } else {
        throw new KeepAwakeError(
          'NO_PRIVILEGE',
          '找不到提权路径。请运行插件的 scripts/install-sudoers.sh 安装一次性免密规则（仅允许两条固定的 pmset disablesleep 命令）',
        )
      }

      const after = await this.readSleepDisabled()
      if (after !== target) {
        throw new KeepAwakeError('VERIFY_FAILED', '命令已执行但系统状态未变化，请尝试在终端手动运行并检查 pmset 输出')
      }
      return { changed: true, method }
    } catch (error) {
      if (error instanceof KeepAwakeError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new KeepAwakeError('COMMAND_FAILED', `执行 ${method} 失败：${message}`)
    }
  }
}
