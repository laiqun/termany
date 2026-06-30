# Contributing to Termany

Thanks for your interest in improving Termany! This guide covers local setup and
how to get a change merged.

## Prerequisites

- **Node.js 22+** (the bundled desktop runtime is Node 24; see `scripts/bundle-server.mjs`)
- **Rust** (stable) + the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  for desktop builds
- macOS: Xcode Command Line Tools (so `node-pty` compiles natively)

## Setup

```bash
git clone git@github.com:thinkany-ai/termany.git
cd termany
npm install            # installs workspaces + builds node-pty
```

## Running

```bash
npm run dev            # web only: PTY server (:5174) + web (:5173)
npm run desktop        # desktop: server + web + Tauri shell, hot-reloading
```

## Project layout

| Path             | What it is                                              |
| ---------------- | ------------------------------------------------------- |
| `apps/web`       | React + xterm.js UI (shared across web/desktop/cloud)   |
| `apps/server`    | Node `node-pty` PTY/API server over WebSocket           |
| `apps/desktop`   | Tauri desktop shell (`src-tauri` = Rust)                |
| `packages/core`  | `ITerminalBackend` — the one seam between UI and backend |
| `scripts`        | Server bundling + release helpers                       |

Anything above `ITerminalBackend` (in `packages/core`) is shared; to support a new
environment you add a backend, not change the UI.

## Pull requests

- Branch off `main`; keep PRs focused and reasonably small.
- Match the surrounding code style (the codebase favors small, well-commented modules).
- Make sure `npm run dev` and, for desktop-touching changes, `npm run desktop` work.
- For changes to the build/bundle pipeline, note how you verified them.

## License of contributions

By contributing, you agree your contributions are licensed under the project's
[AGPL-3.0](LICENSE) license.
