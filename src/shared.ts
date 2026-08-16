/**
 * @dsh-external/dsh-keep-awake — 共享模型（host 与 client 共用）。
 *
 * 配置不进入 DSH settings 白名单体系，而是由 host 半通过本地 HTTP API
 * 持久化到 ~/.dsh/plugins/dsh-keep-awake/config.json。这里只放纯数据与
 * 纯函数，不引用任何 DSH 运行时，保证两端都能安全打包。
 */

export const PLUGIN_ID = '@dsh-external/dsh-keep-awake'

/** 本地状态查询 API（同源路径，由 host 半注册在 webserver 上）。 */
export const STATE_API_PATH = '/api/dsh-keep-awake/state'

/** 本地开关 API：POST JSON `{ "enabled": true | false }`。 */
export const SET_API_PATH = '/api/dsh-keep-awake/set'

/** 本地“重新同步” API：把系统实际状态对齐到已保存的开关意图。 */
export const SYNC_API_PATH = '/api/dsh-keep-awake/sync'

export const CONFIG_VERSION = 1

export interface KeepAwakeConfig {
  version: number
  /** 用户保存的开关意图：true = 合盖不休眠。 */
  enabled: boolean
}

export const DEFAULT_CONFIG: KeepAwakeConfig = Object.freeze({
  version: CONFIG_VERSION,
  enabled: false,
})

export type PowerSource = 'ac' | 'battery' | 'ups' | 'unknown'

export interface BatteryStatus {
  source: PowerSource
  /** 0–100；解析失败时为 null。 */
  percent: number | null
}

export interface PrivilegeStatus {
  /** 后端进程本身就是 root。 */
  root: boolean
  /** 已配置范围精确的 NOPASSWD sudoers 规则（sudo -n 可用）。 */
  passwordlessSudo: boolean
  /** 系统存在 osascript，可弹管理员授权框。 */
  osascript: boolean
}

/**
 * host 通过 HTTP API 返回的完整状态。
 * `enabled` 是“想要的状态”，`actual` 是系统真实状态（SleepDisabled）。
 */
export interface KeepAwakeState {
  platform: string
  supported: boolean
  enabled: boolean
  actual: boolean | null
  updating: boolean
  privilege: PrivilegeStatus
  battery: BatteryStatus
  /** 面向 UI 的简短说明；错误时放 error。 */
  message: string
  error?: string
}

export interface ApiEnvelope<T> {
  ok: boolean
  state?: T
  error?: string
  code?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeConfig(input: unknown): KeepAwakeConfig {
  const root = isRecord(input) ? input : {}
  return {
    version: CONFIG_VERSION,
    enabled: typeof root.enabled === 'boolean' ? root.enabled : DEFAULT_CONFIG.enabled,
  }
}

/** 把非法/损坏的状态响应兜底成可渲染的默认状态。 */
export function normalizeState(input: unknown, platform = 'unknown'): KeepAwakeState {
  const root = isRecord(input) ? input : {}
  const privilege = isRecord(root.privilege) ? root.privilege : {}
  const battery = isRecord(root.battery) ? root.battery : {}
  return {
    platform: typeof root.platform === 'string' ? root.platform : platform,
    supported: typeof root.supported === 'boolean' ? root.supported : false,
    enabled: typeof root.enabled === 'boolean' ? root.enabled : false,
    actual: typeof root.actual === 'boolean' ? root.actual : null,
    updating: typeof root.updating === 'boolean' ? root.updating : false,
    privilege: {
      root: typeof privilege.root === 'boolean' ? privilege.root : false,
      passwordlessSudo: typeof privilege.passwordlessSudo === 'boolean' ? privilege.passwordlessSudo : false,
      osascript: typeof privilege.osascript === 'boolean' ? privilege.osascript : false,
    },
    battery: {
      source:
        typeof battery.source === 'string' &&
        ['ac', 'battery', 'ups', 'unknown'].includes(battery.source)
          ? (battery.source as PowerSource)
          : 'unknown',
      percent: typeof battery.percent === 'number' ? battery.percent : null,
    },
    message: typeof root.message === 'string' ? root.message : '',
    error: typeof root.error === 'string' ? root.error : undefined,
  }
}
