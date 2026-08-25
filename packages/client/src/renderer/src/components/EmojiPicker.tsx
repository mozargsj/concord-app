import { useRef, useState } from 'react';
import '../styles/EmojiPicker.css';

// No emoji-picker dependency added for this — a curated quick-pick grid covers the common case,
// and the text field falls back to whatever the OS's own emoji picker types in (Win+. on
// Windows), so any emoji is still reachable without pulling in a library just for this.
const QUICK_EMOJI = [
  '😂', '😅', '😭', '😱', '🔥', '💀', '🐒', '🐸', '🎉', '👀',
  '😈', '🤡', '💩', '🎵', '📢', '❤️', '😡', '🤣', '👍', '🙏'
];

const GRID_WIDTH = 200;
const GRID_HEIGHT_ESTIMATE = 140;

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
}

export default function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [gridPosition, setGridPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function openGrid() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Fixed positioning (viewport-relative), computed here instead of via CSS top/left off the
    // trigger — the modal this lives in scrolls (overflow-y: auto), which would otherwise clip
    // an absolutely-positioned dropdown the moment it extends past the modal's own box.
    const left = Math.min(rect.left, window.innerWidth - GRID_WIDTH - 8);
    const top = Math.min(rect.bottom + 6, window.innerHeight - GRID_HEIGHT_ESTIMATE - 8);
    setGridPosition({ left, top });
  }

  return (
    <div className="emoji-picker">
      <button
        ref={triggerRef}
        type="button"
        className="emoji-picker__trigger"
        onClick={() => (gridPosition ? setGridPosition(null) : openGrid())}
        title="Escolher emoji"
      >
        {value || '🙂'}
      </button>
      <input
        className="emoji-picker__input"
        value={value}
        maxLength={4}
        placeholder="Emoji"
        onChange={(event) => onChange(event.target.value)}
      />
      {gridPosition && (
        <>
          <div className="emoji-picker__backdrop" onClick={() => setGridPosition(null)} />
          <div className="emoji-picker__grid" style={{ left: gridPosition.left, top: gridPosition.top }}>
            {QUICK_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-picker__option"
                onClick={() => {
                  onChange(emoji);
                  setGridPosition(null);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
