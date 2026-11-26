import test from 'node:test';
import assert from 'node:assert/strict';
import { MabrRouteProxy, contentTypeFor, normalizeKey, respond } from './index.ts';

const hit = { body: Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9).buffer as ArrayBuffer, type: 'video/mp4' };
const get = (range?: string, extra: Partial<Parameters<typeof respond>[1]> = {}) => respond(hit, { method: 'GET', range, ...extra });

test('range requests: a-b, a-, -n, clamp, 416, multi-range and If-Range → 200', () => {
  assert.equal(get('bytes=2-4').status, 206);
  assert.equal(get('bytes=2-4').headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(get('bytes=8-').headers.get('content-range'), 'bytes 8-9/10');
  assert.equal(get('bytes=-3').headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(get('bytes=5-99').headers.get('content-range'), 'bytes 5-9/10');
  for (const ignored of ['bytes=4-2', 'bytes=-', 'items=1-2', 'bytes=a-b']) assert.equal(get(ignored).status, 200, ignored);
  for (const bad of ['bytes=10-', 'bytes=-0']) {
    const r = get(bad);
    assert.equal(r.status, 416, bad);
    assert.equal(r.headers.get('content-range'), 'bytes */10');
  }
  assert.equal(get('bytes=0-1,4-5').status, 200);
  assert.equal(get('bytes=2-4', { ifRange: '"etag"' }).status, 200);
  const head = respond(hit, { method: 'HEAD', range: 'bytes=2-4' });
  assert.deepEqual([head.status, head.body, head.headers.get('content-length')], [206, null, '3']);
});

test('content type and key normalization', () => {
  assert.equal(contentTypeFor('https://h/a.m4a'), 'audio/mp4');
  assert.equal(contentTypeFor('https://h/a.vtt?x=1'), 'text/vtt');
  assert.equal(contentTypeFor('https://h/a.m4s'), 'video/mp4');
  assert.equal(normalizeKey('/a/b.m4s?t=1#frag', 'https://h/x/'), 'https://h/a/b.m4s?t=1');
});

test('missing objects fall through to the network; malformed Content-Location and out-of-scope are counted, not served', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL) => { calls.push(String(i)); return new Response('net'); }) as typeof fetch;
  try {
    const proxy = new MabrRouteProxy({ baseUrl: 'https://p.test/live/' });
    assert.equal(await (await proxy.fetch('https://p.test/live/none.m4s')).text(), 'net');
    assert.equal(proxy.put({ url: 'https://evil.test/live/a.m4s', data: Uint8Array.of(1) }), undefined);
    assert.throws(() => proxy.put({ url: 'http://[bad', data: Uint8Array.of(1) }));
    proxy.noteDrop('integrity');
    assert.deepEqual([proxy.stats.misses, proxy.stats.drops['out-of-scope'], proxy.stats.drops.integrity], [1, 1, 1]);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('late object inside lookupWaitMs is a late-hit; past it falls through; out-of-scope never waits', async () => {
  const events: { outcome: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('net')) as typeof fetch;
  try {
    const proxy = new MabrRouteProxy({ baseUrl: 'https://p.test/live/', lookupWaitMs: 100, onCacheEvent: (e) => events.push(e) });
    const pending = proxy.fetch('https://p.test/live/late.m4s');
    setTimeout(() => proxy.put({ url: 'late.m4s', data: Uint8Array.of(7) }), 10);
    assert.equal((await pending).status, 200);
    assert.equal((await (await proxy.fetch('https://p.test/live/never.m4s')).text()), 'net');
    const t = Date.now();
    await proxy.fetch('https://other.test/x.m4s');
    assert.ok(Date.now() - t < 50);
    assert.deepEqual(events.map((e) => e.outcome), ['late-hit', 'miss', 'miss']);
    assert.equal(proxy.stats.lateHits, 1);
    assert.throws(() => new MabrRouteProxy({ lookupWaitMs: 251 }));
  } finally { globalThis.fetch = original; }
});

test('byte bound evicts oldest, rejects oversize objects, and tracks bytes', () => {
  const proxy = new MabrRouteProxy({ baseUrl: 'https://p.test/', maxBytes: 10, maxObjectBytes: 8 });
  proxy.put({ url: 'a', data: new Uint8Array(6) });
  proxy.put({ url: 'b', data: new Uint8Array(6) });
  assert.deepEqual([proxy.size, proxy.stats.bytes, proxy.stats.drops.evicted], [1, 6, 1]);
  assert.equal(proxy.put({ url: 'c', data: new Uint8Array(9) }), undefined);
  assert.equal(proxy.stats.drops['over-budget'], 1);
  proxy.delete('b');
  assert.equal(proxy.stats.bytes, 0);
});
