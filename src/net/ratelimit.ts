/**
 * What one client — and one room — is allowed to cost the server.
 *
 * Until this file existed, a connected client could send as fast as it liked.
 * Nothing it sent could make the room do something *wrong* (the seat check and
 * the engine see to that), but wrong was never the worry: every message costs a
 * parse, most cost an `applyAction`, and the ones that land cost a storage
 * write plus one send per connection in the room. That last part is the sharp
 * end — a message in is N messages out — so an unlimited sender is an
 * amplifier, and the only fix is to stop reading.
 *
 * TOKEN BUCKETS, on two scopes.
 *
 *  - **Per connection.** The budget one client gets. Sized so that a human
 *    playing as fast as a human can click never sees it, and a script cannot
 *    hold the room's event loop.
 *  - **Per room.** The budget *everyone together* gets. This is the one that
 *    actually bounds the work, because a determined client can always open more
 *    sockets: per-connection limits multiply by the number of connections, and
 *    only a room-wide ceiling does not. It is set well above what a full table
 *    of humans can produce, so in practice it bites on abuse alone.
 *
 * A bucket, rather than a fixed window: play is bursty (a card with three
 * targets is three actions in a second and a half) and a fixed window either
 * has to be sized for the burst — in which case it permits that burst
 * *continuously* — or it clips honest play. A bucket separates the two
 * questions, `capacity` answering "how much at once" and `refillPerSecond`
 * answering "how much forever".
 *
 * DELIBERATELY IN MEMORY. Buckets are never persisted. Writing one to storage
 * per message would cost more than the messages we are defending against, and
 * the failure mode of losing them is that a room evicted from memory forgives
 * whatever a flooder had spent — which requires the flooder to have stopped
 * sending for long enough to let the room hibernate, i.e. to have stopped being
 * a flooder. The hard cap on concurrent connections (`MAX_CONNECTIONS`) is what
 * covers the case buckets cannot: it is a property of the room's live socket
 * set, so it survives being forgotten.
 */

import type { ClientMessage } from './protocol';

/**
 * A classic token bucket. `capacity` tokens to spend at once, refilling at
 * `refillPerSecond` and never past capacity.
 *
 * Time arrives as an argument rather than being read from a clock, because
 * every other timer in the room takes it from `RoomHost.now()` — which is what
 * lets the tests drive a minute of flooding without waiting a minute.
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  private tokens: number;
  private last: number;

  constructor(capacity: number, refillPerSecond: number, now: number) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.last = now;
  }

  /**
   * Spend `cost` if it is there. Returns false — and spends nothing — when it
   * is not: a request that cannot be afforded is refused whole rather than
   * partially charged, so a run of unaffordable messages cannot keep the bucket
   * pinned at empty for a cheaper message that arrives behind them.
   */
  take(now: number, cost: number): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Tokens available as of `now`. For tests and for reasoning about budgets. */
  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }

  private refill(now: number): void {
    // A clock that goes backwards (it does happen) must not mint tokens.
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
  }
}

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/**
 * What each kind of message costs to serve, in tokens.
 *
 * Weighted rather than flat, because the messages differ by more than an order
 * of magnitude in what they ask for:
 *
 *  - `ping` is answered with `pong` and touches nothing. A real client sends
 *    one every 45 seconds to keep middleboxes from reaping the socket.
 *  - `action` runs the engine, appends to the record, writes storage, and
 *    sends a separately-redacted state to every connection. It is also the
 *    only one a client sends in bulk, so its cost sets the sustained rate.
 *  - `configure` rewrites the lobby and broadcasts it. Cheaper than an action
 *    (no engine, no record) but a host toggling seats does it in bursts.
 *  - `start` deals a whole game: a `createGame`, a seal, a full broadcast.
 *  - `hello` re-settles identity, reseats spectators, writes storage and
 *    broadcasts. A legitimate client sends exactly one per connection, so the
 *    price is set to make repeats pointless rather than to leave room for them.
 */
export const MESSAGE_COST: Record<ClientMessage['t'], number> = {
  ping: 1,
  action: 2,
  configure: 4,
  start: 10,
  hello: 10,
};

/**
 * One connection's burst and sustained budget.
 *
 * 60 tokens is 30 actions back to back; 10/s is 5 actions per second forever.
 * A human clicking through a three-target card play produces perhaps four
 * actions in a second and then thinks for several, so honest play never
 * approaches this — while a script is held to five engine calls a second,
 * which the room can serve indefinitely without noticing.
 */
export const CONN_BUCKET_CAPACITY = 60;
export const CONN_BUCKET_REFILL_PER_SEC = 10;

/**
 * The whole room's budget, across every connection in it.
 *
 * Four seated players at full tilt come to ~20 tokens a second, so 40/s leaves
 * honest play a factor of two of headroom and still bounds the room's total
 * work no matter how many sockets are pointed at it.
 *
 * The trade-off is deliberate and worth stating: a flooder inside a room can
 * degrade that room for the people in it. A room is a private table you shared
 * a code with, so the blast radius is your own guests; and the alternative to a
 * shared ceiling is not "nobody is affected", it is unbounded work, which
 * degrades the room anyway and everyone else's besides.
 */
export const ROOM_BUCKET_CAPACITY = 240;
export const ROOM_BUCKET_REFILL_PER_SEC = 40;

/**
 * Concurrent connections one room will hold.
 *
 * Broadcast is O(connections), so this is the multiplier on every action in the
 * game — and the ceiling on how far a client can multiply its own per-connection
 * budget by opening more sockets. Generous for the thing it is: a table seats
 * two or four, and everyone else is watching.
 *
 * Connections presenting a token the room already knows are exempt. A player
 * coming back to their seat is never turned away by a crowd, and the exemption
 * cannot be used to get past the cap: one token holds one live connection, and
 * a second presenting it takes the first's place rather than joining it.
 */
export const MAX_CONNECTIONS = 24;

/**
 * How many of a connection's own messages the room will drop before it stops
 * reading the socket altogether.
 *
 * A client that is told to slow down and does not is not going to; past this
 * point the cheap-but-not-free parse is the only cost left, and closing is the
 * only way to stop paying it. Set well above any plausible overshoot by a
 * client that *does* back off — one warning and a pause clears it.
 *
 * Only a connection's OWN bucket counts toward this. Messages dropped because
 * the ROOM's bucket was empty are somebody else's fault, and disconnecting the
 * bystanders of a flood would hand any flooder the room.
 */
export const FLOOD_DISCONNECT_AFTER = 60;
