/**
 * Build the environment inherited by an interactive PTY.
 *
 * Packaged macOS apps launched from Finder commonly have no LANG/LC_CTYPE.
 * zsh then falls back to a single-byte locale and renders UTF-8 input from an
 * IME as replacement/control characters (for example `�<0086>`) even though
 * the browser-side composition itself completed correctly.
 *
 * Only the character classification locale is repaired. Other locale
 * categories keep the user's values, and an existing UTF-8 locale is left
 * untouched.
 */
export function ptyEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, TERM: "xterm-256color" };
  if (platform === "win32") return env;

  const effectiveCharacterLocale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (/utf-?8/i.test(effectiveCharacterLocale)) return env;

  // LC_ALL overrides LC_CTYPE. Remove it only when it would force a
  // non-Unicode character set, then repair LC_CTYPE without changing the
  // user's language or the other locale categories.
  delete env.LC_ALL;
  env.LC_CTYPE = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) env.LANG = env.LC_CTYPE;
  return env;
}
