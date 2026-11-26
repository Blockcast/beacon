// Real route.wasm -> mABR fetch proxy -> Shaka playback test.
//
// The test is intentionally outside the default unit-test command because it
// needs a TinyGo route.wasm, fec-raptorq wasm-bindgen artifacts, and a browser:
//
//   ROUTE_WASM=/path/to/route.wasm \
//   ROUTE_WASM_EXEC=/path/to/wasm_exec.js \
//   CHROME_PATH=/path/to/chrome \
//   npm run test:e2e
//
// It feeds the real parser through the same bytes subscription used by
// window.multicast, drops one source packet from the HLS CMAF segment on the
// byte-offset source flow, sends the staging sender's RaptorQ repair plane on
// its own S-TSID RepairFlow group, and verifies that recovered media plus
// ordinary ROUTE DASH objects are
// consumed by Shaka. Network ingress is simulated; native, AMT, and tuner joins
// are checked as gateway configuration contracts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pimRoot = process.env.PMG_ROOT || resolve(packageRoot, '../../../pim-multicast-gateway');
const multicastRoot = process.env.MULTICAST_ROOT || resolve(packageRoot, '../../../multicast');
const slsFixturePath = join(packageRoot, 'tests/route-sls-fixture.go');
const routeWasmPath = process.env.ROUTE_WASM || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/route.wasm');
const routeExecPath = process.env.ROUTE_WASM_EXEC || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/wasm_exec.js');
const raptorqJsPath = process.env.RAPTORQ_JS || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/raptorq-pkg/raptorq_wasm.js');
const raptorqWasmPath = process.env.RAPTORQ_WASM || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/raptorq-pkg/raptorq_wasm_bg.wasm');
const shakaPath = process.env.SHAKA_JS || join(pimRoot, 'shaka-player/dist/shaka-player.compiled.debug.js');
const productionShakaPath = process.env.SHAKA_PRODUCTION_JS || join(pimRoot, 'shaka-player/dist/shaka-player.experimental.js');
const assetsRoot = process.env.MEDIA_ROOT || join(pimRoot, 'shaka-player/test/test/assets');
const playwrightPath = process.env.PLAYWRIGHT || join(pimRoot, 'node_modules/playwright/index.mjs');
const chromePath = process.env.CHROME_PATH;
// Unmodified players from npm (pinned devDependencies), loaded as published
// bundles: no Blockcast fork, no patch, no adapter hook in the player.
const npmPlayers = {
  'shaka-upstream': { pkg: 'shaka-player', file: 'dist/shaka-player.compiled.js' },
  hlsjs: { pkg: 'hls.js', file: 'dist/hls.min.js' },
};
for (const player of Object.values(npmPlayers)) {
  const root = join(packageRoot, 'node_modules', player.pkg);
  player.path = join(root, player.file);
  player.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const pinned = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).devDependencies[player.pkg];
  assert.equal(player.version, pinned, `${player.pkg} installed ${player.version}, pinned ${pinned}`);
  player.sha256 = createHash('sha256').update(readFileSync(player.path)).digest('hex');
}

const routeWasm = readFileSync(routeWasmPath);
const wasmExec = readFileSync(routeExecPath);
const raptorqJs = readFileSync(raptorqJsPath);
const raptorqWasm = readFileSync(raptorqWasmPath);
const shaka = readFileSync(shakaPath, 'utf8');
const shakaVariants = [{ name: 'configured', source: shaka }];
if (existsSync(productionShakaPath) && productionShakaPath !== shakaPath) {
  shakaVariants.push({ name: 'production', source: readFileSync(productionShakaPath, 'utf8') });
}
const files = new Map([
  ['dash/dash.mpd', join(assetsRoot, 'dash-vr/dash.mpd')],
  ['dash/init.mp4', join(assetsRoot, 'dash-vr/init.mp4')],
  ...Array.from({ length: 6 }, (_, index) => [`dash/segment_${index}.m4s`, join(assetsRoot, `dash-vr/segment_${index}.m4s`)]),
  // Keep the master in the same DS-root scope as the media playlist so the
  // browser test exercises Shaka's normal master -> variant resolution.
  ['hls/master.m3u8', undefined],
  ['hls/media.m3u8', join(assetsRoot, 'hls-mp4-muxed-aac-h264/hls.m3u8')],
  ['hls/init.mp4', join(assetsRoot, 'hls-mp4-muxed-aac-h264/init.mp4')],
  ['hls/hls11.m4s', join(assetsRoot, 'hls-mp4-muxed-aac-h264/hls11.m4s')],
]);
const hlsMaster = Buffer.from('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n');
const dataByLocation = new Map([...files].map(([location, path]) => [location, path ? readFileSync(path) : hlsMaster]));
const hlsSegmentSha256 = createHash('sha256').update(dataByLocation.get('hls/hls11.m4s')).digest('hex');
// Init segments are the ones the manifests declare (DASH initialization=, HLS
// #EXT-X-MAP), not whatever is called init.mp4. Needs `npm run build` first.
const { isInit, manifestNames } = await import('../dist/manifest-names.js');
const E2E_ORIGIN = 'http://e2e.invalid/';
const initLocations = [...dataByLocation].filter(([location]) => /\.(mpd|m3u8)$/.test(location)).flatMap(([location, data]) => {
  const names = manifestNames(E2E_ORIGIN + location, data.toString('utf8'), E2E_ORIGIN);
  return [...dataByLocation.keys()].filter((candidate) => isInit(E2E_ORIGIN + candidate, names));
});
const encoded = Object.fromEntries([...dataByLocation].map(([location, data]) => [location, data.toString('base64')]));
const fixtureEnv = {
  ...process.env,
  GOMODCACHE: process.env.GOMODCACHE || '/home/oramadan/go/pkg/mod',
  GOCACHE: process.env.GOCACHE || '/home/oramadan/.cache/go-build',
  LD_LIBRARY_PATH: [
    join(multicastRoot, 'fec-raptorq/c-bindings/target/release'),
    process.env.LD_LIBRARY_PATH,
  ].filter(Boolean).join(':'),
};
let slsFixture;
try {
  slsFixture = JSON.parse(execFileSync(
    process.env.GO_BIN || 'go',
    ['run', slsFixturePath, '-assets', assetsRoot],
    { cwd: multicastRoot, env: fixtureEnv, encoding: 'utf8' },
  ));
} catch (error) {
  throw new Error(`multicast SLS fixture generation failed; set MULTICAST_ROOT or build fec-raptorq: ${error.message}`);
}

const createPage = (shakaSource) => `<!doctype html><meta charset=utf-8><video id=v muted playsinline></video>
<script>
if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, factory) { if (!this.has(key)) this.set(key, factory(key)); return this.get(key); };
window.__assets = ${JSON.stringify(encoded)};
window.__hlsSegmentSha256 = ${JSON.stringify(hlsSegmentSha256)};
window.__initLocations = ${JSON.stringify(initLocations)};
window.__sls = ${JSON.stringify(slsFixture.body)};
window.__fixture = ${JSON.stringify(slsFixture)};
window.__shaka = ${JSON.stringify(shakaSource)};
window.__log = [];
window.__fec = {};
</script>
<script src="/wasm_exec.js"></script>
<script type="module">
const log = (value) => window.__log.push(String(value));
const assets = window.__assets;
const fixture = window.__fixture;
const sls = Uint8Array.from(atob(window.__sls), (value) => value.charCodeAt(0));
const params = new URL(location.href).searchParams;
const ingress = params.get('ingress') || 'native';
// The derived pass passes no baseUrl: start() takes the DS origin root and
// the PresentationManifest's directory, and Shaka loads session.manifestUrl.
const transparent = params.get('mode') === 'transparent';
// transparent: the page never calls installFetch(); installTransparentAdapter()
// answers ordinary DS URLs. DASH derives its scope from the SLT; HLS gives an
// explicit /hls/ scope and no SLT (a multicast manifest never sets scope, R1).
const hlsFormat = params.get('format') === 'hls';
const forceFailure = params.get('fail') === '1';
const playerName = params.get('player') || 'shaka';
const derived = params.get('mode') === 'derived' || (transparent && !hlsFormat);
// Loss + RaptorQ repair runs in the default pass and in the transparent HLS
// pass, where the recovered segment must reach an unmodified player.
const fecPass = !derived;
const { createRouteMabrSession } = await import('/mabr-route-proxy/index.js');
const rqModule = await import('/rq/raptorq_wasm.js');
await rqModule.default('/rq/raptorq_wasm_bg.wasm');
const routeBytes = await (await fetch('/route.wasm')).arrayBuffer();
const go = new Go();
const instantiated = await WebAssembly.instantiate(routeBytes, go.importObject);
go.run(instantiated.instance);
const routeExports = instantiated.instance.exports;
routeExports.route_init();
// Counts every encoding-6 symbol route.wasm queued; the session drains the
// queue synchronously, so route_get_raptorq_count() alone reads 0 afterwards.
let raptorqQueued = 0;
const sessionExports = { ...routeExports, route_pop_raptorq_advance: () => { raptorqQueued++; routeExports.route_pop_raptorq_advance(); } };
const subscriptions = [];
const gateway = {
  subscribe: async (config) => {
    const entry = { config, callback: undefined };
    subscriptions.push(entry);
    return {
      addEventListener: (_type, callback) => { entry.callback = callback; },
      removeEventListener: () => {},
      unsubscribe: async () => {},
    };
  },
};
const sessionOptions = {
  gateway,
  wasm: { exports: sessionExports },
  ingress,
  // HTTP LLS/SLT selects the service SLS leg. Rendition legs are learned from
  // S-TSID in the proxy's unit coverage; this browser test exercises the same
  // bootstrap before feeding real route.wasm and Shaka.
  // Transparent passes are configured with an HTTPS SLT URL and a service id
  // only: (S,G), port and cache scope all come from the SLT. /slt/8 is the
  // same SLT advertising the HLS presentation manifest.
  ...(transparent && hlsFormat
    ? { sltUrl: location.origin + '/slt/8', serviceId: 'nasa-iss-a' }
    : { sltUrl: location.origin + '/slt/', serviceId: 'nasa-iss-a',
        ...(derived ? {} : { baseUrl: location.origin + '/mabr/' }) }),
  discoverEndpoints: true,
  ...(transparent ? { transparent: { unauthenticatedSegments: [location.origin] } } : {}),
  raptorq: {
    wasm: { RaptorQDecoder: rqModule.RaptorQDecoder },
    onRecovered: (object) => log('RaptorQ recovered ' + object.contentLocation + ' ' + object.data.length),
  },
};
// AMT discovery is relay-less in the browser contract. The SLS source is
// carried into the gateway subscription, which resolves RFC 8777 TYPE260
// records for that source; the DS hostname is only the HTTPS SLS authority.
window.__sessionOptions = JSON.stringify(sessionOptions, (key, value) => (key === 'gateway' || key === 'wasm' || key === 'raptorq' ? undefined : value));
const session = createRouteMabrSession(sessionOptions);
await session.start();
const expectedManifest = location.origin + (hlsFormat ? '/hls/master.m3u8' : '/dash/dash.mpd');
if ((derived || transparent) && session.manifestUrl !== expectedManifest) {
  throw new Error('derived manifestUrl=' + session.manifestUrl);
}
window.__gatewayConfigs = subscriptions.map(({ config }) => config);
window.__installFetchCalled = false;
if (transparent) {
  const installFetch = session.installFetch.bind(session);
  session.installFetch = () => { window.__installFetchCalled = true; return installFetch(); };
  if (forceFailure) session.resolve = async () => { throw new Error('forced adapter failure'); };
  const { installTransparentAdapter } = await import('/mabr-route-proxy/index.js');
  window.__adapter = installTransparentAdapter(session);
} else {
  session.installFetch();
}
const send = (group, packet) => {
  const entry = subscriptions.find(({ config }) => config.group === group);
  if (!entry?.callback) throw new Error('no active multicast subscription for ' + group);
  entry.callback({ detail: packet.buffer });
};
function lct(toi, codePoint, closeObject, payload, extension = new Uint8Array(), tsi = 0) {
  // ROUTE uses a 32-bit TSI followed by the 32-bit TOI. SLS is TSI=0;
  // media packets use the TSI advertised by the generated S-TSID.
  const headerLength = 16 + extension.length;
  const packet = new Uint8Array(headerLength + payload.length);
  const view = new DataView(packet.buffer);
  const word1 = (1 << 12) | (1 << 7) | (1 << 5) | (closeObject ? 1 : 0);
  view.setUint16(0, word1, false);
  view.setUint16(2, ((headerLength / 4) << 8) | codePoint, false);
  // C=0 means bytes 4..7 are absent CCI; TSI starts at byte 8.
  view.setUint32(4, 0, false);
  view.setUint32(8, tsi, false);
  view.setUint32(12, toi, false);
  packet.set(extension, 16);
  packet.set(payload, headerLength);
  return packet;
}
function compactFti(transferLength, symbolLength, maxSourceBlockLength = transferLength) {
  const extension = new Uint8Array(16);
  const view = new DataView(extension.buffer);
  extension[0] = 64;
  extension[1] = 4;
  // RFC 6330 CompactNoCode FTI: F is 40 bits, followed by E and B.
  view.setUint16(2, Math.floor(transferLength / 0x100000000), false);
  view.setUint32(4, transferLength >>> 0, false);
  view.setUint32(8, symbolLength, false);
  view.setUint32(12, maxSourceBlockLength, false);
  return extension;
}

function sendObject(group, toi, codePoint, data, { dropPacket = -1, close = true } = {}) {
  const packetSize = 1200;
  for (let offset = 0, index = 0; offset < data.length; offset += packetSize, index++) {
    if (index === dropPacket) continue;
    const part = data.subarray(offset, Math.min(offset + packetSize, data.length));
    const payloadId = new Uint8Array(4);
    new DataView(payloadId.buffer).setUint32(0, offset, false);
    send(group, lct(toi, codePoint, close && offset + part.length === data.length, new Uint8Array([...payloadId, ...part]), offset === 0 ? compactFti(data.length, 1) : undefined, 1));
  }
}

// The existing ROUTE parser consumes the SLS object generated by
// multicast/route.SLSPackage.Update. TSI=0/TOI=0 is the receiver's inline SLS
// bootstrap path; its S-TSID carries the media FDT and endpoint.
const slsPayloadId = new Uint8Array(4);
send(fixture.slsGroup, lct(0, 3, true, new Uint8Array([...slsPayloadId, ...sls])));
const slsManifestCount = routeExports.route_sls_manifest_count?.() ?? 0;
if (slsManifestCount !== fixture.manifestLocations.length) {
  throw new Error('generated SLS manifest count=' + slsManifestCount + ' expected=' + fixture.manifestLocations.length);
}
const slsLocations = Array.from({ length: slsManifestCount }, (_, index) => {
  const pointer = routeExports.route_sls_manifest_location(index);
  const length = routeExports.route_sls_manifest_location_len();
  return new TextDecoder().decode(new Uint8Array(routeExports.memory.buffer, Number(pointer), length));
});
for (const location of fixture.manifestLocations) {
  if (!slsLocations.includes(location)) throw new Error('generated SLS manifest missing ' + location);
}
log('generated SLS manifests=' + slsLocations.join(','));
for (let attempt = 0; attempt < 100 && !subscriptions.some(({ config }) => config.group === fixture.mediaGroup); attempt++) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}
if (!subscriptions.some(({ config }) => config.group === fixture.mediaGroup)) {
  throw new Error('S-TSID did not create media subscription; sessions=' + (routeExports.route_stsid_session_count?.() ?? 0));
}
window.__gatewayConfigs = subscriptions.map(({ config }) => config);
for (const [location, base64] of Object.entries(assets)) {
  if (location === 'hls/hls11.m4s' && (fecPass || !transparent)) continue;
  sendObject(fixture.mediaGroup, Object.keys(assets).indexOf(location) + 1, location.endsWith('.mpd') || location.endsWith('.m3u8') ? 3 : window.__initLocations.includes(location) ? 5 : 8, Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)));
}

// The HLS segment is outside the derived pass's /dash/ scope.
if (fecPass) {
  // Mirror the deployed staging sender (route/sender.go): source on the
  // byte-offset flow, and per source block of K symbols (the final block
  // K'-native short) RFC 6330 repair on the RepairFlow group under the same
  // TOI, with the 8-byte [SBN:32][0:8|ESI:24] payload ID, then a header-only
  // close. One dropped 1200-byte source packet loses two T=1344 symbols of
  // block 0, which only the repair plane can restore.
  const fecLocation = 'hls/hls11.m4s';
  const recovered = Uint8Array.from(atob(assets[fecLocation]), (value) => value.charCodeAt(0));
  const fecToi = Object.keys(assets).indexOf(fecLocation) + 1;
  const T = fixture.raptorqSymbolLength;
  const blockBytes = T * fixture.raptorqSourceBlockLength;
  const repairPerBlock = fixture.raptorqMaxNumEs - fixture.raptorqSourceBlockLength;
  let repairSymbols = 0;
  sendObject(fixture.mediaGroup, fecToi, 8, recovered, { dropPacket: 1, close: false });
  for (let sbn = 0; sbn * blockBytes < recovered.length; sbn++) {
    const block = recovered.subarray(sbn * blockBytes, Math.min((sbn + 1) * blockBytes, recovered.length));
    const encoder = new rqModule.RaptorQEncoder(block, T, repairPerBlock, 1, 1, 8);
    const repair = encoder.get_repair_packets(0, 0, repairPerBlock);
    const packetSize = encoder.packet_size();
    encoder.free();
    for (let offset = 0; offset < repair.length; offset += packetSize) {
      // fec-raptorq emits RFC 6330's 4-byte [SBN:8|ESI:24]; ROUTE encoding 6
      // carries the 8-byte INVARIANTS §13.2 ID.
      const esi = (repair[offset + 1] << 16) | (repair[offset + 2] << 8) | repair[offset + 3];
      const wire = new Uint8Array(8 + T);
      new DataView(wire.buffer).setUint32(0, sbn, false);
      new DataView(wire.buffer).setUint32(4, esi, false);
      wire.set(repair.subarray(offset + 4, offset + packetSize), 8);
      send(fixture.repairGroup, lct(fecToi, 129, false, wire, undefined, 1));
      repairSymbols++;
    }
  }
  send(fixture.mediaGroup, lct(fecToi, 8, true, new Uint8Array(), undefined, 1));
  window.__fec = { location: fecLocation, toi: fecToi, transferLength: recovered.length, sourceSymbols: Math.ceil(recovered.length / T), droppedSource: 1, repairSymbols, raptorqQueued };
  if (raptorqQueued === 0) throw new Error('route.wasm queued no encoding-6 symbols fec=' + JSON.stringify(window.__fec));
  log('after FEC rq=' + raptorqQueued);
  for (let attempt = 0; attempt < 100 && !window.__log.some((value) => value.startsWith('RaptorQ recovered ' + fecLocation + ' ')); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (!window.__log.some((value) => value.startsWith('RaptorQ recovered ' + fecLocation + ' '))) throw new Error('RaptorQ recovery callback missing');
}
// Transparent: the recovered segment is checked by the player itself and by
// the node side asserting it never reached HTTP. Default mode reads it here.
if (fecPass && !transparent) {
  const fecLocation = window.__fec.location;
  const recovered = Uint8Array.from(atob(assets[fecLocation]), (value) => value.charCodeAt(0));
  const recoveredResponse = await session.fetch(location.origin + '/mabr/' + fecLocation);
  if (recoveredResponse.status !== 200) throw new Error('recovered object status=' + recoveredResponse.status + ' log=' + JSON.stringify(window.__log) + ' fec=' + JSON.stringify(window.__fec) + ' rq=' + routeExports.route_get_raptorq_count());
  const recoveredBytes = new Uint8Array(await recoveredResponse.arrayBuffer());
  if (recoveredBytes.length !== recovered.length || recoveredBytes.some((value, index) => value !== recovered[index])) throw new Error('recovered object bytes mismatch');
  log('RaptorQ media fetch verified');
}

if (playerName === 'shaka') {
  const shakaScript = document.createElement('script');
  shakaScript.text = window.__shaka;
  document.head.append(shakaScript);
} else {
  // Published npm bundle, loaded exactly as a site would load it.
  await new Promise((resolveLoad, rejectLoad) => {
    const script = document.createElement('script');
    script.src = '/player/' + playerName + '.js';
    script.onload = resolveLoad;
    script.onerror = () => rejectLoad(new Error('failed to load player ' + playerName));
    document.head.append(script);
  });
}
const video = document.querySelector('#v');
let player;
if (playerName === 'shaka') player = new shaka.Player(video);
else if (playerName === 'shaka-upstream') { player = new shaka.Player(); await player.attach(video); }
async function play(url, label) {
  let hls;
  if (playerName === 'hlsjs') {
    if (!Hls.isSupported()) throw new Error('hls.js: MediaSource unsupported');
    hls = new Hls({ enableWorker: false });
    await new Promise((resolveLoad, rejectLoad) => {
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) rejectLoad(new Error('hls.js fatal ' + data.type + '/' + data.details)); });
      hls.on(Hls.Events.MANIFEST_PARSED, resolveLoad);
      hls.attachMedia(video);
      hls.loadSource(url);
    });
  } else {
    await player.load(url);
  }
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  log(label + ':readyState=' + video.readyState + ',buffered=' + video.buffered.length);
  if (video.readyState < 2 || video.buffered.length < 1) throw new Error(label + ' did not decode buffered media');
  if (hls) hls.destroy(); else await player.unload();
}
// HTTP semantics an ordinary player relies on, against the same ordinary DS
// URLs, through the installed adapter (fetch and XHR).
async function probeHttpSemantics() {
  const dir = location.origin + (hlsFormat ? '/hls/' : '/dash/');
  const segment = dir + (hlsFormat ? 'hls11.m4s' : 'segment_0.m4s');
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const full = new Uint8Array(await (await fetch(segment)).arrayBuffer());
  if (hlsFormat) {
    const digest = await crypto.subtle.digest('SHA-256', full);
    const actual = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    if (actual !== window.__hlsSegmentSha256) throw new Error('repaired HLS bytes do not match the fixture: ' + actual);
  }
  const ranged = await fetch(segment, { headers: { range: 'bytes=0-99' } });
  const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
  if (ranged.status !== 206 || ranged.headers.get('content-range') !== 'bytes 0-99/' + full.length || !same(rangedBytes, full.subarray(0, 100))) {
    throw new Error('range: status=' + ranged.status + ' content-range=' + ranged.headers.get('content-range') + ' bytes=' + rangedBytes.length);
  }
  const head = await fetch(segment, { method: 'HEAD' });
  const headBytes = (await head.arrayBuffer()).byteLength;
  if (head.status !== 200 || head.headers.get('content-length') !== String(full.length) || headBytes !== 0) {
    throw new Error('HEAD: status=' + head.status + ' content-length=' + head.headers.get('content-length') + ' body=' + headBytes);
  }
  const xhrRange = await new Promise((resolveXhr, rejectXhr) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', segment);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', 'bytes=100-199');
    xhr.onload = () => resolveXhr(xhr);
    xhr.onerror = () => rejectXhr(new Error('xhr range error'));
    xhr.send();
  });
  if (xhrRange.status !== 206 || !same(new Uint8Array(xhrRange.response), full.subarray(100, 200))) throw new Error('xhr range: status=' + xhrRange.status);
  const controller = new AbortController();
  const aborted = fetch(segment, { signal: controller.signal });
  controller.abort();
  const abortOutcome = await aborted.then(() => 'resolved', (error) => error.name);
  if (abortOutcome !== 'AbortError') throw new Error('fetch abort: ' + abortOutcome);
  const xhrAbort = await new Promise((resolveXhr) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', segment);
    xhr.onabort = () => resolveXhr('abort status=' + xhr.status);
    xhr.onload = () => resolveXhr('load');
    xhr.send();
    xhr.abort();
  });
  if (xhrAbort !== 'abort status=0') throw new Error('xhr abort: ' + xhrAbort);
  if ((await fetch(segment)).status !== 200) throw new Error('fetch after abort failed');
  // Key and licence requests stay on HTTP even inside the cache scope, and a
  // URL outside the scope is never intercepted.
  if ((await (await fetch(dir + 'key.bin')).text()) !== 'http-key') throw new Error('key request did not reach HTTP');
  const licence = await fetch(location.origin + '/license', { method: 'POST', body: 'challenge' });
  if ((await licence.text()) !== 'http-license:challenge') throw new Error('licence request did not reach HTTP');
  if ((await (await fetch(location.origin + '/other/segment_0.m4s')).text()) !== 'http-other') throw new Error('out-of-scope request did not reach HTTP');
  log('probes: range, HEAD, xhr range, fetch/xhr abort, key, licence and out-of-scope ok');
}
if (transparent) {
  // An ordinary URL, not session.manifestUrl: the player is unmodified.
  await play(location.origin + (hlsFormat ? '/hls/master.m3u8' : '/dash/dash.mpd'), (hlsFormat ? 'HLS' : 'DASH') + ' transparent ' + playerName);
  if (!forceFailure) await probeHttpSemantics();
} else if (derived) {
  await play(session.manifestUrl, 'DASH derived');
} else {
  await play(location.origin + '/mabr/dash/dash.mpd', 'DASH');
  await play(location.origin + '/mabr/hls/master.m3u8', 'HLS master');
}
window.__cacheStats = () => session.cacheStats;
window.__sessionManifestUrl = session.manifestUrl;
window.__done = true;
</script>`;

const requests = [];
// The same SLT, advertising the HLS presentation manifest instead of DASH.
const hlsSlt = slsFixture.slt.replace('/dash/dash.mpd', '/hls/master.m3u8');
assert.notEqual(hlsSlt, slsFixture.slt, 'fixture SLT does not advertise /dash/dash.mpd');
const server = http.createServer((request, response) => {
  const path = request.url?.split('?')[0] || '/';
  requests.push(path);
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    const variant = new URL(`http://127.0.0.1${request.url || '/'}`).searchParams.get('shaka') || shakaVariants[0].name;
    const selected = shakaVariants.find(({ name }) => name === variant) || shakaVariants[0];
    response.end(createPage(selected.source));
  } else if (path === '/slt/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<a href="7">7</a>');
  } else if (path === '/slt/7') {
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(slsFixture.slt);
  } else if (path === '/slt/8') {
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(hlsSlt);
  } else if (path.startsWith('/player/') && npmPlayers[path.slice('/player/'.length, -'.js'.length)]) {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(npmPlayers[path.slice('/player/'.length, -'.js'.length)].path));
  } else if (path === '/dash/key.bin' || path === '/hls/key.bin') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end('http-key');
  } else if (path === '/license' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('http-license:' + Buffer.concat(chunks).toString());
    });
  } else if (path === '/other/segment_0.m4s') {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end('http-other');
  } else if (path === '/route.wasm') {
    response.writeHead(200, { 'content-type': 'application/wasm' });
    response.end(routeWasm);
  } else if (path === '/wasm_exec.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(wasmExec);
  } else if (path === '/rq/raptorq_wasm.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(raptorqJs);
  } else if (path === '/rq/raptorq_wasm_bg.wasm') {
    response.writeHead(200, { 'content-type': 'application/wasm' });
    response.end(raptorqWasm);
  } else if (path.startsWith('/mabr-route-proxy/')) {
    const modulePath = path.slice('/mabr-route-proxy/'.length);
    if (!['index.js', 'proxy.js', 'route.js', 'route-health.js', 'adapter.js', 'manifest-names.js', 'gateway.js', 'respond.js'].includes(modulePath)) {
      response.writeHead(404);
      response.end('module miss');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(join(packageRoot, 'dist', modulePath)));
  } else if (/^\/(?:dash|hls)\//.test(path) && dataByLocation.has(path.slice(1))) {
    // Plain DS over HTTPS: the transparent passes load manifests (and, when
    // ROUTE cannot answer, segments) from here.
    const data = dataByLocation.get(path.slice(1));
    response.writeHead(200, { 'content-type': path.endsWith('.mpd') ? 'application/dash+xml' : path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
    response.end(data);
  } else if (path === '/favicon.ico') {
    response.writeHead(204);
    response.end();
  } else {
    response.writeHead(404);
    response.end('network miss');
  }
});

const { chromium } = await import(pathToFileURL(playwrightPath).href);
await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
const port = server.address().port;
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});
try {
  const openPage = async (query) => {
    const pageHandle = await browser.newPage();
    const errors = [];
    pageHandle.on('pageerror', (error) => errors.push(error.stack || String(error)));
    pageHandle.on('console', (message) => {
      console.error(`[browser:${message.type()}] ${message.text()}`);
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await pageHandle.goto(`http://127.0.0.1:${port}/?${query}`);
      for (let attempt = 0; attempt < 120; attempt++) {
        if ((await pageHandle.evaluate(() => window.__done === true))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      const state = await pageHandle.evaluate(() => ({
        done: window.__done === true,
        log: window.__log,
        fec: window.__fec,
        gatewayConfigs: window.__gatewayConfigs,
        installFetchCalled: window.__installFetchCalled,
        adapter: window.__adapter?.status(),
        cache: window.__cacheStats?.(),
        sessionOptions: window.__sessionOptions,
        manifestUrl: window.__sessionManifestUrl,
      }));
      assert.equal(errors.length, 0, errors.join(' | '));
      assert.equal(state.done, true, JSON.stringify(state));
      return state;
    } finally {
      await pageHandle.close();
    }
  };
  for (const shakaVariant of shakaVariants) {
    for (const ingress of ['native', 'amt', 'tuner']) {
      const state = await openPage(`ingress=${ingress}&shaka=${shakaVariant.name}`);
      assert.equal(state.fec.location, 'hls/hls11.m4s');
      assert.equal(state.fec.droppedSource, 1);
      assert.ok(state.fec.raptorqQueued > 0, `route.wasm queued no RaptorQ symbols: ${JSON.stringify(state.fec)}`);
      const expectedGatewayConfigs = ingress === 'native'
        ? [
          { group: slsFixture.slsGroup, port: slsFixture.slsPort, source: slsFixture.slsSource, consume: 'bytes', origin: 'ip-multicast' },
          { group: slsFixture.mediaGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'ip-multicast' },
          { group: slsFixture.repairGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'ip-multicast' },
        ]
        : ingress === 'amt' ? [
          { group: slsFixture.slsGroup, port: slsFixture.slsPort, source: slsFixture.slsSource, consume: 'bytes', origin: 'amt', discovery: 'driad' },
          { group: slsFixture.mediaGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'amt', discovery: 'driad' },
          { group: slsFixture.repairGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'amt', discovery: 'driad' },
        ] : [
          { group: slsFixture.slsGroup, port: slsFixture.slsPort, source: slsFixture.slsSource, consume: 'bytes', origin: 'tuner', standard: 'atsc3', protocol: 'route' },
          { group: slsFixture.mediaGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'tuner', standard: 'atsc3', protocol: 'route' },
          { group: slsFixture.repairGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'tuner', standard: 'atsc3', protocol: 'route' },
        ];
      assert.deepEqual(state.gatewayConfigs, expectedGatewayConfigs);
      console.log(`${shakaVariant.name}/${ingress}: ${state.log.join('; ')}`);
    }
  }
  const derivedFrom = requests.length;
  const derivedState = await openPage(`ingress=native&shaka=${shakaVariants[0].name}&mode=derived`);
  console.log(`${shakaVariants[0].name}/native/derived: ${derivedState.log.join('; ')}`);
  const derivedMedia = requests.slice(derivedFrom).filter((path) => path.startsWith('/dash/'));
  assert.deepEqual(derivedMedia, [], `derived DS URLs escaped to HTTP: ${derivedMedia.join(', ')}`);
  assert.ok(requests.includes('/slt/'), 'HTTP LLS group discovery was not requested');
  assert.ok(requests.includes('/slt/7'), 'HTTP SLT document was not requested');
  const mediaRequests = requests.filter((path) => path.startsWith('/mabr/'));
  assert.deepEqual(mediaRequests, [], `cached media escaped to HTTP: ${mediaRequests.join(', ')}`);
  // Transparent interception: an unmodified Shaka loads ordinary DS URLs; no
  // installFetch() call. Manifests come over unicast (R8); segments from ROUTE.
  for (const [name, player] of Object.entries(npmPlayers)) console.log(`unmodified player ${player.pkg}@${player.version} sha256=${player.sha256} (${name})`);
  const transparentPasses = [
    ['shaka', 'dash'], ['shaka', 'hls'],
    ['shaka-upstream', 'dash'], ['shaka-upstream', 'hls'],
    ['hlsjs', 'hls'],
  ];
  for (const [player, format] of transparentPasses) {
    const from = requests.length;
    const state = await openPage(`ingress=native&shaka=${shakaVariants[0].name}&mode=transparent&format=${format}&player=${player}`);
    const seen = requests.slice(from).filter((path) => path.startsWith(`/${format}/`));
    assert.equal(state.installFetchCalled, false, 'transparent page must not call installFetch()');
    assert.ok(state.cache.hits > 0, `${player}/${format}: cacheStats.hits=${state.cache.hits}`);
    assert.ok(seen.some((path) => /\.(mpd|m3u8)$/.test(path)), `${player}/${format}: manifest must load over unicast: ${seen.join(',')}`);
    const media = seen.filter((path) => /\.(m4s|mp4)$/.test(path));
    assert.deepEqual(media, [], `${player}/${format}: segments escaped to HTTP: ${media.join(',')}`);
    // Range/HEAD/abort/key/licence/scope probes ran in the page; the control
    // plane requests must have reached this HTTP server.
    assert.ok(state.log.some((line) => line.startsWith('probes: ')), `${player}/${format}: probes did not run`);
    const after = requests.slice(from);
    for (const path of [`/${format}/key.bin`, '/license', '/other/segment_0.m4s']) {
      assert.ok(after.includes(path), `${player}/${format}: ${path} did not reach HTTP`);
    }
    // No hard-coded (S,G): the page was configured with an HTTPS SLT URL and a
    // service id; every multicast join came from the SLT and its S-TSID.
    const configured = JSON.parse(state.sessionOptions);
    assert.deepEqual(Object.keys(configured).sort(), ['discoverEndpoints', 'ingress', 'serviceId', 'sltUrl', 'transparent']);
    // The page origin is the test server's own 127.0.0.1 address; strip it so only multicast addressing could match.
    assert.doesNotMatch(state.sessionOptions.replaceAll(`http://127.0.0.1:${port}`, 'DS'), /\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'page options carry an IP literal');
    assert.ok(after.includes(format === 'hls' ? '/slt/8' : '/slt/7'), `${player}/${format}: SLT was not fetched over HTTP`);
    assert.deepEqual(state.gatewayConfigs.map(({ group, source }) => [group, source]), [
      [slsFixture.slsGroup, slsFixture.slsSource],
      [slsFixture.mediaGroup, slsFixture.mediaSource],
      [slsFixture.repairGroup, slsFixture.mediaSource],
    ]);
    assert.equal(state.manifestUrl, `http://127.0.0.1:${port}/${format === 'hls' ? 'hls/master.m3u8' : 'dash/dash.mpd'}`);
    if (format === 'hls') {
      // One source packet of hls11.m4s was dropped on multicast; only the
      // RaptorQ repair flow could restore it, and the player consumed it.
      assert.equal(state.fec.droppedSource, 1);
      assert.ok(state.fec.repairSymbols > 0 && state.fec.raptorqQueued > 0, JSON.stringify(state.fec));
      assert.ok(state.log.some((line) => line.startsWith('RaptorQ recovered hls/hls11.m4s ')), state.log.join('; '));
      assert.ok(!seen.includes('/hls/hls11.m4s'), 'repaired segment was fetched over HTTP');
    }
    console.log(`transparent/${player}/${format}: hits=${state.cache.hits} misses=${state.cache.misses} adapter=${JSON.stringify(state.adapter)} log=${state.log.join('; ')}`);
  }
  // Forced adapter failure: every lookup throws, playback still works over unicast.
  {
    const from = requests.length;
    const state = await openPage(`ingress=native&shaka=${shakaVariants[0].name}&mode=transparent&fail=1`);
    const media = requests.slice(from).filter((path) => /^\/dash\/.*\.(m4s|mp4)$/.test(path));
    assert.ok(media.length > 0, 'forced failure must fall through to unicast segments');
    assert.equal(state.cache.hits, 0);
    assert.ok(state.adapter.errors > 0, JSON.stringify(state.adapter));
    console.log(`transparent/forced-failure: unicast media=${media.length} adapter=${JSON.stringify(state.adapter)}`);
  }
  console.log('PASS: unmodified players (Blockcast Shaka build, upstream shaka-player, hls.js) played ordinary DS URLs through the transparent adapter with SLT-only config; range/HEAD/abort/key/licence/scope probes and transparent RaptorQ repair passed');
  console.log('PASS: real route.wasm + RaptorQ loss recovery reached Shaka DASH/HLS; native, AMT, and tuner gateway contracts passed; derived DS URLs played DASH from the ROUTE cache (network ingress simulated)');
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
