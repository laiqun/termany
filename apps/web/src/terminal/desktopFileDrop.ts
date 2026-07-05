import { isTauri } from "../env";

type DesktopFileDropEvent =
  | { type: "enter" | "over" | "drop"; paths: string[]; points: Array<{ x: number; y: number }> }
  | { type: "leave" };

type Listener = (event: DesktopFileDropEvent) => void;

const listeners = new Set<Listener>();
let unlistenPromise: Promise<() => void> | null = null;

async function listenToTauriDrops(): Promise<() => void> {
  const [{ getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/webview"),
    import("@tauri-apps/api/window"),
  ]);
  const win = getCurrentWindow();
  let scaleFactor = await win.scaleFactor();
  const unlistenScale = await win.onScaleChanged(({ payload }) => {
    scaleFactor = payload.scaleFactor;
  });
  const unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      for (const listener of listeners) listener({ type: "leave" });
      return;
    }

    const physical = payload.position;
    const logical = physical.toLogical(scaleFactor);
    const paths = payload.type === "over" ? [] : payload.paths;
    for (const listener of listeners) {
      listener({
        type: payload.type,
        paths,
        points: [
          { x: logical.x, y: logical.y },
          { x: physical.x, y: physical.y },
        ],
      });
    }
  });

  return () => {
    unlistenDragDrop();
    unlistenScale();
  };
}

function ensureListening() {
  if (!isTauri || unlistenPromise) return;
  unlistenPromise = listenToTauriDrops().catch((e) => {
    unlistenPromise = null;
    console.warn("[termany] failed to listen for desktop file drops", e);
    return () => {};
  });
}

export function subscribeDesktopFileDrops(listener: Listener): () => void {
  if (!isTauri) return () => {};
  listeners.add(listener);
  ensureListening();

  return () => {
    listeners.delete(listener);
    if (listeners.size || !unlistenPromise) return;

    const pending = unlistenPromise;
    unlistenPromise = null;
    void pending.then((unlisten) => unlisten());
  };
}
