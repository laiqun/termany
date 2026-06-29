# Termany

An AI terminal — **local-first, cloud-ready**. Built so the same UI runs as a web app
today and as a desktop client / cloud service later, by swapping one thing: the backend.

## Why it's shaped like this

```
┌──────────────────────────────────────────────┐
│  apps/web   React + xterm.js                   │  ← shared UI + (later) AI layer
│   Workspace ▸ VerticalTab ▸ HorizontalTab      │
├──────────────────────────────────────────────┤
│  packages/core   ITerminalBackend              │  ← the ONE seam
│    WebSocketBackend   (web / cloud)            │
│    LocalPtyBackend    (desktop, TODO)          │
├──────────────────────────────────────────────┤
│  apps/server   node-pty over WebSocket         │  ← local now; container-per-session later
└──────────────────────────────────────────────┘
```

Everything above `ITerminalBackend` is shared across web / desktop / cloud. To target a
new environment you write one more backend; the UI doesn't change.

## UI model — maximize the windows

- **Workspace** — far-left rail. A whole context (e.g. a client, a product).
- **Vertical tab** — left sidebar. A project / area inside the workspace.
- **Horizontal tab** — top strip. One live shell each.

Every horizontal tab is a persistent session: it keeps running (and keeps its scrollback)
while backgrounded — a build in one tab survives you switching away.

## Run

```bash
npm install          # builds node-pty natively (needs Xcode CLT on macOS)
npm run dev          # starts PTY server (:5174) + web (:5173)
```

Open http://localhost:5173.

### Shortcuts

| Key     | Action               |
| ------- | -------------------- |
| ⌘T      | New horizontal tab   |
| ⌘N      | New vertical tab     |
| ⌘⇧N     | New workspace        |
| ⌘W      | Close horizontal tab |

## Roadmap (next)

- **Split panes** inside a horizontal tab (grid view — true "max windows").
- **AI layer** in `apps/web` — pipe terminal output to Claude for inline command
  suggestion / error diagnosis / natural-language execution.
- **Desktop**: wrap `apps/web` in Tauri, add `LocalPtyBackend` (portable-pty/node-pty).
- **Cloud**: move `apps/server` behind auth + a container-per-session sandbox.
- **Session reconnect**: survive page reload (server-side PTY persistence).
