/**
 * Transparent interception for unmodified players: patches page-world `fetch`
 * and `XMLHttpRequest` so ordinary manifest/segment URLs are answered from
 * ROUTE with no player or page-code change. Mechanism A/B of ADR 0001
 * (docs/adr/0001-browser-route-interception.md); the mitigations R1-R24 are in
 * docs/threat-model/route-interception.md and each has a test in
 * adapter.test.ts. Every failure and every miss falls through to the network.
 *
 * It reuses `window.multicast` from `@blockcast/window-multicast-bridge` through
 * the session you pass in and never subscribes to or relays a group itself.
 */

export interface AdapterTarget {
  resolve(input: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined>;
  /** Called with a manifest the player loaded over unicast (R8) so ROUTE may answer the segments it names (R10). */
  trustManifest?(url: string, body: ArrayBuffer): boolean;
  /** Lets the adapter skip, unreported, requests ROUTE can never answer (R21). */
  inScope?(url: string): boolean;
}

export interface TransparentAdapterOptions {
  /** DS origins a cross-origin `cors` request may be answered for once a successful CORS response was seen (R17). */
  corsOrigins?: readonly string[];
  /** Path prefixes never answered (entitlement-gated or control paths) (R18). */
  gatedPaths?: readonly string[];
  /** Path prefixes that may be answered even for credentialed requests (R18). */
  publicPaths?: readonly string[];
  /** The top-level site this adapter's cache is bound to; a mismatch means a miss (R19). */
  topLevelSite?: () => string;
  /** Lookups in the sliding window used to report downgrade (R23), default 20. */
  window?: number;
  /** Miss rate at or above which the window counts as degraded (R23), default 0.9. */
  degradedMissRate?: number;
  /** Called once each time the adapter enters the degraded state (R23). */
  onDowngrade?: (status: AdapterStatus) => void;
  /** Globals to patch; defaults to `globalThis`. For tests and embedded realms. */
  global?: AdapterGlobal;
}

export interface AdapterGlobal {
  fetch: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  location: { href: string; origin: string };
}

export interface AdapterStatus {
  hits: number;
  misses: number;
  /** Requests the adapter handed straight to the network without a lookup. */
  bypassed: number;
  /** Adapter faults that fell through to the network (R22). */
  errors: number;
  missRate: number;
  /** True when the last `window` lookups were mostly misses or faults (R23). */
  degraded: boolean;
}

export interface TransparentAdapter {
  status(): AdapterStatus;
  /** Put back the original `fetch` / `XMLHttpRequest` methods. */
  restore(): void;
}

interface RequestInfoLite {
  url: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials;
  mode: RequestMode;
  cache: RequestCache;
  destination: RequestDestination;
}

const MEDIA_DESTINATIONS = new Set(['', 'video', 'audio', 'track']);
const MANIFEST_URL = /\.(?:mpd|m3u8)(?:[?#]|$)/i;
const MANIFEST_TYPE = /dash\+xml|mpegurl/i;
const MAX_MANIFEST_BYTES = 2 * 2 ** 20;

function secureTransport(url: URL): boolean {
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

export function installTransparentAdapter(target: AdapterTarget, options: TransparentAdapterOptions = {}): TransparentAdapter {
  const g = options.global ?? (globalThis as unknown as AdapterGlobal);
  const windowSize = options.window ?? 20;
  const degradedAt = options.degradedMissRate ?? 0.9;
  const origFetch = g.fetch;
  const corsSeen = new Set<string>();
  const recent: boolean[] = []; // true = hit
  const counts = { hits: 0, misses: 0, bypassed: 0, errors: 0 };
  let degraded = false;
  const partition = options.topLevelSite?.();

  const status = (): AdapterStatus => {
    const lookups = recent.length;
    const missRate = lookups === 0 ? 0 : recent.filter((hit) => !hit).length / lookups;
    return { ...counts, missRate, degraded: lookups >= windowSize && missRate >= degradedAt };
  };
  const record = (hit: boolean): void => {
    recent.push(hit);
    if (recent.length > windowSize) recent.shift();
    const now = status();
    if (now.degraded && !degraded) {
      try { options.onDowngrade?.(now); } catch { /* telemetry never alters playback */ }
    }
    degraded = now.degraded;
  };

  /** The R4/R7/R17/R18/R19 gate. Returns the cached Response, or undefined for "use the network". */
  async function serve(info: RequestInfoLite): Promise<Response | undefined> {
    if (info.method !== 'GET' && info.method !== 'HEAD') return bypass();
    if (info.cache === 'no-store' || info.cache === 'reload') return bypass(); // R7
    const url = new URL(info.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return bypass();
    if (target.inScope && !target.inScope(url.href)) return bypass(); // R21: never report foreign URLs
    if (!MEDIA_DESTINATIONS.has(info.destination) || info.mode === 'navigate') return bypass(); // R4
    if (partition !== undefined && options.topLevelSite!() !== partition) return bypass(); // R19
    const initiator = g.location.origin;
    if (url.origin !== initiator) {
      // R17: only if the network would have given the page a readable response.
      if (info.mode !== 'cors' || !options.corsOrigins?.includes(url.origin) || !corsSeen.has(`${url.origin}|${initiator}`)) return bypass();
    }
    const gated = options.gatedPaths?.some((prefix) => url.pathname.startsWith(prefix));
    const credentialed = info.credentials === 'include' || info.headers.has('authorization');
    const open = options.publicPaths?.some((prefix) => url.pathname.startsWith(prefix));
    if (gated || (credentialed && !open)) return bypass(); // R18
    const response = await target.resolve(new Request(url.href, { method: info.method, headers: info.headers, cache: info.cache }));
    if (!response) { counts.misses++; record(false); return undefined; }
    counts.hits++;
    record(true);
    try { Object.defineProperty(response, 'url', { value: url.href }); } catch { /* optional fidelity */ }
    return response;
  }

  function bypass(): undefined { counts.bypassed++; return undefined; }

  /** Run `serve`, turning any adapter fault into a plain miss (R22). */
  async function safeServe(info: RequestInfoLite): Promise<Response | undefined> {
    try { return await serve(info); } catch { counts.errors++; record(false); return undefined; }
  }

  /** After a unicast response: learn trusted manifests (R8) and CORS grants (R17). Never throws. */
  function observe(info: RequestInfoLite, response: Response | undefined, kind: 'fetch' | 'xhr'): void {
    try {
      if (!response || !response.ok || info.method !== 'GET') return;
      const url = new URL(info.url);
      if (response.redirected || (kind === 'fetch' && response.type === 'opaque')) return;
      if (url.origin !== g.location.origin && options.corsOrigins?.includes(url.origin) &&
          (kind === 'xhr' || response.type === 'cors')) corsSeen.add(`${url.origin}|${g.location.origin}`);
      const type = response.headers.get('content-type') ?? '';
      if (!target.trustManifest || !(MANIFEST_URL.test(url.pathname) || MANIFEST_TYPE.test(type))) return;
      if (!secureTransport(url) || (target.inScope && !target.inScope(url.href))) return;
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_MANIFEST_BYTES) return;
      response.clone().arrayBuffer().then((body) => {
        // A trust failure only means ROUTE answers less; it must not surface as a page error (R22).
        try { if (body.byteLength <= MAX_MANIFEST_BYTES) target.trustManifest!(url.href, body); } catch { counts.errors++; }
      }, () => {});
    } catch { /* observation is best effort */ }
  }

  // ---- fetch ----
  const patchedFetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let info: RequestInfoLite | undefined;
    try {
      // Read fields only; never construct a Request from `input`, which would
      // disturb a body-carrying request that must reach the network intact (R20).
      const request = input instanceof Request ? input : undefined;
      info = {
        url: new URL(request ? request.url : String(input), g.location.href).href,
        method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
        headers: new Headers(init?.headers ?? request?.headers),
        credentials: init?.credentials ?? request?.credentials ?? 'same-origin',
        mode: init?.mode ?? request?.mode ?? 'cors',
        cache: init?.cache ?? request?.cache ?? 'default',
        destination: request?.destination ?? '',
      };
    } catch { counts.errors++; }
    const served = info ? await safeServe(info) : undefined;
    if (served) return served;
    const response = await origFetch.call(g, input, init); // R20: the original arguments, unchanged
    if (info) observe(info, response, 'fetch');
    return response;
  };
  g.fetch = patchedFetch as typeof fetch;

  // ---- XMLHttpRequest ----
  // On a hit the request is re-opened onto a blob: URL so the browser's own XHR
  // does responseType, progress events and abort; only status and headers are
  // overridden, so the player sees the original URL and a 200/206 as from the DS.
  const XHR = g.XMLHttpRequest;
  const restoreXhr: Array<() => void> = [];
  if (XHR) {
    const proto = XHR.prototype;
    const { open, send, setRequestHeader, abort } = proto;
    const pending = new WeakSet<XMLHttpRequest>(); // sent by the page, awaiting the async ROUTE lookup
    const sendToken = new WeakMap<XMLHttpRequest, object>(); // identifies the current send; abort/open invalidate it so a stale lookup cannot act
    interface XhrMeta { method: string; url: string; async: boolean; headers: Array<[string, string]>; }
    const meta = new WeakMap<XMLHttpRequest, XhrMeta>();
    proto.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      sendToken.delete(this);
      try {
        meta.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), g.location.href).href, async: rest[0] !== false, headers: [] });
      } catch { meta.delete(this); }
      return (open as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest);
    } as unknown as typeof proto.open;
    proto.setRequestHeader = function(this: XMLHttpRequest, name: string, value: string) {
      const m = meta.get(this);
      if (!m) return setRequestHeader.call(this, name, value);
      // Held back until we know hit or miss, so a Range header never reaches the blob: loader.
      m.headers.push([name, value]);
    };
    proto.abort = function(this: XMLHttpRequest) {
      // During the lookup the real XHR is still unsent, so native abort() is a no-op: cancel it here.
      if (pending.delete(this)) {
        sendToken.delete(this);
        this.dispatchEvent(new Event('abort')); this.dispatchEvent(new Event('loadend'));
        return;
      }
      return abort.call(this);
    };
    proto.send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this);
      const xhr = this;
      if (!m) return send.call(xhr, body);
      meta.delete(this);
      const flush = () => { for (const [name, value] of m.headers) setRequestHeader.call(xhr, name, value); send.call(xhr, body); };
      if (!m.async || body != null || m.method !== 'GET') { flush(); return; }
      const headers = new Headers();
      try { for (const [name, value] of m.headers) headers.append(name, value); } catch { /* malformed header: let the network path report it */ }
      const noCache = /no-store|no-cache/i.test(headers.get('cache-control') ?? '') || /no-cache/i.test(headers.get('pragma') ?? '');
      const info: RequestInfoLite = {
        url: m.url, method: 'GET', headers, mode: 'cors', destination: '',
        credentials: xhr.withCredentials ? 'include' : 'same-origin', cache: noCache ? 'no-store' : 'default',
      };
      const token = {};
      sendToken.set(xhr, token);
      const cancelled = () => sendToken.get(xhr) !== token;
      pending.add(xhr);
      safeServe(info).then((response) => {
        if (cancelled()) return true;
        if (!response || (response.status !== 200 && response.status !== 206)) return false;
        return response.blob().then((blob) => {
          if (cancelled()) return true;
          pending.delete(xhr);
          const blobUrl = URL.createObjectURL(blob);
          xhr.addEventListener('loadend', () => URL.revokeObjectURL(blobUrl), { once: true });
          const define = (key: string, value: unknown) => Object.defineProperty(xhr, key, { configurable: true, value });
          // After this point the request is committed to the blob: URL.
          let headerText = '';
          response.headers.forEach((v, k) => { headerText += `${k}: ${v}\r\n`; });
          define('status', response.status);
          define('statusText', response.status === 206 ? 'Partial Content' : 'OK');
          define('responseURL', m.url);
          define('getResponseHeader', (name: string) => response.headers.get(name));
          define('getAllResponseHeaders', () => headerText);
          open.call(xhr, 'GET', blobUrl, true);
          send.call(xhr);
          return true;
        });
      }).then((served) => {
        if (served || cancelled()) return;
        pending.delete(xhr);
        // Miss: send the original request. Observe a manifest/CORS grant on completion.
        xhr.addEventListener('load', () => {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            observe(info, new Response(xhr.responseType === 'arraybuffer' || xhr.responseType === 'text' || xhr.responseType === '' ? xhr.response : null, {
              status: 200,
              headers: { 'content-type': xhr.getResponseHeader('content-type') ?? '' },
            }), 'xhr');
          } catch { /* best effort */ }
        }, { once: true });
        flush();
      }, () => { counts.errors++; if (cancelled()) return; pending.delete(xhr); flush(); });
    } as unknown as typeof proto.send;
    restoreXhr.push(() => { proto.open = open; proto.send = send; proto.setRequestHeader = setRequestHeader; proto.abort = abort; });
  }

  return {
    status,
    restore() {
      if (g.fetch === (patchedFetch as typeof fetch)) g.fetch = origFetch;
      for (const undo of restoreXhr.splice(0)) undo();
    },
  };
}
