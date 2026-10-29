// SPDX-License-Identifier: Apache-2.0
import type { MachineWorkspace } from "./machines.ts";
import { RUNTIME_PROFILES, isRuntimeProfileId } from "./runtime-profiles.ts";
import { CloudError, type CloudInstanceRecord, type CloudProvider, type CloudVolumeDeleteConditions } from "./cloud-types.ts";
import { X86_MACHINE_PRESETS } from "./x86-machine-config.ts";
import { listMachineImages, getMachineImage, importMachineImage, exportMachineImage, deleteMachineImage, subscribeMachineImageChanges } from "./machine-image-store.ts";

export type CloudVolumeStoreAPI = Pick<typeof import("./volume-store.ts"), "listVolumes" | "getVolume" | "createVolume" | "snapshotVolume" | "cloneVolume" | "deleteVolume"> & Partial<Pick<typeof import("./volume-store.ts"), "subscribeVolumeChanges" | "exportVolumeTo">>;

/** This adapter holds no duplicate resource inventory; every read comes from its owner. */
export function createWorkspaceCloudProvider(workspace: MachineWorkspace, storage?: CloudVolumeStoreAPI): CloudProvider {
  const writable = () => workspace.assertWritable();
  const entry = (id: string) => {
    if (!workspace.list().some((machine) => machine.id === id)) throw new CloudError("not_found", "That instance does not exist in this workspace.");
    return workspace.get(id);
  };
  const describe = (id: string): CloudInstanceRecord => {
    const machine = entry(id); const state = machine.runtime.getSnapshot(); const network = machine.port.getSnapshot();
    const image = RUNTIME_PROFILES[machine.config.profile];
    return {
      id, name: machine.name, imageId: machine.config.profile, status: state.status, message: state.message,
      vpcId: network.vpcId, subnetId: network.subnetId, ip: network.ip, memoryMiB: machine.config.x86 ? X86_MACHINE_PRESETS[machine.config.x86.presetId].memoryMiB : image.memoryMiB,
      ...(machine.config.x86 ? { machine: machine.config.x86 } : {}),
      networkMode: network.mode, quarantined: network.quarantined, ephemeral: machine.ephemeral,
      commandBusy: machine.runner.isBusy(), operation: machine.lifecycle !== "ready" ? machine.lifecycle : state.operation ?? state.volumeOperation ?? (state.acquiringEvidence ? "acquiring-evidence" : null),
      canCancelBoot: machine.runtime.capabilities.cancelBoot === true,
      volumeAttachments: (state.volumes ?? machine.config.volumes).map((volume) => ({ volumeId: volume.id, slot: volume.slot, readOnly: volume.readOnly === true })),
    };
  };
  const mutableEntry = (id: string) => {
    writable(); const machine = entry(id);
    if (machine.lifecycle !== "ready") throw new CloudError("conflict", `Wait for ${machine.name} to finish ${machine.lifecycle}.`);
    return machine;
  };
  const requireIdleControl = (id: string) => {
    const machine = mutableEntry(id); const state = machine.runtime.getSnapshot();
    if (machine.runner.isBusy() || state.operation || state.acquiringEvidence || state.volumeOperation) throw new CloudError("conflict", "Wait for the instance's current command, checkpoint, evidence, or volume operation.");
    return machine;
  };
  const vpc = (id: string) => {
    const value = workspace.getSnapshot().vpcs.find((item) => item.id === id);
    if (!value) throw new CloudError("not_found", "That VPC does not exist."); return value;
  };
  const subnet = (vpcId: string, id: string) => {
    const value = vpc(vpcId).subnets.find((item) => item.id === id);
    if (!value) throw new CloudError("not_found", "That subnet does not exist in this VPC."); return { ...value, vpcId };
  };

  return {
    assertWritable: writable,
    subscribe: (listener) => {
      const volumes = storage?.subscribeVolumeChanges?.(() => listener({ type: "resource.changed", at: Date.now(), resourceType: "volume", resourceId: null, action: "updated" }));
      const images = subscribeMachineImageChanges(change => listener({ type: "resource.changed", at: Date.now(), resourceType: "image", resourceId: change.id, action: change.action }));
      return () => { volumes?.(); images(); };
    },
    machineImages: {
      list: () => listMachineImages(), get: id => getMachineImage(id), export: id => exportMachineImage(id),
      import: blob => { writable(); return importMachineImage(blob); },
      remove: (id, conditions) => { writable(); return deleteMachineImage(id, { ...conditions, assertUnreferenced: workspace.assertImageUnreferenced }); },
    },
    images: Object.values(RUNTIME_PROFILES).map((image) => ({ id: image.id, name: image.label, architecture: image.architecture, bits: image.bits, memoryMiB: image.memoryMiB, description: image.description, kernel: image.kernel, userland: image.userland, capabilities: { ...image.capabilities }, limitations: [...image.limitations] })),
    instances: {
      list: () => workspace.list().map((machine) => describe(machine.id)),
      get: describe,
      create: async (input) => {
        writable();
        if (!isRuntimeProfileId(input.imageId)) throw new CloudError("not_found", "That image is not in the runtime registry.");
        const attachment = input.vpcId && input.subnetId ? { vpcId: input.vpcId, subnetId: input.subnetId, ...(input.ip ? { ip: input.ip } : {}) } : undefined;
        const machine = await workspace.addConfigured(input.name, input.imageId, input.initScript ?? "", attachment, input.machine); return describe(machine.id);
      },
      update: async (id, patch) => { mutableEntry(id); if (patch.machine) await workspace.configureMachine(id, { ...patch, machine: patch.machine }); else workspace.configure(id, patch); return describe(id); },
      start: async (id) => {
        const machine = requireIdleControl(id); const status = machine.runtime.getSnapshot().status;
        if (status === "running") return describe(id);
        if (status === "paused") throw new CloudError("conflict", "Use instances.resume() for a paused guest. Start boots a stopped definition.");
        if (status === "loading" || status === "booting") throw new CloudError("conflict", "This instance is already starting.");
        await machine.runtime.boot(); return describe(id);
      },
      pause: async (id) => {
        const machine = requireIdleControl(id);
        if (machine.runtime.getSnapshot().status !== "paused") await machine.runtime.pause(); return describe(id);
      },
      resume: async (id) => {
        const machine = requireIdleControl(id);
        if (machine.runtime.getSnapshot().status !== "running") {
          const blocked = machine.runner.getState().blockedReason;
          if (blocked) throw new CloudError("conflict", blocked);
          await machine.runtime.resume();
        }
        return describe(id);
      },
      stop: async (id) => { mutableEntry(id); await workspace.stop(id); return describe(id); },
      remove: async (id) => {
        requireIdleControl(id);
        // The manager owns sync, teardown, dependency release and manifest commit.
        await workspace.remove(id);
      },
      setNetwork: (id, mode) => { mutableEntry(id); workspace.setNetwork(id, mode); return describe(id); },
      configureTransport: (id, transport) => { mutableEntry(id); workspace.configureNetworkTransport(id, transport); return describe(id); },
      setPolicy: (id, policy) => { mutableEntry(id); workspace.setPolicy(id, policy); return describe(id); },
      move: (id, attachment) => { mutableEntry(id); workspace.configureAttachment(id, attachment); return describe(id); },
      attachVolume: async (id, attachment) => {
        const machine = requireIdleControl(id);
        const occupied = new Set(machine.config.volumes.map((volume) => volume.slot));
        const slot = attachment.slot ?? [0, 1].find((candidate) => !occupied.has(candidate as 0 | 1));
        if (slot !== 0 && slot !== 1) throw new CloudError("conflict", "Both VirtIO disk slots are configured. Detach a disk before replacing it.");
        await workspace.attachVolume(id, { id: attachment.volumeId, slot, readOnly: attachment.readOnly }); return describe(id);
      },
      detachVolume: async (id, volumeId) => {
        const machine = requireIdleControl(id); const attachment = machine.config.volumes.find((volume) => volume.id === volumeId);
        if (!attachment) throw new CloudError("not_found", "That volume is not configured on this instance.");
        await workspace.detachVolume(id, attachment.slot); return describe(id);
      },
      syncVolumes: async (id) => { requireIdleControl(id); await workspace.syncVolumes(id); return describe(id); },
    },
    vpcs: {
      list: () => workspace.getSnapshot().vpcs,
      create: (input) => { writable(); workspace.addVpc(input); return vpc(input.id); },
      update: (id, patch) => { writable(); workspace.updateVpc(id, patch); return vpc(id); },
      remove: (id) => { writable(); vpc(id); workspace.removeVpc(id); },
    },
    subnets: {
      create: (vpcId, input) => { writable(); workspace.addSubnet(vpcId, input); return subnet(vpcId, input.id); },
      update: (vpcId, id, patch) => { writable(); workspace.updateSubnet(vpcId, id, patch); return subnet(vpcId, id); },
      remove: (vpcId, id) => { writable(); subnet(vpcId, id); workspace.removeSubnet(vpcId, id); },
    },
    ...(storage ? { volumes: {
      ...(storage.exportVolumeTo ? { exportTo: storage.exportVolumeTo } : {}),
      list: () => storage.listVolumes(), get: (id: string) => storage.getVolume(id), create: (input: { name: string; sizeMiB: number }) => { writable(); return storage.createVolume(input); },
      snapshot: (id: string, input: { name: string }) => { writable(); return storage.snapshotVolume(id, input); }, clone: (id: string, input: { name: string }) => { writable(); return storage.cloneVolume(id, input); },
      remove: (id: string, conditions?: CloudVolumeDeleteConditions) => {
        writable();
        const attached = workspace.list().filter((machine) => machine.config.volumes.some((volume) => volume.id === id));
        if (attached.length) throw new CloudError("conflict", `Detach this volume before deleting it. Attached instance definitions: ${attached.map((machine) => machine.name).join(", ")}.`);
        return storage.deleteVolume(id, conditions);
      },
    } } : {}),
  };
}
