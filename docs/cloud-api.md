# Terrarium local cloud API

Version: `terrarium.local/v1alpha1`, introduced in Terrarium 0.4.

`window.terrarium.cloud` controls the same machines, VPCs, subnets, and volumes as the interface. A successful mutation completes its real workspace or storage operation. The cloud facade does not provision a remote account or keep machines running after this browser page closes.

Use these examples in the browser's JavaScript developer console. Guest terminals and the agent command workpad accept Linux shell commands instead.

## Resource operations

Reads return promises. Compute, network, and block-volume mutations immediately return an operation handle:

```js
const cloud = window.terrarium.cloud;
const operation = cloud.instances.create({
  name: 'worker-01',
  imageId: 'x86',
  initScript: 'mkdir -p /root/agent-work'
}, { idempotencyKey: 'worker-01-create' });

operation.id;
operation.get();                // queued, running, succeeded, or failed
const instance = await operation.wait();
await cloud.instances.start(instance.id).wait();
const vm = window.terrarium.get(instance.id);
const result = await vm.exec('uname -a');
result;
```

The final expression returns the command result object. `console.log(result.output, result.exitCode)` prints the output and exit code but evaluates to `undefined`, as defined by the [Console Standard](https://console.spec.whatwg.org/#log). A successful `exec` result has an observed exit code; timeouts and interrupted runs can have `exitCode: null`.

Instance creation saves a definition without allocating an emulator. Start boots it. Pause retains guest memory; resume continues it. Stop discards RAM and the temporary root filesystem, syncing writable data volumes first. A paused guest with writable disks must be resumed before stop. Delete removes the definition and leaves separate stored volumes available. Zero instances, zero VPCs, and VPCs with zero subnets are valid saved states; deleting the last resource does not recreate a default resource. There is no upper machine-count limit. Browser capacity and available subnet addresses still apply. An empty workspace needs a VPC and subnet before an instance can be created.

| API | Methods |
| --- | --- |
| `images` | `list()`, `get(id)` |
| `machineImages` | `presets()`, `list()`, `get(id)`, `import(blob, options?)`, `export(id)`, `delete(id, options?)` |
| `instances` | `list()`, `get(id)`, `create(input, options?)`, `update(id, {name?, initScript?, machine?}, options?)`, `start`, `pause`, `resume`, `stop`, `delete` |
| `instances` networking | `setNetwork(id, 'isolated' \| 'local' \| 'world')`, `configureTransport`, `setPolicy`, `move` |
| `instances` storage | `attachVolume(id, {volumeId, slot?, readOnly?})`, `detachVolume(id, volumeId)`, `syncVolumes(id)` |
| `vpcs` | `list()`, `get(id)`, `create(input)`, `update(id, {name})`, `delete(id)` |
| `subnets` | `list(vpcId)`, `get(vpcId, id)`, `create(vpcId, input)`, `update(vpcId, id, {name?, cidr?})`, `delete(vpcId, id)` |
| `volumes` | `list()`, `get(id)`, `create({name, sizeMiB})`, `snapshot(id, {name})`, `clone(id, {name})`, `exportTo(id, sink, options?)`, `delete(id)` |
| `metadata` | `describe(instanceId)` |
| `operations` | `list()`, `get(operationId)`, `wait(operationId)` |
| `events` | `list(afterSequence?)`, `subscribe(listener)` returning an unsubscribe function |
| `deletions` | `preview({type, id, vpcId?, bucket?})` for a live dependency and preservation summary |
| `cloud` | `subscribe(listener)` for operation events and resource invalidations; `assertSettled()` for the controlled-reload guard |

All listed mutations accept a final request options object. Input and lifecycle validation can reject a request immediately. Accepted operations expose errors on their state and reject `.wait()` when their real provider callback fails. `CloudError` has `code`, `message`, and an operation ID when applicable.

Resource responses include `apiVersion`, `resourceType`, and a stable resource URN. Instance records expose actual runtime status, profile, memory allocation, attachment, network mode, quarantine, command/operation readiness, and `canCancelBoot` for supported runtimes. Image records come from the bootable profile registry. `metadata.describe` reads this live registry; there is no guest HTTP metadata endpoint.

### x86_64 settings and imported Linux images

See [machine settings and image API](machine-settings.md) for S2's versioned hardware contract, custom image import/assignment, checkpoint limits and streamed exports. A successful import saves an independent image; it does not replace a machine. `machineImages.import(blob)` first verifies an immutable Blob and therefore returns a **promise of an operation handle**. Other compute/network handles remain immediate. `volumes.exportTo` is a backpressured read with its own promise and a controlled-reload fence.

### Ordering, events, and retries

Operations hold locks for the resources they change. Mutations on the same instance serialize; independent instances can operate concurrently. Network inventory changes share a lock. Attachment and volume mutations also coordinate by volume ID. The underlying runtime/store enforces its own lifecycle, read-only, quarantine, and transaction protections.

```js
const stopEvents = cloud.events.subscribe(event => console.log(event));
cloud.operations.list();
stopEvents();
```

History retains the most recent 200 completed operations and 500 events. It is in-memory and belongs to this open page. An idempotency key reuses the original operation for the same retained request, including its original failure. Reusing that key with changed input or identity rejects with `idempotency_conflict`. A fresh retry after an injected failure needs a new key, or no key. Idempotency is not durable across reloads or after history eviction. Cloud operation handles do not have a cancellation API.

An x86_64 instance that is actively loading or booting can be interrupted through `await window.terrarium.get(id).cancelBoot()`, or **Cancel boot** in the interface. This goes directly through the guarded workspace lifecycle, so it can interrupt a running `cloud.instances.start(id)` while that cloud operation unwinds. It retains the definition and separate stored disks. The interrupted start fails; callers must handle its rejected `.wait()` or `boot()` promise. Cancelling a boot does not cancel later queued cloud operations. `cloud.instances.stop(id)` still follows the normal instance queue and is not an immediate boot-cancellation call. Wait for cancellation to finish before requesting deletion.

Object-store data calls return their own promises and are not control-plane operations. Commands sent through `vm.exec()` use the machine's runner history. Existing direct runtime/UI methods continue to enforce their own locks but do not create cloud operation entries unless they go through this facade.

`cloud.subscribe` also emits `{type: 'resource.changed', at, resourceType, resourceId, action, scope?}` after successful object, bucket, volume, identity, and fault changes. Object events use `scope` for the bucket and `resourceId` for the object key; broad inventory invalidations can have a null resource ID. Storage notifications reach other handles and browser tabs, so consumers should reread current data instead of treating an event as a resource record. Identity/fault changes remain page-local. `cloud.events` is still the bounded operation-only journal.

### Workspace ownership and controlled reload

The application has one writable browser tab per workspace. A tab still opening storage, a read-only tab, a conflicting or corrupt saved manifest, or a workspace preparing to reload rejects mutations. Reads remain available. The cloud adapter checks ownership for every workspace and volume mutation, and the singleton applies the same guard to object writes and simulation configuration. Ownership is checked again after injected latency and before an object transaction begins. A simulated identity cannot bypass this guard or permanent quarantine.

`cloud.assertSettled()` throws while a cloud operation is queued/running or an object-store write is hashing or committing. The controlled reload flow invokes this guard before stopping guests. Failed conditional writes also finish before the guard clears. A shared resource fence then prevents new bucket, object, volume, checkpoint, or evidence mutations from starting during the reload preparation. The method does not itself stop a guest, save its memory, or reload the page.

## Safe deletion without a reload

Every user-created instance, VPC, subnet, block volume, disk snapshot, bucket, object, simulated identity, and queued fault has a delete path. Deletion changes the live inventory and its persistence; no page reload is needed. Built-in image profiles and the reserved `local` simulation owner are not user-created resources.

Inspect dependencies before presenting a confirmation:

```js
const preview = await cloud.deletions.preview({
  type: 'volume', id: disk.id
});
preview.allowed;
preview.blockers; // {type, id, name, message, vpcId?, bucket?}
preview.preserves;

// Bind these conditions to the resource the user reviewed. Do not silently
// replace them with a later revision while the confirmation is open.
if (preview.allowed) {
  await cloud.volumes.delete(disk.id, {
    ifRevision: preview.revision,
    ...(preview.sha256 ? { ifSha256: preview.sha256 } : {})
  }).wait();
}
```

Preview targets are `instance`, `vpc`, `subnet`, `volume`, `image`, `bucket`, `object`, `identity`, and `fault`. Subnet targets require `vpcId`; object targets use their key as `id` and require `bucket`. Results include `exists`, `allowed`, `name`, named `blockers`, `preserves`, and applicable `revision`, `sha256`, or `generation` tokens. A preview is advisory: each owner rechecks dependencies and conditions during the actual deletion. A resource becoming busy or acquiring a dependency after preview can still reject deletion safely.

| Resource | Delete condition | What remains |
| --- | --- | --- |
| Instance | No command or lifecycle operation is busy; writable guest filesystems must be syncable | Data disks, disk snapshots, VPC/subnets, saved VM checkpoints, and evidence archives |
| Subnet | No instance definition is attached, including stopped or quarantined instances | Its VPC and all independent storage |
| VPC | No instances and no child subnets; delete each subnet explicitly | Independent disks, objects, checkpoints, and evidence |
| Volume or disk snapshot | No configured or pending attachment, no active storage lock, and supplied revision/digest still matches | Independent snapshots and clones, which hold their own bytes |
| Bucket | Empty; an optional generation token must still match | Other buckets |
| Object | Supplied revision, digest, and generation conditions must still match | Its bucket and other objects |
| Simulated identity | User-created identity; an optional policy revision must still match | Resources previously created by that identity |
| Queued fault | The same fault ID is still queued | Other rules and already dispatched operations |

For example, remove an unused network explicitly from the leaves upward:

```js
await cloud.instances.delete(worker.id).wait();
for (const subnet of await cloud.subnets.list(vpc.id)) {
  await cloud.subnets.delete(vpc.id, subnet.id).wait();
}
await cloud.vpcs.delete(vpc.id).wait();
```

There is no implicit recursive delete or force-detach. Dependency errors identify the machines or child resources to address. Instance deletion waits for the manager's sync/teardown and manifest commit before dropping the live definition. Volume attachment and deletion serialize by volume ID, with a further workspace deletion lease and storage lock protecting calls outside the cloud queue.

## Real private networks

```js
const vpc = await cloud.vpcs.create({
  name: 'systems-lab',
  cidr: '10.42.0.0/16',
  subnets: [
    { name: 'application', cidr: '10.42.10.0/24' },
    { name: 'analysis', cidr: '10.42.20.0/24' }
  ]
}).wait();

const worker = await cloud.instances.create({
  name: 'worker-02', imageId: 'alpine-riscv64',
  vpcId: vpc.id, subnetId: vpc.subnets[0].id
}).wait();
await cloud.instances.setNetwork(worker.id, 'local').wait();
await cloud.instances.start(worker.id).wait();
await cloud.metadata.describe(worker.id);
```

VPCs contain actual page-local switching and IPv4 routing, using the same policy and packet-capture path as Connections. Current topology limits are up to four VPCs with up to four /24 subnets each; empty inventories are legal. Occupied subnet CIDRs cannot change. Subnet deletion requires no attached instance definitions, and VPC deletion additionally requires all child subnets to be deleted explicitly. A machine must be stopped before moving its attachment. An assigned source address cannot impersonate a peer, and other VPCs are not reachable through the World backend.

Private DNS at the subnet gateway resolves `<machine-name>.terrarium.internal` to its configured IPv4 address within the requester’s VPC. The exact short alias also works, subject to guest resolver conventions. Quarantined guests are excluded; missing and foreign-VPC private names return NXDOMAIN without outside fallback. Ordinary stopped instances retain records, so these are configuration records rather than health checks. The service returns A records only; AAAA receives a successful empty answer. BusyBox `nslookup` can therefore print an extra “No answer” for its AAAA query even when the A lookup succeeds. The original RISC-V garden lacks normal resolver libraries and continues to need numeric addresses.

Network modes, transport configuration, and stateless policies are documented in the README. No peering, public inbound forwarding, load balancer, connection-tracked security groups, or remote network service is claimed. Permanent checkpoint-quarantine ports cannot be released or reattached through this API.

## Persistent volumes

```js
const disk = await cloud.volumes.create({ name: 'case-data', sizeMiB: 16 }).wait();

// Stop the earlier x86 instance; this discards its guest RAM.
await cloud.instances.stop(instance.id).wait();
// Slot 0 must be free.
await cloud.instances.attachVolume(instance.id, {
  volumeId: disk.id, slot: 0
}).wait();
await cloud.instances.start(instance.id).wait();
await window.terrarium.get(instance.id).exec(
  'printf "captured\\n" > /mnt/volumes/disk0/note.txt; sync'
);
await cloud.instances.syncVolumes(instance.id).wait();
await cloud.instances.stop(instance.id).wait();
const snapshot = await cloud.volumes.snapshot(disk.id, { name: 'case-001' }).wait();
const clone = await cloud.volumes.clone(snapshot.id, { name: 'case-working-copy' }).wait();
snapshot;
```

This snippet continues with `instance` from the earlier compute example. Attach/detach configuration changes require a stopped Pocket PC or Alpine x86_64 guest. Each exposes two independently addressed slots, mounted at `/mnt/volumes/disk0` and `disk1` before init; slot 1 does not require slot 0. Snapshots always attach read-only, with host enforcement even if guest code bypasses filesystem flags. A source disk must be closed before copying. Stop/delete syncs and unmounts writable disks; a busy mount blocks shutdown, and a paused writable guest must be resumed first. Configured volume references must be detached before deletion through the cloud facade.

See [Persistent volumes](volumes.md) for the full storage, synchronization, snapshot, export, and forensic semantics. These are genuine data block disks. A full VM memory checkpoint remains a different artifact, and external disks cannot be included in a VM checkpoint.

## Object buckets and artifacts

`cloud.objectStore` is a real browser IndexedDB data service with SHA-256 verification. It has no S3 or guest HTTP endpoint. A bucket must be empty before deletion.

```js
const store = cloud.objectStore;
await store.buckets.create({ name: 'artifacts' });
const first = await store.objects.put('artifacts', 'agent/report.txt', 'first', {
  contentType: 'text/plain;charset=utf-8',
  metadata: { producer: 'agent-01' },
  ifNoneMatch: true
});
const second = await store.objects.put('artifacts', 'agent/report.txt', 'revised', {
  ifRevision: first.revision
});
const object = await store.objects.get('artifacts', 'agent/report.txt');
new TextDecoder().decode(object.body);
```

| Operation | Behavior |
| --- | --- |
| `buckets.list/get/create/delete` | Persistent bucket metadata; rejects duplicate names and nonempty deletion |
| `objects.list(bucket, {prefix?})` | Metadata listing, optionally filtered by key prefix |
| `objects.head(bucket, key)` | Current metadata without body |
| `objects.get(bucket, key)` | Metadata plus copied `Uint8Array` body; verifies SHA-256 |
| `objects.put(bucket, key, data, options?)` | Stores string, Uint8Array, or ArrayBuffer data and advances revision |
| `objects.delete(bucket, key, conditions?)` | Removes one object, optionally only if it still matches |

`ifNoneMatch: true` requires a new key. `ifMatch` requires the exact stored SHA-256. `ifRevision` requires the current revision and detects updates to the same live object even if content cycles back to the same digest. A deleted and recreated key starts a new `generation`, so use `ifGeneration` with a reviewed revision for safe conditional deletion. Buckets also have generations, and `buckets.delete(name, {ifGeneration})` rejects a recreated same-name bucket. Existing records remain readable with a stable legacy generation token. Condition checks and metadata/body updates share an atomic IndexedDB transaction. Put options can include a content type and text metadata.

```js
const selected = await store.objects.head('artifacts', 'agent/report.txt');
await store.objects.delete(selected.bucket, selected.key, {
  ifRevision: selected.revision,
  ifGeneration: selected.generation
});
const emptyBucket = await store.buckets.get('artifacts');
await store.buckets.delete(emptyBucket.name, {
  ifGeneration: emptyBucket.generation
});
```

Each object is at most 64 MiB. Browser quota errors are surfaced. There is no historic version archive or remote replication. Clearing or evicting site storage removes the data; downloads are the portable backup path.

## Failure injection and simulated policies

The simulator is opt-in and defaults to unrestricted local simulation ownership with no faults. Its allow/deny rules apply only to cloud control-plane mutations. Reads and object data access are outside those simulated policies. Actual workspace ownership, lifecycle, write protection, and quarantine still apply, including to the `local` identity. These controls test agent behavior through local failure injection and simulated policies. They do not authenticate users, isolate tenants, or implement AWS IAM.

```js
cloud.simulation.identities.set({
  id: 'agent',
  allow: ['instances.*'],
  deny: ['instances.delete']
});

// Deliberately fail the next matching operation before provider execution.
cloud.simulation.faults.next({
  action: 'instances.start', delayMs: 1000, fail: true,
  message: 'Injected capacity failure'
});

const trial = cloud.instances.start(instance.id, { identity: 'agent' });
try { await trial.wait(); } catch (error) {
  console.log(error.code, error.message);
}
trial.get();
```

Identity allow/deny rules match explicit supported actions or wildcard action groups; deny wins. Unknown or unauthorized identities produce `access_denied`. A fail-next rule produces `injected_failure` before calling the real provider; delay-only rules call the real provider after the delay. Identity authorization is rechecked after a delay. Successful operations cannot be manufactured by the simulator.

`cloud.simulation.actions` lists supported mutation actions. `identities.list/get/set/delete` and `faults.list/next/delete/clear` inspect and configure failure injection and simulated policies. Identity records have a revision; `identities.delete(id, {ifRevision})` rejects a policy changed since selection. `faults.delete(id)` removes one queued rule, while `faults.clear()` removes all queued rules. Neither cancels an operation that has already consumed a fault. Identity deletion is also checked by delayed operations when they dispatch. Policies and queued faults belong to the open page and do not survive a reload. The built-in `local` owner identity cannot be removed or restricted.

## Validation boundary

Repeatable unit and actual-guest smoke checks are recorded in [validation.md](validation.md). Node smoke tests use the real emulator/kernel and browser API shims; IndexedDB fixtures verify transaction paths without claiming browser crash durability, eviction resistance, or visual QA. The static application can be hosted on GitHub Pages; optional outside TCP still requires an explicitly configured Wisp relay.
