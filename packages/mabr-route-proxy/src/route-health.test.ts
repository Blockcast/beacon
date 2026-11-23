import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTE_POLICY_VERSION,
  createShakaRouteHealthAdapter,
  extractShakaRenditionBindings,
  formatRouteHealthDiagnostic,
  mapRouteHealthToShakaRenditions,
  matchRouteTemplate,
  normalizeRoutePolicySnapshot,
  routeTransportLabel,
  type RouteHealthDiagnostic,
  type RoutePolicySnapshot,
  type ShakaRenditionBinding,
  type ShakaRoutePlayer,
} from './route-health.ts';

const high: ShakaRenditionBinding = {
  id: 'video-high',
  format: 'hls',
  bandwidth: 5_200_000,
  uris: ['https://player.test/live/chunk-stream0-1-05222.m4s'],
};
const low: ShakaRenditionBinding = {
  id: 'video-low',
  format: 'hls',
  bandwidth: 1_100_000,
  uris: ['https://player.test/live/chunk-stream2-1-05222.m4s'],
};

function snapshot(overrides: Partial<RoutePolicySnapshot> = {}): RoutePolicySnapshot {
  return {
    version: DEFAULT_ROUTE_POLICY_VERSION,
    decisions: [],
    renditions: [],
    ...overrides,
  };
}

function player(calls: unknown[] = []): ShakaRoutePlayer {
  return {
    configure(value: unknown) { calls.push(value); },
  };
}

test('matches template-only FDT paths and extracts the TOI', () => {
  assert.deepEqual(
    matchRouteTemplate('nasa/iss/a/chunk-stream0-1-$TOI%05d$.m4s', '/nasa/iss/a/chunk-stream0-1-05222.m4s'),
    { toi: '05222' },
  );
  assert.deepEqual(matchRouteTemplate('media-%05d.m4s', 'media-9.m4s'), { toi: '9' });
  assert.deepEqual(matchRouteTemplate('media-%d.m4s', 'media-9.m4s'), { toi: '9' });
  assert.equal(matchRouteTemplate('media-%05d.m4s', 'other-9.m4s'), undefined);
});

test('maps HLS and DASH bindings by URI/template and keeps telemetry separate', () => {
  const dash: ShakaRenditionBinding = {
    id: 'Representation-720', format: 'dash', bandwidth: 7_200_000,
    uris: ['https://player.test/live/video/seg-720-100.m4s'],
  };
  const result = mapRouteHealthToShakaRenditions([high, dash], snapshot({
    renditions: [
      { tsi: 148, template: 'live/chunk-stream0-1-$TOI%05d$.m4s', receive_bitrate_bps: 80_000_000, received_bytes: 10_000_000 },
      { tsi: 720, template: 'live/video/seg-720-$TOI.m4s', receive_bitrate_bps: 1_000_000 },
    ],
  }));
  assert.equal(result[0]?.health?.tsi, 148);
  assert.equal(result[1]?.health?.tsi, 720);
  // A large aggregate/receive rate is not a Shaka bandwidth estimate or cap.
  assert.equal(result[0]?.decision, undefined);
});

test('normalizes rollout JSON and does not invent an unknown transport', () => {
  const normalized = normalizeRoutePolicySnapshot(JSON.stringify({
    policy_version: DEFAULT_ROUTE_POLICY_VERSION,
    decisions: [{ tsi: '148', cap: true, reason: 'wifi_multicast_slow', transport: 'mobile-beacon' }],
    subscriptions: [{ tsi: 148, last_toi: '5222', complete: true }],
  }));
  assert.equal(normalized.version, DEFAULT_ROUTE_POLICY_VERSION);
  assert.equal(normalized.decisions[0]?.transport, 'amt');
  assert.equal(normalized.renditions[0]?.last_toi, '5222');
  const unknown = normalizeRoutePolicySnapshot({ version: DEFAULT_ROUTE_POLICY_VERSION, renditions: [{}] });
  assert.equal(unknown.renditions[0]?.transport, undefined);
});

test('caps a bad high rendition while leaving the lower HTTP fallback available', async () => {
  const calls: unknown[] = [];
  const diagnostics: RouteHealthDiagnostic[] = [];
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls),
    provider: { getSnapshot: () => snapshot({
      renditions: [{ tsi: 148, template: 'live/chunk-stream0-1-$TOI%05d$.m4s', transport: 'amt', state: 'DEGRADED', last_toi: 5222, path: 'live/high-5222.m4s', complete: false }],
      decisions: [{ tsi: 148, cap: true, allowed: false, reason: 'amt_late', transport: 'http' }],
    }) },
    format: 'hls',
    getRenditions: () => [high, low],
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const result = await adapter.refresh();
  assert.equal(result.capped, true);
  assert.equal(result.maxBandwidth, low.bandwidth);
  assert.deepEqual(calls, [{ abr: { restrictions: { maxBandwidth: low.bandwidth } } }]);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /rendition=video-high/);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /tsi=148/);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /toi=5222/);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /transport=http/);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /reason=amt_late/);
});

test('uses explicit source labels and never guesses an unknown browser path', () => {
  assert.equal(routeTransportLabel('native'), 'direct IWA socket');
  assert.equal(routeTransportLabel('amt'), 'Mobile Beacon');
  assert.equal(routeTransportLabel('unknown'), 'path not reported');
  const calls: unknown[] = [];
  const diagnostics: RouteHealthDiagnostic[] = [];
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls), provider: {}, format: 'hls', getRenditions: () => [high],
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  adapter.apply(snapshot({ decisions: [{ rendition: 'video-high', allowed: true, transport: 'unknown' }] }), [high]);
  assert.match(formatRouteHealthDiagnostic(diagnostics[0]!), /path not reported/);
});

test('applies an explicit policy cap without confusing lower rendition bandwidth with the cap', () => {
  const calls: unknown[] = [];
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls),
    provider: {},
    format: 'dash',
    getRenditions: () => [high, low],
  });
  const result = adapter.apply(snapshot({
    decisions: [{ rendition: 'video-high', cap: true, max_bandwidth: 2_000_000, reason: 'native_stale' }],
  }), [high, low]);
  assert.equal(result.maxBandwidth, 2_000_000);
  assert.deepEqual(calls[0], { abr: { restrictions: { maxBandwidth: 2_000_000 } } });
});

test('unknown, stale, or missing policy fails open and restores normal Shaka ABR', () => {
  const calls: unknown[] = [];
  const diagnostics: RouteHealthDiagnostic[] = [];
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls),
    provider: {},
    format: 'dash',
    getRenditions: () => [high, low],
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  const result = adapter.apply({ version: 'gw-rendition-health/999', decisions: [{ tsi: 148, cap: true }] });
  assert.equal(result.capped, false);
  assert.equal(result.maxBandwidth, undefined);
  assert.deepEqual(calls[0], { abr: { restrictions: { maxBandwidth: Infinity } } });
  assert.equal(diagnostics.at(-1)?.reason, 'policy_version_unknown');
  assert.equal(diagnostics.at(-1)?.path, 'path not reported');
});

test('policy recovery restores the higher rung; JavaScript supplies no stability threshold', () => {
  const calls: unknown[] = [];
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls),
    provider: {},
    format: 'hls',
    getRenditions: () => [high, low],
  });
  adapter.apply(snapshot({ decisions: [{ rendition: 'video-high', cap: true, allowed: false }] }), [high, low]);
  adapter.apply(snapshot({ decisions: [{ rendition: 'video-high', cap: false, allowed: true, reason: 'probe_recovered', transport: 'native' }] }), [high, low]);
  assert.deepEqual(calls, [
    { abr: { restrictions: { maxBandwidth: low.bandwidth } } },
    { abr: { restrictions: { maxBandwidth: Infinity } } },
  ]);
});

test('extracts stable HLS/DASH aliases from Shaka tracks', () => {
  const fake: ShakaRoutePlayer = {
    configure() {},
    getVariantTracks: () => [{ id: 7, bandwidth: 1_100_000, videoId: 'Representation-7' }],
    getManifest: () => ({ variants: [{ id: 7, bandwidth: 1_100_000, video: {
      id: 17, originalId: 'Representation-7', uris: ['video/seg-7-$TOI$.m4s'],
    } }] }),
  };
  const bindings = extractShakaRenditionBindings(fake, { format: 'dash', manifestUrl: 'https://player.test/manifest.mpd' });
  assert.equal(bindings[0]?.id, '7');
  assert.equal(bindings[0]?.format, 'dash');
  assert.ok(bindings[0]?.aliases?.includes('Representation-7'));
  assert.deepEqual(bindings[0]?.uris, ['video/seg-7-$TOI$.m4s']);
});

test('provider updates can be applied without adding a second transport byte counter', () => {
  const calls: unknown[] = [];
  let listener: ((snapshot?: unknown) => void) | undefined;
  const adapter = createShakaRouteHealthAdapter({
    player: player(calls),
    provider: {
      subscribe: (callback) => { listener = callback; return () => { listener = undefined; }; },
    },
    format: 'hls',
    getRenditions: () => [high, low],
  });
  adapter.start();
  listener?.(snapshot({ renditions: [{ tsi: 148, received_bytes: 9_999_999, receive_bitrate_bps: 99_000_000 }] }));
  assert.deepEqual(calls, [{ abr: { restrictions: { maxBandwidth: Infinity } } }]);
  adapter.stop();
  assert.equal(listener, undefined);
});
