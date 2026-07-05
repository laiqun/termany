import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { applyTheme, previewTheme, registerTheme, type Theme } from "../themes";
import { CloseIcon } from "./icons";

type ColorKey = "bg" | "bg2" | "bg3" | "border" | "fg" | "fgDim" | "accent" | "accentSoft";

const COLOR_FIELDS: Array<{ key: ColorKey; label: string }> = [
  { key: "bg", label: "Background" },
  { key: "bg2", label: "Surface" },
  { key: "bg3", label: "Hover / active" },
  { key: "border", label: "Border" },
  { key: "fg", label: "Text" },
  { key: "fgDim", label: "Muted text" },
  { key: "accent", label: "Accent" },
  { key: "accentSoft", label: "Accent (soft)" },
];

// Caps uploaded background images so a big photo doesn't blow past
// localStorage's ~5MB quota once base64-encoded alongside every other theme.
const MAX_IMAGE_DIM = 1600;

function downscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("failed to load image"));
    };
    img.src = url;
  });
}

/**
 * Edit a theme's core colors and an optional background image, with a live
 * preview applied to the whole app as you type. Reset snaps every field back
 * to what it was when the editor opened, for whenever manual swatch-tuning
 * gets away from you. Saving always registers a NEW "custom-" theme (the
 * base is never mutated) and switches to it; closing without saving
 * reverts to whatever theme was actually active.
 */
export function ThemeEditor({ base, activeThemeId, onClose }: { base: Theme; activeThemeId: string; onClose: () => void }) {
  const setTheme = useStore((s) => s.setTheme);
  const [id] = useState(() => (base.id.startsWith("custom-") ? base.id : `custom-${crypto.randomUUID()}`));
  const initialName = base.id.startsWith("custom-") ? base.name : `${base.name} copy`;
  const [name, setName] = useState(initialName);
  const [colors, setColors] = useState({ ...base.colors });
  const [image, setImage] = useState(base.background?.image);
  const [opacity, setOpacity] = useState(base.background?.opacity ?? 0.85);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Save and the revert-on-unmount effect both fire from the same click —
  // React batches setTheme()'s and onClose()'s state updates into one
  // re-render, so this component unmounts before it ever sees the new
  // active id as a prop. Without this flag the cleanup below would stomp
  // the just-saved theme back to whatever was active before editing.
  const savedRef = useRef(false);

  function buildCandidate(): Theme {
    return {
      ...base,
      id,
      name: name.trim() || base.name,
      colors,
      background: image ? { image, opacity } : undefined,
      // Only the 3 colors that actually surfaced in the editor; the rest of
      // the 16-color ANSI palette stays whatever the base theme shipped with.
      term: { ...base.term, background: colors.bg, foreground: colors.fg, cursor: colors.accent },
    };
  }

  // Live preview on every change. Reverts to the real active theme on
  // unmount so closing without saving leaves nothing applied.
  useEffect(() => {
    previewTheme(buildCandidate());
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, colors, image, opacity]);

  useEffect(() => () => {
    if (!savedRef.current) applyTheme(activeThemeId);
  }, [activeThemeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pickImage(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      setImage(await downscaleImage(file));
    } catch {
      /* unreadable image — leave the background untouched */
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setName(initialName);
    setColors({ ...base.colors });
    setImage(base.background?.image);
    setOpacity(base.background?.opacity ?? 0.85);
  }

  function save() {
    savedRef.current = true;
    const saved = registerTheme(buildCandidate());
    setTheme(saved.id);
    onClose();
  }

  return (
    <div
      className="settings-backdrop"
      onClick={(e) => {
        // Nested inside Settings' own backdrop div — stop here so this click
        // doesn't also bubble up and close the whole Settings window.
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="theme-editor" role="dialog" aria-label="Edit theme" onClick={(e) => e.stopPropagation()}>
        <button className="settings-close" onClick={onClose}>
          <CloseIcon />
        </button>

        <div className="theme-editor-title">Edit theme</div>

        <label className="theme-editor-name">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <div className="theme-editor-section-title">Colors</div>
        <div className="theme-editor-colors">
          {COLOR_FIELDS.map(({ key, label }) => (
            <label key={key} className="theme-editor-color">
              <input
                type="color"
                value={colors[key]}
                onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="theme-editor-section-title">Background image</div>
        <div className="theme-editor-bg-row">
          <button className="ws-dialog-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Loading…" : image ? "Change image" : "Upload image"}
          </button>
          {image && (
            <button className="ws-dialog-btn" onClick={() => setImage(undefined)}>
              Remove
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickImage(e.target.files?.[0])} />
        </div>
        {image && (
          <label className="theme-editor-opacity">
            <span>Chrome opacity</span>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
        )}

        <div className="ws-dialog-actions">
          <button className="ws-dialog-btn theme-editor-reset" onClick={reset}>
            Reset
          </button>
          <button className="ws-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ws-dialog-btn primary" onClick={save}>
            Save as new theme
          </button>
        </div>
      </div>
    </div>
  );
}
