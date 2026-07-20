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
- Sign off your commits with `git commit -s` — see [License of contributions](#license-of-contributions).

## License of contributions

Termany is released under [AGPL-3.0](LICENSE), and is also offered under a separate
commercial license to organizations that cannot accept AGPL terms. Keeping both
options open requires every contribution to carry the same two grants, so by
submitting a pull request you agree to the following.

**1. Certificate of origin.** You certify the [Developer Certificate of Origin
1.1](https://developercertificate.org/) — in short, that you wrote the contribution
yourself, or have the right to submit it under these terms, and that you understand
it will be public and kept indefinitely. Sign off each commit with `git commit -s`,
which appends a `Signed-off-by:` line.

**2. Licensing grant.** You retain copyright in your contribution. You grant
ThinkAny, LLC a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to
use, reproduce, modify, and distribute your contribution — including the right to
distribute it under AGPL-3.0 **and** under the project's commercial license terms.
You also grant every recipient of the software a patent license covering any of your
patent claims that your contribution necessarily infringes.

If you cannot make these grants — for example your employer owns the copyright in
your work — please say so in the pull request before we review it, so we can sort
out the paperwork rather than merge something we cannot relicense.

> These terms exist so a single dual-licensed codebase stays legally coherent; they
> do not give up your own rights to your code. They are not legal advice — if your
> situation is complicated, talk to a lawyer.
