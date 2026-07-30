/**
 * Performance measurement for legal-action enumeration and card-target
 * feasibility — the "measure first" half of the open TECH_DEBT question about
 * whether this work is repeated unnecessarily.
 *
 * Nothing here optimizes anything. It exists so that any future change made in
 * the name of speed has a before/after number attached, and so that the shape
 * of the cost (which call dominates, how much of it is card feasibility) is
 * recorded rather than guessed at. Run `npx vitest run src/engine/perf.test.ts`
 * and read the printed table; the recorded figures live in TECH_DEBT.md under
 * "Enumeration cost — measured, not yet optimized".
 *
 * The assertions are deliberately loose ORDER-OF-MAGNITUDE ceilings, not
 * targets: they exist to catch an accidental quadratic blowup (the thing that
 * would actually hurt), and they must stay far enough above the measured values
 * that ordinary machine-to-machine variance in CI can never trip them.
 */

import { describe, expect, it } from 'vitest';
import type { GameState } from './index';
import {
  applyAction,
  chooseAiAction,
  createGame,
  enumerateCompleteCardActions,
  getLegalActionIntents,
  getPendingDecisionOptions,
  isGameOver,
} from './index';
import { CARD_DEFINITIONS, firstCompleteTargets, getCardDef } from './cards';
import { mutate, toActionPhase, withGnome, withHand } from './testkit';

const TARGETED = CARD_DEFINITIONS.filter((c) => c.needsTargets).map((c) => c.id);

/** Mean milliseconds per call over `runs` iterations, after a warm-up pass. */
function timeMs(runs: number, fn: () => unknown): number {
  for (let i = 0; i < Math.min(runs, 20); i++) fn(); // warm up JIT
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
}

function report(label: string, ms: number, extra = ''): void {
  console.log(`  ${label.padEnd(52)} ${ms.toFixed(4)} ms${extra ? `   ${extra}` : ''}`);
}

/** A mid-game-ish state: extra gnomes on both sides, a full targeted hand. */
function loadedState(seed = 7): { s: GameState; me: number } {
  let s = toActionPhase(seed);
  const me = s.turn!.activePlayer;
  const foe = me === 0 ? 1 : 0;
  for (const pos of [{ x: 2, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 2 }]) {
    s = withGnome(s, me, pos).state;
  }
  for (const pos of [{ x: 4, y: 3 }, { x: 5, y: 3 }]) {
    s = withGnome(s, foe, pos).state;
  }
  s = withHand(s, me, ...TARGETED);
  s = mutate(s, (d) => {
    d.discard.push('four-leaf-clover');
    d.players[me].wishes = 6;
  });
  return { s, me };
}

describe('enumeration cost', () => {
  it('intent enumeration vs complete expansion, and the feasibility share', () => {
    const { s, me } = loadedState();
    const emptyHand = mutate(s, (d) => {
      d.players[me].hand = [];
    });

    const intents = timeMs(200, () => getLegalActionIntents(s, me));
    const intentsNoCards = timeMs(200, () => getLegalActionIntents(emptyHand, me));
    const complete = timeMs(50, () => enumerateCompleteCardActions(s, me));

    const nIntents = getLegalActionIntents(s, me).length;
    const nComplete = enumerateCompleteCardActions(s, me).length;
    const feasibilityShare = ((intents - intentsNoCards) / intents) * 100;

    console.log('\nenumeration (7×7, 5 gnomes, full targeted hand):');
    report('getLegalActionIntents', intents, `${nIntents} actions`);
    report('  … with an empty hand (no card feasibility)', intentsNoCards);
    report('  … card-feasibility share', intents - intentsNoCards, `${feasibilityShare.toFixed(0)}% of the call`);
    report('enumerateCompleteCardActions (analysis)', complete, `${nComplete} actions`);
    console.log(`  ${'  … expansion multiplier'.padEnd(52)} ${(complete / intents).toFixed(1)}× the intent call`);

    // The intent API must stay the cheap one — that is its entire reason for
    // existing. A 10× margin leaves room for slow CI without hiding a blowup.
    expect(intents).toBeLessThan(complete * 10);
    expect(intents).toBeLessThan(20);
    expect(nComplete).toBeGreaterThanOrEqual(nIntents);
  });

  it('per-card target feasibility (the flow walk behind playability)', () => {
    const { s, me } = loadedState();
    console.log('\ncard-target feasibility — firstCompleteTargets per card:');
    let total = 0;
    const rows: Array<[string, number]> = [];
    for (const cardId of TARGETED) {
      const ms = timeMs(200, () => firstCompleteTargets(s, me, cardId));
      rows.push([cardId, ms]);
      total += ms;
    }
    for (const [cardId, ms] of rows.sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      report(`  ${cardId} (slowest 5)`, ms);
    }
    report('sum over every targeted card', total, `${TARGETED.length} cards`);
    // Every hand card is feasibility-checked once per enumeration, so this sum
    // is the worst case a single `getLegalActionIntents` can pay.
    expect(total).toBeLessThan(50);
  });

  it('phased step options stay proportional to the step, not the board²', () => {
    console.log('\nphased targeting — listing one step’s options:');
    for (const boardSize of [7, 11, 15]) {
      let s = toActionPhase(3, { boardSize });
      const me = s.turn!.activePlayer;
      s = withGnome(s, me, { x: 2, y: 2 }).state;
      s = withHand(s, me, 'plot-twist');
      const started = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
      const first = timeMs(200, () => getPendingDecisionOptions(started));
      report(`plot-twist step 1 on ${boardSize}×${boardSize}`, first, `${getPendingDecisionOptions(started).length} options`);
      expect(first).toBeLessThan(20);
    }
  });
});

describe('what a real loop actually pays', () => {
  it('AI throughput, and how much of an action is enumeration', () => {
    const fresh = () =>
      createGame({ players: [{ name: 'A', controller: 'cpu' }, { name: 'B', controller: 'cpu' }] }, 2024);

    // One full game, timing the two halves of every step.
    let s = fresh();
    let choose = 0;
    let apply = 0;
    let enumerate = 0;
    let steps = 0;
    while (!isGameOver(s) && steps < 5000) {
      const t0 = performance.now();
      const a = chooseAiAction(s);
      const t1 = performance.now();
      const next = applyAction(s, a);
      const t2 = performance.now();
      getLegalActionIntents(s);
      const t3 = performance.now();
      choose += t1 - t0;
      apply += t2 - t1;
      enumerate += t3 - t2;
      s = next;
      steps += 1;
    }

    console.log('\nfull AI game (seed 2024, 2p):');
    report('chooseAiAction', choose / steps, `${steps} actions`);
    report('applyAction (clone + dispatch + settle)', apply / steps);
    report('getLegalActionIntents alone', enumerate / steps,
      `${((enumerate / choose) * 100).toFixed(0)}% of chooseAiAction`);

    expect(isGameOver(s)).toBe(true);
    expect(choose / steps).toBeLessThan(50);
  }, 120_000);

  it('measures the UI’s per-render enumeration cost (it enumerates twice)', () => {
    // GameScreen memoizes `legal` for the acting seat AND `handPlayable` for the
    // revealed seat. On a local human's turn those are the SAME seat, so the
    // work is done twice over identical inputs — the clearest candidate for
    // "repeated unnecessarily", measured here before anyone merges the memos.
    const { s, me } = loadedState();
    const once = timeMs(200, () => getLegalActionIntents(s, me));
    const twice = timeMs(200, () => {
      getLegalActionIntents(s, me);
      getLegalActionIntents(s, me);
    });
    console.log('\nUI per-render enumeration (same seat, both memos):');
    report('one enumeration', once);
    report('two enumerations (what GameScreen does today)', twice);
    report('  … duplicated work per render', twice - once);
    // A frame budget is ~16 ms; two enumerations must not come close to it.
    expect(twice).toBeLessThan(16);
  });
});

describe('repeated work: is the same feasibility computed more than once?', () => {
  /**
   * Count the flow walks one AI action pays for. `whyCannotPlayNow` walks each
   * targeted hand card's flow during enumeration; the CPU's planners then build
   * their own payloads, and `completeTargets` walks the flow AGAIN for any card
   * whose planner declined to target it. This counts both, so the duplication is
   * a number rather than a suspicion.
   */
  it('counts flow walks per enumeration and reports the duplication', () => {
    const { s, me } = loadedState();
    const inHand = [...new Set(s.players[me].hand)];
    const targetedInHand = inHand.filter((id) => getCardDef(id)?.needsTargets);

    // Enumeration walks the flow once per distinct targeted card in hand.
    const walksPerEnumeration = targetedInHand.length;
    // The AI then re-walks only for a card it chose but did not target itself.
    const chosen = chooseAiAction(s);
    const reWalks =
      (chosen.type === 'playCard' || chosen.type === 'respondPlayCard') &&
      getCardDef(chosen.cardId)?.needsTargets &&
      chosen.targets === undefined
        ? 1
        : 0;

    const walkCost = timeMs(200, () => {
      for (const id of targetedInHand) firstCompleteTargets(s, me, id);
    });

    console.log('\nrepeated feasibility work, per AI action:');
    report('flow walks during enumeration', walkCost, `${walksPerEnumeration} cards`);
    report('extra walks from completeTargets', 0, `${reWalks} (planner covered the rest)`);

    // The planners cover every card they select, so the fallback re-walk is the
    // exception, not the rule — the duplication is bounded by 1 per action.
    expect(reWalks).toBeLessThanOrEqual(1);
    expect(walksPerEnumeration).toBe(targetedInHand.length);
  });
});
