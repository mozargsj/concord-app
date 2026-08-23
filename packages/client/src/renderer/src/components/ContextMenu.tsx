import '../styles/ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const ESTIMATED_WIDTH = 200;
const ESTIMATED_ITEM_HEIGHT = 34;

/** Generic right-click menu, positioned at the cursor — clamped so it never renders past the
 * window edge regardless of where on screen the click happened. */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const left = Math.min(x, window.innerWidth - ESTIMATED_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - items.length * ESTIMATED_ITEM_HEIGHT - 8);

  return (
    <>
      <div
        className="context-menu__backdrop"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div className="context-menu" style={{ left, top }}>
        {items.map((item) => (
          <button
            key={item.label}
            className={'context-menu__item' + (item.danger ? ' context-menu__item--danger' : '')}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
