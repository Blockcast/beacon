/**
 * Connect Beacon: the one-tap link that pairs an iOS browser with the Beacon
 * app's bridge, for any page that uses `window.multicast`.
 *
 * Safari learns where Beacon's bridge is from Beacon's Safari extension.
 * Chrome, Firefox, Edge and every other iOS browser have no extension, and
 * WebKit blocks an HTTPS page's loopback `/health` probe, so
 * `initMulticastBridge()` cannot find the bridge there on its own. Beacon
 * claims `/beacon/connect` on both hosts below as a universal link. It starts
 * its bridge, then reopens `to` in the browser named by `return`, with the
 * bridge's certificate pin in the fragment. `initMulticastBridge()` reads that
 * pin and keeps it as a pairing, so later visits connect with no tap. Any HTTPS
 * page can send the link; Beacon still applies its own origin admission to
 * `to`. Where iOS does not hand the link to Beacon (Beacon not installed, a
 * private tab), the tap opens the web page at the endpoint instead.
 *
 * This is a separate entry point on purpose: discovery and authorization in
 * `multicast-bridge.js` stay free of any app-association contract.
 */

export const BEACON_CONNECT_ENDPOINTS = Object.freeze([
  'https://www.blockcast.network/beacon/connect',
  'https://blockcast.network/beacon/connect',
]);

// iOS browsers are told apart only by their user-agent product token. Beacon
// matches these exactly, and returns every other iOS browser to Safari.
const RETURN_TOKENS = Object.freeze(['CriOS', 'FxiOS', 'EdgiOS']);

// Beacon refuses a `to` carrying any of these: they would override its pin or
// steer discovery. Compared lowercased, as Beacon compares them.
const STEERING_KEYS = new Set(['mc_bridge', 'fingerprint', 'fp', 'wt_port', 'wtport', 'gw']);

// What the offer answers: a discovery miss, or a connect that failed. A stale
// pin and a dropped Beacon bridge report themselves as connect failures, never
// as misses. The reasons are `createBridgeBootstrap()`'s names for the same.
const OFFER_REASONS = new Set(['discovery-miss', 'discovery-exhausted', 'connect-failed', 'connect-exhausted']);

const INERT_OFFER = Object.freeze({ offered: false, onStatus() {}, dispose() {} });

/**
 * The `return=` token Beacon switches back to, or '' off iOS, where no Beacon
 * claims the link. An iPad browser that requests desktop sites without its
 * product token reads as Safari.
 */
export function beaconReturnBrowser(navigatorScope = globalThis.navigator) {
  const userAgent = typeof navigatorScope?.userAgent === 'string' ? navigatorScope.userAgent : '';
  const token = RETURN_TOKENS.find((candidate) => userAgent.includes(`${candidate}/`));
  if (token) return token;
  // iPadOS reports a Mac platform; only its touch points tell it apart.
  const ios = /iPhone|iPad|iPod/.test(userAgent)
    || (navigatorScope?.platform === 'MacIntel' && navigatorScope?.maxTouchPoints > 1);
  return ios ? 'Safari' : '';
}

/**
 * The Connect Beacon href for the page in `windowScope`, or null where Beacon
 * cannot act on it: off iOS, off HTTPS, or inside a frame. WebKit hands a link
 * to an app only for a top-level navigation to a host other than the page's,
 * so the link goes to the first endpoint whose hostname is not the page's own.
 */
export function beaconConnectUrl(windowScope = globalThis.window, { endpoints = BEACON_CONNECT_ENDPOINTS } = {}) {
  const browser = beaconReturnBrowser(windowScope?.navigator);
  if (!browser) return null;
  if (windowScope.top && windowScope.top !== windowScope) return null;
  let page;
  try {
    page = new URL(windowScope.location?.href);
  } catch {
    return null;
  }
  if (page.protocol !== 'https:') return null;
  const endpoint = endpoints.map((href) => new URL(href)).find((url) => url.hostname !== page.hostname);
  if (!endpoint) return null;
  endpoint.search = new URLSearchParams({ return: browser, to: beaconTarget(page) }).toString();
  return endpoint.href;
}

/**
 * Show `link` as Connect Beacon while this browser could use a bridge but has
 * none, and hide it once a bridge connects.
 *
 * It follows the bridge's own `multicast-bridge-status` and
 * `multicast-bridge-ready` events on `windowScope`, so it works whoever built
 * the controller. The link appears on a discovery miss or a failed connect
 * rather than on a timer, so a page that is already paired never flashes it.
 * Its href is rebuilt on every tap, so `to` names the page as it is then; the
 * navigation stays the browser's own, as iOS requires for an app link.
 * `onStatus` takes the same events from any other feed, `initMulticastBridge()`'s
 * and `createBridgeBootstrap()`'s included; a connect there withdraws the link.
 */
export function offerBeaconConnect(link, { windowScope = globalThis.window, endpoints, onChange } = {}) {
  if (!link) return INERT_OFFER;
  let offered = false;
  let disposed = false;
  const update = (next) => {
    if (disposed) return;
    link.hidden = !next;
    if (next === offered) return;
    offered = next;
    onChange?.(next);
  };
  const refresh = () => {
    const href = disposed ? null : beaconConnectUrl(windowScope, { endpoints });
    if (href) link.href = href;
    return href;
  };
  const onStatus = (event) => {
    if ((event?.phase === 'connect' && event.ok === true) || event?.state === 'connected') {
      update(false);
      return;
    }
    const wanted = event?.phase === 'discovery'
      ? event.ok === false && event.reason === 'miss'
      : event?.phase === 'connect' ? event.ok === false : OFFER_REASONS.has(event?.reason);
    if (!wanted || typeof windowScope?.multicast?.subscribe === 'function') return;
    if (refresh()) update(true);
  };
  const onBridgeStatus = (event) => onStatus(event?.detail);
  const withdraw = () => update(false);
  update(false);
  link.addEventListener('click', refresh);
  windowScope?.addEventListener?.('multicast-bridge-status', onBridgeStatus);
  windowScope?.addEventListener?.('multicast-bridge-ready', withdraw);
  return {
    get offered() {
      return offered;
    },
    onStatus,
    dispose() {
      disposed = true;
      link.removeEventListener('click', refresh);
      windowScope?.removeEventListener?.('multicast-bridge-status', onBridgeStatus);
      windowScope?.removeEventListener?.('multicast-bridge-ready', withdraw);
    },
  };
}

// The page as Beacon must receive it: no credentials and no steering fields,
// both of which Beacon refuses, and escaped to RFC 3986. Beacon parses `to`
// with Foundation, which refuses (iOS 15/16) or re-encodes (later iOS, which
// also double-encodes the escapes beside it) characters WebKit's href leaves
// raw, such as `[ ] { } | ^` and a stray `%`.
function beaconTarget(page) {
  const query = withoutSteering(page.search.slice(1), '&');
  const fragment = withoutSteering(page.hash.slice(1), '&?');
  return `${page.origin}${rfc3986(page.pathname)}${query ? `?${rfc3986(query)}` : ''}${fragment ? `#${rfc3986(fragment)}` : ''}`;
}

// Split the way Beacon splits: the query on `&`, the fragment on `&` and `?`.
// A dropped field that opened a `?` route passes the `?` to the next field
// kept, so `#/watch?fp=ab&id=7` stays `#/watch?id=7`. Once the route is open,
// a `?` after a dropped field is still that field's value, so it goes too.
function withoutSteering(raw, separators) {
  let kept = '';
  let dropped = false;
  let route = false;
  let inDroppedValue = false;
  for (const field of raw.split(new RegExp(`(?=[${separators}])`))) {
    const separator = separators.includes(field[0]) ? field[0] : '';
    const body = field.slice(separator.length);
    if (inDroppedValue && separator === '?') continue;
    if (isSteering(body)) {
      const routeOpen = kept.includes('?');
      dropped = true;
      route ||= separator === '?' && !routeOpen;
      inDroppedValue = routeOpen || separator === '?';
      continue;
    }
    kept += (route ? '?' : dropped && !kept && separator === '&' ? '' : separator) + body;
    route = false;
    inDroppedValue = false;
  }
  return kept;
}

// Decoded as Beacon will see it, after escaping: a stray `%` is `%25` by
// then, so only invalid UTF-8 still fails, and fails closed as in Beacon.
function isSteering(field) {
  try {
    return STEERING_KEYS.has(decodeURIComponent(rfc3986(field.split('=')[0])).toLowerCase());
  } catch {
    return true;
  }
}

function rfc3986(part) {
  return part.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
