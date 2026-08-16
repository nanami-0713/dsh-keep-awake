# DSH Keep Awake（合盖不休眠）

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 加一个**设置页开关**：开启后，Mac 合上盖子也不会休眠，agent 任务继续跑，手机遥控 / 远程指令持续可用；关闭后恢复 macOS 正常休眠策略。

开关直接集成在 DSH 设置弹窗的 **「通用」** 页里，无需手改配置文件。

## 为什么需要它

DSH 后端跑在本机。Mac 一合盖，系统默认进入睡眠，`dsh web` 子进程会随系统挂起，agent 任务和手机遥控（如 DSH-Remote 这类桥接方案）全部中断。

普通的 `caffeinate` / 浏览器电源断言只能挡「空闲休眠」，**挡不住合盖这个硬件触发**。本插件直接切换内核级标志：

```sh
pmset -a disablesleep 1   # 合盖不休眠
pmset -a disablesleep 0   # 恢复
```

验证方式：

```sh
pmset -g | grep SleepDisabled
# SleepDisabled  1  = 已开启
# SleepDisabled  0  = 已关闭
```

> 在 macOS 15.5 实测：`SleepDisabled 1` 时系统保持唤醒；该开关是 kernel 标志，
> 与电源适配器无关（电池供电同样有效）。Apple 官方 man page 未列出该参数，
> 但 `/usr/bin/pmset` 支持它；不同 macOS 版本行为可能有差异，升级系统后建议再跑一次上面的验证命令。

## 安装

```bash
git clone https://github.com/nanami-0713/dsh-keep-awake.git
cd dsh-keep-awake
npm install
npm run build:all
dsh plugin --profile web add "$(pwd)"
```

重启 `dsh web`（或重启 DSH Desktop），打开 **设置 → 通用**，就能看到「合盖不休眠」开关。

## 使用

| 操作 | 行为 |
| --- | --- |
| 打开开关 | 保存意图并执行 `pmset -a disablesleep 1`，完成后显示「已保持唤醒」 |
| 关闭开关 | 执行 `pmset -a disablesleep 0`，恢复系统正常休眠 |
| 重新授权并生效 | 开关已开但系统状态未对齐时（例如刚重启），重新申请一次授权 |
| 刷新状态 | 重新读取系统真实状态 |

状态说明：

- **绿点**：开关开，且系统已生效。
- **黄点**：开关开，但系统尚未生效（授权被取消 / 重启后等待重新授权）。
- **灰点**：开关关，系统按正常策略休眠。

启动 DSH 时，如果上次保存的意图是「开」，插件会**自动尝试重新对齐**；若还没装免密 sudo，会弹出一次 macOS 授权框。

## 管理员权限

修改 `pmset` 需要 root。插件按以下顺序尝试：

1. 后端进程本身是 root → 直接执行；
2. 已安装范围精确的免密 sudo 规则 → `sudo -n` 静默执行；
3. 否则用 `osascript ... with administrator privileges` 弹出 macOS 授权框（每次切换都需要确认一次）。

想彻底免弹框，一次性安装 sudoers 规则（**只允许两条固定命令，无通配符、无脚本、无守护进程**）：

```sh
sudo bash scripts/install-sudoers.sh
```

规则内容就是下面这一行（用户名固定为当前用户，命令字面量完全一致）：

```
<你的用户名> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
```

移除规则：

```sh
sudo bash scripts/uninstall-sudoers.sh
```

## 安全设计

- **无 shell 拼接**：所有命令都用固定参数数组构造，`disablesleep` 的值只能是 `0` 或 `1`。
- **同源 API 只认回环地址**：`Host` 不是 `127.0.0.1` / `localhost` 的请求直接 403。
- **写接口强制 `application/json`**：跨源页面无法通过普通表单伪造该 content-type，且服务不返回任何 CORS 许可，第三方网页无法远程拨动开关。
- **不擅自关闭别人的设置**：插件只在用户明确点「关」时执行 `disablesleep 0`；卸载、热重载、插件启动时都不会把系统改回休眠。如果你用其他工具保持唤醒，本插件不会覆盖它。
- **意图可恢复**：先持久化开关意图、再执行系统命令；即使这次授权被取消，下次启动仍会提示你重新对齐。
- **提权面最小**：可选 sudoers 规则精确到两条命令，`visudo -cf` 校验后才安装。

## HTTP API（供诊断/自动化）

插件在 DSH webserver 上注册了三个同源接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-keep-awake/state` | 读取意图、系统真实状态、电池与提权通道 |
| POST | `/api/dsh-keep-awake/set` | `{"enabled": true|false}` 切换开关 |
| POST | `/api/dsh-keep-awake/sync` | 把系统状态对齐到已保存的开启意图 |

示例：

```sh
curl http://127.0.0.1:<port>/api/dsh-keep-awake/state
curl -X POST http://127.0.0.1:<port>/api/dsh-keep-awake/set \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'
```

端口以实际 DSH 启动日志里的 `dsh web: http://...` 为准。

## 测试

```sh
npm run typecheck
npm test        # 单元测试：解析器、幂等 no-op、失败校验、真实 pmset 读取（macOS）
```

真实开关验收（会弹授权框）：

```sh
curl -X POST http://127.0.0.1:<port>/api/dsh-keep-awake/set \
  -H 'content-type: application/json' -d '{"enabled":true}'
pmset -g | grep SleepDisabled     # 期望 1
curl -X POST http://127.0.0.1:<port>/api/dsh-keep-awake/set \
  -H 'content-type: application/json' -d '{"enabled":false}'
pmset -g | grep SleepDisabled     # 期望 0
```

最终人工验收：开启开关后合上盖子 30 秒，用手机遥控发一条消息（或从局域网另一台设备 ping/SSH 本机），确认 agent 仍在响应；打开盖子后关闭开关，确认正常休眠恢复。

## 已知边界

- **仅支持 macOS**。Windows / Linux 的 DSH 会正常加载插件，但开关置灰并提示不支持。
- 合盖后散热变差，长时间高负载任务请留意温度；开在电池上会持续耗电，请留意电量。
- `SleepDisabled` 是系统级设置：正常关机 / 重启后系统可能恢复默认，插件会在下次启动时按保存的意图自动重试。
- 与 Amphetamine / KeepingYouAwake / Sleepless 等工具共存时，谁最后写 `disablesleep` 谁生效；本插件读取的是系统真实状态，界面不会撒谎。

## 开发

```sh
npm run build:all   # lib/index.js（host ESM）+ lib/client.js（Web ModuleLoader bundle）
npm run typecheck
npm test
```

## License

[MIT](./LICENSE)
