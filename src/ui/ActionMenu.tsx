/**
 * The action bar's menu: a flat list of buttons where any entry can instead be
 * a *submenu* that expands in place.
 *
 * The bar used to grow one button per choice, which is fine for "Draw" and
 * "End turn" and miserable for anything with a per-variant list (planting once
 * spanned five buttons, and rituals / abilities / upgrades are the same shape).
 * So nesting lives here once, generically: an item is either a leaf that acts,
 * or a submenu that holds leaves. Opening one replaces the list with a back
 * button, a heading and the children — same bar, same row, no navigation.
 *
 * The component owns no game knowledge and no state: `openKey` is the caller's,
 * so a submenu can be force-closed the moment its items stop being legal. What
 * it does own is the keyboard contract — opening focuses the first enabled
 * child, Escape (or Back) closes and returns focus to the trigger — because
 * that is exactly the part every future submenu would otherwise re-invent.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** A button that does something. */
export interface ActionMenuLeaf {
  key: string;
  label: ReactNode;
  /** Right-aligned annotation (e.g. a remaining-supply count). */
  badge?: ReactNode;
  testId?: string;
  title?: string;
  disabled?: boolean;
  /** Extra classes on the button, appended to `btn`. */
  className?: string;
  onSelect: () => void;
}

/** A button that opens a nested list instead of acting. */
export interface ActionMenuSubmenu extends Omit<ActionMenuLeaf, 'onSelect'> {
  /** Heading shown above the children while open. */
  heading: string;
  items: ActionMenuLeaf[];
}

export type ActionMenuItem = ActionMenuLeaf | ActionMenuSubmenu;

function isSubmenu(item: ActionMenuItem): item is ActionMenuSubmenu {
  return 'items' in item;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Key of the open submenu, or null for the top-level list. */
  openKey: string | null;
  onOpenKeyChange: (key: string | null) => void;
}

export function ActionMenu({ items, openKey, onOpenKeyChange }: ActionMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const prevOpen = useRef<string | null>(null);

  // Keyboard continuity: focus moves INTO a submenu when it opens and back to
  // the trigger when it closes, so tabbing never lands somewhere unrelated.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (openKey) {
      root.querySelector<HTMLButtonElement>('[data-menu-item]:not([disabled])')?.focus();
    } else if (prevOpen.current) {
      root.querySelector<HTMLButtonElement>(`[data-menu-key="${prevOpen.current}"]`)?.focus();
    }
    prevOpen.current = openKey;
  }, [openKey]);

  const open = items.find((i): i is ActionMenuSubmenu => isSubmenu(i) && i.key === openKey) ?? null;

  return (
    <div
      className="action-menu"
      ref={rootRef}
      data-open-submenu={open?.key ?? ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          onOpenKeyChange(null);
        }
      }}
    >
      {open ? (
        <>
          <button
            type="button"
            className="btn small"
            data-testid="submenu-back"
            onClick={() => onOpenKeyChange(null)}
          >
            ← Back
          </button>
          <span className="submenu-heading">{open.heading}</span>
          {open.items.map((item) => (
            <MenuButton key={item.key} item={item} onClick={item.onSelect} />
          ))}
        </>
      ) : (
        items.map((item) =>
          isSubmenu(item) ? (
            <MenuButton
              key={item.key}
              item={item}
              submenu
              onClick={() => onOpenKeyChange(item.key)}
            />
          ) : (
            <MenuButton key={item.key} item={item} onClick={item.onSelect} />
          ),
        )
      )}
    </div>
  );
}

function MenuButton({
  item,
  submenu,
  onClick,
}: {
  item: ActionMenuLeaf | ActionMenuSubmenu;
  submenu?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn${item.className ? ` ${item.className}` : ''}`}
      data-menu-item=""
      data-menu-key={item.key}
      data-testid={item.testId}
      title={item.title}
      disabled={item.disabled}
      aria-haspopup={submenu ? 'true' : undefined}
      onClick={onClick}
    >
      {item.label}
      {item.badge !== undefined && <span className="menu-badge">{item.badge}</span>}
      {submenu && <span className="submenu-caret" aria-hidden="true">▸</span>}
    </button>
  );
}
