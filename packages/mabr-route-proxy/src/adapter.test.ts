import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { MabrRouteProxy, type TransparentPolicy } from './proxy.ts';
import { installTransparentAdapter, type AdapterGlobal, type TransparentAdapterOptions } from './adapter.ts';
import { createRouteMabrSession } from './route.ts';

const DS = 'https://ds.example';
const MPD = '<MPD><SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4"/></MPD>';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(policy: TransparentPolicy = { unauthenticatedSegments: [DS] }, options: TransparentAdapterOptions = {},
  page = { href: `${DS}/page.html`, origin: DS }, proxyOptions: { scope?: string; onCacheEvent?: (event: unknown) => void } = {}) {
  const proxy = new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/live/`, transparent: policy, ...proxyOptions });
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const net = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const url = input instanceof Request ? input.url : String(input);
    return url.endsWith('.mpd') ? new Response(MPD, { headers: { 'content-type': 'application/dash+xml' } }) : new Response(`net:${url}`);
  };
  const g: AdapterGlobal = { fetch: net as typeof fetch, location: page };
  const adapter = installTransparentAdapter(proxy, { global: g, ...options });
  return { proxy, g, calls, adapter };
}
async function trusted(s: ReturnType<typeof setup>) {
  await s.g.fetch(`${DS}/live/manifest.mpd`);
  await tick();
  s.calls.length = 0;
}
const text = async (promise: Promise<Response>) => (await promise).text();
const seg = (n: number) => `${DS}/live/seg-${n}.m4s`;

test('adapter: serves a DASH and an HLS segment from ROUTE without installFetch()', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1, 2, 3), contentType: 'video/mp4' });
  s.proxy.put({ url: 'live/hls-1.m4s', data: Uint8Array.of(4, 5), contentType: 'video/mp4' });
  await trusted(s);
  assert.deepEqual([...new Uint8Array(await (await s.g.fetch(seg(1))).arrayBuffer())], [1, 2, 3]);
  const hls = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nhls-1.m4s\n';
  s.proxy.trustManifest(`${DS}/live/media.m3u8`, new TextEncoder().encode(hls));
  assert.equal((await s.g.fetch(`${DS}/live/hls-1.m4s`)).status, 200);
  assert.equal(s.calls.length, 0);
  assert.equal(s.proxy.stats.hits, 2);
  assert.equal(s.adapter.status().hits, 2);
});

test('adapter: refuses to derive scope from an SLS-carried manifest location', async () => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const encoder = new TextEncoder();
  const put = (offset: number, value: string) => { new Uint8Array(memory.buffer, offset, value.length).set(encoder.encode(value)); return offset; };
  const location = 'live/manifest.mpd';
  const wasm = { exports: {
    memory, route_get_buffer: () => 0, route_get_buffer_size: () => 128, route_process_udp: () => {},
    route_get_completed_count: () => 0, route_sls_manifest_count: () => 1,
    route_sls_manifest: () => put(512, MPD), route_sls_manifest_len: () => MPD.length,
    route_sls_manifest_location: () => put(1024, location), route_sls_manifest_location_len: () => location.length,
  } };
  let deliver: ((event: CustomEvent<ArrayBuffer>) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${DS}/slt/`) return new Response('<a href="7">7</a>');
    if (url === `${DS}/slt/7`) return new Response('<SLT><Service globalServiceID="svc"><BroadcastSvcSignaling slsProtocol="1" slsDestinationIpAddress="232.1.1.1" slsDestinationUdpPort="1025" /></Service></SLT>');
    return new Response('network');
  }) as typeof fetch;
  try {
    const session = createRouteMabrSession({
      gateway: { async subscribe() { return { addEventListener(_t: 'bytes', cb: (e: CustomEvent<ArrayBuffer>) => void) { deliver = cb; }, removeEventListener() {}, async unsubscribe() {} }; } },
      wasm, ingress: 'native', sltUrl: DS, serviceId: 'svc', transparent: {},
    });
    await session.start();
    deliver?.({ detail: Uint8Array.of(1).buffer } as CustomEvent<ArrayBuffer>);
    assert.equal(session.manifestUrl, undefined, 'scope must not come from a multicast manifest location');
    assert.equal(session.size, 0);
    await session.stop();
  } finally { globalThis.fetch = originalFetch; }
});

test('adapter: control paths inside scope are never answered from ROUTE', async () => {
  const s = setup({ unauthenticatedSegments: [DS], controlPaths: ['/live/license'] });
  s.proxy.put({ url: `${DS}/live/license/key.mp4`, data: Uint8Array.of(9), contentType: 'video/mp4' });
  assert.equal(s.proxy.size, 0);
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  s.proxy.trustManifest(`${DS}/live/m.m3u8`, new TextEncoder().encode('#EXTM3U\nlicense/key.mp4\nseg-1.m4s\n'));
  await trusted(s);
  assert.equal(await text(s.g.fetch(`${DS}/live/license/key.mp4`)), `net:${DS}/live/license/key.mp4`);
  // the scope itself may be neither an origin root nor /slt/
  assert.throws(() => new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/`, transparent: {} }), RangeError);
  assert.throws(() => new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/slt/x/`, transparent: {} }), RangeError);
});

test('adapter: drops objects received before scope is established', async () => {
  const proxy = new MabrRouteProxy({ transparent: { unauthenticatedSegments: [DS] } });
  assert.equal(proxy.put({ url: 'live/seg-1.m4s', data: Uint8Array.of(1), contentType: 'video/mp4' }), undefined);
  assert.equal(proxy.size, 0);
  // both session store paths funnel through put(): SLS parts and FDT objects
  const memory = new WebAssembly.Memory({ initial: 2 });
  const encoder = new TextEncoder();
  const put = (offset: number, value: string) => { new Uint8Array(memory.buffer, offset, value.length).set(encoder.encode(value)); return offset; };
  let popped = 0;
  const wasm = { exports: {
    memory, route_get_buffer: () => 0, route_get_buffer_size: () => 128, route_process_udp: () => {},
    route_get_completed_count: () => 1 - popped, route_pop_completed_tsi: () => 1n, route_pop_completed_toi: () => 1n,
    route_pop_completed_len: () => 1, route_pop_completed_data: () => put(256, 'x'),
    route_pop_completed_type: () => put(300, 'video/mp4'), route_pop_completed_type_len: () => 9,
    route_pop_completed_location: () => put(400, 'live/fdt.m4s'), route_pop_completed_location_len: () => 12,
    route_pop_completed_codepoint: () => 8, route_pop_completed_integrity: () => 100,
    route_pop_completed_advance: () => { popped++; },
    route_sls_manifest_count: () => 1, route_sls_manifest: () => put(512, 'x'), route_sls_manifest_len: () => 1,
    route_sls_manifest_location: () => put(600, 'live/sls-part.m4s'), route_sls_manifest_location_len: () => 17,
  } };
  let deliver: ((event: CustomEvent<ArrayBuffer>) => void) | undefined;
  const session = createRouteMabrSession({
    gateway: { async subscribe() { return { addEventListener(_t: 'bytes', cb: (e: CustomEvent<ArrayBuffer>) => void) { deliver = cb; }, removeEventListener() {}, async unsubscribe() {} }; } },
    wasm, group: '232.1.1.1', port: 8000, transparent: {},
  });
  await session.start();
  deliver?.({ detail: Uint8Array.of(1).buffer } as CustomEvent<ArrayBuffer>);
  assert.equal(session.size, 0);
  await session.stop();
});

test('adapter: non-media destinations always reach the network', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  s.proxy.put({ url: seg(2), data: Uint8Array.of(2), contentType: 'text/html' });
  await trusted(s);
  class ScriptRequest extends Request { get destination(): RequestDestination { return 'script'; } }
  assert.equal(await text(s.g.fetch(new ScriptRequest(seg(1)))), `net:${seg(1)}`);
  assert.equal(await text(s.g.fetch(seg(2))), `net:${seg(2)}`, 'a stored text/html object is not media');
  assert.equal((await s.g.fetch(seg(1))).status, 200);
  assert.equal(s.proxy.stats.hits, 1);
});

test('adapter: a served segment is not replaced by a later injected object', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  assert.deepEqual([...new Uint8Array(await (await s.g.fetch(seg(1))).arrayBuffer())], [1]);
  s.proxy.put({ url: seg(1), data: Uint8Array.of(66), contentType: 'video/mp4' });
  assert.deepEqual([...new Uint8Array(await (await s.g.fetch(seg(1))).arrayBuffer())], [1]);
});

test('adapter: oversized and over-budget objects are dropped', () => {
  const proxy = new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/live/`, transparent: { maxEntryBytes: 10, maxTotalBytes: 15 } });
  const put = (n: number, size: number) => proxy.put({ url: seg(n), data: new Uint8Array(size), contentType: 'video/mp4' });
  assert.equal(put(1, 11), undefined);
  assert.ok(put(2, 8));
  assert.equal(put(3, 8), undefined, 'would exceed the 15 byte total');
  assert.equal(proxy.size, 1);
  proxy.delete(seg(2));
  assert.ok(put(3, 8), 'freed bytes are reusable');
});

test('adapter: no-store and reload bypass ROUTE', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  assert.equal(await text(s.g.fetch(seg(1), { cache: 'no-store' })), `net:${seg(1)}`);
  assert.equal(await text(s.g.fetch(seg(1), { cache: 'reload' })), `net:${seg(1)}`);
  assert.equal(s.proxy.stats.hits, 0);
});

test('adapter: default mode loads the manifest over unicast', async () => {
  const s = setup();
  s.proxy.put({ url: `${DS}/live/manifest.mpd`, data: new TextEncoder().encode('<MPD id="injected"/>'), contentType: 'application/dash+xml' });
  assert.equal(await text(s.g.fetch(`${DS}/live/manifest.mpd`)), MPD);
  assert.equal(s.calls.length, 1);
});

test('adapter: trusts a unicast HLS manifest before its segment request', async () => {
  const hls = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nhls-1.m4s\n';
  const proxy = new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/live/`, transparent: { unauthenticatedSegments: [DS] } });
  const calls: string[] = [];
  const g: AdapterGlobal = {
    location: { href: `${DS}/page.html`, origin: DS },
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(hls, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }) as typeof fetch,
  };
  const adapter = installTransparentAdapter(proxy, { global: g });
  proxy.put({ url: `${DS}/live/init.mp4`, data: Uint8Array.of(1), contentType: 'video/mp4' });
  proxy.put({ url: `${DS}/live/hls-1.m4s`, data: Uint8Array.of(2), contentType: 'video/mp4' });
  await g.fetch(`${DS}/live/media.m3u8`);
  assert.equal((await g.fetch(`${DS}/live/hls-1.m4s`)).status, 200);
  assert.deepEqual(calls, [`${DS}/live/media.m3u8`]);
  adapter.restore();
});

test('adapter: unverified multicast manifest falls through to unicast', async () => {
  const injected = new TextEncoder().encode('<MPD id="injected"/>');
  let verdict = false;
  const s = setup({ unauthenticatedSegments: [DS], verifyManifest: () => verdict });
  s.proxy.put({ url: `${DS}/live/manifest.mpd`, data: injected, contentType: 'application/dash+xml' });
  assert.equal(await text(s.g.fetch(`${DS}/live/manifest.mpd`)), MPD);
  verdict = true;
  assert.equal(await text(s.g.fetch(`${DS}/live/manifest.mpd`)), '<MPD id="injected"/>');
});

test('adapter: segments not named by the trusted manifest are not served', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  s.proxy.put({ url: `${DS}/live/evil.m4s`, data: Uint8Array.of(6), contentType: 'video/mp4' });
  assert.equal(await text(s.g.fetch(seg(1))), `net:${seg(1)}`, 'no trusted manifest yet');
  await trusted(s);
  assert.equal((await s.g.fetch(seg(1))).status, 200);
  assert.equal(await text(s.g.fetch(`${DS}/live/evil.m4s`)), `net:${DS}/live/evil.m4s`);
});

test('adapter: unauthenticated-segments mode is off by default', async () => {
  const s = setup({});
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  assert.equal(await text(s.g.fetch(seg(1))), `net:${seg(1)}`);
  assert.equal(s.proxy.stats.hits, 0);
});

test('adapter: missing integrity export is treated as incomplete', async () => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const encoder = new TextEncoder();
  const put = (offset: number, value: string) => { new Uint8Array(memory.buffer, offset, value.length).set(encoder.encode(value)); return offset; };
  const build = () => {
    let popped = 0;
    return { exports: {
      memory, route_get_buffer: () => 0, route_get_buffer_size: () => 128, route_process_udp: () => {},
      route_get_completed_count: () => 1 - popped, route_pop_completed_tsi: () => 1n, route_pop_completed_toi: () => 1n,
      route_pop_completed_len: () => 1, route_pop_completed_data: () => put(256, 'x'),
      route_pop_completed_type: () => put(300, 'video/mp4'), route_pop_completed_type_len: () => 9,
      route_pop_completed_location: () => put(400, 'live/seg-1.m4s'), route_pop_completed_location_len: () => 14,
      route_pop_completed_codepoint: () => 8, route_pop_completed_advance: () => { popped++; },
    } };
  };
  const run = async (transparent?: TransparentPolicy) => {
    let deliver: ((event: CustomEvent<ArrayBuffer>) => void) | undefined;
    const session = createRouteMabrSession({
      gateway: { async subscribe() { return { addEventListener(_t: 'bytes', cb: (e: CustomEvent<ArrayBuffer>) => void) { deliver = cb; }, removeEventListener() {}, async unsubscribe() {} }; } },
      wasm: build(), group: '232.1.1.1', port: 8000, baseUrl: `${DS}/`, scope: `${DS}/live/`, ...(transparent ? { transparent } : {}),
    });
    await session.start();
    deliver?.({ detail: Uint8Array.of(1).buffer } as CustomEvent<ArrayBuffer>);
    const size = session.size;
    await session.stop();
    return size;
  };
  assert.equal(await run(), 1, 'control: the legacy path still treats a missing export as complete');
  assert.equal(await run({}), 0);
});

test('adapter: service worker scope equals the configured player path', { skip: 'mechanism not built: the Service Worker adapter is deferred by ADR 0001 (BLO-59455); R13 applies when it is added' }, () => {});

test('adapter: extension manifest requests no <all_urls> host permission', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const hosts = JSON.stringify([manifest.host_permissions, manifest.optional_host_permissions, manifest.content_scripts, manifest.permissions]);
  assert.ok(!hosts.includes('<all_urls>') && !hosts.includes('"*://*/*"') && !hosts.includes('"http://*/*"'));
  assert.deepEqual(manifest.host_permissions, []);
  assert.deepEqual(manifest.content_scripts, []);
});

test('adapter: unapproved origin cannot subscribe through the adapter', () => {
  const s = setup();
  assert.deepEqual(Object.keys(s.adapter).sort(), ['restore', 'status']);
  assert.equal('multicast' in s.g, false);
  assert.equal('subscribe' in s.proxy, false);
});

test('adapter: local proxy rejects foreign Host and Origin', { skip: 'mechanism not built: no local/native proxy is part of this adapter; R16 applies if one is added for browsers' }, () => {});

test('adapter: cross-origin no-cors and non-allowlisted cors requests reach the network', async () => {
  const page = { href: 'https://player.example/p.html', origin: 'https://player.example' };
  const s = setup({ unauthenticatedSegments: [DS] }, { corsOrigins: [DS] }, page);
  const cors = s.g.fetch;
  s.g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await cors(input, init);
    Object.defineProperty(response, 'type', { value: 'cors' });
    return response;
  }) as typeof fetch;
  s.adapter.restore();
  const adapter = installTransparentAdapter(s.proxy, { global: s.g, corsOrigins: [DS] });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await s.g.fetch(`${DS}/live/manifest.mpd`);
  await tick();
  s.calls.length = 0;
  assert.equal(await text(s.g.fetch(seg(1), { mode: 'no-cors' })), `net:${seg(1)}`);
  assert.equal(s.proxy.stats.hits, 0, 'no-cors is never answered');
  // the manifest fetch above was a successful cors response for (DS, player)
  assert.equal((await s.g.fetch(seg(1), { mode: 'cors' })).status, 200);
  adapter.restore();
  const other = setup({ unauthenticatedSegments: [DS] }, { corsOrigins: [] }, page);
  other.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await other.g.fetch(`${DS}/live/manifest.mpd`);
  await tick();
  assert.equal(await text(other.g.fetch(seg(1))), `net:${seg(1)}`, 'origin not on the allowlist');
  const fresh = setup({ unauthenticatedSegments: [DS] }, { corsOrigins: [DS] }, page);
  fresh.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  fresh.proxy.trustManifest(`${DS}/live/manifest.mpd`, new TextEncoder().encode(MPD));
  assert.equal(await text(fresh.g.fetch(seg(1))), `net:${seg(1)}`, 'no recorded CORS success for this initiator');
});

test('adapter: credentialed requests to gated paths reach the network', async () => {
  const s = setup({ unauthenticatedSegments: [DS] }, { gatedPaths: ['/live/gated/'], publicPaths: ['/live/seg-2'] });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  s.proxy.put({ url: seg(2), data: Uint8Array.of(2), contentType: 'video/mp4' });
  s.proxy.put({ url: `${DS}/live/gated/seg-3.m4s`, data: Uint8Array.of(3), contentType: 'video/mp4' });
  s.proxy.trustManifest(`${DS}/live/m.m3u8`, new TextEncoder().encode('#EXTM3U\nseg-1.m4s\nseg-2.m4s\ngated/seg-3.m4s\n'));
  assert.equal(await text(s.g.fetch(seg(1), { headers: { authorization: 'Bearer x' } })), `net:${seg(1)}`);
  assert.equal(await text(s.g.fetch(seg(1), { credentials: 'include' })), `net:${seg(1)}`);
  assert.equal((await s.g.fetch(seg(2), { credentials: 'include' })).status, 200, 'public path');
  assert.equal(await text(s.g.fetch(`${DS}/live/gated/seg-3.m4s`)), `net:${DS}/live/gated/seg-3.m4s`);
});

test('adapter: cache is partitioned by top-level site', async () => {
  let site = 'https://a.example';
  const s = setup({ unauthenticatedSegments: [DS] }, { topLevelSite: () => site });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  assert.equal((await s.g.fetch(seg(1))).status, 200);
  site = 'https://b.example';
  assert.equal(await text(s.g.fetch(seg(1))), `net:${seg(1)}`);
});

test('adapter: miss forwards the original request unchanged', async () => {
  const s = setup();
  const input = `${DS}/live/other.bin`;
  const init = { headers: { 'x-a': '1' }, referrerPolicy: 'no-referrer', credentials: 'include' } as RequestInit;
  await s.g.fetch(input, init);
  assert.equal(s.calls[0]![0], input);
  assert.equal(s.calls[0]![1], init);
  const request = new Request(seg(9), { method: 'POST', body: 'payload' });
  await s.g.fetch(request);
  assert.equal(s.calls[1]![0], request);
  assert.equal(request.bodyUsed, false, 'a body-carrying request is never consumed');
});

test('adapter: cache events are not delivered to other clients', async () => {
  const events: unknown[] = [];
  const s = setup({ unauthenticatedSegments: [DS] }, {}, undefined, { onCacheEvent: (event) => events.push(event) });
  await s.g.fetch(`${DS}/elsewhere/tracker.js`);
  await s.g.fetch(`${DS}/live/x`, { method: 'POST', body: 'b' });
  assert.deepEqual(events, [], 'foreign URLs and non-GET requests are never reported');
  await s.g.fetch(seg(5));
  assert.equal(events.length, 1);
});

test('adapter: forced failure still plays over unicast', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  const failing = { resolve: async () => { throw new Error('wasm trap'); }, trustManifest: () => { throw new Error('boom'); }, inScope: () => true };
  s.adapter.restore();
  const adapter = installTransparentAdapter(failing, { global: s.g });
  assert.equal(await text(s.g.fetch(seg(1))), `net:${seg(1)}`);
  assert.equal((await s.g.fetch(`${DS}/live/manifest.mpd`)).status, 200);
  await tick();
  assert.ok(adapter.status().errors >= 2, 'resolve and trustManifest faults are counted, not thrown');
});

test('adapter: sustained miss rate is reported', async () => {
  const downgrades: number[] = [];
  const s = setup({ unauthenticatedSegments: [DS] }, { window: 5, onDowngrade: (status) => downgrades.push(status.missRate) });
  for (let i = 0; i < 4; i++) await s.g.fetch(seg(i));
  assert.equal(s.adapter.status().degraded, false, 'window not full yet');
  await s.g.fetch(seg(4));
  assert.equal(s.adapter.status().degraded, true);
  assert.deepEqual(downgrades, [1]);
  await s.g.fetch(seg(5));
  assert.equal(downgrades.length, 1, 'reported once per transition');
});

test('adapter: injected manifest cannot redirect segments to another origin', async () => {
  const s = setup();
  const evil = 'https://evil.example/live/seg-1.m4s';
  const trust = s.proxy.trustManifest(`${DS}/live/m.mpd`, new TextEncoder().encode(
    `<MPD><BaseURL>https://evil.example/live/</BaseURL><SegmentTemplate media="seg-$Number$.m4s"/></MPD>`));
  assert.equal(trust, true);
  assert.equal(s.proxy.put({ url: evil, data: Uint8Array.of(6), contentType: 'video/mp4' }), undefined);
  assert.equal(await text(s.g.fetch(evil)), `net:${evil}`);
  assert.equal(s.proxy.stats.hits + s.proxy.stats.misses, 0, 'out-of-scope URLs are not even looked up');
  s.proxy.trustManifest(`${DS}/live/h.m3u8`, new TextEncoder().encode(`#EXTM3U\n${evil}\n`));
  assert.equal(await text(s.g.fetch(evil)), `net:${evil}`);
});

class FakeXhr extends EventTarget {
  static sent: Array<{ url: string; headers: Array<[string, string]> }> = [];
  withCredentials = false;
  responseType = '';
  status = 0;
  readyState = 0;
  static netBody = 'net';
  response: unknown = null;
  url = '';
  headers: Array<[string, string]> = [];
  open(_method: string, url: string) { this.url = url; this.headers = []; }
  setRequestHeader(name: string, value: string) { this.headers.push([name, value]); }
  getResponseHeader(): string | null { return null; }
  abort() { /* native: no-op while unsent */ }
  send() {
    FakeXhr.sent.push({ url: this.url, headers: this.headers });
    queueMicrotask(async () => {
      const blob = this.url.startsWith('blob:') ? resolveObjectURL(this.url) : undefined;
      this.response = blob ? await blob.text() : FakeXhr.netBody;
      if (!blob) this.status = 200;
      this.readyState = 4;
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    });
  }
}

test('adapter: xhr hit is served from ROUTE and a miss reaches the network', async () => {
  FakeXhr.sent = [];
  const s = setup();
  (s.g as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  s.adapter.restore();
  const adapter = installTransparentAdapter(s.proxy, { global: s.g });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(104, 105), contentType: 'video/mp4' });
  await trusted(s);
  const run = (url: string, headers: Array<[string, string]> = []) => new Promise<FakeXhr>((resolve) => {
    const xhr = new FakeXhr();
    xhr.addEventListener('loadend', () => resolve(xhr));
    xhr.open('GET', url);
    for (const [name, value] of headers) xhr.setRequestHeader(name, value);
    xhr.send();
  });
  const hit = await run(seg(1), [['Range', 'bytes=0-0']]);
  assert.equal(hit.response, 'h', 'range is applied once, by the resolver');
  assert.equal(hit.status, 206);
  assert.ok(FakeXhr.sent[0]!.url.startsWith('blob:'));
  assert.deepEqual(FakeXhr.sent[0]!.headers, [], 'no request header reaches the blob: loader');
  const miss = await run(`${DS}/live/other.bin`, [['X-A', '1']]);
  assert.equal(miss.response, 'net');
  assert.deepEqual(FakeXhr.sent[1], { url: `${DS}/live/other.bin`, headers: [['X-A', '1']] });
  const bypass = await run(seg(1), [['Cache-Control', 'no-cache']]);
  assert.equal(bypass.response, 'net', 'no-cache bypasses ROUTE');
  adapter.restore();
});

test('adapter: xhr abort during the ROUTE lookup cancels the request (hit and miss)', async () => {
  FakeXhr.sent = [];
  const s = setup();
  (s.g as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  s.adapter.restore();
  const adapter = installTransparentAdapter(s.proxy, { global: s.g });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(104, 105), contentType: 'video/mp4' });
  await trusted(s);
  for (const url of [seg(1), `${DS}/live/other.bin`]) {
    const xhr = new FakeXhr();
    let events = '';
    for (const t of ['abort', 'load', 'loadend']) xhr.addEventListener(t, () => { events += t + ' '; });
    xhr.open('GET', url);
    xhr.send();
    xhr.abort();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events, 'abort loadend ', `no load after abort: ${url}`);
  }
  assert.deepEqual(FakeXhr.sent, [], 'nothing was sent or resurrected');
  adapter.restore();
});

test('adapter: xhr aborted during lookup then re-sent completes once (hit and miss)', async () => {
  FakeXhr.sent = [];
  const s = setup();
  (s.g as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  s.adapter.restore();
  const adapter = installTransparentAdapter(s.proxy, { global: s.g });
  s.proxy.put({ url: seg(1), data: Uint8Array.of(104, 105), contentType: 'video/mp4' });
  await trusted(s);
  for (const url of [seg(1), `${DS}/live/other.bin`]) {
    FakeXhr.sent = [];
    const xhr = new FakeXhr();
    let loads = 0;
    xhr.addEventListener('load', () => { loads++; });
    xhr.open('GET', url); xhr.send(); xhr.abort();
    xhr.open('GET', url); xhr.send();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(loads, 1, `re-sent request loads once: ${url}`);
    assert.equal(FakeXhr.sent.length, 1, `exactly one request: ${url}`);
  }
  adapter.restore();
});

test('compat: injected in-scope object is not served', async () => {
  const s = setup();
  s.proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  await trusted(s);
  s.proxy.put({ url: seg(1), data: Uint8Array.of(7), contentType: 'video/mp4' });
  s.proxy.put({ url: `${DS}/live/ghost.m4s`, data: Uint8Array.of(8), contentType: 'video/mp4' });
  assert.deepEqual([...new Uint8Array(await (await s.g.fetch(seg(1))).arrayBuffer())], [1]);
  assert.equal(await text(s.g.fetch(`${DS}/live/ghost.m4s`)), `net:${DS}/live/ghost.m4s`);
});

test('adapter: HLS key and licence requests reach the network with their original arguments', async () => {
  const s = setup();
  const hls = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nhls-1.m4s\n';
  s.proxy.trustManifest(`${DS}/live/media.m3u8`, new TextEncoder().encode(hls));
  // Even if key bytes arrive on multicast, a manifest-named key is control-plane and never answered by ROUTE.
  s.proxy.put({ url: `${DS}/live/key.bin`, data: Uint8Array.of(7), contentType: 'application/octet-stream' });
  const keyInit = { headers: { authorization: 'Bearer t' }, credentials: 'include' } as RequestInit;
  assert.equal(await text(s.g.fetch(`${DS}/live/key.bin`, keyInit)), `net:${DS}/live/key.bin`);
  assert.equal(s.calls[0]![1], keyInit);
  const licence = new Request(`${DS}/live/license`, { method: 'POST', body: 'challenge' });
  await s.g.fetch(licence);
  assert.equal(s.calls[1]![0], licence);
  assert.equal(licence.bodyUsed, false);
  assert.equal(s.adapter.status().hits, 0);
});

test('adapter: a chunked manifest over the byte cap stops being read and is never trusted', async () => {
  const trustCalls: string[] = [];
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; pulled <= 16 ? c.enqueue(new Uint8Array(1 << 20)) : c.close(); } }, { highWaterMark: 0 });
  const g: AdapterGlobal = { fetch: (async () => new Response(stream, { headers: { 'content-type': 'application/dash+xml' } })) as typeof fetch, location: { href: `${DS}/page.html`, origin: DS } };
  installTransparentAdapter({ resolve: async () => undefined, trustManifest: (u: string) => { trustCalls.push(u); }, inScope: () => true }, { global: g });
  await g.fetch(`${DS}/live/manifest.mpd`);
  await tick();
  assert.deepEqual(trustCalls, []);
  assert.ok(pulled <= 4, `read stopped at the cap, pulled ${pulled}`);
});

for (const mode of ['onreadystatechange', 'load-listener-before-send'] as const) {
  test(`adapter: XHR segment issued synchronously at playlist readyState 4 is served from ROUTE (${mode})`, async () => {
    const M3U8 = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-1.m4s\n';
    const sent: string[] = [];
    class Xhr extends EventTarget {
      responseType = ''; status = 0; response: unknown = null; readyState = 0; url = '';
      onreadystatechange: ((this: Xhr) => void) | null = null;
      open(_m: string, url: string) { this.url = url; this.readyState = 1; }
      setRequestHeader() {}
      getResponseHeader(n: string) { return n === 'content-type' ? 'application/vnd.apple.mpegurl' : null; }
      abort() {}
      send() {
        sent.push(this.url);
        queueMicrotask(() => {
          this.status = 200; this.response = this.url.endsWith('.m3u8') ? M3U8 : 'x'; this.readyState = 4;
          this.onreadystatechange?.call(this); // browser order: readystatechange(4) before load
          this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
        });
      }
    }
    const proxy = new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/live/`, transparent: { unauthenticatedSegments: [DS] } });
    proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
    const g = { fetch: (async () => new Response('net')) as typeof fetch, location: { href: `${DS}/p.html`, origin: DS }, XMLHttpRequest: Xhr } as unknown as AdapterGlobal;
    installTransparentAdapter(proxy, { global: g });
    await new Promise<void>((done) => {
      const getSeg = () => { const s = new Xhr(); s.open('GET', seg(1)); s.addEventListener('loadend', () => done()); s.send(); };
      const pl = new Xhr();
      pl.open('GET', `${DS}/live/media.m3u8`);
      if (mode === 'onreadystatechange') pl.onreadystatechange = function() { if (this.readyState === 4) getSeg(); };
      else pl.addEventListener('load', getSeg);
      pl.send();
    });
    assert.ok(sent[1]!.startsWith('blob:'), `segment went to network: ${sent.join(', ')}`);
  });
}

test('adapter: fetch segment issued from XHR playlist readystatechange(4) is served from ROUTE', async () => {
  const M3U8 = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-1.m4s\n';
  class Xhr extends EventTarget {
    responseType = ''; status = 0; response: unknown = null; readyState = 0;
    onreadystatechange: ((this: Xhr) => void) | null = null;
    open(_m: string, _u: string) { this.readyState = 1; }
    setRequestHeader() {}
    getResponseHeader(n: string) { return n === 'content-type' ? 'application/vnd.apple.mpegurl' : null; }
    abort() {}
    send() {
      queueMicrotask(() => {
        this.status = 200; this.response = M3U8; this.readyState = 4;
        this.onreadystatechange?.call(this);
        this.dispatchEvent(new Event('load')); this.dispatchEvent(new Event('loadend'));
      });
    }
  }
  let network = 0;
  const proxy = new MabrRouteProxy({ baseUrl: `${DS}/`, scope: `${DS}/live/`, transparent: { unauthenticatedSegments: [DS] } });
  proxy.put({ url: seg(1), data: Uint8Array.of(1), contentType: 'video/mp4' });
  const g = { fetch: (async () => { network++; return new Response('net'); }) as typeof fetch, location: { href: `${DS}/p.html`, origin: DS }, XMLHttpRequest: Xhr } as unknown as AdapterGlobal;
  installTransparentAdapter(proxy, { global: g });
  const res = await new Promise<Response>((done) => {
    const pl = new Xhr();
    pl.open('GET', `${DS}/live/media.m3u8`);
    pl.onreadystatechange = function() { if (this.readyState === 4) g.fetch(seg(1)).then(done); };
    pl.send();
  });
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1]);
  assert.equal(network, 0);
});
