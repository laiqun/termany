const AGENT_INPUT_PROMPT_RE = /^[›>](?:\s|$)/;
const BOX_CHROME_RE = /^[\s│┃┆┊╎╏|]+|[\s│┃┆┊╎╏|]+$/g;
const AGENT_PROMPT_SCAN_ROWS = 6;
const CONFIRMATION_PROMPT_SCAN_ROWS = 14;
const INLINE_CONFIRMATION_RE =
  /(?:\[|\()\s*(?:y(?:es)?)\s*\/\s*(?:n(?:o)?)\s*(?:\]|\))|\byes\s*\/\s*no\b/i;
const CONFIRMATION_QUESTION_RE =
  /[?？]\s*$|\b(?:do you want|would you like|are you sure|allow|approve|permission|confirm|continue|proceed|choose|select|pick|which)\b|(?:是否|请选择|选择一个|需要你|允许|授权|批准|确认|同意|继续)/i;
const POSITIVE_CHOICE_RE =
  /^(?:[›❯>]\s*)?(?:\d+[.)]\s*)?(?:yes\b|allow\b|approve\b|continue\b|proceed\b|always allow\b|是(?:\s|$)|允许|授权|批准|同意|继续)/i;
const NEGATIVE_CHOICE_RE =
  /^(?:[›❯>]\s*)?(?:\d+[.)]\s*)?(?:no\b|deny\b|reject\b|cancel\b|否(?:\s|$)|不允许|拒绝|取消)/i;
const SELECTED_CHOICE_RE = /^[›❯>]\s*(?:\d+[.)]\s*)?/;
const NUMBERED_SELECTED_CHOICE_RE = /^[›❯>]\s*\d+[.)]\s*/;
const CHOICE_INSTRUCTION_RE =
  /\b(?:enter|return)\s+to\s+(?:select|confirm|continue)\b|\b(?:arrow keys?|up\s*\/\s*down|tab)\s+to\s+(?:navigate|select)\b|(?:按|使用).{0,12}(?:选择|确认|导航)/i;

function cleanRow(line: string): string {
  return line.replace(BOX_CHROME_RE, "").trim();
}

/** Find the live input row inside the bottom of a boxed agent TUI. */
export function agentInputPromptVisible(visible: string): boolean {
  const rows = visible.split("\n").map(cleanRow).filter(Boolean);
  return rows
    .slice(-AGENT_PROMPT_SCAN_ROWS)
    .some((row) => AGENT_INPUT_PROMPT_RE.test(row));
}

/**
 * Recognize a real interactive confirmation menu, not prose that happens to
 * say "yes or no". Plain shell [y/N] prompts count only on the cursor row.
 */
export function agentConfirmationPromptVisible(
  visible: string,
  cursorLine = "",
): boolean {
  const liveRow = cleanRow(cursorLine);
  if (liveRow && INLINE_CONFIRMATION_RE.test(liveRow)) return true;

  const rows = visible
    .split("\n")
    .map(cleanRow)
    .filter(Boolean)
    .slice(-CONFIRMATION_PROMPT_SCAN_ROWS);
  const hasQuestion = rows.some((row) => CONFIRMATION_QUESTION_RE.test(row));
  const hasPositive = rows.some((row) => POSITIVE_CHOICE_RE.test(row));
  const hasNegative = rows.some((row) => NEGATIVE_CHOICE_RE.test(row));
  const hasSelectedChoice = rows.some((row) => SELECTED_CHOICE_RE.test(row));
  const hasSelectedConfirmationChoice = rows.some(
    (row) =>
      SELECTED_CHOICE_RE.test(row) &&
      (POSITIVE_CHOICE_RE.test(row) || NEGATIVE_CHOICE_RE.test(row)),
  );
  const hasSelectionInstructions = rows.some((row) =>
    CHOICE_INSTRUCTION_RE.test(row),
  );
  const hasNumberedSelection = rows.some((row) =>
    NUMBERED_SELECTED_CHOICE_RE.test(row),
  );
  return (
    hasQuestion &&
    ((hasPositive && hasNegative && hasSelectedConfirmationChoice) ||
      (hasSelectedChoice &&
        (hasSelectionInstructions || hasNumberedSelection)))
  );
}
