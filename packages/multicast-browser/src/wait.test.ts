import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GATEWAY_READY_EVENT, waitForGateway, type GatewayWaitScope } from './index.ts';

function fakeProviderSurface() {
	return {
		async subscribe() {
			throw new Error('not used');
		},
		async capabilities() {
			return { iwaVersion: 'test', consumeModes: ['bytes'], transports: {}, plugins: [] };
		},
	};
}

/** A mutable scope with a real EventTarget, and a count of live listeners. */
function eventScope() {
	const target = new EventTarget();
	let listeners = 0;
	const scope: GatewayWaitScope & { multicast?: unknown } = {
		addEventListener(type, listener) {
			listeners++;
			target.addEventListener(type, listener);
		},
		removeEventListener(type, listener) {
			listeners--;
			target.removeEventListener(type, listener);
		},
	};
	return {
		scope,
		install(value: unknown) {
			(scope as { multicast?: unknown }).multicast = value;
		},
		ready() {
			target.dispatchEvent(new Event(GATEWAY_READY_EVENT));
		},
		get listeners() {
			return listeners;
		},
	};
}

describe('waitForGateway', () => {
	test('resolves an already-installed provider without waiting', async () => {
		const provider = fakeProviderSurface();
		const gateway = await waitForGateway({ timeoutMs: 0 }, { multicast: provider });
		assert.equal(gateway, provider);
	});

	test('timeoutMs 0 resolves null when nothing is installed', async () => {
		assert.equal(await waitForGateway({ timeoutMs: 0 }, {}), null);
	});

	test('resolves on the ready event, before any poll', async () => {
		const s = eventScope();
		const provider = fakeProviderSurface();
		const started = Date.now();
		const wait = waitForGateway({ timeoutMs: 2_000, pollMs: 60_000 }, s.scope);
		s.install(provider);
		s.ready();
		assert.equal(await wait, provider);
		assert.ok(Date.now() - started < 1_000, 'the event, not the poll, resolved the wait');
		assert.equal(s.listeners, 0, 'the ready listener is removed');
	});

	test('a ready event before a usable surface exists does not resolve the wait', async () => {
		const s = eventScope();
		const wait = waitForGateway({ timeoutMs: 50, pollMs: 60_000 }, s.scope);
		s.install({ subscribe() {} }); // no capabilities(): not a gateway
		s.ready();
		assert.equal(await wait, null);
		assert.equal(s.listeners, 0);
	});

	test('a provider that installs without the event is found by polling', async () => {
		const provider = fakeProviderSurface();
		const scope: { multicast?: unknown } = {};
		const started = Date.now();
		const wait = waitForGateway({ timeoutMs: 2_000, pollMs: 10 }, scope);
		setTimeout(() => {
			scope.multicast = provider;
		}, 20);
		assert.equal(await wait, provider);
		assert.ok(Date.now() - started < 1_000, 'a poll, not the deadline, resolved the wait');
	});

	test('resolves null at the deadline when no provider arrives', async () => {
		const s = eventScope();
		assert.equal(await waitForGateway({ timeoutMs: 30, pollMs: 10 }, s.scope), null);
		assert.equal(s.listeners, 0, 'the ready listener is removed on timeout');
	});

	test('abort resolves null at once and removes the listener', async () => {
		const s = eventScope();
		const controller = new AbortController();
		const started = Date.now();
		const wait = waitForGateway({ timeoutMs: 2_000, pollMs: 60_000, signal: controller.signal }, s.scope);
		controller.abort();
		assert.equal(await wait, null);
		assert.ok(Date.now() - started < 1_000);
		assert.equal(s.listeners, 0);
		// A provider arriving after the abort does not reach a settled wait.
		s.install(fakeProviderSurface());
		s.ready();
	});

	test('an already-aborted signal resolves null', async () => {
		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		assert.equal(await waitForGateway({ timeoutMs: 2_000, signal: controller.signal }, {}), null);
		assert.ok(Date.now() - started < 1_000);
	});
});
