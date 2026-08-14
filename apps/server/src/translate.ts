/**
 * Selection translation for the terminal's Alt+drag lookup bubble.
 *
 * Pluggable engines, all free-tier, queried in parallel and returned as
 * separate result blocks (the bubble renders one section per engine):
 *
 * - youdao: dict.youdao.com page scrape — word senses + phonetics + machine
 *   translation of English phrases. Reachable everywhere; the fallback source.
 * - baidu: fanyi.baidu.com/sug — the search-box suggestion API, no key or
 *   signing needed. Words and short phrases only; sentences come back empty.
 * - caiyun: official api.interpreter.caiyunai.com v2 API. Free but requires a
 *   token the user registers at fanyi.caiyunapp.com — skipped when unset.
 * - google: translate.googleapis.com `client=gtx` endpoint. Unreachable from
 *   some networks (e.g. mainland China without a proxy), so it is disabled by
 *   default and remembers failures briefly to stay snappy.
 *
 * Pronunciation is engine-independent: youdao dictvoice mp3s for single words
 * (EN UK/US, zh pinyin voice), Google TTS (tw-ob, no tk token) for phrases —
 * only when the google engine succeeded anyway.
 */

export type EngineId = "youdao" | "baidu" | "caiyun" | "google";

export interface EngineTranslation {
  id: EngineId;
  name: string;
  translation?: string;
  /** e.g. "英 [həˈləʊ] 美 [həˈloʊ]" — youdao only. */
  phonetic?: string;
  /** Dictionary senses, e.g. "n. 世界；领域". */
  definitions?: string[];
  /** Set when this engine has nothing usable for the input. */
  error?: string;
}

export interface TranslateResponse {
  text: string;
  detectedLang: string;
  /** US/UK mp3 for English words (youdao dictvoice). */
  audioUs?: string;
  audioUk?: string;
  /** Single mp3: Google TTS for phrases, dictvoice for Chinese words. */
  audio?: string;
  engines: EngineTranslation[];
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const ENGLISH_WORD = /^[A-Za-z][A-Za-z'-]{0,39}$/;
const CJK_WORD = /^[一-鿿]{1,4}$/;

const GOOGLE_TIMEOUT_MS = 5000;
const ENGINE_TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 2000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // Dictionary sites serve minimal or blocked markup to a bare node fetch.
    headers: { "User-Agent": BROWSER_UA },
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.text();
}

const stripTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// youdao
// ---------------------------------------------------------------------------

interface YoudaoResult {
  phonetic?: string;
  definitions?: string[];
  /** Machine translation of an English phrase (#fanyiToggle). */
  fanyi?: string;
}

async function youdaoLookup(text: string): Promise<YoudaoResult> {
  const html = await fetchText(
    `https://dict.youdao.com/w/${encodeURIComponent(text)}`,
    ENGINE_TIMEOUT_MS
  );
  // Two <span class="phonetic"> blocks on English pages: UK then US.
  const phonetic = [...html.matchAll(/class="phonetic">([^<]+)</g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join(" ");

  // English words: senses as <li> inside #phrsListTab's trans-container.
  const enSenses = html.match(/class="trans-container"[^>]*>\s*<ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const definitions = [...enSenses.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean)
    .slice(0, 6);

  // Chinese words: translations are the anchors in <span class="contentTitle">.
  if (!definitions.length) {
    definitions.push(
      ...[...html.matchAll(/class="contentTitle"><a[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => stripTags(m[1]))
        .filter(Boolean)
        .slice(0, 6)
    );
  }

  // English phrases/sentences: #fanyiToggle holds [source, translation] <p>s.
  const fanyiBlock = html.match(/id="fanyiToggle"[\s\S]*?trans-container[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const paragraphs = [...fanyiBlock.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  const fanyi = paragraphs[1] && !paragraphs[1].startsWith("以上为") ? paragraphs[1] : undefined;

  return {
    phonetic: phonetic || undefined,
    definitions: definitions.length ? definitions : undefined,
    fanyi,
  };
}

async function youdaoEngine(text: string): Promise<EngineTranslation> {
  const result: EngineTranslation = { id: "youdao", name: "有道词典" };
  try {
    const { phonetic, definitions, fanyi } = await youdaoLookup(text);
    result.translation = fanyi ?? definitions?.[0];
    if (ENGLISH_WORD.test(text) || CJK_WORD.test(text)) {
      result.phonetic = phonetic;
      result.definitions = definitions;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  if (!result.translation && !result.error) result.error = "no result";
  return result;
}

// ---------------------------------------------------------------------------
// baidu — fanyi.baidu.com/sug suggestion API, no signing needed
// ---------------------------------------------------------------------------

async function baiduEngine(text: string): Promise<EngineTranslation> {
  const result: EngineTranslation = { id: "baidu", name: "百度翻译" };
  try {
    const response = await fetch("https://fanyi.baidu.com/sug", {
      method: "POST",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: `kw=${encodeURIComponent(text)}`,
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const data = await response.json();
    if (data?.errno !== 0) throw new Error(`upstream errno ${data?.errno}`);
    const entries: { k?: string; v?: string }[] = Array.isArray(data?.data) ? data.data : [];
    // The first entry whose key echoes the query is the direct translation.
    const lower = text.toLowerCase();
    const match = entries.find((e) => e.k?.toLowerCase() === lower) ?? entries[0];
    if (match?.v) {
      result.translation = match.v;
    } else {
      // /sug is a word/phrase dictionary — sentences come back with no data.
      result.error = "only words and short phrases";
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ---------------------------------------------------------------------------
// caiyun — official v2 API, free token registered at fanyi.caiyunapp.com
// ---------------------------------------------------------------------------

async function caiyunEngine(text: string, token: string): Promise<EngineTranslation> {
  const result: EngineTranslation = { id: "caiyun", name: "彩云小译" };
  if (!token) {
    result.error = "token not set";
    return result;
  }
  try {
    const response = await fetch("https://api.interpreter.caiyunai.com/v2/translator", {
      method: "POST",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        "X-Authorization": token,
      },
      body: JSON.stringify({
        source: [text],
        trans_type: CJK.test(text) ? "auto2en" : "auto2zh",
        request_id: "termany",
        detect: true,
      }),
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const data = await response.json();
    const target: unknown[] = Array.isArray(data?.target) ? data.target : [];
    result.translation = target.map(String).join("\n") || undefined;
    if (!result.translation) throw new Error("upstream returned no text");
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ---------------------------------------------------------------------------
// google — client=gtx, unreachable from some networks; failure is remembered
// briefly so every lookup doesn't pay the 5s timeout first.
// ---------------------------------------------------------------------------

const GOOGLE_DOWN_TTL_MS = 5 * 60 * 1000;
let googleDownUntil = 0;

async function googleEngine(text: string, target: string): Promise<EngineTranslation> {
  const result: EngineTranslation = { id: "google", name: "Google 翻译" };
  if (Date.now() < googleDownUntil) {
    result.error = "unreachable (cached)";
    return result;
  }
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(
      target
    )}&q=${encodeURIComponent(text)}`;
    const data = JSON.parse(await fetchText(url, GOOGLE_TIMEOUT_MS));
    // gtx nests as [[ [translated, source, ...], ... ], null, detectedLang, ...]
    const segments: unknown[] = Array.isArray(data?.[0]) ? data[0] : [];
    result.translation = segments
      .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? "") : ""))
      .join("");
    if (!result.translation) throw new Error("upstream returned no text");
    googleDownUntil = 0;
  } catch (err) {
    googleDownUntil = Date.now() + GOOGLE_DOWN_TTL_MS;
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ---------------------------------------------------------------------------

function googleTtsUrl(text: string, lang: string): string {
  // The tw-ob client needs no tk token, unlike the webapp client.
  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${encodeURIComponent(
    text
  )}&tl=${encodeURIComponent(lang)}`;
}

function dictvoiceUrl(text: string, extra: string): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}${extra}`;
}

export async function translateText(
  raw: unknown,
  options: { enabled: EngineId[]; caiyunToken: string }
): Promise<TranslateResponse> {
  const text = String(raw ?? "").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) throw new Error("text is required");

  // Selected CJK text translates to English, everything else to Chinese.
  const target = CJK.test(text) ? "en" : "zh-CN";
  const enabled = new Set(options.enabled);

  const engines = await Promise.all([
    enabled.has("youdao") ? youdaoEngine(text) : null,
    enabled.has("baidu") ? baiduEngine(text) : null,
    enabled.has("caiyun") && options.caiyunToken ? caiyunEngine(text, options.caiyunToken) : null,
    enabled.has("google") ? googleEngine(text, target) : null,
  ]);
  const present = engines.filter((e): e is EngineTranslation => e !== null);
  if (!present.length) throw new Error("No dictionary engine is enabled");
  if (!present.some((e) => e.translation)) throw new Error("Translation unavailable — all engines failed");

  const google = present.find((e) => e.id === "google");
  const response: TranslateResponse = {
    text,
    detectedLang: "auto",
    engines: present,
  };

  if (ENGLISH_WORD.test(text)) {
    const word = text.toLowerCase();
    response.audioUk = dictvoiceUrl(word, "&type=1");
    response.audioUs = dictvoiceUrl(word, "&type=2");
  } else if (CJK_WORD.test(text)) {
    response.audio = dictvoiceUrl(text, "&le=zh");
  } else if (google?.translation) {
    response.audio = googleTtsUrl(text, "en");
  }
  return response;
}
