// SPDX-License-Identifier: Apache-2.0

import { MAX_INIT_SCRIPT_BYTES, type SerialPort } from "./runtime-types.ts";
import { shellQuote } from "./command-protocol.ts";

export const INTERACTIVE_SERIAL_PORTS = [1, 2, 3] as const;

export function validateInitScript(script: string): string {
  if (typeof script !== "string")
    throw new Error("The init script must be text.");
  if (script.includes("\0"))
    throw new Error("The init script cannot contain a null character.");
  if (new TextEncoder().encode(script).byteLength > MAX_INIT_SCRIPT_BYTES)
    throw new Error("The init script is limited to 8 KiB of UTF-8.");
  return script;
}

/** Independent controlling terminals, session IDs, process groups, and cwd. */
export function sessionBootstrapCommand(options: { configureFourthUart?: boolean } = {}): string {
  const commands = [
    "set -e",
    "mkdir -p /run/terrarium",
  ];
  // The v86 guest needs explicit configuration of its fourth UART. QEMU
  // exposes all four through the Linux serial driver at boot.
  if (options.configureFourthUart !== false)
    commands.push("setserial /dev/ttyS3 uart 16550A port 0x2e8 irq 3");
  for (const port of INTERACTIVE_SERIAL_PORTS) {
    const shell = [
      "#!/bin/sh",
      "_trm_rows=24; _trm_cols=80",
      `if [ -r /run/terrarium/ttyS${port}.size ]; then read -r _trm_rows _trm_cols < /run/terrarium/ttyS${port}.size || true; fi`,
      'case "$_trm_rows" in ""|*[!0-9]*) _trm_rows=24;; esac',
      'case "$_trm_cols" in ""|*[!0-9]*) _trm_cols=80;; esac',
      'stty sane -ixon -ixoff rows "$_trm_rows" cols "$_trm_cols"',
      "export TERM=xterm-256color",
      "export HOME=/root USER=root",
      "cd /root",
      `export PS1=${shellQuote(`shell-${port}> `)}`,
      "exec /bin/sh -i",
    ].join("\n");
    const path = `/run/terrarium/shell-${port}.sh`;
    const entry = `ttyS${port}::respawn:/bin/sh ${path}`;
    commands.push(`printf '%s\\n' ${shellQuote(shell)} > ${path}`);
    commands.push(`chmod 700 ${path}`);
    commands.push(
      `grep -Fqx ${shellQuote(entry)} /etc/inittab || printf '%s\\n' ${shellQuote(entry)} >> /etc/inittab`,
    );
  }
  // PID 1 opens each controlling terminal and starts a new session with clean
  // signal dispositions. A shell detached with "&" would inherit ignored INT
  // and QUIT signals from the noninteractive command transport.
  commands.push("kill -HUP 1");
  return commands.join("\n");
}

export function isSessionPrompt(output: string, port: SerialPort): boolean {
  return output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .endsWith(`shell-${port}> `);
}
