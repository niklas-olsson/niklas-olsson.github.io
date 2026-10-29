// SPDX-License-Identifier: Apache-2.0
import { CloudOperations } from "./cloud-operations.ts";
import { CloudSimulation } from "./cloud-simulation.ts";
import { CloudObjectStore } from "./cloud-object-store.ts";
import { createDeletionInspector } from "./cloud-deletions.ts";
import { CLOUD_API_VERSION, CloudError, type CloudChangeEvent, type CloudInstanceCreate, type CloudInstancePatch, type CloudProvider, type CloudRequestOptions, type CloudResource, type CloudResourceType, type CloudSubnetCreate, type CloudVolumeAttachInput, type CloudVolumeDeleteOptions, type CloudVpcCreate } from "./cloud-types.ts";
import { validateNetworkPolicy, type NetworkPolicy } from "./network-policy.ts";
import { validateRelayUrl, type NetworkTransport } from "./network-transport.ts";
import type { NetworkMode } from "./network.ts";
import { validateVpcConfig, type NetworkAttachment } from "./vpc-config.ts";
import { assertQemuInstanceCreateOptions } from "../../public/runtime/qemu/options.js";
import { validateX86MachineConfiguration, X86_MACHINE_PRESETS } from "./x86-machine-config.ts";
import { inspectMachineImage } from "./machine-image.ts";
import type { VolumeStreamOptions } from "./volume-types.ts";
import { beginResourceMutation } from "./resource-events.ts";
export * from "./cloud-types.ts";

function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new CloudError("invalid_argument", "Resource IDs use letters, numbers, underscores, or hyphens.");
  return value;
}
function text(value: string, field: string, max = 64): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw new CloudError("invalid_argument", `${field} must contain 1–${max} printable characters.`);
  return value.trim();
}
function bootScript(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.includes("\0") || new TextEncoder().encode(value).length > 8192) throw new CloudError("invalid_argument", "Boot scripts must be UTF-8 text within 8 KiB, without null bytes.");
  return value.replace(/\r\n?/g, "\n");
}
function resource<T extends { id: string }>(type: CloudResourceType, value: T, scope = ""): CloudResource<T> {
  return { ...structuredClone(value), apiVersion: CLOUD_API_VERSION, resourceType: type, urn: `urn:terrarium:local:${type}:${encodeURIComponent(scope ? `${scope}/${value.id}` : value.id)}` };
}

/** A local control plane over actual workspace operations, not a remote cloud account. */
export class CloudControlPlane {
  readonly apiVersion = CLOUD_API_VERSION;
  readonly simulation: CloudSimulation;
  #engine: CloudOperations;
  readonly operations: Readonly<Pick<CloudOperations, "get" | "list" | "wait" | "limits">>;
  readonly objectStore: CloudObjectStore;
  readonly deletions: ReturnType<typeof createDeletionInspector>;
  private readonly changeListeners = new Set<(event: CloudChangeEvent) => void>();
  private readonly unsubscribeChanges: (() => void)[] = [];
  readonly semantics = Object.freeze({
    execution: "visitor-browser",
    remoteProvider: false,
    operationPersistence: "open-page-only",
    objectPersistence: "IndexedDB in this browser origin",
    metadataEndpoint: "JavaScript API only; no guest IMDS service",
    dnsEndpoint: "no cloud DNS endpoint",
    cancellation: false,
  });
  private readonly provider: CloudProvider;
  constructor(provider: CloudProvider, options: { objectStore?: CloudObjectStore } = {}) {
    this.provider = provider;
    const guard = () => provider.assertWritable?.();
    this.simulation = new CloudSimulation({ beforeMutation: guard });
    this.#engine = new CloudOperations(async (context) => { guard(); await this.simulation.before(context); guard(); });
    this.operations = Object.freeze({ get: this.#engine.get, list: this.#engine.list, wait: this.#engine.wait, limits: this.#engine.limits });
    this.objectStore = options.objectStore ? options.objectStore.withMutationGuard(guard) : new CloudObjectStore({ beforeMutation: guard });
    this.deletions = createDeletionInspector(provider, this.objectStore, this.simulation);
    this.unsubscribeChanges.push(this.#engine.subscribe(this.publish), this.objectStore.subscribe(this.publish), this.simulation.subscribe(this.publish));
    if (provider.subscribe) this.unsubscribeChanges.push(provider.subscribe(this.publish));
  }

  readonly images = Object.freeze({
    list: async () => this.provider.images.map((image) => resource("image", image)),
    get: async (id: string) => {
      const image = this.provider.images.find((entry) => entry.id === identifier(id));
      if (!image) throw new CloudError("not_found", "That image is not in the verified runtime registry.");
      return resource("image", image);
    },
  });

  readonly machineImages = Object.freeze({
    presets: () => structuredClone(X86_MACHINE_PRESETS),
    list: async () => this.requireMachineImages().list(),
    get: async (id: string) => this.requireMachineImages().get(identifier(id)),
    export: async (id: string) => this.requireMachineImages().export(identifier(id)),
    // The immutable Blob is verified before its content identity enters the
    // operation queue; the actual provider independently validates at commit.
    import: async (blob: Blob, options?: CloudRequestOptions) => {
      this.provider.assertWritable?.();
      const image = await inspectMachineImage(blob);
      return this.#engine.submit("images.import", "image", image.id, { id: image.id, bytes: image.totalBytes }, ["image-inventory", `image:${image.id}`],
        async () => this.requireMachineImages().import(image.blob), options);
    },
    delete: (id: string, options: CloudRequestOptions & { ifSha256?: string } = {}) => {
      identifier(id);
      if (options.ifSha256 !== undefined && options.ifSha256 !== id) throw new CloudError("conflict", "The selected image identity changed.");
      return this.#engine.submit("images.delete", "image", id, { ifSha256: options.ifSha256 ?? id }, [`image:${id}`, "image-inventory"], async conditions => {
        await this.requireMachineImages().remove(id, conditions); return { id, deleted: true as const };
      }, options);
    },
  });

  private requireMachineImages(): NonNullable<CloudProvider["machineImages"]> {
    if (!this.provider.machineImages) throw new CloudError("unsupported", "No custom machine image provider is installed.");
    return this.provider.machineImages;
  }

  readonly instances = Object.freeze({
    list: async () => (await this.provider.instances.list()).map((instance) => resource("instance", instance)),
    get: async (id: string) => resource("instance", await this.provider.instances.get(identifier(id))),
    create: (input: CloudInstanceCreate, options?: CloudRequestOptions) => {
      const imageId = identifier(input.imageId);
      if (!this.provider.images.some((image) => image.id === imageId)) throw new CloudError("not_found", "Choose an image from cloud.images.list().");
      if (imageId === "alpine-x86_64") {
        try { assertQemuInstanceCreateOptions(input); }
        catch (error) { throw new CloudError("unsupported", error instanceof Error ? error.message : String(error)); }
      }
      const value: CloudInstanceCreate = { name: text(input.name, "Instance name", 32), imageId, initScript: bootScript(input.initScript) };
      if (input.machine !== undefined) {
        if (imageId !== "alpine-x86_64") throw new CloudError("unsupported", "Machine presets and custom Linux images require x86_64.");
        value.machine = validateX86MachineConfiguration(input.machine);
      }
      if (input.vpcId !== undefined || input.subnetId !== undefined || input.ip !== undefined) {
        value.vpcId = identifier(input.vpcId!); value.subnetId = identifier(input.subnetId!);
        if (input.ip !== undefined) value.ip = text(input.ip, "IPv4 address", 15);
      }
      return this.#engine.submit("instances.create", "instance", null, value, ["network", "instance-inventory"], async (request) => resource("instance", await this.provider.instances.create(request)), options);
    },
    update: (id: string, patch: CloudInstancePatch, options?: CloudRequestOptions) => {
      identifier(id); const value: CloudInstancePatch = {};
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || ![null, Object.prototype].includes(Object.getPrototypeOf(patch))
        || Reflect.ownKeys(patch).some(key => !["name", "initScript", "machine"].includes(String(key)) || !Object.hasOwn(Object.getOwnPropertyDescriptor(patch, key)!, "value")))
        throw new CloudError("invalid_argument", "Instance updates accept only data fields name, initScript and machine.");
      if (patch.name !== undefined) value.name = text(patch.name, "Instance name", 32);
      if (patch.initScript !== undefined) value.initScript = bootScript(patch.initScript);
      if (patch.machine !== undefined) value.machine = validateX86MachineConfiguration(patch.machine);
      if (!Object.keys(value).length) throw new CloudError("invalid_argument", "Supply a name, initScript or machine update.");
      return this.#engine.submit("instances.update", "instance", id, value, [`instance:${id}`], async (request) => resource("instance", await this.provider.instances.update(id, request)), options);
    },
    start: (id: string, options?: CloudRequestOptions) => this.instanceAction("start", id, options),
    pause: (id: string, options?: CloudRequestOptions) => this.instanceAction("pause", id, options),
    resume: (id: string, options?: CloudRequestOptions) => this.instanceAction("resume", id, options),
    stop: (id: string, options?: CloudRequestOptions) => this.instanceAction("stop", id, options),
    delete: (id: string, options?: CloudRequestOptions) => {
      identifier(id);
      return this.#engine.submit("instances.delete", "instance", id, {}, [`instance:${id}`, "network"], async () => { await this.provider.instances.remove(id); return { id, deleted: true as const }; }, options);
    },
    setNetwork: (id: string, mode: NetworkMode, options?: CloudRequestOptions) => {
      identifier(id); if (!["isolated", "local", "world"].includes(mode)) throw new CloudError("invalid_argument", "Choose isolated, local, or world network mode.");
      return this.#engine.submit("instances.setNetwork", "instance", id, { mode }, [`instance:${id}`], async (request) => { if (request.mode !== "isolated") await this.requireMutableNetwork(id); return resource("instance", await this.provider.instances.setNetwork(id, request.mode)); }, options);
    },
    configureTransport: (id: string, transport: NetworkTransport, options?: CloudRequestOptions) => {
      identifier(id);
      const value: NetworkTransport = transport.kind === "web" ? { kind: "web" } : transport.kind === "wisp" ? { kind: "wisp", relayUrl: validateRelayUrl(transport.relayUrl) } : (() => { throw new CloudError("invalid_argument", "Choose web or wisp transport."); })();
      return this.#engine.submit("instances.configureTransport", "instance", id, value, [`instance:${id}`], async (request) => { await this.requireMutableNetwork(id); return resource("instance", await this.provider.instances.configureTransport(id, request)); }, options);
    },
    setPolicy: (id: string, policy: NetworkPolicy, options?: CloudRequestOptions) => {
      identifier(id); const value = validateNetworkPolicy(policy);
      return this.#engine.submit("instances.setPolicy", "instance", id, value, [`instance:${id}`], async (request) => { await this.requireMutableNetwork(id); return resource("instance", await this.provider.instances.setPolicy(id, request)); }, options);
    },
    move: (id: string, attachment: NetworkAttachment, options?: CloudRequestOptions) => {
      identifier(id); const value = { vpcId: identifier(attachment.vpcId), subnetId: identifier(attachment.subnetId), ip: text(attachment.ip, "IPv4 address", 15) };
      return this.#engine.submit("instances.move", "instance", id, value, [`instance:${id}`, "network"], async (request) => { await this.requireMutableNetwork(id); return resource("instance", await this.provider.instances.move(id, request)); }, options);
    },
    attachVolume: (id: string, attachment: CloudVolumeAttachInput, options?: CloudRequestOptions) => {
      identifier(id); identifier(attachment.volumeId);
      if (attachment.slot !== undefined && (!Number.isInteger(attachment.slot) || attachment.slot < 0 || attachment.slot > 1)) throw new CloudError("invalid_argument", "This runtime exposes disk slots 0 and 1.");
      const value = { volumeId: attachment.volumeId, ...(attachment.slot === undefined ? {} : { slot: attachment.slot }), readOnly: attachment.readOnly === true };
      return this.#engine.submit("instances.attachVolume", "instance", id, value, [`instance:${id}`, `volume:${value.volumeId}`], async (request) => { await this.requireMutableNetwork(id); if (!this.provider.instances.attachVolume) throw new CloudError("unsupported", "This workspace has no durable-volume attachment provider."); return resource("instance", await this.provider.instances.attachVolume(id, request)); }, options);
    },
    syncVolumes: (id: string, options?: CloudRequestOptions) => {
      identifier(id);
      return this.#engine.submit("instances.syncVolumes", "instance", id, {}, [`instance:${id}`], async () => { if (!this.provider.instances.syncVolumes) throw new CloudError("unsupported", "This workspace has no durable-volume sync provider."); return resource("instance", await this.provider.instances.syncVolumes(id)); }, options);
    },
    detachVolume: (id: string, volumeId: string, options?: CloudRequestOptions) => {
      identifier(id); identifier(volumeId);
      return this.#engine.submit("instances.detachVolume", "instance", id, { volumeId }, [`instance:${id}`, `volume:${volumeId}`], async (request) => { await this.requireMutableNetwork(id); if (!this.provider.instances.detachVolume) throw new CloudError("unsupported", "This workspace has no durable-volume attachment provider."); return resource("instance", await this.provider.instances.detachVolume(id, request.volumeId)); }, options);
    },
  });

  readonly vpcs = Object.freeze({
    list: async () => (await this.provider.vpcs.list()).map((vpc) => resource("vpc", vpc)),
    get: async (id: string) => {
      const value = (await this.provider.vpcs.list()).find((vpc) => vpc.id === identifier(id));
      if (!value) throw new CloudError("not_found", "That VPC does not exist.");
      return resource("vpc", value);
    },
    create: (input: CloudVpcCreate, options?: CloudRequestOptions) => {
      const value = structuredClone(input);
      // Validate using placeholders, generating actual identifiers only once the
      // accepted operation runs. Idempotent retries must not generate new IDs.
      validateVpcConfig({ ...value, id: value.id ?? "new-vpc", subnets: value.subnets.map((subnet, index) => ({ ...subnet, id: subnet.id ?? `new-subnet-${index}` })) });
      return this.#engine.submit("vpcs.create", "vpc", input.id ?? null, value, ["network"], async (request) => resource("vpc", await this.provider.vpcs.create({ ...request, id: request.id ?? crypto.randomUUID(), subnets: request.subnets.map((subnet) => ({ ...subnet, id: subnet.id ?? crypto.randomUUID() })) })), options);
    },
    update: (id: string, patch: { name: string }, options?: CloudRequestOptions) => {
      identifier(id); const value = { name: text(patch.name, "VPC name") };
      return this.#engine.submit("vpcs.update", "vpc", id, value, ["network"], async (request) => resource("vpc", await this.provider.vpcs.update(id, request)), options);
    },
    delete: (id: string, options?: CloudRequestOptions) => {
      identifier(id); return this.#engine.submit("vpcs.delete", "vpc", id, {}, ["network"], async () => { await this.provider.vpcs.remove(id); return { id, deleted: true as const }; }, options);
    },
  });

  readonly subnets = Object.freeze({
    list: async (vpcId: string) => (await this.vpcs.get(vpcId)).subnets.map((subnet) => resource("subnet", { ...subnet, vpcId }, vpcId)),
    get: async (vpcId: string, id: string) => {
      const subnet = (await this.subnets.list(vpcId)).find((entry) => entry.id === identifier(id));
      if (!subnet) throw new CloudError("not_found", "That subnet does not exist in this VPC."); return subnet;
    },
    create: (vpcId: string, input: CloudSubnetCreate, options?: CloudRequestOptions) => {
      identifier(vpcId); const value = { ...(input.id === undefined ? {} : { id: identifier(input.id) }), name: text(input.name, "Subnet name"), cidr: text(input.cidr, "Subnet CIDR", 18) };
      return this.#engine.submit("subnets.create", "subnet", input.id ?? null, { vpcId, ...value }, ["network"], async (request) => resource("subnet", await this.provider.subnets.create(request.vpcId, { id: request.id ?? crypto.randomUUID(), name: request.name, cidr: request.cidr }), vpcId), options);
    },
    update: (vpcId: string, id: string, patch: { name?: string; cidr?: string }, options?: CloudRequestOptions) => {
      identifier(vpcId); identifier(id);
      const value = { ...(patch.name === undefined ? {} : { name: text(patch.name, "Subnet name") }), ...(patch.cidr === undefined ? {} : { cidr: text(patch.cidr, "Subnet CIDR", 18) }) };
      if (!Object.keys(value).length) throw new CloudError("invalid_argument", "Supply a subnet name or CIDR update.");
      return this.#engine.submit("subnets.update", "subnet", id, { vpcId, patch: value }, ["network"], async (request) => resource("subnet", await this.provider.subnets.update(request.vpcId, id, request.patch), vpcId), options);
    },
    delete: (vpcId: string, id: string, options?: CloudRequestOptions) => {
      identifier(vpcId); identifier(id);
      return this.#engine.submit("subnets.delete", "subnet", id, { vpcId }, ["network"], async (request) => { await this.provider.subnets.remove(request.vpcId, id); return { id, vpcId: request.vpcId, deleted: true as const }; }, options);
    },
  });

  readonly volumes = Object.freeze({
    exportTo: async (id: string, sink: { write(chunk: Uint8Array<ArrayBuffer>): void | Promise<void> }, options?: VolumeStreamOptions) => {
      const provider = this.volumeProvider();
      if (!provider.exportTo) throw new CloudError("unsupported", "This volume provider has no bounded streaming export path.");
      const finish = beginResourceMutation("volume");
      try { return await provider.exportTo(identifier(id), sink, options); } finally { finish(); }
    },
    list: async () => (await this.volumeProvider().list()).map((volume) => resource("volume", volume)),
    get: async (id: string) => resource("volume", await this.volumeProvider().get(identifier(id))),
    create: (input: { name: string; sizeMiB: number }, options?: CloudRequestOptions) => {
      const value = { name: text(input.name, "Volume name"), sizeMiB: input.sizeMiB };
      if (!Number.isInteger(value.sizeMiB) || value.sizeMiB <= 0) throw new CloudError("invalid_argument", "Volume size must be a positive integer in MiB.");
      return this.#engine.submit("volumes.create", "volume", null, value, ["volume-inventory"], async (request) => resource("volume", await this.volumeProvider().create(request)), options);
    },
    snapshot: (id: string, input: { name: string }, options?: CloudRequestOptions) => this.copyVolume("snapshot", id, input, options),
    clone: (id: string, input: { name: string }, options?: CloudRequestOptions) => this.copyVolume("clone", id, input, options),
    delete: (id: string, options?: CloudVolumeDeleteOptions) => {
      identifier(id);
      const conditions = { ...(options?.ifRevision === undefined ? {} : { ifRevision: options.ifRevision }), ...(options?.ifSha256 === undefined ? {} : { ifSha256: options.ifSha256 }) };
      if (conditions.ifRevision !== undefined && (!Number.isSafeInteger(conditions.ifRevision) || conditions.ifRevision < 0)) throw new CloudError("invalid_argument", "ifRevision must be a nonnegative disk revision.");
      if (conditions.ifSha256 !== undefined && !/^[a-f0-9]{64}$/.test(conditions.ifSha256)) throw new CloudError("invalid_argument", "ifSha256 must be a lowercase SHA-256 digest.");
      return this.#engine.submit("volumes.delete", "volume", id, conditions, [`volume:${id}`], async (request) => { await this.volumeProvider().remove(id, request); return { id, deleted: true as const }; }, options);
    },
  });

  readonly metadata = Object.freeze({
    describe: async (id: string) => {
      const instance = await this.instances.get(id); const image = await this.images.get(instance.imageId);
      return { apiVersion: CLOUD_API_VERSION, source: "live-workspace-registry" as const, observedAt: Date.now(), instance, image };
    },
  });
  readonly events = Object.freeze({ list: (afterSequence = 0) => this.#engine.events(afterSequence), subscribe: (listener: Parameters<CloudOperations["subscribe"]>[0]) => this.#engine.subscribe(listener) });
  subscribe = (listener: (event: CloudChangeEvent) => void): (() => void) => { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; };
  private publish = (event: CloudChangeEvent): void => { for (const listener of this.changeListeners) { try { listener({ ...event }); } catch { /* Observers cannot alter mutations. */ } } };
  dispose = (): void => { this.unsubscribeChanges.splice(0).forEach((unsubscribe) => unsubscribe()); this.changeListeners.clear(); };
  assertSettled = (): void => {
    const pending = this.#engine.list().filter((operation) => operation.status === "queued" || operation.status === "running");
    if (pending.length) throw new CloudError("conflict", `Wait for ${pending.length} pending cloud operation${pending.length === 1 ? "" : "s"} before reloading.`);
    this.objectStore.assertSettled();
  };

  private instanceAction(action: "start" | "pause" | "resume" | "stop", id: string, options?: CloudRequestOptions) {
    identifier(id);
    return this.#engine.submit(`instances.${action}`, "instance", id, {}, [`instance:${id}`], async () => resource("instance", await this.provider.instances[action](id)), options);
  }
  private async requireMutableNetwork(id: string): Promise<void> {
    if ((await this.provider.instances.get(id)).quarantined) throw new CloudError("quarantined", "This investigation clone is permanently quarantined. Cloud operations cannot release its network or change attachments.");
  }
  private volumeProvider() {
    if (!this.provider.volumes) throw new CloudError("unsupported", "No durable block-volume provider is installed in this workspace.");
    return this.provider.volumes;
  }
  private copyVolume(action: "snapshot" | "clone", id: string, input: { name: string }, options?: CloudRequestOptions) {
    identifier(id); const value = { name: text(input.name, "Volume name") };
    return this.#engine.submit(`volumes.${action}`, "volume", id, value, [`volume:${id}`, "volume-inventory"], async (request) => resource("volume", await this.volumeProvider()[action](id, request)), options);
  }
}

export function createCloudControlPlane(provider: CloudProvider, options?: { objectStore?: CloudObjectStore }): CloudControlPlane {
  return new CloudControlPlane(provider, options);
}
