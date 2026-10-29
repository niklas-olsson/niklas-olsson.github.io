// SPDX-License-Identifier: Apache-2.0
export class Sha256Stream {
  update(input: Uint8Array): this;
  digestHex(): string;
}
