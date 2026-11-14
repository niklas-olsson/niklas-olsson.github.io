// SPDX-License-Identifier: Apache-2.0
import { createInternalSockets } from "./channels.js";
import { createPipeMonitor } from "./monitor.js";
import { appendAlpineBootInitramfs } from "./initramfs.js";
import { createSerialPipes } from "./serial.js";
import { installPersistentDisks, installEvidenceDisk } from "./block.js";
import { installCheckpointFile, validateCheckpointDisk } from "./checkpoint.js";
import { validateRawMachineImage } from "./custom-image.js";
import { qemuPresetBootOptions, validateX86MachineConfiguration } from "./machine-config.js";

/** Platform-neutral adapter used by the browser worker and real-kernel harness. */
export async function startQemu(message, { emit, loadModule, pthreadUrl }) {
  const { assets, manifest } = message;
  // Imported images are data only. Revalidate their bounded bytes inside the
  // worker before executable assets are loaded or any guest state is replaced.
  const customImage = message.customImage === undefined ? null : validateRawMachineImage(message.customImage);
  const machine = message.machine === undefined ? null : validateX86MachineConfiguration(message.machine);
  const hardware = machine ? qemuPresetBootOptions(machine) : null;
  if (machine && (machine.runtimeBundleId !== message.runtimeBundleId || machine.nic.mac !== message.mac))
    throw new Error("The engine boot must match its versioned runtime and NIC identity.");
  if (customImage && (!machine || machine.image.kind !== "custom" || machine.image.id !== customImage.id
    || (machine.kernelSettings.hostname ?? "terrarium") !== customImage.manifest.boot.hostname))
    throw new Error("Custom image and hostname must match the versioned machine configuration.");
  if (machine?.image.kind === "custom" && !customImage) throw new Error("The configured custom image was not supplied.");
  if (machine?.presetId === "server" && hardware?.memoryLayout !== "split-2x1024m-ram-blocks-v1")
    throw new Error("The server requires its fixed two-block memory layout.");
  const checkpointSupported = !customImage && (hardware?.checkpointSupported ?? true);
  if (message.checkpoint !== undefined && !checkpointSupported)
    throw new Error("RAM checkpoints are unsupported for this hardware or boot image.");
  let module = null;
  let disks = null;
  let checkpointAttached = false;
  let checkpointOperation = false;
  let ended = false;
  let output = "";
  let outputTimer = null;
  let input = [];
  const readable = new Set();
  const decoder = new TextDecoder();
  const flush = () => {
    if (outputTimer !== null) clearTimeout(outputTimer); outputTimer = null;
    if (output) { emit({ type: "output", port: 0, data: output }); output = ""; }
  };
  const error = (failure) => { if (!ended) emit({ type: "error", message: failure instanceof Error ? failure.message : String(failure) }); };
  const checkpointRejected = (message) => {
    const failure = new Error(message);
    failure.code = "checkpoint_rejected";
    return failure;
  };
  const monitor = createPipeMonitor({ onError: error });
  const serial = createSerialPipes({ onOutput(port, data) { emit({ type: "output", port, data }); } });
  const sockets = createInternalSockets({
    onFrame(frame) { emit({ type: "network", frame: frame.buffer }, [frame.buffer]); },
    onError: error,
  });
  // No guest or emulator socket reaches a native WebSocket implementation.
  globalThis.WebSocket = sockets.Socket;
  const pty = {
    get readable() { return input.length > 0; }, get writable() { return !ended; },
    read(length) { return new Uint8Array(input.splice(0, Math.max(0, Math.min(length, 65_536)))); },
    write(bytes) {
      const source = ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
      for (let at = 0; at < source.length; at += 65_536) {
        // Console data can also arrive from shared Wasm memory. Keep the copy
        // bounded and the streaming decoder intact across character boundaries.
        output += decoder.decode(new Uint8Array(source.subarray(at, at + 65_536)), { stream: true });
        if (output.length >= 16_384) flush();
        else if (outputTimer === null) outputTimer = setTimeout(flush, 16);
      }
    },
    onReadable(fn) { readable.add(fn); return { dispose: () => readable.delete(fn) }; },
    onSignal() { return { dispose() {} }; },
    ioctl(name) {
      if (name === "TCGETS") return { iflag: 0, oflag: 0, cflag: 0, lflag: 0, cc: new Uint8Array(32) };
      if (name === "TIOCGWINSZ") return [100, 30];
      if (name === "TCSETS" || name === "TIOCSWINSZ") return 0;
      throw new Error(`Unsupported console request ${name}.`);
    },
  };
  const init = await loadModule(assets.module);
  const opts = {
    pty,
    wasmBinary: new Uint8Array(assets.wasm),
    // The loader returned by loadModule supplies a verified, local URL for pthread imports.
    mainScriptUrlOrBlob: init.url,
    locateFile(path) {
      if (path === "qemu-system-x86_64.worker.js") return pthreadUrl;
      // Emscripten resolves this name even when wasmBinary supplies all bytes.
      if (path === "qemu-system-x86_64.wasm") return new URL(path, pthreadUrl).href;
      throw new Error(`Unconfigured QEMU runtime asset: ${path}`);
    },
    print: (text) => emit({ type: "diagnostic", message: String(text).slice(0, 4096) }),
    printErr: (text) => emit({ type: "diagnostic", message: String(text).slice(0, 4096) }),
    onAbort: (reason) => error(new Error(`QEMU stopped: ${String(reason).slice(0, 4096)}`)),
    onExit: (code) => { if (!ended) emit({ type: "error", message: `The guest emulator exited (${code}). Stop and boot the machine to reopen it.` }); },
    onRuntimeInitialized() {
      // Emscripten calls C main before the factory's awaiting caller resumes.
      // Install these hooks here so QEMU can never enter xterm-pty's infinite
      // input wait while polling its shared timer and device event loop.
      const { FS, TTY } = this;
      const tty = TTY.stream_ops;
      tty.poll = () => (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
      const read = tty.read;
      tty.read = function (stream, buffer, offset, length) {
        // The host console is fed asynchronously. xterm-pty's original read
        // waits indefinitely when empty, which would suspend QEMU's reactor
        // (including devices and monitor control), regardless of stream flags.
        if (length && !pty.readable) throw new FS.ErrnoError(6);
        return read.call(this, stream, buffer, offset, length);
      };
    },
    arguments: [
      "-nographic", "-M", "pc", "-m", `${hardware?.memoryMiB ?? 512}M`, "-accel", `tcg,tb-size=${hardware?.translationCacheMiB ?? 500}`,
      ...(machine?.presetId === "server" ? [
        // Fixed app-owned topology keeps each anonymous mmap below the pinned
        // libc single-mapping limit while presenting 2 GiB of guest RAM.
        "-smp", "2,sockets=2,cores=1,threads=1,maxcpus=2",
        "-object", "memory-backend-ram,id=terrarium-ram0,size=1024M",
        "-object", "memory-backend-ram,id=terrarium-ram1,size=1024M",
        "-numa", "node,nodeid=0,cpus=0,memdev=terrarium-ram0",
        "-numa", "node,nodeid=1,cpus=1,memdev=terrarium-ram1",
      ] : machine && machine.presetId !== "small" ? ["-smp", String(hardware.virtualCpus)] : []),
      ...(message.checkpoint ? ["-S"] : []),
      "-L", "/pack-rom/", "-nic", "none",
      "-kernel", "/pack-kernel/vmlinuz-virt", "-initrd", "/terrarium-initramfs",
      // The old small path retains its exact command line and PIC workaround.
      // Fixed worker/server presets enable APIC and expose their actual CPUs.
      "-append", hardware?.kernelAppend ?? "console=ttyS0 root=/dev/vda noautodetect hostname=terrarium clocksource=tsc noapic 8250.nr_uarts=4",
      "-drive", "id=root,file=/pack-rootfs/disk-rootfs.img,format=raw,if=none,readonly=on",
      "-device", "virtio-blk-pci,drive=root",
      "-netdev", "socket,id=vmnic,connect=127.0.0.1:8888",
      "-device", "virtio-net-pci,netdev=vmnic,mac=" + message.mac,
      "-serial", "stdio",
      ...[1, 2, 3].flatMap((port) => ["-chardev", `pipe,id=terrarium-serial${port},path=/serial/ttyS${port}`, "-serial", `chardev:terrarium-serial${port}`]),
      ...(message.disks ?? []).flatMap((disk) => [
        "-drive", `id=data${disk.slot},file=/volumes/disk${disk.slot}.raw,format=raw,if=none,readonly=${disk.readOnly ? "on" : "off"},cache=writeback`,
        "-device", `virtio-blk-pci,drive=data${disk.slot},serial=terrarium-volume${disk.slot}`,
      ]),
      ...(message.evidenceImage ? [
        "-drive", "id=evidence,file=/evidence/disk.raw,format=raw,if=none,readonly=on",
        "-device", "virtio-blk-pci,drive=evidence,serial=terrarium-evidence",
      ] : []),
      "-chardev", "pipe,id=terrarium-control,path=/control/qmp",
      // HMP uses QEMU's main loop. This pinned Wasm build's QMP I/O thread
      // stalls guest progress; the private pipe still provides acknowledged
      // stop/continue commands followed by explicit VM status verification.
      "-mon", "chardev=terrarium-control,mode=readline",
    ],
    preRun: [(mod) => {
      monitor.install(mod.FS);
      serial.install(mod.FS);
      disks = installPersistentDisks(mod.FS, message.disks ?? [], emit, error);
      if (message.evidenceImage) installEvidenceDisk(mod.FS, message.evidenceImage);
      installCheckpointFile(mod.FS, message.checkpoint);
      for (const name of customImage ? ["rom"] : ["kernel", "initramfs", "rom", "rootfs"]) {
        const pack = manifest.packages[name];
        const data = new Uint8Array(assets[name]);
        if (data.length !== pack.bytes) throw new Error(`Invalid ${name} package size.`);
        for (const file of pack.metadata.files) {
          const parent = file.filename.slice(0, file.filename.lastIndexOf("/"));
          mod.FS.mkdirTree(parent);
        }
        if (pack.compressedData) {
          mod.LZ4.loadPackage({ metadata: pack.metadata, compressedData: { ...pack.compressedData, cachedChunks: [null, null], cachedIndexes: [-1, -1], data } }, false);
        } else {
          for (const file of pack.metadata.files) mod.FS.writeFile(file.filename, data.subarray(file.start, file.end));
        }
      }
      if (customImage) {
        // Paths and devices belong to the adapter. The manifest cannot choose
        // executable paths, arbitrary emulator arguments, or external backing.
        for (const [key, path] of [["kernel", "/pack-kernel/vmlinuz-virt"], ["initramfs", "/pack-initramfs/initramfs-virt"], ["rootfs", "/pack-rootfs/disk-rootfs.img"]]) {
          mod.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
          mod.FS.writeFile(path, customImage[key], { canOwn: true });
        }
      }
      const original = mod.FS.readFile("/pack-initramfs/initramfs-virt");
      mod.FS.writeFile("/terrarium-initramfs", appendAlpineBootInitramfs(original, "overlay"));
    }],
  };
  try {
    module = await init.factory(opts);
    // Observe the real allocated linear-memory buffer. This is neither guest
    // RAM nor process RSS, and a missing export must not fabricate a sample.
    if (ArrayBuffer.isView(module?.HEAPU8)) {
      emit({ type: "resource-observation", wasmMemoryBytes: module.HEAPU8.buffer.byteLength });
    }
  } catch (failure) {
    ended = true; monitor.close(); serial.close(); disks?.close(); sockets.close(); init.dispose?.();
    (module ?? opts).PThread?.terminateAllThreads?.(); throw failure;
  }
  return {
    input(text, port = 0) {
      if (ended) return;
      if (port !== 0) { serial.input(port, text); return; }
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > 32_768 || input.length + bytes.length > 65_536) throw new Error("The x86_64 console input queue is full.");
      input.push(...bytes);
      for (const listener of readable) listener();
    },
    carrier(enabled) { sockets.setCarrier(enabled); },
    network(frame) { sockets.receive(frame); },
    async pause() {
      await monitor.execute("stop");
      const status = await monitor.execute("query-status");
      if (status?.running !== false || status.status !== "paused") throw new Error("QEMU did not stop guest execution.");
    },
    async resume() {
      if (checkpointOperation || checkpointAttached) throw new Error("Finish the private checkpoint operation before resuming the machine.");
      await monitor.execute("cont");
      const status = await monitor.execute("query-status");
      if (status?.running !== true || status.status !== "running") throw new Error("QEMU did not resume guest execution.");
    },
    async flushDisks() { disks?.flush(); },
    async inspectRegisters() {
      const status = await monitor.execute("query-status");
      if (status.running !== false) throw new Error("Pause the machine before observing CPU registers.");
      return (await monitor.execute("query-registers")).registers;
    },
    async inspectResources() {
      if (ended || checkpointOperation || checkpointAttached)
        throw new Error("Finish the current machine operation before observing translation resources.");
      const status = await monitor.execute("query-status");
      if (status.running !== false || status.status !== "paused")
        throw new Error("Pause the machine before observing translation resources.");
      // A fixed private monitor query. It neither executes a guest command nor
      // resumes CPUs, and excludes engine-native compiled Wasm and process RSS.
      return monitor.execute("query-translation-stats");
    },
    async saveCheckpoint() {
      // Only explicitly bounded no-side-effect refusals are recoverable. An
      // unacknowledged HMP operation remains fatal, including a failed detach.
      if (!checkpointSupported) throw checkpointRejected("RAM checkpoints are unsupported for this hardware or boot image; use persistent data mounts.");
      if ((message.disks ?? []).length || message.evidenceImage)
        throw checkpointRejected("Detach external disks before saving a VM checkpoint.");
      if (checkpointOperation) throw checkpointRejected("A checkpoint operation is already active.");
      checkpointOperation = true;
      try {
        const status = await monitor.execute("query-status");
        if (status.running !== false) throw checkpointRejected("Pause the machine before saving its checkpoint.");
        // The private state backend exists only while CPUs are stopped. It is
        // not a guest-visible disk and is never part of the running block path.
        await monitor.execute("attach-checkpoint");
        checkpointAttached = true;
        await monitor.execute("save-checkpoint");
        await monitor.execute("detach-checkpoint");
        checkpointAttached = false;
        const bytes = module.FS.readFile("/checkpoint/state.qcow2");
        try { validateCheckpointDisk(bytes); }
        catch (failure) {
          // The detached image is disposable and guest execution is still
          // paused. Reject the payload without destroying a healthy machine.
          throw checkpointRejected(failure instanceof Error ? failure.message : String(failure));
        }
        return bytes.buffer;
      } finally { checkpointOperation = false; }
    },
    async restoreCheckpoint() {
      if (!checkpointSupported || !message.checkpoint || (message.disks ?? []).length || message.evidenceImage) throw new Error("Invalid checkpoint restore configuration.");
      if (checkpointOperation) throw new Error("A checkpoint operation is already active.");
      checkpointOperation = true;
      try {
        await monitor.execute("attach-checkpoint");
        checkpointAttached = true;
        await monitor.execute("load-checkpoint");
        await monitor.execute("detach-checkpoint");
        checkpointAttached = false;
        await monitor.execute("stop");
        const status = await monitor.execute("query-status");
        if (status.running !== false) throw new Error("The restored machine did not remain paused.");
        serial.clear();
      } finally { checkpointOperation = false; }
    },
    async destroy() {
      if (ended) return;
      ended = true; input = []; readable.clear(); flush(); serial.close(); disks?.close(); monitor.close(); sockets.close();
      module.PThread?.terminateAllThreads?.(); init.dispose?.();
    },
  };
}
