/** A small curated emoji grid for picking a workspace icon. */
const EMOJIS = [
  "💻", "🚀", "🔥", "⭐️", "📦", "🐳", "🛠️", "⚙️",
  "🧪", "🌱", "🎯", "📁", "🐍", "🦀", "☁️", "🔧",
  "💡", "🧠", "📊", "🌍", "🎨", "🔒", "⚡️", "🍀",
  "🦄", "🐙", "🎸", "🍕", "🌙", "🪐", "🤖", "📝",
];

export function EmojiPicker({
  onPick,
  onClose,
}: {
  /** Receives the chosen emoji, or null to clear back to the letter avatar. */
  onPick: (emoji: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="ws-backdrop" onClick={onClose} />
      <div className="emoji-pop">
        <div className="emoji-grid">
          {EMOJIS.map((e) => (
            <button key={e} className="emoji-cell" onClick={() => onPick(e)}>
              {e}
            </button>
          ))}
        </div>
        <button className="emoji-clear" onClick={() => onPick(null)}>
          Use letter
        </button>
      </div>
    </>
  );
}
