# Terrarium

Live at [niklas-olsson.github.io](https://niklas-olsson.github.io/).

**Small worlds. Real possibilities.**

A browser-local playground for real Linux machines, independent terminal sessions, small networks, and cooperative AI-agent tasks. The visitor's browser runs the kernels. The application is static and can be hosted on GitHub Pages.

**Status: experimental prerelease (0.8.0-dev.s2).** Five profiles cover 32-bit x86, RISC-V64, and experimental x86_64 system emulation. The x86_64 profile uses QEMU with Alpine Linux and a Linux 6.12 kernel. The supplied images do not contain Kubernetes or a container stack.

Machine settings add fixed x86_64 hardware presets, verified custom images, and sparse data disks through 8 GiB. See [machine settings](docs/machine-settings.md) and [validation](docs/validation.md) for runtime requirements and verification limits.

## What works

| Area              | Behavior                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machines          | Create, name, select, and remove independent machines without a fixed machine-count ceiling. Each has its own memory, files, lifecycle, init script, runner, and network port.                                                |
| x86 terminals     | Three real interactive shells on `ttyS1`, `ttyS2`, and `ttyS3`, with independent shell state and a split view. System/agent output uses `ttyS0`.                                                    |
| x86_64 terminals  | Three independent shells on `ttyS1`, `ttyS2`, and `ttyS3`, with job control, resizing, shell respawn and split view. `ttyS0` is reserved for system/agent output. |
| Guest inspection  | Boot-time x86_64 observations of architecture, kernel, RAM, CPUs, cgroups, namespaces, overlay support and installed container tools. |
| RISC-V64 terminal | One real VirtIO console on `hvc0`. Interactive use and the agent runner share that console.                                                                                                         |
| VPC networks      | Up to four independent VPCs, with zero to four /24 subnets each. Real subnet switching and IPv4 routing inside each VPC, per-machine stateless allow rules, verdict logs, and optional PCAP capture. |
| Internet toggle   | Explicit World mode with the limited browser HTTP bridge or a user-configured secure Wisp relay. Isolated mode disconnects the machine.                                                             |
| Init scripts      | Up to 8 KiB of shell code per machine, run once per fresh boot after guest setup, with actual output and exit status.                                                                               |
| Agent tasks       | Bounded commands with real output, exit codes, timeout recovery, and a page API for the selected or explicitly addressed machine.                                                                   |
| Snapshots         | Pocket PC and Alpine x86_64 checkpoints with SHA-256, passive inspection and paused quarantine clones. x86_64 registers are observations captured while paused at save time. RISC-V64 checkpoints are unavailable. |
| Evidence          | Guest-assisted logical file capture on Pocket PC and Alpine x86_64, text/hex inspection, hashes, export, and host-enforced read-only mounts in either clean analyst profile. |
| Fleet console     | Follow any selected machines and serial ports in read-only panes; read or subscribe to output through the page API. |
| Durable disks     | Real Pocket PC and Alpine x86_64 VirtIO block devices backed by IndexedDB, ext2 filesystems, immutable snapshots, independent clones, read-only mounts, and image/manifest export. |
| Local cloud       | Versioned instance/image/VPC/subnet/volume API, actual operation results, bounded events/idempotency, and opt-in mutation policies and failure injection. |
| Object storage    | Persistent browser buckets/keys with SHA-256 integrity, revisions, and atomic conditional writes. |
| Resource deletion | Explicit delete controls, named dependencies, conditional storage deletes, preserved independent copies, and live inventory updates. Empty workspaces are valid. |
| Workspace recovery | One versioned configuration manifest, interrupted-session notices, a single owning tab, storage health/persistence controls, and Stop & reload. No automatic RAM recovery. |
| Appearance        | Obsidian, Grove, and Daylight themes, consistent terminal colors, surface opacity, blur, font size, and reduced motion.                                                                             |

Selecting another machine or terminal does not restart the previous one. Machine controls operate on live guests.

## Safe deletion and refresh recovery

Use Cloud resources, Connections, and Snapshots & evidence to delete resources directly. Reviews explain dependencies and retained copies. Stop/delete syncs and unmounts writable disks before releasing the guest; a busy filesystem blocks deletion. Data disks are kept when deleting a machine. The last machine, subnet, or VPC can be removed, and an empty inventory remains empty after refresh.

Workspace & storage shows the saved configuration revision, interrupted sessions, usage/quota estimates, and the browser persistence status. **Stop & reload** waits for resource operations, stops guests cleanly, saves the manifest, and reloads only if preparation succeeds. One tab owns workspace changes; another can take control after that tab closes.

This is configuration recovery, not automatic memory resumption. Committed data volumes, objects, checkpoints, and evidence survive independently, while guest RAM, temporary roots, terminal output, command/cloud history, and simulation rules remain page-local. The diagnostic configuration export does not include disk or artifact contents. See [workspace lifecycle and recovery](docs/workspace-lifecycle.md) for exact guarantees and [the cloud deletion API](docs/cloud-api.md#safe-deletion-without-a-reload) for automation.

## Machine profiles

| Profile        | ISA            | Kernel       | Userspace                                              | Download | Consoles / checkpoints |
| -------------- | -------------- | ------------ | ------------------------------------------------------ | -------- | ---------------------- |
| Pocket PC      | x86, 32-bit    | Linux 6.8.12 | Buildroot / BusyBox                                    | ~10.2 MB | Three shells / yes     |
| Alpine x86_64 | x86_64, 64-bit | Linux 6.12.43-0-virt | Alpine Linux 3.21.4, OpenRC, apk | ~145.5 MB | Three shells / yes |
| RISC-V garden  | RISC-V, 64-bit | Linux 4.15.0 | Original BusyBox 1.21.1                                | ~8.3 MB  | One / no               |
| Alpine 3.24    | RISC-V, 64-bit | Linux 4.15.0 | Official Alpine 3.24.3, musl, BusyBox 1.37, apk        | ~7.5 MB  | One / no               |
| Debian 13 slim | RISC-V, 64-bit | Linux 4.15.0 | Official Debian 13.7, glibc 2.41, Bash, GNU tools, apt | ~36 MB   | One / no               |

Pocket PC and the RISC-V profiles have 128 MiB guest RAM. Pocket PC uses `v86@0.5.472`; RISC-V uses TinyEMU `2019-12-21` in a dedicated worker. The RISC-V Alpine and Debian profiles use a writable in-memory 9p root filesystem assembled from verified official archives. Debian keeps its system libraries; verified Alpine BusyBox and its musl loader supply a small separate set of boot/network utilities. These are genuinely different userspaces, sharing the same compatible historical RISC-V kernel.

The experimental x86_64 profile uses QEMU 8.2.0 compiled to Wasm, one virtual CPU and 512 MiB guest RAM inside a **2,300 MiB shared-memory reservation per instance**, plus additional browser/image overhead. Its root is an immutable ext4 base with a temporary writable overlay. Root changes are lost on stop, reset or refresh unless preserved in an explicit VM checkpoint. A checkpoint restores the temporary root, RAM, device state and existing interactive shells. Full VM checkpoints require a machine without attached data disks or evidence. See [the x86_64 runtime documentation](docs/qemu-runtime.md) for exact assets, browser requirements and boundaries.

Definitions alone do not allocate an emulator. There is no fixed machine-count ceiling; available browser resources and subnet addresses set practical limits. Guests share the visitor's CPU, and inactive tabs may be throttled or suspended. No supplied profile is certified Kubernetes-ready. The x86_64 inspector distinguishes measured prerequisites from verified container or cluster execution.

## Run locally

Use Node.js 24 LTS. The volume smoke uses Node 24.5+ Web Locks; the app build supports Node 22.12+ as well.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite and boot a machine. Use HTTPS or localhost; integrity verification does not work through `file://`.

No backend, model credentials, or API key is required. `predev` and `prebuild` verify the pinned emulator assets and prepare notices without downloading guest images.

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

Production output is `dist/`. Vite uses a relative base, so the output works at a domain root or repository subpath. Internal navigation needs no route rewrites. v86 and TinyEMU do not require shared memory or isolation headers. QEMU x86_64 requires `SharedArrayBuffer` and cross-origin isolation. Open the app in its own tab, then use **Workspace & storage → Enable x86_64 & reload** when needed. The scoped helper adds isolation headers on a static host and reloads only after workspace preparation succeeds. It refuses conflicting service workers. Browser/hosting policies can still prevent isolation; the setup panel reports the observed support.

## Publish on GitHub Pages

1. Put this source, `package-lock.json`, and `.github/workflows/pages.yml` at your repository root.
2. Choose **Settings > Pages > Build and deployment > Source > GitHub Actions**.
3. Push to `main`, or manually run **Verify and deploy Terrarium** from `main`.

The workflow installs locked dependencies, typechecks, tests, builds, and deploys `dist/`. Pull requests verify without deploying. Deployment permissions belong to the deploy job; Actions are pinned to immutable commits.

GitHub Pages supplies static files. Guest CPU, memory, processes, and files stay in the browser. Optional Wisp networking needs a separately operated relay; GitHub Pages cannot run that service. See the [GitHub Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Networking

| Mode     | Behavior                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- |
| Isolated | No LAN forwarding or guest Internet bridge.                                                         |
| Local    | Communicates with enabled peers in its own VPC; same-subnet Ethernet and cross-subnet IPv4 routing. |
| World    | Its VPC plus the selected external transport, subject to packet rules.                              |

### VPCs, subnets, and packet rules

The default Garden VPC retains `192.168.76.0/24` for existing configurations. Create additional private VPC CIDRs with up to four nonoverlapping /24 subnets inside each. VPC CIDRs may overlap with other VPCs; duplicate IPs across separate VPCs are isolated. Each subnet's first host address is the gateway. Choose a machine's attachment and address before booting. Machine definitions, including temporary investigation and analyst guests, have no fixed count ceiling.

ARP and broadcasts stay inside their subnet. The router resolves a destination NIC, rewrites Ethernet addresses, decrements TTL, and updates the IPv4 checksum for cross-subnet routes in the same VPC. Source address validation rejects spoofed identities. Other VPCs are not reachable through the World backend. IPv6, fragmented IPv4, and unsupported EtherTypes are deliberately not routed.

Private DNS answers at the configured subnet gateway: `<machine-name>.terrarium.internal` resolves to the actual configured IPv4 address in the requesting VPC. Exact short names are accepted too. Quarantined machines have no records; foreign-VPC and missing private names return NXDOMAIN without outside fallback. Stopped ordinary machines keep their records, so DNS is not a health check. This is an IPv4 host-record service: AAAA returns an empty successful answer. Use the FQDN to avoid guest short-name conventions. The original RISC-V garden still needs numeric IPs because its guest image lacks normal resolver libraries.

Each port has stateless ingress and egress allowlists. Rules match protocol, peer CIDR, and optionally TCP/UDP destination port. Empty lists deny IP traffic; return packets need explicit matching rules. Rules never override disconnected links, VPC separation, or quarantine. This is not an AWS security-group implementation: there is no stateful return-traffic authorization or peering.

The last 200 flow decisions stay in memory, with 30 shown in the dialog. Opt-in capture retains at most 2,048 packets/4 MiB with a 2,048-byte snapshot length and exports standard Ethernet PCAP. Capture includes both allowed and dropped attempts; PCAP itself does not contain verdict metadata. Old packets are evicted and counted.

Networks are not shared with other tabs or visitors. Saved World choices reload as Local, so reopening a workspace does not silently reauthorize Internet traffic. Guest addresses are configured before user init scripts run. If World is enabled for that boot, an init script can use it.

### Browser bridge

The guest speaks HTTP, and the browser sends HTTPS fetch requests. Requests remain subject to CORS and the remote server's policy. The bridge omits cookies/referrers, rejects URL credentials and local/private destinations, excludes the app host, refuses redirects, and limits each machine to six concurrent requests and 8 MiB per response. Responses are finite and buffered before delivery; streaming is unsupported. This is useful web access, not unrestricted TCP/UDP.

On x86:

```sh
curl http://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/LICENSE
```

The stock x86 `curl` does not have HTTPS protocol support compiled in. Use an `http://` guest URL with the browser bridge; its host request is upgraded to HTTPS.

**The original RISC-V garden has a specific resolver limitation.** Its minimal image omits glibc NSS DNS libraries. Ordinary hostname lookup fails. Terrarium installs an explicit `webget` helper that reaches the browser HTTP bridge through the numeric virtual gateway:

```sh
webget -O- http://raw.githubusercontent.com/copy/v86/cc37f35c43bf14865d74ad76879ecf9410f69eb1/LICENSE
```

`webget` accepts BusyBox `wget` options. It is installed before the user init script, uses an HTTP proxy only for that invocation, and preserves the observed `wget` exit status. It requires **World + Browser bridge**. It does not repair general DNS, install a global proxy, or work through Wisp. Usage/failure messages explain the transport requirement. Direct LAN and relay tools in this guest need numeric destinations.

### User-owned Wisp relay

The transport dialog accepts an explicit `wss://` Wisp endpoint. No default public relay is bundled or contacted. The secure WebSocket connects when the machine is attached, ready, and in World mode. Leaving World closes the backend and prevents stale reconnect callbacks from reactivating it.

Wisp carries guest TCP connections through that relay. Reachability and policy depend on the relay. Browser WebSockets use normal Origin and applicable relay-origin credential/cookie behavior; the fetch bridge's explicit credential omission does not apply to WebSockets. Guest TLS clients are separate requirements; the supplied x86 image has no HTTPS-capable curl or OpenSSL. An encrypted relay connection does not add end-to-end TLS to guest tools. The original RISC-V garden's missing DNS libraries still apply, so use numeric destinations there. Alpine and Debian include normal resolver libraries. Their package managers are installed, but package installation still depends on repository reachability, transport restrictions, and kernel/tool compatibility. General UDP, VPN connectivity, and inbound public services are not claimed.

## Init scripts and agent API

A machine's init script runs once on a fresh boot/reset, after console and network setup. It does not rerun on pause/resume or a supported VM checkpoint restore. The script executes in a noninteractive shell: create files/services for persistent effects, because an exported variable only changes that script's process environment. A nonzero exit is displayed as failed. An unrecovered startup timeout requires reset.

Definitions and init scripts are saved in browser local storage. Editing a script affects the next fresh boot, not current processes. Live machine state is separate.

Use the page API from browser automation or the developer console:

```js
const machines = window.terrarium.list();
const vm = window.terrarium.get(machines[0].id);
await vm.boot();
const result = await vm.exec('uname -a');
result // { output, exitCode, status, recovery, ... }
```

Evaluate `result.output` for just the captured text. `console.log(result.output, result.exitCode)` prints it, but `console.log` itself returns `undefined`; that final console evaluation is not the command result. Run these JavaScript examples in the browser developer console. Terrarium's guest terminals and command workpad accept Linux shell commands.

The **Console** page follows any selected machines in separate read-only serial panes. Each pane selects its port and can pause its subscription, clear the displayed text, or follow the tail without pausing the guest. It retains the latest 128 Ki characters per displayed pane.

```js
vm.readOutput();                    // retained system/agent serial transcript
vm.readOutput({ port: 1 });         // Pocket PC or Alpine x86_64 Shell 1 transcript
const stop = vm.mirrorOutput();     // explicitly log new output in DevTools
stop();                             // unsubscribe; the VM keeps running

const unsubscribe = vm.subscribeOutput(event => {
  if (event.type === 'data') console.log(event.data);
}, { port: 0, replay: true, format: 'text' });
unsubscribe();
```

Subscriptions default to new output only; opt into historical replay explicitly. Events carry `type`, `data`, `port`, `replay`, and transcript `epoch`. Text mode strips terminal control formatting; raw mode retains decoded serial text. Both include real kernel/command-protocol output. Use structured `exec()` results for a command's clean captured output and actual exit code.

Top-level `window.terrarium.boot()`, `cancelBoot()`, `exec()`, `status()`, `pause()`, `resume()`, and `reset()` address the selected machine. `get(id)` returns a stable target; `list()` exposes identities, capabilities, runtime state, and command readiness. `getInitScript()` and `setInitScript()` inspect/configure startup.

While an x86_64 machine is loading or booting, **Cancel boot** or `await vm.cancelBoot()` interrupts that boot and keeps its definition and separate stored data disks. The pending `boot()` promise rejects; handle that result before booting again. This direct lifecycle action can interrupt an active cloud start. Cloud operation handles themselves do not cancel queued work. Wait for cancellation to complete before deleting the machine.

Each `exec()` starts a fresh noninteractive `/bin/sh` with stdin at EOF. Working directory and exported variables do not persist between calls; guest files do. stdout/stderr share the command channel. Pocket PC and Alpine x86_64 interactive shells are separate from that channel. RISC-V64 profiles share one console, so their interactive input is blocked during an agent task.

| Runner constraint   | Value                                                         |
| ------------------- | ------------------------------------------------------------- |
| Concurrent commands | One per machine; different machines have separate runners     |
| Command size        | 8 KiB of UTF-8                                                |
| Captured output     | 64 KiB of UTF-8                                               |
| Deadline            | 15 seconds by default, clamped to 1–60 seconds                |
| Recovery            | Ctrl-C followed by a fresh shell acknowledgment               |
| Results             | `exited`, `timed_out`, `output_limit`, or `interrupted`       |
| Exit code           | Observed shell status, or null if completion was not observed |
| Recovery status     | `not_needed`, `recovered`, or `reset_required`                |

Failed recovery blocks commands until reset. This is a cooperative shell protocol: hostile programs can interfere with the TTY or spoof output, and background process trees are not independently supervised. It is not a tamper-proof evaluation channel, an MCP service, or an always-on remote endpoint.

## Local cloud resources

The **Cloud resources** view manages actual instances, volumes, object buckets, and operation history. It shares a versioned registry with `window.terrarium.cloud`:

```js
const cloud = window.terrarium.cloud;
const instance = await cloud.instances.create({
  name: 'agent-01', imageId: 'alpine-riscv64',
  initScript: 'mkdir -p /root/agent-work'
}, { idempotencyKey: 'agent-01-create' }).wait();
await cloud.instances.start(instance.id).wait();
await window.terrarium.get(instance.id).exec('uname -a');
```

Mutations return `{id, get(), wait()}`. Success means the real resource mutation finished; failures are exposed as operation errors. Resource changes serialize by affected identity. The most recent 200 completed operations and 500 events remain in this open page. Idempotency is limited to matching retained requests and does not survive a reload. Live metadata comes from `cloud.metadata.describe(id)`; no guest IMDS service is installed.

`cloud.objectStore` stores real bucket/object bytes in IndexedDB, checks SHA-256 on reads, and supports conditional writes by hash or revision. Each object is at most 64 MiB. It is a JavaScript data API without an S3 or guest HTTP endpoint.

Explicit simulated identities and next-operation latency/failure rules let agents test error handling. These optional rules affect control-plane mutations, with an unrestricted local owner and no defaults that inject errors. They provide local failure injection and policy tests; they do not authenticate browser users or isolate tenants. See [the full cloud API](docs/cloud-api.md) for executable examples and exact semantics.

## Persistent data volumes

Create a 4–128 MiB ext2 disk in **Cloud resources > Volumes**, attach it to a stopped Pocket PC or Alpine x86_64 instance, and boot. Files below `/mnt/volumes/disk0` or `disk1` go to a genuine VirtIO block device backed by browser IndexedDB. The stock Linux kernel supplies its VirtIO block and filesystem drivers. The application supplies a tested block request handler and creates the empty filesystem itself; no disk template is redistributed.

Stop writable guests to sync and unmount their filesystems, drain device requests, and close storage locks. A busy mount blocks stop/delete while leaving the guest available. Resume a paused guest with writable disks before stopping or resetting it. Then snapshot the disk into an immutable, hashed copy or clone it into an independent writable disk. Attach a snapshot read-only to a clean analyst guest to inspect its files without running the source guest. The host rejects writes even when guest code bypasses the mount flag. Export downloads a raw image and JSON integrity manifest.

Each Pocket PC and Alpine x86_64 instance exposes two disk slots. Slot 1 can be used independently of slot 0. Disks mount before the user init script runs. RISC-V extra-volume attachment is unavailable. These data disks are separate from the temporary root filesystem and from VM memory checkpoints; full checkpoints are disabled whenever external volumes or evidence are attached. Browser quota, eviction, and guest filesystem caching remain relevant. See [volume behavior and validation](docs/volumes.md).

## Downloads and provenance

The site serves verified v86/TinyEMU code, five owned QEMU runtime bundles and their shared owned Alpine guest, together with component notices. The following legacy profiles fetch separate guest binaries into browser memory:

- Pocket PC: kernel/rootfs from `i.copy.sh`, plus BIOS files from the pinned `copy/v86` GitHub commit.
- Legacy Alpine x86_64: kernel, initramfs, firmware and compressed root from the pinned QEMU-Wasm artifact commit, with per-file size/SHA-256 verification. Owned Small/Worker/Server bundles instead use locally shipped, separately pinned runtime and guest assets.
- Original RISC-V64: boot loader, kernel, and root disk from an immutable `losfair/jslinux-wstunnel` GitHub mirror. Their hashes were independently matched against Fabrice Bellard's official `jslinux-2019-12-21` archive.

Alpine and Debian root archives come from pinned official image repository commits. Their verified bytes are unpacked in memory at boot; these RISC-V guest archives are not bundled in the static app. Exact source/build references and digests are recorded in TinyEMU provenance.

Every guest file must match its length and SHA-256 before execution. Requests omit credentials/referrers. An outage or changed bytes causes a visible boot error. This is not an offline distribution.

The repository/static output includes the owned Alpine 3.21.4 guest with Linux 6.12.38-0-virt. Its exact component sources, modifications, terms, reconstruction instructions and same-distribution source companion are described in [owned runtime sources](docs/runtime-sources.md) and the [source manifest](public/runtime/qemu/source-manifest.json). The manifest identifies the stable GitHub Releases download URL; verify the complete size, SHA-256 and closed membership after retrieval. Legacy remotely fetched guests retain the separate limitations in [v86 provenance](public/runtime/provenance.json), [TinyEMU provenance](public/runtime/tinyemu/provenance.json), [QEMU provenance](public/runtime/qemu/provenance.json) and [the release audit](docs/release-audit.md).

## Persistence and checkpoints

Refreshing or closing the page discards live machines and command histories. Definitions, scripts, transport settings, and appearance persist separately. Explicit supported checkpoints preserve guest memory and temporary root files. Persistent data volumes and object buckets are independent IndexedDB resources and survive reloads. Stop writable guests before closing the page to sync their filesystem caches.

Pocket PC and Alpine x86_64 share a shelf of at most three saved checkpoints in IndexedDB. Either format can also be downloaded. Checkpoints belong to their exact runtime and guest profile:

| Profile | Accepted checkpoint |
| --- | --- |
| Pocket PC | Trusted, uncompressed v86 format-6 state, at most 256 MiB, from the pinned four-UART configuration with 128 MiB RAM and 2 MiB VGA memory. Older single-UART states are incompatible. |
| Alpine x86_64 | Terrarium's versioned checkpoint container, with a pinned profile/asset manifest, payload SHA-256 and at most 768 MiB of QEMU state plus bounded metadata. Arbitrary raw or qcow2 images are not accepted as VM checkpoints. |
| RISC-V64 profiles | No VM checkpoint support. |

Validation happens before replacing a live machine. Import preserves the original bytes in browser storage and opens passive inspection without running them. Restore skips user init. A paused restore runs no guest setup until explicit resume; x86_64 resume repairs the assigned network address and refreshes observations while retaining the saved shell processes, environment, working directories and terminal sizes. Saving a running x86_64 machine briefly pauses it, captures monitor registers and VM state, then resumes it. A safe save refusal restores the prior execution state so it can be retried; an uncertain emulator failure stops the worker.

Data disks and evidence are separate resources and must be detached before a full VM save or restore. A checkpoint does not preserve a browser tab's external network connections.

Browser quota and eviction apply. Download important snapshots; browser storage is not a remote backup.

## Snapshot investigation and evidence

1. Save or import a current Pocket PC or Alpine x86_64 checkpoint, then choose **Inspect**. SHA-256 covers the original bytes. The viewer shows instruction pointers, general registers, privilege level, RAM and device/format facts without running a guest. Pocket PC CPU fields are decoded from serialized state. x86_64 CPU fields are monitor observations captured while paused at save time; they are not decoded from the QEMU state payload.
2. Choose **Create paused quarantine clone**. A new machine gets its own permanently disconnected host network port before the checkpoint is loaded. The runtime loads its state with execution stopped; no startup script, IP repair, or guest command executes until you explicitly resume it. The original checkpoint is never edited.
3. Resume the clone when you want interactive or agent-assisted investigation. Resume repairs the assigned network settings, and on Pocket PC repairs its serial setup. The acquired live state includes that setup; x86_64 retains its existing interactive shell processes. It remains unable to send or receive peer or outside packets. There is no network release operation for that port. You can capture its attempted packets for inspection.
4. On the evidence bench, request explicit absolute paths. Capture allows up to 32 regular files, 1 MiB per file, 8 MiB total. It runs commands inside the quarantined guest. Pocket PC transfers bytes through an in-memory 9p staging share, with host inode-size checks and bounded reads before copying. Alpine x86_64 stages a bounded file copy in its temporary root and transfers 16 KiB chunks through the framed serial command channel. The host checks chunk lengths and hashes the received files and canonical archive, including provenance. These are acquisition/archive bounds; the writable v86 staging backend can still allocate guest-requested data.
5. Inspect files as escaped text or hex, download individual files, or export/import the complete JSON archive. Up to six archives can remain in IndexedDB; imports are capped at 12 MiB and all hashes are verified.
6. Choose **Pocket PC** or **Alpine x86_64** as the analyst profile, then **Mount in clean analyst**. A fresh guest receives an independent archive copy at `/mnt/evidence`. Original paths appear below `files/`, for example `/mnt/evidence/files/etc/passwd`, alongside `manifest.json`. Pocket PC uses a host-side read-only 9p server. Alpine x86_64 uses a separate, host-protected VirtIO ext2 image, which can coexist with its two data slots. Both reject writes independently of guest mount flags. The views use synthetic modes, ownership and timestamps; they do not preserve original inode metadata or expose a host directory. Evidence-mounted guests cannot save or restore full VM checkpoints because the external evidence view is separate from VM state.

Quarantine and analyst machines are temporary. They are not resurrected after refresh. Their evidence/checkpoints must be explicitly saved or downloaded. Deleting a clone does not delete its preserved checkpoint or archive.

A full VM checkpoint is **not** a general disk image. Pocket PC keeps its root in guest RAM; Alpine x86_64 uses an immutable ext4 base with a temporary writable overlay. This workflow supplies passive CPU-state inspection, isolated execution, and bounded logical file acquisition; it does not provide an offline filesystem parser, unallocated/deleted-file recovery, source-level kernel debugging, or a general mount for arbitrary raw/qcow2 disks.

Logical acquisition trusts guest-assisted reads. A compromised kernel or shell can hide or falsify data. Host hashes attest to the bytes received, not source authenticity or a formal chain of custody. This browser/emulator is an educational investigation environment, not an audited containment platform for live malware. The network gate isolates guest packets; it does not establish that the emulator, browser, or command framing resists arbitrary exploitation.

## Verification

```sh
npm test
npm run test:vm
npm run test:bridge
npm run test:workspace
npm run test:volume
npm run test:cloud
npm run test:dns
npm run test:rv64
npm run test:qemu
npm run test:qemu-storage
npm run test:qemu-network
npm run test:network
npm run test:vpc
npm run test:profiles
npm run test:evidence
```

Real-machine tests fetch verified guest assets into memory. The QEMU parity test runs the production runtime and worker dispatcher on a real Node worker thread. It checks three independent controlling terminals, concurrent agent commands, job control, terminal resizing, shell respawn, networking, and a save/cold-paused-restore round trip that preserves shell processes and skips init. The QEMU storage test checks disk persistence through reset, independent slots, immutable snapshots, writable clones, quarantined Unicode/binary acquisition and a fresh read-only analyst mount. The RISC-V test executes the shipped worker and genuine WebAssembly Linux, checking Unicode/file I/O, CPU pause/resume, recovery, Ethernet, host-adapter init/reset/cancellation, and the installed `webget` helper through the actual packet bridge. Its HTTP origin is a deterministic fixture. The network test separately covers the real x86 guest and a locally operated secure Wisp fixture; this does not imply access to an arbitrary public relay. See [the validation record](docs/validation.md) for exact results and browser QA limits.

- [Cloud API and failure injection](docs/cloud-api.md)
- [Persistent volumes and disk investigation](docs/volumes.md)
- [x86_64 machine settings and custom images](docs/machine-settings.md)
- [Experimental x86_64 runtime](docs/qemu-runtime.md)
- [Architecture](docs/architecture.md)
- [Release audit](docs/release-audit.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Apache 2.0 application license](LICENSE)

Third-party components retain their own licenses.
