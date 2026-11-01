// Staging pcap replay (BLO-51223): feeds a ROUTE capture through route.wasm,
// RouteMabrSession and fec-raptorq wasm, dropping the 3rd source packet of
// every object on the protected source group, and reports RaptorQ recovery
// against the undropped capture. Not part of CI: it needs a live capture.
//
//   kubectl -n staging-blockcastd-receiver exec <multicast pod> -c multicast -- \
//     sh -c 'timeout 30 tcpdump -i any -U -w - -s 0 "dst host 232.254.0.16 or dst host 232.254.0.24 or dst host 232.254.0.29"' > staging.pcap
//   npm run build && node tests/route-pcap-replay.mjs staging.pcap route.wasm wasm_exec.js <raptorq-pkg dir> $PWD/dist \
//     [slsGroup=232.254.0.29] [slsPort=1025] [sourceGroup=232.254.0.16] [slsSource=69.25.95.198]
import { readFileSync } from 'node:fs';
const [pcap, wasmPath, execPath, rqDir, distDir, slsGroup = '232.254.0.29', slsPort = '1025', sourceGroup = '232.254.0.16', slsSource = '69.25.95.198'] = process.argv.slice(2);
(0, eval)(readFileSync(execPath, 'utf8'));
function* packets(path) {
  const d = readFileSync(path); const le = d.readUInt32LE(0) === 0xa1b2c3d4 || d.readUInt32LE(0) === 0xa1b23c4d;
  const u32 = (o) => le ? d.readUInt32LE(o) : d.readUInt32BE(o);
  const link = u32(20); let off = 24;
  while (off + 16 <= d.length) {
    const ts = u32(off) + u32(off + 4) / 1e6, cl = u32(off + 8); off += 16;
    const f = d.subarray(off, off + cl); off += cl;
    const ip = link === 113 ? f.subarray(16) : link === 276 ? f.subarray(20) : link === 1 ? f.subarray(14) : f;
    if (!ip.length || ip[0] >> 4 !== 4 || ip[9] !== 17) continue;
    const ihl = (ip[0] & 15) * 4;
    const src = [...ip.subarray(12, 16)].join('.'), dst = [...ip.subarray(16, 20)].join('.');
    const udp = ip.subarray(ihl);
    yield { ts, src, dst, dport: udp.readUInt16BE(2), sport: udp.readUInt16BE(0), payload: udp.subarray(8) };
  }
}
function lct(p) {
  const C = (p[0] >> 2) & 3, S = (p[1] >> 7) & 1, O = (p[1] >> 5) & 3, H = (p[1] >> 4) & 1;
  const hlen = p[2] * 4; let o = 4 + 4 * (C + 1);
  const tl = 4 * S + 2 * H, ol = 4 * O + 2 * H;
  // Buffer.readUIntBE only accepts widths up to six bytes. A diagnostic
  // capture with a wider LCT field is still useful; skip that packet instead
  // of aborting the whole replay.
  if (tl > 6 || ol > 6) return undefined;
  const tsi = p.readUIntBE(o, tl || 1) * (tl ? 1 : 0); o += tl;
  const toi = ol ? p.readUIntBE(o, ol) : 0;
  return { cp: p[3], tsi, toi, hlen, close: (p[1] & 1) === 1 };
}

const rq = await import(rqDir + '/raptorq_wasm.js');
await rq.default({ module_or_path: readFileSync(rqDir + '/raptorq_wasm_bg.wasm') });
const { createRouteMabrSession } = await import(distDir + '/index.js');
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject);
go.run(instance);
const ex = instance.exports;
ex.route_init();
let rqQueued = 0;
const count = ex.route_get_raptorq_count;
const exports = { ...ex, route_get_raptorq_count: () => { const n = count(); rqQueued = Math.max(rqQueued, n); return n; } };
const subs = new Map();
const gateway = { subscribe: async (config) => {
  const e = { config, cb: undefined }; subs.set(config.group, e);
  return { addEventListener: (_t, cb) => { e.cb = cb; }, removeEventListener() {}, unsubscribe: async () => {} };
} };
const recovered = [];
const session = createRouteMabrSession({
  gateway, wasm: { exports }, ingress: 'native', slsEndpoint: { group: slsGroup, port: Number(slsPort), source: slsSource },
  discoverEndpoints: true, baseUrl: 'https://ds.test/',
  raptorq: { wasm: { RaptorQDecoder: rq.RaptorQDecoder }, onRecovered: (o) => recovered.push(o) },
});
await session.start();
// Ground truth: every source object reassembled from the pcap without the drop.
const truth = new Map(); const dropped = new Map(); const seen = new Map();
let fed = 0, droppedPkts = 0;
for (const { dst, payload } of packets(pcap)) {
  const h = lct(payload); if (!h) continue; const pl = payload.subarray(h.hlen);
  const srcMedia = dst === sourceGroup && h.cp === 8 && pl.length > 4;
  if (srcMedia) {
    const t = truth.get(h.toi) ?? truth.set(h.toi, new Map()).get(h.toi); t.set(pl.readUInt32BE(0), Buffer.from(pl.subarray(4)));
    const n = (seen.get(h.toi) ?? 0) + 1; seen.set(h.toi, n);
    if (n === 3) { dropped.set(h.toi, pl.readUInt32BE(0)); droppedPkts++; continue; } // drop one source packet per object
  }
  const e = subs.get(dst); if (!e?.cb) continue;
  e.cb({ detail: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length) }); fed++;
  await new Promise((r) => setImmediate(r));
}
let exact = 0, mismatch = 0;
const full = (toi) => { const m = truth.get(toi); const len = Math.max(...[...m].map(([o, b]) => o + b.length)); const out = Buffer.alloc(len); let have = 0; for (const [o, b] of m) { b.copy(out, o); have += b.length; } return have === len ? out : null; };
for (const o of recovered) { const f = full(Number(o.toi)); if (f && f.equals(Buffer.from(o.data))) exact++; else mismatch++; }
console.log('\nREPLAY ' + JSON.stringify({ subscriptions: [...subs.keys()], packetsFed: fed, sourcePacketsDropped: droppedPkts, raptorqQueueMax: rqQueued,
  recovered: recovered.length, recoveredByteExact: exact, mismatch, recoveredSample: recovered.slice(0, 3).map((o) => `${o.dstIP} TOI=${o.toi} ${o.contentLocation} ${o.data.length}B`) }));
await session.stop();
process.exit(0);
