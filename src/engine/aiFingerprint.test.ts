/**
 * AI behavioral fingerprints.
 *
 * `chooseAiAction` is deterministic (no RNG, stable tie-breaking), so a seeded
 * AI-vs-AI game produces one exact action sequence. These tests hash that
 * sequence per (seed, config, difficulty) and pin the digest, which is what
 * makes a refactor of the AI internals provably behavior-preserving: the split
 * into `src/engine/ai/*` must leave every digest untouched.
 *
 * When a heuristic is INTENTIONALLY changed, these digests move — update them
 * in the same commit as the change, never separately.
 */

import { describe, expect, it } from 'vitest';
import type { GameState } from './index';
import { applyAction, chooseAiAction, createGame, isGameOver } from './index';
import { actionKey } from './actionId';

/**
 * FNV-1a over the canonical action keys of a full game — a compact stand-in for
 * the whole action sequence (any divergence anywhere changes the digest).
 */
function fingerprint(state: GameState, cap = 5000): { digest: string; actions: number; winner: number | null } {
  let s = state;
  let h = 0x811c9dc5;
  let actions = 0;
  while (!isGameOver(s) && actions < cap) {
    const a = chooseAiAction(s);
    const key = actionKey(a);
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    s = applyAction(s, a);
    actions += 1;
  }
  return { digest: (h >>> 0).toString(16).padStart(8, '0'), actions, winner: s.winner };
}

function game(seed: number, difficulty: 'easy' | 'normal' | 'hard', count: 2 | 4 = 2): GameState {
  return createGame(
    {
      players: Array.from({ length: count }, (_, i) => ({
        name: `P${i}`,
        controller: 'cpu' as const,
        difficulty,
      })),
    },
    seed,
  );
}

describe('AI fingerprints (behavior lock)', () => {
  const cases: Array<{
    label: string;
    state: () => GameState;
    digest: string;
    actions: number;
    winner: number | null;
  }> = [
    { label: '2p normal seed 1', state: () => game(1, 'normal'), digest: 'daada85b', actions: 210, winner: 1 },
    { label: '2p normal seed 2', state: () => game(2, 'normal'), digest: '45713736', actions: 293, winner: 1 },
    { label: '2p hard seed 3', state: () => game(3, 'hard'), digest: '899f8d83', actions: 94, winner: 0 },
    { label: '2p easy seed 4', state: () => game(4, 'easy'), digest: 'e0698fee', actions: 115, winner: 1 },
    { label: '4p normal seed 5', state: () => game(5, 'normal', 4), digest: '510a18c4', actions: 496, winner: 1 },
  ];

  for (const c of cases) {
    it(`${c.label} plays exactly the pinned sequence`, () => {
      const fp = fingerprint(c.state());
      expect({ digest: fp.digest, actions: fp.actions, winner: fp.winner }).toEqual({
        digest: c.digest,
        actions: c.actions,
        winner: c.winner,
      });
    });
  }

  it('replays identically from the same seed (no hidden state between runs)', () => {
    expect(fingerprint(game(1, 'normal'))).toEqual(fingerprint(game(1, 'normal')));
  });
});
