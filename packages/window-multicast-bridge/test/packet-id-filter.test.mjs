// Subscription.setPacketIds on the bridge (frozen v1 window.multicast
// contract): replace one consumer's MMTP packet-ID filter without rejoining.
//
// A bridge server keeps one subscription per endpoint and session, so every
// consumer of that endpoint shares it. The server forwards the union of the
// consumers' lists (set_packet_ids replaces it in place), and each consumer is
// delivered only its own list. Before this, a second consumer with a different
// list silently inherited the first consumer's filter.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { BridgeClient, subscribeMulticastBridgeBytes } from '../src/multicast-bridge.js';

// The module's shared bytes-subscription registry (a Symbol.for key).
const BRIDGE_BYTES_SUBSCRIPTIONS_KEY = Symbol.for('blockcast.windowMulticastBridge.bytesSubscriptions');

const GROUP = '232.1.1.60';
const PORT = 8000;
const SOURCE = '69.25.95.192';
const SUBSCRIPTION_ID = `${GROUP}:${PORT}@${SOURCE}`;

function mmtpPacket(packetId, marker = 0) {
  return new Uint8Array([0x40, 0x00, packetId >> 8, packetId & 0xff, marker]).buffer;
}

function packetIdOf(event) {
  const bytes = new Uint8Array(event.data ?? event);
  return (bytes[2] << 8) | bytes[3];
}

/**
 * A connected BridgeClient whose server applies filters like the IWA does:
 * the first subscribe installs its list, a duplicate reuses it, and
 * set_packet_ids replaces it. `mutable: false` models a server that predates
 * set_packet_ids (no packet_ids in its subscribe_response).
 */
function fakeServerClient({ mutable = true } = {}) {
  const client = new BridgeClient();
  client.connected = true;
  const server = { filter: undefined, subscribes: [], setPacketIds: [] };
  client._sendSubscribeRequest = async (entry) => {
    // Same precedence as _buildSubscribeMessage: a present subscribePacketIds,
    // even undefined (every packet ID), wins over the entry's own list.
    const requested = 'subscribePacketIds' in entry
      ? entry.subscribePacketIds
      : entry.transportOpts.packetIds;
    server.subscribes.push(requested);
    if (server.subscribes.length === 1 || server.reset) {
      server.filter = requested ? [...requested] : [];
      server.reset = false;
    }
    return {
      subscriptionId: SUBSCRIPTION_ID,
      transport: 'amt',
      ...(mutable ? { packetIds: [...server.filter], packetIdsMutable: true } : {}),
    };
  };
  client._requestControl = async (msg) => {
    assert.equal(msg.type, 'set_packet_ids');
    assert.equal(msg.subscription_id, SUBSCRIPTION_ID);
    server.setPacketIds.push(msg.packet_ids);
    server.filter = [...msg.packet_ids];
    return { success: true, subscription_id: SUBSCRIPTION_ID, packet_ids: [...msg.packet_ids] };
  };
  client._sendUnsubscribeRequest = async () => {};
  // Deliver what the server's filter admits, the way the IWA enqueues it.
  const deliver = (packetIds) => {
    const admitted = packetIds.filter((id) => server.filter.length === 0 || server.filter.includes(id));
    client.subscriptionCallbacks.get(SUBSCRIPTION_ID)?.onpackets(
      admitted.map((id) => ({ data: mmtpPacket(id) })),
    );
  };
  return { client, server, deliver };
}

function collect(subscription) {
  const received = [];
  subscription.setCallbacks({
    onpackets(events) { for (const event of events) received.push(packetIdOf(event)); },
  });
  return received;
}

test('subscribe_response reports the filter in force and whether it is replaceable', () => {
  const client = new BridgeClient();
  const results = [];
  for (const [id, fields] of [
    ['r1', { packet_ids: [2, 4], packet_ids_mutable: true }],
    ['r2', { packet_ids: [] }],
    ['r3', {}],
  ]) {
    client.pendingRequests.set(id, { resolve: (value) => results.push(value), reject: assert.fail });
    client._handleControlMessage(JSON.stringify({
      type: 'subscribe_response', request_id: id, success: true, subscription_id: 'sub', ...fields,
    }));
  }
  assert.deepEqual(results[0].packetIds, [2, 4]);
  assert.equal(results[0].packetIdsMutable, true);
  assert.deepEqual(results[1].packetIds, []);
  assert.equal(results[1].packetIdsMutable, false);
  assert.equal('packetIds' in results[2], false, 'an older server reports nothing');
});

test('set_packet_ids_response settles its pending request', () => {
  const client = new BridgeClient();
  let settled;
  client.pendingRequests.set('req-set', { resolve: (value) => { settled = value; }, reject: assert.fail });
  client._handleControlMessage(JSON.stringify({
    type: 'set_packet_ids_response', request_id: 'req-set', success: true, packet_ids: [3],
  }));
  assert.deepEqual(settled.packet_ids, [3]);
  assert.equal(client.pendingRequests.has('req-set'), false);
});

test('a second entry widens the shared server filter and each entry gets only its own packets', async () => {
  const { client, server, deliver } = fakeServerClient();
  const video = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 32769] });
  const audio = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4, 32772] });
  assert.deepEqual(server.setPacketIds, [[1, 32769, 4, 32772]]);
  const videoPackets = collect(video);
  const audioPackets = collect(audio);

  deliver([1, 4, 2, 32769, 32772]);
  assert.deepEqual(videoPackets, [1, 32769]);
  assert.deepEqual(audioPackets, [4, 32772]);
});

test('setPacketIds switches a rendition make-before-break without a rejoin', async () => {
  const { client, server, deliver } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3, 4] });
  const received = collect(sub);

  await sub.setPacketIds([3, 4, 1]);
  deliver([1, 2, 3, 4]);
  await sub.setPacketIds([1, 4]);
  deliver([1, 2, 3, 4]);

  assert.deepEqual(server.subscribes, [[3, 4]], 'no rejoin');
  assert.deepEqual(server.setPacketIds, [[3, 4, 1], [1, 4]]);
  assert.deepEqual(received, [1, 3, 4, 1, 4]);

  await sub.setPacketIds([]);
  assert.deepEqual(server.setPacketIds.at(-1), [], 'an empty list forwards every packet ID');
});

test('setPacketIds refuses packet_id 0 and non-lists without touching the server', async () => {
  const { client, server } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3] });
  for (const bad of [[0, 3], [70000], 'all', undefined]) {
    await assert.rejects(sub.setPacketIds(bad), (error) => {
      assert.equal(error.name, 'MulticastError');
      assert.equal(error.code, 'subscription-failed');
      return true;
    });
  }
  assert.deepEqual(server.setPacketIds, []);
});

test('unsubscribing one entry narrows the server filter to the rest', async () => {
  const { client, server } = fakeServerClient();
  const video = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4] });
  await video.unsubscribe();
  await Promise.all(client._packetIdFilterChains.values());
  assert.deepEqual(server.setPacketIds, [[1, 4], [4]]);
});

test('a failed set_packet_ids keeps the entry on its previous filter', async () => {
  const { client, server, deliver } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3] });
  const received = collect(sub);
  client._requestControl = async () => ({ success: false, error: 'refused' });

  await assert.rejects(sub.setPacketIds([1]), { code: 'subscription-failed', message: 'refused' });
  deliver([1, 3]);
  assert.deepEqual(received, [3]);
  assert.deepEqual(server.filter, [3]);
});

test('overlapping setPacketIds calls apply in order and a failure rolls back only its own list', async () => {
  const { client, server, deliver } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3] });
  const received = collect(sub);
  let calls = 0;
  const accept = client._requestControl;
  client._requestControl = async (msg) => {
    calls += 1;
    if (calls === 1) return { success: false, error: 'refused' };
    return accept(msg);
  };

  const first = sub.setPacketIds([1]);
  const second = sub.setPacketIds([2]);
  await assert.rejects(first, { message: 'refused' });
  await second;

  assert.deepEqual(server.setPacketIds, [[2]], 'the second call was sent its own list');
  deliver([1, 2, 3]);
  assert.deepEqual(received, [2], 'and the first failure did not roll it back');
});

test('an older server narrows on the page and refuses a list it does not forward', async () => {
  const { client, server, deliver } = fakeServerClient({ mutable: false });
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 3, 4] });
  const received = collect(sub);

  await sub.setPacketIds([3, 4]);
  deliver([1, 3, 4]);
  assert.deepEqual(received, [3, 4], 'narrowed on the page');

  await assert.rejects(sub.setPacketIds([2]), { code: 'capability-unsupported' });
  deliver([1, 3, 4]);
  assert.deepEqual(received, [3, 4, 3, 4], 'kept its previous filter');
  assert.deepEqual(server.setPacketIds, [], 'never sent set_packet_ids');
});

test('setPacketIds reports the wider filter an immutable receiver keeps', async () => {
  const { client } = fakeServerClient({ mutable: false });
  const sub = await client.subscribe(GROUP, PORT, SOURCE, {
    mode: 'tunnel', packetIds: [1, 3, 4],
  });

  assert.deepEqual(await sub.setPacketIds([3, 4]), [1, 3, 4]);
});

test('a repeat subscribe asks for the union of every entry on the endpoint', async () => {
  const { client, server } = fakeServerClient();
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4] });
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel' });
  assert.deepEqual(server.subscribes, [[1], [1, 4], undefined],
      'a server that replaces on repeat installs a filter covering everyone');
});

test('after a repeat subscribe to an older server every entry filters on the page', async () => {
  const { client } = fakeServerClient({ mutable: false });
  const video = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const audio = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 4] });
  const videoPackets = collect(video);
  const audioPackets = collect(audio);
  // Whichever filter the server kept, no entry sees a packet it did not ask for.
  client.subscriptionCallbacks.get(SUBSCRIPTION_ID).onpackets(
    [1, 2, 4].map((id) => ({ data: mmtpPacket(id) })),
  );
  assert.deepEqual(videoPackets, [1]);
  assert.deepEqual(audioPackets, [1, 4]);
  await assert.rejects(video.setPacketIds([1, 4]), { code: 'capability-unsupported' });
});

test('a union over the bridges\' 64-ID cap forwards every packet ID and still filters per entry', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { client, server, deliver } = fakeServerClient();
  const low = Array.from({ length: 40 }, (_, i) => i + 1);
  const high = Array.from({ length: 40 }, (_, i) => i + 101);
  const a = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: low });
  const b = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: high });
  assert.equal(server.subscribes[1], undefined, 'the repeat subscribe asks for everything, not 80 IDs');
  assert.deepEqual(server.setPacketIds, [[]], 'and the server is widened to everything');
  const aPackets = collect(a);
  const bPackets = collect(b);
  deliver([1, 101, 250]);
  assert.deepEqual(aPackets, [1]);
  assert.deepEqual(bPackets, [101]);
  // Once, where "every packet ID" was sent; a steady over-cap endpoint's
  // later reconciles send nothing and stay quiet.
  await a.setPacketIds([...low, 2000]);
  await client._reconcilePacketIdFilter(SUBSCRIPTION_ID);
  const capWarnings = warn.mock.calls.filter((call) => /over the bridges' 64/.test(call.arguments[0]));
  assert.equal(capWarnings.length, 1);
});

// The IWA and native bridge tests pin their caps to this same vector, so the
// page's copy of the cap cannot drift from theirs unnoticed.
const PACKET_ID_CONTRACT = JSON.parse(readFileSync(
  new URL('./vectors/packet-id-allow-list-v1.json', import.meta.url),
  'utf8',
));

test('setPacketIds applies the bridges\' shared packet-ID cap locally', async () => {
  const { client, server } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3] });
  const max = PACKET_ID_CONTRACT.maxPacketIds;
  await assert.rejects(
    sub.setPacketIds(Array.from({ length: max + 1 }, (_, i) => i + 1)),
    { code: 'subscription-failed', message: PACKET_ID_CONTRACT.errors.tooMany },
  );
  assert.deepEqual(server.setPacketIds, []);
  await sub.setPacketIds(Array.from({ length: max }, (_, i) => i + 1));
  assert.equal(server.setPacketIds.at(-1).length, max, 'exactly the cap is accepted');
});

test('a filter change queued before a reconnect stays serialized with the new subscription', async () => {
  const { client } = fakeServerClient();
  const replayed = `${SUBSCRIPTION_ID}#replayed`;
  const sent = [];
  let releaseStuck;
  client._requestControl = (msg) => {
    sent.push([msg.subscription_id, msg.packet_ids]);
    if (sent.length === 1) {
      return new Promise((resolve) => {
        releaseStuck = () => resolve({ success: true, packet_ids: msg.packet_ids });
      });
    }
    return Promise.resolve({ success: true, packet_ids: msg.packet_ids });
  };
  const a = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const stuck = a.setPacketIds([1, 2]);
  const queued = a.setPacketIds([3]);
  await Promise.resolve();

  // Reconnect replay reassigns the server id of every entry on the endpoint.
  const entries = client._desiredSubscriptions.get(SUBSCRIPTION_ID);
  client._desiredSubscriptions.delete(SUBSCRIPTION_ID);
  client._desiredSubscriptions.set(replayed, entries);
  for (const entry of entries) entry.subscriptionId = replayed;
  // The replayed subscribe reported the pre-change filter, so a reconcile for
  // the new id has work to send.
  client._serverPacketIdFilters.set(replayed, { known: true, mutable: true, packetIds: new Set([1]) });
  const narrowing = client._reconcilePacketIdFilter(replayed);
  await Promise.resolve();
  assert.equal(sent.length, 1, 'nothing for the replayed id runs while the endpoint is busy');

  releaseStuck();
  await Promise.all([stuck, queued, narrowing]);
  assert.deepEqual(sent, [[SUBSCRIPTION_ID, [1, 2]], [replayed, [3]]]);
});

test('a server that cannot replace this filter degrades a join to page filtering', async () => {
  const { client, server, deliver } = fakeServerClient();
  const video = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 4] });
  // The IWA after evicting the stream's consumer: still reports a replaceable
  // filter, then refuses to replace it.
  client._requestControl = async () => ({
    success: false, code: 'capability-unsupported', error: 'no packet-ID filterable stream',
  });
  const audio = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4] });
  const videoPackets = collect(video);
  const audioPackets = collect(audio);
  deliver([1, 4]);
  assert.deepEqual(videoPackets, [1, 4]);
  assert.deepEqual(audioPackets, [4], 'the join resolved and filters on the page');
  await assert.rejects(audio.setPacketIds([2]), { code: 'capability-unsupported' });
  assert.deepEqual(server.filter, [1, 4]);
});

test('a stuck filter change on one endpoint does not hold back another', async () => {
  const { client } = fakeServerClient();
  const other = `${GROUP}:${PORT + 2}@${SOURCE}`;
  const sent = [];
  let releaseStuck;
  client._sendSubscribeRequest = async (entry) => ({
    subscriptionId: `${GROUP}:${entry.port}@${SOURCE}`,
    packetIds: [...(entry.transportOpts.packetIds ?? [])],
    packetIdsMutable: true,
  });
  client._requestControl = (msg) => {
    sent.push(msg.subscription_id);
    if (msg.subscription_id === SUBSCRIPTION_ID) {
      return new Promise((resolve) => { releaseStuck = () => resolve({ success: true, packet_ids: msg.packet_ids }); });
    }
    return Promise.resolve({ success: true, packet_ids: msg.packet_ids });
  };
  const stuck = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const free = await client.subscribe(GROUP, PORT + 2, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const pending = stuck.setPacketIds([2]);
  await free.setPacketIds([3]);
  assert.deepEqual(sent, [SUBSCRIPTION_ID, other]);
  releaseStuck();
  await pending;
});

test('the subscribe message carries the endpoint union, and no list when one entry wants everything', async () => {
  const client = new BridgeClient();
  client.connected = true;
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://example.test/player.html' };
  const sent = [];
  client._sendControl = (msg) => {
    sent.push(msg);
    if (msg.type === 'subscribe') {
      queueMicrotask(() => client._handleControlMessage(JSON.stringify({
        type: 'subscribe_response', request_id: msg.request_id, success: true,
        subscription_id: SUBSCRIPTION_ID, packet_ids: [1], packet_ids_mutable: true,
      })));
    } else if (msg.type === 'set_packet_ids') {
      queueMicrotask(() => client._handleControlMessage(JSON.stringify({
        type: 'set_packet_ids_response', request_id: msg.request_id, success: true,
        subscription_id: SUBSCRIPTION_ID, packet_ids: msg.packet_ids,
      })));
    }
    return true;
  };
  try {
    await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
    await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4] });
    await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel' });
    const subscribes = sent.filter((msg) => msg.type === 'subscribe');
    assert.deepEqual(subscribes.map((msg) => msg.packet_ids), [[1], [1, 4], undefined]);
    assert.equal('packet_ids' in subscribes[2], false);
    assert.deepEqual(
      sent.filter((msg) => msg.type === 'set_packet_ids').map((msg) => msg.packet_ids),
      [[1, 4], []],
    );
  } finally {
    globalThis.location = previousLocation;
  }
});

test('replay after reconnect subscribes with the union of the shared entries', async () => {
  const { client, server } = fakeServerClient();
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [4] });
  client._serverPacketIdFilters.clear();
  server.reset = true;
  await client._replayActiveSubscriptions(null);
  assert.deepEqual(server.subscribes.at(-1), [1, 4]);
  assert.deepEqual(client._serverPacketIdFilters.get(SUBSCRIPTION_ID).packetIds, new Set([1, 4]));
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * Hold every set_packet_ids acknowledgement until `ack` resolves. The server
 * has already applied the filter by then, as both bridges do before acking,
 * so the shared stream carries the new list while the page still waits.
 */
function holdSetPacketIdsAcks(client) {
  const applied = deferred();
  const ack = deferred();
  const accept = client._requestControl;
  client._requestControl = async (msg) => {
    const response = await accept(msg);
    applied.resolve();
    await ack.promise;
    return response;
  };
  return { applied: applied.promise, release: ack.resolve };
}

test('a sole entry never receives a joining entry\'s packet IDs while the widening ack is pending', async () => {
  const { client, server, deliver } = fakeServerClient();
  const a = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  const aPackets = collect(a);
  assert.deepEqual(client._serverPacketIdFilters.get(SUBSCRIPTION_ID).packetIds, new Set([1, 2]),
      'the server filters exactly for A');

  const acks = holdSetPacketIdsAcks(client);
  const joining = client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [3, 4] });
  await acks.applied;
  assert.deepEqual(server.filter, [1, 2, 3, 4], 'the shared stream now carries B\'s packets');
  deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2], 'A got none of B\'s packet IDs before the ack');

  acks.release();
  const b = await joining;
  const bPackets = collect(b);
  deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2, 1, 2]);
  assert.deepEqual(bPackets, [3, 4]);
});

test('an entry never receives a sibling\'s widened packet IDs while that setPacketIds is pending', async () => {
  const { client, server, deliver } = fakeServerClient();
  const a = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  const b = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  assert.deepEqual(server.setPacketIds, [], 'the same list needed no widening');
  const aPackets = collect(a);
  const bPackets = collect(b);

  const acks = holdSetPacketIdsAcks(client);
  const switching = b.setPacketIds([1, 2, 3, 4]);
  await acks.applied;
  deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2], 'A got none of B\'s new packet IDs before the ack');
  assert.deepEqual(bPackets, [1, 2, 3, 4], 'B already gets the packets it switched to');

  acks.release();
  await switching;
  deliver([3]);
  assert.deepEqual(aPackets, [1, 2]);
  assert.deepEqual(bPackets, [1, 2, 3, 4, 3]);
});

test('a join answered inside a setPacketIds round trip still gets its packets once both settle', async () => {
  const { client, server, deliver } = fakeServerClient();
  const e = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2, 3] });
  const ePackets = collect(e);

  // Hold set_packet_ids until the server has answered the join below, so the
  // join's duplicate reports the filter still in force, [1, 2, 3].
  const sent = deferred();
  const gate = deferred();
  const accept = client._requestControl;
  client._requestControl = async (msg) => {
    sent.resolve();
    await gate.promise;
    return accept(msg);
  };
  const narrowing = e.setPacketIds([1]);
  await sent.promise;
  const joining = client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [2, 3] });
  await new Promise(setImmediate);
  assert.deepEqual(server.filter, [1, 2, 3], 'the join was answered before the narrowing applied');

  gate.resolve();
  const f = await joining;
  await narrowing;
  const fPackets = collect(f);
  assert.deepEqual(server.setPacketIds, [[1], [1, 2, 3]], 'the join re-widened what the narrowing removed');
  deliver([1, 2, 3]);
  assert.deepEqual(ePackets, [1]);
  assert.deepEqual(fPackets, [2, 3]);
});

/** Wait until no packet-ID filter change is queued on any endpoint. */
async function settleFilterChanges(client) {
  while (client._packetIdFilterChains.size > 0) {
    await [...client._packetIdFilterChains.values()][0];
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a refusal applied after a sibling\'s newer subscribe report does not freeze the refreshed filter', async (t) => {
  const previousLocation = globalThis.location;
  globalThis.location = { href: 'https://page.example/' };
  t.after(() => { globalThis.location = previousLocation; });
  const client = new BridgeClient();
  client.connected = true;
  const sent = [];
  client._sendControl = (msg) => { sent.push(msg); return true; };
  const reply = (msg) => client._handleControlMessage(JSON.stringify(msg));
  const lastSent = (type) => sent.findLast((msg) => msg.type === type);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const subscribingE = client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  await tick();
  reply({ type: 'subscribe_response', request_id: lastSent('subscribe').request_id, success: true,
    subscription_id: SUBSCRIPTION_ID, packet_ids: [1], packet_ids_mutable: true });
  const e = await subscribingE;
  const eReceived = collect(e);

  // The native bridge has released E's subscription without telling the page.
  const widening = e.setPacketIds([2]);
  await tick();
  const refusedSet = lastSent('set_packet_ids');
  const subscribingF = client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [5] });
  await tick();
  const fSubscribe = lastSent('subscribe');
  // Server order: E's set is refused, then F's subscribe creates a fresh
  // subscription with the list it carried. Both frames arrive in one read,
  // and the page resumes the subscribe before the refusal.
  let serverFilter = fSubscribe.packet_ids;
  reply({ type: 'set_packet_ids_response', request_id: refusedSet.request_id, success: false,
    subscription_id: SUBSCRIPTION_ID, code: 'capability-unsupported', error: 'Unknown subscription' });
  reply({ type: 'subscribe_response', request_id: fSubscribe.request_id, success: true,
    subscription_id: SUBSCRIPTION_ID, packet_ids: serverFilter, packet_ids_mutable: true });
  await assert.rejects(widening, { code: 'capability-unsupported' });

  const answered = new Set([refusedSet]);
  let fSettled = false;
  subscribingF.then(() => { fSettled = true; }, () => { fSettled = true; });
  while (!fSettled) {
    await tick();
    for (const msg of sent) {
      if (msg.type !== 'set_packet_ids' || answered.has(msg)) continue;
      answered.add(msg);
      serverFilter = msg.packet_ids;
      reply({ type: 'set_packet_ids_response', request_id: msg.request_id, success: true,
        subscription_id: SUBSCRIPTION_ID, packet_ids: msg.packet_ids });
    }
  }
  const f = await subscribingF;
  const fReceived = collect(f);
  assert.equal(client._serverPacketIdFilters.get(SUBSCRIPTION_ID).mutable, true,
      'the refusal described the released subscription, not the fresh one');
  assert.deepEqual(serverFilter, [1, 5], 'the join widened the fresh subscription for both entries');
  client.subscriptionCallbacks.get(SUBSCRIPTION_ID).onpackets(
    [1, 2, 5].filter((id) => serverFilter.includes(id)).map((id) => ({ data: mmtpPacket(id) })),
  );
  assert.deepEqual(eReceived, [1]);
  assert.deepEqual(fReceived, [5]);
});

test('a setPacketIds made while a reconnect replays the subscription reaches the server once the replay lands', async () => {
  const { client, server, deliver } = fakeServerClient();
  const e = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  const received = collect(e);
  client.disconnect({ preserveSubscriptions: true, notifySubscriptions: false, intentional: false });
  client.connected = true;
  server.reset = true;
  // Hold the replayed subscribe on the wire.
  const onWire = deferred();
  const land = deferred();
  const subscribe = client._sendSubscribeRequest;
  client._sendSubscribeRequest = async (...args) => {
    client._sendSubscribeRequest = subscribe;
    const result = await subscribe(...args);
    onWire.resolve();
    await land.promise;
    return result;
  };
  const replay = client._replayActiveSubscriptions(null);
  await onWire.promise;

  const widening = e.setPacketIds([1, 2, 3]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(server.setPacketIds, [], 'nothing is sent before the replay records the server filter');
  land.resolve();
  await replay;
  await widening;
  await settleFilterChanges(client);
  assert.deepEqual(server.setPacketIds, [[1, 2, 3]], 'the widening made during the replay was sent after it');
  deliver([1, 2, 3]);
  assert.deepEqual(received, [1, 2, 3]);
});

test('a widening made while a reconnect replays an older server\'s subscription is refused, as outside a replay', async () => {
  const { client, server, deliver } = fakeServerClient({ mutable: false });
  const e = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  const received = collect(e);
  client.disconnect({ preserveSubscriptions: true, notifySubscriptions: false, intentional: false });
  client.connected = true;
  server.reset = true;
  const onWire = deferred();
  const land = deferred();
  const subscribe = client._sendSubscribeRequest;
  client._sendSubscribeRequest = async (...args) => {
    client._sendSubscribeRequest = subscribe;
    const result = await subscribe(...args);
    onWire.resolve();
    await land.promise;
    return result;
  };
  const replay = client._replayActiveSubscriptions(null);
  await onWire.promise;

  const widening = e.setPacketIds([1, 2, 3]);
  land.resolve();
  await replay;
  await assert.rejects(widening, { code: 'capability-unsupported' });
  deliver([1, 2, 3]);
  assert.deepEqual(received, [1, 2], 'kept its previous list');
  assert.deepEqual(server.setPacketIds, []);
});

test('a setPacketIds whose acknowledgement never arrives restores its previous list on the server', async () => {
  const { client, server, deliver } = fakeServerClient();
  const e = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2, 3] });
  const received = collect(e);
  const accept = client._requestControl;
  client._requestControl = async (msg) => {
    client._requestControl = accept;
    await accept(msg); // The server applies the list...
    throw new Error('set_packet_ids timeout'); // ...and its acknowledgement is lost.
  };
  await assert.rejects(e.setPacketIds([1]), { code: 'subscription-failed' });
  await settleFilterChanges(client);
  assert.deepEqual(server.setPacketIds, [[1], [1, 2, 3]], 'the previous list was sent again');
  deliver([1, 2, 3]);
  assert.deepEqual(received, [1, 2, 3], 'the previous list is in force on the server too');
});

const TUNER_SUBSCRIPTION_ID = 'tuner:atsc1:mpeg-ts';
const atsc1TunerOpts = Object.freeze({ origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts' });

/** A 188-byte MPEG-TS packet: sync byte, PID 0x1100 + i. Not MMTP. */
function tsPacket(i) {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = 0x51;
  packet[2] = i;
  packet[3] = 0x10;
  return packet.buffer;
}

/**
 * A connected BridgeClient holding an addressless ATSC 1.0 tuner
 * subscription. `subscribeFields` is what the subscribe_response reported:
 * nothing (an IWA that predates packet-ID reporting) or the explicit
 * non-replaceable marker.
 */
function tunerServerClient(subscribeFields) {
  const client = new BridgeClient();
  client.connected = true;
  const setPacketIds = [];
  client._sendSubscribeRequest = async () => ({
    subscriptionId: TUNER_SUBSCRIPTION_ID,
    ...subscribeFields,
  });
  client._requestControl = async (msg) => {
    setPacketIds.push(msg.packet_ids);
    return { success: true, subscription_id: TUNER_SUBSCRIPTION_ID, packet_ids: msg.packet_ids };
  };
  client._sendUnsubscribeRequest = async () => {};
  const deliver = (count) => client.subscriptionCallbacks.get(TUNER_SUBSCRIPTION_ID).onpackets(
    Array.from({ length: count }, (_, i) => ({ data: tsPacket(i) })),
  );
  return { client, setPacketIds, deliver };
}

test('subscribe_response distinguishes a filter that cannot be replaced from an unreported one', () => {
  const client = new BridgeClient();
  let result;
  client.pendingRequests.set('r1', { resolve: (value) => { result = value; }, reject: assert.fail });
  client._handleControlMessage(JSON.stringify({
    type: 'subscribe_response', request_id: 'r1', success: true,
    subscription_id: TUNER_SUBSCRIPTION_ID, packet_ids_mutable: false,
  }));
  assert.equal(result.packetIdsMutable, false);
  assert.equal('packetIds' in result, false, 'no packet-ID filter is in force at all');
});

for (const [label, subscribeFields] of [
  ['an IWA that reports no packet-ID filter', {}],
  ['an IWA that marks the filter as not replaceable', { packetIdsMutable: false }],
]) {
  test(`setPacketIds on an ATSC 1.0 tuner subscription is capability-unsupported (${label})`, async () => {
    const { client, setPacketIds, deliver } = tunerServerClient(subscribeFields);
    const sub = await client.subscribe(undefined, undefined, undefined, atsc1TunerOpts);
    const received = [];
    sub.setCallbacks({ onpackets(events) { received.push(...events); } });

    await assert.rejects(sub.setPacketIds([100]), (error) => {
      assert.equal(error.name, 'MulticastError');
      assert.equal(error.code, 'capability-unsupported');
      return true;
    });
    assert.deepEqual(setPacketIds, [], 'never asked the bridge');
    const [entry] = client._desiredSubscriptions.get(TUNER_SUBSCRIPTION_ID);
    assert.equal(entry.clientPacketIdFilter ?? null, null, 'no MMTP filter over MPEG-TS bytes');
    assert.equal(entry.transportOpts.packetIds, undefined, 'the entry keeps its (absent) list');

    deliver(3);
    assert.equal(received.length, 3, 'every MPEG-TS packet is still delivered');
  });
}

test('a narrowing setPacketIds resolves even where the server filter is unknown', async () => {
  const { client, server } = fakeServerClient({ mutable: false });
  const video = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const audio = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 4] });
  assert.equal(audio.packetIdsMutable, false,
      'the page can distinguish an immutable physical filter from page-side filtering');
  assert.equal(client._serverPacketIdFilters.get(SUBSCRIPTION_ID).known, false);
  const videoPackets = collect(video);
  const audioPackets = collect(audio);

  await audio.setPacketIds([4]);
  client.subscriptionCallbacks.get(SUBSCRIPTION_ID).onpackets(
    [1, 2, 4].map((id) => ({ data: mmtpPacket(id) })),
  );
  assert.deepEqual(audioPackets, [4], 'narrowed on the page');
  assert.deepEqual(videoPackets, [1]);
  // A list that needs a packet the entry was not asking for still does.
  await assert.rejects(audio.setPacketIds([4, 9]), { code: 'capability-unsupported' });
  assert.deepEqual(server.setPacketIds, [], 'never sent set_packet_ids');
});

test('an entry whose filter admits the whole batch is handed the batch itself', async () => {
  const { client } = fakeServerClient();
  const sub = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  const batches = [];
  sub.setCallbacks({ onpackets(events) { batches.push(events); } });
  const batch = [1, 2, 1].map((id) => ({ data: mmtpPacket(id) }));
  client.subscriptionCallbacks.get(SUBSCRIPTION_ID).onpackets(batch);
  assert.equal(batches[0], batch, 'no per-consumer copy when nothing is filtered out');
});

/** A WebTransport stream frame for stream index 0 carrying one MMTP packet. */
function streamFrame(packetId) {
  return new Uint8Array([0x00, 0x00, 0x40, 0x00, packetId >> 8, packetId & 0xff, 0x00]);
}

/** Run `fn` counting every Uint8Array constructed while it runs. */
function countUint8ArrayConstructions(fn) {
  const RealUint8Array = globalThis.Uint8Array;
  let constructed = 0;
  globalThis.Uint8Array = new Proxy(RealUint8Array, {
    construct(target, args) {
      constructed++;
      return Reflect.construct(target, args);
    },
  });
  try {
    fn();
  } finally {
    globalThis.Uint8Array = RealUint8Array;
  }
  return constructed;
}

test('filtered delivery reads each packet ID at ingest and allocates no view per packet on either layer', async () => {
  const { client } = fakeServerClient();
  // A sole window.multicast bytes consumer: one BridgeClient entry and one
  // shared-layer consumer, each filtering by the list the server applies.
  const sub = await subscribeMulticastBridgeBytes(client, { ...bytesConfig, packetIds: [1, 2] });
  const [entry] = client._desiredSubscriptions.get(SUBSCRIPTION_ID);
  assert.deepEqual([...entry.clientPacketIdFilter], [1, 2], 'the BridgeClient layer filters');
  const [shared] = [...client[BRIDGE_BYTES_SUBSCRIPTIONS_KEY].values()];
  assert.deepEqual([...[...shared.refs][0].packetIdFilter], [1, 2], 'the shared layer filters too');
  const batches = [];
  sub.addEventListener('packets', (event) => batches.push(event.detail));
  client._streamSubscriptions.set(0, SUBSCRIPTION_ID);

  const frames = Array.from({ length: 1000 }, (_, i) => streamFrame(1 + (i % 2)));
  const views = countUint8ArrayConstructions(() => {
    client._beginPacketBatch();
    for (const frame of frames) client._handleStreamMessage(frame);
    client._endPacketBatch();
  });

  assert.equal(views, 0, 'no Uint8Array view is constructed per delivered packet');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(packetIdOf), frames.map((_, i) => 1 + (i % 2)));
  for (const detail of batches[0]) {
    assert.ok(detail instanceof ArrayBuffer, 'the detail shape is unchanged');
  }

  client._handleStreamMessage(streamFrame(3));
  assert.equal(batches.length, 1, 'a packet ID outside the list is still dropped');
  await sub.unsubscribe();
});

test('a packet event keeps its public shape: the ingest packet ID is invisible to keys, JSON and clone', () => {
  const { client } = fakeServerClient();
  const events = [];
  client.subscriptionCallbacks.set(SUBSCRIPTION_ID, { onpackets(batch) { events.push(...batch); } });
  client._streamSubscriptions.set(0, SUBSCRIPTION_ID);
  client._handleStreamMessage(streamFrame(7));
  client._handleStreamMessage(new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00]));
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event), ['data']);
    assert.deepEqual(Object.keys(structuredClone(event)), ['data']);
    assert.equal(JSON.stringify(event), '{"data":{}}');
    let forIn = 0;
    for (const key in event) forIn += key === 'data' ? 1 : 100;
    assert.equal(forIn, 1);
  }
});

// ── window.multicast bytes subscriptions ──────────────────────────────────────

function nativeBridge() {
  const calls = { subscribe: [], setPacketIds: [], unsubscribe: 0 };
  let callbacks;
  const bridge = {
    calls,
    async subscribe(group, port, source, transportOpts) {
      calls.subscribe.push(transportOpts.packetIds);
      return {
        subscriptionId: 'native-1',
        transport: 'amt',
        active: true,
        setCallbacks(cbs) { callbacks = cbs; },
        async setPacketIds(packetIds) { calls.setPacketIds.push(packetIds); },
        async unsubscribe() { calls.unsubscribe++; },
      };
    },
    deliver(packetIds) {
      callbacks.onpackets(packetIds.map((id) => ({ data: mmtpPacket(id) })));
    },
  };
  return bridge;
}

const bytesConfig = Object.freeze({ consume: 'bytes', group: GROUP, port: PORT, source: SOURCE, origin: 'amt' });

function collectBytes(sub) {
  const received = [];
  sub.addEventListener('packets', (event) => {
    for (const detail of event.detail) received.push(packetIdOf(detail));
  });
  return received;
}

test('consumers with different lists share one receiver that forwards their union', async () => {
  const bridge = nativeBridge();
  const shaka = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2, 3, 4] });
  const moqtail = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [3, 4] });
  const lossless = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [9] });
  assert.deepEqual(bridge.calls.subscribe, [[1, 2, 3, 4]], 'one bridge subscription');
  assert.deepEqual(bridge.calls.setPacketIds, [[1, 2, 3, 4, 9]]);

  const shakaPackets = collectBytes(shaka);
  const moqtailPackets = collectBytes(moqtail);
  const losslessPackets = collectBytes(lossless);
  bridge.deliver([1, 3, 9]);
  assert.deepEqual(shakaPackets, [1, 3]);
  assert.deepEqual(moqtailPackets, [3]);
  assert.deepEqual(losslessPackets, [9]);

  await lossless.unsubscribe();
  await Promise.resolve();
  assert.deepEqual(bridge.calls.setPacketIds.at(-1), [1, 2, 3, 4], 'narrowed when a consumer left');
  await shaka.unsubscribe();
  await moqtail.unsubscribe();
  assert.equal(bridge.calls.unsubscribe, 1);
});

test('a bytes subscription rejects setPacketIds its receiver cannot apply', async () => {
  // A receiver without setPacketIds, and then one that is no longer active.
  const receiver = {
    subscriptionId: 'legacy', transport: 'amt', active: true,
    setCallbacks() {}, async unsubscribe() {},
  };
  const bridge = { async subscribe() { return receiver; } };
  const sub = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [3] });
  await assert.rejects(sub.setPacketIds([4]), { code: 'capability-unsupported' });

  receiver.setPacketIds = async () => assert.fail('an inactive receiver is not updated');
  receiver.active = false;
  await assert.rejects(sub.setPacketIds([4]), { code: 'subscription-failed' });
  await sub.unsubscribe();
});

test('a bytes subscription whose receiver cannot replace its filter widens back within the list it last requested', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let callbacks;
  const receiver = {
    subscriptionId: 'legacy', transport: 'amt', active: true,
    setCallbacks(cbs) { callbacks = cbs; }, async unsubscribe() {},
  };
  const bridge = { async subscribe() { return receiver; } };
  const sub = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2, 3] });
  const received = collectBytes(sub);
  // The receiver keeps forwarding the list it was subscribed with.
  const deliver = () => callbacks.onpackets([1, 2, 3].map((id) => ({ data: mmtpPacket(id) })));

  await sub.setPacketIds([1]);
  deliver();
  await sub.setPacketIds([1, 2]);
  deliver();
  await sub.setPacketIds([1, 2, 3]);
  deliver();
  assert.deepEqual(received, [1, 1, 2, 1, 2, 3]);

  await assert.rejects(sub.setPacketIds([4]), { code: 'capability-unsupported' });
  deliver();
  assert.deepEqual(received, [1, 1, 2, 1, 2, 3, 1, 2, 3], 'kept its previous list');
  await sub.unsubscribe();
});

test('an inactive bytes receiver refuses setPacketIds even for a list it was carrying', async () => {
  const receiver = {
    subscriptionId: 'legacy', transport: 'amt', active: true,
    setCallbacks() {}, async unsubscribe() {},
  };
  const bridge = { async subscribe() { return receiver; } };
  const sub = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2, 3] });
  await sub.setPacketIds([1]);
  receiver.active = false;
  await assert.rejects(sub.setPacketIds([1, 2]), { code: 'subscription-failed' });
  await sub.unsubscribe();
});

test('a bytes subscription replaces its own list with setPacketIds', async () => {
  const bridge = nativeBridge();
  const sub = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [3, 4] });
  const received = collectBytes(sub);

  await sub.setPacketIds([1, 3, 4]);
  bridge.deliver([1, 3]);
  await sub.setPacketIds([1, 4]);
  bridge.deliver([1, 4]);

  assert.deepEqual(bridge.calls.subscribe, [[3, 4]], 'no rejoin');
  assert.deepEqual(bridge.calls.setPacketIds, [[1, 3, 4], [1, 4]]);
  assert.deepEqual(received, [1, 3, 1, 4]);
  await assert.rejects(sub.setPacketIds([0]), { code: 'subscription-failed' });
  await sub.unsubscribe();
  await assert.rejects(sub.setPacketIds([1]), { code: 'subscription-failed' });
});

/**
 * A native bridge whose receiver forwards whatever `deliver` is given (the
 * wire) and whose setPacketIds applies before it settles: `applied` resolves
 * once the wire carries the new list, `release()` settles the call.
 */
function heldNativeBridge() {
  const calls = { subscribe: [], setPacketIds: [] };
  let callbacks;
  let hold = null;
  const bridge = {
    calls,
    async subscribe(group, port, source, transportOpts) {
      calls.subscribe.push(transportOpts.packetIds);
      return {
        subscriptionId: 'native-held',
        transport: 'amt',
        active: true,
        setCallbacks(cbs) { callbacks = cbs; },
        async setPacketIds(packetIds) {
          calls.setPacketIds.push(packetIds);
          if (!hold) return;
          hold.applied.resolve();
          await hold.ack.promise;
        },
        async unsubscribe() {},
      };
    },
    holdSetPacketIds() {
      hold = { applied: deferred(), ack: deferred() };
      return { applied: hold.applied.promise, release: hold.ack.resolve };
    },
    deliver(packetIds) {
      callbacks.onpackets(packetIds.map((id) => ({ data: mmtpPacket(id) })));
    },
  };
  return bridge;
}

test('a sole bytes consumer never receives a joining consumer\'s packet IDs while the receiver widens', async () => {
  const bridge = heldNativeBridge();
  const a = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2] });
  const aPackets = collectBytes(a);

  const acks = bridge.holdSetPacketIds();
  const joining = subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [3, 4] });
  await acks.applied;
  assert.deepEqual(bridge.calls.setPacketIds, [[1, 2, 3, 4]]);
  bridge.deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2], 'A got none of B\'s packet IDs before the receiver settled');

  acks.release();
  const b = await joining;
  const bPackets = collectBytes(b);
  bridge.deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2, 1, 2]);
  assert.deepEqual(bPackets, [3, 4]);
});

test('a bytes consumer never receives a sibling\'s widened packet IDs while that setPacketIds is pending', async () => {
  const bridge = heldNativeBridge();
  const a = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2] });
  const b = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [1, 2] });
  assert.deepEqual(bridge.calls.setPacketIds, [], 'the same list needed no widening');
  const aPackets = collectBytes(a);
  const bPackets = collectBytes(b);

  const acks = bridge.holdSetPacketIds();
  const switching = b.setPacketIds([1, 2, 3, 4]);
  await acks.applied;
  bridge.deliver([1, 2, 3, 4]);
  assert.deepEqual(aPackets, [1, 2], 'A got none of B\'s new packet IDs');
  assert.deepEqual(bPackets, [1, 2, 3, 4], 'B already gets the packets it switched to');

  acks.release();
  await switching;
  await a.unsubscribe();
  await b.unsubscribe();
});

test('setPacketIds on an ATSC 1.0 tuner bytes subscription is capability-unsupported and delivery continues', async () => {
  const { client, setPacketIds, deliver } = tunerServerClient({});
  const sub = await subscribeMulticastBridgeBytes(client, {
    consume: 'bytes', origin: 'tuner', standard: 'atsc1', protocol: 'mpeg-ts',
  });
  let received = 0;
  sub.addEventListener('packets', (event) => { received += event.detail.length; });

  await assert.rejects(sub.setPacketIds([100]), (error) => {
    assert.equal(error.name, 'MulticastError');
    assert.equal(error.code, 'capability-unsupported');
    return true;
  });
  assert.deepEqual(setPacketIds, [], 'never asked the bridge');
  const [entry] = client._desiredSubscriptions.get(TUNER_SUBSCRIPTION_ID);
  assert.equal(entry.clientPacketIdFilter ?? null, null, 'no MMTP filter over MPEG-TS bytes');

  deliver(3);
  assert.equal(received, 3, 'every MPEG-TS packet is still delivered');
  await sub.unsubscribe();
});

test('a setPacketIds that reaches no live server record resolves null, not an applied list', async () => {
  // A reconnect that preserves the subscription clears the server's filter
  // record until the replayed subscribe reports one. A list sent in that
  // window reaches nothing, so resolving undefined (the older-provider
  // allowance) would let a consumer record a narrowing the receiver never
  // applied; its two guards (applied-list comparison, packetIdsMutable) are
  // both blind on exactly that path.
  const { client, server } = fakeServerClient();
  const e = await client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 2] });
  client.disconnect({ preserveSubscriptions: true, notifySubscriptions: false, intentional: false });
  assert.equal(client._serverPacketIdFilters.has(SUBSCRIPTION_ID), false, 'the record is gone');
  assert.equal(e.packetIdsMutable, undefined, 'and the mutable bit cannot answer either');

  assert.equal(await e.setPacketIds([1]), null, 'nothing reached the bridge');
  assert.deepEqual(server.setPacketIds, [], 'never sent set_packet_ids');

  // An older provider whose filter is unknown still resolves undefined.
  const older = fakeServerClient({ mutable: false });
  await older.client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1] });
  const o = await older.client.subscribe(GROUP, PORT, SOURCE, { mode: 'tunnel', packetIds: [1, 4] });
  assert.equal(older.client._serverPacketIdFilters.get(SUBSCRIPTION_ID).known, false);
  assert.equal(await o.setPacketIds([4]), undefined, 'a server that reports no filter');
});

test('a shared bytes receiver keeps its list when the native setPacketIds reached nothing', async () => {
  // null from the native layer must not advance the shared receiver's
  // believed list, or the next change would short-circuit as already applied
  // and never re-send.
  const bridge = nativeBridge();
  const subscribe = bridge.subscribe.bind(bridge);
  let natives = 0;
  bridge.subscribe = async (...args) => {
    const native = await subscribe(...args);
    const set = native.setPacketIds;
    native.setPacketIds = async (packetIds) => {
      await set(packetIds);
      return natives++ === 0 ? null : [...packetIds];
    };
    return native;
  };
  const sub = await subscribeMulticastBridgeBytes(bridge, { ...bytesConfig, packetIds: [3, 4] });

  assert.equal(await sub.setPacketIds([1, 3, 4]), null, 'passed through, not reported as applied');
  assert.deepEqual(await sub.setPacketIds([1, 3, 4]), [1, 3, 4], 'the same list is sent again');
  assert.deepEqual(bridge.calls.setPacketIds, [[1, 3, 4], [1, 3, 4]]);
  await sub.unsubscribe();
});
