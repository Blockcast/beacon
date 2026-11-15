import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_BYTES_RETENTION_LIMIT } from '../../multicast-contract/src/gateway.ts';
import { createMulticastReceiverGateway, createRouteGateway } from './gateway.ts';

type Datagram = { data: Uint8Array };
type BytesEvent = CustomEvent<ArrayBuffer>;

const ssm = { group: '232.1.1.66', port: 8000, source: '192.0.2.10', consume: 'bytes' };
/** What RouteMabrSession sends for ingress 'amt' when it has no relay. */
const amt = { ...ssm, origin: 'amt', discovery: 'driad' };

/** Configs MulticastReceiver cannot serve. */
const unserved: Array<[string, object]> = [
  ['an explicit relay', { ...ssm, origin: 'amt', relay: 'relay.example.test', relayPort: 2268 }],
  ['an explicit relay beside a discovery', { ...amt, relay: 'relay.example.test' }],
  ["origin 'tuner'", { ...ssm, origin: 'tuner', standard: 'atsc3', protocol: 'route' }],
  ["origin 'amt' without a discovery", { ...ssm, origin: 'amt' }],
  ["origin 'amt' with a discovery the contract does not name", { ...amt, discovery: 'other' }],
  ['a missing source', { group: ssm.group, port: ssm.port, consume: 'bytes' }],
  ['an empty source', { ...ssm, source: '' }],
  ["a consume other than 'bytes'", { ...ssm, consume: 'frames' }],
];

/** A scope whose MulticastReceiver is a fake; `made` holds every instance. */
function fakeScope(construct?: () => void) {
  const made: FakeReceiver[] = [];
  class FakeReceiver {
    options: unknown;
    /** 'cancel' when the adapter stops its read, 'close' when it closes the receiver. */
    calls: string[] = [];
    controller!: ReadableStreamDefaultController<Datagram[]>;
    readonly readable = new ReadableStream<Datagram[]>({
      start: (controller) => { this.controller = controller; },
      cancel: () => { this.calls.push('cancel'); },
    });
    readonly #opened = Promise.withResolvers<{ readable: ReadableStream<Datagram[]> }>();
    readonly opened = this.#opened.promise;
    /** Settles `closed`: close() does, and a test does for a receiver that ends by itself. */
    readonly ending = Promise.withResolvers<{ reason: string }>();
    readonly closed = this.ending.promise;
    constructor(options: unknown) {
      construct?.();
      this.options = options;
      made.push(this);
    }
    open() { this.#opened.resolve({ readable: this.readable }); }
    decline(error: unknown) { this.#opened.reject(error); }
    // Ends no read by itself, so only the adapter's own cancel stops the read.
    async close() {
      this.calls.push('close');
      this.ending.resolve({ reason: 'test-close' });
    }
  }
  const scope: { MulticastReceiver: typeof FakeReceiver; multicast?: unknown } = { MulticastReceiver: FakeReceiver };
  return { scope, made };
}

/** A fake window.multicast: records each config and resolves to `subscription`. */
function fakeMulticast(subscription: object = { addEventListener() {}, removeEventListener() {}, async unsubscribe() {} }) {
  const configs: object[] = [];
  const multicast = { async subscribe(config: object) { configs.push(config); return subscription; } };
  return { multicast, configs, subscription };
}

/** One chunk as the receiver delivers it: every datagram is a view into one ArrayBuffer. */
function chunk(...payloads: number[][]): Datagram[] {
  const shared = Uint8Array.from(payloads.flat());
  let offset = 0;
  return payloads.map((payload) => {
    const data = shared.subarray(offset, offset + payload.length);
    offset += payload.length;
    return { data };
  });
}

/** Subscribe `config` on a fresh fake scope and let its receiver open. */
async function opened(config: object = ssm) {
  const { scope, made } = fakeScope();
  const pending = createMulticastReceiverGateway(scope)!.subscribe(config);
  made[0]!.open();
  return { subscription: await pending, receiver: made[0]! };
}

/** Let the adapter's pending reads and dispatches run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const bytesOf = (event: BytesEvent) => [...new Uint8Array(event.detail)];

/** The detail of every error event `subscription` dispatches from now on. */
function errorsOf(subscription: object) {
  const errors: Array<Error & { code?: string }> = [];
  (subscription as EventTarget).addEventListener('error', (event) => { errors.push((event as CustomEvent).detail); });
  return errors;
}

test('offers no MulticastReceiver gateway where the scope has no MulticastReceiver', () => {
  assert.equal(createMulticastReceiverGateway({}), undefined);
  assert.equal(createMulticastReceiverGateway({ multicast: fakeMulticast().multicast }), undefined);
  assert.equal(createMulticastReceiverGateway(), undefined);
});

for (const [name, config] of [
  ["origin 'ip-multicast'", { ...ssm, origin: 'ip-multicast' }],
  ['no origin', ssm],
  ["origin 'amt' with its discovery", amt],
] as Array<[string, object]>) {
  test(`opens a MulticastReceiver for ${name} with a source`, async () => {
    const { receiver } = await opened(config);
    assert.deepEqual(receiver.options, { groupAddress: '232.1.1.66', sourceAddress: '192.0.2.10', localPort: 8000 });
  });
}

for (const [name, config] of unserved) {
  test(`refuses ${name} with capability-unsupported and opens no receiver`, async () => {
    const { scope, made } = fakeScope();
    const pending = createMulticastReceiverGateway(scope)!.subscribe(config);
    assert.equal(made.length, 0);
    await assert.rejects(pending, { name: 'Error', code: 'capability-unsupported' });
  });
}

for (const [name, config] of [
  ['a missing consume', { group: ssm.group, port: ssm.port, source: ssm.source }],
  ['a missing config', undefined],
  ['a null config', null],
  ['a config that is not an object', 'bytes'],
] as Array<[string, unknown]>) {
  test(`keeps the contract code for ${name}: subscription-failed, not a missing capability`, async () => {
    const { scope, made } = fakeScope();
    const pending = createMulticastReceiverGateway(scope)!.subscribe(config as object);
    assert.equal(made.length, 0);
    await assert.rejects(pending, { name: 'Error', code: 'subscription-failed' });
  });
}

test('reports options the MulticastReceiver constructor throws on as capability-unsupported with the cause', async () => {
  const cause = new TypeError('bad group');
  const { scope } = fakeScope(() => { throw cause; });
  await assert.rejects(createMulticastReceiverGateway(scope)!.subscribe(ssm), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'capability-unsupported');
    assert.equal(error.cause, cause);
    return true;
  });
});

for (const name of ['NotAllowedError', 'NetworkError']) {
  test(`turns an opened rejection (${name}) into subscription-failed with the cause`, async () => {
    const { scope, made } = fakeScope();
    const pending = createMulticastReceiverGateway(scope)!.subscribe(ssm);
    const cause = new DOMException('declined', name);
    made[0]!.decline(cause);
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.name, 'Error');
      assert.equal(error.code, 'subscription-failed');
      assert.equal(error.cause, cause);
      return true;
    });
    // It never opened, so there is nothing to close.
    assert.deepEqual(made[0]!.calls, []);
  });
}

for (const [name, spoil] of [
  // Locked, so the adapter's getReader() throws.
  ['a stream it cannot read', (receiver) => { receiver.readable.getReader(); }],
  ['no `closed` to read', (receiver) => { (receiver as { closed: unknown }).closed = undefined; }],
] as Array<[string, (receiver: ReturnType<typeof fakeScope>['made'][number]) => void]>) {
  test(`closes a receiver that opened with ${name}, and rejects with subscription-failed`, async () => {
    const { scope, made } = fakeScope();
    const pending = createMulticastReceiverGateway(scope)!.subscribe(ssm);
    spoil(made[0]!);
    made[0]!.open();
    await assert.rejects(pending, (error: Error & { code?: string }) => {
      assert.equal(error.code, 'subscription-failed');
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
    assert.deepEqual(made[0]!.calls, ['close']);
  });
}

test('dispatches one bytes event per datagram, in order, each an ArrayBuffer copy of exactly its bytes', async () => {
  const { subscription, receiver } = await opened();
  const events: BytesEvent[] = [];
  const listener = (event: BytesEvent) => { events.push(event); };
  subscription.addEventListener('bytes', listener);
  const several = chunk([1, 2, 3], [4], [5, 6]);
  receiver.controller.enqueue(several);
  receiver.controller.enqueue(chunk([7]));
  await settle();
  assert.deepEqual(events.map(bytesOf), [[1, 2, 3], [4], [5, 6], [7]]);
  for (const event of events) {
    assert.ok(event instanceof CustomEvent);
    assert.equal(event.type, 'bytes');
    assert.ok(event.detail instanceof ArrayBuffer);
  }
  // The three views share one buffer; what was delivered must not.
  new Uint8Array(several[0]!.data.buffer).fill(9);
  assert.deepEqual(events.map(bytesOf), [[1, 2, 3], [4], [5, 6], [7]]);
  subscription.removeEventListener('bytes', listener);
  receiver.controller.enqueue(chunk([8]));
  await settle();
  assert.equal(events.length, 4);
});

test('passes over what is left of a chunk that is not datagrams and goes on with the next chunk', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { subscription, receiver } = await opened();
    const seen: number[][] = [];
    subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
    receiver.controller.enqueue([...chunk([1]), {} as Datagram, ...chunk([9])]);
    receiver.controller.enqueue({} as Datagram[]);
    receiver.controller.enqueue(chunk([2]));
    await settle();
    assert.deepEqual(seen, [[1], [2]]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('keeps bytes that arrive before the first bytes listener and delivers them in order when it attaches', async () => {
  const { subscription, receiver } = await opened();
  receiver.controller.enqueue(chunk([1], [2]));
  receiver.controller.enqueue(chunk([3]));
  await settle();
  // Only a bytes listener takes them.
  (subscription as unknown as EventTarget).addEventListener('state', () => {});
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
  assert.deepEqual(seen, [[1], [2], [3]]);
  // Only the first one: a second listener starts no second delivery.
  subscription.addEventListener('bytes', () => {});
  assert.deepEqual(seen, [[1], [2], [3]]);
  receiver.controller.enqueue(chunk([4]));
  await settle();
  assert.deepEqual(seen, [[1], [2], [3], [4]]);
});

test('stops delivering the datagrams of a chunk once the bytes listener has called unsubscribe()', async () => {
  const { subscription, receiver } = await opened();
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => {
    seen.push(bytesOf(event));
    void subscription.unsubscribe();
  });
  receiver.controller.enqueue(chunk([1], [2], [3]));
  await settle();
  assert.deepEqual(seen, [[1]]);
});

test('stops delivering the bytes it kept once the bytes listener has called unsubscribe()', async () => {
  const { subscription, receiver } = await opened();
  receiver.controller.enqueue(chunk([1], [2], [3]));
  await settle();
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => {
    seen.push(bytesOf(event));
    void subscription.unsubscribe();
  });
  assert.deepEqual(seen, [[1]]);
});

test('passes the listener options on: a bytes listener added with { once: true } gets one event', async () => {
  const { subscription, receiver } = await opened();
  const seen: number[][] = [];
  (subscription as unknown as EventTarget)
    .addEventListener('bytes', (event) => { seen.push(bytesOf(event as BytesEvent)); }, { once: true });
  receiver.controller.enqueue(chunk([1], [2]));
  await settle();
  assert.deepEqual(seen, [[1]]);
});

test('drops the bytes it kept when unsubscribe() comes before the first bytes listener', async () => {
  const { subscription, receiver } = await opened();
  receiver.controller.enqueue(chunk([1]));
  await settle();
  await subscription.unsubscribe();
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
  assert.deepEqual(seen, []);
});

for (const [count, kept] of [
  [EARLY_BYTES_RETENTION_LIMIT, EARLY_BYTES_RETENTION_LIMIT],
  [EARLY_BYTES_RETENTION_LIMIT + 1, 0],
  [EARLY_BYTES_RETENTION_LIMIT + 2, 0],
]) {
  test(`delivers ${kept} of ${count} early datagrams: the contract limit is ${EARLY_BYTES_RETENTION_LIMIT}, and past it the whole prefix is dropped`, async () => {
    const { subscription, receiver } = await opened();
    const payload = (index: number) => [index & 0xff, index >> 8];
    for (let first = 0; first < count; first += 64) {
      receiver.controller.enqueue(chunk(...Array.from({ length: Math.min(64, count - first) }, (_, index) => payload(first + index))));
    }
    await settle();
    const seen: number[][] = [];
    subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
    assert.deepEqual(seen, Array.from({ length: kept }, (_, index) => payload(index)));
    receiver.controller.enqueue(chunk([7, 7, 7]));
    await settle();
    assert.deepEqual(seen.slice(kept), [[7, 7, 7]]);
  });
}

test('unsubscribe() stops the read, then closes the receiver; a second call does neither again', async () => {
  const { subscription, receiver } = await opened();
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
  const errors = errorsOf(subscription);
  receiver.controller.enqueue(chunk([1]));
  await settle();
  // Read by the adapter, but not yet dispatched when unsubscribe() is called.
  receiver.controller.enqueue(chunk([2]));
  await Promise.all([subscription.unsubscribe(), subscription.unsubscribe()]);
  await subscription.unsubscribe();
  await settle();
  assert.deepEqual(seen, [[1]]);
  assert.deepEqual(receiver.calls, ['cancel', 'close']);
  // `closed` has resolved by now, and after an unsubscribe() that is no error.
  assert.deepEqual(errors, []);
});

test('an unsubscribe issued while the open is pending closes the receiver as soon as it opens', async () => {
  const { scope, made } = fakeScope();
  const pending = createMulticastReceiverGateway(scope)!.subscribe(ssm);
  // subscribe() hands out no subscription before the open settles, so a caller that stopped
  // meanwhile unsubscribes the moment it resolves, as RouteMabrSession does.
  const stopped = pending.then(async (subscription) => {
    await subscription.unsubscribe();
    return subscription;
  });
  made[0]!.controller.enqueue(chunk([1]));
  made[0]!.open();
  const subscription = await stopped;
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
  await settle();
  assert.deepEqual(seen, []);
  assert.deepEqual(made[0]!.calls, ['cancel', 'close']);
});

test('a receiver that ends without unsubscribe() dispatches one error event with the reason of `closed` as its cause', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { subscription, receiver } = await opened();
    const seen: number[][] = [];
    subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
    const errors = errorsOf(subscription);
    receiver.controller.enqueue(chunk([1]));
    await settle();
    // A receiver that ends by itself: its stream errors and `closed` resolves with the reason.
    receiver.controller.error(new DOMException('the receiver closed', 'NetworkError'));
    receiver.ending.resolve({ reason: 'test-ended' });
    await settle();
    assert.deepEqual(seen, [[1]]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0]!.code, 'subscription-failed');
    assert.equal(errors[0]!.cause, 'test-ended');
    await subscription.unsubscribe();
    await settle();
    assert.equal(errors.length, 1);
    assert.deepEqual(unhandled, []);
    // An errored stream has no read left to cancel.
    assert.deepEqual(receiver.calls, ['close']);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('keeps the error event for the first error listener when the receiver ends before one is added', async () => {
  const { scope, made } = fakeScope();
  const pending = createMulticastReceiverGateway(scope)!.subscribe(ssm);
  // It ends as it opens: before subscribe() has resolved, so before any listener can be added.
  made[0]!.open();
  made[0]!.controller.error(new DOMException('the receiver closed', 'NetworkError'));
  made[0]!.ending.resolve({ reason: 'test-ended' });
  const subscription = await pending;
  // Only an error listener takes it.
  subscription.addEventListener('bytes', () => {});
  await settle();
  const errors = errorsOf(subscription);
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'subscription-failed');
  assert.equal(errors[0]!.cause, 'test-ended');
  // Only the first one: a second listener starts no second delivery.
  const later = errorsOf(subscription);
  await settle();
  assert.deepEqual(later, []);
  assert.equal(errors.length, 1);
});

test('a `closed` that rejects is reported the same way, with the rejection as the cause', async () => {
  const { subscription, receiver } = await opened();
  const errors = errorsOf(subscription);
  const cause = new DOMException('the receiver is gone', 'NetworkError');
  receiver.ending.reject(cause);
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'subscription-failed');
  assert.equal(errors[0]!.cause, cause);
});

test('createRouteGateway serves a config the receiver serves from MulticastReceiver and names the user agent', async () => {
  const { scope, made } = fakeScope();
  const bridge = fakeMulticast();
  scope.multicast = bridge.multicast;
  const pending = createRouteGateway(scope).subscribe(ssm);
  made[0]!.open();
  const subscription = await pending;
  assert.equal(subscription.provider, 'user-agent');
  assert.throws(() => { (subscription as { provider: string }).provider = 'window.multicast'; }, TypeError);
  assert.equal(bridge.configs.length, 0);
  const seen: number[][] = [];
  subscription.addEventListener('bytes', (event) => seen.push(bytesOf(event)));
  made[0]!.controller.enqueue(chunk([1, 2]));
  await settle();
  assert.deepEqual(seen, [[1, 2]]);
  await subscription.unsubscribe();
  assert.deepEqual(made[0]!.calls, ['cancel', 'close']);
});

for (const [name, config] of unserved) {
  test(`createRouteGateway sends ${name} to window.multicast and opens no receiver`, async () => {
    const { scope, made } = fakeScope();
    const bridge = fakeMulticast();
    scope.multicast = bridge.multicast;
    const pending = createRouteGateway(scope).subscribe(config);
    assert.equal(made.length, 0);
    const subscription = await pending;
    // The bridge's own object, with nothing but `provider` added.
    assert.equal(subscription, bridge.subscription);
    assert.deepEqual(Object.keys(subscription), ['addEventListener', 'removeEventListener', 'unsubscribe', 'provider']);
    assert.equal(subscription.provider, 'window.multicast');
    assert.throws(() => { (subscription as { provider: string }).provider = 'user-agent'; }, TypeError);
    assert.equal(bridge.configs.length, 1);
    assert.equal(bridge.configs[0], config);
  });
}

test('createRouteGateway uses window.multicast where the scope has no MulticastReceiver', async () => {
  const bridge = fakeMulticast();
  const subscription = await createRouteGateway({ multicast: bridge.multicast }).subscribe(ssm);
  assert.equal(subscription, bridge.subscription);
  assert.equal(subscription.provider, 'window.multicast');
  assert.deepEqual(bridge.configs, [ssm]);
});

test('createRouteGateway sees a window.multicast that is installed after the gateway was made', async () => {
  const scope: { multicast?: unknown } = {};
  const gateway = createRouteGateway(scope);
  const bridge = fakeMulticast();
  scope.multicast = bridge.multicast;
  assert.equal((await gateway.subscribe(ssm)).provider, 'window.multicast');
});

test('createRouteGateway sees a window.multicast that is installed while the receiver is opening', async () => {
  const { scope, made } = fakeScope();
  const pending = createRouteGateway(scope).subscribe(ssm);
  const bridge = fakeMulticast();
  scope.multicast = bridge.multicast;
  made[0]!.decline(new DOMException('declined', 'NetworkError'));
  assert.equal((await pending).provider, 'window.multicast');
  assert.deepEqual(bridge.configs, [ssm]);
});

test('createRouteGateway subscribes once through window.multicast when the receiver does not open', async () => {
  const { scope, made } = fakeScope();
  const bridge = fakeMulticast();
  scope.multicast = bridge.multicast;
  const pending = createRouteGateway(scope).subscribe(ssm);
  made[0]!.decline(new DOMException('declined', 'NotAllowedError'));
  const subscription = await pending;
  assert.equal(subscription, bridge.subscription);
  assert.equal(subscription.provider, 'window.multicast');
  assert.equal(bridge.configs.length, 1);
  assert.equal(bridge.configs[0], ssm);
  assert.equal(made.length, 1);
});

test('createRouteGateway does not go back to the receiver when window.multicast rejects too', async () => {
  const { scope, made } = fakeScope();
  const failure = new Error('bridge is down');
  let calls = 0;
  scope.multicast = { async subscribe() { calls += 1; throw failure; } };
  const pending = createRouteGateway(scope).subscribe(ssm);
  made[0]!.decline(new DOMException('declined', 'NetworkError'));
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(made.length, 1);
});

test('createRouteGateway passes the receiver rejection on when no window.multicast is installed', async () => {
  const { scope, made } = fakeScope();
  const pending = createRouteGateway(scope).subscribe(ssm);
  const cause = new DOMException('declined', 'NotAllowedError');
  made[0]!.decline(cause);
  await assert.rejects(pending, (error: Error & { code?: string }) => {
    assert.equal(error.code, 'subscription-failed');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('createRouteGateway installed as window.multicast does not subscribe through itself', async () => {
  const { scope, made } = fakeScope();
  const gateway = createRouteGateway(scope);
  scope.multicast = gateway;
  const cause = new DOMException('declined', 'NetworkError');
  const rejected = assert.rejects(gateway.subscribe(ssm), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'subscription-failed');
    assert.equal(error.cause, cause);
    return true;
  });
  made[0]!.decline(cause);
  await settle();
  // A subscribe through itself would have constructed a second receiver.
  assert.equal(made.length, 1);
  await rejected;
});

test('createRouteGateway rejects with capability-unsupported when neither side can serve the config', async () => {
  await assert.rejects(createRouteGateway({}).subscribe(ssm), { name: 'Error', code: 'capability-unsupported' });
  await assert.rejects(createRouteGateway().subscribe(ssm), { name: 'Error', code: 'capability-unsupported' });
  // window.multicast without subscribe() is not installed.
  await assert.rejects(createRouteGateway({ multicast: {} }).subscribe(ssm), { name: 'Error', code: 'capability-unsupported' });
  const { scope, made } = fakeScope();
  for (const [, config] of unserved) {
    const pending = createRouteGateway(scope).subscribe(config);
    assert.equal(made.length, 0);
    await assert.rejects(pending, { name: 'Error', code: 'capability-unsupported' });
  }
});

for (const [name, returned] of [
  ['a frozen subscription', () => Object.freeze(recorder())],
  ['a subscription that already has a provider', () => Object.assign(recorder(), { provider: 'bridge' })],
] as Array<[string, () => ReturnType<typeof recorder>]>) {
  test(`createRouteGateway wraps ${name} and leaves the object window.multicast returned as it was`, async () => {
    const original = returned();
    const before = Object.getOwnPropertyDescriptors(original);
    const subscription = await createRouteGateway({ multicast: fakeMulticast(original).multicast }).subscribe(ssm);
    assert.notEqual(subscription, original);
    assert.equal(subscription.provider, 'window.multicast');
    assert.throws(() => { (subscription as { provider: string }).provider = 'user-agent'; }, TypeError);
    assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
    const listener = () => {};
    subscription.addEventListener('bytes', listener);
    subscription.removeEventListener('bytes', listener);
    assert.equal(await subscription.unsubscribe(), 'unsubscribed');
    assert.deepEqual(original.calls, [
      ['addEventListener', original, 'bytes', listener],
      ['removeEventListener', original, 'bytes', listener],
      ['unsubscribe', original],
    ]);
  });
}

/** A window.multicast subscription that records each call with its `this`. */
function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    addEventListener(this: unknown, ...args: unknown[]) { calls.push(['addEventListener', this, ...args]); },
    removeEventListener(this: unknown, ...args: unknown[]) { calls.push(['removeEventListener', this, ...args]); },
    async unsubscribe(this: unknown) { calls.push(['unsubscribe', this]); return 'unsubscribed'; },
  };
}
