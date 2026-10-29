# `@blockcast/mabr-route-proxy`

This is the small browser handoff between the existing `route.wasm` consumer and
an existing DASH or HLS player. `RouteMabrSession` feeds the already-defined
`route_process_udp` / completed-object ABI from `window.multicast`, uses the
ROUTE/FDT `contentLocation` as the cache key, and stores DASH/HLS manifests and
CMAF objects. Shaka keeps its normal manifest and segment URLs:

```ts
import { createRouteMabrSession } from '@blockcast/mabr-route-proxy';

const session = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  // Use ingress: 'amt'; with an SSM source the gateway discovers the relay via
  // RFC 8777 DNS (relay/relayPort are only an explicit override).
  ingress: 'native',
  sltUrl: 'https://live.example',   // the public delivery service (DS)
  serviceId: 'generic-service',
  maxEntries: 300,
});
const restoreFetch = session.installFetch();
await session.start();
if (!session.manifestUrl) throw new Error('DS SLT did not advertise a DASH/HLS manifest');
await shakaPlayer.load(session.manifestUrl); // DASH MPD or HLS .m3u8
```

`start()` reads the DS's `/slt/`, joins the service's SLS leg and takes the
manifest from the service's `PresentationManifest`. The sender labels ROUTE
objects with DS-root paths (`live/seg-1.m4s`), so the session resolves
Content-Locations against the DS origin root and caches only URLs under the
manifest's directory (`https://live.example/live/`). `session.manifestUrl` is
the URL to load, and a miss goes to the DS over unicast. A manifest at the DS
origin root makes `start()` throw; pass `baseUrl` and `scope` explicitly then.

`scope` is the cache's reach: only URLs under its directory are cached and
answered, and every other request goes to the network. It defaults to the
directory of `baseUrl`. ROUTE objects arrive over unauthenticated multicast or
AMT, and `installFetch()` answers every GET the page makes, so never use an
origin root as the scope. A root scope lets an on-path injector shadow any URL
on that origin, including the DS's `/slt/`.

When a network does not carry LLS on the ATSC 3 ASM group, bootstrap the
service SLS over HTTP. `sltUrl` may be the public delivery-service origin or
an explicit `/slt/<group>` URL. For an origin, the library reads the public
`/slt/` listing and fetches the advertised groups; it never assumes a group
number. The selected service's `PresentationManifest`
(`urn:blockcast:route:1`) supplies the DASH or HLS manifest path, which must
be on the DS's own origin; when it advertises several (for example DASH and
HLS), the first in SLT order is used. Its SLS leg supplies the first multicast
join. Its hostname is never used as the AMT relay. The browser still receives
ROUTE bytes through DIMT or AMT, and the S-TSID on that leg supplies the
rendition `(S,G,port)` values. Discovery requests are sent with
`cache: 'no-store'`, which the proxy always passes to the network, so objects
that arrived over multicast cannot answer them. `stop()` aborts a discovery in
flight, and `discoverSlsEndpoint` takes the same `signal` option.

To wire the leg, base and scope explicitly, discover once and pass them:

```ts
const sls = await discoverSlsEndpoint({sltUrl: 'https://live.example', serviceId: 'generic-service'});
if (!sls.manifestUrl) throw new Error('DS SLT did not advertise a DASH/HLS manifest');
const session = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  ingress: 'native',                             // use 'amt' for AMT/DRIAD when SLS has an SSM source
  slsEndpoint: sls,
  discoverEndpoints: true,
  baseUrl: new URL('/', sls.manifestUrl).href,   // Content-Locations are DS-root paths
  scope: new URL('.', sls.manifestUrl).href,     // cache only the manifest's directory
});
const restoreFetch = session.installFetch();
await session.start();
await shakaPlayer.load(session.manifestUrl!);   // .mpd or .m3u8
```

Explicit `baseUrl` and `scope` are used as given; nothing is derived.
`session.manifestUrl` is then the manifest's path resolved against `baseUrl`:
with a page mount such as `https://player.example/mabr/` it is
`https://player.example/mabr/live/manifest.mpd`, and a miss goes to that
mount, which needs a reverse proxy to the DS.

The client fetches `/slt/` to list access groups, then `/slt/<group>` to read
the SLT XML and select the service's `slsProtocol="1"` ROUTE
`BroadcastSvcSignaling`. A deployment may pass a direct `/slt/<group>` URL
instead. The client fails closed when the service selector does not identify
exactly one SLS endpoint; it never guesses a media rendition group and does
not require LLS ASM reception.

For TO/SLS-driven mABR, pass only the TO-selected service SLS leg. The
existing route.wasm S-TSID exports then add each rendition's `(S,G,port)` as
the service signals it; no rendition groups are copied into the page:

```ts
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  ingress: 'native',
  slsEndpoint: sls,                  // the TO-selected leg, e.g. from discoverSlsEndpoint()
  discoverEndpoints: true,
});
```

The proxy patches only `fetch`, returns a normal `Response`, and falls through
to the network on a cache miss and for requests sent with `cache: 'no-store'`
or `'reload'`. Use `cacheStats` or `onCacheEvent` to make cache-miss fallback
visible to telemetry; the callback is best-effort, never changes playback
behavior and does not see `no-store` or `reload` requests:

```ts
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  sltUrl: 'https://live.example',
  serviceId: 'generic-service',
  onCacheEvent: ({ outcome, transport, url }) => {
    metrics.count(`mabr.route.${outcome}`, 1, { transport, url });
  },
});
// proxy.cacheStats === { hits: 0, misses: 0 } before any player request.
```

Call `stop()` and `restoreFetch()` when playback ends.

The session uses the existing route.wasm completed-object ABI and its SLS
manifest accessors (`route_sls_manifest*`, with `route_get_mpd*` as a legacy
fallback); it does not reimplement ROUTE object assembly. Both DASH MPDs and
HLS master/media playlists are cached by their signalled FDT
`Content-Location`, along with the CMAF initialization and media fragments.
Pass the handle returned by the existing loader after that loader has called
`route_init()`.
Set `ingress: 'native'` for DIMT (`origin: 'ip-multicast'`) or `ingress: 'amt'`
for AMT (`origin: 'amt'`). With an SSM source from SLS, omit `relay` and
`relayPort`; the proxy sends `discovery: 'driad'` and the gateway performs RFC
8777 DRIAD over DNS. An explicit relay hostname/IP remains available for
deployments without DRIAD. The default
`ingress: 'tuner'` preserves the ATSC 3 USB/OTA path. The public
`window.multicast` integration then consumes the ROUTE UDP bytes;
ATSC 1 raw MPEG-TS requires a host-provided feed to `route_process_ts` and is
intentionally not advertised by this package.
For Shaka's debug/uncompiled builds, `installFetch()` also updates the default
Fetch plugin if Shaka was loaded first. Production compiled Shaka hides that
fetch snapshot; call `installFetch()` before evaluating the Shaka script, or
configure the player's custom networking plugin to call `proxy.fetch`. The
proxy warns when it detects a previously loaded compiled build that it cannot
patch.

For route.wasm builds that expose the optional RFC 6330 symbol queue, pass the
initialized browser sidecar from `fec-raptorq/wasm/pkg` to recover lost CMAF
objects before they reach the player:

```ts
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  ingress: 'native',
  sltUrl: 'https://live.example',
  serviceId: 'generic-service',
  raptorq: { wasm: raptorqWasm },
});
```

The sidecar must be initialized before `start()`. Recovery uses the parser's
FTI geometry and scalar `[SBN, ESI]` fields, normalizing each source block to
the decoder's zero-based block ID, then stores the reconstructed object at its
FDT `contentLocation`; old route.wasm builds simply skip this
optional path. The collector bounds browser state at 32 objects, 64 MiB per
object, 4,096 decoded source blocks per object, and 262,144 symbols per object by
default; set the `raptorq.max*` options when the service's announced geometry
requires a different resource budget.

The browser E2E test uses the checked-out ATSC 3 parser, the real
`fec-raptorq` WASM module, and Shaka's test CMAF assets. It drops one source
symbol from an HLS segment, verifies exact recovery, then plays DASH and HLS
through the cache for both native DIMT and AMT subscription configurations:

```sh
npm run test:e2e
```

Set `PMG_ROOT`, `ROUTE_WASM`, `ROUTE_WASM_EXEC`, `RAPTORQ_JS`, `RAPTORQ_WASM`,
`SHAKA_JS`, `MEDIA_ROOT`, `PLAYWRIGHT`, or `CHROME_PATH` when those artifacts
live outside the adjacent `pim-multicast-gateway` checkout. `CHROME_PATH` is
useful when the installed browser is available but Playwright's pinned revision
is not.
