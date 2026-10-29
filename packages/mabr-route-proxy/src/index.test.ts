import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSlsEndpoint, MabrRouteProxy } from './index.ts';
import { rescope } from './proxy.ts';

test('exports DS SLS discovery from the package entry point', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://ds.example.test/slt/7');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.mode, 'cors');
    assert.equal(init?.cache, 'no-store');
    return new Response('<SLT><Server globalServiceID="generic-service"><BroadcastSvcSignaling slsProtocol="1" slsDestinationIpAddress="232.1.1.66" slsDestinationUdpPort="8000" slsSourceIpAddress="69.25.95.61" /></Server></SLT>');
  }) as typeof globalThis.fetch;
  try {
    assert.deepEqual(await discoverSlsEndpoint({
      sltUrl: 'https://ds.example.test/slt/7',
      serviceId: 'generic-service',
    }), {
      group: '232.1.1.66',
      port: 8000,
      source: '69.25.95.61',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serves cached CMAF bytes and falls through misses', async () => {
  const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/live/' });
  proxy.put({ url: 'seg-1.m4s', data: Uint8Array.of(1, 2, 3) });
  const response = await proxy.fetch('https://player.test/live/seg-1.m4s');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(proxy.size, 1);
});

test('reports ROUTE hits and unicast fallback misses', async () => {
  const originalFetch = globalThis.fetch;
  const events: unknown[] = [];
  globalThis.fetch = (async () => new Response('origin')) as typeof fetch;
  try {
    const proxy = new MabrRouteProxy({
      baseUrl: 'https://player.test/live/',
      onCacheEvent: (event) => {
        events.push(event);
        if (events.length === 1) throw new Error('metrics sink is down');
      },
    });
    proxy.put({ url: 'seg.m4s', data: Uint8Array.of(1, 2) });
    assert.equal(await (await proxy.fetch('https://player.test/live/seg.m4s')).status, 200);
    assert.equal(await (await proxy.fetch('https://player.test/live/missing.m4s')).text(), 'origin');
    assert.deepEqual(proxy.stats, { hits: 1, misses: 1 });
    assert.deepEqual(events, [
      { url: 'https://player.test/live/seg.m4s', method: 'GET', outcome: 'hit', transport: 'route' },
      { url: 'https://player.test/live/missing.m4s', method: 'GET', outcome: 'miss', transport: 'network' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports HEAD and range hits without treating them as misses', async () => {
  const events: unknown[] = [];
  const proxy = new MabrRouteProxy({
    baseUrl: 'https://player.test/live/',
    onCacheEvent: (event) => events.push(event),
  });
  proxy.put({ url: 'seg.m4s', data: Uint8Array.of(1, 2, 3) });
  assert.equal((await proxy.fetch('https://player.test/live/seg.m4s', { method: 'HEAD' })).status, 200);
  assert.equal((await proxy.fetch('https://player.test/live/seg.m4s', { headers: { range: 'bytes=1-2' } })).status, 206);
  assert.deepEqual(proxy.stats, { hits: 2, misses: 0 });
  assert.deepEqual(events, [
    { url: 'https://player.test/live/seg.m4s', method: 'HEAD', outcome: 'hit', transport: 'route' },
    { url: 'https://player.test/live/seg.m4s', method: 'GET', outcome: 'hit', transport: 'route' },
  ]);
});

test('evicts oldest entries', () => {
  const proxy = new MabrRouteProxy({ maxEntries: 1, baseUrl: 'https://player.test/' });
  proxy.put({ url: 'a.m4s', data: Uint8Array.of(1) });
  proxy.put({ url: 'b.m4s', data: Uint8Array.of(2) });
  assert.equal(proxy.size, 1);
});

test('attaches a window.multicast bytes subscription', async () => {
  let listener: ((event: { detail: ArrayBuffer }) => void) | undefined;
  const subscription = {
    addEventListener: (_type: 'bytes', cb: (event: { detail: ArrayBuffer }) => void) => { listener = cb; },
    removeEventListener: () => { listener = undefined; },
  };
  const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/' });
  const detach = proxy.attach(subscription, () => ({ url: 'live.m4s', data: Uint8Array.of(9) }));
  listener?.({ detail: new Uint8Array([1]).buffer });
  assert.equal(proxy.size, 1);
  detach();
  assert.equal(listener, undefined);
});

test('patches and restores the page fetch used by players', async () => {
  const original = globalThis.fetch;
  const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/' });
  proxy.put({ url: 'master.m3u8', data: new TextEncoder().encode('#EXTM3U') });
  const restore = proxy.installFetch();
  try {
    const response = await fetch('https://player.test/master.m3u8');
    assert.equal(await response.text(), '#EXTM3U');
  } finally {
    restore();
  }
  assert.equal(globalThis.fetch, original);
});

test('patches Shaka Fetch plugin when Shaka loaded before the proxy', async () => {
  const original = globalThis.fetch;
  const host = globalThis as typeof globalThis & {
    shaka?: { net?: { HttpFetchPlugin?: { fetch_?: typeof globalThis.fetch } } };
  };
  const previousShaka = host.shaka;
  const plugin = { fetch_: original };
  host.shaka = { net: { HttpFetchPlugin: plugin } };
  const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/' });
  proxy.put({ url: 'master.mpd', data: new TextEncoder().encode('<MPD/>') });
  const restore = proxy.installFetch();
  try {
    assert.notEqual(plugin.fetch_, original);
    const response = await plugin.fetch_!('https://player.test/master.mpd');
    assert.equal(await response.text(), '<MPD/>');
  } finally {
    restore();
    host.shaka = previousShaka;
  }
  assert.equal(globalThis.fetch, original);
  assert.equal(plugin.fetch_, original);
});

test('warns when a production Shaka build hides its fetch snapshot', () => {
  const host = globalThis as typeof globalThis & {
    shaka?: { net?: { HttpFetchPlugin?: { fetch_?: typeof globalThis.fetch } } };
  };
  const previousShaka = host.shaka;
  const previousWarn = console.warn;
  const warnings: string[] = [];
  host.shaka = { net: { HttpFetchPlugin: {} } };
  console.warn = (message: unknown) => warnings.push(String(message));
  const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/' });
  const restore = proxy.installFetch();
  try {
    assert.match(warnings[0] ?? '', /call installFetch\(\) before evaluating Shaka/);
  } finally {
    restore();
    console.warn = previousWarn;
    host.shaka = previousShaka;
  }
});

test('refuses locations outside the baseUrl scope and lets them reach the network', async () => {
  const original = globalThis.fetch;
  let network = 0;
  globalThis.fetch = (async () => { network++; return new Response('network'); }) as typeof globalThis.fetch;
  try {
    const proxy = new MabrRouteProxy({ baseUrl: 'https://player.test/live/' });
    for (const url of ['https://player.test/api/session', 'https://evil.test/live/seg.m4s', '../api/session', 'https://player.test/live2/seg.m4s']) {
      assert.equal(proxy.put({ url, data: Uint8Array.of(1) }), undefined, url);
    }
    assert.equal(proxy.size, 0);
    assert.equal(await (await proxy.fetch('https://player.test/api/session')).text(), 'network');
    assert.equal(network, 1);
    assert.equal(proxy.put({ url: 'seg-1.m4s', data: Uint8Array.of(7) }), 'https://player.test/live/seg-1.m4s');
  } finally {
    globalThis.fetch = original;
  }
});

test('resolves against baseUrl, caches only under scope and drops entries on rescope', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('network')) as typeof globalThis.fetch;
  try {
    const proxy = new MabrRouteProxy({ baseUrl: 'https://ds.test/', scope: 'https://ds.test/live/' });
    assert.equal(proxy.put({ url: 'live/seg-1.m4s', data: Uint8Array.of(1) }), 'https://ds.test/live/seg-1.m4s');
    assert.equal(proxy.put({ url: 'slt/9', data: Uint8Array.of(2) }), undefined);
    assert.equal(proxy.size, 1);
    assert.deepEqual([...new Uint8Array(await (await proxy.fetch('https://ds.test/live/seg-1.m4s')).arrayBuffer())], [1]);
    assert.equal(await (await proxy.fetch('https://ds.test/live/seg-1.m4s', { cache: 'no-store' })).text(), 'network');
    assert.equal(await (await proxy.fetch('https://ds.test/live/seg-1.m4s', { cache: 'reload' })).text(), 'network');
    assert.deepEqual(proxy.stats, { hits: 1, misses: 0 });
    proxy[rescope]('https://ds.test/', 'https://ds.test/vod/');
    assert.equal(proxy.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});
