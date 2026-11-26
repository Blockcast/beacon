// Compat matrix for transparent ROUTE interception (BLO-59460).
//
// Unmodified Shaka, hls.js and dash.js play DASH/HLS from ordinary DS URLs in
// headless Chromium and Firefox. The only page code is the bootstrap that an
// extension or one script tag would inject (install the adapter, seed the
// ROUTE cache); the player is loaded and driven exactly as on any site. ROUTE
// delivery is simulated by seeding MabrRouteProxy with the init/media objects,
// so this lane needs no private route.wasm (the pim lane covers that).
//
//   npm install && npm run test:compat      (needs ffmpeg with libvpx-vp9)
//   COMPAT_BROWSERS=chromium CHROME_PATH=/path/to/chrome node matrix.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');
const dist = join(pkgRoot, 'dist');
const req = (path) => join(here, 'node_modules', path);

// ---- the claimed matrix, and what is explicitly not claimed ----
const PLAYERS = [
  { name: 'shaka', formats: ['dash', 'hls'], lib: req('shaka-player/dist/shaka-player.compiled.js'),
    start: `shaka.polyfill.installAll(); const p = new shaka.Player(); await p.attach(video); await p.load(url);` },
  { name: 'hls.js', formats: ['hls'], lib: req('hls.js/dist/hls.min.js'),
    start: `const h = new Hls(); h.attachMedia(video); h.loadSource(url);` },
  { name: 'dash.js', formats: ['dash'], lib: req('dashjs/dist/modern/umd/dash.all.min.js'),
    start: `dashjs.MediaPlayer().create().initialize(video, url, true);` },
];
const BROWSERS = (process.env.COMPAT_BROWSERS || 'chromium,firefox').split(',');
// Keep in sync with the README "Unsupported combinations" table (asserted below).
export const UNSUPPORTED = [
  'hls.js x DASH', 'dash.js x HLS', 'webkit', 'Safari native HLS',
];

const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');
for (const label of UNSUPPORTED) assert.ok(readme.includes(label), `README must list unsupported combination: ${label}`);

// ---- media: one VP9 CMAF stream, split into init + segments ----
const work = mkdtempSync(join(tmpdir(), 'mabr-compat-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '6',
  '-c:v', 'libvpx-vp9', '-g', '15', '-b:v', '200k', '-f', 'mp4',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof+cmaf', join(work, 'out.mp4')]);
const mp4 = readFileSync(join(work, 'out.mp4'));
const boxes = [];
for (let o = 0; o < mp4.length;) { const n = mp4.readUInt32BE(o); boxes.push({ type: mp4.toString('latin1', o + 4, o + 8), data: mp4.subarray(o, o + n) }); o += n; }
const initBytes = Buffer.concat(boxes.filter((b) => b.type === 'ftyp' || b.type === 'moov').map((b) => b.data));
const segments = [];
for (let i = 0; i < boxes.length; i++) if (boxes[i].type === 'moof') segments.push(Buffer.concat([boxes[i].data, boxes[i + 1].data]));
assert.ok(segments.length >= 4, `expected >=4 segments, got ${segments.length}`);
const names = ['init.mp4', ...segments.map((_, i) => `seg-${i + 1}.m4s`)];
const bodies = new Map([['init.mp4', initBytes], ...segments.map((s, i) => [`seg-${i + 1}.m4s`, s])]);
const CODECS = 'vp09.00.10.08';
const files = {
  dash: { 'manifest.mpd': Buffer.from(`<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${segments.length}S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period><AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1"><Representation id="v" codecs="${CODECS}" width="320" height="180" bandwidth="200000"><SegmentTemplate timescale="1" duration="1" startNumber="1" media="seg-$Number$.m4s" initialization="init.mp4"/></Representation></AdaptationSet></Period></MPD>`) },
  hls: {
    'master.m3u8': Buffer.from(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="${CODECS}",RESOLUTION=320x180\nmedia.m3u8\n`),
    'media.m3u8': Buffer.from(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n${segments.map((_, i) => `#EXTINF:1.0,\nseg-${i + 1}.m4s\n`).join('')}#EXT-X-ENDLIST\n`),
  },
};
for (const f of Object.keys(files)) for (const n of names) files[f][n] = bodies.get(n);
files.dash['ghost.m4s'] = Buffer.from('NET'); files.hls['ghost.m4s'] = Buffer.from('NET');
const type = (n) => n.endsWith('.mpd') ? 'application/dash+xml' : n.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- servers: `app` serves the page, player libs and ROUTE seed bytes (and the
// DS paths for same-origin cells); `ds` is a second origin for cross-origin cells.
function listen(handler) {
  return new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
}
const dsLog = [];
const dsHandler = (request, response) => {
  const url = new URL(request.url, 'http://x');
  const [, format, name] = url.pathname.split('/');
  const body = files[format]?.[name];
  dsLog.push({ path: url.pathname, dest: request.headers['sec-fetch-dest'],  });
  const origin = request.headers.origin;
  const cors = origin ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'x-served-by', 'access-control-allow-headers': '*' } : {};
  if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end(); }
  if (!body) { response.writeHead(404, cors); return response.end('miss'); }
  response.writeHead(200, { ...cors, 'content-type': type(name), 'x-served-by': 'network' });
  response.end(body);
};
const ds = await listen(dsHandler);
const app = await listen((request, response) => {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/page') {
    const q = Object.fromEntries(url.searchParams);
    const player = PLAYERS.find((p) => p.name === q.player);
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(pageHtml(player, q));
  }
  if (url.pathname.startsWith('/__route/')) {
    const [, , format, name] = url.pathname.split('/'); // seed bytes: not DS traffic
    response.writeHead(200); return response.end(files[format][name]);
  }
  if (url.pathname.startsWith('/lib/')) {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    return response.end(readFileSync(PLAYERS[Number(url.pathname.slice(5))].lib));
  }
  if (url.pathname.startsWith('/mabr/')) {
    const m = url.pathname.slice(6);
    if (!/^(proxy|adapter|manifest-names|respond|route|index|route-health|gateway)\.js$/.test(m)) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/javascript' });
    return response.end(readFileSync(join(dist, m)));
  }
  dsHandler(request, response); // same-origin DS
});
const origin = (s) => `http://127.0.0.1:${s.address().port}`;

function pageHtml(player, q) {
  const dsOrigin = q.xo === '1' ? origin(ds) : origin(app);
  const cfg = { ds: dsOrigin, format: q.format, fail: q.fail === '1', names, files: Object.keys(files[q.format]), idx: PLAYERS.indexOf(player) };
  return `<!doctype html><meta charset=utf-8><video id=v muted playsinline autoplay></video>
<script id=cfg type=application/json>${JSON.stringify(cfg)}</script>
<script type=module>
const cfg = JSON.parse(document.getElementById('cfg').textContent);
const { MabrRouteProxy } = await import('/mabr/proxy.js');
const { installTransparentAdapter } = await import('/mabr/adapter.js');
const dir = cfg.ds + '/' + cfg.format + '/';
// --- bootstrap an extension/script tag would inject: seed ROUTE objects, install the adapter ---
const proxy = new MabrRouteProxy({ baseUrl: cfg.ds + '/', scope: dir, transparent: { unauthenticatedSegments: [cfg.ds] } });
const seeded = new Map();
for (const n of cfg.names) {
  const data = new Uint8Array(await (await fetch('/__route/' + cfg.format + '/' + n)).arrayBuffer());
  seeded.set(n, data);
  proxy.put({ url: dir + n, data, contentType: 'video/mp4' });
}
const target = cfg.fail ? { resolve: async () => { throw new Error('forced adapter failure'); }, trustManifest: () => { throw new Error('forced'); }, inScope: () => true } : proxy;
const adapter = installTransparentAdapter(target, { corsOrigins: [cfg.ds] });
window.__adapter = adapter;
// --- from here on: an ordinary page with an unmodified player ---
await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/lib/' + cfg.idx; s.onload = ok; s.onerror = no; document.head.append(s); });
const video = document.getElementById('v');
const url = dir + (cfg.format === 'dash' ? 'manifest.mpd' : 'master.m3u8');
${player.start}
for (let i = 0; i < 300 && !(video.readyState >= 2 && video.buffered.length > 0); i++) await new Promise((r) => setTimeout(r, 100));
window.__played = video.readyState >= 2 && video.buffered.length > 0;
window.__status = adapter.status();
if (!cfg.fail) {
  const probes = {};
  const served = async (u, init) => (await fetch(u, init)).headers.get('x-served-by') === 'network' ? 'network' : 'route';
  // R7: discovery (no-store) bypasses ROUTE
  probes.noStore = await served(dir + 'seg-2.m4s', { cache: 'no-store' });
  // R4: a non-media destination (an <img>) reaches the network, never ROUTE
  await new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = dir + 'seg-3.m4s'; });
  // R5/R10: an injected in-scope object, and an overwrite of a served segment
  proxy.put({ url: dir + 'seg-1.m4s', data: Uint8Array.of(7, 7, 7), contentType: 'video/mp4' });
  proxy.put({ url: dir + 'ghost.m4s', data: Uint8Array.of(8, 8, 8), contentType: 'video/mp4' });
  const seg1 = new Uint8Array(await (await fetch(dir + 'seg-1.m4s')).arrayBuffer());
  probes.seg1Intact = seg1.length === seeded.get('seg-1.m4s').length && seg1.every((b, i) => b === seeded.get('seg-1.m4s')[i]);
  probes.ghost = await (await fetch(dir + 'ghost.m4s')).text();
  window.__probes = probes;
}
window.__done = true;
</script>`;
}

// ---- run ----
const cells = [];
const results = [];
for (const browserName of BROWSERS) {
  const launcher = playwright[browserName];
  const browser = await launcher.launch({
    headless: true,
    ...(browserName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    ...(browserName === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}),
  });
  try {
    for (const player of PLAYERS) for (const format of player.formats) for (const xo of [0, 1]) for (const fail of [0, 1]) {
      const id = `${browserName} / ${player.name} / ${format} / ${xo ? 'cross-origin' : 'same-origin'}${fail ? ' / forced-failure' : ''}`;
      dsLog.length = 0;
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      let outcome;
      try {
        await page.goto(`${origin(app)}/page?player=${encodeURIComponent(player.name)}&format=${format}&xo=${xo}&fail=${fail}`);
        await page.waitForFunction(() => window.__done === true, null, { timeout: 60000 });
        const s = await page.evaluate(() => ({ played: window.__played, status: window.__status, probes: window.__probes, final: window.__adapter.status() }));
        const media = dsLog.filter((r) => /seg-\d+\.m4s|init\.mp4/.test(r.path));
        assert.equal(s.played, true, 'player did not buffer media');
        assert.deepEqual(errors, [], 'page errors');
        if (fail) {
          // Compat: forced failure still plays over unicast.
          assert.ok(s.status.errors > 0 && s.status.hits === 0, `fail run status ${JSON.stringify(s.status)}`);
          assert.ok(media.length > 0, 'unicast carried no media');
        } else {
          assert.ok(s.status.hits > 0, `ROUTE hits must be > 0: ${JSON.stringify(s.status)}`);
          assert.ok(!media.some((r) => r.dest !== 'image' && r.path !== '/' + format + '/seg-2.m4s'), `player media reached the network: ${JSON.stringify(media)}`);
          assert.equal(s.probes.noStore, 'network', 'compat: discovery bypasses ROUTE');
          assert.ok(media.some((r) => r.dest === 'image'), 'compat: non-media destinations always reach the network');
          assert.equal(s.probes.seg1Intact, true, 'compat: injected in-scope object is not served (overwrite)');
          assert.equal(s.probes.ghost, 'NET', 'compat: injected in-scope object is not served (unnamed)');
        }
        outcome = { id, ok: true, hits: s.final.hits, misses: s.final.misses, errors: s.final.errors };
      } catch (error) {
        outcome = { id, ok: false, error: String(error.message || error).split('\n')[0] };
      } finally { await page.close(); }
      results.push(outcome);
      console.log(`${outcome.ok ? 'PASS' : 'FAIL'} ${id}${outcome.ok ? ` hits=${outcome.hits}` : ` -- ${outcome.error}`}`);
    }
  } finally { await browser.close(); }
}
ds.close(); app.close();
writeFileSync(process.env.COMPAT_RESULTS || join(here, 'compat-matrix-results.json'), JSON.stringify({ unsupported: UNSUPPORTED, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} cells passed; unsupported (documented): ${UNSUPPORTED.join(', ')}`);
process.exit(failed.length ? 1 : 0);
