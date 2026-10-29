// SPDX-License-Identifier: Apache-2.0
import type { CloudObjectStore } from "./cloud-object-store.ts";
import type { CloudSimulation } from "./cloud-simulation.ts";
import { CloudError, type CloudDeletionBlocker, type CloudDeletionPreview, type CloudDeletionTarget, type CloudProvider } from "./cloud-types.ts";

/** Advisory live dependency view. Resource owners recheck every actual deletion. */
export function createDeletionInspector(provider: CloudProvider, store: CloudObjectStore, simulation: CloudSimulation) {
  return Object.freeze({
    preview: async (input: CloudDeletionTarget): Promise<CloudDeletionPreview> => {
      if (!input || !["instance", "vpc", "subnet", "volume", "image", "bucket", "object", "identity", "fault"].includes(input.type) || typeof input.id !== "string" || !input.id || input.id.length > 1024) throw new CloudError("invalid_argument", "Choose an existing resource type and ID.");
      if (input.type === "subnet" && (typeof input.vpcId !== "string" || !input.vpcId)) throw new CloudError("invalid_argument", "A subnet deletion preview requires its VPC ID.");
      if (input.type === "object" && (typeof input.bucket !== "string" || !input.bucket)) throw new CloudError("invalid_argument", "An object deletion preview requires its bucket.");
      const target: CloudDeletionTarget = { type: input.type, id: input.id, ...(input.vpcId === undefined ? {} : { vpcId: input.vpcId }), ...(input.bucket === undefined ? {} : { bucket: input.bucket }) };
      const blockers: CloudDeletionBlocker[] = []; const preserves: string[] = [];
      let exists = false, name = target.id, revision: number | undefined, sha256: string | undefined, generation: string | undefined;
      const machineBlockers = (machines: Awaited<ReturnType<CloudProvider["instances"]["list"]>>, message: string) => {
        for (const machine of machines) blockers.push({ type: "instance", id: machine.id, name: machine.name, message: `${message} ${machine.name} (${machine.status}).` });
      };
      if (target.type === "instance") {
        const machine = (await provider.instances.list()).find((item) => item.id === target.id);
        if (machine) {
          exists = true; name = machine.name;
          if (machine.commandBusy || machine.operation) blockers.push({ type: "operation", id: machine.id, name: machine.name, message: `Wait for ${machine.name}'s current command or lifecycle operation to finish.` });
          if ((machine.status === "loading" || machine.status === "booting") && !machine.canCancelBoot) blockers.push({ type: "operation", id: machine.id, name: machine.name, message: `Wait for ${machine.name} to finish booting before deleting it.` });
          if (machine.status === "paused" && machine.volumeAttachments.some((volume) => !volume.readOnly)) blockers.push({ type: "instance", id: machine.id, name: machine.name, message: `Resume ${machine.name} so its writable guest filesystems can be synced before deletion.` });
          preserves.push("Data volumes and independent disk snapshots remain in storage.", "VPCs, subnets, saved VM checkpoints, and evidence archives remain available.");
        }
      } else if (target.type === "vpc" || target.type === "subnet") {
        const vpcId = target.type === "vpc" ? target.id : target.vpcId!;
        const vpc = (await provider.vpcs.list()).find((item) => item.id === vpcId);
        const subnet = target.type === "subnet" ? vpc?.subnets.find((item) => item.id === target.id) : undefined;
        exists = target.type === "vpc" ? Boolean(vpc) : Boolean(subnet);
        if (exists) {
          name = target.type === "vpc" ? vpc!.name : subnet!.name;
          const attached = (await provider.instances.list()).filter((machine) => machine.vpcId === vpcId && (target.type === "vpc" || machine.subnetId === target.id));
          machineBlockers(attached, "Move or delete attached instance");
          if (target.type === "vpc") for (const child of vpc!.subnets) blockers.push({ type: "subnet", id: child.id, vpcId, name: child.name, message: `Delete child subnet ${child.name} explicitly first.` });
          preserves.push("Stored disks, objects, VM checkpoints, and evidence archives remain available.");
        }
      } else if (target.type === "volume") {
        if (!provider.volumes) throw new CloudError("unsupported", "No durable volume provider is installed.");
        const volume = (await provider.volumes.list()).find((item) => item.id === target.id);
        if (volume) {
          exists = true; name = volume.name; revision = volume.revision; sha256 = volume.sha256 ?? undefined;
          machineBlockers((await provider.instances.list()).filter((machine) => machine.volumeAttachments.some((attachment) => attachment.volumeId === target.id)), "Stop and detach this disk from instance");
          preserves.push("Independent disk snapshots and clones retain their own bytes.");
        }
      } else if (target.type === "image") {
        if (!provider.machineImages) throw new CloudError("unsupported", "No custom image provider is installed.");
        const image = await provider.machineImages.get(target.id);
        if (image) {
          exists = true; name = image.name; sha256 = image.id;
          machineBlockers((await provider.instances.list()).filter(machine => machine.machine?.image.kind === "custom" && machine.machine.image.id === target.id), "Change or delete this image's dependent instance");
          preserves.push("Other custom images, independent volumes, preserved checkpoints and evidence remain available.");
        }
      } else if (target.type === "bucket") {
        const bucket = (await store.buckets.list()).find((item) => item.name === target.id);
        exists = Boolean(bucket); generation = bucket?.generation;
        if (exists) for (const object of await store.objects.list(target.id)) blockers.push({ type: "object", id: object.key, bucket: target.id, name: object.key, message: `Delete object ${object.key} explicitly first.` });
      } else if (target.type === "object") {
        try {
          const object = await store.objects.head(target.bucket!, target.id);
          exists = true; revision = object.revision; sha256 = object.sha256; generation = object.generation;
          preserves.push("The bucket and its other objects remain available.");
        } catch (error) { if (!(error instanceof CloudError && error.code === "not_found")) throw error; }
      } else if (target.type === "identity") {
        const identity = simulation.identities.list().find((item) => item.id === target.id);
        if (identity) {
          exists = true; revision = identity.revision;
          if (identity.id === "local") blockers.push({ type: "identity", id: identity.id, name: "Local page owner", message: "The built-in local page owner is reserved; user-created identities can be deleted." });
          preserves.push("Resources created by this simulated identity remain. Pending mutations must pass the current policy at dispatch.");
        }
      } else {
        exists = simulation.faults.list().some((fault) => fault.id === target.id);
        preserves.push("Operations that already consumed a fault continue with that fault; deleting a queued rule only affects future dispatches.");
      }
      if (!exists) blockers.push({ type: target.type, id: target.id, name, message: "This resource is no longer present." });
      try { provider.assertWritable?.(); } catch (error) { blockers.push({ type: "operation", id: "workspace", name: "Workspace ownership", message: error instanceof Error ? error.message : "The workspace is currently read-only." }); }
      return { target, exists, allowed: exists && blockers.length === 0, name, blockers, preserves, ...(revision === undefined ? {} : { revision }), ...(sha256 === undefined ? {} : { sha256 }), ...(generation === undefined ? {} : { generation }) };
    },
  });
}
