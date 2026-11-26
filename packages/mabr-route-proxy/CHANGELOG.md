# Changelog

## 0.3.0

### Added (opt-in, default OFF)

- `installTransparentAdapter(session)`: page-world `fetch` / `XMLHttpRequest`
  interception so an unmodified Shaka, hls.js or dash.js answers ordinary
  DASH/HLS URLs from ROUTE. See README "Transparent interception for
  unmodified players".
- `transparent` session option (`unauthenticatedSegments`, `verifyManifest`).
  Segments are served from ROUTE only for origins you list; the default serves none.
- Shared ROUTE lookup/respond contract (`respond.ts`) and the ordinary-player,
  manifest-derived init flow.
- Compatibility matrix (`tests/compat/`, `npm run test:compat`) and its CI
  workflow: Shaka, hls.js, dash.js on Chromium and Firefox.

### Unchanged

- Nothing is intercepted unless you call `installTransparentAdapter()`.
  `createRouteMabrSession()`, `installFetch()`, `proxy.fetch` and `resolve()`
  behave as in 0.2.x when the `transparent` option is not set.
- No production deployment or page enablement ships with this release.

### Known limits

See README "Unsupported combinations" (webkit/Safari, Safari native HLS,
Service Worker and extension packaging are not built or claimed).

## 0.2.3

Last published release before 0.3.0.
