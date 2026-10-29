# x86_64 machine settings and image API

Terrarium provides a fixed, versioned machine configuration in this experimental prerelease. An installed runtime or development preset does not establish release qualification.

## Configuration

Open **Machine settings** on a stopped x86_64 instance. Choose a hardware preset and built-in or previously verified custom image. The same configuration appears in `cloud.instances.get(id).machine`. The instance retains its NIC identity when settings change.

| Preset target | Guest allocation | Memory layout | Full RAM checkpoint |
| --- | --- | --- | --- |
| Small | 1 vCPU, 512 MiB | One RAM block; original boot behavior | Only the qualified built-in runtime/image, without external disks or evidence |
| Worker | 1 vCPU, 1,024 MiB | One RAM block; APIC enabled | Unavailable |
| Server | 2 vCPUs, 2,048 MiB | Fixed two-block candidate, 1,024 MiB each | Unavailable |

The server requires its separately identified runtime and real qualification. The first single-allocation candidate refused the requested allocation at QEMU's 32-bit host limit. The earlier candidate is retained as failed evidence and cannot be selected as the supported server. A larger Wasm buffer alone does not solve that limit.

The ordinary resource budget allows two active/loading x86_64 runtimes and at most 4,600 MiB of declared Wasm reservation. A 3,584-MiB server therefore needs the budget to itself. Paused guests retain their reservations. Release occurs after confirmed worker termination, storage teardown and settlement of pending input reads. Cancellation discards prepared boot payload references before awaiting a late network attachment. This accounting excludes browser overhead, custom-image bytes and garbage-collection timing; it does not establish capacity for multiple server guests.

The contract `terrarium.x86-machine/v1` contains `presetId`, registered `runtimeBundleId`, `image`, `nic`, four `consoles`, two fixed `diskSlots`, `diskPolicy: 'persistent-mounts'`, and `kernelSettings`. The only configurable kernel setting is a bounded lowercase hostname. The preset/runtime pair fixes CPU and memory topology. Unknown fields, getters, arbitrary arguments, executable image metadata and unregistered runtime URLs are rejected.

Hardware changes require an idle, fully stopped machine. An accepted edit verifies the image, rechecks the same destination, commits the complete saved definition, then updates the runtime. A failed validation or storage write leaves the previous definition intact. Running, paused, loading, stopping, command-busy or permanently quarantined machines cannot use this path to replace their hardware or image.

The built-in guest applies an explicitly configured hostname during fresh-boot setup before user init. Imported image hostnames must agree with their verified manifest. A checkpoint restore preserves its saved guest state and does not rerun hostname setup or init. The VPC instance name and the guest hostname remain separate settings.

## API use

`window.terrarium.cloud` controls the same owners as the UI. The configuration factory is an app-owned public module:

```js
const cloud = window.terrarium.cloud;
const { defaultX86MachineConfiguration } = await import(
  new URL('./runtime/qemu/machine-config.js', document.baseURI).href
);
const machine = defaultX86MachineConfiguration({ presetId: 'worker' });
const instance = await cloud.instances.create({
  name: 'configured-worker', imageId: 'alpine-x86_64', machine
}).wait();

await cloud.instances.update(instance.id, {
  machine: { ...instance.machine, kernelSettings: { hostname: 'worker-one' } }
}).wait();
```

Creating a definition does not start the guest or grant World access. Network policy and resource admission still apply at boot. `cloud.machineImages.presets()` returns the fixed preset descriptors, not a claim of completed acceptance. The factory rejects a server selection if its required runtime is absent.

Instance records return the saved configuration. `window.terrarium.get(id).status().machineConfiguration` identifies the actual active configuration, including a compatible restored checkpoint's identity. The runtime status also exposes the exact active executable bundle and current checkpoint capability. The console command budget remains 8 KiB per command; transfer larger data through separately acknowledged bounded chunks or the intended artifact API.

## Importing and assigning an image

The `.trmimg` contract contains only canonical data: a manifest, x86_64 Linux kernel, compatible initramfs and one raw ext4 root. Component sizes, hashes, devices, consoles, root policy and provenance are checked before storage or machine replacement. The public validators in `public/runtime/qemu/machine-image.js` define the format; `scripts/image-bundle.mjs` packs or inspects bounded component files.

Importing saves an independent image. It does not assign the image to a machine:

```js
// imageFile is the File the user selected from a local .trmimg bundle.
const importing = await cloud.machineImages.import(imageFile);
const image = await importing.wait();
const custom = defaultX86MachineConfiguration({
  presetId: 'worker', image: { kind: 'custom', id: image.id },
  hostname: image.manifest.boot.hostname
});
await cloud.instances.update(instance.id, {
  machine: { ...custom, nic: instance.machine.nic }
}).wait();
```

Unlike immediate compute/network operation handles, `machineImages.import` first verifies the immutable Blob and returns a **promise of a handle**. Full verification runs again before assignment and before execution. The manifest ID binds component digests; it differs from the SHA-256 of the entire downloadable container. Both identities are recorded by the packaging CLI.

The image store admits at most eight bundles and 1 GiB in total. Imports have bounded sizes and reads, but an accepted cloud operation has no cancellation method. The UI can clear a file before import and prevents a controlled reload from racing an in-progress import. Invalid images cannot replace a live or saved machine configuration.

Stopped definitions retain image references. Inspect them through `cloud.deletions.preview({ type: 'image', id })`; deletion rechecks those references under the image lock. Deleting a machine leaves its image independent. `cloud.machineImages.export(id)` returns the original verified Blob. Only an explicit unreferenced image deletion removes it.

## Persistent bytes and large exports

Fresh boot recreates the root overlay. Store durable data under an attached `/mnt/volumes/disk0` or `/mnt/volumes/disk1` volume. These mounts preserve committed data independently of the temporary root; they do not establish working containers or Kubernetes.

The sparse volume store supports logical sizes through 8 GiB with a 64 MiB cache per open volume. Committed nonzero pages consume browser storage. Large raw exports include the full logical zero-filled space and can take several minutes. They require a backpressured sink:

```js
// Obtain selectedFileHandle from an explicit user Save action first.
const writer = await selectedFileHandle.createWritable();
try {
  const result = await cloud.volumes.exportTo(disk.id, writer, {
    signal: abortController.signal,
    onProgress: (written, total) => console.log(written, total)
  });
  await writer.close(); // Publish only after the complete verified stream.
  console.log(result.sha256, result.bytesWritten);
} catch (error) {
  await writer.abort(error).catch(() => {});
  throw error;
}
```

The UI uses a streaming Save file picker above 128 MiB and reports missing browser support clearly. The export holds a read-only volume lock and blocks controlled reload until it finishes. Clean stop synchronizes guest data and drains committed host writes. Abrupt page loss, origin eviction and full RAM preservation are separate guarantees; read [volume documentation](volumes.md) before interpreting a checkpoint or disk snapshot.

## Upgrade and recovery

The authoritative storage key remains `terrarium.workspace.v1`; its envelope becomes `terrarium.workspace/v2`. Valid v0.7 definitions receive stable migrated NIC identities and keep the historical runtime. Direct v0.4 legacy keys migrate under the same workspace writer lock. Empty inventories remain empty. Unknown/corrupt data and failed atomic writes preserve the original source for recovery.

Independent disks, VM checkpoints, evidence archives and object buckets remain separate from the machine inventory. An old checkpoint either uses its exact compatible runtime path or remains inspectable/exportable with an explicit compatibility result. Larger/custom profiles do not acquire RAM-checkpoint support from a UI label or configuration edit.
