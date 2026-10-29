# Validation

Use Node 24 and install the exact lockfile dependencies:

```sh
npm ci
npm run typecheck
npm test
node --test --test-concurrency=1 scripts/*.test.mjs scripts/browser/*.test.mjs
npm run build
```

The build verifies every registered QEMU bundle by exact size and SHA-256. Owned runtime modules, Wasm and guest packages use fixed application-local catalog paths and must accompany any deployment. Missing or changed bytes fail the build; the application does not substitute a historical runtime. The legacy upstream runtime remains registered for its original machines and checkpoints.

## Browser checks

Build the production application and the separate acceptance helper first:

```sh
npm run build
npm run test:browser:s2:helper
npx playwright install chromium --only-shell
npm run test:browser:s2:migrations
npm run test:browser:s2:quota
TERRARIUM_S2_PROFILE_DIR="$PWD/.cache/s2-browser-profiles/storage-check-1" npm run test:browser:s2:storage
npm run test:browser:s2:presets
TERRARIUM_S2_PROFILE_DIR="$PWD/.cache/s2-browser-profiles/persistence-check-1" npm run test:browser:s2:persistence
npm run test:browser:s2:ui
```

These modes run sequentially in actual Chromium against the built application. The storage helper invokes production IndexedDB and Web Locks APIs; it does not replace a guest. Migration cases cover historical schemas, corrupt inputs, ownership transfer and independent artifact preservation. Storage cases include sparse capacity, bounded caches/copies, streaming exports and native quota refusal. Guest modes exercise actual CPU/RAM presets, command execution and durable disks.

`npm run test:browser:s2:images` verifies and expands the committed compressed Orchard fixture into ignored cache output before testing. `TERRARIUM_S2_IMAGE` may identify a separately retained copy of the same exact fixture; an arbitrary image is not equivalent evidence. Browser reports default to ignored `.cache/test-results/`; set `TERRARIUM_BROWSER_REPORT` to retain them elsewhere. Persistent profiles must be dedicated to each test run; choose a new basename for each invocation because an existing directory is deliberately refused.

The runtime validation workflow runs script fixtures on pushes and pull requests. Expensive real-guest and browser checks are available through manual workflow dispatch. Guest tests fetch or copy only exact catalog-pinned assets; remote availability and a localhost run are distinct from production-origin validation.

## Verification boundaries

This is an experimental `0.8.0-dev.s2` prerelease. Source archive integrity, a successful static build, fixture results, real guest execution, independent runtime reproduction and production-origin acceptance are separate results. No v0.8.0 release qualification follows from catalog registration or archive recovery. Browser memory, storage eviction, abrupt page loss and cross-origin policies remain practical runtime constraints.
