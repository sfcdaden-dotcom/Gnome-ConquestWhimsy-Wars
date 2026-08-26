/**
 * UI metadata + human-readable formatting.
 * Pure functions over engine data — no rule logic lives here.
 */

import type {
  Action,
  CardId,
  CardTarget,
  CardTargets,
  EliminationReason,
  FightSide,
  GameEvent,
  GameState,
  GardenType,
  PlayerId,
  Pos,
  QuickChatId,
} from '../engine';
import { getCardDef, getCurseDef, getQuickChatPhrase, nameSaltOf, whyCannotPlayNow } from '../engine';
import type { UnitEventRef } from './gnomeNames';
import { gnomeName, unitNameFromEvent, unitNameLive } from './gnomeNames';

// ---------------------------------------------------------------------------
// Player + garden presentation
// ---------------------------------------------------------------------------

/** Seat colors: red, blue, yellow, purple (clockwise). Named in
 * `PLAYER_COLOR_NAMES`, which is also what an untouched seat is called. */
export const PLAYER_COLORS = ['#d8504d', '#3f7ad8', '#c9930a', '#9256cf'];
export const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Purple'];

/** Why a seat left the game, in log-line words. */
export const ELIMINATION_REASON_TEXT: Record<EliminationReason, string> = {
  'home-captured': 'home garden captured',
  'home-destroyed': 'home garden gone',
  reinforcements: 'out of reinforcements',
};

export function playerColor(id: number): string {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}

/** "👋 Hi!" for a quick-chat phrase id (raw id if it is not in the catalogue). */
export function quickChatText(phraseId: QuickChatId): string {
  const p = getQuickChatPhrase(phraseId);
  return p ? `${p.emoji} ${p.text}` : phraseId;
}

/** A fresh random game seed (UI convenience; the engine itself never rolls). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

export interface GardenMeta {
  label: string;
  blurb: string;
  /** Name of the upgraded form (Garden Upgrades, RULES.md). */
  upgradeLabel: string;
  /** What the upgraded form does. */
  upgradeBlurb: string;
}

export const GARDEN_META: Record<GardenType, GardenMeta> = {
  home: {
    label: 'Home Garden',
    blurb: 'Harvest: 1 Wish or 1 Gnome. Lose it, lose the game.',
    upgradeLabel: 'Home Garden',
    upgradeBlurb: 'Home Gardens cannot be upgraded.',
  },
  dandelion: {
    label: 'Dandelion',
    blurb: 'Harvest: up to 2 occupying gnomes gain 1 Wish each.',
    upgradeLabel: 'Golden Dandelion',
    upgradeBlurb: 'Golden Dandelion: harvest unchanged, and your wish limit is +1 while you control it.',
  },
  mushroom: {
    label: 'Mushroom',
    blurb: 'Harvest: clone up to 2 occupying gnomes.',
    upgradeLabel: 'Elder Mushroom',
    upgradeBlurb: 'Elder Mushroom: harvest unchanged, and your gnome board limit is +1 while you control it.',
  },
  flytrap: {
    label: 'Flytrap',
    blurb: 'Neutral hazard: fights anyone who enters or harvests here.',
    upgradeLabel: 'Snapping Maw',
    upgradeBlurb: 'Snapping Maw: the flytrap adds +1 to its die — against everyone, including you.',
  },
  maize: {
    label: 'Maize',
    blurb: 'Exit costs 1 Wish. Harvest roll < 4 doubles the cost.',
    upgradeLabel: 'Thorn Maize',
    upgradeBlurb: 'Thorn Maize: exit costs 2 Wishes (harvest doubling makes it 4).',
  },
  slippery: {
    label: 'Slippery',
    blurb: 'Entry: slide 1 space. Harvest: slide anywhere adjacent (incl. diagonal).',
    upgradeLabel: 'Glacier',
    upgradeBlurb:
      'Glacier: entry slides may go diagonally; harvest slides exactly 2 orthogonally in a straight line (whooshing past the middle space) or 1 diagonally.',
  },
  tunnel: {
    label: 'Tunnel',
    blurb: 'Entry: hop to another tunnel. Harvest: tunnel or hop to a garden you occupy.',
    upgradeLabel: 'Grand Burrow',
    upgradeBlurb: 'Grand Burrow: the entry hop may also go to any garden occupied by one of your gnomes.',
  },
};

export const DIE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export function dieFace(roll: number): string {
  return DIE_FACES[Math.max(0, Math.min(5, roll - 1))];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function pname(state: GameState, id: number): string {
  return state.players[id]?.name ?? `Player ${id + 1}`;
}

export function cardName(id: string): string {
  return getCardDef(id)?.name ?? getCurseDef(id)?.name ?? id;
}

/** Rules text of a card or curse, for tooltips. Empty when the id is unknown. */
export function cardText(id: string): string {
  return getCardDef(id)?.text ?? getCurseDef(id)?.text ?? '';
}

/**
 * Why a card in the revealed hand cannot be played right now, as a sentence,
 * or null when it can.
 *
 * A greyed-out Play button used to be the whole explanation, and the reasons
 * are not guessable: a Ritual held during someone else's turn and a Sudden
 * with nothing legal to point at look identical in the hand. The engine
 * already computes the reason for its own legality check — this only dresses
 * it as a sentence.
 *
 * `blocked` is the screen-level reason nothing at all is playable (a hot-seat
 * hand-off, a fight replaying); it wins, because "no legal targets" is a
 * confusing thing to say about a card whose owner is not even looking yet.
 */
export function playHint(
  state: GameState,
  seat: PlayerId,
  cardId: CardId,
  blocked: string | null = null,
): string | null {
  if (blocked) return sentence(blocked);
  const why = whyCannotPlayNow(state, seat, cardId);
  return why === null ? null : sentence(why);
}

/** Capitalized, full-stopped. The engine writes reasons as clause fragments. */
function sentence(text: string): string {
  if (text === '') return text;
  const capped = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

export function sideName(state: GameState, side: FightSide): string {
  return side.kind === 'flytrap' ? 'the Flytrap' : pname(state, side.player);
}

export function posStr(p: Pos): string {
  return `(${p.x},${p.y})`;
}

// ---------------------------------------------------------------------------
// Event → sentence
// ---------------------------------------------------------------------------

/**
 * "Bramblewick the Bold (Red)" — a unit named from the identity facts its event
 * carries, so the line still reads correctly long after the unit is off the
 * board. Snail labels already name their seat, so they are not doubled up.
 */
function who(state: GameState, ref: UnitEventRef): string {
  const name = unitNameFromEvent(state, ref);
  return ref.unitKind === 'snail' ? name : `${name} (${pname(state, ref.player)})`;
}

/**
 * " — at risk: X vs Y." for a fight round. A side with no gnome on the line
 * (a flytrap, which is only ever stunned) is simply left out rather than
 * suppressing the whole clause, so a mixed fight still names its one casualty
 * candidate. Empty when neither side risks a gnome.
 */
function atRiskClause(state: GameState, candidates: readonly (string | null)[]): string {
  const named = candidates.filter((id): id is string => id !== null).map((id) => gnomeName(nameSaltOf(state), id));
  return named.length === 0 ? '' : ` — at risk: ${named.join(' vs ')}.`;
}

export function describeEvent(state: GameState, ev: GameEvent): string {
  switch (ev.type) {
    case 'rollOffRolled':
      return `${pname(state, ev.player)} rolls ${dieFace(ev.roll)} ${ev.roll} for turn order.`;
    case 'rollOffTie':
      return `Tie! ${ev.players.map((p) => pname(state, p)).join(' and ')} reroll.`;
    case 'turnOrderDetermined':
      return `${pname(state, ev.first)} goes first!`;
    case 'turnStarted':
      return `— Turn ${ev.turnNumber}: ${pname(state, ev.player)} —`;
    case 'harvestPhaseStarted':
      return `${pname(state, ev.player)}'s Harvest Phase (${ev.sources.length} source${ev.sources.length === 1 ? '' : 's'}).`;
    case 'actionPhaseStarted':
      return `${pname(state, ev.player)}'s Action Phase.`;
    case 'harvestSkipped':
      return `Harvest ${ev.sourceKey} skipped (${ev.reason}).`;
    case 'homeHarvested':
      return ev.took === 'nothing'
        ? `${pname(state, ev.player)}'s Home Garden produces nothing (limits reached).`
        : `${pname(state, ev.player)}'s Home Garden grants a ${ev.took === 'wish' ? 'Wish ✨' : 'Gnome'}.`;
    case 'dandelionHarvested':
      return `${pname(state, ev.player)}'s Dandelion at ${posStr(ev.pos)} blooms for ${ev.gnomes} gnome${ev.gnomes === 1 ? '' : 's'}.`;
    case 'mushroomHarvested':
      return `${pname(state, ev.player)}'s Mushroom at ${posStr(ev.pos)} clones ${ev.cloned} gnome${ev.cloned === 1 ? '' : 's'}.`;
    case 'maizeHarvested':
      return `${pname(state, ev.player)} rolls ${ev.roll} at the Maize ${posStr(ev.pos)}${ev.doubled ? ' — exit cost doubled!' : '.'}`;
    case 'wishesGained':
      return `${pname(state, ev.player)} gains ${ev.gained} Wish${ev.gained === 1 ? '' : 'es'}${ev.lost > 0 ? ` (${ev.lost} lost to the cap)` : ''}.`;
    case 'wishesSpent':
      return `${pname(state, ev.player)} spends ${ev.amount} Wish${ev.amount === 1 ? '' : 'es'} (${ev.reason}).`;
    case 'gnomeSpawned':
      return `${gnomeName(nameSaltOf(state), ev.unitId)} joins ${pname(state, ev.player)} at ${posStr(ev.pos)}.`;
    case 'unitMoved':
      return `${who(state, ev)} moves ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'unitSlid':
      return `${who(state, ev)} slides ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'unitTunneled':
      return `${who(state, ev)} tunnels ${posStr(ev.from)} → ${posStr(ev.to)}.`;
    case 'entryEffectDeclined':
      return `${who(state, ev)} declines the entry effect at ${posStr(ev.pos)}.`;
    case 'quickChatSaid':
      return `💬 ${pname(state, ev.player)}: ${quickChatText(ev.phraseId)}`;
    case 'entryChainCapped':
      return `${who(state, ev)} is too dizzy to keep hopping (${ev.hops} in a row) and stays at ${posStr(ev.pos)}.`;
    case 'gardenPlanted':
      return `${pname(state, ev.player)} plants a ${GARDEN_META[ev.gardenType].label} at ${posStr(ev.pos)}.`;
    case 'gardenUpgraded':
      return `⭐ ${pname(state, ev.player)} upgrades the ${GARDEN_META[ev.gardenType].label} at ${posStr(ev.pos)} into a ${GARDEN_META[ev.gardenType].upgradeLabel}!`;
    case 'gardenDestroyed':
      return `The ${GARDEN_META[ev.gardenType].label} at ${posStr(ev.pos)} is destroyed (${ev.cause}).`;
    case 'maizeExitPaid':
      return `${pname(state, ev.player)} pays ${ev.cost} Wish to leave the Maize at ${posStr(ev.pos)}.`;
    case 'cardDrawn':
      return `${pname(state, ev.player)} draws a Whimsy card.`; // identity hidden (pass-and-play)
    case 'cardDiscarded':
      return `${pname(state, ev.player)} discards ${cardName(ev.cardId)}.`;
    case 'cardPlayed':
      return `${pname(state, ev.player)} plays ${cardName(ev.cardId)}!`;
    case 'cardResolved':
      return `${pname(state, ev.player)}'s ${cardName(ev.cardId)} resolves.`;
    case 'cardCancelled':
      return `🚫 ${pname(state, ev.player)}'s ${cardName(ev.cardId)} is cancelled!`;
    case 'cardFizzled':
      return `${pname(state, ev.player)}'s ${cardName(ev.cardId)} fizzles (${ev.reason}).`;
    case 'cardStolen':
      return `${pname(state, ev.to)} steals a random card from ${pname(state, ev.from)}.`;
    case 'rollModified':
      return `${pname(state, ev.player)}'s roll is modified: ${ev.raw} ${ev.modifier >= 0 ? '+' : '−'} ${Math.abs(ev.modifier)} → ${ev.result}.`;
    case 'destructionPrevented':
      return `🛡️ ${who(state, ev)} is saved (Gnomebody Dies)!`;
    case 'gnomesMarried':
      // Titled off the event's own pair order, which is the order the engine
      // stores the marriage in — so the line agrees with every later label.
      return `💍 Mr ${gnomeName(nameSaltOf(state), ev.unitA)} and Mrs ${gnomeName(nameSaltOf(state), ev.unitB)} are married — till death do them join.`;
    case 'unitTeleported':
      return `${who(state, ev)} moves ${posStr(ev.from)} → ${posStr(ev.to)} (${cardName(ev.cardId)}).`;
    case 'spacesSwapped':
      return `🔀 Plot Twist! ${posStr(ev.a)} and ${posStr(ev.b)} swap contents.`;
    case 'timedEffectStarted':
      return ev.kind === 'greatWall'
        ? `🚧 Great Wall Of Whimsy${ev.pos ? ` at ${posStr(ev.pos)}` : ''} — no entry until ${pname(state, ev.player)}'s next turn.`
        : `🌽 Lost In The Maize — gnomes can't leave Maize Gardens until ${pname(state, ev.player)}'s next turn.`;
    case 'timedEffectExpired':
      return `${ev.kind === 'greatWall' ? 'The Great Wall Of Whimsy' : 'Lost In The Maize'} expires.`;
    case 'curseRevealed':
      return `☠️ ${pname(state, ev.player)} reveals a Curse: ${cardName(ev.cardId)}! It affects everyone, forever.`;
    case 'deckReshuffled':
      return `The deck is reshuffled${ev.curseAdded ? ' — a Curse lurks within…' : '.'}`;
    case 'fightStarted':
      return `⚔️ Fight at ${posStr(ev.pos)}: ${sideName(state, ev.sides[1])} attacks ${sideName(state, ev.sides[0])}!`;
    case 'fightRoundStarted':
      return `⚔️ Round ${ev.round}…`;
    case 'fightRolled':
      // The rolls belong to the SIDES (a seat rolls, with that seat's
      // modifiers) — the named gnomes are who each side stands to lose, not
      // duellists. `fightStarted` just above already names the two sides.
      return (
        `Rolls: ${dieFace(ev.rolls[0])} ${ev.rolls[0]} vs ${dieFace(ev.rolls[1])} ${ev.rolls[1]}` +
        `${ev.tie ? ' — tie, reroll!' : ''}${atRiskClause(state, ev.casualtyCandidates)}`
      );
    case 'unitDestroyed':
      return `${who(state, ev)} is destroyed at ${posStr(ev.pos)} — ${ev.cause}.`;
    case 'flytrapStunned':
      return `The Flytrap at ${posStr(ev.pos)} is stunned!`;
    case 'snailSurvivedLoss':
      return `${pname(state, ev.player)}'s Immortal Snail shrugs off the loss and is driven back.`;
    case 'snailRetreatBlocked':
      return `${pname(state, ev.player)}'s Immortal Snail has nowhere to retreat to and holds its ground.`;
    case 'fightEnded':
      return `The fight at ${posStr(ev.pos)} ends.`;
    case 'playerEliminated':
      return `💀 ${pname(state, ev.player)} is eliminated (${ELIMINATION_REASON_TEXT[ev.reason]}).`;
    case 'playerSnailified':
      return `${pname(state, ev.player)} returns as an Immortal Snail at ${posStr(ev.pos)}!`;
    case 'snailifyDeclined':
      return `${pname(state, ev.player)} leaves the game.`;
    case 'turnEnded':
      return `${pname(state, ev.player)} ends their turn.`;
    case 'gameFinished':
      return ev.winner !== null
        ? `🏆 ${pname(state, ev.winner)} wins Whimsy Wars!`
        : 'Nobody wins — the garden falls silent.';
    default: {
      // Future event kinds (cards in progress): render something readable.
      const e = ev as { type: string };
      return `${e.type}: ${JSON.stringify(ev)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Action → button label (generic fallback for unknown decision kinds)
// ---------------------------------------------------------------------------

export function describeAction(state: GameState, a: Action): string {
  switch (a.type) {
    case 'rollOff':
      return '🎲 Roll the die';
    case 'chooseHarvest':
      return `Harvest ${a.sourceKey === 'home' ? 'Home Garden' : `garden at (${a.sourceKey})`}`;
    case 'homeHarvest':
      return a.take === 'wish' ? '✨ Take 1 Wish' : 'Spawn a Gnome';
    case 'mushroomClones':
      return `Clone ${a.count} gnome${a.count === 1 ? '' : 's'}`;
    case 'slide':
      return `Slide to ${posStr(a.to)}`;
    case 'tunnel':
      return `Tunnel to ${posStr(a.to)}`;
    case 'declineEffect':
      return 'Decline';
    case 'respondPass':
      return 'Pass';
    case 'respondPlayCard':
      return `Play ${cardName(a.cardId)}`;
    case 'discardCard':
      return `Discard ${cardName(a.cardId)}`;
    case 'snailify':
      return a.accept ? 'Become the Immortal Snail' : 'Leave the game';
    case 'sacrificeGnome': {
      const u = state.units[a.unitId];
      return `Sacrifice ${unitNameLive(state, a.unitId)}${u ? ` at ${posStr(u.pos)}` : ''}`;
    }
    case 'snailMove':
      return `Move the snail to ${posStr(a.to)}`;
    case 'selectTarget':
      return describeTarget(state, a.target);
    case 'cancelTargeting':
      return 'Cancel targeting';
    case 'move':
      return `Move to ${posStr(a.to)}`;
    case 'plant':
      return `Plant ${GARDEN_META[a.gardenType].label} at ${posStr(a.pos)}`;
    case 'upgrade': {
      const g = state.gardens[`${a.pos.x},${a.pos.y}`];
      return g
        ? `Upgrade to ${GARDEN_META[g.type].upgradeLabel} at ${posStr(a.pos)} (2 ✨)`
        : `Upgrade the garden at ${posStr(a.pos)} (2 ✨)`;
    }
    case 'drawCard':
      return 'Draw a card (1 ✨)';
    case 'playCard':
      return `Play ${cardName(a.cardId)}`;
    case 'endTurn':
      return 'End turn';
    default: {
      // Future action kinds added by the card system.
      const raw = a as { type: string };
      const rest = Object.entries(a as Record<string, unknown>)
        .filter(([k]) => k !== 'type' && k !== 'player')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      return rest ? `${raw.type} (${rest})` : raw.type;
    }
  }
}

/**
 * What a card on the stack is pointed at, one phrase per target, in the order
 * the caster picked them.
 *
 * Written for the response window: a card is announced before it resolves, and
 * "Blue played Rocket-Propelled Gnome" is only half the news — whether to spend
 * a Nope-Gnome on it depends entirely on *whose* gnome is strapped to the
 * rocket. The targets are already public (the card stack is not redacted; see
 * view.ts), so this only surfaces what the responder is entitled to see.
 *
 * Empty for a card that takes no targets.
 */
export function describeCardTargets(state: GameState, targets: CardTargets | undefined): string[] {
  if (!targets) return [];
  const out: string[] = [];
  for (const unitId of targets.units ?? []) {
    const u = state.units[unitId];
    out.push(
      u
        ? `${unitNameLive(state, unitId)} (${pname(state, u.owner)}) at ${posStr(u.pos)}`
        : unitNameLive(state, unitId),
    );
  }
  for (const pos of targets.spaces ?? []) out.push(posStr(pos));
  for (const p of targets.players ?? []) out.push(pname(state, p));
  for (const cardId of targets.cards ?? []) out.push(cardName(cardId));
  if (targets.gardenType) out.push(GARDEN_META[targets.gardenType].label);
  return out;
}

function describeTarget(state: GameState, target: CardTarget): string {
  switch (target.kind) {
    case 'unit': {
      const u = state.units[target.unitId];
      return `Target the unit at ${u ? posStr(u.pos) : target.unitId}`;
    }
    case 'space':
      return `Target ${posStr(target.pos)}`;
    case 'player':
      return `Target ${pname(state, target.playerId)}`;
    case 'card':
      return `Choose ${cardName(target.cardId)}`;
    case 'gardenType':
      return `Choose ${GARDEN_META[target.gardenType].label}`;
  }
}

export function decisionLabel(kind: string): string {
  switch (kind) {
    case 'rollOff':
      return 'turn-order roll';
    case 'chooseHarvest':
      return 'choose harvest order';
    case 'homeHarvest':
      return 'home harvest';
    case 'mushroomClones':
      return 'mushroom clones';
    case 'slide':
      return 'slide destination';
    case 'tunnel':
      return 'tunnel destination';
    case 'fightRespond':
      return 'fight response';
    case 'cardResponse':
      return 'card response window';
    case 'cardTargeting':
      return 'choosing targets';
    case 'sacrificeGnome':
      return 'sacrifice a gnome';
    case 'snailMove':
      return 'snail move';
    case 'discard':
      return 'discard to hand limit';
    case 'snailify':
      return 'elimination choice';
    default:
      return kind;
  }
}
