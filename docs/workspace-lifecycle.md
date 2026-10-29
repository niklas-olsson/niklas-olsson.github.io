# Workspace lifecycle and recovery

Introduced in Terrarium 0.5 and extended to Alpine x86_64 in 0.7. Terrarium implements guarded resource removal and configuration recovery. It does not add automatic RAM checkpoints, a persistent root filesystem, a durable command journal, or background compute after the page closes.

## Delete resources without reloading

The resource views expose delete controls for instances, VPCs, subnets, writable volumes, disk snapshots and clones, object buckets and objects, manual VM checkpoints, evidence archives, simulated identities, and queued faults. The final machine, VPC, or subnet can be removed. Empty inventories are valid saved states.

The app presents the selected resource and its consequences before a destructive click. Cloud/network dialogs read dependencies again at confirmation; the resource owner also checks dependencies when applying the change. Storage deletion can bind to the revision, generation, or hash that the user reviewed, so a stale confirmation cannot delete a replaced object or changed disk silently. Successful mutations publish invalidations and views reread their stores without a page reload.

| Resource | Required preparation | Independent resources retained |
| --- | --- | --- |
| Machine | Finish its command, checkpoint, evidence or volume operation. Finish boot, or use **Cancel boot** for Alpine x86_64 and wait for cancellation. Resume a paused guest with writable disks. Running writable filesystems must unmount successfully. | Data disks, disk snapshots/clones, VM checkpoints, evidence, VPCs and subnets |
| Subnet | Delete or move all attached machine definitions, including stopped machines | Parent VPC and storage |
| VPC | Delete attached machines and explicitly remove its subnets | All storage |
| Volume, clone, disk snapshot | Detach every configured reference; no active/pending device or storage lease | Separate disk copies and other resources |
| Object | Reviewed generation/revision/hash still matches if conditions were supplied | Bucket and other objects |
| Bucket | Remove every object, including keys outside the current prefix filter | Other buckets |
| VM checkpoint or evidence | Reviewed hash matches if supplied | Already loaded quarantine/analyst copies and unrelated artifacts |
| Simulated identity | Custom identity, with matching policy revision if supplied | Previously created resources |
| Queued fault | Same fault ID is still pending | Other faults and operations already dispatched |

Image profiles and the reserved `local` simulation owner are built-in definitions, not created resources. Boot scripts and packet rules are edited or cleared on their machine. Packet-capture data has an explicit clear confirmation. There is no implicit cascading deletion, force-detach, or trash/undo feature.

## Orderly machine removal

Workspace Stop and Delete share the same shutdown path. They gate new commands/lifecycle changes first. For a running Pocket PC or Alpine x86_64 guest with writable disks:

1. The guest executes `sync` and unmounts every writable data filesystem.
2. If a filesystem is busy, the shutdown refuses deletion and restores any earlier unmounted volumes. The definition and disk bytes are retained. Close processes whose files or working directory use the disk, then retry.
3. The emulator CPU stops and outstanding VirtIO requests and IndexedDB writes drain. The CPU remains stopped between this step and teardown.
4. Teardown ends emulator execution, disposes devices, and releases storage locks. Only after successful teardown is the activity record cleared. Browser memory reclamation is controlled by the browser and is not inferred from this lifecycle completion.
5. Delete commits a manifest that excludes the machine before removing its live definition and network port. A storage/revision failure leaves the stopped definition visible for retry.

If shutdown or rollback cannot be confirmed, the app reports the failure and preserves the disk records. A machine already in an error state cannot promise to flush guest memory; teardown can only drain submitted disk writes. Independent persistent disks are never deleted as a side effect of machine removal.

Saved JavaScript handles are revoked when the definition is removed. `vm.boot()`, `vm.exec()`, and reads against an old handle fail; they cannot recreate an unregistered emulator. Concurrent deletion, boot and command attempts fail while the manager owns teardown. Guest root RAM and processes are deliberately discarded by Stop/Delete; export or checkpoint anything needed before doing so.

## Atomic configuration

`terrarium.workspace.v1` is a versioned manifest containing:

- All persistent machine definitions, boot scripts, network policies, and disk attachments.
- VPC and subnet configuration.
- The selected persistent machine.
- The last non-idle state recorded for each persistent machine.
- A schema, monotonically increasing revision, and save timestamp.

A single `localStorage.setItem` replaces the whole manifest. Configuration is no longer spread across independently committed machine/VPC keys. A revision check refuses an obsolete writer. This is configuration atomicity at the browser storage API level, not a physical power-loss guarantee.

The first load migrates valid older machine/VPC keys. Once a new manifest exists, it is authoritative, including empty lists. Legacy keys are not a fallback and cannot resurrect deleted resources. A malformed or unsupported saved manifest opens an error state without overwriting it or silently skipping individual resources. Configuration export remains available for diagnosis when the underlying storage can be read.

The browser uses an exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) for the writable workspace tab. Other tabs cannot boot guests or mutate shared workspace resources through the supported interface/API. They can inspect their loaded inventory and stored artifacts. After the owner closes, **Take control / retry** acquires the lock and adopts the current saved inventory before allowing changes. No lock stealing is used. Read-only tabs may have an older compute inventory until takeover; storage invalidations refresh stored artifact lists.

Startup attempts ownership once without waiting. A newly opened page can remain read-only if that attempt overlaps the previous document's lock retirement, including after an abrupt close. Once the previous owner closes, use **Take control / retry**; the page does not automatically promote itself. Session timestamps are recovery information, not expiring ownership leases. A live owner's lock remains exclusive regardless of elapsed time.

## Reopening and controlled reload

Normal refresh restores definitions and their selection as stopped machines. Stored volumes, manual checkpoints, evidence, and objects remain in IndexedDB. Temporary analyst and quarantine guests are omitted from the manifest. Saved World access becomes Local; outside access requires an explicit new decision.

An activity marker indicates that a guest was running, paused, booting, loading, or failed when the prior page ended. **Workspace & storage** lists these machines. Opening a machine lets the user inspect its definition and choose a fresh Boot. **Acknowledge** clears only the interrupted-session notice. It neither deletes the machine nor reruns a command. Compatible manual Pocket PC and Alpine x86_64 checkpoints can be restored through Snapshots & evidence.

**Stop & reload** checks active cloud operations, object/artifact writes, pending attachments/deletions, guest commands, and runtime maintenance. It fences new mutations, performs orderly stops, commits the final manifest, and only then reloads. Failure leaves the page open with a reason. Read-only exports remain possible during the storage fence. There is no asynchronous unload checkpoint assumption.

The page API exposes the same coordinator:

```js
window.terrarium.workspace.status();
await window.terrarium.workspace.prepareReload();
// All guests are stopped. This call itself does not navigate.
window.location.reload();
```

Other methods are `takeControl()`, `acknowledgeRecovery(machineId)`, and `exportManifest()`. The exported JSON contains configuration and boot scripts, not disk/object/checkpoint/evidence bytes. It is a diagnostic copy, not a complete importable workspace bundle.

## Browser storage and remaining limits

Workspace & storage displays `navigator.storage.estimate()` and `persisted()`, and offers a user-initiated [`persist()` request](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist). The browser can decline it. A grant reduces automatic eviction; it cannot prevent explicit site-data removal, origin changes, browser-profile loss, or hardware failure. Export independent data artifacts as backups.

Current durable data paths are the extra Pocket PC and Alpine x86_64 ext2 volumes and browser object/artifact stores. All supplied root filesystems remain temporary. Ordinary refresh loses CPU/RAM, processes, terminal output, command history, cloud operation/idempotency history, and simulation settings. No arbitrary task is automatically rerun after an unknown outcome. ext2 is not journaled; abruptly closing a guest can leave incomplete filesystem/application operations despite committed individual block writes. There is no automatic fsck or coherent multi-machine RAM-plus-disk restore in this release.

These mechanisms remain compatible with static GitHub Pages hosting: compute and persistence occur in the visitor's browser. Moving the app to a different origin does not migrate its local data.

## Verification

`npm run test:lifecycle` uses real Linux, VirtIO and ext2 to exercise sync failure, a busy mount and rollback, deletion while commands/boots race, revoked handles, empty-manifest reopen, and preserved disks read by a fresh VM. `npm run test:workspace` reconstructs six definitions and boots the fifth and sixth independently. Pure manifest tests cover failed saves, stale writers, empty inventories, invalid data and orphaned activity markers. Storage tests cover conditional deletion, dependency leases, notification timing and reload fences. These Node checks use browser storage shims; they do not establish real-browser eviction, crash/power-loss behavior, or visual QA.

`npm run test:qemu-storage` applies the same committed-volume and guarded-shutdown contracts to the actual x86_64 kernel, including busy unmount refusal, reset, independent reopening, read-only snapshots, writable clones and evidence acquisition/mounting. The checks actually completed are recorded in [validation](validation.md).
