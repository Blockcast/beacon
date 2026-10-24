// Optional public ROUTE fallback check.
//
// This intentionally leaves the gateway silent: SLT discovery still selects
// the service SLS leg, while every player request falls through the browser
// proxy to the public CDN. It proves that the route.wasm/session integration
// does not break ordinary DASH/HLS playback when multicast is unavailable.
//
//   npm run test:e2e:public
//
// Override PUBLIC_ROUTE_ORIGIN, PUBLIC_ROUTE_BASE_PATH, PUBLIC_ROUTE_SLT, or
// PUBLIC_ROUTE_SERVICE_ID for another CDN service. The other artifact paths
// use the same variables as the synthetic route-wasm-shaka-e2e test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pimRoot = process.env.PMG_ROOT || resolve(packageRoot, '../../../pim-multicast-gateway');
const routeWasmPath = process.env.ROUTE_WASM || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/route.wasm');
const routeExecPath = process.env.ROUTE_WASM_EXEC || join(pimRoot, 'packages/atsc3-tuner-bridge/wasm/wasm_exec.js');
const shakaPath = process.env.SHAKA_JS || join(pimRoot, 'shaka-player/dist/shaka-player.compiled.debug.js');
const playwrightPath = process.env.PLAYWRIGHT || join(pimRoot, 'node_modules/playwright/index.mjs');
const chromePath = process.env.CHROME_PATH;

const defaultPublicOrigin = 'https://cdn.onprem-production-live-multicast.public-pr.cdn.blockcast.net';
const publicOrigin = new URL(process.env.PUBLIC_ROUTE_ORIGIN || defaultPublicOrigin).origin;
const basePath = `${process.env.PUBLIC_ROUTE_BASE_PATH || '/nasa/iss/a/'}`.replace(/^\/*/, '/').replace(/\/*$/, '/');
const baseUrl = new URL(basePath, publicOrigin).href;
const sltUrl = new URL(process.env.PUBLIC_ROUTE_SLT || '/slt/1', publicOrigin).href;
// Production's current SLT assigns serviceId 1 to the live NASA multicast
// service. Keep this overrideable because service IDs are TO-owned.
const serviceId = process.env.PUBLIC_ROUTE_SERVICE_ID || '1';
const expectedGroup = process.env.PUBLIC_ROUTE_EXPECTED_GROUP ||
  (publicOrigin === defaultPublicOrigin && basePath === '/nasa/iss/a/' && serviceId === '1' ? '232.1.1.66' : undefined);
const expectedPort = process.env.PUBLIC_ROUTE_EXPECTED_PORT
  ? Number(process.env.PUBLIC_ROUTE_EXPECTED_PORT)
  : expectedGroup ? 8000 : undefined;
const expectedSource = process.env.PUBLIC_ROUTE_EXPECTED_SOURCE ||
  (expectedGroup ? '69.25.95.61' : undefined);
const dashUrl = new URL('manifest.mpd', baseUrl).href;
const hlsUrl = new URL('master.m3u8', baseUrl).href;
const routeWasm = readFileSync(routeWasmPath);
const wasmExec = readFileSync(routeExecPath);
const shaka = readFileSync(shakaPath, 'utf8');

const page = `<!doctype html><meta charset=utf-8><video id=v muted playsinline></video>
<script src="/wasm_exec.js"></script>
<script>if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, factory) { if (!this.has(key)) this.set(key, factory(key)); return this.get(key); };</script>
<script src="/shaka.js"></script>
<script type="module">
const baseUrl = ${JSON.stringify(baseUrl)};
const sltUrl = ${JSON.stringify(sltUrl)};
const serviceId = ${JSON.stringify(serviceId)};
window.__log = [];
window.__gatewayConfigs = [];
window.__done = false;
const log = (value) => window.__log.push(String(value));
const gateway = {
  subscribe: async (config) => {
    window.__gatewayConfigs.push(config);
    return {
      addEventListener() {},
      removeEventListener() {},
      unsubscribe: async () => {},
    };
  },
};
try {
  const { createRouteMabrSession } = await import('/mabr-route-proxy/index.js');
  const routeBytes = await (await fetch('/route.wasm')).arrayBuffer();
  const go = new Go();
  const instantiated = await WebAssembly.instantiate(routeBytes, go.importObject);
  go.run(instantiated.instance);
  const routeExports = instantiated.instance.exports;
  if (typeof routeExports.route_init !== 'function') throw new Error('route.wasm has no route_init export');
  routeExports.route_init();
  const session = createRouteMabrSession({
    gateway,
    wasm: { exports: routeExports },
    ingress: 'native',
    sltUrl,
    serviceId,
    discoverEndpoints: false,
    baseUrl,
  });
  // start() performs HTTP SLT discovery and subscribes to the one SLS leg.
  // No bytes are delivered by this gateway, so all Shaka objects use HTTP.
  await session.start();
  if (session.size !== 0) throw new Error('silent gateway unexpectedly populated the ROUTE cache');
  session.installFetch();
  window.__session = session;
  const player = new shaka.Player(document.querySelector('#v'));
  async function play(url, label) {
    await player.load(url);
    await document.querySelector('#v').play();
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    const video = document.querySelector('#v');
    log(label + ':readyState=' + video.readyState + ',buffered=' + video.buffered.length);
    if (video.readyState < 2 || video.buffered.length < 1) throw new Error(label + ' did not decode buffered media');
    await player.unload();
  }
  await play(${JSON.stringify(dashUrl)}, 'DASH');
  await play(${JSON.stringify(hlsUrl)}, 'HLS');
  window.__done = true;
} catch (error) {
  window.__error = error?.stack || String(error);
}
</script>`;

const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});
const pageHandle = await browser.newPage();
const browserErrors = [];
const publicRequests = [];
await pageHandle.route('**/*', async (route) => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.origin !== publicOrigin) {
    await route.continue();
    return;
  }
  const path = requestUrl.pathname;
  if (path === '/__mabr-route-proxy-test__') {
    await route.fulfill({ status: 200, contentType: 'text/html', body: page });
  } else if (path === '/route.wasm') {
    await route.fulfill({ status: 200, contentType: 'application/wasm', body: routeWasm });
  } else if (path === '/wasm_exec.js') {
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: wasmExec });
  } else if (path === '/shaka.js') {
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: shaka });
  } else if (path.startsWith('/mabr-route-proxy/')) {
    const modulePath = path.slice('/mabr-route-proxy/'.length);
    if (!['index.js', 'proxy.js', 'route.js'].includes(modulePath)) {
      await route.fulfill({ status: 404, body: 'module miss' });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(packageRoot, 'dist', modulePath)) });
    }
  } else {
    // The CDN remains the source of truth for SLT, manifests, and CMAF media.
    await route.continue();
  }
});
pageHandle.on('pageerror', (error) => browserErrors.push(error.stack || String(error)));
pageHandle.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(message.text());
});
pageHandle.on('request', (request) => {
  if (request.url().startsWith(publicOrigin)) publicRequests.push(new URL(request.url()).pathname);
});
try {
  // The synthetic harness is fulfilled at the CDN origin so its browser
  // requests are same-origin with the public ROUTE objects.
  await pageHandle.goto(`${publicOrigin}/__mabr-route-proxy-test__`);
  const deadline = Date.now() + Number(process.env.PUBLIC_ROUTE_TIMEOUT_MS || 90000);
  while (Date.now() < deadline && !(await pageHandle.evaluate(() => window.__done || window.__error))) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const state = await pageHandle.evaluate(() => ({
    done: window.__done === true,
    error: window.__error,
    log: window.__log,
    gatewayConfigs: window.__gatewayConfigs,
  }));
  const diagnostic = JSON.stringify({ state, browserErrors, publicRequests });
  assert.deepEqual(browserErrors, [], diagnostic);
  assert.equal(state.error, undefined, diagnostic);
  assert.equal(state.done, true, diagnostic);
  assert.equal(state.gatewayConfigs.length, 1, JSON.stringify(state.gatewayConfigs));
  if (expectedGroup) assert.equal(state.gatewayConfigs[0].group, expectedGroup);
  if (expectedPort !== undefined) assert.equal(state.gatewayConfigs[0].port, expectedPort);
  if (expectedSource) assert.equal(state.gatewayConfigs[0].source, expectedSource);
  assert.equal(state.gatewayConfigs[0].origin, 'ip-multicast');
  assert.ok(publicRequests.includes(new URL(dashUrl).pathname), `DASH manifest did not use HTTP: ${publicRequests.join(', ')}`);
  assert.ok(publicRequests.includes(new URL(hlsUrl).pathname), `HLS manifest did not use HTTP: ${publicRequests.join(', ')}`);
  assert.ok(publicRequests.some((path) => path.endsWith('.m4s')), `no CMAF media request observed: ${publicRequests.join(', ')}`);
  console.log(`PASS: public ROUTE CDN fallback played DASH and HLS with HTTP SLT discovery (${state.log.join('; ')})`);
} finally {
  await pageHandle.close();
  await browser.close();
}
