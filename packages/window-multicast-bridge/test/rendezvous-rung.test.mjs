// Rung 3 — rendezvous (BLO-34193). The response contract is
// `trafficcontrol/internal/rendezvous/response.go`: `{bridges:[{host,wtPort,hashes}]}`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectRendezvousCandidate,
  loadBridgePairing,
  parseRendezvousBridges,
  startRendezvousLookup,
} from '../src/multicast-bridge.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/multicast-bridge.js');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function mockGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
    entries: () => [...map.entries()],
  };
}

/** Records every WebTransport construction, so an unpinned one is observable. */
function recordingWebTransport(t, behaviour) {
  const constructions = [];
  mockGlobal(t, 'WebTransport', class {
    constructor(url, options) {
      const index = constructions.length;
      constructions.push({ url, options, closed: false });
      this._index = index;
      this.ready = behaviour(url, index);
      // An unawaited rejection must not surface as an unhandled rejection.
      if (typeof this.ready?.catch === 'function') this.ready.catch(() => {});
    }
    close() { constructions[this._index].closed = true; }
  });
  return constructions;
}

function captureLogs(t) {
  const lines = [];
  const previous = console.log;
  console.log = (...args) => lines.push(args);
  t.after(() => { console.log = previous; });
  return lines;
}

function jsonResponse(body, { status = 200, etag = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    json: async () => body,
  };
}

// ── Response parsing ──

test('parses the edge contract and keeps response order', () => {
  const parsed = parseRendezvousBridges({
    bridges: [
      { host: '127.0.0.1', wtPort: 33445, hashes: [A, B] },
      { host: '::1', wtPort: 33446, hashes: [C] },
    ],
  });
  assert.deepEqual(parsed, [
    { host: '127.0.0.1', wtPort: 33445, hashes: [A, B] },
    { host: '::1', wtPort: 33446, hashes: [C] },
  ]);
});

test('drops every candidate that cannot be connected to pinned', () => {
  // Each entry is malformed in exactly one way, so no drop can be attributed
  // to a different field than the one it is testing.
  const parsed = parseRendezvousBridges({
    bridges: [
      { host: '192.168.1.50', wtPort: 33445, hashes: [A] },   // non-loopback — DPIA
      { host: '10.0.0.4', wtPort: 33445, hashes: [A] },       // non-loopback — DPIA
      { host: '127.0.0.1', wtPort: 33445, hashes: [] },       // hash-less
      { host: '127.0.0.1', wtPort: 33445 },                   // no hashes field
      { host: '127.0.0.1', wtPort: 0, hashes: [A] },          // port out of range
      { host: '127.0.0.1', wtPort: 99999, hashes: [A] },      // port out of range
      { host: '', wtPort: 33445, hashes: [A] },               // no host
      { host: '127.0.0.1', wtPort: 33445, hashes: ['nothex'] },
      null,
      'not an object',
    ],
  });
  assert.deepEqual(parsed, []);
});

test('a malformed body contributes nothing rather than throwing', () => {
  for (const body of [null, undefined, {}, { bridges: null }, { bridges: 'x' }, []]) {
    assert.deepEqual(parseRendezvousBridges(body), []);
  }
});

// ── Multi-host and multi-hash ordering ──

test('one pinned connect per host:port, carrying every hash for it, in order', async (t) => {
  const constructions = recordingWebTransport(t, (url) => (
    url.includes('33446') ? Promise.resolve() : new Promise(() => {})
  ));
  mockGlobal(t, 'localStorage', memoryStorage());

  const bridge = await connectRendezvousCandidate([
    // Two households at one IPv4 key publish the same endpoint — they must
    // collapse into one connect offering both hashes, not two connects.
    { host: '127.0.0.1', wtPort: 33445, hashes: [A] },
    { host: '127.0.0.1', wtPort: 33445, hashes: [B] },
    { host: '::1', wtPort: 33446, hashes: [C] },
  ], { httpPort: 33446 });

  assert.equal(constructions.length, 2, 'one connect per distinct host:port');
  assert.match(constructions[0].url, /127\.0\.0\.1:33445$/);
  assert.match(constructions[1].url, /\[::1\]:33446$/);
  assert.deepEqual(
    constructions[0].options.serverCertificateHashes.map((h) => Buffer.from(h.value).toString('hex')),
    [A, B],
    'union of both households\' hashes, first-seen order',
  );
  assert.equal(bridge.host, '::1');
  assert.equal(bridge.wtPort, 33446);
  assert.equal(bridge.discoveryMethod, 'rendezvous');
  assert.deepEqual(bridge.fingerprint, [C]);
});

test('first success wins and the remaining attempts are aborted', async (t) => {
  const constructions = recordingWebTransport(t, (url) => (
    url.includes('33445') ? Promise.resolve() : new Promise(() => {})
  ));
  mockGlobal(t, 'localStorage', memoryStorage());

  const bridge = await connectRendezvousCandidate([
    { host: '127.0.0.1', wtPort: 33445, hashes: [A] },
    { host: '127.0.0.1', wtPort: 33446, hashes: [B] },
  ], { httpPort: 33445 });

  assert.equal(bridge.wtPort, 33445);
  assert.ok(constructions.every((c) => c.closed), 'every session closed, winner included');
});

test('a losing endpoint failing fast does not decide the race', async (t) => {
  // Promise.race over all attempts would resolve on this rejection; the rung
  // uses first-fulfilled, so the slower real bridge still wins.
  recordingWebTransport(t, (url) => (
    url.includes('33445')
      ? Promise.reject(new Error('refused'))
      : new Promise((resolve) => setTimeout(resolve, 20))
  ));
  mockGlobal(t, 'localStorage', memoryStorage());

  const bridge = await connectRendezvousCandidate([
    { host: '127.0.0.1', wtPort: 33445, hashes: [A] },
    { host: '127.0.0.1', wtPort: 33446, hashes: [B] },
  ], { httpPort: 33445 });

  assert.equal(bridge.wtPort, 33446);
});

test('all candidates failing yields no bridge and no rejection', async (t) => {
  recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  mockGlobal(t, 'localStorage', memoryStorage());

  assert.equal(
    await connectRendezvousCandidate([{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }], { httpPort: 1 }),
    null,
  );
});

// ── No unpinned fallback ──

test('never constructs a WebTransport without serverCertificateHashes', async (t) => {
  const constructions = recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  mockGlobal(t, 'localStorage', memoryStorage());

  // Hash-less, malformed and non-loopback shapes all the way through the real
  // parse boundary — the only entry point candidates have.
  const candidates = parseRendezvousBridges({
    bridges: [
      { host: '127.0.0.1', wtPort: 33445, hashes: [] },
      { host: '127.0.0.1', wtPort: 33445, hashes: null },
      { host: '127.0.0.1', wtPort: 33445 },
      { host: '192.168.1.50', wtPort: 33445, hashes: [A] },
      { host: 'bridge.example.test', wtPort: 33445, hashes: [A] },
    ],
  });
  assert.equal(await connectRendezvousCandidate(candidates, { httpPort: 1 }), null);
  assert.equal(constructions.length, 0, 'no connect at all for unusable candidates');

  // And when a usable candidate is present, the option is always populated.
  const good = parseRendezvousBridges({ bridges: [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }] });
  await connectRendezvousCandidate(good, { httpPort: 1 });
  assert.equal(constructions.length, 1);
  assert.equal(constructions[0].options.serverCertificateHashes.length, 1);
});

test('a LAN candidate produces zero WebTransport constructions for that host', async (t) => {
  // BLO-34188 DPIA: a pin published from a shared public address proves nothing
  // about whose bridge it is. Loopback is the only self-authenticating class.
  const constructions = recordingWebTransport(t, () => Promise.resolve());
  mockGlobal(t, 'localStorage', memoryStorage());

  const candidates = parseRendezvousBridges({
    bridges: [
      { host: '192.168.1.50', wtPort: 33445, hashes: [A] },
      { host: '127.0.0.1', wtPort: 33445, hashes: [B] },
    ],
  });
  await connectRendezvousCandidate(candidates, { httpPort: 1 });

  assert.equal(constructions.length, 1);
  assert.match(constructions[0].url, /127\.0\.0\.1/);
  assert.ok(!constructions.some((c) => c.url.includes('192.168.1.50')));
});

test('the source carries no rendezvous host literal', () => {
  const source = readFileSync(SRC, 'utf8');
  assert.doesNotMatch(source, /rdv\./);
  assert.doesNotMatch(source, /bcast\.id\/v1\/bridges/);
  // The path is ours; the host must come from the page's configuration.
  assert.match(source, /options\.rendezvousUrl/);
});

// ── Bounded consumption ──
// Review follow-up. The edge's own contract reasons about up to 64 unrelated
// households at one key, but that is a property of the server half, and the
// client filter has to be the half that survives a change at either end. Every
// cap below guards a resource the client spends per entry: one WebTransport and
// one 5 s timer per endpoint, one `serverCertificateHashes` entry per hash, and
// a cache write that shares its quota with the pairing record.

test('a flooded candidate list is truncated, keeping the edge\'s own order', () => {
  const bridges = [];
  for (let i = 0; i < 5000; i += 1) bridges.push({ host: '127.0.0.1', wtPort: 20000 + i, hashes: [A] });
  const parsed = parseRendezvousBridges({ bridges });

  assert.equal(parsed.length, 128);
  assert.deepEqual(parsed[0], { host: '127.0.0.1', wtPort: 20000, hashes: [A] });
  assert.equal(parsed[127].wtPort, 20127);
});

test('a flooded response constructs a bounded number of WebTransports', async (t) => {
  const constructions = recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  mockGlobal(t, 'localStorage', memoryStorage());

  const candidates = [];
  for (let i = 0; i < 5000; i += 1) candidates.push({ host: '127.0.0.1', wtPort: 20000 + i, hashes: [A] });

  assert.equal(await connectRendezvousCandidate(candidates, { httpPort: 1 }), null);
  assert.equal(constructions.length, 64, 'one connect per endpoint, endpoints capped');
});

test('the per-endpoint hash union is capped', async (t) => {
  const constructions = recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  mockGlobal(t, 'localStorage', memoryStorage());

  // Every default-configured household publishes `127.0.0.1:33445`, so the
  // honest case *is* the collapsed one: a cap below the edge's 64-household
  // envelope would silently strand every household past the cut, because its
  // own pin would never be offered. 200 is past the cap, so this pins the
  // backstop; `the whole 64-household envelope is offered` below pins the half
  // that must not bite.
  const candidates = [];
  for (let i = 0; i < 200; i += 1) {
    candidates.push({ host: '127.0.0.1', wtPort: 33445, hashes: [i.toString(16).padStart(64, '0')] });
  }
  await connectRendezvousCandidate(candidates, { httpPort: 1 });

  assert.equal(constructions.length, 1);
  assert.equal(constructions[0].options.serverCertificateHashes.length, 128);
});

test('the whole 64-household envelope is offered on one collapsed endpoint', async (t) => {
  const constructions = recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  mockGlobal(t, 'localStorage', memoryStorage());

  // The edge's stated envelope, each household mid-rotation with two hashes:
  // 128 hashes on one endpoint, none dropped. A household whose hash is not in
  // this list cannot complete the handshake and never will.
  const candidates = [];
  for (let i = 0; i < 64; i += 1) {
    candidates.push({
      host: '127.0.0.1',
      wtPort: 33445,
      hashes: [(i * 2).toString(16).padStart(64, '0'), (i * 2 + 1).toString(16).padStart(64, '0')],
    });
  }
  await connectRendezvousCandidate(candidates, { httpPort: 1 });

  assert.equal(constructions.length, 1, 'the default port collapses every household to one endpoint');
  assert.equal(constructions[0].options.serverCertificateHashes.length, 128, 'no household is stranded');
});

test('a rendezvous win persists the whole offered union, not a prefix', async (t) => {
  // The winner's own pin must survive the round trip through `localStorage`.
  // WebTransport does not report which offered hash matched, so storing a
  // prefix of the union is a coin flip: with a 4-hash store bound this record
  // holds households 0 and 1, and the other 62 fail rung 0's pinned connect on
  // every subsequent load and re-pay full discovery — the "paired visit costs
  // no network I/O" contract never holds on a contended key.
  const constructions = recordingWebTransport(t, (_url, index) =>
    (index === 0 ? Promise.resolve() : Promise.reject(new Error('refused'))));
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);

  const hash = (n) => n.toString(16).padStart(64, '0');
  const candidates = [];
  for (let i = 0; i < 64; i += 1) {
    candidates.push({ host: '127.0.0.1', wtPort: 33445, hashes: [hash(i * 2), hash(i * 2 + 1)] });
  }

  const won = await connectRendezvousCandidate(candidates, { httpPort: 8080 });
  assert.equal(won?.wtPort, 33445);
  assert.equal(constructions[0].options.serverCertificateHashes.length, 128);

  const reloaded = loadBridgePairing({ storage: store });
  assert.equal(reloaded.hashes.length, 128, 'the stored record is the union, not a prefix of it');
  // Household 40 — a late one, which a prefix-truncating store would drop.
  assert.ok(reloaded.hashes.includes(hash(80)), 'a late household survives the write');
  assert.ok(reloaded.hashes.includes(hash(81)), 'including its rotation successor');
});

test('an oversized body is used but not cached', async (t) => {
  captureLogs(t);
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);
  const bridges = [];
  for (let i = 0; i < 1000; i += 1) bridges.push({ host: '127.0.0.1', wtPort: 20000 + i, hashes: [A] });
  assert.ok(JSON.stringify({ bridges }).length > 64 * 1024, 'fixture must exceed the ceiling');
  mockGlobal(t, 'fetch', async () => jsonResponse({ bridges }, { etag: '"big"' }));

  const candidates = await startRendezvousLookup('https://rendezvous.example.test');

  assert.equal(candidates.length, 128, 'the capped candidates are still usable');
  assert.equal(store.size, 0, 'nothing written — the quota is shared with the pairing record');
});

// ── Fetch: headers, timeout, 304, failure modes ──

test('issues the GET with credentials omitted and no If-None-Match when uncached', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  const calls = [];
  mockGlobal(t, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ bridges: [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }] });
  });

  const candidates = await startRendezvousLookup('https://rendezvous.example.test');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://rendezvous.example.test/v1/bridges');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers['If-None-Match'], undefined);
  assert.ok(calls[0].init.signal, 'carries an abort signal');
  assert.deepEqual(candidates, [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }]);
});

test('a trailing slash on the configured base does not double the path separator', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  const calls = [];
  mockGlobal(t, 'fetch', async (url) => {
    calls.push(url);
    return jsonResponse({ bridges: [] });
  });
  await startRendezvousLookup('https://rendezvous.example.test/');
  assert.equal(calls[0], 'https://rendezvous.example.test/v1/bridges');
});

test('stores the ETag and sends it back as If-None-Match', async (t) => {
  captureLogs(t);
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);
  const calls = [];
  mockGlobal(t, 'fetch', async (url, init) => {
    calls.push(init.headers['If-None-Match']);
    return jsonResponse({ bridges: [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }] }, { etag: '"v1"' });
  });

  await startRendezvousLookup('https://rendezvous.example.test');
  await startRendezvousLookup('https://rendezvous.example.test');

  assert.deepEqual(calls, [undefined, '"v1"']);
});

test('304 replays the cached body', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  let first = true;
  mockGlobal(t, 'fetch', async () => {
    if (first) {
      first = false;
      return jsonResponse({ bridges: [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }] }, { etag: '"v1"' });
    }
    return { status: 304, ok: false, headers: { get: () => '"v1"' }, json: async () => { throw new Error('no body'); } };
  });

  await startRendezvousLookup('https://rendezvous.example.test');
  const replayed = await startRendezvousLookup('https://rendezvous.example.test');

  assert.deepEqual(replayed, [{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }]);
});

test('304 with no cached body contributes zero candidates', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  mockGlobal(t, 'fetch', async () => ({
    status: 304,
    ok: false,
    headers: { get: () => null },
    json: async () => { throw new Error('no body'); },
  }));

  assert.deepEqual(await startRendezvousLookup('https://rendezvous.example.test'), []);
});

test('a response with no ETag is not cached, so the next request is unconditional', async (t) => {
  captureLogs(t);
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);
  const calls = [];
  mockGlobal(t, 'fetch', async (url, init) => {
    calls.push(init.headers['If-None-Match']);
    return jsonResponse({ bridges: [] });
  });

  await startRendezvousLookup('https://rendezvous.example.test');
  await startRendezvousLookup('https://rendezvous.example.test');

  assert.deepEqual(calls, [undefined, undefined]);
});

test('every failure mode contributes zero candidates and never rejects', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());

  const modes = {
    'network error': async () => { throw new TypeError('Failed to fetch'); },
    'non-2xx 500': async () => jsonResponse({}, { status: 500 }),
    'non-2xx 404': async () => jsonResponse({}, { status: 404 }),
    'non-2xx 429': async () => jsonResponse({}, { status: 429 }),
    'empty candidate list': async () => jsonResponse({ bridges: [] }),
    'unparseable body': async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad json'); } }),
  };
  for (const [name, impl] of Object.entries(modes)) {
    mockGlobal(t, 'fetch', impl);
    assert.deepEqual(await startRendezvousLookup('https://rendezvous.example.test'), [], name);
  }
});

test('aborts at 1.5 s and contributes zero candidates', async (t) => {
  captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  let abortedAfterMs = null;
  const startedAt = Date.now();
  mockGlobal(t, 'fetch', (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortedAfterMs = Date.now() - startedAt;
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));

  assert.deepEqual(await startRendezvousLookup('https://rendezvous.example.test'), []);
  assert.ok(abortedAfterMs !== null, 'the request was aborted, not left hanging');
  assert.ok(abortedAfterMs >= 1400 && abortedAfterMs < 3000, `aborted at ~1.5s (was ${abortedAfterMs}ms)`);
});

test('no configured rendezvous URL means the rung is off — no fetch, no telemetry', async (t) => {
  const lines = captureLogs(t);
  mockGlobal(t, 'fetch', async () => { throw new Error('must not be called'); });
  assert.equal(startRendezvousLookup(''), null);
  assert.equal(startRendezvousLookup(undefined), null);
  assert.equal(lines.length, 0);
});

// ── Telemetry ──

test('emits exactly one structured telemetry line per attempt', async (t) => {
  const lines = captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  mockGlobal(t, 'fetch', async () => jsonResponse({
    bridges: [
      { host: '127.0.0.1', wtPort: 33445, hashes: [A] },
      { host: '::1', wtPort: 33446, hashes: [B] },
    ],
  }));

  await startRendezvousLookup('https://rendezvous.example.test');

  const telemetry = lines.filter(([, payload]) => payload?.rung === 'rendezvous');
  assert.equal(telemetry.length, 1);
  const [, payload] = telemetry[0];
  assert.equal(payload.rung, 'rendezvous');
  assert.equal(payload.candidates, 2);
  assert.equal(typeof payload.latencyMs, 'number');
  assert.ok(payload.latencyMs >= 0);
});

test('telemetry still reports the rung with zero candidates on failure', async (t) => {
  const lines = captureLogs(t);
  mockGlobal(t, 'localStorage', memoryStorage());
  mockGlobal(t, 'fetch', async () => { throw new TypeError('Failed to fetch'); });

  await startRendezvousLookup('https://rendezvous.example.test');

  const telemetry = lines.filter(([, payload]) => payload?.rung === 'rendezvous');
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0][1].candidates, 0);
});

// ── Persisted pairing on success ──

test('a successful pinned connect writes the pairing record', async (t) => {
  recordingWebTransport(t, () => Promise.resolve());
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);

  const bridge = await connectRendezvousCandidate(
    [{ host: '127.0.0.1', wtPort: 33445, hashes: [A, B] }],
    { httpPort: 33446 },
  );

  assert.equal(bridge.discoveryMethod, 'rendezvous');
  const paired = loadBridgePairing();
  assert.equal(paired.host, '127.0.0.1');
  assert.equal(paired.wtPort, 33445);
  assert.equal(paired.httpPort, 33446);
  assert.deepEqual(paired.hashes, [A, B]);
});

test('a failed race writes no pairing record', async (t) => {
  recordingWebTransport(t, () => Promise.reject(new Error('refused')));
  const store = memoryStorage();
  mockGlobal(t, 'localStorage', store);

  await connectRendezvousCandidate([{ host: '127.0.0.1', wtPort: 33445, hashes: [A] }], { httpPort: 1 });

  assert.equal(store.size, 0);
  assert.equal(loadBridgePairing(), null);
});

// The ordering that makes "a subsequent discovery performs no rendezvous
// fetch" true is asserted behaviourally in `multicast-bridge.test.mjs`
// (`a seeded pairing starts no rendezvous fetch`) — it needs the full
// `discoverBridge` harness, which lives there. It used to be asserted here on
// statement order in the source, which no rename survives.
