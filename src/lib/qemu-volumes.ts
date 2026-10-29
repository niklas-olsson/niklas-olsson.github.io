// SPDX-License-Identifier: Apache-2.0
import { getVolume, openVolume, type VolumeSession } from "./volume-store.ts";
import {
  validateVolumeAttachments,
  type VolumeAttachment,
  type VolumeAttachmentState,
  type VolumeMeta,
} from "./volume-types.ts";

/** Fixed per-disk mailbox used only between the owning host and emulator worker. */
export const QEMU_DISK_HEADER_BYTES = 16;
export const QEMU_DISK_DATA_BYTES = 65_536;
export const QEMU_DISK_MAILBOX_BYTES = QEMU_DISK_HEADER_BYTES + QEMU_DISK_DATA_BYTES;
export const QEMU_DISK_PENDING = 0;
export const QEMU_DISK_COMMITTED = 1;
export const QEMU_DISK_FAILED = -1;
export const QEMU_DISK_READONLY = -2;
export const QEMU_DISK_CANCELLED = -3;

export interface QemuDiskDescriptor {
  slot: 0 | 1;
  bytes: number;
  readOnly: boolean;
  transport: "paged-v1";
  /** Int32 status/sequence header, followed by a bounded read/write payload. */
  mailbox: SharedArrayBuffer;
}

export interface QemuDiskRequest {
  type: "disk-request";
  operation: "read" | "write" | "flush";
  slot: 0 | 1;
  sequence: number;
  offset: number;
  length: number;
}

type Session = Pick<VolumeSession, "readOnly" | "getMetadata" | "getState" | "subscribe" | "read" | "write" | "flush" | "close">;
interface Store {
  get(id: string): Promise<VolumeMeta>;
  open(id: string, options: { readOnly?: boolean }): Promise<Session>;
}
interface OpenDisk {
  session: Session;
  header: Int32Array<SharedArrayBuffer>;
  payload: Uint8Array<SharedArrayBuffer>;
  mailbox: SharedArrayBuffer;
  sequence: number;
  pending: Promise<void> | null;
  failed: Error | null;
  unsubscribe: () => void;
}
interface Options {
  onState?: (state: readonly VolumeAttachmentState[]) => void;
  onError?: (error: Error) => void;
  /** Dependency injection for deterministic storage-failure and cancellation tests. */
  store?: Store;
}

function errorOf(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

/**
 * Host owner of QEMU's durable disks. A worker write is acknowledged only after
 * the existing VolumeSession transaction commits. The emulator worker may wait
 * on Atomics; this host never blocks the browser UI thread.
 */
export class QemuVolumeManager {
  private attachments: VolumeAttachment[];
  private states: VolumeAttachmentState[];
  private readonly disks = new Map<0 | 1, OpenDisk>();
  private readonly store: Store;
  private readonly options: Options;
  private generation = 0;
  private opening: Promise<QemuDiskDescriptor[]> | null = null;
  private closing: Promise<void> | null = null;
  private configuring = false;

  constructor(attachments: readonly VolumeAttachment[] = [], options: Options = {}) {
    this.attachments = validateVolumeAttachments([...attachments]);
    this.states = this.attachments.map((attachment) => this.initialState(attachment));
    this.options = options;
    this.store = options.store ?? { get: getVolume, open: openVolume };
  }

  getAttachments = (): readonly VolumeAttachment[] => this.attachments.map((attachment) => Object.freeze({ ...attachment }));
  getStates = (): readonly VolumeAttachmentState[] => this.states.map((state) => Object.freeze({ ...state }));

  private initialState(attachment: VolumeAttachment): VolumeAttachmentState {
    return {
      ...attachment, name: attachment.id, bytes: 0, kind: "volume", readOnly: attachment.readOnly === true,
      device: `/dev/terrarium-volume${attachment.slot}`, mountPath: `/mnt/volumes/disk${attachment.slot}`,
      status: "configured", pendingWrites: 0, lastPersistedAt: null,
    };
  }
  private publish(): void {
    try { this.options.onState?.(this.getStates()); } catch { /* Views do not own I/O. */ }
  }
  private update(slot: 0 | 1, patch: Partial<VolumeAttachmentState>): void {
    this.states = this.states.map((state) => state.slot === slot ? { ...state, ...patch } : state);
    this.publish();
  }
  private requireConfigurable(): void {
    if (this.opening || this.closing || this.disks.size || this.configuring)
      throw new Error("Stop the machine and wait for its disk operation before changing attachments.");
  }
  attach = async (input: VolumeAttachment): Promise<void> => {
    this.requireConfigurable();
    const attachments = validateVolumeAttachments([...this.attachments, input]);
    this.configuring = true;
    try {
      const metadata = await this.store.get(input.id);
      const attachment = attachments.find((item) => item.id === input.id)!;
      attachment.readOnly = attachment.readOnly === true || metadata.kind === "snapshot";
      this.attachments = attachments;
      this.states = [...this.states, {
        ...this.initialState(attachment), name: metadata.name, bytes: metadata.bytes, kind: metadata.kind,
      }].sort((a, b) => a.slot - b.slot);
      this.publish();
    } finally { this.configuring = false; }
  };
  detach = (slot: 0 | 1): void => {
    this.requireConfigurable();
    if (slot !== 0 && slot !== 1) throw new Error("Choose VirtIO disk slot 0 or 1.");
    this.attachments = this.attachments.filter((item) => item.slot !== slot);
    this.states = this.states.filter((item) => item.slot !== slot);
    this.publish();
  };

  open = (): Promise<QemuDiskDescriptor[]> => {
    if (this.opening) return this.opening;
    if (this.closing || this.disks.size || this.configuring)
      return Promise.reject(new Error("Wait for the previous disk lifecycle to finish before booting."));
    const generation = ++this.generation;
    const task = this.openDisks(generation);
    this.opening = task;
    void task.finally(() => { if (this.opening === task) this.opening = null; }).catch(() => undefined);
    return task;
  };
  private async openDisks(generation: number): Promise<QemuDiskDescriptor[]> {
    const descriptors: QemuDiskDescriptor[] = [];
    try {
      for (const attachment of this.attachments) {
        this.update(attachment.slot, { status: "opening", error: undefined });
        const mailbox = new SharedArrayBuffer(QEMU_DISK_MAILBOX_BYTES);
        const session = await this.store.open(attachment.id, { readOnly: attachment.readOnly });
        if (generation !== this.generation) {
          await session.close();
          throw new Error("Disk attachment was cancelled.");
        }
        const metadata = session.getMetadata();
        const disk: OpenDisk = {
          session, mailbox, header: new Int32Array(mailbox, 0, 4),
          payload: new Uint8Array(mailbox, QEMU_DISK_HEADER_BYTES, QEMU_DISK_DATA_BYTES),
          sequence: 0, pending: null, failed: null, unsubscribe: () => undefined,
        };
        // Register ownership before subscribing, so any initialization failure releases the lock.
        this.disks.set(attachment.slot, disk);
        this.update(attachment.slot, { name: metadata.name, bytes: metadata.bytes, kind: metadata.kind, readOnly: session.readOnly });
        disk.unsubscribe = session.subscribe((state) => {
          if (generation !== this.generation) return;
          this.update(attachment.slot, {
            pendingWrites: state.pendingWrites, lastPersistedAt: state.lastPersistedAt,
            ...(state.error ? { status: "error", error: state.error } : {}),
          });
        });
        descriptors.push({ slot: attachment.slot, bytes: metadata.bytes, readOnly: session.readOnly, transport: "paged-v1", mailbox });
      }
      return descriptors;
    } catch (error) {
      await this.releaseDisks().catch(() => undefined);
      const cancelled = generation !== this.generation;
      this.states = this.states.map((state) => state.status === "opening"
        ? { ...state, status: cancelled ? "closed" : "error", ...(cancelled ? {} : { error: errorOf(error).message }) }
        : state);
      this.publish();
      throw error;
    }
  }

  markMounted = (slot?: 0 | 1): void => {
    for (const [number, disk] of this.disks) {
      if ((slot === undefined || number === slot) && !disk.failed)
        this.update(number, { status: "mounted" });
    }
  };

  /** Copy the request payload before the first await. Never trust a worker's success claim. */
  handleRequest = (input: unknown): Promise<void> => {
    const request = input as Partial<QemuDiskRequest> | null;
    const slot = request?.slot;
    const disk = (slot === 0 || slot === 1) ? this.disks.get(slot) : undefined;
    if (!disk) {
      const error = new Error("The emulator requested an unattached disk.");
      this.failAll(error);
      return Promise.reject(error);
    }
    const generation = this.generation;
    let data: Uint8Array<ArrayBuffer> | null = null;
    try {
      if (this.closing) throw new Error("The disk is closing.");
      if (disk.failed) throw disk.failed;
      if (disk.pending) throw new Error("Overlapping emulator disk requests were rejected.");
      if (!request || request.type !== "disk-request" ||
          !["read", "write", "flush"].includes(String(request.operation)) ||
          !Number.isSafeInteger(request.sequence) || request.sequence! < 1 || request.sequence! > 0x7fffffff ||
          request.sequence !== disk.sequence + 1 || Atomics.load(disk.header, 1) !== request.sequence ||
          Atomics.load(disk.header, 0) !== QEMU_DISK_PENDING)
        throw new Error("The emulator disk request sequence is invalid.");
      if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) ||
          request.offset! < 0 || request.length! < 0 || request.length! > QEMU_DISK_DATA_BYTES ||
          request.offset! + request.length! > disk.session.getMetadata().bytes ||
          (request.operation === "flush" && (request.offset !== 0 || request.length !== 0)))
        throw new Error("The emulator disk request is outside its bounded image.");
      if (request.operation === "write" && disk.session.readOnly) {
        this.acknowledge(disk, request.sequence!, QEMU_DISK_READONLY);
        throw new Error("Host write protection rejected an emulator write to a read-only disk.");
      }
      if (request.operation === "write") data = disk.payload.slice(0, request.length!);
      disk.sequence = request.sequence!;
    } catch (error) {
      const failure = errorOf(error);
      this.failDisk(slot!, disk, failure, Atomics.load(disk.header, 0) === QEMU_DISK_READONLY ? QEMU_DISK_READONLY : QEMU_DISK_FAILED);
      return Promise.reject(failure);
    }
    const sequence = request.sequence!, operationKind = request.operation!, offset = request.offset!, length = request.length!;
    const operation = Promise.resolve().then<void | Uint8Array<ArrayBuffer>>(() => operationKind === "write"
      ? disk.session.write(offset, data!)
      : operationKind === "read" ? disk.session.read(offset, length) : disk.session.flush());
    const task = operation.then((result) => {
      if (generation !== this.generation || this.closing || this.disks.get(slot!) !== disk) return;
      if (disk.failed) throw disk.failed;
      if (Atomics.load(disk.header, 1) !== sequence || Atomics.load(disk.header, 0) !== QEMU_DISK_PENDING)
        throw new Error("The emulator changed a pending disk request before its commit completed.");
      if (operationKind === "read") {
        if (!(result instanceof Uint8Array) || result.byteLength !== length) throw new Error("The volume returned an incomplete disk read.");
        disk.payload.set(result);
      }
      this.acknowledge(disk, sequence, QEMU_DISK_COMMITTED);
    }).catch((error: unknown) => {
      const failure = errorOf(error);
      if (generation === this.generation && this.disks.get(slot!) === disk)
        this.failDisk(slot!, disk, failure, QEMU_DISK_FAILED);
      throw failure;
    }).finally(() => { if (disk.pending === task) disk.pending = null; });
    disk.pending = task;
    return task;
  };

  private acknowledge(disk: OpenDisk, sequence: number, status: number): void {
    if (Atomics.load(disk.header, 1) !== sequence) return;
    Atomics.store(disk.header, 0, status);
    Atomics.notify(disk.header, 0);
  }
  private failDisk(slot: 0 | 1, disk: OpenDisk, error: Error, status: number): void {
    const first = !disk.failed;
    disk.failed = disk.failed ?? error;
    Atomics.store(disk.header, 0, status);
    Atomics.notify(disk.header, 0);
    this.update(slot, { status: "error", error: disk.failed.message });
    if (first) { try { this.options.onError?.(disk.failed); } catch { /* Owner handles teardown independently. */ } }
  }
  private failAll(error: Error): void {
    for (const [slot, disk] of this.disks) this.failDisk(slot, disk, error, QEMU_DISK_FAILED);
    if (!this.disks.size) { try { this.options.onError?.(error); } catch { /* Observer only. */ } }
  }
  flush = async (): Promise<void> => {
    for (const disk of this.disks.values()) {
      if (disk.pending) await disk.pending;
      if (disk.failed) throw disk.failed;
      await disk.session.flush();
    }
  };
  close = (): Promise<void> => {
    if (this.closing) return this.closing;
    this.generation++;
    for (const disk of this.disks.values()) {
      Atomics.store(disk.header, 0, QEMU_DISK_CANCELLED);
      Atomics.notify(disk.header, 0);
    }
    const task = (async () => {
      await this.opening?.catch(() => undefined);
      await this.releaseDisks();
    })();
    this.closing = task;
    void task.finally(() => { if (this.closing === task) this.closing = null; }).catch(() => undefined);
    return task;
  };
  private async releaseDisks(): Promise<void> {
    const disks = [...this.disks.entries()];
    // Wait for writes already accepted by storage. Termination cannot release a
    // writer's Web Lock while its IndexedDB commit is still in progress.
    const results = await Promise.allSettled(disks.map(async ([, disk]) => {
      try { await disk.pending; }
      finally { disk.unsubscribe(); await disk.session.close(); }
    }));
    for (const [slot, disk] of disks) {
      if (this.disks.get(slot) === disk) this.disks.delete(slot);
      const result = results[disks.findIndex(([number]) => number === slot)];
      const failure = result?.status === "rejected" ? errorOf(result.reason) : disk.failed;
      this.update(slot, { status: failure ? "error" : "closed", pendingWrites: 0, ...(failure ? { error: failure.message } : {}) });
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
