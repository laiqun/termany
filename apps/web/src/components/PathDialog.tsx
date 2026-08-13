import { useState } from "react";
import { resolveDirCwd } from "../fs";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { useStore } from "../state/store";

/**
 * Modal "pick a working directory" prompt shown before a page/tab is created
 * (see store.pathPrompt). The input is pre-filled with the directory the new
 * page/tab would have inherited, so accepting the default is a single Enter;
 * Escape cancels the creation entirely. An invalid path flags the input red
 * (Enter keeps the dialog open); an empty input means home.
 */
export function PathDialog() {
  const { t } = useI18n();
  const ime = useImeGuard();
  const prompt = useStore((s) => s.pathPrompt);
  const closePathPrompt = useStore((s) => s.closePathPrompt);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!prompt) return null;

  const commit = async (raw: string) => {
    if (busy) return;
    setBusy(true);
    const cwd = await resolveDirCwd(raw);
    setBusy(false);
    if (cwd === null) {
      setInvalid(true);
      return;
    }
    const s = useStore.getState();
    if (prompt.kind === "tab") s.addHTab(cwd);
    else if (prompt.kind === "childPage" && prompt.parentId) s.addChildNode(prompt.parentId, cwd);
    else s.addRootNode(cwd);
    closePathPrompt();
  };

  const titleKey =
    prompt.kind === "tab"
      ? "pathPrompt.newTab"
      : prompt.kind === "childPage"
        ? "pathPrompt.newChildPage"
        : "pathPrompt.newPage";

  return (
    <div className="search-backdrop" onClick={closePathPrompt}>
      <div className="path-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="path-prompt-title">{t(titleKey)}</div>
        <input
          key={prompt.initial}
          className={`path-prompt-input${invalid ? " invalid" : ""}`}
          autoFocus
          defaultValue={prompt.initial}
          placeholder="~"
          spellCheck={false}
          {...ime.props}
          onFocus={(e) => e.target.select()}
          onChange={() => setInvalid(false)}
          onKeyDown={(e) => {
            if (ime.handled(e)) return; // the IME is still using this key
            if (e.key === "Enter") void commit((e.target as HTMLInputElement).value);
            else if (e.key === "Escape") closePathPrompt();
          }}
        />
        <div className={`path-prompt-foot${invalid ? " invalid" : ""}`}>
          {invalid ? t("pathPrompt.invalid") : t("pathPrompt.hint")}
        </div>
      </div>
    </div>
  );
}
