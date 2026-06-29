/**
 * The single seam between "the terminal UI" and "where the shell actually runs".
 *
 * Everything above this interface (xterm.js rendering, tabs, AI layer) is shared
 * across every form factor. Below it, each environment ships its own implementation:
 *
 *   - WebSocketBackend  -> talks to a remote/local PTY server   (web, cloud)
 *   - LocalPtyBackend   -> node-pty in the desktop process      (Electron/Tauri, TODO)
 *
 * Add a new place to run a shell == write one more implementation of this. The UI
 * never changes.
 */
export interface ITerminalBackend {
  /** Register the callback that receives raw terminal output (server -> UI). */
  onData(cb: (data: string) => void): void;
  /** Send user keystrokes / input to the shell (UI -> server). */
  write(data: string): void;
  /** Tell the PTY the new viewport size. */
  resize(cols: number, rows: number): void;
  /** Register a callback for when the underlying session ends. */
  onExit(cb: () => void): void;
  /** Tear down the connection / session. */
  dispose(): void;
}

/** Wire protocol: UI -> server messages (JSON text frames). */
export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
