/**
 * URL cache for completed ROUTE objects. The existing ROUTE parser supplies
 * the manifest/FDT identity; this package only makes those bytes available at
 * the URLs an ordinary DASH/HLS player already requests.
 */

import { contentTypeFor, normalizeKey, respond } from './respond.ts';

export interface RoutePayload {
  /** ROUTE TOI as emitted by the existing parser (preserve uint64 as bigint/string). */
  toi: bigint | number | string;
  data: ArrayBuffer | ArrayBufferView;
}

export interface RouteFile {
  /** FDT TOI corresponding to `RoutePayload.toi`. */
  toi: bigint | number | string;
  /** FDT Content-Location, resolved against `baseUrl`. */
  contentLocation: string;
  contentType?: string;
}

export interface RouteManifest {
  /** URL exposed by the existing manifest generator. */
  url: string;
  body: ArrayBuffer | ArrayBufferView;
  contentType?: string;
}

/** A direct URL/data insertion retained for callers that already resolve FDT entries. */
export interface RouteSegment {
  /** URL used by the manifest, relative URLs are resolved against `baseUrl`. */
  url: string;
  data: ArrayBuffer | ArrayBufferView;
  contentType?: string;
}

/** A player request served by ROUTE or sent to the normal HTTP origin. */
export interface RouteCacheEvent {
  url: string;
  method: 'GET' | 'HEAD';
  /** `late-hit`: the object completed inside the bounded `lookupWaitMs`. */
  outcome: 'hit' | 'miss' | 'late-hit';
  transport: 'route' | 'network';
  /** HTTP status served (route hits only; network responses are the origin's). */
  status?: number;
  range?: string;
  reason?: 'no-entry';
}

export type RouteDropReason = 'out-of-scope' | 'integrity' | 'no-location' | 'over-budget' | 'evicted';

export interface RouteCacheStats {
  hits: number;
  misses: number;
  lateHits: number;
  entries: number;
  bytes: number;
  drops: Record<RouteDropReason, number>;
}

/** The bytes-only subset of the frozen `window.multicast` Subscription surface. */
export interface ByteSubscription {
  addEventListener(type: 'bytes', listener: (event: CustomEvent<ArrayBuffer>) => void): void;
  removeEventListener(type: 'bytes', listener: (event: CustomEvent<ArrayBuffer>) => void): void;
}

export interface MabrRouteProxyOptions {
  /** Bound the cache so a stalled player cannot retain media forever. */
  maxEntries?: number;
  /** Total cached bytes (default 128 MiB) and per-object cap (default 64 MiB). */
  maxBytes?: number;
  maxObjectBytes?: number;
  /**
   * Bounded wait (default 0, max 250) for an object that is mid-assembly
   * before a miss falls through to the network.
   */
  lookupWaitMs?: number;
  /**
   * Base for relative Content-Location and request URLs. The sender labels
   * objects with DS-root paths, so for DS URLs this is the DS origin root.
   */
  baseUrl?: string;
  /**
   * Cache scope: only URLs under this URL's directory are cached and
   * answered, so nothing else can be shadowed. Defaults to `baseUrl`.
   */
  scope?: string;
  /** Called for GET/HEAD requests except no-store and reload; callback errors are ignored. */
  onCacheEvent?: (event: RouteCacheEvent) => void;
}

/** Session hook, not exported from the package: rebase and rescope the cache. */
export const rescope = Symbol('mabr-route-proxy.rescope');

function bytes(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}


function sameToi(left: bigint | number | string, right: bigint | number | string): boolean {
  return String(left) === String(right);
}

interface ShakaFetchPlugin {
  fetch_?: typeof globalThis.fetch;
}

interface ShakaGlobal {
  net?: { HttpFetchPlugin?: ShakaFetchPlugin };
}

function shakaGlobal(): ShakaGlobal | undefined {
  return (globalThis as typeof globalThis & { shaka?: ShakaGlobal }).shaka;
}

export class MabrRouteProxy {
  readonly #maxEntries: number;
  #baseUrl: string;
  #scope: string;
  readonly #entries = new Map<string, { body: ArrayBuffer; type: string }>();
  readonly #onCacheEvent: ((event: RouteCacheEvent) => void) | undefined;
  readonly #maxBytes: number;
  readonly #maxObjectBytes: number;
  readonly #lookupWaitMs: number;
  readonly #waiters = new Map<string, Set<() => void>>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #lateHits = 0;
  readonly #drops: Record<RouteDropReason, number> = { 'out-of-scope': 0, integrity: 0, 'no-location': 0, 'over-budget': 0, evicted: 0 };
  #networkFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
  #restore: (() => void) | undefined;

  constructor(options: MabrRouteProxyOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 256;
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new RangeError('maxEntries must be positive');
    this.#maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.#maxObjectBytes = options.maxObjectBytes ?? 64 * 1024 * 1024;
    this.#lookupWaitMs = options.lookupWaitMs ?? 0;
    if (!(this.#maxBytes > 0) || !(this.#maxObjectBytes > 0)) throw new RangeError('maxBytes and maxObjectBytes must be positive');
    if (!(this.#lookupWaitMs >= 0 && this.#lookupWaitMs <= 250)) throw new RangeError('lookupWaitMs must be 0..250');
    this.#baseUrl = options.baseUrl ?? globalThis.location?.href ?? 'http://localhost/';
    this.#scope = new URL('.', new URL(options.scope ?? this.#baseUrl, this.#baseUrl)).href;
    this.#onCacheEvent = options.onCacheEvent;
  }

  /** Replace base and scope, dropping cached entries outside the new scope. */
  [rescope](baseUrl: string, scope: string): void {
    this.#baseUrl = baseUrl;
    this.#scope = new URL('.', new URL(scope, baseUrl)).href;
    for (const url of [...this.#entries.keys()]) if (!url.startsWith(this.#scope)) this.#remove(url);
  }

  #remove(url: string): boolean {
    const old = this.#entries.get(url);
    if (!old) return false;
    this.#bytes -= old.body.byteLength;
    return this.#entries.delete(url);
  }

  /** Count an object the ROUTE layer refused to cache (e.g. incomplete or unlabelled). */
  noteDrop(reason: RouteDropReason): void { this.#drops[reason]++; }

  /**
   * Cache bytes at `segment.url`. Returns undefined, caching nothing, when the
   * resolved URL is outside the scope: Content-Location arrives on
   * unauthenticated multicast/AMT, and installFetch() answers every page GET.
   */
  put(segment: RouteSegment): string | undefined {
    const url = normalizeKey(segment.url, this.#baseUrl);
    if (!url.startsWith(this.#scope)) { this.#drops['out-of-scope']++; return undefined; }
    const size = segment.data.byteLength;
    if (size > this.#maxObjectBytes || size > this.#maxBytes) { this.#remove(url); this.#drops['over-budget']++; return undefined; }
    this.#remove(url);
    this.#entries.set(url, { body: bytes(segment.data), type: segment.contentType || contentTypeFor(url) });
    this.#bytes += size;
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      this.#remove(this.#entries.keys().next().value!);
      this.#drops.evicted++;
    }
    for (const wake of this.#waiters.get(url) ?? []) wake();
    return url;
  }

  /** Cache a manifest generated by the existing ROUTE/CMAF sender. */
  putManifest(manifest: RouteManifest): string | undefined {
    return this.put({
      url: manifest.url,
      data: manifest.body,
      contentType: manifest.contentType,
    });
  }

  /** Resolve a completed ROUTE object through the existing FDT TOI mapping. */
  putRouteObject(object: RoutePayload, file: RouteFile): string | undefined {
    if (!sameToi(object.toi, file.toi)) {
      throw new RangeError(`ROUTE TOI ${String(object.toi)} does not match FDT TOI ${String(file.toi)}`);
    }
    return this.put({
      url: file.contentLocation,
      data: object.data,
      contentType: file.contentType,
    });
  }

  delete(url: string): boolean { return this.#remove(normalizeKey(url, this.#baseUrl)); }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
  get size(): number { return this.#entries.size; }
  get stats(): RouteCacheStats {
    return { hits: this.#hits, misses: this.#misses, lateHits: this.#lateHits, entries: this.#entries.size, bytes: this.#bytes, drops: { ...this.#drops } };
  }

  /** Resolve true if `url` is put within the bound, else false. */
  #waitFor(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.#waiters.get(url) ?? new Set<() => void>();
      this.#waiters.set(url, set);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        set.delete(wake);
        if (!set.size) this.#waiters.delete(url);
        resolve(ok);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), this.#lookupWaitMs);
      set.add(wake);
    });
  }

  #report(event: RouteCacheEvent): void {
    try {
      this.#onCacheEvent?.(event);
    } catch {
      // Observability must never interrupt player requests.
    }
  }

  /** Connect a `window.multicast` bytes subscription with a ROUTE decoder. */
  attach(subscription: ByteSubscription, decode: (bytes: ArrayBuffer) => RouteSegment | readonly RouteSegment[] | undefined): () => void {
    const listener = (event: CustomEvent<ArrayBuffer>) => {
      const result = decode(event.detail);
      if (result === undefined) return;
      for (const segment of Array.isArray(result) ? result : [result]) this.put(segment);
    };
    subscription.addEventListener('bytes', listener);
    return () => subscription.removeEventListener('bytes', listener);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    // A request that bypasses caches (DS discovery sends no-store) must not
    // be answered by objects that arrived on unauthenticated multicast.
    if ((request.method !== 'GET' && request.method !== 'HEAD') ||
        request.cache === 'no-store' || request.cache === 'reload') return this.#networkFetch(request);
    const url = normalizeKey(request.url, this.#baseUrl);
    const method = request.method as 'GET' | 'HEAD';
    const range = request.headers.get('range') ?? undefined;
    let hit = this.#entries.get(url);
    let late = false;
    // Only wait for URLs we would actually answer, so out-of-scope requests never stall.
    if (!hit && this.#lookupWaitMs > 0 && url.startsWith(this.#scope) && await this.#waitFor(url)) {
      hit = this.#entries.get(url);
      late = hit !== undefined;
    }
    if (!hit) {
      this.#misses++;
      this.#report({ url, method, outcome: 'miss', transport: 'network', reason: 'no-entry', ...(range ? { range } : {}) });
      return this.#networkFetch(request);
    }
    const reply = respond(hit, { method, range, ifRange: request.headers.get('if-range') });
    if (late) this.#lateHits++; else this.#hits++;
    this.#report({ url, method, outcome: late ? 'late-hit' : 'hit', transport: 'route', status: reply.status, ...(range ? { range } : {}) });
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }

  /** Patch page fetch; returns an idempotent restore function. */
  installFetch(): () => void {
    if (this.#restore) return this.#restore;
    const original = globalThis.fetch;
    this.#networkFetch = original.bind(globalThis);
    const proxy = this;
    const patched = function(input: RequestInfo | URL, init?: RequestInit) { return proxy.fetch(input, init); };
    globalThis.fetch = patched;

    // Shaka's default Fetch plugin snapshots window.fetch when its module is
    // loaded. Update that snapshot when Shaka was loaded before this proxy;
    // custom fetch functions are left alone.
    const shaka = shakaGlobal();
    const plugin = shaka?.net?.HttpFetchPlugin;
    const shakaOriginal = plugin?.fetch_;
    if (plugin && shakaOriginal === original) plugin.fetch_ = patched;
    else if (shaka && plugin && !shakaOriginal) {
      console.warn('[mabr-route-proxy] Shaka was loaded before installFetch(), but its production Fetch plugin hides window.fetch; call installFetch() before evaluating Shaka or configure a networking plugin with proxy.fetch');
    }

    this.#restore = () => {
      globalThis.fetch = original;
      if (plugin && plugin.fetch_ === patched) plugin.fetch_ = shakaOriginal;
      this.#restore = undefined;
    };
    return this.#restore;
  }
}

export function createMabrRouteProxy(options?: MabrRouteProxyOptions): MabrRouteProxy {
  return new MabrRouteProxy(options);
}
