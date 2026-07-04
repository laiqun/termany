# Termany

An agent-native terminal — **local-first, cloud-ready**. The same UI runs as a web app and as a
desktop client today, and as a cloud service later, by swapping one thing: the backend.

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

## Run (web, dev)

```bash
npm install          # builds node-pty natively (needs Xcode CLT on macOS)
npm run dev          # starts PTY server (:5174) + web (:5173)
```

Open http://localhost:5173.

## Desktop app

The desktop client wraps `apps/web` in [Tauri](https://tauri.app) and ships the
Node PTY/API server alongside it (a bundled Node runtime + `node-pty`), so it runs
fully offline with no separate install.

```bash
npm run desktop      # dev: server + web + the Tauri shell, hot-reloading
```

### Build installers

Installers are produced in CI (`.github/workflows/`), one job per OS:

- **macOS** (`build.yml`) — signed + notarized `.dmg`, attached to a draft GitHub
  Release. Requires the `APPLE_*` repository secrets.
- **Windows** (`build-windows.yml`) — NSIS `.exe`, uploaded as a build artifact.
  No secrets required (unsigned).

Both rely on `scripts/bundle-server.mjs`, which assembles the Node server for the
host platform before the Tauri build. To build the macOS DMG locally, see
`scripts/release-mac.sh`.

## Configuration

Model providers are **BYOK** (bring your own key) — added at runtime in the app and
stored locally in `~/.termany/termany.db`; no keys live in this repo. Optional env vars:

| Variable            | Default        | Purpose                                  |
| ------------------- | -------------- | ---------------------------------------- |
| `TERMANY_PORT`      | `5174`         | PTY/API server port                      |
| `TERMANY_PASTE_DIR` | system temp    | Where pasted images are written          |
| `VITE_PTY_URL`      | `ws://localhost:5174` | Web client → PTY WebSocket        |
| `VITE_API_URL`      | `http://localhost:5174` | Web client → REST API           |

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
- **`LocalPtyBackend`** — an in-process pty backend for desktop (today the desktop
  app talks to the bundled server over a local WebSocket).
- **Cloud**: move `apps/server` behind auth + a container-per-session sandbox.
- **Session reconnect**: survive page reload (server-side PTY persistence).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and PR guidelines, and
[SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[AGPL-3.0](LICENSE) © Termany. Network use is distribution: if you run a modified
version as a service, you must offer users its source. For commercial licensing
outside the AGPL, contact support@trys.ai.
