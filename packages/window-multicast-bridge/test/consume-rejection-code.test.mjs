// Every provider must answer a rejected `consume` mode with the code the
// contract ratifies (see the RULING next to MulticastErrorCode, and
// CONSUME_REJECTION_VECTORS, which both halves below read so the agreed codes
// are stated once). The bridge has two guards: subscribeMulticastBridgeBytes(),
// and the window.multicast.subscribe a page actually calls, which runs first and
// used to shadow the inner one with a different code (BLO-33765).
//
// The source-shape half reads src/ as text: the minified build writes `void 0`,
// so the shapes cannot match it, and test:dist redirects module resolution
// only, so it keeps reading src/. The behaviour half imports the bridge, so
// test:dist runs it against the build that ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CONSUME_REJECTION_VECTORS,
  checkConsumeRejectionAgreed,
} from '../../multicast-contract/src/conformance.ts';
import { MULTICAST_ERROR_CODES } from '../../multicast-contract/src/gateway.ts';
import {
  BridgeClient,
  initMulticastBridge,
  subscribeMulticastBridgeBytes,
} from '../src/multicast-bridge.js';

/**
 * The two `consume` guards, and how far past one to look for the code it
 * answers with: generous enough to span a reformatted multi-line throw, tight
 * enough not to reach the next rejection (every site answers within ~8 lines).
 *
 * Both shapes are pinned, not just the capability one. A guard that keeps the
 * capability branch but drops `=== undefined` swallows a MISSING required field
 * into "unsupported mode", and reads as correct at every individual call site.
 */
const WINDOW_CHARS = 420;

const GUARDS = [
  {
    what: 'an explicitly supplied unsupported consume mode',
    shape: /consume\s*!==\s*undefined\s*&&[^\n]*consume\s*!==\s*['"]bytes['"]/g,
    expectFrom: 'unsupported-consume-mode-is-capability-unsupported',
    hint:
      "the capability branch must be `consume !== undefined && consume !== 'bytes'`. " +
      'Without the `!== undefined` half it also swallows a config that merely OMITS ' +
      '`consume`, which is a malformed request, not an absent capability.',
  },
  {
    what: 'an omitted consume field',
    shape: /consume\s*===\s*undefined/g,
    expectFrom: 'missing-consume-is-subscription-failed',
    hint:
      'the malformed branch must stay `consume === undefined`. `consume` is a REQUIRED ' +
      'SubscribeConfig field, so omitting it is a bad request the caller can fix by ' +
      'supplying it; `capability-unsupported` would tell them retrying is pointless.',
  },
];

const SRC = readFileSync(new URL('../src/multicast-bridge.js', import.meta.url), 'utf8');

function expectedCodeFor(vectorName) {
  const vector = CONSUME_REJECTION_VECTORS.find((candidate) => candidate.name === vectorName);
  assert.ok(vector, `no CONSUME_REJECTION_VECTORS entry named "${vectorName}"`);
  return vector.expectErrorCode;
}

/** The first documented error code quoted after `from`, or null. */
function codeAnsweredAfter(source, from) {
  for (const [, candidate] of source.slice(from, from + WINDOW_CHARS).matchAll(/['"]([a-z-]+)['"]/g)) {
    if (MULTICAST_ERROR_CODES.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Is `index` inside a comment line? The guards are heavily commented, and the
 * comments quote the guard they explain (the one above the outer guard does),
 * so without this the check fires on its own documentation.
 *
 * ponytail: line-prefix test, not a tokenizer. It handles `//` and the `*`
 * continuation of a block comment, every comment style at these sites; a guard
 * after code on a line with a trailing `//` comment would be missed.
 */
function isCommentLine(source, index) {
  const line = source.slice(source.lastIndexOf('\n', index) + 1, index).trimStart();
  return line.startsWith('//') || line.startsWith('*');
}

for (const guard of GUARDS) {
  test(`every consume guard in src/ answers ${guard.what} with the agreed code`, () => {
    const expectErrorCode = expectedCodeFor(guard.expectFrom);
    const sites = [...SRC.matchAll(guard.shape)].filter((site) => !isCommentLine(SRC, site.index));

    // Positive control: no match means the guard was renamed or removed, not
    // that the bridge agrees. Without it this passes vacuously on exactly the
    // refactor most likely to re-diverge it.
    assert.ok(
      sites.length > 0,
      `found no guard for ${guard.what} in src/multicast-bridge.js. ${guard.hint} ` +
        'If this was a deliberate refactor, update this check in the same commit.',
    );

    // EVERY site, not just the first: the outer guard shadows the inner one,
    // so checking one site could report agreement while the code a page
    // actually receives disagreed.
    for (const site of sites) {
      const answered = codeAnsweredAfter(SRC, site.index);
      const line = SRC.slice(0, site.index).split('\n').length;
      assert.equal(
        answered,
        expectErrorCode,
        `src/multicast-bridge.js:${line} answers ${guard.what} with "${String(answered)}", ` +
          `but the contract ratifies "${expectErrorCode}".`,
      );
    }
  });
}

test('subscribeMulticastBridgeBytes answers each consume rejection with the agreed code', async () => {
  const subscribeCalls = [];
  const bridgeClient = {
    async subscribe(...args) {
      subscribeCalls.push(args);
      throw new Error('a rejected config reached the bridge');
    },
  };

  const result = await checkConsumeRejectionAgreed({
    gateway: { subscribe: (config) => subscribeMulticastBridgeBytes(bridgeClient, config) },
  });

  assert.equal(result.status, 'pass', result.detail);
  assert.deepEqual(subscribeCalls, [], 'a rejected config must never reach the bridge');
});

function mockGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}

test('window.multicast.subscribe answers each consume rejection with the agreed code', async (t) => {
  const listeners = new Map();
  const store = new Map();
  const windowScope = {
    location: {
      href: 'https://example.test/live',
      origin: 'https://example.test',
      protocol: 'https:',
      hostname: 'example.test',
      search: `?mc_bridge=127.0.0.1&fingerprint=${'cd'.repeat(32)}`,
      hash: '',
    },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  mockGlobal(t, 'window', windowScope);
  mockGlobal(t, 'location', windowScope.location);
  mockGlobal(t, 'localStorage', windowScope.localStorage);
  mockGlobal(t, 'document', {
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', title: 'test',
  });
  mockGlobal(t, 'WebTransport', class WebTransportStub {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in this test'); });
  t.mock.method(console, 'log', () => {});
  t.mock.method(BridgeClient.prototype, 'connect', async function connectStub() {
    this.connected = true;
    this._transport = 'webtransport';
  });
  const bridgeSubscribe = t.mock.method(BridgeClient.prototype, 'subscribe', async () => {
    throw new Error('a rejected config reached the bridge');
  });

  // Stopped in the body, not in t.after: after-hooks run in registration
  // order, so the globals above would already be restored.
  const controller = initMulticastBridge({ autoStart: false });
  try {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const surface = windowScope.multicast;
    assert.equal(surface?.__blockcastBridgePolyfill, true, 'the bridge must install window.multicast');

    const result = await checkConsumeRejectionAgreed({ gateway: surface });

    assert.equal(result.status, 'pass', result.detail);
    assert.equal(bridgeSubscribe.mock.callCount(), 0, 'a rejected config must never reach the bridge');
  } finally {
    controller.stop();
  }
});
