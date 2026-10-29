// SPDX-License-Identifier: Apache-2.0
import type { V86 } from "v86";
import type { VolumeSession } from "./volume-store.ts";

interface Descriptor { addr_low: number; addr_high: number; len: number }
interface BufferChain {
  length_readable: number; length_writable: number; length_written: number;
  read_buffers: Descriptor[]; write_buffers: Descriptor[];
  get_next_blob(destination: Uint8Array): number;
  set_next_blob(source: Uint8Array): number;
}
interface Queue {
  enabled: boolean; size: number; desc_addr: number; avail_addr: number; used_addr: number;
  count_requests(): number; has_request(): boolean; pop_request(): BufferChain;
  push_reply(chain: BufferChain): void; flush_replies(): void; notify_me_after(count: number): void;
}
interface Cpu { mem8: Uint8Array; write8(address: number, byte: number): void }
interface Virtio { queues: Queue[]; needs_reset(): void; reset(): void }
interface CapabilityField { bytes: 1 | 2 | 4; name: string; read(): number; write(value: number): void }
interface VirtioOptions {
  name: string; pci_id: number; device_id: number; subsystem_device_id: number;
  common: { initial_port: number; queues: { size_supported: number; notify_offset: number }[]; features: number[]; on_driver_ok(): void };
  notification: { initial_port: number; single_handler: boolean; handlers: ((queue: number) => void)[] };
  isr_status: { initial_port: number };
  device_specific: { initial_port: number; struct: CapabilityField[] };
}
type VirtioConstructor = new (cpu: Cpu, options: VirtioOptions) => Virtio;
declare global { var TerrariumVirtIO: VirtioConstructor | undefined }

const MAX_REQUEST_BYTES = 1024 * 1024;
const QUEUE_SIZE = 128;
const STATUS_OK = 0, STATUS_IO_ERROR = 1, STATUS_UNSUPPORTED = 2;

/** Real VirtIO block I/O. Successful writes wait for an IndexedDB commit. */
export class PersistentVirtioBlock {
  private readonly cpu: Cpu;
  private readonly virtio: Virtio;
  private readonly session: VolumeSession;
  private readonly onFailure: (error: Error) => void;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private inflight = 0;
  private epoch = 0;
  private requests = new WeakMap<BufferChain, { desc: number; avail: number; used: number; epoch: number }>();

  constructor(emulator: V86, session: VolumeSession, slot: 0 | 1, onFailure: (error: Error) => void) {
    const Constructor = globalThis.TerrariumVirtIO;
    const cpu = (emulator as unknown as { v86?: { cpu?: Cpu } }).v86?.cpu;
    if (!Constructor || !cpu?.mem8) throw new Error("The pinned VirtIO integration is unavailable. Prepare and deploy the complete runtime assets.");
    this.cpu = cpu; this.session = session; this.onFailure = onFailure;
    const port = 0xe000 + slot * 0x400;
    const field = (name: string, value: number): CapabilityField => ({ bytes: 4, name, read: () => value, write: () => {} });
    this.virtio = new Constructor(cpu, {
      name: `terrarium-volume-${slot}`, pci_id: (14 + slot) << 3,
      device_id: 0x1042, subsystem_device_id: 2,
      common: {
        initial_port: port, queues: [{ size_supported: QUEUE_SIZE, notify_offset: 0 }],
        // SIZE_MAX, SEG_MAX, BLK_SIZE, FLUSH, VERSION_1. Direct descriptor chains
        // are bounded; the upstream indirect-table parser is not negotiated.
        features: [1, 2, 6, 9, 32, ...(session.readOnly ? [5] : [])],
        on_driver_ok: () => {},
      },
      notification: { initial_port: port + 0x100, single_handler: false, handlers: [(queue) => this.notify(queue)] },
      isr_status: { initial_port: port + 0x200 },
      device_specific: { initial_port: port + 0x300, struct: [
        field("capacity-low", session.getMetadata().bytes / 512), field("capacity-high", 0),
        field("size-max", MAX_REQUEST_BYTES), field("seg-max", QUEUE_SIZE - 2),
        field("geometry", 0), field("block-size", 512),
      ] },
    });
    const reset = this.virtio.reset.bind(this.virtio);
    this.virtio.reset = () => { this.epoch++; reset(); };
  }
  private inMemory(address: number, length: number): boolean {
    return Number.isInteger(length) && length >= 0 && (address >>> 0) + length <= this.cpu.mem8.byteLength;
  }
  private safeQueue(queue: Queue): boolean {
    return queue.enabled && Number.isInteger(queue.size) && queue.size > 0 && queue.size <= QUEUE_SIZE &&
      (queue.size & (queue.size - 1)) === 0 &&
      this.inMemory(queue.desc_addr, queue.size * 16) && this.inMemory(queue.avail_addr, 6 + queue.size * 2) &&
      this.inMemory(queue.used_addr, 6 + queue.size * 8) && queue.count_requests() <= queue.size;
  }
  private notify(index: number): void {
    if (this.disposed) return;
    const queue = this.virtio.queues[0];
    if (index !== 0 || !this.safeQueue(queue)) { this.fail(new Error("The guest supplied an invalid VirtIO disk queue.")); return; }
    let taken = 0;
    while (queue.has_request() && taken++ < queue.size) {
      if (++this.inflight > QUEUE_SIZE) { this.fail(new Error("The guest exceeded the bounded VirtIO disk request queue.")); return; }
      const chain = queue.pop_request();
      this.requests.set(chain, { desc: queue.desc_addr, avail: queue.avail_addr, used: queue.used_addr, epoch: this.epoch });
      this.tail = this.tail.then(() => this.process(queue, chain)).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => { this.inflight--; });
    }
    queue.notify_me_after(0);
  }
  private validChain(chain: BufferChain): boolean {
    const all = [...chain.read_buffers, ...chain.write_buffers];
    return chain.write_buffers.length > 0 && all.length > 0 && all.length <= QUEUE_SIZE &&
      all.every((buffer) => buffer.addr_high === 0 && this.inMemory(buffer.addr_low, buffer.len)) &&
      Number.isSafeInteger(chain.length_readable) && chain.length_readable >= 16 && chain.length_readable <= MAX_REQUEST_BYTES + 16 &&
      Number.isSafeInteger(chain.length_writable) && chain.length_writable >= 1 && chain.length_writable <= MAX_REQUEST_BYTES + 1 &&
      chain.write_buffers.at(-1)!.len >= 1;
  }
  private current(queue: Queue, chain: BufferChain): boolean {
    const original = this.requests.get(chain);
    // Driver reset cancels completion into an old queue. Never use changed
    // queue addresses after an asynchronous storage transaction.
    return !this.disposed && Boolean(original && original.epoch === this.epoch && queue.enabled && original.desc === queue.desc_addr && original.avail === queue.avail_addr && original.used === queue.used_addr);
  }
  private complete(queue: Queue, chain: BufferChain, status: number): void {
    if (!this.current(queue, chain)) return;
    const last = chain.write_buffers.at(-1)!;
    this.cpu.write8((last.addr_low >>> 0) + last.len - 1, status);
    chain.length_written++;
    queue.push_reply(chain); queue.flush_replies();
  }
  private async process(queue: Queue, chain: BufferChain): Promise<void> {
    if (!this.current(queue, chain)) return;
    if (!this.validChain(chain)) { this.fail(new Error("The guest supplied an invalid VirtIO block descriptor.")); return; }
    const header = new Uint8Array(16);
    if (chain.get_next_blob(header) !== 16) { this.complete(queue, chain, STATUS_IO_ERROR); return; }
    const view = new DataView(header.buffer);
    const type = view.getUint32(0, true), sectorHigh = view.getUint32(12, true);
    const offset = view.getUint32(8, true) * 512;
    try {
      if (type === 0) {
        const length = chain.length_writable - 1;
        if (sectorHigh || length % 512 || offset + length > this.session.getMetadata().bytes) { this.complete(queue, chain, STATUS_IO_ERROR); return; }
        const data = await this.session.read(offset, length);
        if (!this.current(queue, chain)) return;
        chain.set_next_blob(data);
      } else if (type === 1) {
        const length = chain.length_readable - 16;
        // RO is both advertised to Linux and enforced independently by the host.
        if (this.session.readOnly || sectorHigh || length % 512 || offset + length > this.session.getMetadata().bytes) { this.complete(queue, chain, STATUS_IO_ERROR); return; }
        const data = new Uint8Array(length);
        if (chain.get_next_blob(data) !== length) { this.complete(queue, chain, STATUS_IO_ERROR); return; }
        await this.session.write(offset, data);
      } else if (type === 4) {
        await this.session.flush();
      } else if (type === 8) {
        const identity = new Uint8Array(Math.min(20, chain.length_writable - 1));
        identity.set(new TextEncoder().encode(this.session.getMetadata().id.replaceAll("-", "").slice(0, identity.length)));
        chain.set_next_blob(identity);
      } else { this.complete(queue, chain, STATUS_UNSUPPORTED); return; }
      this.complete(queue, chain, STATUS_OK);
    } catch (error) {
      this.complete(queue, chain, STATUS_IO_ERROR);
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.virtio.needs_reset();
    this.onFailure(error);
  }
  async drain(): Promise<void> {
    let observed: Promise<void>;
    do { observed = this.tail; await observed; } while (observed !== this.tail);
    await this.session.flush();
  }
  dispose(): void { this.disposed = true; }
}
