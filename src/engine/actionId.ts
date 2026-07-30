/**
 * Canonical identities for actions, intents and card targets.
 *
 * An enumerated legal action has no identity of its own: `getLegalActionIntents`
 * and `enumerateCompleteCardActions` return plain arrays, and callers that need
 * to say "this is the same action as that one" (a UI keying a button, a policy
 * caching a score, a test diffing two enumerations, a network client acking a
 * dispatch) were left comparing array *indices*. An index is not an identity —
 * it moves whenever enumeration order changes, which happens for reasons that
 * have nothing to do with the action itself (a unit id being reused, a card
 * gaining a targeting step, a loop being reordered in a refactor).
 *
 * `actionKey(action)` is that missing identity: a total, deterministic string
 * derived from the action's CONTENT alone. Two actions with the same key are the
 * same play; two plays that differ anywhere get different keys (the encoding is
 * injective — every field is length- or delimiter-tagged, so no two distinct
 * actions collide). It is stable across:
 *  - enumeration order (position in the returned array is never an input),
 *  - object key order (`{player, type}` keys the same as `{type, player}`),
 *  - JSON round-trips (`GameState` is plain data; so are actions),
 *  - engine versions, unless the action's own shape changes.
 *
 * ORDER INSIDE A PAYLOAD IS CONTENT, NOT NOISE. `targets.units = [a, b]` and
 * `[b, a]` key differently on purpose: for an `ordered: true` targeting step the
 * two are genuinely different plays (Instigation's first gnome is the attacker).
 * For an unordered step the enumerator emits exactly one canonical order, so the
 * distinction never surfaces in an enumerated set — and `canonicalTargets`
 * exists for callers that build payloads by hand and want the enumerator's
 * order-insensitive form (see its doc for the one case it must not be used on).
 *
 * `intentKey(action)` is the coarser identity used by the UI and the CPU: the
 * same action with any `targets` payload stripped, so every completion of one
 * card play collapses onto the single intent that started it.
 */

import type { Action, CardTarget, CardTargets, Pos } from './types';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** `x,y` — the same encoding `posKey` uses, kept local so this module has no deps. */
function pos(p: Pos): string {
  return `${p.x},${p.y}`;
}

/**
 * Escape a value that is interpolated between delimiters. Ids are engine-issued
 * and delimiter-free today, but escaping is what makes the encoding injective
 * for *any* future id, rather than only for the ones we happen to mint now.
 */
function esc(s: string): string {
  return s.replace(/[\\|:;]/g, (c) => `\\${c}`);
}

function list(items: readonly string[]): string {
  return items.map(esc).join(';');
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Canonical key for a single `CardTarget` (one answer to one targeting step). */
export function targetKey(t: CardTarget): string {
  switch (t.kind) {
    case 'unit':
      return `u:${esc(t.unitId)}`;
    case 'space':
      return `s:${pos(t.pos)}`;
    case 'player':
      return `p:${t.playerId}`;
    case 'card':
      return `c:${esc(t.cardId)}`;
    case 'gardenType':
      return `g:${t.gardenType}`;
  }
}

/**
 * Canonical key for a complete `CardTargets` payload. Slots are emitted in a
 * fixed order (units, spaces, players, cards, gardenType) regardless of the
 * object's own key order; an absent slot and an empty slot key differently,
 * because a card that requires a space and one that takes none are different
 * payloads.
 */
export function targetsKey(t: CardTargets | undefined): string {
  if (t === undefined) return '';
  const parts: string[] = [];
  if (t.units) parts.push(`u=${list(t.units)}`);
  if (t.spaces) parts.push(`s=${list(t.spaces.map(pos))}`);
  if (t.players) parts.push(`p=${list(t.players.map(String))}`);
  if (t.cards) parts.push(`c=${list(t.cards)}`);
  if (t.gardenType) parts.push(`g=${t.gardenType}`);
  // A payload with no slots is still a payload: `{}` means "this play was built
  // with targets that happen to be empty", which is not the same action as an
  // untargeted intent, so it gets its own marker rather than the empty key.
  return parts.length > 0 ? parts.join('|') : '-';
}

/**
 * The order-insensitive form of a payload: every list slot sorted.
 *
 * For a card whose targeting steps are all unordered this is the enumerator's
 * canonical order, so a hand-built payload keys identically to the enumerated
 * one. Do NOT apply it to a card with an `ordered: true` step (Instigation) —
 * sorting there would merge two genuinely different plays (attacker/defender
 * swapped) into one identity.
 */
export function canonicalTargets(t: CardTargets): CardTargets {
  const out: CardTargets = {};
  if (t.units) out.units = [...t.units].sort();
  if (t.spaces) out.spaces = [...t.spaces].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (t.players) out.players = [...t.players].sort((a, b) => a - b);
  if (t.cards) out.cards = [...t.cards].sort();
  if (t.gardenType) out.gardenType = t.gardenType;
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Canonical identity of an action. Same content ⇒ same key, whatever order the
 * enumerator produced it in or the object's fields were written in.
 */
export function actionKey(action: Action): string {
  const head = `${action.type}:${action.player}`;
  switch (action.type) {
    case 'rollOff':
    case 'declineEffect':
    case 'respondPass':
    case 'cancelTargeting':
    case 'drawCard':
    case 'endTurn':
      return head;
    case 'chooseHarvest':
      return `${head}:${esc(action.sourceKey)}`;
    case 'homeHarvest':
      return `${head}:${action.take}`;
    case 'mushroomClones':
      return `${head}:${action.count}`;
    case 'slide':
    case 'tunnel':
    case 'snailMove':
      return `${head}:${pos(action.to)}`;
    case 'discardCard':
      return `${head}:${esc(action.cardId)}`;
    case 'snailify':
      return `${head}:${action.accept ? 'accept' : 'decline'}`;
    case 'sacrificeGnome':
      return `${head}:${esc(action.unitId)}`;
    case 'selectTarget':
      return `${head}:${targetKey(action.target)}`;
    case 'move':
      return `${head}:${esc(action.unitId)}:${pos(action.to)}`;
    case 'plant':
      return `${head}:${pos(action.pos)}:${action.gardenType}`;
    case 'upgrade':
      return `${head}:${pos(action.pos)}`;
    case 'playCard':
    case 'respondPlayCard':
      // An untargeted play (the intent) and any of its completions are distinct
      // identities; `intentKey` is what collapses them.
      return `${head}:${esc(action.cardId)}:${targetsKey(action.targets)}`;
    case 'quickChat':
      return `${head}:${esc(action.phraseId)}`;
  }
}

/**
 * Identity of the *intent* behind an action: `actionKey` with any card-target
 * payload stripped. Every complete expansion of one card play shares its
 * intent key with the untargeted intent that `getLegalActionIntents` offers, so
 * a UI that keys hand buttons by intent stays stable while the player walks the
 * card's targeting steps.
 */
export function intentKey(action: Action): string {
  if (action.type === 'playCard' || action.type === 'respondPlayCard') {
    return actionKey({ type: action.type, player: action.player, cardId: action.cardId });
  }
  return actionKey(action);
}

/** Do these two actions denote the same play? (Content equality, order-free.) */
export function sameAction(a: Action, b: Action): boolean {
  return actionKey(a) === actionKey(b);
}

/**
 * Index a list of actions by canonical key. Later entries win on a duplicate
 * key, which cannot happen in a well-formed enumeration — `legalActions.test.ts`
 * pins that every enumerated set is key-unique.
 */
export function byActionKey(actions: readonly Action[]): Map<string, Action> {
  return new Map(actions.map((a) => [actionKey(a), a]));
}
