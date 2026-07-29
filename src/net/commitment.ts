/**
 * Commit–reveal for a sealed game's secret.
 *
 * Server-authoritative multiplayer asks players to trust the host with the one
 * thing they cannot see: the deck. `sealHiddenState` puts the deck behind a
 * secret only the host knows, which stops opponents reading it — and creates a
 * new question, "how do I know the host didn't stack it?" Commit–reveal
 * answers that without giving anything away while the game is live:
 *
 *   1. Room creation — host draws a secret and a nonce, and publishes
 *      `commitment` = SHA-256(secret, nonce). Binding: it can no longer change
 *      the deck without breaking the hash.
 *   2. The game is played. The commitment says nothing usable (see NONCE).
 *   3. Game over — host publishes `secret` and `nonce` in the match record.
 *      Anyone can now recompute the hash, confirm it matches what was
 *      published at the start, and `replayMatch` the whole game to see that
 *      every card fell where the seal said it would.
 *
 * NONCE — the part that is easy to get wrong. `rngState` is a 32-bit number,
 * so committing to `sha256(secret)` alone would be no commitment at all: an
 * opponent receives it at game start, hashes all 2^32 candidates in minutes,
 * and reads the deck for the rest of the game. The 128-bit nonce puts the
 * pre-image out of reach. Never drop it, and never derive it from the room
 * code, the time, or the seed.
 *
 * Runs unchanged in a Worker and in the browser — Web Crypto only, no deps.
 */

import type { GameSeal } from '../engine';

/** Bytes of randomness padding the commitment. 128 bits is well past search. */
const NONCE_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The host's secret: what the deck order and every die roll follow from.
 * A CSPRNG draw, never a counter or a timestamp — a guessable secret is
 * exactly the failure this whole mechanism exists to prevent.
 */
export function randomSecret(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** SHA-256 over the secret and nonce, hex. The published commitment. */
export async function commitmentFor(secret: number, nonce: string): Promise<string> {
  const message = new TextEncoder().encode(`whimsy-wars/seal/v1:${secret >>> 0}:${nonce}`);
  const digest = await crypto.subtle.digest('SHA-256', message);
  return toHex(new Uint8Array(digest));
}

/**
 * Draw a fresh seal at room creation. The host keeps the whole thing, passes
 * `secret` to `sealHiddenState`, and publishes ONLY `commitment` until the
 * game is over.
 */
export async function createSeal(): Promise<GameSeal> {
  const secret = randomSecret();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
  return { secret, nonce, commitment: await commitmentFor(secret, nonce) };
}

/**
 * Check a revealed seal against the commitment published when the game began.
 * `published` is what the client saw at the start — the point of the exercise
 * is that it does NOT come from the same message as the reveal.
 *
 * True here means the host was bound to this secret before the first card was
 * drawn. Pair it with `replayMatch` to check the game actually followed from
 * it: the seal proves the deck was fixed in advance, the replay proves it was
 * the deck that got played.
 */
export async function verifySeal(seal: GameSeal, published: string): Promise<boolean> {
  if (seal.commitment !== published) return false;
  return (await commitmentFor(seal.secret, seal.nonce)) === published;
}
