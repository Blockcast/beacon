# `@blockcast/mabr-route-proxy`

This is the small browser handoff between the existing `route.wasm` consumer and
an existing DASH or HLS player. `RouteMabrSession` feeds the already-defined
`route_process_udp` / completed-object ABI from `window.multicast`, uses the
ROUTE/FDT `contentLocation` as the cache key, and stores DASH/HLS manifests and
CMAF objects. Shaka keeps its normal manifest and segment URLs:

```ts
import { createRouteMabrSession } from '@blockcast/mabr-route-proxy';

const manifestUrl = 'https://player.example/live/manifest.mpd';
const proxy = createRouteMabrSession({
  gateway: window.multicast,
  wasm: routeWasm,
  // DIMT/native multicast. Use ingress: 'amt' plus relay/relayPort for AMT.
  ingress: 'native',
  group: '239.21.4.1',
  port: 5004,
  // Resolve FDT Content-Location values against the actual player URL.
  baseUrl: new URL('/', manifestUrl).href,
  maxEntries: 300,
});
const restoreFetch = proxy.installFetch();
await proxy.start();

await shakaPlayer.load(manifestUrl);       // DASH MPD or HLS .m3u8
```

The proxy patches only `fetch`, returns a normal `Response`, and falls through
to the network on a cache miss. Call `stop()` and `restoreFetch()` when playback
ends.

The session uses the existing route.wasm completed-object ABI and its SLS
manifest accessors (`route_get_mpd*`); it does not reimplement ROUTE or SLS.
Pass the handle returned by the existing loader after that loader has called
`route_init()`.
Set `ingress: 'native'` for DIMT (`origin: 'ip-multicast'`) or `ingress: 'amt'`
with `relay` and `relayPort` for AMT (`origin: 'amt'`). The default
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
  group: '239.21.4.1',
  port: 5004,
  raptorq: { wasm: raptorqWasm },
});
```

The sidecar must be initialized before `start()`. Recovery uses the parser's
FTI geometry and exact `[SBN, ESI]` payload IDs, then stores the reconstructed
object at its FDT `contentLocation`; old route.wasm builds simply skip this
optional path.

The browser E2E test uses the checked-out ATSC 3 parser, the real
`fec-raptorq` WASM module, and Shaka's test CMAF assets. It drops one source
symbol from an HLS segment, verifies exact recovery, then plays DASH and HLS
through the cache for both native DIMT and AMT subscription configurations:

```sh
npm run test:e2e
```

Set `PMG_ROOT`, `ROUTE_WASM`, `ROUTE_WASM_EXEC`, `RAPTORQ_JS`, `RAPTORQ_WASM`,
`SHAKA_JS`, `MEDIA_ROOT`, or `PLAYWRIGHT` when those artifacts live outside the
adjacent `pim-multicast-gateway` checkout.
