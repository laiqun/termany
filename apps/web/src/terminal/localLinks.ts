import type { IBufferCell, IBufferLine, ILink, Terminal } from "@xterm/xterm";
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
  /** 0-based buffer column of each string index. */
  cols: number[];
  /** cell width (1 or 2) of the char at each string index. */
  widths: number[];
}

/**
 * Flatten a buffer line to a string while remembering which COLUMN each string
 * character sits in. `translateToString()` alone won't do: wide chars (CJK)
 * occupy two cells but one string char, so string index ≠ column and every
 * link range after a Chinese character would be shifted left.
 */
function mapBufferLine(line: IBufferLine, cell: IBufferCell): MappedLine {
  let text = "";
  const cols: number[] = [];
  const widths: number[] = [];
  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell)) break;
    const width = cell.getWidth();
    if (width === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || " "; // empty cell renders as a space
    for (let i = 0; i < chars.length; i++) {
      cols.push(x);
      widths.push(width);
    }
    text += chars;
  }
  return { text, cols, widths };
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

  let workCell: IBufferCell | undefined;

  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const bufLine = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!bufLine) {
        callback(undefined);
        return;
      }
      workCell ??= term.buffer.active.getNullCell();
      const mapped = mapBufferLine(bufLine, workCell);
      const candidates = findCandidates(mapped.text);
      if (!candidates.length) {
        callback(undefined);
        return;
      }

      void resolveCached(candidates.map((c) => pathFromLinkText(c.text)))
        .then((resolved) => {
          const links: ILink[] = [];
          candidates.forEach((candidate, i) => {
            const target = resolved[i];
            if (!target) return;
            const last = candidate.index + candidate.text.length - 1;
            links.push({
              range: {
                // 1-based, end-inclusive buffer coordinates.
                start: { x: mapped.cols[candidate.index] + 1, y: bufferLineNumber },
                end: { x: mapped.cols[last] + mapped.widths[last], y: bufferLineNumber },
              },
              text: candidate.text,
              activate: async (event) => {
                if (!event.metaKey) return;
                const error = await revealPath(target);
                if (error) console.warn("[termany] failed to reveal path:", error);
              },
            });
          });
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  });
}
