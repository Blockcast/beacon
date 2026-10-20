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
// window.multicast, drops one RaptorQ source symbol from the HLS CMAF segment,
// and verifies that recovered media plus ordinary ROUTE DASH objects are
// consumed by Shaka. Network ingress is simulated; native and AMT joins
// are checked as gateway configuration contracts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
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
const assetsRoot = process.env.MEDIA_ROOT || join(pimRoot, 'shaka-player/test/test/assets');
const playwrightPath = process.env.PLAYWRIGHT || join(pimRoot, 'node_modules/playwright/index.mjs');
const chromePath = process.env.CHROME_PATH;

const routeWasm = readFileSync(routeWasmPath);
const wasmExec = readFileSync(routeExecPath);
const raptorqJs = readFileSync(raptorqJsPath);
const raptorqWasm = readFileSync(raptorqWasmPath);
const shaka = readFileSync(shakaPath, 'utf8');
const files = new Map([
  ['dash/dash.mpd', join(assetsRoot, 'dash-vr/dash.mpd')],
  ['dash/init.mp4', join(assetsRoot, 'dash-vr/init.mp4')],
  ...Array.from({ length: 6 }, (_, index) => [`dash/segment_${index}.m4s`, join(assetsRoot, `dash-vr/segment_${index}.m4s`)]),
  ['hls/media.m3u8', join(assetsRoot, 'hls-mp4-muxed-aac-h264/hls.m3u8')],
  ['hls/init.mp4', join(assetsRoot, 'hls-mp4-muxed-aac-h264/init.mp4')],
  ['hls/hls11.m4s', join(assetsRoot, 'hls-mp4-muxed-aac-h264/hls11.m4s')],
]);
const dataByLocation = new Map([...files].map(([location, path]) => [location, readFileSync(path)]));
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

const page = `<!doctype html><meta charset=utf-8><video id=v muted playsinline></video>
<script>
if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, factory) { if (!this.has(key)) this.set(key, factory(key)); return this.get(key); };
window.__assets = ${JSON.stringify(encoded)};
window.__sls = ${JSON.stringify(slsFixture.body)};
window.__fixture = ${JSON.stringify(slsFixture)};
window.__shaka = ${JSON.stringify(shaka)};
window.__log = [];
window.__fec = {};
</script>
<script src="/wasm_exec.js"></script>
<script type="module">
const log = (value) => window.__log.push(String(value));
const assets = window.__assets;
const fixture = window.__fixture;
const sls = Uint8Array.from(atob(window.__sls), (value) => value.charCodeAt(0));
const ingress = new URL(location.href).searchParams.get('ingress') || 'native';
const { createRouteMabrSession } = await import('/mabr-route-proxy/index.js');
const rqModule = await import('/rq/raptorq_wasm.js');
await rqModule.default('/rq/raptorq_wasm_bg.wasm');
const routeBytes = await (await fetch('/route.wasm')).arrayBuffer();
const go = new Go();
const instantiated = await WebAssembly.instantiate(routeBytes, go.importObject);
go.run(instantiated.instance);
const routeExports = instantiated.instance.exports;
routeExports.route_init();
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
  wasm: { exports: routeExports },
  ingress,
  // HTTP LLS/SLT selects the service SLS leg. Rendition legs are learned from
  // S-TSID in the proxy's unit coverage; this browser test exercises the same
  // bootstrap before feeding real route.wasm and Shaka.
  sltUrl: location.origin + '/slt/',
  serviceId: 'nasa-iss-a',
  discoverEndpoints: true,
  baseUrl: location.origin + '/mabr/',
  raptorq: {
    wasm: { RaptorQDecoder: rqModule.RaptorQDecoder },
    onRecovered: (object) => log('RaptorQ recovered ' + object.contentLocation + ' ' + object.data.length),
  },
};
if (ingress === 'amt') Object.assign(sessionOptions, { relay: '198.51.100.20', relayPort: 2268 });
const session = createRouteMabrSession(sessionOptions);
await session.start();
window.__gatewayConfigs = subscriptions.map(({ config }) => config);
session.installFetch();
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

function raptorqFti(transferLength, symbolLength, maxSourceBlockLength, maxEncodingSymbols) {
  const extension = new Uint8Array(28);
  const view = new DataView(extension.buffer);
  extension[0] = 64;
  extension[1] = 7;
  const high = Math.floor(transferLength / 0x1000000);
  view.setUint16(2, high, false);
  view.setUint32(4, (transferLength << 8) >>> 0, false);
  view.setUint16(8, symbolLength, false);
  view.setUint32(10, (1 << 24) | (1 << 8) | 8, false);
  view.setUint16(14, 0, false);
  view.setUint32(16, maxSourceBlockLength, false);
  view.setUint32(20, maxEncodingSymbols, false);
  return extension;
}
function sendObject(group, toi, codePoint, data) {
  const packetSize = 1200;
  for (let offset = 0; offset < data.length; offset += packetSize) {
    const part = data.subarray(offset, Math.min(offset + packetSize, data.length));
    const payloadId = new Uint8Array(4);
    new DataView(payloadId.buffer).setUint32(0, offset, false);
    send(group, lct(toi, codePoint, offset + part.length === data.length, new Uint8Array([...payloadId, ...part]), offset === 0 ? compactFti(data.length, 1) : undefined, 1));
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
  if (location === 'hls/hls11.m4s') continue;
  sendObject(fixture.mediaGroup, Object.keys(assets).indexOf(location) + 1, location.endsWith('.mpd') || location.endsWith('.m3u8') ? 3 : location.endsWith('init.mp4') ? 5 : 8, Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)));
}

// Build a real RFC 6330 codeword for the HLS CMAF segment, drop one source
// symbol, and feed the repair symbols through route.wasm's encoding-6 queue.
// The FDT still advertises the original transfer length/location, so only the
// browser sidecar can make this player request succeed.
const fecLocation = 'hls/hls11.m4s';
const recovered = Uint8Array.from(atob(assets[fecLocation]), (value) => value.charCodeAt(0));
const fecEncoder = new rqModule.RaptorQEncoder(recovered, 1200, 4, 1, 1, 8);
const sourcePackets = fecEncoder.get_source_packets(0);
const repairPackets = fecEncoder.get_repair_packets(0, 0, 4);
const fecPacketSize = fecEncoder.packet_size();
const maxSourceBlockLength = sourcePackets.length / fecPacketSize;
const maxEncodingSymbols = maxSourceBlockLength + repairPackets.length / fecPacketSize;
const fecToi = Object.keys(assets).indexOf(fecLocation) + 1;
window.__fec = { location: fecLocation, toi: fecToi, transferLength: recovered.length, sourceSymbols: maxSourceBlockLength, droppedSource: 1, repairSymbols: repairPackets.length / fecPacketSize };
const sendRaptorQ = (blob, skipSourceIndex = -1) => {
  for (let offset = 0, index = 0; offset < blob.length; offset += fecPacketSize, index++) {
    if (index === skipSourceIndex) continue;
    const localPacket = blob.slice(offset, offset + fecPacketSize);
    // ROUTE/RFC 6330 encoding 6 carries [SBN:8|ESI:24].
    const packet = localPacket;
    // RaptorQ symbols are one object-wide repair plane. The close-object
    // marker is sent by the ROUTE sender's separate closing unit after both
    // source and repair planes; marking the last symbol in either plane
    // makes the receiver retire the object before the other plane arrives.
    send(fixture.mediaGroup, lct(window.__fec.toi, 8, false,
      packet, raptorqFti(recovered.length, 1200, maxSourceBlockLength, maxEncodingSymbols), 1));
  }
};
sendRaptorQ(sourcePackets, window.__fec.droppedSource);
sendRaptorQ(repairPackets);
fecEncoder.free();
log('after FEC rq=' + routeExports.route_get_raptorq_count());
const recoveredResponse = await session.fetch(location.origin + '/mabr/' + fecLocation);
if (recoveredResponse.status !== 200) throw new Error('recovered object status=' + recoveredResponse.status + ' log=' + JSON.stringify(window.__log) + ' fec=' + JSON.stringify(window.__fec) + ' rq=' + routeExports.route_get_raptorq_count());
const recoveredBytes = new Uint8Array(await recoveredResponse.arrayBuffer());
if (recoveredBytes.length !== recovered.length || recoveredBytes.some((value, index) => value !== recovered[index])) throw new Error('recovered object bytes mismatch');
if (!window.__log.some((value) => value.startsWith('RaptorQ recovered ' + fecLocation + ' '))) throw new Error('RaptorQ recovery callback missing');
log('RaptorQ media fetch verified');

const shakaScript = document.createElement('script');
shakaScript.text = window.__shaka;
document.head.append(shakaScript);
const player = new shaka.Player(document.querySelector('#v'));
async function play(url, label) {
  await player.load(url);
  await document.querySelector('#v').play();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const video = document.querySelector('#v');
  log(label + ':readyState=' + video.readyState + ',buffered=' + video.buffered.length);
  if (video.readyState < 2 || video.buffered.length < 1) throw new Error(label + ' did not decode buffered media');
  await player.unload();
}
await play(location.origin + '/mabr/dash/dash.mpd', 'DASH');
await play(location.origin + '/mabr/hls/media.m3u8', 'HLS');
window.__done = true;
</script>`;

const requests = [];
const server = http.createServer((request, response) => {
  const path = request.url?.split('?')[0] || '/';
  requests.push(path);
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  } else if (path === '/slt/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<a href="7">7</a>');
  } else if (path === '/slt/7') {
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end('<SLT><Server serviceId="42" globalServiceID="nasa-iss-a"><BroadcastSvcSignaling slsProtocol="1" slsDestinationIpAddress="239.21.4.1" slsDestinationUdpPort="5004" slsSourceIpAddress="192.0.2.10" /></Server></SLT>');
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
    if (!['index.js', 'proxy.js', 'route.js'].includes(modulePath)) {
      response.writeHead(404);
      response.end('module miss');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(join(packageRoot, 'dist', modulePath)));
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
  for (const ingress of ['native', 'amt']) {
    const pageHandle = await browser.newPage();
    const errors = [];
    pageHandle.on('pageerror', (error) => errors.push(error.stack || String(error)));
    pageHandle.on('console', (message) => {
      console.error(`[browser:${message.type()}] ${message.text()}`);
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await pageHandle.goto(`http://127.0.0.1:${port}/?ingress=${ingress}`);
      for (let attempt = 0; attempt < 120; attempt++) {
        if ((await pageHandle.evaluate(() => window.__done === true))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      const state = await pageHandle.evaluate(() => ({
        done: window.__done === true,
        log: window.__log,
        fec: window.__fec,
        gatewayConfigs: window.__gatewayConfigs,
      }));
      assert.equal(errors.length, 0, errors.join(' | '));
      assert.equal(state.done, true, JSON.stringify(state));
      assert.equal(state.fec.location, 'hls/hls11.m4s');
      assert.equal(state.fec.droppedSource, 1);
      const expectedGatewayConfigs = ingress === 'native'
        ? [
          { group: slsFixture.slsGroup, port: slsFixture.slsPort, source: slsFixture.slsSource, consume: 'bytes', origin: 'ip-multicast' },
          { group: slsFixture.mediaGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'ip-multicast' },
        ]
        : [
          { group: slsFixture.slsGroup, port: slsFixture.slsPort, source: slsFixture.slsSource, consume: 'bytes', origin: 'amt', relay: '198.51.100.20', relayPort: 2268 },
          { group: slsFixture.mediaGroup, port: slsFixture.mediaPort, source: slsFixture.mediaSource, consume: 'bytes', origin: 'amt', relay: '198.51.100.20', relayPort: 2268 },
        ];
      assert.deepEqual(state.gatewayConfigs, expectedGatewayConfigs);
      console.log(`${ingress}: ${state.log.join('; ')}`);
    } finally {
      await pageHandle.close();
    }
  }
  assert.ok(requests.includes('/slt/'), 'HTTP LLS group discovery was not requested');
  assert.ok(requests.includes('/slt/7'), 'HTTP SLT document was not requested');
  const mediaRequests = requests.filter((path) => path.startsWith('/mabr/'));
  assert.deepEqual(mediaRequests, [], `cached media escaped to HTTP: ${mediaRequests.join(', ')}`);
  console.log('PASS: real route.wasm + RaptorQ loss recovery reached Shaka DASH/HLS; native and AMT gateway contracts passed (network ingress simulated)');
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
