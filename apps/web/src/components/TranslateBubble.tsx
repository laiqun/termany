import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { apiPath } from "../api";
import { useNativeOccluder } from "../nativeViewOcclusion";
import { TRANSLATE_SELECTION_EVENT, type TranslateSelectionDetail } from "../terminal/manager";
import { CloseIcon, SpeakerIcon, SpinnerIcon } from "./icons";

interface EngineTranslation {
  id: string;
  name: string;
  translation?: string;
  phonetic?: string;
  definitions?: string[];
  error?: string;
}

interface TranslateResult {
  text: string;
  detectedLang: string;
  audioUs?: string;
  audioUk?: string;
  audio?: string;
  engines: EngineTranslation[];
}

interface BubbleState {
  anchor: TranslateSelectionDetail;
  result?: TranslateResult;
  error?: string;
}

const BUBBLE_WIDTH = 320;
const EDGE_MARGIN = 8;

/**
 * Non-modal dictionary popup for the terminal's Alt+drag selection gesture.
 * Anchored at the mouseup point, clamped into the window; closes on Escape or
 * on any click elsewhere — selecting again simply re-anchors it with the new
 * text. Like every floating layer it registers as a native-view occluder so
 * web/office preview panes underneath go blank instead of painting over it.
 */
export function TranslateBubble() {
  const occluderId = useId();
  const [state, setState] = useState<BubbleState | null>(null);
  const bubbleRef = useNativeOccluder<HTMLDivElement>(occluderId, state !== null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch on each new selection; a response for superseded text is dropped.
  const requestId = useRef(0);
  const startLookup = (anchor: TranslateSelectionDetail) => {
    if (!anchor?.text.trim()) return;
    const id = ++requestId.current;
    setState({ anchor });
    fetch(apiPath("/api/translate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: anchor.text }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (requestId.current === id) setState({ anchor, result: body as TranslateResult });
      })
      .catch((err) => {
        if (requestId.current === id) {
          setState({ anchor, error: err instanceof Error ? err.message : String(err) });
        }
      });
  };
  const startLookupRef = useRef(startLookup);
  startLookupRef.current = startLookup;

  // Terminal panes raise the event themselves from their xterm selection.
  useEffect(() => {
    const onSelect = (event: Event) => {
      const anchor = (event as CustomEvent<TranslateSelectionDetail>).detail;
      if (anchor) startLookupRef.current(anchor);
    };
    window.addEventListener(TRANSLATE_SELECTION_EVENT, onSelect);
    return () => window.removeEventListener(TRANSLATE_SELECTION_EVENT, onSelect);
  }, []);

  // Every other pane (agent chat, settings, previews…) is plain DOM text, so
  // the same Alt+drag gesture is tracked here against window.getSelection().
  // Skipped inside .xterm (handled above, and xterm swallows the DOM
  // selection) and inside .web-pane (explicitly excluded, and its webview is
  // a native view whose mouse events never reach the DOM anyway).
  useEffect(() => {
    let gesture: { x: number; y: number; dragged: boolean; clickCount: number } | null = null;
    const onMouseDown = (event: MouseEvent) => {
      gesture = null;
      if (event.button !== 0 || !event.altKey) return;
      const target = event.target as Element | null;
      if (target?.closest(".xterm, .web-pane, .translate-bubble")) return;
      gesture = { x: event.clientX, y: event.clientY, dragged: false, clickCount: event.detail };
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!gesture || !(event.buttons & 1)) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (dx * dx + dy * dy >= 16) gesture.dragged = true;
    };
    const onMouseUp = (event: MouseEvent) => {
      const g = gesture;
      gesture = null;
      if (event.button !== 0 || !g) return;
      if (!g.dragged && g.clickCount < 2) return;
      const text = window.getSelection()?.toString() ?? "";
      if (!text.trim()) return;
      startLookupRef.current({ text, x: event.clientX, y: event.clientY });
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);

  const close = () => setState(null);
  const open = state !== null;

  // Escape or a click anywhere outside dismisses; the capture-phase key handler
  // swallows Escape so the pane underneath doesn't also react.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!bubbleRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Stop any playing pronunciation when the bubble closes or re-anchors.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [state?.anchor]);

  // Clamp into the window once the content (and thus the height) is known.
  // Opens below-right of the cursor, flipping above when there's no room.
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!state || !el) return;
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - EDGE_MARGIN;
    const maxY = window.innerHeight - rect.height - EDGE_MARGIN;
    let x = Math.min(Math.max(state.anchor.x + 4, EDGE_MARGIN), Math.max(maxX, EDGE_MARGIN));
    let y = state.anchor.y + 14;
    if (y > maxY) y = Math.max(state.anchor.y - rect.height - 10, EDGE_MARGIN);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }, [state]);

  if (!state) return null;
  const { result, error } = state;
  // The phonetic is dictionary data, currently provided by the youdao engine.
  const phonetic = result?.engines.find((e) => e.phonetic)?.phonetic;

  const play = (url: string) => {
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.play().catch(() => { });
  };

  return (
    <div className="translate-bubble" ref={bubbleRef} style={{ width: BUBBLE_WIDTH }}>
      <div className="translate-bubble-head">
        <span className="translate-bubble-source">{state.anchor.text}</span>
        <button className="translate-bubble-btn" onClick={close} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      {phonetic && <div className="translate-bubble-phonetic">{phonetic}</div>}
      {(result?.audioUs || result?.audioUk || result?.audio) && (
        <div className="translate-bubble-audio">
          {result.audioUk && (
            <button className="translate-bubble-say" onClick={() => play(result.audioUk!)}>
              <SpeakerIcon /> UK
            </button>
          )}
          {result.audioUs && (
            <button className="translate-bubble-say" onClick={() => play(result.audioUs!)}>
              <SpeakerIcon /> US
            </button>
          )}
          {result.audio && !result.audioUs && (
            <button className="translate-bubble-say" onClick={() => play(result.audio!)}>
              <SpeakerIcon />
            </button>
          )}
        </div>
      )}
      {!result && !error && (
        <div className="translate-bubble-status">
          <SpinnerIcon />
        </div>
      )}
      {error && <div className="translate-bubble-error">{error}</div>}
      {result?.engines.map((engine) => (
        <div className="translate-bubble-engine" key={engine.id}>
          <div className="translate-bubble-engine-name">{engine.name}</div>
          {engine.translation && (
            <div className="translate-bubble-translation">{engine.translation}</div>
          )}
          {engine.definitions && engine.definitions.length > 1 && (
            <ul className="translate-bubble-defs">
              {engine.definitions.map((def, i) => (
                <li key={i}>{def}</li>
              ))}
            </ul>
          )}
          {engine.error && <div className="translate-bubble-engine-error">{engine.error}</div>}
        </div>
      ))}
    </div>
  );
}
