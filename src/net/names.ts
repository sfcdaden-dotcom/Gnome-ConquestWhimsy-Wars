/**
 * Seat names, made safe to store and show.
 *
 * A name reaches every screen in the room, the game log, the TV board view and
 * the revealed match record, so what it can carry matters even though React
 * escapes it (there is no XSS here — the risk is spoofing). The room used to
 * cap names at 24 UTF-16 units and nothing else, which let through:
 *
 *  - control characters, NUL included;
 *  - bidi overrides and isolates, which reorder how the rest of a line reads;
 *  - zero-width and other invisible format characters, which make two names
 *    that look identical different strings;
 *  - and a cap that could cut an emoji in half, leaving a lone surrogate.
 *
 * What this deliberately does NOT do is restrict the script or fold
 * lookalikes: a guest may call themselves "Мишка" or "🍄 Mo". Those rules are
 * for account usernames, which are a different thing (see ACCOUNTS.md §8.1).
 */

/** The longest seat name, in code points (what a player would call characters). */
export const SEAT_NAME_MAX = 24;

/**
 * Control (Cc), format (Cf — bidi controls, zero-width characters, BOM, soft
 * hyphen), private-use (Co) and unassigned (Cn) code points, plus the line and
 * paragraph separators. None of them belongs in a name.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu;

/**
 * The name to store for a seat, or null when `value` yields no usable name —
 * not a string, or nothing left once cleaned. Callers keep the seat's current
 * name on null rather than storing an empty one.
 */
export function sanitizeSeatName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
  // By code point, so a surrogate pair is never split at the boundary.
  const capped = Array.from(cleaned).slice(0, SEAT_NAME_MAX).join('').trim();
  return capped.length > 0 ? capped : null;
}
