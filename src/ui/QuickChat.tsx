/**
 * Quick chat UI: a phrase menu and the bubbles it produces over the board.
 *
 * There is no text input anywhere in here by design — the engine only accepts
 * phrase ids from its catalogue, so the UI's whole job is picking one. Every
 * phrase the local seat can send comes from `QUICK_CHAT_GROUPS`; the remaining
 * allowance comes from the engine too, so the button disables for exactly the
 * same reason a dispatch would be rejected.
 */

import { useEffect, useRef, useState } from 'react';
import type { GameState, PlayerId, QuickChatId } from '../engine';
import { QUICK_CHAT_GROUPS, QUICK_CHAT_PER_TURN, quickChatsLeft } from '../engine';
import type { ChatBubble } from './useGame';
import { playerColor, pname, quickChatText } from './meta';

// ---------------------------------------------------------------------------
// The phrase menu
// ---------------------------------------------------------------------------

export interface QuickChatBarProps {
  state: GameState;
  /** The seat this device speaks for (the revealed human), or null to hide. */
  seat: PlayerId | null;
  disabled: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onSay: (player: PlayerId, phraseId: QuickChatId) => void;
}

export function QuickChatBar({ state, seat, disabled, muted, onToggleMute, onSay }: QuickChatBarProps) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape or a click outside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (seat === null) return null;

  const left = quickChatsLeft(state, seat);
  const canSay = !disabled && left > 0;
  const current = QUICK_CHAT_GROUPS[Math.min(group, QUICK_CHAT_GROUPS.length - 1)];

  return (
    <div className="quickchat-panel" ref={ref} data-testid="quickchat">
      <div className="panel-title log-title">
        <span>💬 Quick chat</span>
        <span className="qc-controls">
          <span
            className="small muted"
            data-testid="quickchat-left"
            title={`${QUICK_CHAT_PER_TURN} quickchats per player per turn`}
          >
            {left}/{QUICK_CHAT_PER_TURN}
          </span>
          <button
            type="button"
            className={`btn small${muted ? ' on' : ''}`}
            aria-pressed={muted}
            data-testid="quickchat-mute"
            title={muted ? 'Chat bubbles hidden — the log still records them' : 'Hide chat bubbles'}
            onClick={onToggleMute}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </span>
      </div>

      <button
        type="button"
        className="btn qc-open"
        disabled={!canSay}
        aria-expanded={open}
        data-testid="quickchat-open"
        title={
          left === 0
            ? 'No quickchats left this turn'
            : `Say something as ${pname(state, seat)} (fixed phrases only)`
        }
        onClick={() => setOpen((o) => !o)}
      >
        💬 Say something…
      </button>

      {open && canSay && (
        <div className="qc-menu" role="menu" data-testid="quickchat-menu">
          <div className="qc-groups">
            {QUICK_CHAT_GROUPS.map((g, i) => (
              <button
                key={g.id}
                type="button"
                className={`btn small chip${g.id === current.id ? ' on' : ''}`}
                aria-pressed={g.id === current.id}
                data-testid={`quickchat-group-${g.id}`}
                onClick={() => setGroup(i)}
              >
                {g.emoji} {g.label}
              </button>
            ))}
          </div>
          <div className="qc-phrases">
            {current.phrases.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn qc-phrase"
                role="menuitem"
                data-testid={`quickchat-say-${p.id}`}
                onClick={() => {
                  onSay(seat, p.id);
                  setOpen(false);
                }}
              >
                {p.emoji} {p.text}
              </button>
            ))}
          </div>
          <div className="small muted qc-note">Fixed phrases only — no typing, no surprises.</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bubbles over the board
// ---------------------------------------------------------------------------

/** Recent quickchats, newest last. Rendered over the board and auto-expiring. */
export function QuickChatFeed({ state, bubbles }: { state: GameState; bubbles: readonly ChatBubble[] }) {
  if (bubbles.length === 0) return null;
  return (
    <div className="qc-feed" aria-live="polite" data-testid="quickchat-feed">
      {bubbles.map((b) => (
        <div
          key={b.id}
          className="qc-bubble"
          style={{ borderColor: playerColor(b.player) }}
          data-testid={`quickchat-bubble-${b.phraseId}`}
        >
          <b style={{ color: playerColor(b.player) }}>{pname(state, b.player)}</b>{' '}
          {quickChatText(b.phraseId)}
        </div>
      ))}
    </div>
  );
}
