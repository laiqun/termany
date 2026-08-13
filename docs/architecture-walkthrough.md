# Termany 最小架构与核心实现导读

> 面向想读懂这个仓库的人。先给出最小架构和一条核心数据流的伪代码，
> 然后每一层"螺旋上升"：伪代码 → 真实实现 → 关键文件:行号。
> 读完全文后，附一份推荐的源码阅读顺序。

---

## 0. 项目是什么

Termany 是一个"同时跑多个 coding agent 的终端"：UI 是三层嵌套
**工作区(Workspace) → 页面(TreeNode，可无限嵌套) → 标签页(HTab) → 可分屏的面板(Pane)**，
每个 Pane 可以在 终端 / 文件树+编辑器 / Git Diff / Agent 聊天 / 浏览器 等视图间切换。

设计核心（README 称之为 "local-first, cloud-ready"）：
**整个 UI 不直接碰 shell，只依赖一个接口 `ITerminalBackend`**。
换掉 backend 的实现，就能从"本地桌面"换到"云端容器"，UI 一行不改。

```
┌─────────────┐   WebSocket(终端I/O)    ┌──────────────┐   node-pty   ┌───────┐
│  apps/web   │ ─────────────────────▶ │ apps/server  │ ───────────▶ │ shell │
│  React UI   │ ◀───────────────────── │  HTTP + WS   │ ◀─────────── │ agent │
│             │   REST /api/*(其余一切)  │  + SQLite    │              └───────┘
└─────────────┘                        └───────────────┘
      ▲                                       ▲
      │ apps/desktop (Tauri) 只是个壳：          │ apps/server 被打包进桌面端资源，
      │ webview 里加载 apps/web 的产物           │ 由 Rust 侧作为子进程拉起
```

四个包的分工：

| 包 | 角色 | 技术栈 |
|---|---|---|
| `packages/core` | **接缝**：`ITerminalBackend` 接口 + 通信协议 | 纯 TS，无构建 |
| `apps/web` | 全部 UI（也被桌面端复用） | React 18 + Zustand + xterm.js + CodeMirror |
| `apps/server` | PTY 托管 + 全部 API | 裸 `node:http` + `ws` + `node-pty` + `node:sqlite` |
| `apps/desktop` | 桌面壳，无自有 JS | Tauri v2 (Rust) |

---

## 1. 核心链路：一次按键的完整旅程（伪代码 v0）

先不管所有功能，只看"敲一个键，看到字符回显"这一条链路：

```
// ── 前端（apps/web）──
onKeyDown(key):                      // xterm.js 捕获按键
  backend.write({type:"input", data:key})   // → JSON 帧发 WebSocket

// ── 服务端（apps/server）──
onWsMessage(msg):
  pty.write(msg.data)                // 写进伪终端

pty.onData(output):                  // shell 回显/程序输出
  ws.send(output)                    // 原样发回（纯文本帧，无任何包装）

// ── 前端 ──
backend.onData(output):
  xterm.write(output)                // 渲染到屏幕
```

**这就是整个产品的内核。其余 90% 的代码都是围绕它的增强。**
下面每一节把这段伪代码的一个侧面展开成真实实现。

---

## 2. 螺旋展开一：协议层 `packages/core`

### 伪代码 v1 —— 协议设计

```
interface ITerminalBackend://从UI视角抽象的接口
  onData(cb)        // 服务端 → 客户端：原始终端字节流（不是消息！）
  write(msg)        // 客户端 → 服务端：JSON {type:"input"|"resize"}
  resize(cols,rows) // 就是 write({type:"resize",...})
  onExit(cb)        // shell 退出通知
  dispose()
```

注意：**这个接口是 UI 一侧的抽象，不是前后端契约**。
服务端从不 import 它——它只表示"UI 不关心 shell 跑在哪"，名字里的 Backend 指 shell 的运行场所。
真正的前后端契约是同文件里的线上协议：`ClientMessage` 帧格式 + 关闭码 `4000`。

关键设计决策（容易错过，但很重要）：

- **server→client 的每个文本帧就是裸 PTY 输出**，没有 JSON 包装——省去每帧序列化开销。
- 那"shell 退出了"这种元信息怎么传？答案：**骑在 WebSocket 的 CLOSE 帧上**。
  用私有关闭码 `4000`，close reason 里塞 JSON `{exitCode, signal}`。
  因为关闭帧本来就没有"数据"语义，不会被误当成终端输出，也无法被伪造。
- 前端先连 WS 时服务端 PTY 可能还没 spawn 完，早到的输入要**缓冲**，等 spawn 完成后补发。

### 真实实现

- 协议与接口定义：`packages/core/src/backend.ts`
- 唯一实现 `WebSocketBackend`：`packages/core/src/ws-backend.ts:19`
  - 打开前的消息入队，open 后 flush
  - 首次连接失败最多重试 8 次（桌面端 webview 和被打包的 server 是并行启动的，server 可能慢一步）
  - close 帧里解析 `{exitCode, signal}`
- 关闭码常量 `SHELL_EXIT_CLOSE_CODE = 4000`：`apps/server/src/index.ts:257`

> 读代码时先读这两个文件，一共两百多行，是整个仓库的"宪法"。

---

## 3. 螺旋展开二：服务端 PTY 会话 `apps/server`

### 伪代码 v2 —— 会话生命周期

```

ptySessions: Map<sessionId, PtySession>   
// PtySession:{pty, scrollRing, attachedWs, detachedAt}

onWsConnection(query):// query: session, cwd, ssh, agent...
  if query.session 已存在:// ★ 断线重连
      重放 scrollRing 里的历史
      把新 ws attach 到旧 pty
  else: // Win: PowerShell; 其他: $SHELL -l（默认shell，登录启动）
      pty = node_pty.spawn(shell, cwd)   
      注册进 ptySessions

wireSession(session)://从server看pty的视角，
  pty.onData(d): ws.send(d); scrollRing.append(d)// 双写：实时 + 历史 
  pty.onExit(e):  ws.close(4000, json(e))           // 见协议层
  //pty.onData pty.onExit都是server收到pty的数据
onWsClose():
  session.detach()          // ★ 不杀 PTY！只断开 attach
                            // 7 天没人回来才被 reap(收个) 掉
```

三个要点：

1. **会话比 WebSocket 活得久。** 刷新页面、切后台、关窗口，shell 不死；
   下次带着同一个 `session` id 连回来，重放历史、继续用。
   清理靠 `reapDetachedSessions()`（默认 TTL 7 天，`index.ts:572`）。
2. **scrollRing**：每会话 512KB 的内存环形缓冲，每 10 秒落盘到 SQLite，
   重连时先 `sanitizeForReplay()`（剥掉 OSC 52 写剪贴板等危险转义序列）再回放。
3. **没有框架。** 一个 `node:http` server 手工路由 ~30 个 `/api/*` 端点，
   `ws` 库的 `WebSocketServer` 挂在同一个 HTTP server 上处理 upgrade。

### 真实实现（都在 `apps/server/src/`）

| 关注点 | 位置 |
|---|---|
| WS 连接入口、query 参数、重连逻辑 | `index.ts:1853` 起的 `wss.on("connection")` |
| spawn PTY（含 SSH 会话改 spawn `ssh` 命令） | `index.ts:2021`、`index.ts:1989` |
| 数据双写 + 退出处理 `wireSession()` | `index.ts:480-535` |
| 会话注册表 `ptySessions` | `index.ts:400` |
| 环形缓冲 / 写到硬盘 / 回放净化 | `index.ts:284` / `index.ts:588` / `index.ts:313` |
| SQLite（`node:sqlite`，WAL，`~/.termany/termany.db`） | `db.ts:18` |

除 WS 外还有两类实时通道，注意区分：

- **SSE** `/api/state/events`、`/api/activity/events` —— 布局同步、agent 活动状态（单向推送）。
- **NDJSON 流式响应** —— agent 聊天：`POST /api/agent/acp/chat`，逐行写 `{type:"delta"|...}`。

---

## 4. 螺旋展开三：前端会话管理 `apps/web`

### 伪代码 v3 —— Session 注册表

```
// 关键：Session 活在 React 之外
sessions: Map<paneId, Session>   // {xterm实例, backend, domNode, scrollback...}

openTerminal(paneId, opts):
  if sessions.has(paneId): return       // 已存在，直接用
  term = new XTerm(+fit/search/webgl addons)
  backend = new WebSocketBackend(WS_URL, {session: paneId, cwd, ssh, ...})
  backend.onData(d => term.write(d))
  term.onData(d => backend.write({type:"input", data:d}))
  sessions.set(paneId, ...)

// React 组件只做"挂载/卸载 DOM"，不拥有会话 
TerminalPane.render()://屏幕div与xterm产生关系
  useEffect: attachSession(paneId, divRef)   // 把既有 DOM 节点挪进来
  cleanup:   detachSession(paneId)           // 挪走，不销毁
```

为什么这样设计：**xterm 实例和它的 scrollback 是昂贵且有状态的**。
如果让 React 组件持有xterm 实例（`useEffect` 里创建、cleanup 里销毁），组件每次卸载
（切页、切分屏布局变化）都会断开 WS、丢掉渲染现场——尽管服务端 PTY 还活着。

```tsx
// 反例：React 持有会话
function TerminalPane({ sessionId }) {
  useEffect(() => {
    const term = new XTerm();
    const ws = new WebSocketBackend(...);          // 挂载时创建
    return () => { ws.dispose(); term.dispose(); }; // 卸载时全销毁
  }, []);
}
```

所以"会话注册表"是模块级单例，React 只是它的投影：store 里只存
"哪个 pane 显示哪个 sessionId"，渲染时按 id 去注册表**借用**会话的 DOM，
组件卸载只是"不再显示"，会话本身一直在。

```tsx
// 正例：注册表在模块顶层，组件只借用
const sessions = new Map<string, Session>();  // manager.ts 顶层，与 React 无关

function TerminalPane({ sessionId }) {
  useEffect(() => {
    attachSession(sessionId, divRef.current);  // 借：既有 DOM 搬进来
    return () => detachSession(sessionId);      // 还：搬走，不销毁
  }, []);
}
```

类比：会话是一直运行的电脑主机，React 组件只是显示器——拔掉显示器（卸载）主机照跑，插回去接着看。

渲染侧值得一提的增强（都属于"伪代码之外的 90%"）：

- WebGL 渲染 + 自定义字形图集修复：`terminal/glyphAtlas.ts`
- 检测输出里的本地路径 / URL，变成可点链接：`terminal/localLinks.ts`、`webLinks.ts`
- 检测"某个端口起服务了"→ 提示在浏览器面板打开：`terminal/servedUrls.ts`
- 从屏幕内容推断 agent 是 working / done / 需要人工干预：`terminal/agentIdleWatcher.ts`

### 现象解读：滚到历史中敲回车，新提示符一闪而过、视口不跳到底部

这是**故意的**，代码里叫 manual-scroll output deferral（`manager.ts:110-169`）：

1. 你往上滚 = 声明"我在看历史"：会话进入手动滚动状态
   （`manualScrollUntil` 冷却期 + `lockedViewportY` 记下视口所在行）。
2. 回车的回显和新提示符确实写到了终端底部——所以"一闪而过"。
3. 写完立刻 `scrollToLine(lockedViewportY)` 把视口拉回你停留的位置（`manager.ts:125-127`）；
   冷却期内的新输出甚至先攒在 `deferredOutput` 里不写（`manager.ts:137-141`）。

设计意图：agent 刷输出时你滚上去翻日志，不该被新输出拽到底部。
规则即"**你不回到底部，视口就钉在原地**"；手动滚回最底部后 `followOutput`
恢复，重新跟随输出（`manager.ts:117-119`）。

### 现象解读：窗口退后台一段时间再切回，终端一片空白，敲回车才冒出新提示符

这是**渲染层问题，会话没丢**（shell 和滚屏历史都在，所以回车有响应）——
丢的只是屏幕上的像素：

1. 窗口退后台后 webview 暂停渲染，操作系统可能回收 GPU 纹理——
   xterm 的 WebGL 渲染器把字符画在 GPU 纹理上，纹理没了画布就是空白。
2. 切回前台时 xterm 只在"有新输出"时才重绘，旧内容位置保持空白；
   敲回车产生新输出，新行被正常画出，于是"空白中冒出一个新提示符"。
3. 关键陷阱：这**不是** GPU 上下文丢失，`onContextLoss` 不会触发，
   所以 `manager.ts:1897` 的 DOM 渲染器兜底接管不了这种"纹理被清、上下文还在"的空档。

**修复**（`repaintOnWindowVisible`，在 `refreshOnSymbolsFontLoad` 之后）：
监听 `visibilitychange`，窗口回到可见时用 `requestAnimationFrame` 等一帧
（等 compositor 恢复），然后对所有**挂在 DOM 上**的会话执行
`clearTextureAtlas()` + `refresh(0, rows-1)` 强制重绘。后台未挂载的 pane 不管——
它们重新 attach 时走 `attachSession` → `refreshSessionAfterLayout` 自带的重绘路径。

姊妹问题见 `glyphAtlas.ts:1-29`：后台 pane 的字形图集过期导致字符显示成
别的字符，同属"后台期间 GPU 侧状态腐烂，回来后没人强制重传"一族。

副作用：切回前台瞬间一次性重栅格化字形 + 全量重绘，约一帧的 CPU 开销；
操作幂等，频繁 alt-tab 多跑几次无害；`refresh` 不动视口，不影响滚动钉住逻辑。

### 真实实现

| 关注点 | 位置 |
|---|---|
| 会话注册表、`Session` 接口 | `apps/web/src/terminal/manager.ts:50-73` |
| 建连（每 pane 一条 WS） | `manager.ts:1518-1527` |
| `attachSession` / `detachSession` | `manager.ts:1873` / `manager.ts:1956` |
| React 侧的薄壳组件 | `components/TerminalPane.tsx:62` |
| 滚动历史持久化（sendBeacon 写到硬盘） | `terminal/scroll.ts` |

---

## 5. 螺旋展开四：UI 状态模型与持久化

### 伪代码 v4 —— 数据模型（"Notion 式"）

> "Notion 式"指 Notion 笔记的组织方式：左侧页面树、页面无限套子页面、
> 每个页面有独立内容。Termany 把"页面内容"从笔记块换成了终端布局：
>
> ```
> Notion:  工作区 → 页面(可嵌套) → 内容块(段落/图片...)
> Termany: Workspace → Page（TreeNode 可嵌套) → HTab（horizontal tab - 横排标签） → Pane
> ```
>
> 好处和 Notion 一样：按项目/任务把终端组织成树（"项目A"下挂"前端""后端"子页面），
> 而不是一堆平铺的窗口。`store.ts:22-33` 顶部注释即此模型的权威说明。


```
Workspace
  └─ TreeNode[]            // 无限嵌套的页面/文件夹树（左侧栏竖排，即 vertical tab）
       └─ HTab[]           // 每个页面有一排标签页（顶部横排，H = horizontal）
            └─ layout: Pane // 一棵分屏二叉树
                 ├─ split{ direction: row|col, sizes, children: [Pane, Pane] }
                 └─ leaf{ view: "terminal"|"files"|"git"|"agent"|"web"|...,
                          sessionId, sshTarget, agentMessages... }
```

"Notion 式"命名由来：UI 有两排标签——左侧竖排选"哪个页面"（vertical tab），
顶部横排选"页面里的哪个终端"（HTab，`HTabBar.tsx`）。 见 `apps/web/src/demo.ts:84`：`workspace ▸ vertical tab ▸ horizontal tab`。

- 单一 Zustand store：`apps/web/src/state/store.ts`（约 2000 行，~50 个 action，
  文件顶部注释就是这个模型的权威说明）。
- `SplitView.tsx` 递归渲染这棵 Pane 树；叶子按 `view` 分发到
  `TerminalPane` / `FileTree` / `GitDiffView` / `AgentPane` / …
- **持久化**：整个布局 JSON 通过 `PUT /api/state` 存进服务端 SQLite 的 `workspace` 表；
  启动时 `main.tsx` 先 `loadState()` 再渲染——所以你重开 app 看到的是上次的完整现场。
- **多窗口同步**：Termany 支持开多个 app 窗口（Tauri 多窗口）。

  多窗口同步讲的是多个 OS 窗口之间怎么保持一致：
  - 布局共享：工作区、页面树、tab、pane 整套结构只有一份，存在服务端 SQLite。A 窗口拖了个分屏，B 窗口也要看到。
  - "显示哪个页面"各管各的：A 窗口在看"页面 1"，B 窗口可以同时看"页面 2"——这个选择是窗口私有的，所以存各自的 localStorage，不进共享布局。
  - 怎么同步：
    1. A 窗口改了布局 → PUT /api/state 存服务端
    2. 服务端通过 SSE /api/state/events 推给B窗口
    3. B窗口收到后用state/layoutMerge.ts 把新布局和自己本地状态合并（不能直接覆盖，否则会把 B 正在看哪个页面这类本地状态冲掉）。

  一句话：布局是大家的一本账，"正在看哪页"是各自的书签，SSE 负责账本变更时通知其他窗口

### 各视图分别走什么通道？

除终端 I/O 走 WebSocket，其他视图全部是 HTTP：

| 视图 | 数据通道 | 端点 |
|---|---|---|
| 终端 | **WebSocket**（唯一例外） | WS 根路径 |
| 文件树 / 编辑器 | REST | `/api/fs/list`、`/api/fs/read`、`/api/fs/write` |
| Git Diff | REST | `/api/git/overview`、`/api/git/diffs` |
| Agent 聊天 | HTTP 流式响应（NDJSON） | `POST /api/agent/acp/chat` |
| Agent 历史 / 用量 | REST | `/api/agent-sessions`、`/api/agent-usage` |
| 系统监控 | REST 轮询 | `/api/system-stats` |
| 浏览器视图 | 不走 server | 直接嵌原生 webview |

两个注意点：

- Agent 聊天虽走 HTTP，但不是"请求→一次性响应"：fetch 后逐行读 `response.body`，
  每行一个 JSON（`{type:"delta"...}`），实现打字机式流式输出。
- SSE（`/api/state/events`、`/api/activity/events`）也是 HTTP，用于服务端单向推送。

一句话：**终端走 WS，实时推送走 SSE，流式聊天走 NDJSON，剩下全是普通 REST——但传输层都是 HTTP/WS，且都在同一个 server 同一个端口上。**

NDJSON = Newline Delimited JSON，每行一个独立的 JSON 对象，用换行分隔：
```
{"type":"delta","text":"我来帮你"}
{"type":"delta","text":"看一下这个文件"}
{"type":"tool","name":"Read","path":"index.ts"}
{"type":"done"}
```
---

## 6. 螺旋展开五：桌面端怎么串起来的 `apps/desktop`

桌面端自己几乎不写 JS——`tauri.conf.json` 直接指向 `apps/web` 的构建产物。
真正的逻辑在 Rust 侧（`apps/desktop/src-tauri/src/lib.rs`）：

```
onAppStart:
  if 已有健康的服务端在跑 (port 5174): 直接复用
  else: spawn(resources/server/ 里打包好的 Node + server.cjs)   // lib.rs:453
  监控子进程，崩溃则重启；app 退出时杀掉

onWebviewLoad:
  加载 apps/web → WebSocketBackend 连 ws://localhost:5174 → 完
```

打包链路：根目录 `pnpm bundle:server`（`scripts/bundle-server.mjs`）用 esbuild 把
server 打成单文件 `server.cjs`，下载对应平台的 Node 运行时和 node-pty 预编译产物，
一起塞进 `src-tauri/resources/server/`。所以桌面版用户**不需要装 Node**。

> 注意 roadmap：`LocalPtyBackend` 还是个 TODO——未来 PTY 直接在进程内跑，
> 连本地 server 都不需要。这正是 `ITerminalBackend` 接缝存在的意义。

---

## 7. 推荐源码阅读顺序

按"从内到外"读，每一步都有上一节打底：

1. `packages/core/src/backend.ts` → `ws-backend.ts`
2. `apps/server/src/index.ts` 只看三块：`wss.on("connection")`（:1853）、
   `wireSession`（:480）、spawn 段（:1989-2021）
3. `apps/web/src/terminal/manager.ts` 的 `Session` 接口（:50）和建连段（:1518）
4. `apps/web/src/state/store.ts` 顶部注释 + 类型定义（:22-183）
5. `apps/web/src/App.tsx` 渲染树（:352-397）→ `SplitView.tsx` → `TerminalPane.tsx`
6. 之后按兴趣挑支线：
   - git(`apps/server/src/git.ts`)
   - ACP（简单理解为 kimi code ，codex cli就行了）聊天(`acpRuntime.ts` +`AgentPane.tsx`)
   - SSH(`ssh.ts`)
   - 主题(`apps/web/src/themes/`)

各包测试都是 colocated 的 `*.test.ts`，`node --import tsx --test` 运行，
读实现时对照测试是最快的确证方式。

---

## 8. 一页纸备忘

- 终端 I/O 走 **WebSocket**，其余一切走 **REST**，两者同端口同 server。
- server→client 帧 = 裸 PTY 字节；元信息（退出）走 close 码 4000。
- PTY 会话 > WS 连接 > React 组件，三者寿命依次递减，各自有注册表。
- 前端会话注册表在 React 外；UI 状态是单一 Zustand store，整体 JSON 落 SQLite。
- 桌面端 = Tauri 壳 + 打包的 Node server 子进程 + 同一份 web UI。
- 想改"shell 跑在哪"：只动 `ITerminalBackend` 的实现，别碰 UI。

---

## 9. Q&A（读码过程中实际问过的问题）

**Q：`ITerminalBackend` 是前后端契约吗？**
不是，它是 UI 一侧的抽象（consumer-owned port），服务端从不 import 它。
真正的前后端契约是同文件里的线上协议：`ClientMessage` 帧格式 + 关闭码 4000。（见第 2 节）

**Q：`PtySession` 的 `{pty, ring, ws, detachedAt}` 是什么？**
服务端会话注册表的 value（`index.ts:391-398`）：PTY 句柄、512KB 滚动缓冲、
当前连着的 WS（断开为 null）、断开时间（用于 7 天 TTL 回收），另有 `sshTarget`
区分本地 shell 还是 SSH 远端。

**Q："落盘"是什么意思？**
内存里的 scrollRing 每 10 秒批量写进 SQLite（`session_scroll` 表），
server 重启后滚屏历史还在。触发时机：定时、detach 时、页面关闭前 sendBeacon。

**Q：前端 `attachSession` 是 WS 和 PTY 建立关系吗？**
不是，是 DOM 挂载：把 xterm 实例自己持有的元素 `s.el` appendChild 进 pane 的 div。
WS↔PTY 的关系在 WS 连接建立那一刻就由服务端 `wireSession()` 接好了。
类比：会话是一直运行的主机，React 组件只是显示器——拔掉（卸载）主机照跑。（见第 4 节）

**Q：文件树、git diff 等其他视图也走 WebSocket 吗？**
不走，全是 HTTP。终端 I/O 是唯一走 WS 的；另有 SSE（布局/活动推送）和
NDJSON（agent 聊天流式输出）两条 HTTP 上的流式通道。（见第 5 节末尾的通道对照表）

**Q：NDJSON 是什么？**
Newline Delimited JSON，每行一个独立 JSON 对象。边生成边发，前端 fetch 后逐行读
`response.body`，来一行解析一行——agent 聊天的打字机效果就是这么来的。

**Q：HTTP 和 WS 怎么在同一个端口共存？HTTP/2？**
HTTP/1.1 Upgrade，与 HTTP/2 无关。连接先以 HTTP/1.1 开场，带 `Upgrade: websocket`
头的请求触发 `upgrade` 事件，`ws` 库回 101 后把整条 TCP 连接拿走改跑 WS 帧；
普通请求走 `createServer` 的请求回调。共存 = 按请求头分流，不是一条连接上两种协议并行。

**Q：终端 pane 切成其他视图，WS 要"降级"回 HTTP / 关闭吗？**
都不用。HTTP 和 WS 是各自独立的连接，不存在降级机制；切视图只是 `detachSession`
挪走 DOM，WS 连接随会话注册表保留，shell 输出持续写进 xterm 缓冲区。
WS 只在用户关闭 pane/tab 时销毁（`disposeSession`，`manager.ts:2258`）；
就算意外断开，服务端 PTY 也活着，带 session id 重连即可恢复。

**Q：WS 占用了那条 TCP，HTTP 请求要另开 TCP，这是项目代码做的吗？**
不是，一行代码都没有。`new WebSocket()` 和 `fetch()` 只是声明意图；
TCP 建连、连接池、keep-alive、Upgrade 握手全是 runtime（webview / `node:http`）的内建行为。

**Q：窗口退后台再切回，终端一片空白？**
渲染层问题，会话没丢：OS 回收了 GPU 纹理但不算 context loss，xterm 没有触发重绘。
已修复：`visibilitychange` 回来时对已挂载会话强制重绘。（见第 4 节"现象解读"）

**Q：滚到历史中间敲回车，新提示符一闪而过、视口不跳到底？**
故意的：manual-scroll output deferral。你往上滚 = 钉住视口，输出照写但视口拉回原地；
滚回底部才恢复跟随。（见第 4 节"现象解读"）

**这个 http 和 ws 共存是哪种实现，http1.1 升级，还是 http2**
是经典的 HTTP/1.1 Upgrade，跟 HTTP/2 无关。证据：

• index.ts:10：import { createServer } from "node:http" —— node:http 只讲 HTTP/1.1（HTTP/2 得用 node:http2，代码里没有）
• index.ts:1650：new WebSocketServer({ server: http }) —— ws 库挂到同一个 HTTP server 上

共存原理是 HTTP/1.1 的协议升级机制：

1. 同一个 TCP 端口（5174）上，所有连接一开始都是普通 HTTP/1.1。
2. 普通请求（GET /api/...）→ 走 createServer 的请求回调（index.ts:608），手工路由到 REST 端点，一问一答，结束。
3. WS 客户端发来的请求带特殊头：
    ```
      GET /?session=xxx HTTP/1.1
      Upgrade: websocket
      Connection: Upgrade
      Sec-WebSocket-Key: ...
    ```
    Node 发现 Upgrade 头后不走请求回调，而是发 upgrade 事件。
4. WebSocketServer({ server: http }) 在构造时就注册了这个事件的监听：它校验握手、回 101 Switching Protocols，然后把这条 TCP 连接从 HTTP 手里拿走。
5. 从此这条连接上跑的不再是 HTTP，而是 WebSocket 帧——直到关闭。

所以"共存"不是两种协议同时跑在一条连接上，而是一条连接先以 HTTP/1.1 开场，握手后整条连接换轨。端口复用靠的就是请求头里的 Upgrade 字段分流。

顺带说：HTTP/2 也能承载 WebSocket（RFC 8441 Extended CONNECT），但需要 node:http2 + TLS，且 ws 库默认不走这条路。这里用 HTTP/1.1 Upgrade 是最简单通用的做法——localhost 场景没有多路复用的需求，HTTP/2 没有收益。

**有个问题啊， ws只在terminal pane时才用吧，切换成其他pane 需要降为HTTP吗？ 这个ws连接要关闭吗？**
不需要"降级"，WS 也不关。拆开说：

1. 没有"降级"这个概念

HTTP 和 WS 是各自独立的连接，不是一条连接在两种协议间来回切。终端 pane 的 WS 建立后就一直在；文件树/git 视图发 REST 请求时，浏览器另开 HTTP 连接（或复用 keep-alive 连接）去访问同一个端口。两者并行不悖——升
级是单向的（HTTP→WS），不存在用完再降回来的机制，也不需要。

2. 切视图时 WS 保持连接

回想之前的"主机与显示器"模型：切视图只是 detachSession 把 DOM 挪走（拔显示器），会话注册表里的 Session——xterm 实例 + WS 连接——原样保留（主机照跑）。这样：

• shell 继续在跑，agent 的输出继续通过 WS 到达、写进 xterm 缓冲区
• 切回终端视图时 attachSession 把 DOM 插回来，看到的是实时最新的画面，不是重连+重放

3. WS 真正关闭的时机

代码里只有两个销毁入口（manager.ts:2258、:2292），注释写得很明确：

│ Permanently destroy a session — only when the user closes the pane/tab.

即：用户关闭 pane/tab → backend.dispose() 关 WS + 销毁 xterm + 顺带 POST /api/forget 让服务端把持久化的滚屏数据也删掉。再有就是页面卸载时浏览器自动收连接。

4. 就算 WS 意外断了，PTY 也不死

这是服务端那层的设计（之前讲过的寿命关系：PTY > WS > React 组件）：WS 断开只是 detach，服务端 PTY 保留（默认 7 天 TTL），下次带同一个 session id 连上，重放历史接着用。

所以整个设计里，WS 连接的生命周期绑的是终端会话（pane 存活期），而不是终端视图是否正在显示。

**浏览器另开 HTTP 连接（或复用 keep-alive 连接）去访问同一个端口。这个行为要写代码吗？**
它升级成了ws，那么另外开新的tcp，这个是这个项目要操作的事情，还是底层runtime？
完全是底层 runtime 的事，这个项目一行相关代码都没有。

项目代码只到这一层：

```ts
  new WebSocket("ws://localhost:5174/?session=...")   // 声明：我要一条 WS
  fetch("http://localhost:5174/api/git/diffs")         // 声明：我要发个 HTTP 请求
```

这两行都是声明意图，底下的一切由 webview 的网络栈完成：

• new WebSocket() → 网络栈建 TCP 连接 → 发 Upgrade 握手 → 握手成功后这条 TCP 被标记为 WS 专用，从 HTTP 连接池里移除
• fetch() → 网络栈看连接池：没有可用的（原来那条已经变成 WS 了）→ 静默新建一条 TCP → 发请求

"原来那条 TCP 升级没了，要不要再开一条"这个决策，代码里不存在——连接池发现自己空了就会开新的，这是浏览器网络栈的常规行为，和" pool 里连接被 6 个并发请求占满后再开新的"是同一条代码路径。

服务端同理，甚至更被动：node:http 只在端口上 accept，来的连接是普通请求就触发 request 回调，带 Upgrade 头就触发 upgrade 事件交给 ws 库——服务端从来不"开"连接，只是接收，然后按请求头分流。

所以分工是：
```
  ┌──────────────────────────────┬──────────────────────────────────────────────────────┐
  │ 层                           │ 负责什么                                             │
  ├──────────────────────────────┼──────────────────────────────────────────────────────┤
  │ 项目代码                     │ 声明意图：new WebSocket()、fetch()                   │
  ├──────────────────────────────┼──────────────────────────────────────────────────────┤
  │ runtime（webview/node:http） │ TCP 建连、连接池、keep-alive、Upgrade 握手、按头分流 │
  ├──────────────────────────────┼──────────────────────────────────────────────────────┤
  │ 操作系统                     │ 真正的 socket、端口、包                              │
  └──────────────────────────────┴──────────────────────────────────────────────────────┘
```

这也是这个项目协议设计干净的原因之一：应用层只关心"终端数据走 WS、其他走 HTTP"这个语义分工，传输层的连接管理零代码。
