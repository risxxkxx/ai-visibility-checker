/**
 * CORS for the public endpoints: only origins from PUBLIC_ALLOWED_ORIGINS, reflected back with
 * Vary: Origin. No credentials. Anything else (including requests without an Origin) gets 403.
 */

export const CORS_METHODS = 'POST, OPTIONS';
export const CORS_HEADERS = 'content-type';

const base = { 'cache-control': 'no-store', vary: 'Origin' } as const;

export type CorsResult = { ok: true; headers: Record<string, string> } | { ok: false; response: Response };

export function checkOrigin(req: Request, allowed: string[]): CorsResult {
  const origin = req.headers.get('origin');
  if (!origin || !allowed.includes(origin)) {
    return { ok: false, response: Response.json({ error: 'Origin not allowed.', code: 'origin_not_allowed' }, { status: 403, headers: base }) };
  }
  return { ok: true, headers: { ...base, 'access-control-allow-origin': origin } };
}

/** Answers an OPTIONS preflight: 204 for allowed origins, 403 otherwise. */
export function preflight(req: Request, allowed: string[]): Response {
  const cors = checkOrigin(req, allowed);
  if (!cors.ok) return cors.response;
  return new Response(null, {
    status: 204,
    headers: {
      ...cors.headers,
      'access-control-allow-methods': CORS_METHODS,
      'access-control-allow-headers': CORS_HEADERS,
      'access-control-max-age': '600',
    },
  });
}

export const jsonWith =
  (headers: Record<string, string>) =>
  (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers: { ...headers, ...extra } });
