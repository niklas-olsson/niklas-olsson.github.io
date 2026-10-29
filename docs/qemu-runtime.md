# Experimental x86_64 runtime

Terrarium's `alpine-x86_64` profile uses QEMU system emulation compiled to WebAssembly. It has a real x86_64 CPU, Linux kernel and Alpine userspace. The page API, console, init scripts and machine lifecycle use the same contracts as the existing runtimes.

The x86_64 backend provides independent shells, framed agent commands, init scripts, VM checkpoints, paused quarantine restores, durable data-volume attachments and read-only logical evidence views. The Field guide and profile registry describe the capabilities actually exposed by the application. Machine settings provide fixed CPU/RAM presets and verified custom boot images. See [machine settings](machine-settings.md) for their contracts and checkpoint limits. Kubernetes and a symbolic debugger are not supplied.

New machine definitions support the fixed Small, Worker and Server presets. Worker uses the owned small-runtime module with 1,024 MiB guest RAM; Server uses its distinct split-memory module with two CPUs, 2,048 MiB guest RAM and a 3,584 MiB Wasm reservation. Custom images must satisfy the fixed four-UART boot ABI and content-addressed manifest. Owned bundle paths are local to the application and every registered artifact must be present for a build. Historical checkpoint identities remain separate.

## Historical runtime and assets

| Property | Value |
| --- | --- |
| Profile ID | `alpine-x86_64` |
| Emulator | QEMU 8.2.0, experimental Wasm build |
| Machine | PC, one virtual CPU, TCG software emulation |
| Architecture | x86_64 |
| Kernel | Linux 6.12.43-0-virt |
| Userspace | Alpine Linux 3.21.4 with OpenRC |
| Guest RAM | 512 MiB |
| Wasm shared-memory reservation | 2,300 MiB per running instance, including guest RAM |
| Consoles | Dedicated agent channel on `ttyS0`; independent shells on `ttyS1`, `ttyS2` and `ttyS3` |
| Root | 150 MiB ext4 base with a temporary writable overlay |
| Boot asset download | 145,490,481 bytes, about 145.5 MB / 138.75 MiB |

The memory reservation is not a measurement of resident browser memory. The browser also needs memory for the compressed image, compiled Wasm/TCG code, worker state and application. A machine definition allocates no emulator until Boot, and idle definitions remain uncapped. The admission policy permits at most two active/loading QEMU runtimes and accounts for 4,600 MiB of Wasm reservation. Paused machines retain their lease. Teardown releases it after the worker and storage-owner lifecycle end. This policy is a bound on admitted reservations, not a claim that every host can run two guests. Legacy backends do not consume this QEMU budget.

For the historical profile, the executable module, Wasm binary, kernel, initramfs, firmware and compressed root are fetched directly from the immutable upstream artifact commit `b7c549b5e6f4c376f76483a03e983214421434ad`. Every download must match its exact size and SHA-256 before the worker starts. Fetch omits credentials and referrer. A failed or changed download is rejected before execution.

The static site contains the MIT Emscripten pthread loader with documented comment cleanup and URL-resolution adaptation, application-owned adapters and a data-only package index. Historical upstream executable/guest bytes remain remote. The static site additionally includes five owned executable bundles and the shared Alpine 3.21.4/Linux 6.12.38-0-virt guest. Their complete neutral reconstruction kit and same-distribution source companion are described in [runtime sources](runtime-sources.md). The public source manifest identifies its stable GitHub Releases download URL; verify size, SHA-256 and closed membership after retrieval. See [the machine-readable provenance](../public/runtime/qemu/provenance.json), [the asset pins](../src/lib/qemu-assets.ts) and [third-party notices](../THIRD_PARTY_NOTICES.md).

The historical artifact repository identifies its accepted bytes but does not attest the exact QEMU source commit that built them. Linked upstream recipes are useful build references, not a claim of a reproducible binary rebuild. Alpine's installed APK database retains per-package versions, license identifiers and source-recipe commits at `/lib/apk/db/installed`.

## Browser and static hosting

QEMU's pthreads require `SharedArrayBuffer` and `crossOriginIsolated`. The existing v86 and TinyEMU profiles do not require them. HTTPS or localhost is required for image integrity checks and the service worker.

On a host that supports response headers, use `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` consistently for the document and workers. On a static host, **Workspace & storage → Enable x86_64 & reload** installs Terrarium's scoped isolation helper, prepares the workspace for reload, and reloads only after preparation succeeds.

The helper handles only same-origin GET document/worker responses inside this application's directory. It preserves response status, refuses opaque or redirected responses, and adds the two isolation headers. It does not cache files, proxy guest traffic, rewrite remote URLs, or trigger an automatic reload. Registration refuses a conflicting service worker instead of replacing another application. Relative scopes support a GitHub Pages repository subpath.

An embedded page also depends on the parent page's isolation policy. Open the Site in its own tab when the setup panel requests it. A host policy, browser restriction, authentication redirect or conflicting service worker can still prevent isolation. A successful Node kernel test does not validate browser headers or rendered UI; the exact verification scope is recorded in [validation](validation.md).

## Boot and command transport

The worker imports only the hash-verified upstream JavaScript module. It provides the package files from verified buffers through Emscripten's filesystem. The root package uses its pinned LZ4 index; downloaded preload scripts are not executed.

A bounded concatenated `newc` archive replaces `/init` in the verified initramfs. It mounts the immutable root under a temporary writable overlay, loads the required virtual disk/network modules and hands control to Alpine's init. It removes only exact upstream demonstration assumptions: the known external proxy profile, the obsolete `/boot` UUID entry and known demonstration networking runlevel links. User-edited alternatives are preserved by the cleanup routine.

After the root shell appears, the runtime configures the control TTY before the first command frame saves its settings. This preserves disabled software flow control across the wrapper's final TTY restore. It then mounts sysfs, configures the assigned network address, establishes the framed command channel and starts three PID-1-supervised shells. It waits for all three actual shell prompts, locates configured data/evidence devices by their stable sysfs serials, mounts them, runs the configured init script, and then records guest prerequisite observations. Boot resolves only after those steps complete. Init runs once on a fresh boot and reports the actual exit code. Pause/resume and checkpoint restore do not rerun it. All asynchronous startup work remains bound to the captured worker/generation; cancelling a boot cannot send stale setup commands to a replacement VM.

Each serial channel has independent bounded input/output queues and transcript listeners. Interactive shells retain their own controlling terminal, process group, working directory, environment and job-control state. The agent uses a separate channel, so it can execute while an interactive shell is active. Resizing updates the selected TTY and its saved size for respawn. The page API returns structured command output and observed exit status. A command's output is separate from the return value of JavaScript `console.log`.

## Execution control and networking

Pause and resume use a private HMP character-device pipe in the worker's filesystem. Commands are serialized and bounded; each waits for the monitor prompt. After `stop` or `cont`, `info status` must report the expected execution state. A deadline closes the monitor, so a late reply cannot satisfy a later request. Worker messages retain separate matching request IDs. The UI does not mark a guest paused merely because a worker timer stopped.

The pinned QEMU build stalled during the QMP monitor's extra I/O-thread path. Private HMP stays on the main loop and passed actual stop/status/continue plus a post-resume guest command. The guest console is not multiplexed with the monitor. The single-CPU profile uses `noapic clocksource=tsc` to avoid its observed IO-APIC timer-calibration failure. These are compatibility choices for this experimental build, not broad hardware-emulation guarantees.

The emulator's socket API is replaced inside its worker by an in-memory Ethernet endpoint. It accepts only the configured internal socket address. No QEMU socket opens a native WebSocket. Guest packets pass through Terrarium's `NetworkPort`, which owns VPC routing, policy, capture, isolation and optional World transport. Disabling the carrier invalidates queued deliveries. The private monitor does not use this network path.

Stop/delete terminates QEMU's pthreads and the owning worker and detaches its network port. Old worker events and late network attachments are invalidated. The runtime's shared destruction promise prevents a new boot from overlapping teardown. **Cancel boot**, including `vm.cancelBoot()`, uses the workspace owner to cancel loading/startup and release its resources. A cloud start operation can unwind after cancellation; a queued delete retains the cloud resource lock until then. Boot timeout, failed integrity, worker failure and unacknowledged control requests fail closed.

## Durability and inspection

The saved machine definition, disk attachments and init script survive refresh through the workspace manifest. Live CPU/RAM and the temporary writable root do not automatically survive. **Save a VM checkpoint before stop, reset or refresh to preserve the root and live state.** A fresh boot starts from the pinned base image and reruns init; an explicit checkpoint restore rolls back to its preserved state.

### VM checkpoints

The worker pauses the actual CPU, records its private-monitor register observations, and temporarily attaches a private qcow2 backend to store QEMU's `savevm terrarium` state. This backend is not a guest-visible data disk. It is detached before guest execution continues. Keeping a writable qcow2 backend open during normal execution exposed stalls in the pinned Wasm build, so the state backend exists only during paused save/load operations.

The portable `TRMQEMU1` container records the exact runtime/hardware profile, four UARTs, MAC address, guest/emulator asset hashes, state-file byte count/digest and capture-time registers. Its bounded parser rejects incompatible hardware, external backing files, unexpected qcow2 features, malformed tables and altered payloads before an emulator sees them. The payload limit is 768 MiB, with up to 16 KiB metadata; this is not an eager allocation. Existing v86 checkpoints retain their separate 256 MiB format limit. Neither format validation nor hashing establishes that a hostile guest state is safe for the emulator.

A cold restore starts QEMU with `-S`, loads the preserved state and confirms that execution remains paused. No login input, guest setup, capability probe or init script runs during a passive restore. Explicit resume reassigns the current virtual-network configuration and observes guest capabilities, while preserving the saved shell processes and avoiding init. Quarantined clones retain the host's irreversible peer/World gate throughout this process.

The x86_64 inspector displays register observations captured by the private monitor while paused, using exact hexadecimal strings for 64-bit values. It labels them separately from v86's passive decoding of serialized CPU fields. The recorded observations are not independently rederived from the qcow2 memory payload.

### Durable disks and evidence

QEMU exposes two data slots through real VirtIO block devices. Startup locates them by stable serial numbers and mounts their ext2 filesystems at `/mnt/volumes/disk0` and `/mnt/volumes/disk1` before init. The existing volume store owns browser persistence, exclusive/shared attachment locks, revisions, snapshots and clones. A bounded 64 KiB shared-memory mailbox connects synchronous emulator file writes to asynchronous host IndexedDB transactions. The worker waits for the committed host result; the browser UI thread does not block on Atomics. Read-only writes are rejected by the host as well as the guest device. See [volumes](volumes.md).

Orderly Stop/Delete/Reset/reload sync and unmount writable data disks before teardown. Busy mounts refuse the action and receive an attempted remount repair. Cancellation during startup and forced teardown wait for already submitted host writes and preserve committed disk bytes; they cannot recover data still cached only inside the guest or make a failed storage transaction durable. A storage failure remains visible and is reported by the next explicit teardown attempt; it cannot silently become a successful deletion.

Logical file acquisition is available only from a running, host-quarantined machine. Bounded serial/base64 transfers preserve binary bytes under the same limits as the existing evidence format: 32 files, 1 MiB per file, 8 MiB total. Capture remains guest-assisted; compromised guest commands can lie. The independent analyst receives a generated 32 MiB ext2 view containing `manifest.json` and `files/`, mounted at `/mnt/evidence`. The host rejects file writes, resize, allocation and writable mappings, independently of the guest's mount flags. Acquisition does not change the preserved source checkpoint.

VM checkpoint operations reject any configured external data disk or evidence attachment. Those resources have independent lifecycles and are not included in the VM state container. Data-volume snapshots and exported evidence archives remain separate preservation records.

The guest prerequisite panel reports the architecture, kernel, visible memory, online CPU count, mounted cgroup mode/controllers, namespace entries, overlay support and the presence of `containerd`, `runc`, `k3s`, `kubectl`, `crictl` and `ctr`. These are guest-reported observations taken after the configured init script, not authenticated host facts. They can become stale after guest changes and do not prove container execution, pod networking, Services, durable cluster restart or HA failover.

## Reproduce the integration checks

```sh
npm ci
npm run runtime:prepare
npm test
npm run test:qemu
npm run test:qemu-storage
npm run test:qemu-network
```

Maintainers can regenerate the data-only package index from locally downloaded, hash-verified upstream `load-*.js` and `load-*.data` pairs:

```sh
node scripts/extract-qemu-packages.mjs /path/to/pinned/assets /path/to/regenerated-packages.json
```

The extractor parses bounded JSON declarations, validates package ranges and every LZ4 index entry, and reproduces the committed index. It does not execute the preload scripts or perform a network download.

The real-kernel smoke uses the production `QemuRuntime`, command runner, shared browser-worker dispatcher and worker engine in an actual Node worker thread. This separation permits the host to commit IndexedDB transactions while the emulator waits on its mailbox. The Node adapter changes only host module/pthread loading and the logical-core fallback required by the test environment. Pinned artifacts are verified before execution; Browser bridge HTTP uses a deterministic network fixture. The storage smoke uses `fake-indexeddb` and Node Web Locks. The network smoke boots a real v86 peer and uses a certificate-verified, loopback-only Wisp fixture to check routed/direct traffic, VPC and port isolation, policies, DNS, World disconnection/reconnection and capture. These checks do not verify browser isolation headers, rendering, CORS, physical storage durability, browser eviction, upstream package repositories or a public relay. Consult [validation](validation.md) for the checks actually completed.

This release's implementation and verification work is confined to x86_64 parity. No other architecture is added.
