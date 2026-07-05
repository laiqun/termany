import { useCallback, useEffect, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { revealPath } from "../openExternal";
import { activeHtab, findLeaf, useStore } from "../state/store";
import { apiUrl, sendCommand } from "../terminal/manager";
import {
  ChevronIcon,
  CollapseAllIcon,
  FileEntryIcon,
  FolderIcon,
  RefreshIcon,
  RestoreExpandedIcon,
  RevealFolderIcon,
} from "./icons";

/** Base name only (Windows- and Unix-style separators both) — the preview
 *  header shows just this, not the full path (that's still in its title). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Quote a path as a `cd` argument — works as typed in both POSIX shells
 *  (bash/zsh/fish) and PowerShell for the vast majority of paths; only ones
 *  containing a literal `"` would need shell-specific escaping. */
function quoteForShell(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/** A directory's fetched children, keyed by its own absolute path. */
interface DirState {
  status: "loading" | "loaded" | "error";
  entries?: FsEntry[];
  error?: string;
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  // Fixed to "en-US", not the system locale — the rest of this UI is English
  // ("Reveal in Finder", column headers, …), and a locale like zh-CN produces
  // "2025年6月25日", which is both inconsistent and too wide for this column,
  // wrapping to two lines.
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/**
 * One row + (if a directory, expanded) its children, to any depth — mirrors
 * TreeSidebar's TreeItem. Clicking a folder expands/collapses it IN PLACE;
 * there is no "navigate into" — the root stays the pane's terminal cwd.
 * Clicking a file loads it into the preview panel on the right — the tree
 * itself never changes shape or gets replaced.
 */
function FileTreeRow({
  path,
  entry,
  depth,
  dirs,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: {
  path: string;
  entry: FsEntry;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = entry.isDir && expanded.has(path);
  const state = dirs[path];

  return (
    <>
      <div
        className={`file-tree-row ${!entry.isDir && path === selectedPath ? "selected" : ""}`}
        style={{ paddingLeft: 4 + depth * 9 }}
        onClick={() => (entry.isDir ? onToggleDir(path) : onSelectFile(path))}
      >
        <span className="file-tree-twisty">
          {entry.isDir && <ChevronIcon dir={isOpen ? "down" : "right"} />}
        </span>
        <span className="file-tree-icon">{entry.isDir ? <FolderIcon /> : <FileEntryIcon />}</span>
        <span className="file-tree-name">{entry.name}</span>
        <span className="file-tree-size">{formatSize(entry.size, entry.isDir)}</span>
        <span className="file-tree-date">{formatDate(entry.mtimeMs)}</span>
      </div>
      {isOpen && state?.status === "error" && (
        <div className="file-tree-message" style={{ paddingLeft: 4 + (depth + 1) * 9 }}>
          {state.error}
        </div>
      )}
      {isOpen && state?.status === "loaded" && state.entries!.length === 0 && (
        <div className="file-tree-message" style={{ paddingLeft: 4 + (depth + 1) * 9 }}>
          Empty directory
        </div>
      )}
      {isOpen &&
        state?.status === "loaded" &&
        state.entries!.map((child) => (
          <FileTreeRow
            key={child.name}
            path={`${path}/${child.name}`}
            entry={child}
            depth={depth + 1}
            dirs={dirs}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ))}
    </>
  );
}

interface Selected {
  path: string;
  status: "loading" | "text" | "binary" | "error";
  content?: string;
  truncated?: boolean;
  error?: string;
}

/**
 * The right-hand preview/editor panel — only ever mounted while a file is
 * selected (which is also when the pane is maximized), so there's no
 * "nothing selected" state to render here. Keyed on `selected.path` by the
 * caller, so switching files always gets a fresh instance (and with it, a
 * fresh CodeEditor + reset save/dirty state) rather than reusing stale state.
 */
function FilePreview({ selected, dark }: { selected: Selected; dark: boolean }) {
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // Reveal (not open) — opening a file with the OS default app needs a Tauri
  // permission (opener:allow-open-path) this app doesn't grant, and revealing
  // it selected in Finder/Explorer covers the same need without asking for it.
  const revealInFinder = (path: string) => {
    setOpenError(null);
    void revealPath(path).then((err) => {
      if (err) setOpenError(err);
    });
  };

  const save = useCallback((path: string, text: string) => {
    setSaveError(null);
    fetch(`${apiUrl()}/api/fs/write`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: text }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || `HTTP ${res.status}`);
        setDirty(false);
      })
      .catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
  }, []);

  const header = (
    <div className="file-tree-head">
      <span className="file-tree-path" title={selected.path}>
        {dirty && <span className="file-preview-dirty" title="Unsaved changes" />}
        {basename(selected.path)}
      </span>
      <button className="pane-btn" title="Reveal in Finder" onClick={() => revealInFinder(selected.path)}>
        <RevealFolderIcon />
      </button>
    </div>
  );

  if (selected.status === "loading") {
    return (
      <div className="file-preview-panel">
        {header}
      </div>
    );
  }

  if (selected.status === "binary") {
    return (
      <div className="file-preview-panel">
        {header}
        <div className="file-tree-message">Binary file — can't preview it here. Use "Reveal in Finder" to open it yourself.</div>
        {openError && <div className="file-tree-message file-preview-error">{openError}</div>}
      </div>
    );
  }

  if (selected.status === "error") {
    return (
      <div className="file-preview-panel">
        {header}
        <div className="file-tree-message">{selected.error}</div>
      </div>
    );
  }

  return (
    <div className="file-preview-panel">
      {header}
      {selected.truncated && (
        <div className="file-tree-message">
          File is larger than the 2 MB preview limit — showing (read-only) the start of it. Use "Reveal
          in Finder" to open the whole file yourself.
        </div>
      )}
      {saveError && <div className="file-tree-message file-preview-error">Save failed: {saveError}</div>}
      {openError && <div className="file-tree-message file-preview-error">{openError}</div>}
      <CodeEditor
        path={selected.path}
        content={selected.content ?? ""}
        dark={dark}
        readOnly={!!selected.truncated}
        onDirtyChange={setDirty}
        onSave={(text) => save(selected.path, text)}
      />
    </div>
  );
}

interface FileTreeState {
  root: string | null;
  rootError: string | null;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  collapsedFrom: Set<string> | null;
  selected: Selected | null;
}

function emptyFileTreeState(): FileTreeState {
  return { root: null, rootError: null, dirs: {}, expanded: new Set(), collapsedFrom: null, selected: null };
}

/**
 * Selecting a file maximizes the pane (see FileTree below), and maximizing a
 * not-yet-split pane makes SplitView swap which component sits at that tree
 * slot (a bare `<PaneSlot solo>` instead of `<SplitTree>`'s), which forces
 * React to unmount and remount everything under it — including this
 * component. Ordinary useState would lose the tree/preview right when they'd
 * just been set. Stash it here instead, keyed by session id (the same trick
 * the terminal session registry uses for the same reason), so a remount just
 * re-hydrates instead of starting over.
 */
const stateCache = new Map<string, FileTreeState>();

/**
 * A pane's alternative body: browse the filesystem rooted at `sessionId`'s
 * live shell cwd (resolved server-side — see /api/fs/list). By default it's
 * just the tree, full width. Clicking a file maximizes the pane and opens a
 * read-only preview alongside the tree (two columns); restoring the pane
 * closes the preview again — the split view only exists while "full-screen
 * editing" a file. Toggled from the pane header, alongside the terminal it's
 * attached to (not a global overlay), so each pane can independently show its
 * own terminal or its own file tree.
 */
export function FileTree({
  sessionId,
  initialCwdFrom,
}: {
  sessionId: string;
  /** A files-view pane has no PTY session of its own to resolve a live cwd
   *  from, so the root directory is instead resolved from WHATEVER pane was
   *  focused when this one was created (set once, at creation — see addPane
   *  in state/store.ts). Falls back to `sessionId` itself so toggling an
   *  EXISTING terminal pane to its file-tree view (which does have a live
   *  session) still opens rooted at that same pane's own cwd, as before. */
  initialCwdFrom?: string;
}) {
  const isMaximized = useStore((s) => activeHtab(s)?.maximized === sessionId);
  const toggleMaximize = useStore((s) => s.toggleMaximize);
  // Read once per render — cheap, and the editor only needs it at creation
  // anyway (see CodeEditor's own comment on why it doesn't react to changes).
  const dark = document.documentElement.dataset.appearance !== "light";

  const initial = stateCache.get(sessionId) ?? emptyFileTreeState();
  const [root, setRoot] = useState(initial.root);
  const [rootError, setRootError] = useState(initial.rootError);
  const [dirs, setDirs] = useState(initial.dirs);
  const [expanded, setExpanded] = useState(initial.expanded);
  // Snapshot of what was open right before the last "collapse all" — lets
  // the same button restore it, instead of collapsing being a one-way trip.
  const [collapsedFrom, setCollapsedFrom] = useState(initial.collapsedFrom);
  // Only trust a cached selection if we're ALSO currently maximized: a mount
  // while not maximized means this is the remount from Restore (exiting
  // fullscreen) or a fresh pane, either way the preview shouldn't reappear.
  const [selected, setSelected] = useState(isMaximized ? initial.selected : null);

  // The address bar's own draft text — separate from `root` so typing
  // doesn't take effect until Enter, and doesn't get clobbered by a
  // background refresh while the input is focused.
  const [addressDraft, setAddressDraft] = useState(root ?? "");
  const [addressFocused, setAddressFocused] = useState(false);
  useEffect(() => {
    if (!addressFocused) setAddressDraft(root ?? "");
  }, [root, addressFocused]);

  // Always up to date without depending on the closure — read from a plain
  // ref inside async callbacks below instead of the `root` state variable,
  // which would otherwise be whatever it was when that callback was created.
  const rootRef = useRef(root);
  rootRef.current = root;
  // The session's live cwd as of the last resolveRootFromSession() call —
  // NOT necessarily the same as `root`, which a manual address-bar
  // navigation can point elsewhere. Compared against `root` when leaving
  // files view (see the sync-back-to-terminal effect below) to decide
  // whether the terminal actually needs a `cd`.
  const lastKnownCwd = useRef<string | null>(null);

  const loadDir = useCallback((path: string) => {
    setDirs((d) => ({ ...d, [path]: { status: "loading" } }));
    fetch(`${apiUrl()}/api/fs/list?${new URLSearchParams({ path })}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setDirs((d) => ({ ...d, [path]: { status: "loaded", entries: body.entries } }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setDirs((d) => ({ ...d, [path]: { status: "error", error: msg } }));
      });
  }, []);

  // A genuinely new navigation (the address bar, below) — resets the tree,
  // since folders expanded under the OLD root have nothing to do with this one.
  const navigateTo = useCallback((path: string) => {
    setRootError(null);
    fetch(`${apiUrl()}/api/fs/list?${new URLSearchParams({ path })}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setRoot(body.path);
        setDirs({ [body.path]: { status: "loaded", entries: body.entries } });
        setExpanded(new Set());
        setCollapsedFrom(null);
        setSelected(null);
      })
      .catch((e) => setRootError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Resolve root from the pane's LIVE session cwd. Called every time this
  // component (re)mounts — including the maximize-triggered remount AND a
  // terminal<->files view switch, which look identical from in here (both
  // are just "FileTree mounted again"). The two cases need OPPOSITE
  // behavior: a maximize remount should preserve everything (the cwd hasn't
  // had time to change), while a view-switch remount should drop a stale
  // manual navigation and reflect wherever the terminal cd'ed to meanwhile.
  // Comparing the freshly resolved path to whatever root we already have
  // gives us both for free: same path -> just refresh its listing in place;
  // different path -> this is effectively a fresh entry, reset the tree.
  const resolveRootFromSession = useCallback(() => {
    setRootError(null);
    fetch(`${apiUrl()}/api/fs/list?${new URLSearchParams({ session: initialCwdFrom ?? sessionId })}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        lastKnownCwd.current = body.path;
        setRoot(body.path);
        if (rootRef.current !== null && rootRef.current === body.path) {
          setDirs((d) => ({ ...d, [body.path]: { status: "loaded", entries: body.entries } }));
        } else {
          setDirs({ [body.path]: { status: "loaded", entries: body.entries } });
          setExpanded(new Set());
          setCollapsedFrom(null);
          setSelected(null);
        }
      })
      .catch((e) => setRootError(e instanceof Error ? e.message : String(e)));
  }, [sessionId, initialCwdFrom]);

  // Mirror every render's state into the cache, keyed by this pane's session —
  // NOT scoped to a dependency list, since ANY of the six pieces changing
  // should update it (cheap: a Map.set of a plain object).
  useEffect(() => {
    stateCache.set(sessionId, { root, rootError, dirs, expanded, collapsedFrom, selected });
  });

  // Only hydrate from a DIFFERENT session's cache when `sessionId` actually
  // changes after mount — the lazy useState above already seeded the right
  // values for the initial mount (including a remount that preserved the
  // same session id), so re-doing it here would just discard what was just
  // restored. resolveRootFromSession() runs on EVERY mount regardless (see
  // its own doc comment for why that's the right call for both remount cases).
  const lastSessionId = useRef<string>();
  useEffect(() => {
    if (lastSessionId.current !== undefined && lastSessionId.current !== sessionId) {
      const cached = stateCache.get(sessionId) ?? emptyFileTreeState();
      setRoot(cached.root);
      setRootError(cached.rootError);
      setDirs(cached.dirs);
      setExpanded(cached.expanded);
      setCollapsedFrom(cached.collapsedFrom);
      setSelected(isMaximized ? cached.selected : null);
    }
    lastSessionId.current = sessionId;
    resolveRootFromSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // NOT keyed on isMaximized: that would re-run this on every maximize
    // toggle, re-resolving (and possibly resetting) state we want to leave
    // alone outside of an actual remount.
  }, [sessionId, resolveRootFromSession]);

  // The other half of keeping the tree and the terminal in sync: leaving
  // files view for terminal should `cd` the shell to wherever the tree
  // ended up (typically from a manual address-bar navigation — the terminal
  // has no way to know about that on its own). Only a genuine view switch —
  // not the maximize-triggered remount, which never touches `leaf.view` —
  // reaches this with a leaf whose view is no longer "files". Reads
  // everything through refs so the closure captured at mount time doesn't
  // matter; this only runs once, in the cleanup, right as the component
  // actually goes away.
  useEffect(() => {
    return () => {
      const htab = activeHtab(useStore.getState());
      const leaf = htab && findLeaf(htab.layout, sessionId);
      if (!leaf || leaf.view === "files") return;
      const path = rootRef.current;
      if (path && path !== lastKnownCwd.current) sendCommand(sessionId, `cd ${quoteForShell(path)}`);
    };
  }, [sessionId]);

  // Click a file: maximize the pane (if it isn't already) — this is ONLY safe
  // to pair with a local setSelected because the cache write below happens
  // SYNCHRONOUSLY, as a plain object mutation. toggleMaximize causes the same
  // remount described in the module doc comment, and when that remount is
  // triggered in the SAME event handler as a React state update, React can
  // discard the old fiber (and that state update with it) before it ever
  // commits — so a `setSelected` here alone could vanish along with the
  // instance that called it. The direct cache write has no such lifecycle;
  // it's there unconditionally for whichever instance (old or new) reads it.
  const selectFile = (path: string) => {
    const next: Selected = { path, status: "loading" };
    stateCache.set(sessionId, { ...(stateCache.get(sessionId) ?? emptyFileTreeState()), selected: next });
    setSelected(next);
    if (!isMaximized) toggleMaximize(sessionId);
  };

  // Actually fetch the selected file's content. Runs in whichever FileTree
  // instance is current when `selected.status` is "loading" — including a
  // FRESH instance after the maximize-triggered remount above, so even if an
  // earlier instance's in-flight request never gets to land (its result would
  // call a dead setSelected — harmless no-op, but also lost), this instance's
  // own effect independently redoes it and succeeds.
  useEffect(() => {
    if (selected?.status !== "loading") return;
    const path = selected.path;
    let live = true;
    fetch(`${apiUrl()}/api/fs/read?${new URLSearchParams({ path })}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const result: Selected = body.binary
          ? { path, status: "binary" }
          : { path, status: "text", content: body.content, truncated: !!body.truncated };
        if (!live) return;
        stateCache.set(sessionId, { ...(stateCache.get(sessionId) ?? emptyFileTreeState()), selected: result });
        setSelected(result);
      })
      .catch((e) => {
        if (!live) return;
        setSelected({ path, status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [selected?.path, selected?.status, sessionId]);

  const toggleDir = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening && !dirs[path]) loadDir(path);
  };

  // Refresh re-fetches the CURRENT root (wherever it is — session-resolved or
  // manually navigated to) plus every currently-expanded subdirectory, so the
  // open shape of the tree survives — only the contents go stale-free. Unlike
  // resolveRootFromSession, this deliberately does NOT jump back to the
  // session's live cwd — that would undo a manual navigation the user is
  // just trying to refresh, not leave.
  const refresh = () => {
    if (root) loadDir(root);
    else resolveRootFromSession();
    expanded.forEach(loadDir);
  };

  // One button, two jobs: collapse everything (remembering what was open),
  // then flip to restoring that exact set back open again.
  const collapsedAll = expanded.size === 0 && !!collapsedFrom;
  const toggleCollapseAll = () => {
    if (collapsedAll) {
      setExpanded(collapsedFrom!);
      setCollapsedFrom(null);
    } else if (expanded.size > 0) {
      setCollapsedFrom(expanded);
      setExpanded(new Set());
    }
  };

  const rootState = root ? dirs[root] : undefined;

  const treeUi = (
    <>
      <div className="file-tree-head">
        <input
          className="file-tree-path file-tree-path-input"
          value={addressDraft}
          spellCheck={false}
          title={root ?? ""}
          onFocus={() => setAddressFocused(true)}
          onChange={(e) => setAddressDraft(e.target.value)}
          onBlur={() => {
            setAddressFocused(false);
            setAddressDraft(root ?? "");
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              const target = addressDraft.trim();
              if (target && target !== root) navigateTo(target);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setAddressDraft(root ?? "");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          className="pane-btn"
          title="Reveal in Finder"
          disabled={!root}
          onClick={() => root && void revealPath(root).then((err) => err && console.warn("[termany]", err))}
        >
          <RevealFolderIcon />
        </button>
        <button
          className="pane-btn"
          title={collapsedAll ? "Restore expanded folders" : "Collapse all"}
          disabled={expanded.size === 0 && !collapsedFrom}
          onClick={toggleCollapseAll}
        >
          {collapsedAll ? <RestoreExpandedIcon /> : <CollapseAllIcon />}
        </button>
        <button className="pane-btn" title="Refresh" onClick={refresh}>
          <RefreshIcon />
        </button>
      </div>
      <div className="file-tree-list">
        {rootError && <div className="file-tree-message">{rootError}</div>}
        {!rootError && rootState?.status === "loaded" && rootState.entries!.length === 0 && (
          <div className="file-tree-message">Empty directory</div>
        )}
        {!rootError &&
          root &&
          rootState?.entries?.map((entry) => (
            <FileTreeRow
              key={entry.name}
              path={`${root}/${entry.name}`}
              entry={entry}
              depth={0}
              dirs={dirs}
              expanded={expanded}
              selectedPath={selected?.path ?? null}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
            />
          ))}
      </div>
    </>
  );

  // Default: just the tree, full width. The preview column only exists while
  // a file is open (which is also when the pane is maximized) — see the
  // module doc comment above for why.
  if (!selected) return <div className="file-tree">{treeUi}</div>;

  return (
    <div className="file-tree-split">
      <div className="file-tree">{treeUi}</div>
      <FilePreview key={selected.path} selected={selected} dark={dark} />
    </div>
  );
}
