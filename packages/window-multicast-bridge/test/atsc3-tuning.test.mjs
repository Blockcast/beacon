// Catalog atsc3 networkSource tuning (draft-ramadan-moq-multicast-01 §4.2.2)
// rides the page-side subscribe to the bridge: frequency (kHz), plpId and
// serviceId reach the WT subscribe frame as frequency/plp_id/service_id.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BridgeClient,
  multicastBridgeTransportOptionsFromConfig,
  subscribeMulticastBridgeBytes,
} from "../src/multicast-bridge.js";

const ATSC3 = { group: "224.0.23.60", port: 4937, consume: "bytes", origin: "tuner", standard: "atsc3", protocol: "mmtp" };

function subscribeMessage(config) {
  const previousLocation = globalThis.location;
  globalThis.location = { href: "https://example.test/player.html" };
  try {
    return new BridgeClient()._buildSubscribeMessage({
      group: config.group,
      port: Number(config.port),
      source: config.source,
      transportOpts: multicastBridgeTransportOptionsFromConfig(config),
    }, "req-1");
  } finally {
    globalThis.location = previousLocation;
  }
}

test("a full atsc3 config carries frequency, plp_id and service_id", () => {
  const config = { ...ATSC3, frequency: 593000, plpId: 3, serviceId: 5004 };
  assert.deepEqual(multicastBridgeTransportOptionsFromConfig(config), {
    protocol: "mmtp", origin: "tuner", standard: "atsc3", frequency: 593000, plpId: 3, serviceId: 5004,
  });
  const msg = subscribeMessage(config);
  assert.equal(msg.frequency, 593000);
  assert.equal(msg.plp_id, 3);
  assert.equal(msg.service_id, 5004);
  assert.equal("plpId" in msg || "serviceId" in msg, false);
});

test("a frequency-only atsc3 config carries frequency alone, including PLP 0 when given", () => {
  const msg = subscribeMessage({ ...ATSC3, frequency: 177000 });
  assert.equal(msg.frequency, 177000);
  assert.equal("plp_id" in msg || "service_id" in msg, false);
  assert.equal(subscribeMessage({ ...ATSC3, frequency: 177000, plpId: 0 }).plp_id, 0);
});

test("an ip-multicast subscribe frame is byte-identical to the pre-tuning one", () => {
  const msg = subscribeMessage({ group: "232.1.1.50", port: 8000, source: "69.25.95.128", consume: "bytes", origin: "ip-multicast", protocol: "mmtp", fec: true });
  assert.equal(
    JSON.stringify(msg),
    '{"type":"subscribe","request_id":"req-1","client_type":"bridge","page_url":"https://example.test/player.html",' +
      '"group":"232.1.1.50","port":8000,"source":"69.25.95.128","protocol":"mmtp","origin":"ip-multicast","fec":true,"mode":"native"}',
  );
});

test("one group on two channels does not share a receiver", async () => {
  const calls = [];
  const bridgeClient = {
    async subscribe(group, port, source, transportOpts) {
      calls.push(transportOpts);
      return { subscriptionId: `sub-${calls.length}`, setCallbacks() {} };
    },
    async unsubscribe() {},
  };
  await subscribeMulticastBridgeBytes(bridgeClient, { ...ATSC3, frequency: 593000 });
  await subscribeMulticastBridgeBytes(bridgeClient, { ...ATSC3, frequency: 599000 });
  await subscribeMulticastBridgeBytes(bridgeClient, { ...ATSC3, frequency: 599000 });
  assert.deepEqual(calls.map((o) => o.frequency), [593000, 599000]);
});
