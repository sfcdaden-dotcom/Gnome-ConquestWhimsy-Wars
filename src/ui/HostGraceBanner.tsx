/**
 * The countdown on a lobby whose host has dropped.
 *
 * Two things make this worth its own component. It ticks, so it needs a timer
 * the rest of the lobby does not want; and it is deliberately LATE — a reload
 * drops the socket for about a second, and the most ordinary thing a waiting
 * host does is reload, so announcing every absence would turn a non-event into
 * a crisis. The room starts counting at the disconnect; only the telling waits
 * (HOST_ABSENCE_BANNER_MS).
 *
 * The remaining time is computed against the server's clock, the same way the
 * shot clock is: `until` and `now` both come from the room, so the two
 * machines disagreeing about the time of day cannot show a wrong number.
 */

import { useEffect, useState } from 'react';
import type { HostGrace } from '../net/protocol';
import { HOST_ABSENCE_BANNER_MS, HOST_GRACE_MS } from '../net/protocol';

/** mm:ss, floored, never negative. */
function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function HostGraceBanner({ grace, hostName }: { grace: HostGrace; hostName: string | null }) {
  // The offset between this browser's clock and the room's, measured once per
  // snapshot. Everything below is rendered from local time plus this.
  const [skew] = useState(() => grace.now - Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  const remaining = grace.until - (Date.now() + skew);
  const elapsed = HOST_GRACE_MS - remaining;
  // Still inside the quiet window: the host is probably mid-reload.
  if (elapsed < HOST_ABSENCE_BANNER_MS) return null;

  return (
    <div className="lobby-grace" role="status" data-testid="lobby-grace">
      <strong>{hostName ?? 'The host'} disconnected.</strong>{' '}
      <span data-testid="lobby-grace-countdown">
        {remaining > 0
          ? `Waiting ${countdown(remaining)} for them to come back.`
          : 'Handing the room over…'}
      </span>
    </div>
  );
}
