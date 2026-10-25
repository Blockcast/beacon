// How the page-side subscribe maps a window.multicast config onto bridge
// transport options: AMT tunnel fields, ATSC 1.0 tuner acquisition, and the
// receiver shared by identical requests.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  multicastBridgeTransportOptionsFromConfig,
  subscribeMulticastBridgeBytes,
} from "../src/multicast-bridge.js";

function makeBridgeClient() {
  const calls = [];
  const results = [];
  return {
    calls,
    results,
    async subscribe(group, port, source, transportOpts) {
      calls.push({ group, port, source, transportOpts });
      const result = {
        subscriptionId: "server-sub-a",
        setCallbacks(callbacks) {
          this.callbacks = callbacks;
        },
      };
      results.push(result);
      return result;
    },
    async unsubscribe(subscriptionId) {
      calls.push({ unsubscribe: subscriptionId });
    },
  };
}

test("multicast bridge transport options follow the canonical origin", () => {
  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      origin: "amt",
      relay: "69.25.95.1",
      relayPort: 2268,
      protocol: "mmtp",
      fec: true,
      reliableBacklog: "latest",
    }),
    {
      protocol: "mmtp",
      fec: true,
      mode: "tunnel",
      origin: "amt",
      amtRelay: "69.25.95.1",
      amtRelayPort: 2268,
      reliableBacklog: "latest",
    },
  );

  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      origin: "ip-multicast",
      mode: "tunnel",
      amtRelay: "69.25.95.1",
      amtRelayPort: 2268,
    }),
    {
      origin: "ip-multicast",
      mode: "native",
    },
  );
});

test("AMT DRIAD discovery survives the page-to-bridge option mapping", () => {
  assert.deepEqual(
    multicastBridgeTransportOptionsFromConfig({
      origin: "amt",
      discovery: "driad",
      source: "69.25.95.198",
    }),
    {
      origin: "amt",
      discovery: "driad",
      mode: "tunnel",
    },
  );
});

test("lowercase bridge preserves ATSC 1.0 tuner acquisition metadata", async () => {
  const bridgeClient = makeBridgeClient();

  await subscribeMulticastBridgeBytes(bridgeClient, {
    consume: "bytes",
    origin: "tuner",
    standard: "atsc1",
    protocol: "mpeg-ts",
    reliableBacklog: "ordered",
  });

  assert.deepEqual(bridgeClient.calls[0].transportOpts, {
    origin: "tuner",
    standard: "atsc1",
    protocol: "mpeg-ts",
    reliableBacklog: "ordered",
  });
  assert.equal(bridgeClient.calls[0].group, undefined);
  assert.equal(bridgeClient.calls[0].port, undefined);
});

test("lowercase bridge rejects a synthetic IP endpoint for ATSC 1.0", async () => {
  const bridgeClient = makeBridgeClient();

  await assert.rejects(
    subscribeMulticastBridgeBytes(bridgeClient, {
      group: "224.0.23.60",
      port: 4937,
      consume: "bytes",
      origin: "tuner",
      standard: "atsc1",
      protocol: "mpeg-ts",
    }),
    /ATSC 1\.0 MPEG-TS is addressless/,
  );
  assert.equal(bridgeClient.calls.length, 0);
});

test("lowercase bytes subscription forwards AMT tunnel options", async () => {
  const bridgeClient = makeBridgeClient();

  const sub = await subscribeMulticastBridgeBytes(bridgeClient, {
    group: "232.99.0.10",
    source: "69.25.95.101",
    port: 5050,
    consume: "bytes",
    origin: "amt",
    relay: "69.25.95.1",
    relayPort: 2268,
    protocol: "mmtp",
    fec: true,
    reliableBacklog: "latest",
  });

  assert.equal(sub.id, "server-sub-a");
  assert.equal(bridgeClient.calls.length, 1);
  assert.deepEqual(bridgeClient.calls[0], {
    group: "232.99.0.10",
    port: 5050,
    source: "69.25.95.101",
    transportOpts: {
      protocol: "mmtp",
      fec: true,
      mode: "tunnel",
      origin: "amt",
      amtRelay: "69.25.95.1",
      amtRelayPort: 2268,
      reliableBacklog: "latest",
    },
  });
});

test("lowercase bytes subscriptions ref-count identical bridge requests", async () => {
  const bridgeClient = makeBridgeClient();
  const config = {
    group: "232.99.0.10",
    source: "69.25.95.101",
    port: 5050,
    consume: "bytes",
    origin: "amt",
    relay: "69.25.95.1",
    relayPort: 2268,
    reliableBacklog: "latest",
  };

  const subA = await subscribeMulticastBridgeBytes(bridgeClient, config);
  const subB = await subscribeMulticastBridgeBytes(bridgeClient, config);
  const seenA = [];
  const seenB = [];
  subA.addEventListener("bytes", (event) => seenA.push(event.detail.byteLength));
  subB.addEventListener("bytes", (event) => seenB.push(event.detail.byteLength));

  assert.equal(bridgeClient.calls.filter((call) => !call.unsubscribe).length, 1);
  bridgeClient.results[0].callbacks.onpacket({ data: new Uint8Array([1, 2, 3]).buffer });
  assert.deepEqual(seenA, [3]);
  assert.deepEqual(seenB, [3]);

  await subA.unsubscribe();
  assert.equal(bridgeClient.calls.filter((call) => call.unsubscribe).length, 0);

  bridgeClient.results[0].callbacks.onpacket({ data: new Uint8Array([4, 5]).buffer });
  assert.deepEqual(seenA, [3]);
  assert.deepEqual(seenB, [3, 2]);

  await subB.unsubscribe();
  assert.deepEqual(bridgeClient.calls.filter((call) => call.unsubscribe), [
    { unsubscribe: "server-sub-a" },
  ]);
});
