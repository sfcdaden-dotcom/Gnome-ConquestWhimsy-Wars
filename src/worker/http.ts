/**
 * Small HTTP helpers the router and the route handlers share: JSON answers,
 * per-IP rate limiting, and reading a JSON request body under a size cap.
 *
 * Nothing here knows about routes, sessions or rooms.
 */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

/** A refusal: `{ "error": code }` and nothing else. */
export function refuse(status: number, code: string): Response {
  return json({ error: code }, status);
}

/**
 * The caller, for limiting purposes.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client —
 * unlike `X-Forwarded-For`, which is why that one is not consulted. If it is
 * somehow absent every such request shares one bucket, which is the safe way
 * round: unattributable traffic is limited together rather than not at all.
 */
export function callerKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unattributed';
}

/** True when this caller is over the limit. No binding means no limit. */
export async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

export function tooManyRequests(): Response {
  return json({ error: 'Too many requests' }, 429, { 'retry-after': '60' });
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

/**
 * How a route that takes a body declares it. `parse` is the schema check: it
 * gets the decoded JSON and returns the typed value, or `undefined` to refuse
 * it. It runs before the handler, so a handler only ever sees a valid body.
 */
export interface BodySpec<B> {
  maxBytes: number;
  parse(value: unknown): B | undefined;
}

export type BodyResult<B> = { ok: true; value: B } | { ok: false; response: Response };

/**
 * Read a JSON body: `application/json` only, at most `spec.maxBytes` bytes
 * (counted as they arrive, whatever `Content-Length` claims), then `spec.parse`.
 */
export async function readJsonBody<B>(request: Request, spec: BodySpec<B>): Promise<BodyResult<B>> {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { ok: false, response: refuse(415, 'UNSUPPORTED_MEDIA_TYPE') };

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > spec.maxBytes) {
    return { ok: false, response: refuse(413, 'BODY_TOO_LARGE') };
  }

  const bytes = await readCapped(request, spec.maxBytes);
  if (bytes === null) return { ok: false, response: refuse(413, 'BODY_TOO_LARGE') };

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, response: refuse(400, 'BAD_BODY') };
  }
  const value = spec.parse(decoded);
  if (value === undefined) return { ok: false, response: refuse(400, 'BAD_BODY') };
  return { ok: true, value };
}

/** The whole body, or null as soon as it passes `max` bytes. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
