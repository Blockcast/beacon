/**
 * Where a ROUTE session takes its datagrams from: the user agent's own
 * `MulticastReceiver` where the browser has one, `window.multicast` otherwise.
 */

import type { RouteGateway } from './route.ts';

/** The side that served a subscription made through `createRouteGateway`. */
export type RouteProvider = 'user-agent' | 'window.multicast';

type RouteSubscription = Awaited<ReturnType<RouteGateway['subscribe']>>;
type Datagrams = Array<{ data: Uint8Array }>;

/** The fields of a `window.multicast` subscribe config that are read here. */
interface Config {
  group: string;
  port: number;
  source?: string;
  consume?: string;
  origin?: string;
  discovery?: string;
  relay?: string;
}

/** The user agent's receiver: source-specific, read as chunks of datagrams. */
interface MulticastReceiver {
  readonly opened: Promise<{ readable: ReadableStream<Datagrams> }>;
  readonly closed: Promise<{ reason: string }>;
  close(): Promise<void>;
}

type MulticastReceiverConstructor = new (options: {
  groupAddress: string;
  sourceAddress: string;
  localPort: number;
}) => MulticastReceiver;

// The value of EARLY_BYTES_RETENTION_LIMIT in @blockcast/multicast-contract,
// which this package does not depend on.
const EARLY_BYTES_RETENTION_LIMIT = 128;

function fail(code: 'capability-unsupported' | 'subscription-failed', message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** The error for a `config` that `MulticastReceiver` cannot serve; undefined when it can. */
function refusal(config: Config | null | undefined): Error | undefined {
  // As the contract rules: a missing config or consume is a bad request, an unknown consume a missing capability.
  if (config?.consume === undefined) return fail('subscription-failed', "subscribe() requires a config with consume: 'bytes'");
  const { consume, origin = 'ip-multicast', discovery, relay, source } = config;
  const unsupported =
    consume !== 'bytes' ? `MulticastReceiver delivers bytes, not consume: '${String(consume)}'`
    : relay !== undefined ? 'MulticastReceiver takes no relay'
    : origin !== 'ip-multicast' && !(origin === 'amt' && discovery === 'driad')
      ? `MulticastReceiver does not serve ${JSON.stringify({ origin, discovery })}`
    : !source ? 'MulticastReceiver needs a source'
    : undefined;
  return unsupported === undefined ? undefined : fail('capability-unsupported', unsupported);
}

/**
 * A gateway over `scope.MulticastReceiver`, or undefined when the scope has
 * none. A config without `consume`, or no config, is refused with `code:
 * 'subscription-failed'`; any other config it cannot serve with `code:
 * 'capability-unsupported'`. The README lists which configs it serves.
 * A subscription dispatches `bytes` events, and one `error` event if the
 * receiver's `closed` settles before `unsubscribe()` is called; that event is
 * kept for the first `error` listener.
 */
export function createMulticastReceiverGateway(scope: object = globalThis): RouteGateway | undefined {
  const Receiver = (scope as { MulticastReceiver?: MulticastReceiverConstructor }).MulticastReceiver;
  if (typeof Receiver !== 'function') return undefined;
  return {
    async subscribe(config: object) {
      const refused = refusal(config as Config);
      if (refused) throw refused;
      const { group, port, source } = config as Config;
      let receiver: MulticastReceiver;
      try {
        receiver = new Receiver({ groupAddress: group, sourceAddress: source!, localPort: port });
      } catch (cause) {
        throw fail('capability-unsupported', 'MulticastReceiver rejected its options', cause);
      }
      const events = new EventTarget();
      // Bytes kept for the first 'bytes' listener; undefined once bytes are dispatched as they come.
      let early: ArrayBuffer[] | undefined = [];
      let closing: Promise<void> | undefined;
      // Resolved by the first 'error' listener: the error event waits for it, so that an end right after the open is not missed.
      let heard = () => {};
      const listening = new Promise<void>((resolve) => { heard = resolve; });
      let reader: ReadableStreamDefaultReader<Datagrams>;
      let open = false;
      try {
        const { readable } = await receiver.opened;
        open = true;
        reader = readable.getReader();
        // `closed` settling before any unsubscribe() is a receiver that ended by itself: the page is told why.
        void receiver.closed.then((info) => info?.reason, (error) => error).then(async (cause) => {
          await listening;
          if (!closing) events.dispatchEvent(new CustomEvent('error', { detail: fail('subscription-failed', 'MulticastReceiver closed', cause) }));
        });
      } catch (cause) {
        // Open, but without a stream or a `closed` to read: closed, so that no receiver is left open behind the rejection.
        if (open) await receiver.close().catch(() => {});
        throw fail('subscription-failed', 'MulticastReceiver open failed', cause);
      }
      void (async () => {
        for (;;) {
          // read() rejects once the receiver has closed by itself: nothing is left to deliver.
          const { value, done } = await reader.read()
            .catch((): ReadableStreamReadResult<Datagrams> => ({ done: true, value: undefined }));
          if (done) return;
          try {
            for (const { data } of value) {
              if (closing) return;
              // A copy: every datagram of a chunk is a view into the chunk's one buffer.
              const bytes = data.slice().buffer;
              if (!early) events.dispatchEvent(new CustomEvent('bytes', { detail: bytes }));
              // Past the limit the whole prefix goes: delivering part of it would hide the gap.
              else if (early.push(bytes) > EARLY_BYTES_RETENTION_LIMIT) early = undefined;
            }
          } catch {
            // Not a chunk of datagrams: what is left of it is passed over, and the read goes on.
          }
        }
      })();
      return {
        addEventListener(type: string, listener: (event: CustomEvent<ArrayBuffer>) => void, options?: AddEventListenerOptions | boolean) {
          events.addEventListener(type, listener as EventListener, options);
          if (type === 'error') heard();
          if (type !== 'bytes') return;
          const kept = early ?? [];
          early = undefined;
          for (const bytes of kept) {
            // The listener may unsubscribe on one of them: nothing after that.
            if (closing) return;
            events.dispatchEvent(new CustomEvent('bytes', { detail: bytes }));
          }
        },
        removeEventListener: events.removeEventListener.bind(events) as RouteSubscription['removeEventListener'],
        unsubscribe() {
          return closing ??= reader.cancel().catch(() => {}).then(() => receiver.close());
        },
      };
    },
  };
}

/** Name the side that served `subscription`: on the object itself, or on a wrapper when it cannot take the property. */
function withProvider(subscription: RouteSubscription, provider: RouteProvider) {
  const target = Object.isExtensible(subscription) && !('provider' in subscription) ? subscription : {
    addEventListener: subscription.addEventListener.bind(subscription),
    removeEventListener: subscription.removeEventListener.bind(subscription),
    unsubscribe: subscription.unsubscribe.bind(subscription),
  };
  return Object.defineProperty(target, 'provider', { value: provider, enumerable: true }) as
    RouteSubscription & { readonly provider: RouteProvider };
}

/**
 * The gateway to hand to `RouteMabrSession`. Each subscribe goes to
 * `scope.MulticastReceiver` when the scope has one and it serves the config.
 * It goes to `scope.multicast` otherwise, and once when the receiver rejects.
 * The subscription's `provider` names the side that served it.
 */
export function createRouteGateway(scope: object = globalThis): {
  subscribe(config: object): Promise<RouteSubscription & { readonly provider: RouteProvider }>;
} {
  const receiver = createMulticastReceiverGateway(scope);
  const gateway: ReturnType<typeof createRouteGateway> = {
    async subscribe(config: object) {
      // The receiver gateway refuses what it does not serve, so every rejection takes the same way out.
      let rejection: unknown;
      if (receiver) {
        try {
          return withProvider(await receiver.subscribe(config), 'user-agent');
        } catch (error) {
          rejection = error;
        }
      }
      // Read only now: a bridge may install window.multicast while the receiver is still opening.
      const multicast = (scope as { multicast?: RouteGateway }).multicast;
      // This gateway installed as window.multicast is no second side: it would subscribe through itself.
      if (multicast === gateway || typeof multicast?.subscribe !== 'function') {
        throw rejection ?? fail('capability-unsupported', 'neither MulticastReceiver nor window.multicast is installed');
      }
      return withProvider(await multicast.subscribe(config), 'window.multicast');
    },
  };
  return gateway;
}
