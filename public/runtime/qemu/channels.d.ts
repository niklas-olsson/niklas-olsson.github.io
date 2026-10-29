export type EthernetBytes = Uint8Array | ArrayBuffer;

export class EthernetStream {
  constructor(receive: (frame: Uint8Array) => void);
  readonly receive: (frame: Uint8Array) => void;
  pending: Uint8Array;
  push(input: EthernetBytes): void;
  clear(): void;
  static frame(input: EthernetBytes): Uint8Array;
}

export interface InternalSocketEvent {
  data?: ArrayBuffer;
  code?: number;
  wasClean?: boolean;
}
export interface InternalEthernetSocket {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  readonly url: string;
  readyState: number;
  binaryType: string;
  bufferedAmount: number;
  onopen?: (event: InternalSocketEvent) => void;
  onmessage?: (event: InternalSocketEvent & { data: ArrayBuffer }) => void;
  onclose?: (event: InternalSocketEvent) => void;
  on(type: "message", listener: (data: Uint8Array, isBinary: boolean) => void): this;
  on(type: "open" | "close" | "error", listener: (event: InternalSocketEvent) => void): this;
  addEventListener(type: "message", listener: (event: InternalSocketEvent & { data: ArrayBuffer }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: (event: InternalSocketEvent) => void): void;
  removeEventListener(type: "message", listener: (event: InternalSocketEvent & { data: ArrayBuffer }) => void): void;
  removeEventListener(type: "open" | "close" | "error", listener: (event: InternalSocketEvent) => void): void;
  send(data: EthernetBytes | string): void;
  deliver(data: Uint8Array): void;
  close(): void;
}
export interface InternalSockets {
  Socket: {
    new (url: string | URL, protocols?: string | string[]): InternalEthernetSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
  setCarrier(enabled: boolean): void;
  receive(frame: EthernetBytes): void;
  close(): void;
}

export function createInternalSockets(options: {
  onFrame: (frame: Uint8Array) => void;
  onError: (error: Error) => void;
}): InternalSockets;
