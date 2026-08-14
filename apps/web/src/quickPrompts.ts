import { useEffect, useState } from "react";

const STORAGE_KEY = "termany.quick-prompts";
const PROMPTS_CHANGED_EVENT = "termany:quick-prompts-changed";

export type QuickPrompt = {
  id: string;
  name: string;
  /** The text pasted into the focused terminal, followed by Enter. */
  text: string;
  enabled: boolean;
};

/** First-run seeds. Once the user saves anything, their list is authoritative
 *  — these never come back on their own. */
export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { id: "continue", name: "Continue", text: "Continue", enabled: true },
  {
    id: "review-changes",
    name: "Review changes",
    text: "Review my current uncommitted changes: find bugs and edge cases, then suggest concrete fixes.",
    enabled: true,
  },
  {
    id: "fix-tests",
    name: "Fix failing tests",
    text: "Run the test suite, find any failures, and fix them.",
    enabled: true,
  },
];

function normalize(saved: unknown): QuickPrompt[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((item): item is Partial<QuickPrompt> & { id: string } => Boolean(item?.id))
    .map((item) => ({
      id: item.id,
      name: typeof item.name === "string" && item.name.trim() ? item.name : item.id,
      text: typeof item.text === "string" ? item.text : "",
      enabled: item.enabled ?? true,
    }));
}

export function loadQuickPrompts(): QuickPrompt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_PROMPTS.map((prompt) => ({ ...prompt }));
    return normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_QUICK_PROMPTS.map((prompt) => ({ ...prompt }));
  }
}

export function saveQuickPrompts(prompts: QuickPrompt[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  } catch {
    /* localStorage may be blocked; the in-memory edit still applies. */
  }
  window.dispatchEvent(new Event(PROMPTS_CHANGED_EVENT));
}

export function createQuickPrompt(): QuickPrompt {
  return { id: crypto.randomUUID(), name: "New prompt", text: "", enabled: true };
}

export function useQuickPrompts() {
  const [prompts, setPrompts] = useState(loadQuickPrompts);

  useEffect(() => {
    const onChange = () => setPrompts(loadQuickPrompts());
    window.addEventListener(PROMPTS_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(PROMPTS_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return prompts;
}
