// SPDX-License-Identifier: Apache-2.0

// Hardware is selected only through the versioned data-only machine contract.
// This list never admits free-form emulator arguments or executable asset URLs.
const constructorKeys = new Set(["profileId", "defaultBootBundleId", "initScript", "networkPort", "volumes", "resourceBudget", "machine"]);
const instanceKeys = new Set(["name", "imageId", "initScript", "vpcId", "subnetId", "ip", "machine"]);
const bootKeys = new Set(["type", "runtimeBundleId", "profileId", "memoryMiB", "mac", "network",
  "module", "wasm", "kernel", "initramfs", "rom", "rootfs", "disks", "evidenceImage", "checkpoint", "machine", "customImage"]);

function exactOptions(value, allowed, context) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context} requires an options object with the declared fields.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error(`${context} requires plain options; inherited hardware or boot overrides are unsupported.`);
  // Inspect names without reading values, so rejecting an extra property never
  // invokes its getter. Non-enumerable and symbol extras are also rejected.
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key)) {
      const label = typeof key === "string" ? JSON.stringify(key.slice(0, 80)) : "a symbol key";
      throw new Error(`${context} has unsupported option ${label}. x86_64 uses fixed hardware and boot assets from its registered profile; overrides and arbitrary emulator arguments are not supported.`);
    }
  }
}

export function assertQemuConstructorOptions(options) { exactOptions(options, constructorKeys, "QEMU runtime construction"); }
export function assertQemuInstanceCreateOptions(options) { exactOptions(options, instanceKeys, "x86_64 instance creation"); }
export function assertQemuBootOptions(options) { exactOptions(options, bootKeys, "QEMU worker boot"); }
