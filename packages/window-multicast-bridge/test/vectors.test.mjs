import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// test/vectors/ holds copies of the cross-language contract vectors that the bridge servers
// (the IWA bridge and the native BCDS bridge) test against. Neither server lives in this repository,
// and the contract package carries no copy to compare with, so these pins are the drift guard here.
// A vector changes only in step with the servers; update its pin in the same change.
// packet-id-allow-list-v1.json's description is reworded from the servers' copy, whose text names
// private paths; its vectors are the servers' byte for byte, so its pin is not that file's digest.
const PINS = {
  'packet-id-allow-list-v1.json': '684e5f7e372bfca3b5766f566ff9513939dd427aa0e3b566f51d35706b33c5dd',
  'bridge-enrollment-v1.json': '7306554e36d6210de3f92df82cb15cccb755155c568631870ff0e34b77115d82',
};

for (const [name, sha256] of Object.entries(PINS)) {
  test(`contract vector ${name} matches its pin`, () => {
    const digest = createHash('sha256').update(readFileSync(new URL(`./vectors/${name}`, import.meta.url))).digest('hex');
    assert.equal(digest, sha256, `${name} changed: change it in step with the bridge servers, then update its pin`);
  });
}
