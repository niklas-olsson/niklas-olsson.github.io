// SPDX-License-Identifier: Apache-2.0
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileCode2,
  Info,
  Leaf,
  Network,
  Terminal,
} from "lucide-react";
import { BrandMark } from "./Brand";
import { RUNTIME_PROFILES } from "../lib/runtime-profiles";

export function FieldGuide() {
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">
            <BookOpen size={14} />
            THE FIELD GUIDE
          </div>
          <h1>Know your little world.</h1>
          <p>What is here, how it behaves, and a few things worth noticing.</p>
        </div>
        <BrandMark className="about-brand" />
      </section>
      <div className="guide-feature-grid">
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <Terminal size={24} />
          </span>
          <h2>{Object.keys(RUNTIME_PROFILES).length} guest profiles</h2>
          {Object.values(RUNTIME_PROFILES).map((profile) => (
            <p key={profile.id}>
              <strong>{profile.label}</strong>: {profile.userland},{" "}
              {profile.bits}-bit {profile.architecture}, Linux {profile.kernel},{" "}
              {profile.memoryMiB} MiB RAM.{" "}
              {profile.capabilities.interactiveSessions} interactive{" "}
              {profile.capabilities.interactiveSessions === 1
                ? "console"
                : "shells"}
              {profile.capabilities.snapshots
                ? ", with checkpoints."
                : ". No checkpoints."}
            </p>
          ))}
          <p>
            These are the default images for fresh boots. A restored x86_64
            checkpoint retains its recorded runtime and guest image.
          </p>
          <p>
            The RISC-V Alpine and Debian profiles provide modern userspaces on
            the historical RISC-V kernel. RISC-V64 and x86_64 are different
            instruction sets. The QEMU x86_64 profile is experimental;
            Kubernetes readiness has not been established.
          </p>
          <p>
            QEMU uses 512 MiB guest RAM inside a 2,300 MiB shared Wasm
            reservation per running instance, plus browser and image overhead.
            Its writable root is temporary. Enable its shared-memory runtime
            from Workspace &amp; storage when prompted.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <CheckCircle2 size={24} />
          </span>
          <h2>A workspace of machines</h2>
          <ul>
            <li>Create independent guests without a fixed machine-count limit</li>
            <li>Switch machines without restarting them</li>
            <li>Split two Pocket PC or Alpine x86_64 shells side by side</li>
            <li>Follow several machines in the read-only Console view</li>
            <li>Pause, resume, or reset each machine</li>
            <li>Cancel an x86_64 boot while keeping its saved definition</li>
            <li>Delete any machine while preserving its independent data disks</li>
            <li>Run a saved shell script on a fresh boot</li>
            <li>Send bounded tasks through the page’s agent API</li>
          </ul>
          <p>
            Each guest has its own memory and filesystem. More running guests
            use more of your browser’s CPU and memory. Guest RAM is listed for
            each profile; emulator, disk, and display memory add to that total.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <Network size={24} />
          </span>
          <h2>Choose the connections</h2>
          <p>
            Create up to four private VPCs, each with zero to four /24 subnets.
            Real Ethernet switching stays inside each subnet; the in-page router
            carries IPv4 between subnets in the same VPC. Separate VPCs cannot
            peer. New machines start disconnected.
          </p>
          <p>
            All supplied runtimes connect through the same network controls. The
            x86_64 guest uses a VirtIO network device; its DNS and HTTP packet
            path has been verified through the shared bridge.
          </p>
          <p>
            Private DNS resolves <code>machine-name.terrarium.internal</code>
            {" "}inside its own VPC. Records describe configured IPv4 addresses,
            including stopped machines; they are not health checks. Quarantined
            machines are never advertised, and missing private names do not
            leak to an outside resolver.
          </p>
          <p>
            Choose the browser bridge for outbound HTTP subject to CORS, or
            supply a secure Wisp relay for outbound TCP. The relay carries
            traffic and resolves destination names. General UDP and incoming
            public ports are not included.
          </p>
          <p>
            Outside access starts off when you reopen the page. Turning it off
            closes relay connections and aborts web requests. The private LAN
            can remain connected.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <FileCode2 size={24} />
          </span>
          <h2>Give a machine a beginning</h2>
          <p>
            Open <strong>Boot script</strong> beside the console. Write, import,
            or export a <code>/bin/sh</code> script of up to 8 KiB. It runs as
            guest root after Linux starts and before the interactive session is
            released.
          </p>
          <p>
            Scripts run on fresh Boot and Reset, with a 60-second limit. Their
            output and exit status are available in the script editor. Saving a
            script changes the next boot; a snapshot restore skips it.
          </p>
          <p>
            Keep setup repeatable. Put long-running services in the background
            so initialization can finish.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <CheckCircle2 size={24} />
          </span>
          <h2>Preserve and investigate</h2>
          <p>
            Inspect saved Pocket PC and Alpine x86_64 checkpoint hashes without
            executing guest instructions. Pocket PC registers are decoded from
            the saved state. Alpine x86_64 registers are monitor observations
            captured while the machine was paused at save time.
          </p>
          <p>
            Create a separate quarantine clone restored paused. Explicitly resume
            it when you want to run commands. Its network port permanently blocks
            peer and world traffic. Restoring a checkpoint preserves the guest’s
            files and shell state and skips the saved boot script.
          </p>
          <p>
            Capture selected regular files, inspect text or hex, verify SHA-256,
            and export the archive. Choose Pocket PC or Alpine x86_64 for a clean
            analyst and mount a copy at <code>/mnt/evidence</code>; the host rejects
            writes. Logical capture uses the source guest and can be incomplete
            or misleading if that guest is compromised.
          </p>
          <p>
            A checkpoint preserves CPU, memory, device state, and temporary root
            files. It is not a general disk image. Quarantine and analyst machines
            are temporary. Data disks and evidence must be detached before saving
            or restoring a full VM checkpoint.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon"><FileCode2 size={24} /></span>
          <h2>Disks that outlive a guest</h2>
          <p>
            Create persistent ext2 data volumes in Cloud resources. Attach to a
            stopped Pocket PC or Alpine x86_64 machine, then boot to mount at
            {" "}<code>/mnt/volumes/disk0</code> or <code>disk1</code> before its
            boot script runs. Each sparse disk is 4–8,192 MiB, with two independent slots
            per machine. RISC-V profiles do not expose these extra disks.
          </p>
          <p>
            Stop attached guests to sync filesystem caches before making an
            immutable disk snapshot or a writable clone. Mount the snapshot
            read-only on a clean analyst guest. The device and host store both
            reject writes; inspecting files does not boot the source system.
          </p>
          <p>
            A busy filesystem prevents stop or deletion and leaves the guest
            available. Resume a paused guest with writable disks before stopping
            or resetting it. Deleting a machine keeps its separate stored disks.
          </p>
          <p>
            These are data disks. The supplied boot image still has a temporary
            root filesystem. Full VM checkpoints are unavailable while external
            disks or evidence are attached.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon"><Network size={24} /></span>
          <h2>A local cloud control plane</h2>
          <p>
            <code>window.terrarium.cloud</code> manages the actual instance,
            image, VPC, subnet, and volume registry. Mutations return an operation
            handle with status, result, and error. Await <code>.wait()</code> to
            receive the completed resource change.
          </p>
          <p>
            Persistent object buckets store agent artifacts with SHA-256
            integrity and conditional writes. Live metadata is available through
            the JavaScript API. Storage and compute run in this browser;
            there is no remote provider, S3 endpoint, or guest metadata server.
          </p>
          <p>
            Failure injection can reject or delay the next matching control-plane
            mutation. Simulated identities let you test allow and deny policies.
            These rules do not authenticate browser users.
          </p>
        </section>
        <section className="boundary-card glass">
          <span className="boundary-icon">
            <Network size={24} />
          </span>
          <h2>See what crosses the boundary</h2>
          <p>
            Each machine has stateless ingress and egress allow rules. Unmatched
            IPv4 traffic is dropped. Return traffic needs its own matching rule.
            VPC separation, source-address checks, and quarantine remain
            enforced independently of those rules.
          </p>
          <p>
            Inspect packet verdicts and opt into a bounded capture for PCAP
            export. Captures keep the latest 2,048 frames, up to 4 MiB, with a
            2,048-byte snapshot length. They disappear on refresh.
          </p>
        </section>
      </div>
      <section className="trivia-section">
        <header>
          <div className="eyebrow">
            <Leaf size={15} />
            SMALL DISCOVERIES
          </div>
          <h2>A little systems trivia.</h2>
        </header>
        <div className="trivia-grid">
          <article className="trivia-card glass">
            <span>01</span>
            <h3>Your terminal has an address.</h3>
            <p>
              On Pocket PC and Alpine x86_64, <code>tty</code> prints{" "}
              <code>/dev/ttyS1</code>, <code>ttyS2</code>, or <code>ttyS3</code>
              . Each pane talks to a separate emulated serial port and its own
              shell.
            </p>
            <code className="trivia-command">tty; echo $$</code>
          </article>
          <article className="trivia-card glass">
            <span>02</span>
            <h3>The kernel tells you about itself.</h3>
            <p>
              <code>/proc</code> is a virtual filesystem. Entries such as{" "}
              <code>/proc/meminfo</code> report current kernel information when
              you read them.
            </p>
            <code className="trivia-command">head /proc/meminfo</code>
            <a
              href="https://docs.kernel.org/filesystems/proc.html"
              target="_blank"
              rel="noreferrer"
            >
              Linux /proc documentation
              <ExternalLink size={12} />
            </a>
          </article>
          <article className="trivia-card glass">
            <span>03</span>
            <h3>BusyBox wears many hats.</h3>
            <p>
              Many commands in these guests are applets of one BusyBox
              executable. Run it without arguments to see which tools this image
              includes.
            </p>
            <code className="trivia-command">busybox</code>
            <a
              href="https://busybox.net/about.html"
              target="_blank"
              rel="noreferrer"
            >
              About BusyBox
              <ExternalLink size={12} />
            </a>
          </article>
        </div>
      </section>
      <section className="technical-notes glass">
        <div className="card-label">
          A FEW PRACTICAL DETAILS
          <Info size={15} />
        </div>
        <details open>
          <summary>
            What stays after a refresh?
            <ChevronDown size={15} />
          </summary>
          <p>
            Machine names, profiles, boot scripts, VPCs, subnets, packet rules,
            volume attachments, and the selected machine are saved together.
            Object buckets, stored artifacts, and appearance also persist in this browser. Live guest
            memory and command history do not. For Pocket PC and Alpine x86_64,
            explicitly saved checkpoints preserve CPU, memory, and guest files. Keep at most three
            browser snapshots and six evidence archives, or download a backup.
            Temporary investigation and analyst guests are not restored after
            refresh. Durable data volumes and objects persist independently of
            VM checkpoints. Workspace & storage shows interrupted sessions and
            storage estimates, lets you request persistent browser storage, and
            provides Stop & reload. That action syncs and unmounts writable disks
            before stopping guests; a busy disk prevents it. Export backups;
            browser storage can still be cleared.
          </p>
        </details>
        <details>
          <summary>How do I delete resources?<ChevronDown size={15} /></summary>
          <p>
            Cloud resources, Connections, and Snapshots & evidence have explicit
            delete controls. Reviews name dependencies and show what is kept.
            Delete or move attached machines before deleting a subnet; remove
            subnets before their VPC; detach disks before deleting them; empty
            buckets before deleting them. Independent disk snapshots, clones,
            checkpoints, and evidence copies remain until explicitly deleted.
          </p>
          <p>
            The final machine, subnet, or VPC can be deleted. An empty workspace
            stays empty after refresh. Lists update after successful API and UI
            mutations. The Failure injection tab can remove custom identities and queued
            faults. A single tab owns workspace changes; another tab can take
            control after the owner closes. Nothing is automatically executed
            or restored from RAM when the page reopens.
          </p>
        </details>
        <details>
          <summary>
            Which network tools are available?
            <ChevronDown size={15} />
          </summary>
          <p>
            The 32-bit Pocket PC includes <code>curl</code> for HTTP; that build does
            not include TLS. In the Browser bridge, use a guest{" "}
            <code>http://</code> URL and the browser fetches it over HTTPS,
            subject to CORS.
          </p>
          <p>
            The original RISC-V garden image lacks its normal hostname lookup
            libraries. Alpine and Debian include normal resolver libraries and
            their own package managers; package installation also requires a
            reachable repository and a compatible transport. Its{" "}
            <code>webget http://host/path</code> helper uses an explicit numeric
            HTTP proxy through the Browser bridge and preserves the real
            download exit status. With Wisp, applications in the original RISC-V
            garden need numeric destination IPs. LAN traffic between numeric
            guest addresses works normally.
          </p>
        </details>
        <details>
          <summary>
            What does an agent connect to?
            <ChevronDown size={15} />
          </summary>
          <p>
            <code>window.terrarium.list()</code> lists the machines;{" "}
            <code>window.terrarium.get(id)</code> gives a specific machine’s
            command interface. The short <code>boot()</code> and{" "}
            <code>exec()</code> calls target the selected machine. Each guest
            allows one tracked task at a time, with 8 KiB of input, 64 KiB of
            captured output, and a 1–60-second deadline.
          </p>
          <p>
            Each task runs in a fresh noninteractive shell; use absolute paths
            or combine dependent commands. Interactive Pocket PC and Alpine x86_64
            shells stay separate from the agent channel. The page must stay open. No model or remote
            MCP service is connected.
          </p>
          <p>
            An x86_64 machine that is still loading or booting exposes
            {" "}<code>vm.cancelBoot()</code>. It stops that boot and retains the
            machine definition. The original <code>boot()</code> promise rejects;
            handle that result before starting another boot. Cancel boot is also
            available in the machine and Cloud resources controls.
          </p>
          <p>
            Use the browser’s JavaScript developer console for this API; guest
            terminals accept Linux shell commands. A final <code>console.log()</code>
            {" "}evaluates to <code>undefined</code> even when it prints a successful
            result. Evaluate <code>result</code> or <code>result.output</code>
            {" "}to inspect the value. <code>vm.readOutput()</code> reads a serial
            transcript; <code>const stop = vm.mirrorOutput()</code> streams new
            output until you call <code>stop()</code>.
          </p>
        </details>
        <details>
          <summary>
            What downloads when a machine boots?
            <ChevronDown size={15} />
          </summary>
          <p>
            The static site serves v86 and TinyEMU. The x86_64 profile downloads
            its pinned QEMU module and Wasm when needed. Boot downloads guest
            assets from <code>i.copy.sh</code> and pinned{" "}
            <code>raw.githubusercontent.com</code> paths, then checks their
            exact size and SHA-256. The original RISC-V assets match Bellard’s
            official demo byte for byte. Alpine and Debian userspaces are
            fetched from pinned official image repositories. Those upstream
            hosts receive ordinary download requests even when the guest network
            is off.
          </p>
          <p>
            Guest binaries are fetched on demand, not mirrored in the site’s
            build. This version needs an Internet connection to fetch uncached
            boot assets.
          </p>
        </details>
        <details>
          <summary>
            What do pause and reset mean?
            <ChevronDown size={15} />
          </summary>
          <p>
            Pause stops guest execution while retaining its memory. Reset
            discards that guest’s RAM, temporary root files, and processes,
            starts the original image again, and reruns its saved boot script.
            Attached data disks are synced and preserved. Resume a paused guest
            with writable disks before stopping or resetting it. Other
            machines continue independently. Pocket PC and Alpine x86_64
            checkpoints are tied to their own emulator, guest assets, and
            four-port machine profile. Incompatible imports are rejected before
            replacing a running machine.
          </p>
        </details>
        <details>
          <summary>
            Where does the sandbox run?
            <ChevronDown size={15} />
          </summary>
          <p>
            The CPU, kernel, and guest memory run in your browser. There are no
            mounted host folders or model keys. Guest network settings control
            the connections described above. Quarantine blocks guest networking,
            but it does not make the browser an audited malware containment
            environment. This is an experimental local environment; the serial
            command protocol and browser networking are not an audited boundary
            for hostile multi-tenant execution.
          </p>
        </details>
        <details>
          <summary>
            Who made the underlying pieces?
            <ChevronDown size={15} />
          </summary>
          <p>
            Terrarium is an independent interface built with React, xterm.js,
            and Lucide. The 32-bit Pocket PC uses v86; RISC-V uses Fabrice
            Bellard’s TinyEMU; x86_64 uses an experimental QEMU-Wasm build
            reporting QEMU 8.2.0.
            The theme uses locally served DM Sans and
            Manrope. Third-party projects retain their own licenses.
          </p>
          <div className="source-links">
            <a
              href={`${import.meta.env.BASE_URL}runtime/THIRD_PARTY_NOTICES.md`}
              target="_blank"
              rel="noreferrer"
            >
              Third-party notices
              <ExternalLink size={13} />
            </a>
            <a
              href="https://github.com/copy/v86"
              target="_blank"
              rel="noreferrer"
            >
              v86
              <ExternalLink size={13} />
            </a>
            <a
              href="https://bellard.org/tinyemu/"
              target="_blank"
              rel="noreferrer"
            >
              TinyEMU
              <ExternalLink size={13} />
            </a>
            <a
              href="https://github.com/ktock/qemu-wasm"
              target="_blank"
              rel="noreferrer"
            >
              QEMU-Wasm
              <ExternalLink size={13} />
            </a>
            <a href="https://xtermjs.org/" target="_blank" rel="noreferrer">
              xterm.js
              <ExternalLink size={13} />
            </a>
          </div>
        </details>
      </section>
    </>
  );
}
