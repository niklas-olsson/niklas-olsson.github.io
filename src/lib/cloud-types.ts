// SPDX-License-Identifier: Apache-2.0
import type { NetworkAttachment, SubnetConfig, VpcConfig } from "./vpc-config.ts";
import type { NetworkPolicy } from "./network-policy.ts";
import type { NetworkMode } from "./network.ts";
import type { NetworkTransport } from "./network-transport.ts";
import type { X86MachineConfiguration } from "./x86-machine-config.ts";
import type { MachineImageMeta } from "./machine-image-store.ts";
import type { VolumeStreamOptions, VolumeStreamResult } from "./volume-types.ts";

export const CLOUD_API_VERSION = "terrarium.local/v1alpha1" as const;
export type CloudResourceType = "instance" | "vpc" | "subnet" | "volume" | "image";
export interface CloudResourceIdentity { apiVersion: typeof CLOUD_API_VERSION; resourceType: CloudResourceType; urn: string }
export type CloudResource<T> = T & CloudResourceIdentity;
export type MaybePromise<T> = T | Promise<T>;
export interface CloudRequestOptions { idempotencyKey?: string; identity?: string }
export interface CloudVolumeDeleteOptions extends CloudRequestOptions { ifRevision?: number; ifSha256?: string }
export interface CloudVolumeDeleteConditions { ifRevision?: number; ifSha256?: string }
export type CloudDeletionType = "instance" | "vpc" | "subnet" | "volume" | "image" | "bucket" | "object" | "identity" | "fault";
export interface CloudDeletionTarget { type: CloudDeletionType; id: string; vpcId?: string; bucket?: string }
export interface CloudDeletionBlocker { type: CloudDeletionType | "operation"; id: string; name: string; message: string; vpcId?: string; bucket?: string }
export interface CloudDeletionPreview {
  target: CloudDeletionTarget; exists: boolean; allowed: boolean; name: string;
  blockers: CloudDeletionBlocker[]; preserves: string[]; revision?: number; sha256?: string; generation?: string;
}
export interface CloudResourceEvent {
  type: "resource.changed"; at: number;
  resourceType: CloudResourceType | "bucket" | "object" | "identity" | "fault";
  resourceId: string | null; action: string; scope?: string;
}
export type CloudChangeEvent = CloudEvent | CloudResourceEvent;
export interface CloudInstanceCreate {
  name: string; imageId: string; initScript?: string;
  vpcId?: string; subnetId?: string; ip?: string;
  machine?: X86MachineConfiguration;
}
export interface CloudInstancePatch { name?: string; initScript?: string; machine?: X86MachineConfiguration }
export interface CloudVolumeAttachment { volumeId: string; slot: number; readOnly: boolean }
export interface CloudVolumeAttachInput { volumeId: string; slot?: number; readOnly?: boolean }
export interface CloudInstanceRecord {
  machine?: X86MachineConfiguration;
  id: string; name: string; imageId: string; status: string; message: string;
  vpcId: string; subnetId: string; ip: string; memoryMiB: number;
  networkMode: NetworkMode; quarantined: boolean; ephemeral: boolean;
  commandBusy: boolean; operation: string | null;
  /** The runtime can cancel and drain an in-progress boot during stop/delete. */
  canCancelBoot?: boolean;
  volumeAttachments: CloudVolumeAttachment[];
}
export interface CloudImageRecord {
  id: string; name: string; architecture: string; bits: number; memoryMiB: number;
  description: string; kernel: string; userland: string;
  capabilities: Record<string, string | number | boolean | null>;
  limitations: readonly string[];
}
export interface CloudVolumeRecord {
  id: string; name: string; bytes: number; kind: "volume" | "snapshot";
  createdAt: number; updatedAt: number; revision: number;
  sha256: string | null; sourceId?: string; filesystem: "ext2";
}
export type CloudSubnetRecord = SubnetConfig & { vpcId: string };
export interface CloudVpcCreate { id?: string; name: string; cidr: string; subnets: Array<Omit<SubnetConfig, "id"> & { id?: string }> }
export interface CloudSubnetCreate { id?: string; name: string; cidr: string }
export interface DeletedResource { id: string; deleted: true }

/** All mutations must reach the workspace/store and enforce their own lifecycle gates. */
export interface CloudProvider {
  machineImages?: {
    list(): Promise<MachineImageMeta[]>;
    get(id: string): Promise<MachineImageMeta | null>;
    import(blob: Blob): Promise<MachineImageMeta>;
    export(id: string): Promise<Blob>;
    remove(id: string, conditions?: { ifSha256?: string }): Promise<void>;
  };
  /** Optional single-tab ownership / maintenance guard; checked at dispatch. */
  assertWritable?(): void;
  subscribe?(listener: (event: CloudResourceEvent) => void): () => void;
  images: readonly CloudImageRecord[];
  instances: {
    list(): MaybePromise<CloudInstanceRecord[]>;
    get(id: string): MaybePromise<CloudInstanceRecord>;
    create(input: CloudInstanceCreate): MaybePromise<CloudInstanceRecord>;
    update(id: string, patch: CloudInstancePatch): MaybePromise<CloudInstanceRecord>;
    start(id: string): MaybePromise<CloudInstanceRecord>;
    pause(id: string): MaybePromise<CloudInstanceRecord>;
    resume(id: string): MaybePromise<CloudInstanceRecord>;
    stop(id: string): MaybePromise<CloudInstanceRecord>;
    remove(id: string): MaybePromise<void>;
    setNetwork(id: string, mode: NetworkMode): MaybePromise<CloudInstanceRecord>;
    configureTransport(id: string, transport: NetworkTransport): MaybePromise<CloudInstanceRecord>;
    setPolicy(id: string, policy: NetworkPolicy): MaybePromise<CloudInstanceRecord>;
    move(id: string, attachment: NetworkAttachment): MaybePromise<CloudInstanceRecord>;
    attachVolume?(id: string, attachment: CloudVolumeAttachInput): MaybePromise<CloudInstanceRecord>;
    detachVolume?(id: string, volumeId: string): MaybePromise<CloudInstanceRecord>;
    syncVolumes?(id: string): MaybePromise<CloudInstanceRecord>;
  };
  vpcs: {
    list(): MaybePromise<VpcConfig[]>;
    create(input: VpcConfig): MaybePromise<VpcConfig>;
    update(id: string, patch: { name: string }): MaybePromise<VpcConfig>;
    remove(id: string): MaybePromise<void>;
  };
  subnets: {
    create(vpcId: string, input: SubnetConfig): MaybePromise<CloudSubnetRecord>;
    update(vpcId: string, id: string, patch: Partial<Pick<SubnetConfig, "name" | "cidr">>): MaybePromise<CloudSubnetRecord>;
    remove(vpcId: string, id: string): MaybePromise<void>;
  };
  volumes?: {
    exportTo?(id: string, sink: { write(chunk: Uint8Array<ArrayBuffer>): void | Promise<void> }, options?: VolumeStreamOptions): Promise<VolumeStreamResult>;
    list(): MaybePromise<CloudVolumeRecord[]>;
    get(id: string): MaybePromise<CloudVolumeRecord>;
    create(input: { name: string; sizeMiB: number }): MaybePromise<CloudVolumeRecord>;
    snapshot(id: string, input: { name: string }): MaybePromise<CloudVolumeRecord>;
    clone(id: string, input: { name: string }): MaybePromise<CloudVolumeRecord>;
    remove(id: string, conditions?: CloudVolumeDeleteConditions): MaybePromise<void>;
  };
}

export type CloudErrorCode = "invalid_argument" | "not_found" | "conflict" | "quarantined" | "unsupported" | "provider_error" | "idempotency_conflict" | "storage_unavailable" | "quota_exceeded" | "access_denied" | "injected_failure";
export class CloudError extends Error {
  readonly code: CloudErrorCode;
  readonly operationId?: string;
  constructor(code: CloudErrorCode, message: string, operationId?: string) {
    super(message); this.name = "CloudError"; this.code = code; this.operationId = operationId;
  }
}
export interface CloudOperation<T = unknown> {
  id: string; action: string; status: "queued" | "running" | "succeeded" | "failed";
  identity: string;
  submittedAt: number; startedAt: number | null; finishedAt: number | null;
  resourceType: CloudResourceType; resourceId: string | null;
  result?: T; error?: { code: CloudErrorCode; message: string };
}
export interface CloudOperationHandle<T> {
  readonly id: string;
  get(): CloudOperation<T>;
  wait(): Promise<T>;
}
export interface CloudEvent {
  sequence: number; at: number; type: "operation.queued" | "operation.running" | "operation.succeeded" | "operation.failed";
  operationId: string; action: string; resourceType: CloudResourceType; resourceId: string | null;
  identity: string;
}
