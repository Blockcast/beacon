import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BEACON_CONNECT_ENDPOINTS,
  beaconConnectUrl,
  beaconReturnBrowser,
  offerBeaconConnect,
} from '../src/beacon-connect.js';
import { initMulticastBridge } from '../src/multicast-bridge.js';

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const UA = {
  chrome: `${IOS} CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1`,
  firefox: `${IOS} FxiOS/144.0 Mobile/15E148 Safari/605.1.15`,
  edge: `${IOS} Version/26.0 EdgiOS/141.3537.71 Mobile/15E148 Safari/605.1.15`,
  safari: `${IOS} Version/26.4 Mobile/15E148 Safari/604.1`,
  desktopChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

function makeWindow(href, userAgent = UA.chrome, extra = {}) {
  const listeners = new Map();
  return {
    location: { href },
    navigator: { userAgent },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    ...extra,
  };
}

function makeLink() {
  const window = makeWindow('https://unused.example/');
  return { hidden: false, href: '', ...window, click() { this.dispatchEvent({ type: 'click' }); } };
}

// A port of Beacon's inbound check (`BridgeInboundHandoff.parse` and
// `BridgeHandoff.carriesSteeringParam`): what it refuses, the app never acts on.
// `to` is held to RFC 3986 as Foundation's strict parser holds it, so a target
// WHATWG accepts but iOS 15/16 refuses (or later iOS re-encodes) fails here.
const RFC3986 = /^https:\/\/[^/?#]+((?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*)(\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(#(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$/;
function beaconTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.hash || url.pathname !== '/beacon/connect') return null;
  const fields = url.search.slice(1).split('&');
  const names = fields.map((field) => field.split('=')[0]);
  if (fields.length !== 2 || !names.includes('return') || !names.includes('to')) return null;
  if (!['Safari', 'CriOS', 'FxiOS', 'EdgiOS'].includes(url.searchParams.get('return'))) return null;
  const to = url.searchParams.get('to');
  if (!RFC3986.test(to)) return null;
  const target = new URL(to);
  if (target.username || target.password) return null;
  const steering = ['mc_bridge', 'fingerprint', 'fp', 'wt_port', 'wtport', 'gw'];
  const segments = [...target.search.slice(1).split('&'), ...target.hash.slice(1).split(/[&?]/)];
  return segments.some((segment) => steering.includes(decodeURIComponent(segment.split('=')[0]).toLowerCase())) ? null : to;
}
const beaconAccepts = (raw) => beaconTarget(raw) !== null;

test('return browser: the iOS product token, Safari for other iOS browsers, nothing elsewhere', () => {
  assert.equal(beaconReturnBrowser({ userAgent: UA.chrome }), 'CriOS');
  assert.equal(beaconReturnBrowser({ userAgent: UA.firefox }), 'FxiOS');
  assert.equal(beaconReturnBrowser({ userAgent: UA.edge }), 'EdgiOS');
  assert.equal(beaconReturnBrowser({ userAgent: UA.safari }), 'Safari');
  // iPadOS asks for desktop sites with a Mac user agent.
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
  assert.equal(beaconReturnBrowser(ipad), 'Safari');
  assert.equal(beaconReturnBrowser({ ...ipad, maxTouchPoints: 0 }), '');
  assert.equal(beaconReturnBrowser({ userAgent: UA.desktopChrome }), '');
  assert.equal(beaconReturnBrowser({ userAgent: UA.android }), '');
  assert.equal(beaconReturnBrowser(undefined), '');
});

test('the link is never on the page\'s own host, so iOS can hand it to Beacon', () => {
  const fromApex = new URL(beaconConnectUrl(makeWindow('https://blockcast.network/live')));
  assert.equal(fromApex.host, 'www.blockcast.network');
  const fromWww = new URL(beaconConnectUrl(makeWindow('https://www.blockcast.network/live', UA.safari)));
  assert.equal(fromWww.host, 'blockcast.network');
  assert.equal(fromWww.searchParams.get('to'), 'https://www.blockcast.network/live');
  assert.equal(fromWww.searchParams.get('return'), 'Safari');
  // WebKit compares hosts without their ports.
  assert.equal(new URL(beaconConnectUrl(makeWindow('https://blockcast.network:8443/live'))).host, 'www.blockcast.network');
  const elsewhere = new URL(beaconConnectUrl(makeWindow('https://player.example/watch?id=7#t=30')));
  assert.equal(elsewhere.origin + elsewhere.pathname, BEACON_CONNECT_ENDPOINTS[0]);
  assert.equal(elsewhere.searchParams.get('to'), 'https://player.example/watch?id=7#t=30');
  for (const href of [fromApex.href, fromWww.href, elsewhere.href]) assert.ok(beaconAccepts(href), href);
});

test('no link where Beacon cannot act on it', () => {
  // WebKit offers an app link only for a top-level navigation.
  const frame = makeWindow('https://player.example/embed/7');
  frame.top = makeWindow('https://news.example/');
  assert.equal(beaconConnectUrl(frame), null);
  const top = makeWindow('https://player.example/');
  top.top = top;
  assert.ok(beaconConnectUrl(top));
  assert.equal(beaconConnectUrl(makeWindow('https://player.example/', UA.desktopChrome)), null);
  assert.equal(beaconConnectUrl(makeWindow('https://player.example/', UA.android)), null);
  assert.equal(beaconConnectUrl(makeWindow('http://player.example/')), null);
  assert.equal(beaconConnectUrl(makeWindow('not a url')), null);
  assert.equal(beaconConnectUrl(undefined), null);
  const sameHostOnly = { endpoints: ['https://player.example/beacon/connect'] };
  assert.equal(beaconConnectUrl(makeWindow('https://player.example/'), sameHostOnly), null);
});

test('a custom endpoint list is honoured', () => {
  const endpoints = ['https://links.example/beacon/connect'];
  const href = beaconConnectUrl(makeWindow('https://player.example/'), { endpoints });
  assert.equal(new URL(href).host, 'links.example');
});

test('`to` drops what Beacon refuses and keeps the rest of the page address', () => {
  const page = 'https://player.example/watch?id=7&gw=relay.example&WT_PORT=1#t=30&mc_bridge=127.0.0.1&fp=ab&wtPort=4433';
  const href = beaconConnectUrl(makeWindow(page));
  assert.equal(beaconTarget(href), 'https://player.example/watch?id=7#t=30');
  // Survivors keep their exact bytes; nothing is re-serialized.
  const raw = beaconConnectUrl(makeWindow('https://player.example/w?q=a%20b&gw=x&z=1+2'));
  assert.equal(beaconTarget(raw), 'https://player.example/w?q=a%20b&z=1+2');
  // Fragment routes split on `?` as well as `&`, as Beacon splits them, and
  // a dropped field that opened the route hands its `?` on.
  const routed = beaconConnectUrl(makeWindow('https://player.example/#/watch?fp=ab&id=7'));
  assert.equal(beaconTarget(routed), 'https://player.example/#/watch?id=7');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://player.example/#?fp=1&x=2'))), 'https://player.example/#?x=2');
  // A stray `%` is escaped, not mistaken for a malformed key: anchors and
  // routes that carry one survive. Only invalid UTF-8 fails closed.
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://player.example/#%zz=1&t=30'))), 'https://player.example/#%25zz=1&t=30');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/app#/search/100%'))), 'https://p.example/app#/search/100%25');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/a?100%=yes&id=7'))), 'https://p.example/a?100%25=yes&id=7');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/a#%E9=1&t=30'))), 'https://p.example/a#t=30');
  // A `?` inside a dropped field's value goes with it, and nothing is spliced
  // into a neighbour's value; a page with nothing to drop keeps its bytes.
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/#/w?a=1&fp=2?x=3&b=4'))), 'https://p.example/#/w?a=1&b=4');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/#/w?fp=ab?x=1&id=7'))), 'https://p.example/#/w?id=7');
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://p.example/#&a=1'))), 'https://p.example/#&a=1');
  // Beacon refuses credentials, and the web fallback must not receive them.
  assert.equal(beaconTarget(beaconConnectUrl(makeWindow('https://user:pw@player.example/w'))), 'https://player.example/w');
});

test('`to` is escaped to RFC 3986, which Beacon parses it with', () => {
  for (const [page, expected] of [
    ['https://player.example/w?ids[]=1&ids[]=2', 'https://player.example/w?ids%5B%5D=1&ids%5B%5D=2'],
    ['https://player.example/w?q=a%20b&ids[]=1', 'https://player.example/w?q=a%20b&ids%5B%5D=1'],
    ['https://player.example/w?state={"x":1}', 'https://player.example/w?state=%7B%22x%22:1%7D'],
    ['https://player.example/w?d=50%&m=a|b^c', 'https://player.example/w?d=50%25&m=a%7Cb%5Ec'],
    ['https://player.example/w[1]/x', 'https://player.example/w%5B1%5D/x'],
    ['https://player.example/#/route|x#b', 'https://player.example/#/route%7Cx%23b'],
    ['https://player.example/caf%C3%A9?n=%E2%9C%93', 'https://player.example/caf%C3%A9?n=%E2%9C%93'],
  ]) {
    const href = beaconConnectUrl(makeWindow(page));
    assert.equal(beaconTarget(href), expected, page);
  }
});

test('offer: hidden until discovery misses, withdrawn when a bridge is ready', () => {
  const windowScope = makeWindow('https://player.example/watch');
  const link = makeLink();
  const changes = [];
  const offer = offerBeaconConnect(link, { windowScope, onChange: (offered) => changes.push(offered) });
  assert.equal(link.hidden, true);
  offer.onStatus({ phase: 'discovery', ok: true });
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'lock-busy' });
  assert.equal(link.hidden, true);
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(link.hidden, false);
  assert.equal(offer.offered, true);
  assert.ok(beaconAccepts(link.href), link.href);
  windowScope.dispatchEvent({ type: 'multicast-bridge-ready' });
  assert.equal(link.hidden, true);
  assert.equal(offer.offered, false);
  // A bridge that drops sends discovery round again; the next miss re-offers.
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(link.hidden, false);
  assert.deepEqual(changes, [true, false, true]);
});

test('offer: a failed connect offers too, as a stale pin or a dropped bridge reports one', () => {
  const link = makeLink();
  const offer = offerBeaconConnect(link, { windowScope: makeWindow('https://player.example/') });
  offer.onStatus({ phase: 'connect', ok: true });
  offer.onStatus({ phase: 'disconnect' });
  assert.equal(link.hidden, true);
  offer.onStatus({ phase: 'connect', ok: false });
  assert.equal(link.hidden, false);
});

test('offer: a connect from a fed status withdraws the link', () => {
  const link = makeLink();
  const offer = offerBeaconConnect(link, { windowScope: makeWindow('https://player.example/') });
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(link.hidden, false);
  offer.onStatus({ phase: 'connect', ok: true });
  assert.equal(link.hidden, true);
  offer.onStatus({ state: 'discovering', reason: 'connect-failed' });
  offer.onStatus({ state: 'connected', reason: 'connected' });
  assert.equal(link.hidden, true);
});

test('every pin key the bridge reads is stripped from `to`', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/multicast-bridge.js'), 'utf8');
  const keys = [...source.match(/const PINNED_PARAM_KEYS = Object\.freeze\(\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 6, keys.join());
  for (const key of keys) {
    for (const spelled of [key, key.toUpperCase()]) {
      const href = beaconConnectUrl(makeWindow(`https://p.example/w?${spelled}=1&id=2#${spelled}=3&t=4`));
      assert.equal(beaconTarget(href), 'https://p.example/w?id=2#t=4', spelled);
    }
  }
});

test('offer: bootstrap statuses work too', () => {
  for (const reason of ['discovery-miss', 'discovery-exhausted', 'connect-failed', 'connect-exhausted']) {
    const link = makeLink();
    offerBeaconConnect(link, { windowScope: makeWindow('https://player.example/') }).onStatus({ state: 'discovering', reason });
    assert.equal(link.hidden, false, reason);
  }
});

test('offer: never shown off iOS or with a bridge already installed', () => {
  const desktop = makeLink();
  offerBeaconConnect(desktop, { windowScope: makeWindow('https://player.example/', UA.desktopChrome) })
    .onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(desktop.hidden, true);
  const bridged = makeLink();
  const multicast = { subscribe() {} };
  offerBeaconConnect(bridged, { windowScope: makeWindow('https://player.example/', UA.chrome, { multicast }) })
    .onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(bridged.hidden, true);
});

test('offer: a tap links to the page as it is at the tap', () => {
  const windowScope = makeWindow('https://player.example/watch#mc_bridge=127.0.0.1&fp=ab&wt_port=1');
  const link = makeLink();
  const offer = offerBeaconConnect(link, { windowScope });
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  windowScope.location.href = 'https://player.example/watch?id=9';
  link.click();
  assert.equal(new URL(link.href).searchParams.get('to'), 'https://player.example/watch?id=9');
});

test('offer: nothing moves the link after dispose', () => {
  const windowScope = makeWindow('https://player.example/watch');
  const link = makeLink();
  const offer = offerBeaconConnect(link, { windowScope });
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  const href = link.href;
  offer.dispose();
  windowScope.location.href = 'https://player.example/other';
  link.click();
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  windowScope.dispatchEvent({ type: 'multicast-bridge-ready' });
  windowScope.dispatchEvent({ type: 'multicast-bridge-status', detail: { phase: 'connect', ok: false } });
  assert.equal(link.href, href);
  assert.equal(link.hidden, false);
});

test('offer: a page without the link gets an inert offer', () => {
  const offer = offerBeaconConnect(null, { windowScope: makeWindow('https://player.example/') });
  offer.onStatus({ phase: 'discovery', ok: false, reason: 'miss' });
  offer.dispose();
  assert.equal(offer.offered, false);
});

test('offer: follows a controller it did not build, through the window event', async (t) => {
  const windowScope = makeWindow('https://player.example/watch');
  windowScope.location = { ...windowScope.location, origin: 'https://player.example', protocol: 'https:', hostname: 'player.example', search: '', hash: '' };
  for (const [key, value] of [['window', windowScope], ['location', windowScope.location], ['WebTransport', class {}]]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no bridge'); });
  const link = makeLink();
  const statuses = [];
  windowScope.addEventListener('multicast-bridge-status', (event) => statuses.push(event.detail));
  offerBeaconConnect(link, { windowScope });
  // Built elsewhere, with its own private onStatus, as a player library would.
  const controller = initMulticastBridge({ autoStart: false, onStatus() {} });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  const { phase, ok, reason } = statuses.at(0);
  assert.deepEqual({ phase, ok, reason }, { phase: 'discovery', ok: false, reason: 'miss' });
  assert.equal(link.hidden, false);
  assert.ok(beaconAccepts(link.href), link.href);
});
