# `@blockcast/mabr-route-proxy`

This is the small browser handoff between the existing `route.wasm` consumer and
an existing DASH or HLS player. `RouteMabrSession` feeds the already-defined
`route_process_udp` / completed-object ABI from `window.multicast`, uses the
ROUTE/FDT `contentLocation` as the cache key, and stores DASH/HLS manifests and
CMAF objects. Shaka keeps its normal manifest and segment URLs:

```ts
import { createRouteMabrSession } from '@blockcast/mabr-route-proxy';

// ROUTE objects are mounted under baseUrl: an FDT Content-Location of
// `live/manifest.mpd` is served at `${baseUrl}live/manifest.mpd`.
const baseUrl = 'https://player.example/mabr/';
const manifestUrl = new URL('live/manifest.mpd', baseUrl).href;
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  // `toSls` is the service SLS endpoint selected by the sender/TO. Use
  // ingress: 'amt'; with an SSM source the gateway discovers the relay via
  // RFC 8777 DNS (relay/relayPort are only an explicit override).
  ingress: 'native',
  slsEndpoint: toSls,
  discoverEndpoints: true,
  baseUrl,
  maxEntries: 300,
});
const restoreFetch = proxy.installFetch();
await proxy.start();

await shakaPlayer.load(manifestUrl);       // DASH MPD or HLS .m3u8
```

`baseUrl` is also the cache scope. Only Content-Location URLs under its
directory are cached; anything else is dropped and the request goes to the
network. ROUTE objects arrive over unauthenticated multicast or AMT, and
`installFetch()` answers every GET the page makes, so give ROUTE a path of its
own, never the origin root. A root `baseUrl` lets an on-path injector shadow
any same-origin URL.

When a network does not carry LLS on the ATSC 3 ASM group, bootstrap the
service SLS over HTTPS. `sltUrl` is the HTTP LLS/SLT authority exposed by the
TO-selected sender; it is used only to select the first service SLS leg. The
browser still receives ROUTE bytes through DIMT or AMT, and the S-TSID on that
leg supplies the rendition `(S,G,port)` values:

```ts
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  ingress: 'native',                 // use 'amt' for AMT/DRIAD when SLS has an SSM source
  sltUrl: 'https://live.example/slt/',
  sltGroup: 7,                       // optional when /slt/ lists one group
  serviceId: 'nasa-iss-a',            // globalServiceID or numeric serviceId
  discoverEndpoints: true,
  baseUrl,
});
const restoreFetch = proxy.installFetch();
await proxy.start();
await shakaPlayer.load(manifestUrl);  // .mpd or .m3u8
```

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
  slsEndpoint: toSls,
  discoverEndpoints: true,
});
```

The proxy patches only `fetch`, returns a normal `Response`, and falls through
to the network on a cache miss. Call `stop()` and `restoreFetch()` when playback
ends.

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
Shaka versions configured with an XHR networking plugin need that plugin
pointed at `proxy.fetch`; the default Fetch plugin is intercepted by
`installFetch()`.

For route.wasm builds that expose the optional RFC 6330 symbol queue, pass the
initialized browser sidecar from `fec-raptorq/wasm/pkg` to recover lost CMAF
objects before they reach the player:

```ts
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  ingress: 'native',
  slsEndpoint: toSls,
  discoverEndpoints: true,
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
