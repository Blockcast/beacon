/**
 * Pure HTTP answer for a ROUTE object. No globals, so the page proxy, a
 * Service Worker and a native local-origin server share identical semantics.
 */

export interface RouteReply {
  status: 200 | 206 | 416;
  headers: Headers;
  body: ArrayBuffer | null;
}

const TYPES: Record<string, string> = {
  mpd: 'application/dash+xml', m3u8: 'application/vnd.apple.mpegurl',
  m4a: 'audio/mp4', cmfa: 'audio/mp4', aac: 'audio/aac',
  vtt: 'text/vtt', ts: 'video/mp2t', webm: 'video/webm',
};

/** FDT type wins; otherwise by suffix; never empty. shortcut: unknown suffixes assume video/mp4 (CMAF), extend the map as needed. */
export function contentTypeFor(url: string): string {
  const ext = /\.([a-z0-9]+)$/.exec(new URL(url).pathname.toLowerCase())?.[1] ?? '';
  return TYPES[ext] ?? 'video/mp4';
}

/** Cache key: absolute URL without fragment. Queries are kept (identity includes them). */
export function normalizeKey(url: string, base: string): string {
  const u = new URL(url, base);
  u.hash = '';
  return u.href;
}

/** Single-range per RFC 9110; multi-range and If-Range (no validators) are ignored → 200. */
export function respond(
  hit: { body: ArrayBuffer; type: string },
  req: { method: string; range?: string | null; ifRange?: string | null },
): RouteReply {
  const size = hit.body.byteLength;
  const head = req.method === 'HEAD';
  const headers = new Headers({
    'content-type': hit.type, 'cache-control': 'no-store',
    'accept-ranges': 'bytes', 'content-length': String(size),
  });
  const full = (): RouteReply => ({ status: 200, headers, body: head ? null : hit.body.slice(0) });
  const unsatisfiable = (): RouteReply => {
    headers.set('content-range', `bytes */${size}`);
    return { status: 416, headers, body: null };
  };
  const range = req.range?.trim();
  if (!range || req.ifRange) return full();
  if (range.includes(',')) return full();
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  // RFC 9110 §14.2: unknown unit or invalid syntax is ignored (200); only a valid-but-unsatisfiable range is 416.
  if (!m || (m[1] === '' && m[2] === '')) return full();
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return unsatisfiable();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? Infinity : Number(m[2]);
    if (!Number.isSafeInteger(start) || (m[2] !== '' && (!Number.isSafeInteger(end) || start > end))) return full();
    if (start >= size) return unsatisfiable();
    end = Math.min(end, size - 1);
  }
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  headers.set('content-length', String(end - start + 1));
  return { status: 206, headers, body: head ? null : hit.body.slice(start, end + 1) };
}
