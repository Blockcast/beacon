// BLO-36599 probe: page-thread cost of delivering BCDS packets to one bytes
// subscription. Drives the real BridgeClient reader (_appendDataStreamBytes)
// into a real subscribeMulticastBridgeBytes() subscription and reports, per
// delivered packet, the DOM events dispatched and the wall time spent.
//
//   node bench/packet-dispatch.mjs [path/to/multicast-bridge.js]
//
// Pass an older copy of the module to measure a baseline. Node's EventTarget
// is far cheaper than Blink's C++ dispatch (the Kirin 659 profile measured
// ~35 us per dispatchEvent + CustomEvent), so the event counts are the portable
// result and the CPU timings are a same-machine comparison only.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modulePath = resolve(process.argv[2] || new URL('../src/multicast-bridge.js', import.meta.url).pathname);
const { BridgeClient, subscribeMulticastBridgeBytes } = await import(pathToFileURL(modulePath).href);

const STREAM_INDEX = 3;
const PACKETS = 60_000;
// One WebTransport read carries several BCDS frames; 16 is what the Kirin
// profile's _appendDataStreamBytes chunk/frame ratio showed on average.
const FRAMES_PER_READ = 16;
// A NASA 720p AMT packet (MMTP + FEC framing) is ~1.3 KB.
const PAYLOAD_BYTES = 1316;
const RUNS = 7;

function chunk(count) {
  const frameBytes = 4 + 2 + PAYLOAD_BYTES;
  const out = new Uint8Array(count * frameBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    const base = i * frameBytes;
    view.setUint32(base, 2 + PAYLOAD_BYTES, true);
    view.setUint16(base + 4, STREAM_INDEX, true);
    out[base + 6] = 0x40; // MMTP v1-ish first byte; content is irrelevant here
  }
  return out;
}

async function harness(mode) {
  const client = new BridgeClient();
  client.connected = true;
  client._sendControl = () => true;
  const token = {};
  client._dataStreamBuffers.set(STREAM_INDEX, new Uint8Array(0));
  client._dataStreamTokens.set(STREAM_INDEX, token);
  client._streamSubscriptions.set(STREAM_INDEX, 'bench');
  const sub = await subscribeMulticastBridgeBytes({
    async subscribe() {
      return {
        subscriptionId: 'bench',
        setCallbacks(callbacks) { client.subscriptionCallbacks.set('bench', callbacks); },
      };
    },
    async unsubscribe() {},
  }, { group: '232.1.1.60', port: 8000, source: '69.25.95.128', consume: 'bytes' });
  let delivered = 0;
  if (mode === 'bytes') sub.addEventListener('bytes', () => { delivered++; });
  else sub.addEventListener('packets', (event) => { delivered += event.detail.length; });
  return {
    feed: (bytes) => client._appendDataStreamBytes(STREAM_INDEX, bytes, token),
    delivered: () => delivered,
    close: () => sub.unsubscribe(),
  };
}

async function measure(mode) {
  const read = chunk(FRAMES_PER_READ);
  const reads = PACKETS / FRAMES_PER_READ;
  const samples = [];
  let dispatches = 0;
  let delivered = 0;
  for (let run = 0; run < RUNS; run++) {
    const h = await harness(mode);
    const original = EventTarget.prototype.dispatchEvent;
    let count = 0;
    EventTarget.prototype.dispatchEvent = function counted(event) { count++; return original.call(this, event); };
    // CPU time, not wall time: the reader yields to the event loop every
    // dispatch batch, and Node clamps that setTimeout(0) to ~1 ms of idle.
    const started = process.cpuUsage();
    for (let i = 0; i < reads; i++) await h.feed(read.slice());
    const used = process.cpuUsage(started);
    const elapsed = (used.user + used.system) * 1000;
    EventTarget.prototype.dispatchEvent = original;
    samples.push(elapsed / PACKETS);
    dispatches = count;
    delivered = h.delivered();
    await h.close();
  }
  samples.sort((a, b) => a - b);
  return {
    mode,
    delivered,
    domEventsPerPacket: +(dispatches / PACKETS).toFixed(4),
    cpuNsPerPacketMedian: Math.round(samples[Math.floor(RUNS / 2)]),
  };
}

const results = [await measure('bytes')];
const probe = await harness('packets');
await probe.feed(chunk(1));
if (probe.delivered() > 0) results.push(await measure('packets'));
else results.push({ mode: 'packets', delivered: 0, note: 'provider does not emit packets events' });
await probe.close();
console.log(JSON.stringify({ module: modulePath, node: process.version, packets: PACKETS, framesPerRead: FRAMES_PER_READ, results }, null, 2));
