import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeMulticastProvider } from '../../multicast-contract/src/fake-gateway.ts';
import { createRouteMabrSession, type RouteGateway } from './route.ts';

const encoder = new TextEncoder();

function routeWasmFixture() {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const input = 1024;
  const objects = [
    {
      location: 'live/dash/manifest.mpd',
      type: 'application/dash+xml',
      data: '<MPD><SegmentTemplate initialization="init.mp4" media="seg-1.m4s"/></MPD>',
    },
    {
      location: 'live/dash/init.mp4',
      type: 'video/mp4',
      data: 'DASH-INIT',
    },
    {
      location: 'live/dash/seg-1.m4s',
      type: 'video/iso.segment',
      data: 'DASH-SEGMENT',
    },
    {
      location: 'live/hls/master.m3u8',
      type: 'application/vnd.apple.mpegurl',
      data: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n',
    },
    {
      location: 'live/hls/media.m3u8',
      type: 'application/vnd.apple.mpegurl',
      data: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg-1.m4s\n',
    },
    {
      location: 'live/hls/init.mp4',
      type: 'video/mp4',
      data: 'HLS-INIT',
    },
    {
      location: 'live/hls/seg-1.m4s',
      type: 'video/iso.segment',
      data: 'HLS-SEGMENT',
    },
  ];
  let index = 0;

  const put = (offset: number, value: Uint8Array): number => {
    new Uint8Array(memory.buffer, offset, value.byteLength).set(value);
    return offset;
  };
  const exports = {
    memory,
    route_get_buffer: () => input,
    route_get_buffer_size: () => 4096,
    route_process_udp: () => {},
    route_get_completed_count: () => objects.length - index,
    route_pop_completed_tsi: () => 7n,
    route_pop_completed_toi: () => BigInt(index + 1),
    route_pop_completed_len: () => encoder.encode(objects[index]?.data ?? '').byteLength,
    route_pop_completed_data: () => put(2048, encoder.encode(objects[index]?.data ?? '')),
    route_pop_completed_type: () => put(32768, encoder.encode(objects[index]?.type ?? '')),
    route_pop_completed_type_len: () => encoder.encode(objects[index]?.type ?? '').byteLength,
    route_pop_completed_location: () => put(33000, encoder.encode(objects[index]?.location ?? '')),
    route_pop_completed_location_len: () => encoder.encode(objects[index]?.location ?? '').byteLength,
    route_pop_completed_codepoint: () => 8,
    route_pop_completed_integrity: () => 100,
    route_pop_completed_advance: () => { index += 1; },
  };
  return { exports };
}

async function text(response: Response): Promise<string> {
  assert.equal(response.status, 200);
  return response.text();
}

for (const ingress of ['native', 'amt'] as const) {
  test(`fetches DASH and HLS CMAF objects after ${ingress} byte delivery`, { concurrency: false }, async () => {
    const provider = new FakeMulticastProvider();
    const group = '239.21.4.1';
    const port = 5004;
    const routeConfig = ingress === 'native'
      ? { origin: 'ip-multicast' as const, group, port, consume: 'bytes' as const }
      : {
          origin: 'amt' as const,
          group,
          port,
          consume: 'bytes' as const,
          relay: '198.51.100.20',
          relayPort: 2268,
        };
    const session = createRouteMabrSession({
      gateway: provider.gateway as unknown as RouteGateway,
      wasm: routeWasmFixture(),
      ingress,
      group,
      port,
      ...(ingress === 'amt' ? { relay: '198.51.100.20', relayPort: 2268 } : {}),
      baseUrl: 'https://player.test/',
      maxEntries: 20,
    });

    await session.start();
    try {
      provider.deliverBytes(routeConfig, [Uint8Array.of(1, 2, 3)]);

      const dashManifestUrl = 'https://player.test/live/dash/manifest.mpd';
      const dashManifest = await session.fetch(dashManifestUrl);
      assert.match(await text(dashManifest), /SegmentTemplate/);
      assert.equal(await text(await session.fetch('https://player.test/live/dash/init.mp4')), 'DASH-INIT');
      const dashSegment = await session.fetch('https://player.test/live/dash/seg-1.m4s', {
        headers: { range: 'bytes=5-11' },
      });
      assert.equal(dashSegment.status, 206);
      assert.equal(await dashSegment.text(), 'SEGMENT');

      const hlsMaster = await text(await session.fetch('https://player.test/live/hls/master.m3u8'));
      assert.match(hlsMaster, /media\.m3u8/);
      const hlsMedia = await text(await session.fetch('https://player.test/live/hls/media.m3u8'));
      assert.match(hlsMedia, /EXT-X-MAP/);
      assert.equal(await text(await session.fetch('https://player.test/live/hls/init.mp4')), 'HLS-INIT');
      assert.equal(await text(await session.fetch('https://player.test/live/hls/seg-1.m4s')), 'HLS-SEGMENT');
      assert.equal(session.size, 7);
    } finally {
      await session.stop();
    }
  });
}
