/**
 * @dsh-external/dsh-keep-awake — client half。
 *
 * 在设置弹窗「通用」页注册一个开关行（settings.general.item）：
 *   - 开关 = 用户保存的意图（host 持久化到 ~/.dsh/plugins/dsh-keep-awake/config.json）
 *   - 状态点 = 系统真实 SleepDisabled 是否已生效
 *   - “重新授权” = 让系统状态对齐到已开启的意图（启动后也会自动尝试）
 *
 * 所有系统命令都由 host 半执行；浏览器只走同源 HTTP API，不获得任何提权能力。
 */
import { useEffect } from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-store'
// 仅用于把 settings.general.item 的 SlotMap 声明合并加载进来
import type { SettingsGeneralItemOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PLUGIN_ID,
  SET_API_PATH,
  STATE_API_PATH,
  SYNC_API_PATH,
  normalizeState,
  type KeepAwakeState,
} from '../shared'

const CSS = `
.dkw-root{display:flex;flex-direction:column;gap:9px;width:100%;padding:4px 0}
.dkw-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dkw-title{display:flex;flex-direction:column;gap:2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dkw-title small{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dkw-desc{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dkw-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dkw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.dkw-dot.on{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}
.dkw-dot.pending{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary))}
.dkw-dot.foreign{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary))}
.dkw-muted{color:var(--dsw-alias-label-tertiary)}
.dkw-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}
.dkw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dkw-btn{font:inherit;font-size:12px;line-height:18px;padding:5px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer}
.dkw-btn:hover{background:var(--dsw-alias-button-floating-hover)}
.dkw-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.dkw-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dkw-switch{position:relative;display:inline-block;width:44px;height:24px;flex:none}
.dkw-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:2}
.dkw-switch input:disabled{cursor:not-allowed}
.dkw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-disabled,var(--dsw-alias-bg-mask-2));transition:background .2s var(--ds-ease-in-out)}
.dkw-thumb{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .2s var(--ds-ease-in-out)}
.dkw-switch input:checked + .dkw-track{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-success-primary))}
.dkw-switch input:checked + .dkw-track .dkw-thumb{transform:translateX(20px)}
.dkw-switch input:focus-visible + .dkw-track{box-shadow:0 0 0 2px var(--dsw-alias-bg-base),0 0 0 4px var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-alias-state-success-primary))}
.dkw-switch input:disabled + .dkw-track{opacity:.55}
`

interface KeepAwakeRowInjected {
  setEnabled: (enabled: boolean) => Promise<void>
  syncNow: () => Promise<void>
  refresh: () => Promise<void>
}

function createRowStore() {
  return defineStore({
    init: () => ({ state: normalizeState(undefined) }),
    actions: {
      sync: (draft, state: KeepAwakeState) => {
        draft.state = state
      },
    },
  })
}

type KeepAwakeRowProps = ComposedProps<
  'settings.general.item',
  string,
  never,
  ReturnType<typeof createRowStore>,
  KeepAwakeRowInjected
>

interface ApiResponse {
  ok?: boolean
  state?: unknown
  error?: string
  code?: string
}

async function callApi(path: string, init?: RequestInit): Promise<{ state?: KeepAwakeState; error?: string }> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
  })
  let payload: ApiResponse = {}
  try {
    payload = (await response.json()) as ApiResponse
  } catch {
    payload = {}
  }
  if (!response.ok || payload.ok !== true) {
    return {
      state: payload.state === undefined ? undefined : normalizeState(payload.state),
      error: payload.error ?? `请求失败（HTTP ${response.status}）`,
    }
  }
  return { state: normalizeState(payload.state) }
}

function statusOf(state: KeepAwakeState): { cls: 'on' | 'pending' | 'foreign' | ''; text: string } {
  if (!state.supported) return { cls: '', text: '仅支持 macOS，当前系统不会执行 pmset 命令' }
  if (state.updating) return { cls: 'pending', text: '正在申请系统授权…' }
  if (state.error) {
    // host 已经区分了“关闭未生效”和“其他工具保持唤醒”，错误时以 host 文案为准。
    return { cls: 'pending', text: state.message || state.error }
  }
  if (state.enabled && state.actual) return { cls: 'on', text: state.message || '已保持唤醒：合盖不休眠' }
  if (state.enabled && !state.actual) return { cls: 'pending', text: state.message || '开关已开，系统尚未生效' }
  if (!state.enabled && state.actual) return { cls: 'foreign', text: state.message || '开关已关，系统仍被其他来源保持唤醒' }
  return { cls: '', text: state.message || '正常休眠：合盖后按 macOS 策略休眠' }
}

function batteryText(state: KeepAwakeState): string | null {
  const { source, percent } = state.battery
  if (source === 'ac') return 'AC 电源'
  if (source === 'battery') return percent === null ? '电池供电' : `电池 ${percent}%`
  if (source === 'ups') return 'UPS 供电'
  return null
}

function KeepAwakeRow(props: KeepAwakeRowProps): JSX.Element {
  const state = props.useStore((snapshot) => snapshot.state)
  const status = statusOf(state)
  const battery = batteryText(state)
  const needsAuthorization = state.supported && state.enabled && state.actual !== true && !state.updating

  // 只在设置行挂载（用户在设置页）时轮询状态，避免常驻请求。
  useEffect(() => {
    void props.refresh()
    const timer = window.setInterval(() => {
      void props.refresh()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [props.refresh])

  return (
    <div className="dkw-root">
      <div className="dkw-head">
        <div className="dkw-title">
          合盖不休眠
          <small>Keep Mac awake with the lid closed</small>
        </div>
        <label className="dkw-switch" aria-label="合盖不休眠开关">
          <input
            type="checkbox"
            role="switch"
            checked={state.enabled}
            disabled={!state.supported || state.updating}
            onChange={(event) => {
              void props.setEnabled(event.target.checked)
            }}
          />
          <span className="dkw-track">
            <span className="dkw-thumb" />
          </span>
        </label>
      </div>

      <p className="dkw-desc">
        开启后通过 <code>pmset disablesleep</code> 保持系统唤醒：合上 Mac 盖子也不会休眠，agent
        任务继续运行，手机遥控和远程指令持续可用；关闭后恢复系统正常休眠策略。
      </p>

      <div className="dkw-meta">
        <span className={`dkw-dot ${status.cls}`} aria-hidden="true" />
        <span>{status.text}</span>
        {battery !== null && <span className="dkw-muted">{battery}</span>}
        {state.platform === 'darwin' && !state.privilege.root && !state.privilege.passwordlessSudo && (
          <span className="dkw-muted">首次切换会弹出 macOS 授权框</span>
        )}
      </div>

      {(needsAuthorization || state.error) && (
        <div className="dkw-actions">
          {needsAuthorization && (
            <button
              type="button"
              className="dkw-btn primary"
              disabled={state.updating}
              onClick={() => {
                void props.syncNow()
              }}
            >
              重新授权并生效
            </button>
          )}
          {state.error && (
            <div className="dkw-error">
              <span>{state.error}</span>
              <button
                type="button"
                className="dkw-btn"
                disabled={state.updating}
                onClick={() => {
                  void props.refresh()
                }}
              >
                刷新状态
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const inject = ['slots']

/**
 * 0.1.2 起 dsh-client-runtime 包已移除，ctx 由 shell 直接注入。
 * 按本插件实际用到的最小面声明（slots.inject/register + effect）。
 */
interface ClientContext {
  slots: {
    inject(name: string, factory: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect(fn: () => () => void, key: string): void
}

export function apply(ctx: ClientContext): void {
  const store = createRowStore()
  let boundActions: { sync: (state: KeepAwakeState) => void } | null = null
  let currentState: KeepAwakeState = normalizeState(undefined)

  const publish = (next: KeepAwakeState): void => {
    currentState = next
    boundActions?.sync(next)
  }

  const refresh = async (): Promise<void> => {
    try {
      const result = await callApi(STATE_API_PATH)
      if (result.state) publish(result.state)
      else if (result.error) publish({ ...currentState, error: result.error })
    } catch (error) {
      publish({ ...currentState, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    publish({ ...currentState, updating: true, error: undefined })
    try {
      const result = await callApi(SET_API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (result.state) publish(result.state)
      else if (result.error) publish({ ...currentState, updating: false, error: result.error })
    } catch (error) {
      publish({
        ...currentState,
        updating: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const syncNow = async (): Promise<void> => {
    publish({ ...currentState, updating: true, error: undefined })
    try {
      const result = await callApi(SYNC_API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      if (result.state) publish(result.state)
      else if (result.error) publish({ ...currentState, updating: false, error: result.error })
    } catch (error) {
      publish({
        ...currentState,
        updating: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'keep-awake',
        order: 60,
        store,
        inject: (actions) => {
          boundActions = actions
          actions.sync(currentState)
          return { setEnabled, syncNow, refresh }
        },
      },
      KeepAwakeRow,
    ),
  )

  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'dsh-keep-awake-styles'
    style.setAttribute('data-plugin', PLUGIN_ID)
    style.textContent = CSS
    document.head.appendChild(style)

    return () => {
      style.remove()
    }
  }, `${PLUGIN_ID}: styles`)
}
