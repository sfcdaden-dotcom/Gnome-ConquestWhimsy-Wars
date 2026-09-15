/**
 * The chat window: one collapsible panel with two tabs (Chat / Game log), and
 * a radial phrase picker at its foot.
 *
 * There is no text input anywhere in here by design — the engine only accepts
 * phrase ids from its catalogue, so the UI's whole job is picking one. The
 * picker is two-step: a wheel of categories, then a plain list of that
 * category's phrases (a list, not a second ring, because the lines are
 * sentences — "Where'd all my friends go?" does not fit in a 60px petal). The
 * remaining allowance comes from the engine too, so the button disables for
 * exactly the same reason a dispatch would be rejected.
 *
 * Two phrases name something — a rival, or a square — and take a third step: a
 * list of who or what. A LIST, not a click on the board, and that is the
 * load-bearing choice: quick chat is sendable at any moment, including out of
 * turn and while somebody else's decision is open, so a picker that captured
 * board clicks would be fighting the game for them at exactly the times chat is
 * most likely to be used.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameState, PlayerId, QuickChatId, QuickChatPhrase, QuickChatTarget } from '../engine';
import { QUICK_CHAT_GROUPS, QUICK_CHAT_PER_TURN, quickChatsLeft } from '../engine';
import type { ChatBubble } from './useGame';
import { GameLogView } from './panels';
import { GARDEN_META, playerColor, pname, posStr, quickChatText } from './meta';

// ---------------------------------------------------------------------------
// The chat window
// ---------------------------------------------------------------------------

export interface ChatPanelProps {
  state: GameState;
  /** The seat this device speaks for (the revealed human), or null: read-only. */
  seat: PlayerId | null;
  disabled: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onSay: (player: PlayerId, phraseId: QuickChatId, target?: QuickChatTarget) => void;
}

type Tab = 'chat' | 'log';

export function ChatPanel({ state, seat, disabled, muted, onToggleMute, onSay }: ChatPanelProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [collapsed, setCollapsed] = useState(false);
  const [seen, setSeen] = useState(0);

  const lines = useMemo(
    () =>
      state.events.flatMap((e, i) =>
        e.type === 'quickChatSaid'
          ? [{ key: i, player: e.player, phraseId: e.phraseId, target: e.target }]
          : [],
      ),
    [state.events],
  );

  // Reading the chat clears its unread badge; the log tab lets it build up.
  const showingChat = tab === 'chat' && !collapsed;
  useEffect(() => {
    if (showingChat) setSeen(lines.length);
  }, [showingChat, lines.length]);
  const unread = Math.max(0, lines.length - seen);

  return (
    <div className={`chat-panel${collapsed ? ' collapsed' : ''}`} data-testid="chat-panel" data-tab={tab}>
      <div className="panel-title chat-head">
        <span className="chat-tabs" role="tablist" aria-label="Chat and game log">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={`btn small chip${tab === 'chat' ? ' on' : ''}`}
            data-testid="chat-tab-chat"
            onClick={() => {
              setTab('chat');
              setCollapsed(false);
            }}
          >
            💬 Chat
            {unread > 0 && tab !== 'chat' && (
              <span className="chat-unread" data-testid="chat-unread">
                {unread}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'log'}
            className={`btn small chip${tab === 'log' ? ' on' : ''}`}
            data-testid="chat-tab-log"
            onClick={() => {
              setTab('log');
              setCollapsed(false);
            }}
          >
            📜 Game log
          </button>
        </span>
        <span className="chat-head-right">
          <button
            type="button"
            className={`btn small${muted ? ' on' : ''}`}
            aria-pressed={muted}
            data-testid="quickchat-mute"
            title={muted ? 'Chat bubbles hidden — the transcript still records them' : 'Hide chat bubbles'}
            onClick={onToggleMute}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            type="button"
            className="btn small"
            aria-expanded={!collapsed}
            data-testid="chat-collapse"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? 'Show ▸' : 'Hide ▾'}
          </button>
        </span>
      </div>

      {!collapsed &&
        (tab === 'chat' ? <ChatTranscript state={state} lines={lines} /> : <GameLogView state={state} />)}

      {/* The composer sits at the foot of the window on both tabs, so you can
          say something while reading the log. */}
      <QuickChatComposer state={state} seat={seat} disabled={disabled} onSay={onSay} />
    </div>
  );
}

function ChatTranscript({
  state,
  lines,
}: {
  state: GameState;
  lines: ReadonlyArray<{ key: number; player: PlayerId; phraseId: QuickChatId; target?: QuickChatTarget }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="chat-transcript" ref={ref} aria-label="Chat" data-testid="chat-transcript">
      {lines.map((l) => (
        <div key={l.key} className="chat-line">
          <b style={{ color: playerColor(l.player) }}>{pname(state, l.player)}</b>{' '}
          {quickChatText(l.phraseId, l.target)}
        </div>
      ))}
      {lines.length === 0 && <div className="chat-line muted">Nobody has said a word yet.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The picker: a wheel of categories, then that category's phrases
// ---------------------------------------------------------------------------

/** Wheel geometry (px). The column is 280–360 wide, so the ring must fit 260. */
const WHEEL_SIZE = 240;
const WHEEL_RADIUS = 88;

function QuickChatComposer({
  state,
  seat,
  disabled,
  onSay,
}: {
  state: GameState;
  seat: PlayerId | null;
  disabled: boolean;
  onSay: (player: PlayerId, phraseId: QuickChatId, target?: QuickChatTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  /** A chosen phrase still waiting for the thing it names. */
  const [pending, setPending] = useState<QuickChatPhrase | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setGroupId(null);
    setPending(null);
  };

  // Escape steps back one level (phrases → wheel → closed); an outside click
  // closes outright.
  //
  // Capture phase, and the event stops here: the game screen also backs out on
  // Escape (targeting, then a selection), and an open picker is the innermost
  // thing on screen, so it gets the key and nothing behind it does.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pending !== null) setPending(null);
      else if (groupId !== null) setGroupId(null);
      else close();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, groupId, pending]);

  if (seat === null) return null;

  const left = quickChatsLeft(state, seat);
  const canSay = !disabled && left > 0;
  const group = groupId === null ? null : (QUICK_CHAT_GROUPS.find((g) => g.id === groupId) ?? null);

  return (
    <div className="chat-composer" ref={ref}>
      <button
        type="button"
        className="btn qc-open"
        disabled={!canSay}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="quickchat-open"
        title={
          left === 0
            ? 'No quickchats left this turn'
            : `Say something as ${pname(state, seat)} (fixed phrases only)`
        }
        onClick={() => (open ? close() : setOpen(true))}
      >
        Say something…
        <span className="qc-left" data-testid="quickchat-left" title={`${QUICK_CHAT_PER_TURN} per player per turn`}>
          {left}/{QUICK_CHAT_PER_TURN}
        </span>
      </button>

      {open && canSay && pending === null && group === null && (
        <div className="qc-wheel" role="menu" aria-label="Quick chat categories" data-testid="quickchat-menu">
          <div
            className="qc-ring"
            style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}
          >
            {QUICK_CHAT_GROUPS.map((g, i) => {
              // Start at the top and go clockwise, so the first category is
              // always under the thumb's natural resting arc.
              const angle = (i / QUICK_CHAT_GROUPS.length) * 2 * Math.PI - Math.PI / 2;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="menuitem"
                  className="qc-petal"
                  style={{
                    left: `calc(50% + ${Math.cos(angle) * WHEEL_RADIUS}px)`,
                    top: `calc(50% + ${Math.sin(angle) * WHEEL_RADIUS}px)`,
                  }}
                  data-testid={`quickchat-group-${g.id}`}
                  onClick={() => setGroupId(g.id)}
                >
                  <span className="qc-petal-label">{g.label}</span>
                </button>
              );
            })}
            <div className="qc-hub">
              <span className="qc-hub-title">Quick chat</span>
              <button type="button" className="btn small" data-testid="quickchat-close" onClick={close}>
                ✕ Close
              </button>
            </div>
          </div>
        </div>
      )}

      {open && canSay && pending !== null && (
        <TargetPicker
          state={state}
          seat={seat}
          phrase={pending}
          onBack={() => setPending(null)}
          onPick={(target) => {
            onSay(seat, pending.id, target);
            close();
          }}
        />
      )}

      {open && canSay && pending === null && group !== null && (
        <div className="qc-list" role="menu" aria-label={group.label} data-testid="quickchat-menu">
          <div className="qc-list-head">
            <button type="button" className="btn small" data-testid="quickchat-back" onClick={() => setGroupId(null)}>
              ‹ Back
            </button>
            <span className="qc-list-title">{group.label}</span>
          </div>
          {group.phrases.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className="btn qc-phrase"
              data-testid={`quickchat-say-${p.id}`}
              onClick={() => {
                // A phrase that names something cannot be sent yet: the engine
                // refuses it without a target, so ask for one first.
                if (p.needs) {
                  setPending(p);
                  return;
                }
                onSay(seat, p.id);
                close();
              }}
            >
              {p.text}
            </button>
          ))}
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
/**
 * Step three: who, or where.
 *
 * Rendered in place of the phrase list, with a Back that returns to it. Both
 * kinds are plain lists for the reason in the module comment — the board is not
 * available to click on while somebody else is mid-decision, and chat is
 * specifically the thing people do at that moment.
 */
function TargetPicker({
  state,
  seat,
  phrase,
  onBack,
  onPick,
}: {
  state: GameState;
  seat: PlayerId;
  phrase: QuickChatPhrase;
  onBack: () => void;
  onPick: (target: QuickChatTarget) => void;
}) {
  const options = useMemo(() => {
    if (phrase.needs === 'player') {
      // Everyone still in the game but you. A seat that is out cannot be
      // threatened, and the engine refuses aiming a line at yourself.
      return state.players
        .filter((p) => p.id !== seat && p.status === 'playing')
        .map((p) => ({
          key: `p${p.id}`,
          label: pname(state, p.id),
          color: playerColor(p.id),
          target: { kind: 'player', player: p.id } as QuickChatTarget,
        }));
    }
    // Gardens you do not already own — the line is about wanting one.
    return Object.entries(state.gardens)
      .filter(([, g]) => g.owner !== seat)
      .map(([key, g]) => {
        const [x, y] = key.split(',').map(Number);
        const pos = { x, y };
        return {
          key,
          label: `${GARDEN_META[g.type].label} ${posStr(pos)}`,
          color: g.owner === undefined ? undefined : playerColor(g.owner),
          target: { kind: 'space', pos } as QuickChatTarget,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [state, seat, phrase.needs]);

  return (
    <div className="qc-list" role="menu" aria-label="Choose a target" data-testid="quickchat-targets">
      <div className="qc-list-head">
        <button type="button" className="btn small" data-testid="quickchat-target-back" onClick={onBack}>
          ‹ Back
        </button>
        <span className="qc-list-title">{phrase.needs === 'player' ? 'Aim at…' : 'Which garden?'}</span>
      </div>
      {options.length === 0 && (
        <div className="qc-phrase muted" data-testid="quickchat-targets-empty">
          Nothing to point at right now.
        </div>
      )}
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="menuitem"
          className="btn qc-phrase"
          data-testid={`quickchat-target-${o.key}`}
          style={o.color ? { borderLeftColor: o.color, borderLeftWidth: 4 } : undefined}
          onClick={() => onPick(o.target)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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
          {quickChatText(b.phraseId, b.target)}
        </div>
      ))}
    </div>
  );
}
