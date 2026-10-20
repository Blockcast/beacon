import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteMabrSession, type RouteGateway } from './route.ts';

interface SymbolPacket {
  tsi: bigint;
  toi: bigint;
  sbn: number;
  esi: number;
  symbol: Uint8Array;
  transferLength: number;
  symbolSize: number;
  maxSbLen: number;
  maxNumEs: number;
  numSrcBlks: number;
  numSubBlks: number;
  symAlignParam: number;
  contentType: string;
  contentLocation: string;
}

const recoveredBytes = Uint8Array.of(1, 2, 3, 4);

function routeFixture() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const queue: SymbolPacket[] = [];
  let index = 0;
  const encoder = new TextEncoder();
  const put = (offset: number, value: string | Uint8Array): number => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    new Uint8Array(memory.buffer, offset, bytes.length).set(bytes);
    return offset;
  };
  const current = () => queue[index];
  const exports = {
    memory,
    route_get_buffer: () => 1024,
    route_get_buffer_size: () => 512,
    route_process_udp: () => {},
    route_get_completed_count: () => 0,
    route_pop_completed_advance: () => {},
    route_pop_raptorq_count: () => queue.length - index,
    route_get_raptorq_count: () => queue.length - index,
    route_pop_raptorq_tsi: () => current()?.tsi ?? 0n,
    route_pop_raptorq_toi: () => current()?.toi ?? 0n,
    route_pop_raptorq_sbn: () => current()?.sbn ?? 0,
    route_pop_raptorq_esi: () => current()?.esi ?? 0,
    route_pop_raptorq_symbol: () => put(2048, current()?.symbol ?? new Uint8Array()),
    route_pop_raptorq_symbol_len: () => current()?.symbol.length ?? 0,
    route_pop_raptorq_transfer_len: () => current()?.transferLength ?? 0,
    route_pop_raptorq_symbol_size: () => current()?.symbolSize ?? 0,
    route_pop_raptorq_max_sb_len: () => current()?.maxSbLen ?? 0,
    route_pop_raptorq_max_num_es: () => current()?.maxNumEs ?? 0,
    route_pop_raptorq_num_src_blks: () => current()?.numSrcBlks ?? 0,
    route_pop_raptorq_num_sub_blks: () => current()?.numSubBlks ?? 0,
    route_pop_raptorq_sym_align_param: () => current()?.symAlignParam ?? 0,
    route_pop_raptorq_codepoint: () => 8,
    route_pop_raptorq_type: () => put(3072, current()?.contentType ?? ''),
    route_pop_raptorq_type_len: () => encoder.encode(current()?.contentType ?? '').length,
    route_pop_raptorq_location: () => put(3200, current()?.contentLocation ?? ''),
    route_pop_raptorq_location_len: () => encoder.encode(current()?.contentLocation ?? '').length,
    route_pop_raptorq_advance: () => { index += 1; },
  };
  return {
    exports,
    setPackets(packets: SymbolPacket[]) {
      queue.splice(0, queue.length, ...packets);
      index = 0;
    },
  };
}

function packet(overrides: Partial<SymbolPacket> = {}): SymbolPacket {
  return {
    tsi: 7n,
    toi: 42n,
    sbn: 0,
    esi: 0,
    symbol: Uint8Array.of(9, 9, 9, 9),
    transferLength: recoveredBytes.length,
    symbolSize: recoveredBytes.length,
    maxSbLen: 1,
    maxNumEs: 2,
    numSrcBlks: 1,
    numSubBlks: 1,
    symAlignParam: 1,
    contentType: 'video/mp4',
    contentLocation: 'live/recovered.m4s',
    ...overrides,
  };
}

function gatewayFixture() {
  let listener: ((event: CustomEvent<ArrayBuffer>) => void) | undefined;
  const gateway: RouteGateway = {
    async subscribe() {
      return {
        addEventListener(_type: 'bytes', callback: (event: CustomEvent<ArrayBuffer>) => void) { listener = callback; },
        removeEventListener() { listener = undefined; },
        async unsubscribe() {},
      };
    },
  };
  return {
    gateway,
    deliver() { listener?.({ detail: new Uint8Array([1]).buffer } as CustomEvent<ArrayBuffer>); },
  };
}

function fakeRaptorQModule() {
  let freeCount = 0;
  const decoders: Array<{ oti: Uint8Array; packets: Uint8Array[]; freed: boolean }> = [];
  const otiFor = (transferLength: bigint, symbolSize: number, sourceBlocks: number, subBlocks: number, alignment: number): Uint8Array => {
    const oti = new Uint8Array(12);
    let length = Number(transferLength);
    for (let index = 4; index >= 0; index--) {
      oti[index] = length & 0xff;
      length = Math.floor(length / 256);
    }
    oti[6] = symbolSize >>> 8;
    oti[7] = symbolSize & 0xff;
    oti[8] = sourceBlocks;
    oti[9] = subBlocks >>> 8;
    oti[10] = subBlocks & 0xff;
    oti[11] = alignment;
    return oti;
  };
  class Decoder {
    readonly oti: Uint8Array;
    readonly packets: Uint8Array[] = [];
    readonly ordinal: number;
    complete = false;
    freed = false;

    constructor(oti: Uint8Array) {
      this.oti = new Uint8Array(oti);
      this.ordinal = decoders.length;
      decoders.push(this);
    }

    static with_params(transferLength: bigint, symbolSize: number, sourceBlocks: number, subBlocks: number, alignment: number): Decoder {
      return new Decoder(otiFor(transferLength, symbolSize, sourceBlocks, subBlocks, alignment));
    }

    add_packet(value: Uint8Array): boolean {
      this.packets.push(new Uint8Array(value));
      // ESI 1 stands in for a repair symbol that recovers the lost source.
      this.complete ||= value[3] === 1;
      return this.complete;
    }

    is_complete(): boolean { return this.complete; }
    get_result(): Uint8Array {
      const transferLength = (this.oti[0] * 0x100000000 + this.oti[1] * 0x1000000 + this.oti[2] * 0x10000 + this.oti[3] * 0x100 + this.oti[4]);
      return Uint8Array.from({ length: transferLength }, (_, index) => this.ordinal * 4 + index + 1);
    }
    free(): void { if (!this.freed) { this.freed = true; freeCount += 1; } }
  }
  return {
    module: { RaptorQDecoder: Decoder },
    decoders,
    get freeCount() { return freeCount; },
  };
}

test('recovers a lost ROUTE object from a repair symbol and serves it by Content-Location', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  route.setPackets([
    packet({ esi: 0 }),
    packet({ esi: 0 }), // duplicate source packet is ignored
    packet({ esi: 1 }), // repair symbol recovers the missing source
  ]);
  const recovered: Uint8Array[] = [];
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    baseUrl: 'https://player.test/',
    raptorq: {
      wasm: fec.module,
      onRecovered: (object) => recovered.push(object.data),
    },
  });
  await session.start();
  gateway.deliver();
  const response = await session.fetch('https://player.test/live/recovered.m4s');
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...recoveredBytes]);
  assert.deepEqual(recovered, [recoveredBytes]);
  assert.deepEqual([...fec.decoders[0].oti], [0, 0, 0, 0, 4, 0, 0, 4, 1, 0, 1, 1]);
  assert.equal(fec.decoders[0].packets.length, 2);
  assert.equal(fec.freeCount, 1);
  await session.stop();
});

test('uses wire symbol bytes and clamps stale FDT geometry', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  route.setPackets([
    packet({ esi: 0, symbolSize: 1, maxSbLen: 65535 }),
    packet({ esi: 1, symbolSize: 1, maxSbLen: 65535 }),
  ]);
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    baseUrl: 'https://player.test/',
    raptorq: { wasm: fec.module },
  });
  await session.start();
  gateway.deliver();
  assert.deepEqual([...new Uint8Array(await (await session.fetch('https://player.test/live/recovered.m4s')).arrayBuffer())], [...recoveredBytes]);
  assert.deepEqual([...fec.decoders[0].oti], [0, 0, 0, 0, 4, 0, 0, 4, 1, 0, 1, 1]);
  await session.stop();
});

test('rejects malformed symbols and frees bounded objects on eviction and stop', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  route.setPackets([packet({ symbol: new Uint8Array() })]);
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    raptorq: { wasm: fec.module, maxObjects: 1 },
  });
  await session.start();
  gateway.deliver();
  assert.equal(fec.decoders.length, 0);

  route.setPackets([packet({ toi: 1n }), packet({ toi: 2n })]);
  gateway.deliver();
  assert.equal(fec.decoders.length, 2);
  assert.equal(fec.freeCount, 1);
  await session.stop();
  assert.equal(fec.freeCount, 2);
});

test('rejects a zero RaptorQ source-block count instead of coercing it to one', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  route.setPackets([packet({ numSrcBlks: 0 })]);
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    raptorq: { wasm: fec.module },
  });
  await session.start();
  gateway.deliver();
  assert.equal(fec.decoders.length, 0);
  assert.equal(session.size, 0);
  await session.stop();
});

test('rejects an out-of-range RaptorQ source block number', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  route.setPackets([packet({ sbn: 256 })]);
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    raptorq: { wasm: fec.module },
  });
  await session.start();
  gateway.deliver();
  assert.equal(fec.decoders.length, 0);
  await session.stop();
});

test('supports multi-block geometry and a partial final object', async () => {
  const route = routeFixture();
  const gateway = gatewayFixture();
  const fec = fakeRaptorQModule();
  const data = Uint8Array.of(5, 6, 7, 8, 9, 10);
  route.setPackets([
    packet({ toi: 9n, sbn: 0, esi: 0, transferLength: data.length, symbolSize: 4, maxSbLen: 1, numSrcBlks: 2, symAlignParam: 1, contentLocation: 'live/partial.m4s' }),
    packet({ toi: 9n, sbn: 0, esi: 1, transferLength: data.length, symbolSize: 4, maxSbLen: 1, numSrcBlks: 2, symAlignParam: 1, contentLocation: 'live/partial.m4s' }),
    packet({ toi: 9n, sbn: 1, esi: 1, transferLength: data.length, symbolSize: 4, maxSbLen: 1, numSrcBlks: 2, symAlignParam: 1, contentLocation: 'live/partial.m4s' }),
  ]);
  const session = createRouteMabrSession({
    gateway: gateway.gateway,
    wasm: { exports: route.exports },
    group: '239.21.4.1',
    port: 5004,
    baseUrl: 'https://player.test/',
    raptorq: { wasm: fec.module },
  });
  await session.start();
  gateway.deliver();
  assert.deepEqual([...new Uint8Array(await (await session.fetch('https://player.test/live/partial.m4s')).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...fec.decoders[0].oti], [0, 0, 0, 0, 4, 0, 0, 4, 1, 0, 1, 1]);
  assert.deepEqual([...fec.decoders[1].oti], [0, 0, 0, 0, 4, 0, 0, 4, 1, 0, 1, 1]);
  await session.stop();
});
