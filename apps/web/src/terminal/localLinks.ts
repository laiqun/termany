import type { IBufferCell, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { revealPath } from "../openExternal";

/** Resolve candidate path strings to absolute paths (null = not a real file). */
export type ResolvePaths = (paths: string[]) => Promise<Array<string | null>>;

// Characters allowed inside a path segment — permissive (CJK filenames are
// common) but stops at whitespace, quotes, shell/prose delimiters, and `:`
// so a compiler's `:line:col` suffix never becomes part of the match.
const SEG = "[^\\s/\\\\\"'`<>|:*?()\\[\\]{},;=]";
const FILE_URL_RE = /file:\/\/[^\s"'<>`]+/g;
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|*?]+/g;
// Absolute-ish (/x, ~/x, ./x, ../x) at any depth, or bare relative with at
// least two segments (`src/foo.ts`) — a single bare word is never a path.
const UNIX_PATH_RE = new RegExp(
  `(?:~|\\.{1,2})?/${SEG}+(?:/${SEG}+)*/?|${SEG}+(?:/${SEG}+)+/?`,
  "g"
);
// Web URLs are WebLinksAddon's job — their path portion must not double-match.
const URL_RE = /[a-zA-Z][\w+.-]*:\/\/[^\s"'<>`]+/g;

const TRAILING_PUNCT_RE = /[),.;\]]+$/;
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

const MAX_CANDIDATES_PER_LINE = 16;
const MAX_WINDOW_LINES = 16;
const CACHE_TTL_MS = 5_000;
const CACHE_MAX = 200;

function fileUrlToPath(value: string): string {
  const url = new URL(value);
  let path = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path;
}

function normalizeLinkText(value: string): string {
  let text = value.replace(TRAILING_PUNCT_RE, "");
  text = text.replace(LINE_SUFFIX_RE, "");
  return text;
}

function pathFromLinkText(value: string): string {
  if (value.startsWith("file://")) return fileUrlToPath(value);
  return value;
}

interface Candidate {
  index: number;
  text: string;
  fileUrl?: boolean;
}

function collectMatches(line: string, re: RegExp, fileUrl = false): Candidate[] {
  const matches: Candidate[] = [];
  for (const match of line.matchAll(re)) {
    const text = normalizeLinkText(match[0]);
    if (!text) continue;
    matches.push({ index: match.index ?? 0, text, fileUrl });
  }
  return matches;
}

function findCandidates(line: string): Candidate[] {
  const urlRanges = [...line.matchAll(URL_RE)]
    .filter((match) => !match[0].startsWith("file://"))
    .map((match) => {
      const start = match.index ?? 0;
      return { start, end: start + match[0].length };
    });

  // Leftmost-longest wins: a Windows drive path or file:// URL swallows the
  // shorter unix-style match its tail would otherwise produce.
  const all = [
    ...collectMatches(line, FILE_URL_RE, true),
    ...collectMatches(line, WINDOWS_PATH_RE),
    ...collectMatches(line, UNIX_PATH_RE),
  ].sort((a, b) => a.index - b.index || b.text.length - a.text.length);

  const accepted: Array<Candidate & { end: number }> = [];
  for (const candidate of all) {
    const end = candidate.index + candidate.text.length;
    if (accepted.some((a) => candidate.index < a.end && end > a.index)) continue;
    if (!candidate.fileUrl && urlRanges.some((r) => candidate.index < r.end && end > r.start)) {
      continue;
    }
    accepted.push({ ...candidate, end });
  }
  return accepted.slice(0, MAX_CANDIDATES_PER_LINE);
}

interface MappedLine {
  text: string;
  positions: CellPosition[];
  isWrapped: boolean;
  reachesRightEdge: boolean;
}

interface CellPosition {
  x: number;
  y: number;
  width: number;
}

/**
 * Flatten a buffer line to a string while remembering which COLUMN each string
 * character sits in. `translateToString()` alone won't do: wide chars (CJK)
 * occupy two cells but one string char, so string index ≠ column and every
 * link range after a Chinese character would be shifted left.
 */
function mapLine(terminal: Terminal, y: number, cell: IBufferCell): MappedLine | null {
  const line = terminal.buffer.active.getLine(y);
  if (!line) return null;

  let text = "";
  const positions: CellPosition[] = [];
  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell)) break;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || " "; // empty cell renders as a space
    for (let i = 0; i < chars.length; i++) {
      positions.push({ x, y, width });
    }
    text += chars;
  }

  const trimmedLength = text.trimEnd().length;
  text = text.slice(0, trimmedLength);
  positions.length = trimmedLength;
  const last = positions.at(-1);
  return {
    text,
    positions,
    isWrapped: line.isWrapped,
    reachesRightEdge: !!last && last.x + last.width >= terminal.cols,
  };
}

function continues(previous: MappedLine, next: MappedLine): boolean {
  if (!next.text || /^\s/.test(next.text)) return false;
  // Natural terminal wrapping marks the continuation row. Rich CLI output may
  // instead insert CRLF itself, so also join a non-indented row after a line
  // that filled the terminal width.
  return next.isWrapped || previous.reachesRightEdge;
}

/**
 * Underline local file paths in terminal output and reveal them in
 * Finder/Explorer on click. Candidates (including RELATIVE paths like
 * `src/foo/bar.ts`) are verified through `resolvePaths` — the server resolves
 * them against the session shell's live cwd and stats them — so only paths
 * that actually exist get a link, and activation always has an absolute path.
 */
export function registerLocalPathLinks(term: Terminal, resolvePaths: ResolvePaths): void {
  // Cache per candidate set so hovering doesn't re-stat the same line, with a
  // short TTL so files created after the output was printed still linkify.
  const cache = new Map<string, { at: number; result: Promise<Array<string | null>> }>();
  const resolveCached = (paths: string[]) => {
    const key = paths.join("\n");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
    const result = resolvePaths(paths);
    cache.delete(key);
    cache.set(key, { at: Date.now(), result });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return result;
  };

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      void computeLocalLinks(bufferLineNumber, term, resolveCached)
        .then((links) => callback(links.length ? links : undefined))
        .catch(() => callback(undefined));
    },
  };
  term.registerLinkProvider(provider);
}

/** Build and verify local-path links for the physical row xterm is querying. */
export async function computeLocalLinks(
  bufferLineNumber: number,
  terminal: Terminal,
  resolvePaths: ResolvePaths
): Promise<ILink[]> {
  const requestedY = bufferLineNumber - 1;
  const cell = terminal.buffer.active.getNullCell();
  const cache = new Map<number, MappedLine>();
  const mapped = (y: number) => {
    if (!cache.has(y)) {
      const line = mapLine(terminal, y, cell);
      if (line) cache.set(y, line);
    }
    return cache.get(y);
  };

  if (!mapped(requestedY)) return [];

  let top = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES && top > 0; i++) {
    const previous = mapped(top - 1);
    const current = mapped(top);
    if (!previous || !current || !continues(previous, current)) break;
    top--;
  }

  let bottom = requestedY;
  for (let i = 0; i < MAX_WINDOW_LINES; i++) {
    const current = mapped(bottom);
    const next = mapped(bottom + 1);
    if (!current || !next || !continues(current, next)) break;
    bottom++;
  }

  let virtualText = "";
  const positions: CellPosition[] = [];
  for (let y = top; y <= bottom; y++) {
    const line = mapped(y)!;
    virtualText += line.text;
    positions.push(...line.positions);
  }

  const candidates = findCandidates(virtualText);
  if (!candidates.length) return [];
  const resolved = await resolvePaths(candidates.map((candidate) => pathFromLinkText(candidate.text)));
  const links: ILink[] = [];

  candidates.forEach((candidate, i) => {
    const target = resolved[i];
    if (!target) return;
    const start = positions[candidate.index];
    const end = positions[candidate.index + candidate.text.length - 1];
    if (!start || !end || requestedY < start.y || requestedY > end.y) return;
    links.push({
      range: {
        start: { x: start.x + 1, y: start.y + 1 },
        end: { x: end.x + end.width, y: end.y + 1 },
      },
      text: candidate.text,
      activate: async (event) => {
        if (!event.metaKey) return;
        event.preventDefault();
        const error = await revealPath(target);
        if (error) console.warn("[termany] failed to reveal path:", error);
      },
    });
  });
  return links;
}
