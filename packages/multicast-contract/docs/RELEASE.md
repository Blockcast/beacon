# Releasing `@blockcast/multicast-contract` and `@blockcast/multicast-browser`

Internal release procedure. This file is not packed (`files: ["dist"]`), so it
does not reach consumers — the consumer-facing policy lives in each README.

## Version policy

Both packages are at `1.0.0` and the v1 surface is frozen. Within v1:

- **Additive, ships as MINOR** — new `SubscriptionEventMap` keys, new optional
  `SubscribeConfig` members, new `MulticastErrorCode` members. The error-code set
  is explicitly **open**; consumers are told in the shipped `.d.ts` to carry a
  `default` branch and to treat an unrecognised code as a multicast error of an
  unknown kind rather than as "not ours".
- **Removing or retyping any member is MAJOR.** Removing a member of
  `TransportCapabilityReport` is the worked example: it was free before `1.0.0`
  and is a major bump after.

`@blockcast/multicast-browser` tracks the contract's major. It consumes the
contract **type-only** and declares no runtime dependency, so the two version
independently within a major.

## Publishing

Both packages build to `dist/` and declare no `prepack`/`prepare`, so **`npm pack`
builds nothing**. Build first or you will ship a tarball containing only
`package.json` and `README.md`.

```bash
cd packages/multicast-contract  && npm install --include=dev && npm run build
cd ../multicast-browser         && npm install --include=dev && npm run build
```

> In CI and in agent containers `NODE_ENV=production` is set, which makes npm
> omit `devDependencies` — `npm install` reports "up to date" and installs no
> `typescript`, so `npm run build` fails with `tsc: not found`. `--include=dev`
> is what makes the build step work there.

Then, from the repo root:

```bash
npm pack ./packages/multicast-contract  --pack-destination dist-artifacts
npm pack ./packages/multicast-browser   --pack-destination dist-artifacts
sha256sum dist-artifacts/*.tgz          # record these in the release record
```

`npm pack` output is byte-reproducible for a given tree (npm normalises entry
mtimes), so a recorded SHA-256 is a checkable claim about the source, not an
accident of when it was packed. Verify by packing twice before recording.

Publication itself runs through npm **Trusted Publishing (OIDC)** — the same
mechanism `Blockcast/libmmt` uses for `@blockcast/mmt-transport` in
`.github/workflows/publish-npm.yml`: a hosted runner, `permissions: id-token:
write`, and a trusted publisher registered on npmjs.com against the publishing
repository and workflow. **That registration is per-package and per-repository**;
it does not carry over from `libmmt` to this repository, and only an owner of the
`@blockcast` npm scope can create it.

## Verifying a release candidate

Run all five against the **packed tarball**, never the repo tree — the tarball is
the only surface on which "does this ship?" is decidable.

1. **No internal tracker keys.** `tar -xzf` the tarball and
   `grep -rnE 'BLO-[0-9]+'` the extraction ⇒ 0 hits. `removeComments` is unset,
   so every `//` and `/** */` reaches `dist/`, and npm packs `README.md` and
   `package.json` regardless of `files`. npm cannot re-publish a version, so a
   key that ships at `1.0.0` is unfixable.
2. **No private internals.** `grep -rniE 'libmmt|harbor\.|\.ts\.net'` ⇒ only
   prose asserting their absence. No `.wasm`/`.so`/`.node` files.
3. **No dependency edge.** Neither `package.json` declares `dependencies`,
   `peerDependencies`, or `optionalDependencies`, and neither ships a
   `workspace:*` specifier. A runtime edge here would drag the unpublished
   workspace into a public surface.
4. **Cold install.** In an empty directory with no workspace and no private
   checkout, `npm install <both tarballs>` then run the conformance suite from
   the installed package — `runConformanceSuite(new FakeMulticastProvider())`
   must report `conformant=true` with zero skipped. A skipped check is not a pass.
5. **Co-install type check.** In a scratch project, install the contract tarball
   **and** `@blockcast/mmt-transport`, add one first-party `.ts` file importing
   from each, and run `tsc --noEmit` twice — `skipLibCheck: true` and `false`.
   Record both. The expected results and the reason they differ are documented in
   the contract's README under "Installing alongside `@blockcast/mmt-transport`";
   a non-clean result there is a documentation obligation, not a release stop,
   unless the collision reaches a consumer transitively.

Record, alongside the artifact SHA-256s, the **`libmmt` submodule SHA of the tree
the release was cut from**. Every crate in `libmmt` — `mmt-ffi`, `mmt-core`,
`mmt-wasm`, `mmt-fec`, `mmt-container` — reads `version = "0.1.0"` and is not
bumped, so the crate semver carries no information and the gitlink SHA is the
only identifier of the compiled ABI. Neither published package contains any
`libmmt` code; the pin identifies the **provider** side these consumers talk to.

## Rollback

npm forbids re-publishing a version, so rollback is always **forward to a new
version** — never a mutation of a published one.

**A bad `1.0.x` is live.**

1. Move the `latest` tag back to the last good version. This is the fast
   mitigation and it is reversible:
   `npm dist-tag add @blockcast/multicast-contract@<last-good> latest`.
   New installs resolve to `<last-good>` immediately; existing lockfiles are
   untouched, which is why step 3 still matters.
2. Deprecate the bad version so it is visible at install time:
   `npm deprecate @blockcast/multicast-contract@<bad> "<reason, and the version to use instead>"`.
3. Fix forward and publish `1.0.<x+1>`, then move `latest` to it.

Do **not** `npm unpublish`. Beyond the 72-hour window it is refused, and inside
it, it breaks every lockfile already pinning that version — strictly worse than a
deprecation for consumers who have already installed.

**Something private shipped in a tarball.** Unpublishing does not undo
disclosure: the tarball is already mirrored. Treat it as an incident — rotate
whatever leaked — then publish a clean version, deprecate the bad one, and move
`latest`. Verification 1 and 2 above exist to make this case not happen, because
it is the one that cannot be rolled back.

**The release is not yet published.** Nothing to roll back: drop the tag and the
artifacts. This is the cheapest state to catch a problem in, which is why the
five verification steps run against the candidate tarball rather than after
publication.
