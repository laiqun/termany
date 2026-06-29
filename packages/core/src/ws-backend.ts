import type { ClientMessage, ITerminalBackend } from "./backend.js";

/**
 * Talks to a PTY server over a single WebSocket.
 *
 * Protocol:
 *   - server -> client : raw text frames === terminal output
 *   - client -> server : JSON ClientMessage frames (input / resize)
 *
 * Messages sent before the socket is open are buffered and flushed on open,
 * so callers never have to care about connection timing.
 */
export class WebSocketBackend implements ITerminalBackend {
  private ws: WebSocket;
  private open = false;
  private outbox: string[] = [];
  private dataCb?: (data: string) => void;
  private exitCb?: () => void;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.open = true;
      for (const m of this.outbox) this.ws.send(m);
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") this.dataCb?.(e.data);
    };
    this.ws.onclose = () => this.exitCb?.();
  }

  onData(cb: (data: string) => void) {
    this.dataCb = cb;
  }

  onExit(cb: () => void) {
    this.exitCb = cb;
  }

  write(data: string) {
    this.send({ type: "input", data });
  }

  resize(cols: number, rows: number) {
    this.send({ type: "resize", cols, rows });
  }

  dispose() {
    this.open = false;
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

  private send(msg: ClientMessage) {
    const frame = JSON.stringify(msg);
    if (this.open) this.ws.send(frame);
    else this.outbox.push(frame);
  }
}
