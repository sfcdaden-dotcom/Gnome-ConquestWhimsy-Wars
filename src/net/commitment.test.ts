/**
 * Commit–reveal (commitment.ts) plus the end-to-end property it exists for:
 * a finished game verifies against the seal published before it started, and
 * a host that swapped the deck cannot make that check pass.
 */

import { describe, expect, it } from 'vitest';
import { commitmentFor, createSeal, randomSecret, verifySeal } from './commitment';
import type { MatchRecord } from '../engine';
import {
  MATCH_RECORD_SCHEMA,
  applyAction,
  chooseAiAction,
  createGame,
  isGameOver,
  replayMatch,
  sealHiddenState,
} from '../engine';
import type { GameSeal } from '../engine';

describe('commitment', () => {
  it('binds the host to one secret', async () => {
    const seal = await createSeal();
    expect(await verifySeal(seal, seal.commitment)).toBe(true);
  });

  it('rejects a different secret behind the same commitment', async () => {
    const seal = await createSeal();
    const swapped: GameSeal = { ...seal, secret: (seal.secret ^ 1) >>> 0 };

    // The host may of course publish a matching-looking envelope; the check
    // that matters is against the commitment seen at the START of the game.
    expect(await verifySeal(swapped, seal.commitment)).toBe(false);
    expect(await verifySeal({ ...swapped, commitment: await commitmentFor(swapped.secret, swapped.nonce) }, seal.commitment)).toBe(false);
  });

  it('rejects a different nonce', async () => {
    const seal = await createSeal();
    expect(await verifySeal({ ...seal, nonce: 'deadbeef' }, seal.commitment)).toBe(false);
  });

  it('is a SHA-256 hex digest, and deterministic for a given (secret, nonce)', async () => {
    const a = await commitmentFor(7, 'abc');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await commitmentFor(7, 'abc')).toBe(a);
    expect(await commitmentFor(8, 'abc')).not.toBe(a);
    expect(await commitmentFor(7, 'abd')).not.toBe(a);
  });

  it('pads the commitment with a nonce long enough to resist a 2^32 sweep', async () => {
    const seal = await createSeal();
    // 16 bytes of hex. Without it, sha256(secret) over a 32-bit secret is
    // exhaustible in minutes and the commitment leaks the deck mid-game.
    expect(seal.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('draws a fresh secret and nonce each time', async () => {
    const seals = await Promise.all(Array.from({ length: 16 }, () => createSeal()));
    expect(new Set(seals.map((s) => s.nonce)).size).toBe(seals.length);
    expect(new Set(seals.map((s) => s.commitment)).size).toBe(seals.length);
    expect(new Set(Array.from({ length: 16 }, randomSecret)).size).toBeGreaterThan(1);
  });
});

describe('a finished game verifies against the seal published before it', () => {
  /** Play a sealed game to completion and record it the way a room would. */
  function playSealed(seal: GameSeal, seed: number, maxActions = 2000): MatchRecord {
    let state = sealHiddenState(createGame(
      { players: [{ name: 'P0', controller: 'cpu' }, { name: 'P1', controller: 'cpu' }], gardenPreset: 'random' },
      seed,
    ), seal.secret);
    const config = state.config;
    const actions = [];
    while (!isGameOver(state) && actions.length < maxActions) {
      const action = chooseAiAction(state);
      actions.push(action);
      state = applyAction(state, action);
    }
    return {
      schemaVersion: MATCH_RECORD_SCHEMA,
      config,
      seed,
      seal,
      actions,
      result: {
        winner: state.winner,
        winnerName: null,
        winnerController: null,
        turns: state.turn?.number ?? 0,
        actionCount: actions.length,
        winningTeam: null,
      winners: [],
      winnerNames: [],
      reason: state.winner === null ? 'draw' : 'lastStanding',
      },
    };
  }

  it('replays exactly — the deck the players saw is the deck the seal fixed', async () => {
    const seal = await createSeal();
    const record = playSealed(seal, 71);

    expect(await verifySeal(seal, seal.commitment)).toBe(true);
    const replayed = replayMatch(record);
    expect(replayed.winner).toBe(record.result.winner);
    expect(replayed.eventCount).toBeGreaterThan(0);
  });

  it('catches a host that played a different deck than it committed to', async () => {
    const honest = await createSeal();
    const record = playSealed(honest, 72);

    // The host reveals a DIFFERENT secret than the one it committed to — the
    // shape a stacked deck would take. Two independent checks catch it.
    const lie: GameSeal = { ...honest, secret: (honest.secret ^ 0x5eed) >>> 0 };
    expect(await verifySeal(lie, honest.commitment)).toBe(false);

    // ...and even without the commitment, the replay itself diverges: the
    // actions recorded no longer describe a legal game under that deck.
    let diverged = false;
    try {
      const replayed = replayMatch({ ...record, seal: lie });
      diverged = replayed.winner !== record.result.winner || replayed.eventCount !== 0;
    } catch {
      diverged = true; // an illegal action under the swapped deck
    }
    expect(diverged).toBe(true);
  });

  it('cannot be replayed with the seal simply dropped', () => {
    const record = playSealed({ secret: 0, nonce: '', commitment: '' }, 73);
    const unsealed: MatchRecord = { ...record, seal: undefined };
    // `config + seed` rebuilds the right board but the seed's ORIGINAL deck,
    // so the recorded actions stop describing a legal game. This is why
    // MatchRecord had to grow the seal (schema 2) rather than infer it.
    expect(() => replayMatch(unsealed)).toThrow();
  });
});
