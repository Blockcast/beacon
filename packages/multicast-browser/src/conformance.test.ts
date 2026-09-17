/**
 * Browser conformance: run the contract's own suite through the adapter.
 *
 * The point is the composition, not the suite. `runConformanceSuite` already
 * passes when handed the contract's `FakeMulticastProvider` directly — that is
 * checked inside the contract package. What is unchecked until here is the path a
 * real page takes: a provider surface installed on `window.multicast`, resolved
 * structurally by `getGateway`, wrapped by `createBrowserConformanceDriver`, and
 * only then driven. A resolution bug in the adapter (dropping a hook, losing the
 * provider as a method receiver, rejecting a valid surface) fails here and
 * nowhere else.
 *
 * `fake.gateway` rather than `fake` is installed as the global on purpose: in a
 * real realm `window.multicast` IS the gateway, and the driver control surface is
 * out of band. Installing the provider object itself would test a topology that
 * does not ship.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runConformanceSuite } from '../../multicast-contract/src/conformance.ts';
import { FakeMulticastProvider } from '../../multicast-contract/src/fake-gateway.ts';

import { createBrowserConformanceDriver, type BrowserScope } from './index.ts';

function pageRealmWith(fake: FakeMulticastProvider): BrowserScope {
	// Exactly what the extension's inject.ts and the bridge polyfill both do:
	// assign the gateway surface to the global and nothing else.
	return { multicast: fake.gateway } as BrowserScope;
}

describe('browser conformance', () => {
	test('a conformant provider stays conformant through the adapter', async () => {
		const fake = new FakeMulticastProvider();
		const driver = createBrowserConformanceDriver(pageRealmWith(fake), {
			deliverBytes: (config, payloads) => fake.deliverBytes(config, payloads),
			resolveTransport: (config, transport) => fake.resolveTransport(config, transport),
			forceState: (config, state) => fake.forceState(config, state),
			physicalJoinCount: (config) => fake.physicalJoinCount(config),
		});

		const report = await runConformanceSuite(driver);
		assert.equal(
			report.conformant,
			true,
			`adapter-driven suite not conformant: ${JSON.stringify(report.checks, null, 2)}`,
		);
		assert.equal(report.failed, 0);
		// Every check is driver-backed here, so none may be skipped: a silently
		// dropped hook would otherwise read as a pass.
		assert.equal(report.skipped, 0, 'a skipped check means the adapter dropped a driver hook');
	});

	test('a production provider skips the injection checks rather than failing them', async () => {
		// No page can inject bytes into a real multicast group, so a real provider
		// exposes no driver hooks. Those checks must be `skipped` — reporting them
		// as failures would make a healthy deployment look broken.
		const fake = new FakeMulticastProvider();
		const driver = createBrowserConformanceDriver(pageRealmWith(fake));
		const report = await runConformanceSuite(driver);
		assert.equal(report.failed, 0, JSON.stringify(report.checks, null, 2));
		assert.ok(report.skipped > 0);
	});
});
