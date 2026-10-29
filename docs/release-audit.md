# Public release notes and boundaries

Terrarium is an independent, static browser application for small Linux machines, shell sessions, agent tasks, and network experiments. This document records the implementation and packaging choices a public repository maintainer should understand. It does not claim an independent security audit of the browser, emulators, guests, or network transports.

## Product and source

The interface includes a vector mark, locally served typography, semantic themes, and documentation. The field guide describes available behavior and systems trivia.

Obsidian, Grove, and Daylight retain their existing semantic color tokens. Translucency affects surface backgrounds while text remains opaque. The terminal uses the same palette and preferences. New machine, network, and script controls use those shared styles.

The working name Terrarium has not undergone trademark clearance. Naming upstream components identifies dependencies and does not imply affiliation. Their licenses remain separate from the application's Apache 2.0 license.

## What a static host supplies

The built `dist/` contains the UI, locally served fonts, emulator JavaScript/WebAssembly, a TinyEMU worker, and dependency notices. Guest CPU work runs on the visitor's device. GitHub Pages supplies static files, not a server-side Linux process, relay, always-on agent, or remote filesystem.

The site uses relative asset URLs and in-page navigation. v86 and TinyEMU require neither shared memory nor isolation headers. QEMU x86_64 requires SharedArrayBuffer and cross-origin isolation. Its explicit setup installs a scoped, pass-through service worker and prepares the workspace before reload; a conflicting worker or incompatible hosting/browser policy is reported. Embedded pages may need to open in their own tab. The browser isolation path remains separately subject to the verification limits below. The included Pages workflow builds from the lockfile and deploys `dist/`; pull requests verify without publishing. Only the deploy job receives Pages write and OIDC permissions. Action revisions are pinned and checkout does not persist credentials.

An optional Wisp Internet relay is a separately operated service. Its address is explicitly supplied by the user. Hosting the static app on Pages does not host that relay.

## Runtime and guest provenance

### x86

The application pins `v86@0.5.472` at source commit `cc37f35c43bf14865d74ad76879ecf9410f69eb1`. Runtime preparation verifies the installed upstream bytes before copying the WASM assets and applying one documented JavaScript integration patch. The patch exports the existing Fetch and Wisp adapter constructors for lazy, per-port lifecycle control, and the generic VirtIO PCI transport for the application-owned block-device handler. It does not replace the emulator or networking algorithms. Both upstream and redistributed digests are recorded in `public/runtime/provenance.json`.

The guest is Linux 6.8.12 with a small Buildroot/BusyBox environment, 128 MiB RAM, and four UARTs. The control channel uses ttyS0; ttyS1–3 host independent interactive shells. CPU state snapshots use the `v86@0.5.472-uart4-v1` compatibility identifier. Old single-UART snapshots are rejected before replacing a running guest.

Boot fetches the Linux image from `i.copy.sh` and firmware from immutable `raw.githubusercontent.com/copy/v86/…` paths. Every file has an exact byte count and SHA-256 check. The Linux URL is mutable, but changed content is rejected. Availability still depends on those origins and browser CORS support.

The exact upstream Buildroot configuration and complete corresponding source bundle for the x86 demo binary have not been established. This distribution therefore references the upstream download and does not mirror that guest image or firmware.

### QEMU x86_64

The experimental Alpine x86_64 profile uses immutable, hash-verified upstream QEMU 8.2.0 executable bytes and an Alpine 3.21.4 / Linux 6.12.43-0-virt guest. Its 512 MiB guest RAM sits inside a fixed 2,300 MiB shared Wasm allocation. It has a dedicated agent channel and three independent serial shells, a temporary root overlay, explicit full VM checkpoints and two external data-disk slots. Checkpoints reject external data/evidence attachments. The prerequisite panel reports observations instead of claiming Kubernetes readiness.

The historical runtime downloads QEMU executable module/Wasm and guest packages directly from upstream. The fixed hardware presets additionally require application-local owned runtime bundles, their notices and corresponding source materials. The build rejects missing or changed catalog bytes. The historical upstream artifact repository does not attest that legacy runtime's exact QEMU source revision; reference recipes and this limitation are disclosed in `public/runtime/qemu/provenance.json`. Boot rejects changed bytes. Private HMP pipes and an in-memory Ethernet endpoint keep execution controls separate from guest egress. See [the QEMU runtime documentation](qemu-runtime.md) and [validation](validation.md).

### RISC-V64

The original RISC-V profile uses the MIT-licensed TinyEMU/JSLinux 2019-12-21 release in a dedicated worker. The locally served emulator JS and WASM are pinned by length and SHA-256. The guest identifies Linux `4.15.0-00049-ga3b1e7a-dirty`, RISC-V64, and BusyBox 1.21.1, with 128 MiB RAM and a single hvc0 console. This is a historical, small guest image. RISC-V64 is not x86-64; the profile does not contain Kubernetes.

The bootloader, kernel, and disk bytes match Bellard's official demo archive and are fetched from a pinned GitHub mirror with CORS support. `public/runtime/tinyemu/provenance.json` and `src/lib/tinyemu-assets.ts` record the original archive, mirror revision, individual sizes, and digests. They are not redistributed in the static build. The worker keeps disk writes in memory and does not implement snapshots. This root filesystem omits its normal DNS NSS libraries. The installed `webget` helper uses an explicit numeric HTTP proxy with the Browser bridge; applications in this original RISC-V profile on Wisp require numeric destination addresses. The x86 image includes curl 8.7.1 without TLS support. Neither of these original profiles is advertised as a full modern networking tool distribution.

Alpine 3.24.3 and Debian 13.7 add genuine modern 64-bit userspaces. They share the compatible historical Linux 4.15 RISC-V kernel, with 128 MiB RAM and one console. Root archives are pinned to official image repository commits and fetched/verified on demand. Debian uses its own glibc/Bash/GNU tools; a separate verified Alpine BusyBox/musl utility pair supports startup and networking. Provenance records the exact byte hashes, official source/build links, and that these are userspace integrations rather than complete modern-kernel distributions. Their package managers' presence does not promise arbitrary package or Kubernetes compatibility.

Runtime preparation performs no guest downloads. Historical upstream guests stay remote; owned QEMU guest packages use exact catalog-pinned bundle subdirectories. Owned runtime/guest sources and exact recipe identities are described in [runtime sources](runtime-sources.md) and the public source manifest. The public source manifest identifies the same-distribution companion's stable GitHub Releases download URL and integrity metadata. Verify the complete archive after retrieval; a URL or local archive check alone does not establish live availability or component-obligation clearance. Legacy profiles still require upstream downloads.

## Network behavior

Each machine has an explicit VPC/subnet/IPv4 attachment on a page-local switch/router. Ordinary duplicates are rejected within one VPC; overlapping CIDRs and duplicate IPs across separate VPCs remain isolated. ARP and broadcasts are subnet-confined. IPv4 routes inside the same VPC use actual gateway neighbor resolution and L2/TTL/checksum rewriting. Assigned source addresses are checked. Other-VPC destinations are blocked before the World backend. IPv6, fragments and unsupported EtherTypes are not routed.

Stateless ingress and egress allowlists are enforced at the host port. These are not cloud security groups with connection tracking. Capture is opt-in, bounded, in-memory and exportable as PCAP; metadata records allowed/dropped verdicts. A restored quarantine clone receives a private, irreversible isolation flag before execution, independent of guest NIC configuration and ordinary network controls.

Outside access has two transports:

| Transport                | Behavior                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser bridge           | Translates guest HTTP to browser HTTPS fetch requests. Destination CORS policy applies. The bridge omits credentials/referrers, rejects redirects, excludes literal private/local hosts and the app origin, bounds concurrency and response size, and aborts requests when disabled. It does not provide guest TLS or arbitrary TCP.                        |
| User-supplied Wisp relay | Establishes a secure WebSocket only after outside access is explicitly enabled and the guest port is ready. Carries outbound TCP using the selected relay to resolve destination names. The encrypted relay transport does not add TLS support to guest applications. No default public relay, general UDP, or public incoming port forwarding is supplied. |

Turning outside access off destroys the backend, closes sockets, aborts fetches, and rejects stale callbacks. A page reload restores saved LAN/transport preferences but leaves outside access off. Relay URL configuration is local to the browser, not a site secret or a shared setting.

Browser fetch restrictions and hostname checks do not establish a robust network security perimeter. Browser DNS behavior, emulator code, and relay policy remain relevant. A user-supplied relay decides which destinations it can reach. Its operator can observe destinations and any traffic not encrypted by the guest application.

Guest boot downloads are separate from guest egress controls. The browser must fetch the application and guest assets even when the guest network is off.

## Durable storage and cloud control plane

Pocket PC and Alpine x86_64 expose genuine VirtIO block devices through their respective emulator adapters. The stock guests' block/filesystem drivers mount the generated ext2 data disks. Empty images are produced by application code; no disk template or extra guest binary is included. Up to two slots per supported guest expose 4–128 MiB disks, with store commits preceding successful guest write acknowledgments. Immutable snapshots reject writes at both device and store levels. The QEMU adapter uses bounded shared-memory requests and waits in its worker for the host storage commit. Shared teardown gating prevents a new boot while old storage requests are closing. A failed storage commit is reported when stopping the machine instead of silently treating teardown as a successful flush.

Persistent storage depends on IndexedDB and Web Locks in a secure browser context. Locks and atomic revisions protect cooperative origin-local use; guest caching, browser eviction, quota, abrupt termination, and a compromised browser remain outside durable-commit guarantees. Exports provide portable image/manifest copies. Full VM checkpoints reject external volume or evidence attachments because they cannot capture their external state. See [volumes.md](volumes.md).

The local cloud API operates on the real resource registry and exposes truthful operation completion/failure. Its bounded events and idempotency last only for the open page. Object buckets/keys are real origin-local IndexedDB data with hash verification and atomic conditional writes. The **Failure injection** module can apply a one-shot delay or failure to a control-plane mutation and test optional simulated identities/policies. These controls have an unrestricted local owner; they provide neither authentication nor a hostile multi-tenant boundary. The existing `cloud.simulation` API name remains compatible. Live metadata is a JavaScript API without an IMDS endpoint, and object storage has no S3 compatibility endpoint. See [cloud-api.md](cloud-api.md).

VPC DNS returns actual configured IPv4 host records through the subnet gateway and the existing policy gates. Private queries remain within the VPC; quarantined records are excluded. The service does not implement recursive DNS, health checks, IPv6 address records, or a general DNS hosting product.

## Agent and execution limits

`window.terrarium` is a page API. Each machine has its own command runner, so two guests can run separate tasks concurrently. A single guest allows one tracked command at a time. Inputs are bounded to 8 KiB of UTF-8, captured output to 64 KiB, and requested deadlines to 1–60 seconds. stdout and stderr share the tracked stream.

Commands run in fresh noninteractive shells. Working directories and exported variables do not carry between API calls, while guest filesystem changes do. Pocket PC and Alpine x86_64 each provide three interactive shells on separate UARTs, alongside a dedicated agent channel. Those interactive shells retain their own state and can operate while an agent command runs. The RISC-V console/task runner shares one channel, which the UI locks during a task.

The runner reports observed exit codes and distinguishes timeout, interruption, and output-limit results. Recovery requires a new shell acknowledgment after Ctrl-C. Failed recovery blocks the command channel until reset. This is cooperative task control: it does not guarantee that every background descendant terminated, and its text protocol is not a tamper-proof result attestation against hostile guest code.

Boot scripts run as guest root once per fresh boot/reset. They are bounded to 8 KiB and 60 seconds. Scripts are configuration stored in the browser; snapshot restore skips the script. There is no model key, host mount, authenticated remote MCP endpoint, or server-side persistence in this distribution.

## State and practical validation

There is no fixed machine-count ceiling in creation or saved-configuration loading. Definitions do not allocate emulators; guest RAM is allocated on boot. Actual responsiveness depends on the visitor's CPU, memory, browser, and workload. A 128 MiB guest allocation is not the total memory consumed by an emulator. Inactive tabs can be throttled or suspended.

Names, profiles, boot scripts, disk attachments, LAN/relay preferences, and appearance can persist in browser storage. Live memory and run history do not automatically survive refresh. Pocket PC and Alpine x86_64 VM checkpoints are explicit, limited to three browser records, and accepted only for their compatible runtime/hardware profile. v86 imports retain a 256 MiB limit; the QEMU payload limit is 768 MiB plus bounded metadata. Browser quota/eviction rules apply; a download is the durable user-controlled backup.

See [validation.md](validation.md) for checks actually run and their limits. Before a public announcement, exercise the final hosted origin in the target browsers: create each runtime type, boot with a script, split x86 shells, verify machine isolation and LAN communication, toggle each configured transport, restore snapshots, reload, change themes, and use a narrow viewport. Native build and VM tests do not substitute for browser rendering checks.

## Investigation boundaries

Saved Pocket PC and Alpine x86_64 checkpoints gain original-byte SHA-256 and passive CPU-register inspection. Pocket PC register values are decoded from its serialized state. QEMU register values are captured from the private monitor while paused and saved as labeled observations alongside the checkpoint; they are not decoded from an arbitrary imported QEMU state. A quarantine clone restores paused with no guest instructions, init scripts, or setup commands. Explicit resume executes the guest under a permanently closed peer/world network gate. Original bytes stay unchanged.

File collection is guest-assisted logical acquisition, capped by file count, per-file size and total bytes. A compromised guest can lie about its own files. Host hashing verifies the resulting archive's integrity, not its authenticity or completeness. Pocket PC's read-only analyst mount uses a host 9p handler. Alpine x86_64 uses a host-generated ext2 view on a read-only VirtIO block device, mounted with `ro,nodev,nosuid,noexec`. Both host adapters reject mutations independently of guest mount requests. Analyst VM checkpoints are disabled because their external evidence filesystem is not part of a full VM state. These guests are temporary and not restored after refresh.

This is not an audited live-malware containment environment, an offline block-device forensic tool, or a debugger with symbols/breakpoints. VM state import validation reduces malformed-input risk but does not prove the emulator safe against hostile snapshots. The UI describes these present limits without promoting future capabilities as available.

## Primary references

- [v86 hardware and compatibility](https://github.com/copy/v86)
- [v86 networking](https://github.com/copy/v86/blob/cc37f35c43bf14865d74ad76879ecf9410f69eb1/docs/networking.md)
- [TinyEMU and its licensing](https://bellard.org/tinyemu/)
- [TinyEMU technical documentation](https://bellard.org/tinyemu/readme.txt)
- [GitHub Pages deployment workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Buildroot source/license output](https://buildroot.org/downloads/manual/manual.html#legal-info)
