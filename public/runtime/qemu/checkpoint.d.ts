export const MAX_CHECKPOINT_BYTES: number;
export function createCheckpointDisk(): Uint8Array<ArrayBuffer>;
export function validateCheckpointDisk(bytes: Uint8Array, requireSnapshot?: boolean): Uint8Array;
