// SPDX-License-Identifier: Apache-2.0
// App-owned pins shared by the TypeScript application and raw module workers.
// Add only measured build outputs. No runtime registry or external configuration
// may add entries, replace pins, or choose executable paths.
export const LEGACY_QEMU_BUNDLE_ID = "qemu@8.2.0-b7c549b5-uart4-v1";
export const OWNED_QEMU_V2_BUNDLE_ID = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v2";
export const OWNED_QEMU_BUNDLE_ID = "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3";
export const SERVER_QEMU_V1_BUNDLE_ID = "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v1";
export const SERVER_QEMU_V2_BUNDLE_ID = "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v2";
export const SERVER_QEMU_BUNDLE_ID = "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v3";
export const DEFAULT_QEMU_BUNDLE_ID = LEGACY_QEMU_BUNDLE_ID;
export const QEMU_BUNDLES = Object.freeze({
  [LEGACY_QEMU_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-b7c549b5-uart4-v1",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 512,
    "virtualCpus": 1,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "legacy-cpu-websocket-bindings-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.43-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 512,
      "reservedWasmMiB": 2300,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "QEMU x86_64 JavaScript runtime",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/out.js",
        "bytes": 240815,
        "sha256": "dab94140dc2ea847181ba47ae4cbd759728e551d8fd9ba9de409711ed25eddcc"
      }),
      "kernel": Object.freeze({
        "name": "Alpine x86_64 kernel",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/load-kernel.data",
        "bytes": 11666432,
        "sha256": "dd239e40daf62dfb34e1bedb281ee66a98ae9664935d0471c026726629a52c25"
      }),
      "initramfs": Object.freeze({
        "name": "Alpine x86_64 initramfs",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/load-initramfs.data",
        "bytes": 9699151,
        "sha256": "84fd4d99c66dc78302428ea381c14252aad2c604fc16021d19c7dd12679fc09c"
      }),
      "rom": Object.freeze({
        "name": "Alpine x86_64 rom",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Alpine x86_64 rootfs",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/load-rootfs.data",
        "bytes": 82611515,
        "sha256": "e2facfffb787471a8784863fd8bf77dd87f098809a9b5cd54d9f082929596b3a"
      }),
      "wasm": Object.freeze({
        "name": "QEMU x86_64 WebAssembly runtime",
        "url": "https://raw.githubusercontent.com/ktock/qemu-wasm-demo-images/b7c549b5e6f4c376f76483a03e983214421434ad/alpine-x86_64/qemu-system-x86_64.wasm",
        "bytes": 40799480,
        "sha256": "f53107a35029d676aa551cd00d042f4f65af39a89bf72464494321fafdf54191"
      })
    }),
    "manifest": Object.freeze({
      "file": "alpine-packages.json",
      "bytes": 1163122,
      "sha256": "a8785aa9e14b50cfb9e95ae43cca7d992e635c52fbeae2cfbea5bfabf33a3ec0"
    }),
    "pthread": Object.freeze({
      "file": "qemu-system-x86_64.worker.js",
      "bytes": 6458,
      "sha256": "186440bb0507c34222ba52f4600c58080ea83d2158bd9d22c2faa6f038cf4dae"
    })
  }),
  [OWNED_QEMU_V2_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v2",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 512,
    "virtualCpus": 1,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "owned-minified-cpu-websocket-bindings-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.38-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 512,
      "reservedWasmMiB": 2300,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "Owned QEMU x86_64 module",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/out.js",
        "bytes": 169540,
        "sha256": "f7970f0a7e76d9f47bf7ee5115a8af6758dca5276e01cfeeb33bea53cf9a62ef"
      }),
      "kernel": Object.freeze({
        "name": "Owned QEMU x86_64 kernel",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-kernel.data",
        "bytes": 11658240,
        "sha256": "7e5c9e26d8dd032c8a1fa469f3bf8c2ea507fb3a486a8cb85fa2000005bc5cdc"
      }),
      "initramfs": Object.freeze({
        "name": "Owned QEMU x86_64 initramfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-initramfs.data",
        "bytes": 9110518,
        "sha256": "fe9a01e2a4adbe35a9c524aca87a5aa9970a0c0e6a0d8d823b83bc2ffe31648b"
      }),
      "rom": Object.freeze({
        "name": "Owned QEMU x86_64 rom",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Owned QEMU x86_64 rootfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rootfs.data",
        "bytes": 15861107,
        "sha256": "564ad6278fbb057946854e70bf3c1b98a221152900743128b0fd3fdc2dabe8f9"
      }),
      "wasm": Object.freeze({
        "name": "Owned QEMU x86_64 wasm",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/qemu-system-x86_64.wasm",
        "bytes": 11526461,
        "sha256": "d53d9f5590e5fbffece1ba53a5cc426b9ed0104c9a2a17574419303570574803"
      })
    }),
    "manifest": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/alpine-packages.json",
      "bytes": 1081467,
      "sha256": "b68081cd549109fa54a2d838186a847163ebff71290999c84cef11f3890841db"
    }),
    "pthread": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js",
      "bytes": 3271,
      "sha256": "960199074fdc92f0aa6c0665b6f15dff461fad6605743c5bb0c620438379a62c"
    })
  }),
  [OWNED_QEMU_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 512,
    "virtualCpus": 1,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "owned-minified-cpu-websocket-bindings-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.38-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 512,
      "reservedWasmMiB": 2300,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "Owned QEMU x86_64 module",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v3/out.js",
        "bytes": 169540,
        "sha256": "550dde9b6ee7c13d2de338c3227713c245cf2e27cbbf263d3bdf0eee1253f0fd"
      }),
      "kernel": Object.freeze({
        "name": "Owned QEMU x86_64 kernel",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-kernel.data",
        "bytes": 11658240,
        "sha256": "7e5c9e26d8dd032c8a1fa469f3bf8c2ea507fb3a486a8cb85fa2000005bc5cdc"
      }),
      "initramfs": Object.freeze({
        "name": "Owned QEMU x86_64 initramfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-initramfs.data",
        "bytes": 9110518,
        "sha256": "fe9a01e2a4adbe35a9c524aca87a5aa9970a0c0e6a0d8d823b83bc2ffe31648b"
      }),
      "rom": Object.freeze({
        "name": "Owned QEMU x86_64 rom",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Owned QEMU x86_64 rootfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rootfs.data",
        "bytes": 15861107,
        "sha256": "564ad6278fbb057946854e70bf3c1b98a221152900743128b0fd3fdc2dabe8f9"
      }),
      "wasm": Object.freeze({
        "name": "Owned QEMU x86_64 wasm",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v3/qemu-system-x86_64.wasm",
        "bytes": 11526469,
        "sha256": "32529d7ed12b5c600bdd821cc17a38a74212c293a703a01c4bb147a40116f420"
      })
    }),
    "manifest": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/alpine-packages.json",
      "bytes": 1081467,
      "sha256": "b68081cd549109fa54a2d838186a847163ebff71290999c84cef11f3890841db"
    }),
    "pthread": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js",
      "bytes": 3271,
      "sha256": "960199074fdc92f0aa6c0665b6f15dff461fad6605743c5bb0c620438379a62c"
    })
  }),
  [SERVER_QEMU_V1_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v1",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 2048,
    "virtualCpus": 2,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "owned-minified-cpu-websocket-bindings-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.38-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 2048,
      "reservedWasmMiB": 3584,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "Owned server QEMU x86_64 module",
        "url": "runtime/qemu/bundles/owned-s2-server-v1/out.js",
        "bytes": 169540,
        "sha256": "8df25d4485805784ea62fd4d0fb32aa20674613c7017524bdf086f82fcd2044f"
      }),
      "kernel": Object.freeze({
        "name": "Owned QEMU x86_64 kernel",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-kernel.data",
        "bytes": 11658240,
        "sha256": "7e5c9e26d8dd032c8a1fa469f3bf8c2ea507fb3a486a8cb85fa2000005bc5cdc"
      }),
      "initramfs": Object.freeze({
        "name": "Owned QEMU x86_64 initramfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-initramfs.data",
        "bytes": 9110518,
        "sha256": "fe9a01e2a4adbe35a9c524aca87a5aa9970a0c0e6a0d8d823b83bc2ffe31648b"
      }),
      "rom": Object.freeze({
        "name": "Owned QEMU x86_64 rom",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Owned QEMU x86_64 rootfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rootfs.data",
        "bytes": 15861107,
        "sha256": "564ad6278fbb057946854e70bf3c1b98a221152900743128b0fd3fdc2dabe8f9"
      }),
      "wasm": Object.freeze({
        "name": "Owned server QEMU x86_64 wasm",
        "url": "runtime/qemu/bundles/owned-s2-server-v1/qemu-system-x86_64.wasm",
        "bytes": 11526469,
        "sha256": "420831479233ec5e91fb6eb90c237a96ddb5bd71995ed5de0872e734785be1eb"
      })
    }),
    "manifest": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/alpine-packages.json",
      "bytes": 1081467,
      "sha256": "b68081cd549109fa54a2d838186a847163ebff71290999c84cef11f3890841db"
    }),
    "pthread": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js",
      "bytes": 3271,
      "sha256": "960199074fdc92f0aa6c0665b6f15dff461fad6605743c5bb0c620438379a62c"
    })
  }),
  [SERVER_QEMU_V2_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v2",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 2048,
    "virtualCpus": 2,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "owned-minified-cpu-websocket-bindings-v1",
    "machineMemoryLayout": "split-2x1024m-ram-blocks-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.38-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 2048,
      "reservedWasmMiB": 3584,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "Owned server QEMU x86_64 module",
        "url": "runtime/qemu/bundles/owned-s2-server-v2/out.js",
        "bytes": 169557,
        "sha256": "342f657d300ca662030b4432c1bb34b2fa0ea018cd2310da3e497537027dcc08"
      }),
      "kernel": Object.freeze({
        "name": "Owned QEMU x86_64 kernel",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-kernel.data",
        "bytes": 11658240,
        "sha256": "7e5c9e26d8dd032c8a1fa469f3bf8c2ea507fb3a486a8cb85fa2000005bc5cdc"
      }),
      "initramfs": Object.freeze({
        "name": "Owned QEMU x86_64 initramfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-initramfs.data",
        "bytes": 9110518,
        "sha256": "fe9a01e2a4adbe35a9c524aca87a5aa9970a0c0e6a0d8d823b83bc2ffe31648b"
      }),
      "rom": Object.freeze({
        "name": "Owned QEMU x86_64 rom",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Owned QEMU x86_64 rootfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rootfs.data",
        "bytes": 15861107,
        "sha256": "564ad6278fbb057946854e70bf3c1b98a221152900743128b0fd3fdc2dabe8f9"
      }),
      "wasm": Object.freeze({
        "name": "Owned server QEMU x86_64 wasm",
        "url": "runtime/qemu/bundles/owned-s2-server-v2/qemu-system-x86_64.wasm",
        "bytes": 11527698,
        "sha256": "890e807f89b165d80a756fba5ccb61ce2b8e7f956fa53d14740eb82c337045e3"
      })
    }),
    "manifest": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/alpine-packages.json",
      "bytes": 1081467,
      "sha256": "b68081cd549109fa54a2d838186a847163ebff71290999c84cef11f3890841db"
    }),
    "pthread": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js",
      "bytes": 3271,
      "sha256": "960199074fdc92f0aa6c0665b6f15dff461fad6605743c5bb0c620438379a62c"
    })
  }),
  [SERVER_QEMU_BUNDLE_ID]: Object.freeze({
    "id": "qemu@8.2.0-terrarium-0ef7b4e-s2-server-v3",
    "profileId": "alpine-x86_64",
    "architecture": "x86_64",
    "memoryMiB": 2048,
    "virtualCpus": 2,
    "serialPorts": 4,
    "integration": "terrarium-qemu-uart4-v1",
    "nodeAdapter": "owned-minified-cpu-websocket-bindings-v1",
    "machineMemoryLayout": "split-2x1024m-ram-blocks-v1",
    "guest": Object.freeze({
      "userland": "Alpine Linux 3.21.4",
      "kernel": "6.12.38-0-virt",
      "rootBytes": 157286400
    }),
    "resources": Object.freeze({
      "guestMemoryMiB": 2048,
      "reservedWasmMiB": 3584,
      "translationCacheMiB": 500
    }),
    "assets": Object.freeze({
      "module": Object.freeze({
        "name": "Owned server QEMU x86_64 module",
        "url": "runtime/qemu/bundles/owned-s2-server-v3/out.js",
        "bytes": 169827,
        "sha256": "6dafedb87255cf3e3e5bfbd18c6f4a76a8f4a18a33f17bb34c8c04f5511b8c0e"
      }),
      "kernel": Object.freeze({
        "name": "Owned QEMU x86_64 kernel",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-kernel.data",
        "bytes": 11658240,
        "sha256": "7e5c9e26d8dd032c8a1fa469f3bf8c2ea507fb3a486a8cb85fa2000005bc5cdc"
      }),
      "initramfs": Object.freeze({
        "name": "Owned QEMU x86_64 initramfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-initramfs.data",
        "bytes": 9110518,
        "sha256": "fe9a01e2a4adbe35a9c524aca87a5aa9970a0c0e6a0d8d823b83bc2ffe31648b"
      }),
      "rom": Object.freeze({
        "name": "Owned QEMU x86_64 rom",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rom.data",
        "bytes": 473088,
        "sha256": "15de099e1363ceb13a31b9d11836337bab974f9460836449330b20c0534d06c9"
      }),
      "rootfs": Object.freeze({
        "name": "Owned QEMU x86_64 rootfs",
        "url": "runtime/qemu/bundles/owned-s1-candidate-v2/load-rootfs.data",
        "bytes": 15861107,
        "sha256": "564ad6278fbb057946854e70bf3c1b98a221152900743128b0fd3fdc2dabe8f9"
      }),
      "wasm": Object.freeze({
        "name": "Owned server QEMU x86_64 wasm",
        "url": "runtime/qemu/bundles/owned-s2-server-v3/qemu-system-x86_64.wasm",
        "bytes": 11527698,
        "sha256": "664f7bc0062bd702212c5a04bffda3c910fe51ed2c757cb0773ec25bfc280e86"
      })
    }),
    "manifest": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/alpine-packages.json",
      "bytes": 1081467,
      "sha256": "b68081cd549109fa54a2d838186a847163ebff71290999c84cef11f3890841db"
    }),
    "pthread": Object.freeze({
      "file": "bundles/owned-s1-candidate-v2/qemu-system-x86_64.worker.js",
      "bytes": 3271,
      "sha256": "960199074fdc92f0aa6c0665b6f15dff461fad6605743c5bb0c620438379a62c"
    })
  })
});
