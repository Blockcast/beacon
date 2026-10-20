// A bytes subscription carries the server's declared delivery (window.multicast
// `delivery`). The iOS Beacon's native-bcds-bridge relays each subscription's
// socket reads, in order, on one reliable BCDS uni stream and declares
// `delivery: "ordered-relay"` in its subscribe_response. The page's FEC layer
// (the MMT transport's FECManager) then decides block fate by stream order instead of a
// datagram inactivity deadline: on this stream a 50-200 ms relay pause carries
// no loss information, and the datagram deadline failed ~7-9% of blocks on
// iPhone Safari with only ~0.2% wire loss. Only the server knows whether it
// also sends datagram media, so the client passes the declaration through and
// never infers it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeClient, subscribeMulticastBridgeBytes } from '../src/multicast-bridge.js';

function resolvedSubscribeResponse(fields) {
  const client = new BridgeClient();
  let result;
  client.pendingRequests.set('req-delivery', {
    resolve(value) { result = value; },
    reject(error) { throw error; },
  });
  client._handleControlMessage(JSON.stringify({
    type: 'subscribe_response',
    request_id: 'req-delivery',
    success: true,
    subscription_id: 'sub-delivery',
    ...fields,
  }));
  return result;
}

test('subscribe_response passes through a declared ordered-relay delivery', () => {
  assert.deepEqual(resolvedSubscribeResponse({ stream_index: 7, delivery: 'ordered-relay' }), {
    subscriptionId: 'sub-delivery',
    transport: undefined,
    delivery: 'ordered-relay',
  });
  assert.equal(resolvedSubscribeResponse({ delivery: 'datagram' }).delivery, 'datagram');
});

test('an absent or unknown delivery declaration makes no ordering promise', () => {
  assert.equal('delivery' in resolvedSubscribeResponse({}), false);
  assert.equal('delivery' in resolvedSubscribeResponse({ delivery: 'reliable' }), false);
});

function nativeBridge(delivery) {
  return {
    async subscribe() {
      return {
        subscriptionId: 'native-1',
        transport: 'amt',
        ...(delivery === undefined ? {} : { delivery }),
        setCallbacks() {},
      };
    },
    async unsubscribe() {},
  };
}

const bytesConfig = Object.freeze({
  consume: 'bytes',
  group: '232.1.1.60',
  port: 8000,
  source: '69.25.95.192',
});

test('a bytes subscription exposes the declared delivery to the page', async () => {
  const sub = await subscribeMulticastBridgeBytes(nativeBridge('ordered-relay'), bytesConfig);
  assert.equal(sub.delivery, 'ordered-relay');
  await sub.unsubscribe();
});

test('a bytes subscription without a declaration reports none', async () => {
  const sub = await subscribeMulticastBridgeBytes(nativeBridge(undefined), bytesConfig);
  assert.equal(sub.delivery, undefined);
  await sub.unsubscribe();
});

test('BridgeClient.subscribe keeps the delivery its server declared', async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._sendSubscribeRequest = async () => ({
    subscriptionId: 'sub-declared',
    transport: 'amt',
    delivery: 'ordered-relay',
  });
  const subscription = await client.subscribe('232.1.1.60', 8000, '69.25.95.192', { mode: 'tunnel' });
  assert.equal(subscription.delivery, 'ordered-relay');
});
