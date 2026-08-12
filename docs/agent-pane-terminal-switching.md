# Agent Pane 与终端视图切换的交互性分析

本文分析 agent pane 的两种启动方式、pane 视图切换按钮（agent ↔ 终端）的终端复用逻辑，
以及 commit [`656b851`](https://github.com/Murat2283plus/termany/commit/656b851a338cefeb857044a52fdf100e5c1573a3)
（PTY WebSocket 新增 `cmd` 参数）对"切换成交互终端"能力的影响。

## 一、Agent 的两条启动路径

### 路径 A：agent 作为 TUI 跑在 pane 的交互 shell 里

适用于**没有**配置 `runtime`（ACP）的 agent，如 kimi（`apps/web/src/agents.ts:163-170` 无 `runtime` 字段）。

- `apps/web/src/components/SideRail.tsx:97-102` `runAgent()`：`addPane("terminal")` 创建终端 pane，
  然后 `queueCommand(paneId, agentCommand(agent))` 把命令（如 `kimi`）排进队列。
- `apps/web/src/terminal/manager.ts:1926-1933` `attachSession()`：pane 首次挂载终端时，
  把 `pendingCommands` 里的命令 `sendCommand` 打进 shell。
- 服务端 `apps/server/src/index.ts:2021` 用 node-pty spawn 登录交互 shell（`zsh -l` 等，见 `index.ts:189-222`），
  agent TUI 就跑在这个 shell 里。

特点：pty 是交互式的。agent 退出后 shell 还在，回到提示符可继续使用。

### 路径 B：ACP 原生 agent 视图（无 pty，非交互）

适用于配置了 `runtime`（ACP 协议）的 agent，如 claude、codex（`apps/web/src/agents.ts:43-49, 68-74`）。

- `SideRail.tsx:104-112` `openAgent()`：`addPane("agent")` + `setAgentRuntime(paneId, agent.id)`。
- 前端 `apps/web/src/components/AgentPane.tsx` 是纯 HTTP 会话 UI
  （`/api/agent/acp/chat`、`/api/agent/acp/config`、`/api/agent/acp/permission`），**不创建任何终端 session**。
- 服务端 `apps/server/src/acpRuntime.ts:174-177` 用 `spawn(command, args, { stdio: ["pipe","pipe","pipe"] })`
  起 agent——普通管道子进程，**没有 pty**。runtime 以 `paneId` 为 key 存在 `runtimes` Map
  （`acpRuntime.ts:326, 380-391`），与终端 session 注册表完全独立。

## 二、视图切换按钮的终端复用逻辑

- 切换按钮在 `apps/web/src/components/SplitView.tsx:254-296`（pane 头部 view 菜单），
  调用 `setPaneView(leaf.id, view)`。
- store 侧 `apps/web/src/state/store.ts:1600-1618` `setPaneView` / `:1577-1598` `togglePaneView`：
  **只改 leaf 的 `view` 字段**（SSH pane 强制 "terminal"），不触碰任何 session。
- 渲染分支 `SplitView.tsx:495-498`：`view === "agent"` → `<AgentPane>`，否则 → `<TerminalPane id={leaf.id}>`。
- 切到终端视图时，`TerminalPane` 挂载 → `attachSession(sessionId=leaf.id)`（`TerminalPane.tsx:79-91`）
  → `getSession()`（`apps/web/src/terminal/manager.ts:1397`）：
  - **该 pane id 已有存活 session** → 直接复用同一个 xterm 实例和后端 pty，只重新挂载 DOM；
  - **没有 session**（pane 是纯 ACP agent 视图创建的）→ 全新创建：新建 xterm + WebSocket，
    服务端 node-pty 按 session id 起一个新的交互式登录 shell。

### 结论：重建还是复用？

| 场景 | agent 进程是否有 pty | 切到终端视图的行为 |
| --- | --- | --- |
| 路径 A（TUI 跑在 pty 里） | 有，交互 shell pty | **复用**同一 pty，agent TUI 还在里面跑 |
| 路径 B（ACP pipe 进程） | 无 pty | **重建**一个全新的交互式 shell pty，与 agent 进程无关 |

一句话：切换按钮只改 `view` 字段；终端视图按需懒加载——有同 pane id 的活 pty 就复用，
没有就新建交互 shell。**关键不在"agent 是否交互"，而在于 agent 进程有没有占用该 pane id 的终端 session。**

## 三、commit 656b851 的改动与风险

### 改动内容

给 PTY WebSocket 增加可选的 `cmd` 查询参数：pane 直接运行指定命令，而不是落到交互提示符。

- 新增 `apps/server/src/shellCommand.ts`：`shellArgsForCommand()` 生成 shell 参数，
  POSIX 下为 `["-l", "-c", command]`，Windows 下为 `["-NoLogo", "-NoProfile", "-Command", script]`。
- `apps/server/src/index.ts`：WS 连接处理里读取 `cmd` 参数，存在时用它替代默认的 `SHELL_ARGS` spawn pty。
- 动机：`-l -c` 是**登录但非交互** shell——仍读 `~/.zprofile`（PATH、Homebrew、fnm 等），
  但跳过 `~/.zshrc`，避免同名 alias/函数静默劫持命令；同时避免"往 shell 里打字"的时序竞争。

### 风险：agent pane 无法再切换成交互终端

如果前端把 agent pane 改为用 `?cmd=kimi` 启动（路径 A 的改造方向），切换按钮就会失效：

1. **切换时必然复用那个非交互 pty。** 服务端 reattach 分支忽略 `cmd`（pty 已在运行，spawn 参数无法更改）；
   前端 `getSession` 命中"同 pane id 已有 session"分支，原样复用。切到终端视图后看到的仍是
   `zsh -l -c kimi` 的 pty：没有 shell 提示符，键盘输入全部进 agent 进程的 stdin。
2. **没有后路。** agent 退出后 `-l -c` 的 shell 随之退出，pty 死掉（Windows 侧去掉了 `-NoExit`，
   命令结束 pane 直接关闭）。此后若前端重连仍带 `cmd`，只会再跑一遍 agent，永远拿不到交互 shell。
   想切换成交互终端的前提变成"先把 agent 弄死"。

对比之下，现有路径 A（`sendCommand` 把命令打进交互 shell）没有这个问题：agent 退出后 shell 还在。

### 关键机制说明

**"reattach 时忽略 cmd"**：pty 和 WebSocket 是分离的。每个 WS 连接带 `session` id 进来时，
服务端先查该 id 是否有存活 pty：没有才 spawn（只有这次用到 `cmd`、`cwd`）；有就直接把新 WS
接到已在运行的 pty 上（组件重挂载、断线重连、切换视图都会走这里）。`cmd` 只在 spawn 那一刻有效，
reattach 时进程参数早已定死，无法更改。

**`-l -c` 的生命周期**：`-c` 的语义是"执行完命令就退出"。`zsh -l -c kimi` 中 shell 只是启动器：
读 `~/.zprofile` → 启动 kimi → kimi 退出则 shell 退出 → pty 子进程结束，整个 session 终结。
对比交互路径 `zsh -l`：停在提示符等待输入，命令退出后 shell 仍存活。Windows 去掉 `-NoExit`
是同一语义（commit 测试注释："a pane created to run one command should end with it rather
than linger as a dead shell"）。

### 配套修复建议

若要采用 `cmd` 方式启动 agent pane，同时保留切换能力，可选其一：

- 切到终端视图时，对 cmd-pane 先杀掉原 session，再以不带 `cmd` 的参数新建
  （用户主动切视图，杀掉 agent 符合预期）；
- 给 agent 运行和终端视图使用**不同的 session id**，让 `getSession` 走不到复用分支；
- 让这类 pane 禁用视图切换按钮；
- 或参考 ACP 路径的做法：agent 进程与 pane 的终端 session 解耦（runtime 以 paneId 单独管理，
  不占终端 session 注册表），切换时自然新建交互 shell。
