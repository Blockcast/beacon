// BLO-36599: batched packet delivery on bytes subscriptions.
//
// On a Huawei ANE-LX1 (Kirin 659) the bridge's per-packet DOM event cost about
// 22 ms of main thread per second at ~450 packets/s (dispatchEvent 15.6 ms/s,
// CustomEvent construction 6.2 ms/s) before any media work ran. The reader
// already drains the BCDS stream in dispatch batches (one synchronous run of at
// most WT_DATA_STREAM_DISPATCH_BATCH_FRAMES frames between yields), so a
// subscription can receive each batch as one `packets` event instead of one
// `bytes` event per packet. The batch boundary is the reader's own yield point:
// no timer, no size knob.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeClient, subscribeMulticastBridgeBytes } from '../src/multicast-bridge.js';

const STREAM_INDEX = 3;
const SUBSCRIPTION_ID = 'sub-batch';
// Mirrors WT_DATA_STREAM_DISPATCH_BATCH_FRAMES in the bridge.
const DISPATCH_BATCH_FRAMES = 64;

function makeStreamIndexFrame(streamIndex, payload) {
  const frame = new Uint8Array(2 + payload.length);
  new DataView(frame.buffer).setUint16(0, streamIndex, true);
  frame.set(payload, 2);
  return frame;
}

function makeLengthPrefixedFrame(bytes) {
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, true);
  frame.set(bytes, 4);
  return frame;
}

function packetPayload(index) {
  return new Uint8Array([index & 0xff, (index >> 8) & 0xff, 0x47]);
}

/** One BCDS chunk carrying `count` stream-index frames for STREAM_INDEX. */
function bcdsChunk(start, count) {
  const frames = [];
  let length = 0;
  for (let i = start; i < start + count; i++) {
    const frame = makeLengthPrefixedFrame(makeStreamIndexFrame(STREAM_INDEX, packetPayload(i)));
    frames.push(frame);
    length += frame.byteLength;
  }
  const chunk = new Uint8Array(length);
  let offset = 0;
  for (const frame of frames) {
    chunk.set(frame, offset);
    offset += frame.byteLength;
  }
  return chunk;
}

function packetIndex(detail) {
  const data = detail instanceof ArrayBuffer ? detail : detail.data;
  const bytes = new Uint8Array(data);
  return bytes[0] | (bytes[1] << 8);
}

/**
 * A real BridgeClient reading a BCDS stream, wired to a real bytes
 * subscription the way the live bridge wires them: the subscription's
 * callbacks are the client's subscriptionCallbacks entry for the stream.
 */
async function makeHarness() {
  const client = new BridgeClient();
  client.connected = true;
  client._sendControl = () => true;
  const token = {};
  client._dataStreamBuffers.set(STREAM_INDEX, new Uint8Array(0));
  client._dataStreamTokens.set(STREAM_INDEX, token);
  client._streamSubscriptions.set(STREAM_INDEX, SUBSCRIPTION_ID);
  const bridge = {
    async subscribe() {
      return {
        subscriptionId: SUBSCRIPTION_ID,
        setCallbacks(callbacks) {
          client.subscriptionCallbacks.set(SUBSCRIPTION_ID, callbacks);
        },
      };
    },
    async unsubscribe() {},
  };
  const sub = await subscribeMulticastBridgeBytes(bridge, {
    group: '232.1.1.60',
    port: 8000,
    source: '69.25.95.128',
    consume: 'bytes',
  });
  return {
    client,
    sub,
    feed: (chunk) => client._appendDataStreamBytes(STREAM_INDEX, chunk, token),
  };
}

/** Count events dispatched on any EventTarget, by type, while `run` executes. */
async function countDispatches(run) {
  const counts = new Map();
  const original = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function countingDispatch(event) {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
    return original.call(this, event);
  };
  try {
    await run();
  } finally {
    EventTarget.prototype.dispatchEvent = original;
  }
  return counts;
}

test('bytes subscriptions advertise the packets event for feature detection', async () => {
  const { sub } = await makeHarness();
  assert.ok(Array.isArray(sub.eventTypes), 'eventTypes lists the events this provider emits');
  assert.ok(sub.eventTypes.includes('packets'));
  assert.ok(sub.eventTypes.includes('bytes'));
  assert.ok(Object.isFrozen(sub.eventTypes));
  await sub.unsubscribe();
});

test('a packets listener receives one event per reader dispatch batch, in order', async () => {
  const { sub, feed } = await makeHarness();
  const batches = [];
  sub.addEventListener('packets', (event) => batches.push(event.detail.map(packetIndex)));

  assert.equal(await feed(bcdsChunk(0, 10)), true);
  assert.deepEqual(batches, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    'ten frames drained in one synchronous run are one batch');

  // The reader's yield budget lives on the stream, not on the read: the 10
  // frames above already spent 10 of it, so 130 more frames yield after 54,
  // then after a full 64, and the read ends with the remaining 12.
  assert.equal(await feed(bcdsChunk(10, 130)), true);
  assert.deepEqual(batches.slice(1).map((batch) => batch.length),
    [DISPATCH_BATCH_FRAMES - 10, DISPATCH_BATCH_FRAMES, 130 - (DISPATCH_BATCH_FRAMES - 10) - DISPATCH_BATCH_FRAMES]);
  assert.deepEqual(batches.flat(), Array.from({ length: 140 }, (_, i) => i),
    'batching neither drops, duplicates nor reorders packets');
  await sub.unsubscribe();
});

test('a packets-only consumer pays no per-packet bytes events', async () => {
  const { sub, feed } = await makeHarness();
  let delivered = 0;
  sub.addEventListener('packets', (event) => { delivered += event.detail.length; });

  const counts = await countDispatches(() => feed(bcdsChunk(0, 200)));
  assert.equal(delivered, 200);
  assert.equal(counts.get('bytes') || 0, 0, 'no bytes event is built for a packets-only consumer');
  assert.equal(counts.get('packets'), Math.ceil(200 / DISPATCH_BATCH_FRAMES));
  await sub.unsubscribe();
});

test('a legacy bytes listener still receives one event per packet with the same detail', async () => {
  const { sub, feed } = await makeHarness();
  const bytesIndices = [];
  sub.addEventListener('bytes', (event) => {
    assert.ok(event.detail instanceof ArrayBuffer, 'bytes detail stays an ArrayBuffer');
    bytesIndices.push(packetIndex(event.detail));
  });

  await feed(bcdsChunk(0, 70));
  assert.deepEqual(bytesIndices, Array.from({ length: 70 }, (_, i) => i));
  await sub.unsubscribe();
});

test('packets are delivered before the reader yields, not after', async (t) => {
  const log = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  Object.defineProperty(globalThis, 'scheduler', {
    configurable: true,
    writable: true,
    value: { yield: async () => { log.push('yield'); } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'scheduler', previous);
    else delete globalThis.scheduler;
  });

  const { sub, feed } = await makeHarness();
  sub.addEventListener('packets', (event) => log.push(`packets:${event.detail.length}`));
  await feed(bcdsChunk(0, DISPATCH_BATCH_FRAMES + 1));
  assert.deepEqual(log, [`packets:${DISPATCH_BATCH_FRAMES}`, 'yield', 'packets:1']);
  await sub.unsubscribe();
});

test('state is dispatched on the connected edge, not per packet', async () => {
  const { sub, feed } = await makeHarness();
  const states = [];
  sub.addEventListener('state', (event) => states.push(event.detail));
  sub.addEventListener('packets', () => {});
  const counts = await countDispatches(async () => {
    await feed(bcdsChunk(0, 5));
    await feed(bcdsChunk(5, 5));
  });
  assert.deepEqual(states, ['connected']);
  assert.equal(counts.get('state'), 1);
  await sub.unsubscribe();
});

test('a closed subscription receives no further packets batches', async () => {
  const { sub, feed } = await makeHarness();
  const batches = [];
  sub.addEventListener('packets', (event) => batches.push(event.detail.length));
  await feed(bcdsChunk(0, 3));
  await sub.unsubscribe();
  await feed(bcdsChunk(3, 3));
  assert.deepEqual(batches, [3]);
});

test('client callbacks without onpackets keep per-packet onpacket delivery', async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._sendControl = () => true;
  const token = {};
  client._dataStreamBuffers.set(STREAM_INDEX, new Uint8Array(0));
  client._dataStreamTokens.set(STREAM_INDEX, token);
  client._streamSubscriptions.set(STREAM_INDEX, 'legacy');
  const seen = [];
  client.subscriptionCallbacks.set('legacy', {
    onpacket(event) { seen.push(packetIndex(event)); },
  });
  await client._appendDataStreamBytes(STREAM_INDEX, bcdsChunk(0, 66), token);
  assert.deepEqual(seen, Array.from({ length: 66 }, (_, i) => i));
});

function makeStreamMetadataFrame(streamIndex, payload, receiveTime, source, receiveTimeOrigin) {
  const sourceBytes = new TextEncoder().encode(source);
  const frame = new Uint8Array(13 + sourceBytes.length + 8 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, streamIndex | 0x8000, true);
  view.setUint8(2, 2); // metadata version
  view.setUint8(3, 1); // receiveTimeOrigin present
  view.setFloat64(4, receiveTime, true);
  view.setUint8(12, sourceBytes.length);
  frame.set(sourceBytes, 13);
  view.setFloat64(13 + sourceBytes.length, receiveTimeOrigin, true);
  frame.set(payload, 13 + sourceBytes.length + 8);
  return frame;
}

test('the per-stream receive-timestamp source cache follows a changed label', () => {
  const client = new BridgeClient();
  client._streamSubscriptions.set(STREAM_INDEX, 'timing');
  const sources = [];
  client.subscriptionCallbacks.set('timing', {
    onpacket(event) { sources.push(event.receiveTimestampSource); },
  });
  const payload = new Uint8Array([1, 2]);
  for (const source of ['kernel-software', 'kernel-software', 'kernel-hardware', 'kernel-software']) {
    client._handleStreamMessage(makeStreamMetadataFrame(STREAM_INDEX, payload, 1.5, source, 1_700_000_000_000));
  }
  assert.deepEqual(sources, ['kernel-software', 'kernel-software', 'kernel-hardware', 'kernel-software']);
});
