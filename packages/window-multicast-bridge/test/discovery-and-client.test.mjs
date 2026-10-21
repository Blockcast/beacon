// Discovery, host classification, and BridgeClient transport/control cases that
// ran outside this package's own suite before the bridge moved here. Most cover
// exports nothing else in this directory tests (resolveBridgeWtHost, isPrivateIp,
// desktopLanScanPrefixesFromInputs, the discovery lock, tuner_tune, ...). One case
// reads src/ as text; the rest go through module resolution, so test:dist runs
// them against the minified build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BridgeClient,
  bridgeDiscoveryScopeFromInputs,
  canProbeBridgeHost,
  desktopLanScanPrefixesFromInputs,
  formatBridgeHost,
  bridgeProto,
  isAutoTlsGatewayDomain,
  isPrivateIp,
  loadSavedGateway,
  nextBridgePollDelay,
  normalizeBridgeHost,
  parseBridgeHostPort,
  readBridgeDiscoveryCache,
  releaseBridgeDiscoveryLock,
  resolveBridgeWtHost,
  saveGateway,
  shouldProbeHttpBridgeHost,
  tryDesktopLanDiscovery,
  tryAcquireBridgeDiscoveryLock,
  writeBridgeDiscoveryCache,
  writeBridgeDiscoveryMiss,
} from "../src/multicast-bridge.js";

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function withLocation(protocol, fn) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol },
  });
  try {
    fn();
  } finally {
    delete globalThis.location;
  }
}

function installBrowserGlobals() {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.test/player", protocol: "https:" },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { title: "test" },
  });
  return () => {
    delete globalThis.location;
    delete globalThis.document;
  };
}

function makeStreamIndexFrame(streamIndex, bytes) {
  const frame = new Uint8Array(2 + bytes.length);
  new DataView(frame.buffer).setUint16(0, streamIndex, true);
  frame.set(bytes, 2);
  return frame;
}

function makeDataStreamHeader(streamIndex = 0) {
  const header = new Uint8Array([0x42, 0x43, 0x44, 0x53, 0x01, 0x00, 0x00, 0x00]);
  new DataView(header.buffer).setUint16(6, streamIndex, true);
  return header;
}

function makeLengthPrefixedFrame(bytes) {
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, true);
  frame.set(bytes, 4);
  return frame;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function makeReadableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function makeControlledReadableStream() {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    enqueue(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      controller.close();
    },
  };
}

function yieldToReaders() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeJsonBidiFrame(message) {
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(4 + encoded.byteLength);
  new DataView(frame.buffer).setUint32(0, encoded.byteLength, true);
  frame.set(encoded, 4);
  return frame;
}

function installSubscribeResponder(client, responseForSubscribe) {
  const sent = [];
  // `_sendControl` returns whether the frame was enqueued. A stub returning
  // nothing reads as "the frame never left the process", and subscribe() then
  // fails fast with "Bridge control channel unavailable" instead of waiting
  // for the response this responder queues.
  client._sendControl = (msg) => {
    sent.push(msg);
    if (msg.type !== "subscribe") return true;
    const response = responseForSubscribe(msg);
    queueMicrotask(() => {
      client._handleControlMessage(JSON.stringify({
        type: "subscribe_response",
        request_id: msg.request_id,
        success: true,
        subscription_id: response.subscriptionId,
      }));
      if (Number.isInteger(response.streamIndex)) {
        client._handleControlMessage(JSON.stringify({
          type: "subscription_stream",
          subscription_id: response.subscriptionId,
          stream_index: response.streamIndex,
        }));
      }
    });
    return true;
  };
  return sent;
}

test("resolveBridgeWtHost uses SAN-covered localhost for .local gateway domains", () => {
  assert.equal(
    resolveBridgeWtHost("10-244-0-168.multicast-bridge.local", {
      gatewayDomain: "multicast-bridge.local",
      localAddress: "10.244.0.168",
    }),
    "localhost",
  );
});

test("resolveBridgeWtHost keeps AutoTLS IP-in-hostname outside .local gateway domains", () => {
  assert.equal(
    resolveBridgeWtHost("10.244.0.168", {
      gatewayDomain: "gw-abc.tenant.bcast.id",
      localAddress: "10.244.0.168",
    }),
    "10-244-0-168.gw-abc.tenant.bcast.id",
  );
});

test("multicast bridge skips .local HTTP probes from HTTPS pages", () => {
  assert.equal(shouldProbeHttpBridgeHost("multicast-bridge.local", "https:"), false);
});

test("multicast bridge keeps loopback HTTP probes from HTTPS pages", () => {
  assert.equal(shouldProbeHttpBridgeHost("localhost", "https:"), true);
  assert.equal(shouldProbeHttpBridgeHost("127.0.0.1", "https:"), true);
});

test("multicast bridge uses HTTP bootstrap for explicit private IP bridge hosts", () => {
  withLocation("https:", () => {
    assert.equal(bridgeProto("192.168.1.244"), "http");
    assert.equal(bridgeProto("100.72.10.26"), "http");
    assert.equal(shouldProbeHttpBridgeHost("192.168.1.244", "https:"), false);
    assert.equal(canProbeBridgeHost("192.168.1.244"), false);
    assert.equal(canProbeBridgeHost("192.168.1.244", { explicitBridge: true }), true);
    assert.equal(canProbeBridgeHost("100.72.10.26", { explicitBridge: true }), true);
  });
});

test("multicast bridge treats CGNAT hosts as private addresses", () => {
  assert.equal(isPrivateIp("100.72.10.26"), true);
  assert.equal(isPrivateIp("100.127.255.254"), true);
  assert.equal(isPrivateIp("100.63.255.255"), false);
  assert.equal(isPrivateIp("100.128.0.1"), false);
});

test("multicast bridge normalizes IPv6 hosts and formats URL authorities with brackets", () => {
  assert.equal(normalizeBridgeHost("[FD12:3456::1]"), "fd12:3456::1");
  assert.equal(normalizeBridgeHost("fd12:3456::1"), "fd12:3456::1");
  assert.equal(formatBridgeHost("fd12:3456::1"), "[fd12:3456::1]");
  assert.deepEqual(parseBridgeHostPort("[fd12:3456::1]:33446"), {
    host: "fd12:3456::1",
    port: 33446,
  });
  assert.deepEqual(parseBridgeHostPort("fd12:3456::1"), {
    host: "fd12:3456::1",
    port: null,
  });
  assert.equal(parseBridgeHostPort("[fd12:3456::1]:bad"), null);
  assert.deepEqual(parseBridgeHostPort("fd12:3456::1:3344"), {
    host: "fd12:3456::1:3344",
    port: null,
  });
  assert.equal(normalizeBridgeHost("[fe80::1%25wlan0]"), null);
});

test("multicast bridge classifies IPv6 ULA/link-local and mapped private addresses for PNA", () => {
  assert.equal(isPrivateIp("fd12:3456::1"), true);
  assert.equal(isPrivateIp("FC00::1"), true);
  assert.equal(isPrivateIp("fe80::1234"), true);
  assert.equal(isPrivateIp("::ffff:192.168.1.20"), true);
  assert.equal(isPrivateIp("2001:db8::1"), false);
  withLocation("https:", () => {
    assert.equal(bridgeProto("[fd12:3456::1]"), "http");
    assert.equal(shouldProbeHttpBridgeHost("[::1]", "https:"), true);
    assert.equal(canProbeBridgeHost("[fd12:3456::1]"), false);
    assert.equal(canProbeBridgeHost("[fd12:3456::1]", { explicitBridge: true }), true);
  });
});

const BCDS_CAPABILITY = {
  bridgeProtocol: "bcds-v1",
  webTransportBridge: true,
};

test("desktop LAN scan prefixes come from explicit params before defaults", () => {
  assert.deepEqual(
    desktopLanScanPrefixesFromInputs({
      search: "?mc_scan=192.168.50,192.168.51.77&mc_scan_prefix=10.8.0",
      hostname: "192.168.1.201",
    }),
    ["10.8.0", "192.168.50", "192.168.51", "192.168.1"],
  );
  assert.deepEqual(
    desktopLanScanPrefixesFromInputs({
      search: "?mc_scan=false",
      hostname: "192.168.1.201",
    }),
    [],
  );
  // `off` is the token an automated player harness sends, where a blind
  // 192.168.x sweep can only run to timeout and starve player startup.
  assert.deepEqual(
    desktopLanScanPrefixesFromInputs({
      search: "?mc_scan=off",
      hostname: "localhost",
    }),
    [],
  );
});

test("desktop LAN scan discovers non-mobile Chrome web player bridge by health", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (!url.startsWith("http://192.168.1.244:33446/health")) {
      return { ok: false };
    }
    return {
      ok: true,
      async json() {
        return {
          name: "IWA Multicast Bridge",
          ...BCDS_CAPABILITY,
          fingerprint: "ef".repeat(32),
          httpPort: 33446,
          wtPort: 33445,
          localAddress: "192.168.1.244",
        };
      },
    };
  };

  try {
    const bridge = await tryDesktopLanDiscovery(33446, {
      force: true,
      prefixes: ["192.168.1"],
      hosts: ["192.168.1.10", "192.168.1.244"],
      batchSize: 2,
      timeoutMs: 25,
    });
    assert.equal(bridge.host, "192.168.1.244");
    assert.equal(bridge.httpPort, 33446);
    assert.equal(bridge.wtPort, 33445);
    assert.equal(bridge.discoveryMethod, "desktop-lan-scan");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.targetAddressSpace, "private");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("BridgeClient connects through WebTransport and sends length-prefixed hello", async () => {
  const cleanup = installBrowserGlobals();
  const oldWebTransport = globalThis.WebTransport;
  const oldNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://127.0.0.1:8088/player", protocol: "http:" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      title: "test",
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "node-test" },
  });

  const transports = [];
  let writer;
  class MockWebTransport {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.ready = Promise.resolve();
      this.closed = new Promise(() => {});
      this.incomingUnidirectionalStreams = {
        getReader() {
          return {
            async read() {
              return { value: undefined, done: true };
            },
            releaseLock() {},
          };
        },
      };
      transports.push(this);
    }
    async createBidirectionalStream() {
      writer = {
        frames: [],
        write(frame) {
          this.frames.push(frame);
          return Promise.resolve();
        },
        close() {
          return Promise.resolve();
        },
      };
      return {
        writable: { getWriter: () => writer },
        readable: {
          getReader() {
            return {
              async read() {
                return { value: undefined, done: true };
              },
              releaseLock() {},
            };
          },
        },
      };
    }
    close() {
      this.closed = Promise.resolve();
    }
  }
  globalThis.WebTransport = MockWebTransport;

  let client;
  try {
    client = new BridgeClient();
    await client.connect("127.0.0.1", 33446, { fingerprint: "aa".repeat(32), wtPort: 33445 });

    assert.equal(client._transport, "webtransport");
    assert.equal(transports[0].url, "https://127.0.0.1:33445");
    assert.equal(transports[0].options.serverCertificateHashes[0].algorithm, "sha-256");
    assert.equal(transports[0].options.serverCertificateHashes[0].value.byteLength, 32);

    const firstFrame = writer.frames[0];
    const frameLen = new DataView(firstFrame.buffer, firstFrame.byteOffset, firstFrame.byteLength).getUint32(0, true);
    const hello = JSON.parse(new TextDecoder().decode(firstFrame.subarray(4, 4 + frameLen)));
    assert.equal(hello.type, "hello");
    assert.equal(hello.client_type, "bridge");
    assert.equal(Object.hasOwn(hello, "capability"), false);
  } finally {
    client?.disconnect();
    globalThis.WebTransport = oldWebTransport;
    if (oldNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: oldNavigator });
    }
    delete globalThis.window;
    cleanup();
  }
});

// Reads src/ as text. test:dist redirects module resolution only, so this
// keeps reading src/ there too; the minified build renames these calls.
test("bridge discovery uses direct health and WebTransport without lifecycle pairing state", () => {
  const src = readFileSync(new URL("../src/multicast-bridge.js", import.meta.url), "utf8");
  assert.match(src, /const bridge = await tryBridgeHealth\(host, probePort, 'health', 2000\)/);
  assert.match(src, /new BridgeClient\(\)/);
  assert.doesNotMatch(src, /bridge_capability|X-Blockcast-Bridge-Capability|requestPairing|doPairing/);
});

test("BridgeClient routes compact stream-index transport frames", () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub", {
    onpacket(event) {
      packets.push(Array.from(new Uint8Array(event.data)));
    },
  });

  client._handleTransportFrame(makeStreamIndexFrame(3, [0x10, 0x20, 0x30]));
  client._handleTransportFrame(makeStreamIndexFrame(3, [0x40]));

  assert.deepEqual(packets, [
    [0x10, 0x20, 0x30],
    [0x40],
  ]);
});

test("BridgeClient accepts only current BCDS v1 data-stream headers", () => {
  const client = new BridgeClient();

  assert.deepEqual(
    client._parseDataStreamHeader(makeDataStreamHeader(3)),
    { streamIndex: 3 },
  );
  assert.match(client._parseDataStreamHeader(new Uint8Array([
    0x42, 0x43, 0x41, 0x57, 0x01, 0x00, 0x03, 0x00,
  ])).error, /magic/);
  assert.match(
    client._parseDataStreamHeader(new Uint8Array([
      0x42, 0x43, 0x50, 0x46, 0x01, 0x00, 0x07, 0x00,
    ])).error,
    /magic/,
  );
  assert.match(
    client._parseDataStreamHeader(new Uint8Array([
      0x42, 0x43, 0x44, 0x53, 0x01, 0x01, 0x03, 0x00,
    ])).error,
    /flags 1/,
  );
});

test("BridgeClient dispatches split length-prefixed WebTransport data-stream frames", async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub", {
    onpacket(event) {
      packets.push(Array.from(new Uint8Array(event.data)));
    },
  });

  const frame = makeLengthPrefixedFrame(makeStreamIndexFrame(3, [0x10, 0x20, 0x30]));
  await client._consumeUniStream(makeReadableStream([
    makeDataStreamHeader(3),
    frame.subarray(0, 2),
    frame.subarray(2),
  ]));

  assert.deepEqual(packets, [[0x10, 0x20, 0x30]]);
  assert.equal(client._debugStats.wtDataStreamFrames, 1);
  assert.equal(client._debugStats.wtLastDataStreamIndex, 3);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 0);
});

test("BridgeClient yields while draining a large WebTransport data-stream burst", async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub", {
    onpacket(event) {
      packets.push(new Uint8Array(event.data)[0]);
    },
  });

  const frames = Array.from({length: 130}, (_, index) =>
    makeLengthPrefixedFrame(makeStreamIndexFrame(3, [index & 0xff])));
  const streamBytes = concatBytes([makeDataStreamHeader(3), ...frames]);
  let packetsAtFirstTimer = null;
  setTimeout(() => {
    packetsAtFirstTimer = packets.length;
  }, 0);

  await client._consumeUniStream(makeReadableStream([streamBytes]));

  assert.equal(packets.length, 130);
  assert.equal(packetsAtFirstTimer, 64);
  assert.equal(client._debugStats.wtDataStreamFrames, 130);
  assert.equal(client._debugStats.wtDataStreamYields, 2);
  assert.equal(client._debugStats.wtDataStreamAbortedDrains, 0);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 0);
});

test("BridgeClient aborts a yielded data-stream drain after disconnect", async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub", {
    onpacket(event) {
      packets.push(new Uint8Array(event.data)[0]);
    },
  });

  const frames = Array.from({length: 130}, (_, index) =>
    makeLengthPrefixedFrame(makeStreamIndexFrame(3, [index & 0xff])));
  const streamBytes = concatBytes([makeDataStreamHeader(3), ...frames]);
  setTimeout(() => {
    client.disconnect({ notifySubscriptions: false });
  }, 0);

  await client._consumeUniStream(makeReadableStream([streamBytes]));

  assert.equal(packets.length, 64);
  assert.equal(client._debugStats.wtDataStreamFrames, 64);
  assert.equal(client._debugStats.wtDataStreamYields, 1);
  assert.equal(client._debugStats.wtDataStreamAbortedDrains, 1);
  assert.equal(client._dataStreamBuffers.size, 0);
  assert.equal(client._dataStreamTokens.size, 0);
});

test("BridgeClient keeps partial BCDS frame buffers isolated per WebTransport stream", async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub-a");
  client._streamSubscriptions.set(4, "server-sub-b");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub-a", {
    onpacket(event) {
      packets.push(["a", Array.from(new Uint8Array(event.data))]);
    },
  });
  client.subscriptionCallbacks.set("server-sub-b", {
    onpacket(event) {
      packets.push(["b", Array.from(new Uint8Array(event.data))]);
    },
  });

  const streamA = makeControlledReadableStream();
  const streamB = makeControlledReadableStream();
  const consumeA = client._consumeUniStream(streamA.stream);
  const consumeB = client._consumeUniStream(streamB.stream);

  const frameA = makeLengthPrefixedFrame(makeStreamIndexFrame(3, [0x10, 0x20, 0x30]));
  const frameB = makeLengthPrefixedFrame(makeStreamIndexFrame(4, [0x40, 0x50]));

  streamA.enqueue(makeDataStreamHeader(3));
  streamA.enqueue(frameA.subarray(0, 6));
  await yieldToReaders();

  streamB.enqueue(makeDataStreamHeader(4));
  streamB.enqueue(frameB);
  await yieldToReaders();

  streamA.enqueue(frameA.subarray(6));
  streamA.close();
  streamB.close();
  await Promise.all([consumeA, consumeB]);

  assert.deepEqual(packets, [
    ["b", [0x40, 0x50]],
    ["a", [0x10, 0x20, 0x30]],
  ]);
  assert.equal(client._debugStats.wtDataStreamFrames, 2);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 0);
  assert.equal(client.getStats().dataStreamBufferBytes, 0);
});

test("BridgeClient rejects stale raw BCDS data-stream packets", async () => {
  const client = new BridgeClient();
  client.connected = true;
  client._streamSubscriptions.set(3, "server-sub");

  const packets = [];
  client.subscriptionCallbacks.set("server-sub", {
    onpacket(event) {
      packets.push(Array.from(new Uint8Array(event.data)));
    },
  });

  await client._consumeUniStream(makeReadableStream([
    makeDataStreamHeader(3),
    makeStreamIndexFrame(3, [0x10, 0x20, 0x30]),
    makeStreamIndexFrame(3, [0x40]),
  ]));

  assert.deepEqual(packets, []);
  assert.equal(client._debugStats.wtDataStreamFrames, 0);
  assert.equal(client._debugStats.wtDataStreamProtocolErrors, 1);
  assert.match(client._debugStats.wtLastDataStreamProtocolError, /invalid BCDS packet length/);
});

test("BridgeClient drops obsolete subscription-id transport frames", () => {
  const client = new BridgeClient();
  client.connected = true;
  // Keep the canonical stream-index map non-empty so a rejected legacy frame
  // is observable as an index miss without granting it a delivery path.
  client._streamSubscriptions.set(3, "canonical-subscription");
  const subscriptionId = "239.1.1.1:8000@10.0.0.1";

  const packets = [];
  client.subscriptionCallbacks.set(subscriptionId, {
    onpacket(event) {
      packets.push(Array.from(new Uint8Array(event.data)));
    },
  });

  const subIdBytes = new TextEncoder().encode(subscriptionId);
  const frame = new Uint8Array(2 + subIdBytes.byteLength + 3);
  new DataView(frame.buffer).setUint16(0, subIdBytes.byteLength, true);
  frame.set(subIdBytes, 2);
  frame.set([0x01, 0x02, 0x03], 2 + subIdBytes.byteLength);

  client._handleTransportFrame(frame);

  assert.deepEqual(packets, []);
  assert.equal(client._debugStats.wtStreamIndexMisses, 1);
});

test("BridgeClient parses split and coalesced bidi control frames", () => {
  const client = new BridgeClient();
  const first = makeJsonBidiFrame({
    type: "subscription_stream",
    subscription_id: "sub-a",
    stream_index: 4,
  });
  const second = makeJsonBidiFrame({
    type: "subscription_stream",
    subscription_id: "sub-b",
    stream_index: 7,
  });

  client._extractBidiFrames([first.subarray(0, 3), first.subarray(3), second]);

  assert.equal(client._streamSubscriptions.get(4), "sub-a");
  assert.equal(client._streamSubscriptions.get(7), "sub-b");
});

test("BridgeClient accepts keepalive_ack as a liveness-only control message", () => {
  const client = new BridgeClient();
  client.pendingRequests.set("req-1", {
    resolve() {
      throw new Error("keepalive_ack must not resolve unrelated requests");
    },
    reject() {
      throw new Error("keepalive_ack must not reject unrelated requests");
    },
  });

  client._handleControlMessage(JSON.stringify({
    type: "keepalive_ack",
    timestamp: 1234,
    client_timestamp: 1000,
  }));

  assert.equal(client.pendingRequests.has("req-1"), true);
});

test("BridgeClient replays active subscriptions after preserved reconnect", async () => {
  const cleanup = installBrowserGlobals();
  try {
    const client = new BridgeClient();
    client.connected = true;
    client._transport = "webtransport";

    let subscribeCount = 0;
    installSubscribeResponder(client, () => {
      subscribeCount += 1;
      return subscribeCount === 1
        ? { subscriptionId: "server-sub-a", streamIndex: 0 }
        : { subscriptionId: "server-sub-b", streamIndex: 7 };
    });

    const subscription = await client.subscribe("239.1.1.1", 8000, "10.0.0.1");
    const packets = [];
    subscription.setCallbacks({
      onpacket(event) {
        packets.push(Array.from(new Uint8Array(event.data)));
      },
    });

    client._handleStreamMessage(makeStreamIndexFrame(0, [0xaa, 0xbb]));
    assert.deepEqual(packets, [[0xaa, 0xbb]]);

    client.disconnect({ preserveSubscriptions: true });
    assert.equal(client.connected, false);
    assert.equal(client.activeSubscriptions.has(subscription.subscriptionId), true);
    assert.equal(client.subscriptionCallbacks.has(subscription.subscriptionId), true);
    assert.equal(client._streamSubscriptions.size, 0);

    client.connected = true;
    await client._replayActiveSubscriptions();

    client._handleStreamMessage(makeStreamIndexFrame(7, [0xcc, 0xdd]));
    assert.deepEqual(packets, [
      [0xaa, 0xbb],
      [0xcc, 0xdd],
    ]);
    assert.equal(subscribeCount, 2);
  } finally {
    cleanup();
  }
});

test("BridgeClient surfaces reconnect replay failure to the subscription callback", async () => {
  const cleanup = installBrowserGlobals();
  try {
    const client = new BridgeClient();
    client.connected = true;
    client._transport = "webtransport";

    installSubscribeResponder(client, () => ({ subscriptionId: "server-sub-a", streamIndex: 0 }));
    const subscription = await client.subscribe("239.1.1.1", 8000, "10.0.0.1");
    let errorCount = 0;
    const packets = [];
    subscription.setCallbacks({
      onpacket(event) {
        packets.push(Array.from(new Uint8Array(event.data)));
      },
      onerror() {
        errorCount++;
      },
    });

    let resubscribeAttempts = 0;
    client._sendSubscribeRequest = async () => {
      resubscribeAttempts++;
      throw new Error("Subscribe timeout");
    };

    client.disconnect({ preserveSubscriptions: true });
    client.connected = true;
    await client._replayActiveSubscriptions();
    assert.equal(resubscribeAttempts, 1);
    assert.equal(errorCount, 1);
    assert.deepEqual(packets, []);
  } finally {
    cleanup();
  }
});

test("BridgeClient tunerStatus only requests signal stats when explicitly asked", async () => {
  const cleanup = installBrowserGlobals();
  try {
    const client = new BridgeClient();
    client.connected = true;
    client._transport = "webtransport";

    const sent = [];
    client._sendControl = (msg) => {
      sent.push(msg);
      queueMicrotask(() => {
        client._handleControlMessage(JSON.stringify({
          type: "tuner_response",
          request_id: msg.request_id,
          action: "status",
          success: true,
          status: { state: "running" },
        }));
      });
    };

    await client.tunerStatus();
    await client.tunerStatus({ includeSignal: true });

    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, "tuner_status");
    assert.equal(sent[0].include_signal, false);
    assert.equal(sent[1].type, "tuner_status");
    assert.equal(sent[1].include_signal, true);
  } finally {
    cleanup();
  }
});

test("BridgeClient tunerTune sends tuner_tune with public option names", async () => {
  const cleanup = installBrowserGlobals();
  try {
    const client = new BridgeClient();
    client.connected = true;
    client._transport = "webtransport";

    const sent = [];
    client._sendControl = (msg) => {
      sent.push(msg);
      queueMicrotask(() => {
        client._handleControlMessage(JSON.stringify({
          type: "tuner_response",
          request_id: msg.request_id,
          action: "tune",
          success: true,
          locked: true,
          status: { state: "running", locked: true },
        }));
      });
    };

    const response = await client.tunerTune({ freqKHz: 177000, mode: 5, plpId: 0 });

    assert.equal(response.locked, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "tuner_tune");
    assert.equal(sent[0].freq_khz, 177000);
    assert.equal(sent[0].mode, 5);
    assert.equal(sent[0].plp_id, 0);
  } finally {
    cleanup();
  }
});

test("bridge polling backs off, caps, and leaves lock-busy retries unchanged", () => {
  assert.equal(nextBridgePollDelay(5000, "miss"), 8000);
  assert.equal(nextBridgePollDelay(59000, "miss"), 60000);
  assert.equal(nextBridgePollDelay(32000, "reset"), 5000);
  assert.equal(nextBridgePollDelay(12000, "lock-busy"), 12000);
});

test("bridge discovery cache shares found and missed probes with TTLs", () => {
  const storage = makeStorage();
  const bridge = {
    host: "localhost",
    httpPort: 33446,
    wtPort: 33445,
    fingerprint: "ab".repeat(32),
    gatewayDomain: "gw.example.test",
    localAddress: "192.168.1.10",
    ...BCDS_CAPABILITY,
  };

  assert.equal(writeBridgeDiscoveryCache(33446, bridge, { now: 1000, ttlMs: 100, storage }), true);
  assert.deepEqual(readBridgeDiscoveryCache(33446, 1050, storage), {
    status: "found",
    expiresAt: 1100,
    bridge: {
      host: "localhost",
      httpPort: 33446,
      wtPort: 33445,
      fingerprint: "ab".repeat(32),
      gatewayDomain: "gw.example.test",
      localAddress: "192.168.1.10",
      discoveryMethod: "cache",
      ...BCDS_CAPABILITY,
    },
  });
  assert.equal(readBridgeDiscoveryCache(33446, 1101, storage), null);

  assert.equal(writeBridgeDiscoveryMiss(33446, { now: 2000, ttlMs: 50, storage }), true);
  assert.deepEqual(readBridgeDiscoveryCache(33446, 2025, storage), {
    status: "miss",
    expiresAt: 2050,
  });
  assert.equal(readBridgeDiscoveryCache(33446, 2051, storage), null);
});

test("bridge discovery cache scopes explicit URL inputs separately from default probes", () => {
  const storage = makeStorage();
  const defaultBridge = {
    host: "localhost",
    httpPort: 33446,
    wtPort: 33445,
    fingerprint: "ab".repeat(32),
    ...BCDS_CAPABILITY,
  };
  const explicitScope = bridgeDiscoveryScopeFromInputs({
    search: "?mc_bridge=192.168.1.50&gw=gw.example.test",
  });

  assert.notEqual(explicitScope, "default");
  assert.equal(writeBridgeDiscoveryCache(33446, defaultBridge, { now: 1000, ttlMs: 1000, storage }), true);
  assert.equal(readBridgeDiscoveryCache(33446, 1100, storage, explicitScope), null);

  assert.equal(writeBridgeDiscoveryMiss(33446, { now: 1200, ttlMs: 1000, storage, scope: explicitScope }), true);
  assert.deepEqual(readBridgeDiscoveryCache(33446, 1250, storage), {
    status: "found",
    expiresAt: 2000,
    bridge: {
      host: "localhost",
      httpPort: 33446,
      wtPort: 33445,
      fingerprint: "ab".repeat(32),
      gatewayDomain: "",
      localAddress: "",
      discoveryMethod: "cache",
      ...BCDS_CAPABILITY,
    },
  });
  assert.deepEqual(readBridgeDiscoveryCache(33446, 1250, storage, explicitScope), {
    status: "miss",
    expiresAt: 2200,
  });
});

test("bridge discovery lock prevents concurrent probes until release or expiry", () => {
  const storage = makeStorage();

  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1000, ttlMs: 100, owner: "tab-a", storage }),
    "tab-a",
  );
  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1050, ttlMs: 100, owner: "tab-b", storage }),
    null,
  );

  releaseBridgeDiscoveryLock("tab-a", { storage });
  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1060, ttlMs: 100, owner: "tab-b", storage }),
    "tab-b",
  );

  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1200, ttlMs: 100, owner: "tab-c", storage }),
    "tab-c",
  );
});

test("bridge discovery locks are isolated by discovery scope", () => {
  const storage = makeStorage();
  const explicitScope = bridgeDiscoveryScopeFromInputs({
    search: "?gw=gw.example.test",
  });

  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1000, ttlMs: 100, owner: "tab-a", storage }),
    "tab-a",
  );
  assert.equal(
    tryAcquireBridgeDiscoveryLock(33446, { now: 1000, ttlMs: 100, owner: "tab-b", storage, scope: explicitScope }),
    "tab-b",
  );
});

// Regression: BLO-10897 — subscribeLowercaseBytes was dropping amtRelayPort when
// calling bridgeClient.subscribe, causing the IWA to miss the AMT port hint.
test("BridgeClient.subscribe forwards amtRelayPort as amt_relay_port in subscribe message", async () => {
  const cleanup = installBrowserGlobals();
  try {
    const client = new BridgeClient();
    client.connected = true;
    client._transport = "webtransport";

    const sent = installSubscribeResponder(client, () => ({
      subscriptionId: "server-sub-amt",
      streamIndex: 0,
    }));

    await client.subscribe("239.1.1.1", 8000, "10.0.0.1", {
      mode: "tunnel",
      amtRelay: "amt.example.com",
      amtRelayPort: 2268,
    });

    const subscribeMsg = sent.find((m) => m.type === "subscribe");
    assert.ok(subscribeMsg, "subscribe control message was sent");
    assert.equal(subscribeMsg.amt_relay, "amt.example.com");
    assert.equal(subscribeMsg.amt_relay_port, 2268);
    assert.equal(subscribeMsg.mode, "tunnel");
  } finally {
    cleanup();
  }
});

test("bridge client reconnects when active subscriptions stop receiving packets", () => {
  const client = new BridgeClient();
  const subscriptionId = "239.21.4.1:8000";
  const now = Date.now();
  let reconnects = 0;

  client.connected = true;
  client._transport = "webtransport";
  client._lastConnectArgs = { host: "192.168.1.244", httpPort: 33446, options: {} };
  client.activeSubscriptions.add(subscriptionId);
  client.subscriptionCallbacks.set(subscriptionId, {});
  client._desiredSubscriptions.set(subscriptionId, {
    subscriptionId,
    group: "239.21.4.1",
    port: 8000,
    transportOpts: {},
    callbacks: {},
  });
  client._debugStats.wtLastPacketAt = now - 8000;
  client._lastSubscriptionProgressAt = now - 8000;
  client._scheduleReconnect = () => {
    reconnects++;
  };

  assert.equal(client._checkSubscriptionWatchdog(now), true);
  assert.equal(client.connected, false);
  assert.equal(reconnects, 1);
  assert.equal(client.activeSubscriptions.has(subscriptionId), true);
  assert.equal(client.getStats().wtStaleSubscriptionReconnects, 1);
});

test("bridge client keeps WebTransport when payload is stale but control is alive", () => {
  const client = new BridgeClient();
  const subscriptionId = "239.21.4.1:8000";
  const now = Date.now();
  let reconnects = 0;

  client.connected = true;
  client._transport = "webtransport";
  client._lastConnectArgs = { host: "192.168.1.244", httpPort: 33446, options: {} };
  client.activeSubscriptions.add(subscriptionId);
  client.subscriptionCallbacks.set(subscriptionId, {});
  client._desiredSubscriptions.set(subscriptionId, {
    subscriptionId,
    group: "239.21.4.1",
    port: 8000,
    transportOpts: {},
    callbacks: {},
  });
  client._debugStats.wtLastPacketAt = now - 8000;
  client._lastSubscriptionProgressAt = now - 8000;
  client._markControlActivity(now - 500);
  client._scheduleReconnect = () => {
    reconnects++;
  };

  assert.equal(client._checkSubscriptionWatchdog(now), false);
  assert.equal(client.connected, true);
  assert.equal(reconnects, 0);
  assert.equal(client.getStats().wtSubscriptionWatchdogControlDeferrals, 1);
});

test("bridge client watchdog ignores idle connection with no subscriptions", () => {
  const client = new BridgeClient();
  const now = Date.now();
  let reconnects = 0;

  client.connected = true;
  client._transport = "webtransport";
  client._debugStats.wtLastPacketAt = now - 8000;
  client._lastSubscriptionProgressAt = now - 8000;
  client._scheduleReconnect = () => {
    reconnects++;
  };

  assert.equal(client._checkSubscriptionWatchdog(now), false);
  assert.equal(client.connected, true);
  assert.equal(reconnects, 0);
  assert.equal(client._lastSubscriptionProgressAt, now);
  assert.equal(client.getStats().wtLastPacketAt, now);
  assert.equal(client.getStats().wtStaleSubscriptionReconnects, 0);
});

test("isAutoTlsGatewayDomain requires a gateway label under the apex", () => {
  assert.equal(isAutoTlsGatewayDomain("gw-abc.bcast.id"), true);
  assert.equal(isAutoTlsGatewayDomain("relay.gw-abc.tenant.bcast.id"), true);
  // Bare apex — the poisoned shape: authoritatives answer NODATA for
  // dashed-IP children, so 100-72-10-82.bcast.id can never resolve.
  assert.equal(isAutoTlsGatewayDomain("bcast.id"), false);
  assert.equal(isAutoTlsGatewayDomain("bridge.local"), false); // mDNS, HTTP-only
  assert.equal(isAutoTlsGatewayDomain(""), false);
  assert.equal(isAutoTlsGatewayDomain(undefined), false);
});

function withStorage(fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: makeStorage(),
  });
  try {
    return fn(globalThis.localStorage);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      delete globalThis.localStorage;
    }
  }
}

test("saveGateway refuses domains without a gateway label", () => {
  withStorage((storage) => {
    saveGateway("bcast.id", "100.72.10.82");
    assert.equal(storage.getItem("multicast-bridge-gw"), null);

    saveGateway("gw-abc.bcast.id", "192.168.1.181");
    const stored = JSON.parse(storage.getItem("multicast-bridge-gw"));
    assert.equal(stored.gatewayDomain, "gw-abc.bcast.id");
    assert.equal(stored.localAddress, "192.168.1.181");
  });
});

test("loadSavedGateway evicts poisoned pre-guard entries", () => {
  withStorage((storage) => {
    storage.setItem("multicast-bridge-gw", JSON.stringify({
      gatewayDomain: "bcast.id",
      localAddress: "100.72.10.82",
      savedAt: Date.now(),
    }));
    assert.equal(loadSavedGateway(), null);
    // Evicted, not just skipped — bootstrap rediscovery must be able to run.
    assert.equal(storage.getItem("multicast-bridge-gw"), null);
  });
});

test("loadSavedGateway returns valid entries and skips invalid bridge-discovery promotions", () => {
  withStorage((storage) => {
    storage.setItem("multicast-bridge-gw", JSON.stringify({
      gatewayDomain: "gw-abc.bcast.id",
      localAddress: "192.168.1.181",
      savedAt: Date.now(),
    }));
    assert.equal(loadSavedGateway().gatewayDomain, "gw-abc.bcast.id");
  });

  withStorage((storage) => {
    storage.setItem("iwa-bridge-discoveries", JSON.stringify([
      { gatewayDomain: "bcast.id", localAddress: "100.72.10.82" },
      { gatewayDomain: "gw-ok.bcast.id", localAddress: "192.168.1.244" },
    ]));
    const promoted = loadSavedGateway();
    assert.equal(promoted.gatewayDomain, "gw-ok.bcast.id");
    assert.equal(promoted.localAddress, "192.168.1.244");
    const own = JSON.parse(storage.getItem("multicast-bridge-gw"));
    assert.equal(own.gatewayDomain, "gw-ok.bcast.id");
  });
});
