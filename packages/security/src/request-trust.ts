// Request trust primitives (errata G-6 / SR-10 / SR-02, Phase 1 13 ST-12 / ST-27).
// - Client IP: `api` never trusts X-Forwarded-For. It accepts a signed `X-Client-IP` header only from the BFF's
//   mTLS identity; otherwise it uses the socket peer.
// - CSRF: synchronizer token derived from the session id with a server key (no per-session storage).
import { isIP } from 'node:net';
import { assertKey, constantTimeEqual, hmacSha256 } from './hashing.ts';

export const CLIENT_IP_HEADER = 'x-client-ip';
const MAX_HEADER_AGE_SEC = 30;

export function signClientIp(key: Uint8Array, ip: string, now: Date): string {
  assertKey(key, 'client-IP header key');
  if (isIP(ip) === 0) throw new Error('not an IP address');
  const ts = Math.floor(now.getTime() / 1000);
  return `v1.${ts}.${ip}.${hmacSha256(key, `v1|${ts}|${ip}`).toString('base64url')}`;
}

/** Returns the signed IP, or undefined when the header is missing, stale, malformed or forged. */
export function verifyClientIpHeader(key: Uint8Array, header: string | undefined, now: Date): string | undefined {
  if (!header || header.length > 200) return undefined;
  const m = /^v1\.(\d{1,12})\.([0-9A-Fa-f:.]{2,45})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!m) return undefined;
  const [ts = '', ip = '', mac = ''] = m.slice(1);
  if (isIP(ip) === 0) return undefined;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(ts)) > MAX_HEADER_AGE_SEC) return undefined;
  const expected = hmacSha256(key, `v1|${ts}|${ip}`);
  return constantTimeEqual(expected, Buffer.from(mac, 'base64url')) ? ip : undefined;
}

export interface InboundConnection {
  /** Socket peer address as seen by this process. */
  readonly peerAddress: string;
  /** Verified mTLS client identity (e.g. "web-bff"), undefined for plain connections. */
  readonly peerIdentity?: string | undefined;
  /** Lower-cased request headers. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/** The client IP used for rate limits and audit (SR-10). X-Forwarded-For is never consulted. */
export function resolveClientIp(conn: InboundConnection, opts: { readonly trustedPeer: string; readonly headerKey: Uint8Array; readonly now: Date }): string {
  if (conn.peerIdentity === opts.trustedPeer) {
    const signed = verifyClientIpHeader(opts.headerKey, conn.headers[CLIENT_IP_HEADER], opts.now);
    if (signed) return signed;
  }
  return conn.peerAddress;
}

export function csrfToken(key: Uint8Array, sessionId: string): string {
  assertKey(key, 'CSRF key');
  return hmacSha256(key, `csrf|${sessionId}`).toString('base64url');
}

export function verifyCsrfToken(key: Uint8Array, sessionId: string, presented: string | undefined): boolean {
  if (!presented || presented.length > 100) return false;
  return constantTimeEqual(Buffer.from(csrfToken(key, sessionId)), Buffer.from(presented));
}
