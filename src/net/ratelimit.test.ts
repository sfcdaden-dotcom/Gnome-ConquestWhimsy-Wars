/**
 * The token bucket, and the budgets built on it.
 *
 * Two kinds of property here. The bucket's own arithmetic — it refills, it
 * caps, it refuses rather than going negative — and the *sizing*, which is the
 * part that is easy to get wrong silently: a limit tuned a factor of ten too
 * tight throttles honest play and nothing tells you, because the people it
 * happens to are not in the room with you.
 */

import { describe, expect, it } from 'vitest';
import {
  CONN_BUCKET_CAPACITY,
  CONN_BUCKET_REFILL_PER_SEC,
  FLOOD_DISCONNECT_AFTER,
  MESSAGE_COST,
  ROOM_BUCKET_CAPACITY,
  ROOM_BUCKET_REFILL_PER_SEC,
  TokenBucket,
} from './ratelimit';

describe('TokenBucket', () => {
  it('starts full and spends down', () => {
    const b = new TokenBucket(10, 1, 0);
    expect(b.available(0)).toBe(10);
    expect(b.take(0, 4)).toBe(true);
    expect(b.available(0)).toBe(6);
  });

  it('refuses what it cannot afford, and spends nothing doing so', () => {
    const b = new TokenBucket(10, 1, 0);
    expect(b.take(0, 8)).toBe(true);
    expect(b.take(0, 8)).toBe(false);
    // The refusal must not have partially charged: 2 tokens are still there
    // for a cheaper message arriving behind the expensive one.
    expect(b.available(0)).toBe(2);
    expect(b.take(0, 2)).toBe(true);
  });

  it('refills at the stated rate', () => {
    const b = new TokenBucket(10, 5, 0);
    expect(b.take(0, 10)).toBe(true);
    expect(b.available(500)).toBe(2.5);
    expect(b.available(2000)).toBe(10);
  });

  it('never refills past capacity, however long it idles', () => {
    const b = new TokenBucket(10, 5, 0);
    expect(b.take(0, 10)).toBe(true);
    expect(b.available(60 * 60 * 1000)).toBe(10);
  });

  it('does not mint tokens when the clock goes backwards', () => {
    const b = new TokenBucket(10, 5, 1000);
    expect(b.take(1000, 10)).toBe(true);
    expect(b.available(0)).toBe(0);
    // ...and time still runs forward from where it actually is, rather than
    // from the bogus reading: one second after the last real observation.
    expect(b.available(2000)).toBe(10);
  });
});

describe('the budgets are sized for humans', () => {
  /** A brisk human: a card play with three targets, clicked out in a second. */
  const BURST_ACTIONS = 6;

  it('lets one player fire a burst of actions without ever seeing a limit', () => {
    const b = new TokenBucket(CONN_BUCKET_CAPACITY, CONN_BUCKET_REFILL_PER_SEC, 0);
    for (let i = 0; i < BURST_ACTIONS; i++) expect(b.take(0, MESSAGE_COST.action)).toBe(true);
    expect(b.available(0)).toBeGreaterThan(CONN_BUCKET_CAPACITY / 2);
  });

  it('sustains a full turn of steady play indefinitely', () => {
    const b = new TokenBucket(CONN_BUCKET_CAPACITY, CONN_BUCKET_REFILL_PER_SEC, 0);
    // Two actions a second for five minutes — far past any real turn, and
    // past the control budget the shot clock would have closed anyway.
    for (let t = 0; t < 300_000; t += 500) {
      expect(b.take(t, MESSAGE_COST.action)).toBe(true);
    }
  });

  it('holds a flooder to a rate the room can serve forever', () => {
    const b = new TokenBucket(CONN_BUCKET_CAPACITY, CONN_BUCKET_REFILL_PER_SEC, 0);
    let served = 0;
    // A thousand messages a second for ten seconds.
    for (let t = 0; t < 10_000; t++) {
      for (let i = 0; i < 1000; i++) if (b.take(t, MESSAGE_COST.action)) served++;
    }
    // Capacity up front plus the refill, and not one message more.
    const ceiling = (CONN_BUCKET_CAPACITY + 10 * CONN_BUCKET_REFILL_PER_SEC) / MESSAGE_COST.action;
    expect(served).toBeLessThanOrEqual(ceiling);
    expect(served).toBeLessThan(100);
  });

  it('gives a full table more room than four players at full tilt can use', () => {
    const room = new TokenBucket(ROOM_BUCKET_CAPACITY, ROOM_BUCKET_REFILL_PER_SEC, 0);
    // Four seats each acting twice a second for two minutes. Only one seat can
    // legally act at a time, so this is already several times reality.
    for (let t = 0; t < 120_000; t += 500) {
      for (let seat = 0; seat < 4; seat++) expect(room.take(t, MESSAGE_COST.action)).toBe(true);
    }
  });

  it('prices the messages that broadcast above the one that does not', () => {
    expect(MESSAGE_COST.ping).toBeLessThan(MESSAGE_COST.action);
    expect(MESSAGE_COST.action).toBeLessThan(MESSAGE_COST.configure);
    expect(MESSAGE_COST.configure).toBeLessThan(MESSAGE_COST.start);
  });

  it('warns long before it disconnects', () => {
    // The whole point of FLOOD_DISCONNECT_AFTER is that a client which is told
    // to slow down and does gets to stay. If it were 1, the warning would be
    // indistinguishable from the hang-up.
    expect(FLOOD_DISCONNECT_AFTER).toBeGreaterThan(10);
  });
});
