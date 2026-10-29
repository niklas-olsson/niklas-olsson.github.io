// SPDX-License-Identifier: Apache-2.0

export const MAX_COMMAND_BYTES = 8_192;
export const MAX_OUTPUT_BYTES = 65_536;
const encoder = new TextEncoder();

function validateToken(token: string): void {
  if (typeof token !== "string" || !/^[a-zA-Z0-9]{1,64}$/.test(token)) {
    throw new Error("Invalid command token.");
  }
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

/** Return complete UTF-8 code points without exceeding the byte budget. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const budget = Number.isFinite(maxBytes)
    ? Math.max(0, Math.floor(maxBytes))
    : 0;
  if (encoder.encode(text).byteLength <= budget) return text;
  let bytes = 0;
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > budget) break;
    bytes += size;
    length += character.length;
  }
  return text.slice(0, length);
}

export function commandFrame(command: string, token: string): string {
  validateToken(token);
  if (typeof command !== "string" || !command.trim())
    throw new Error("Enter a command first.");
  if (command.includes("\0"))
    throw new Error("Commands cannot contain a null character.");
  const bytes = encoder.encode(command);
  if (bytes.byteLength > MAX_COMMAND_BYTES)
    throw new Error("Commands are limited to 8 KiB.");

  // Send only ASCII data through the interactive serial line discipline.
  // Encoding protects quotes, newlines, Unicode, and terminal control bytes.
  // Short lines also avoid the guest TTY's canonical input-line limit.
  const payload = btoa(String.fromCharCode(...bytes));
  const chunks = payload.match(/.{1,512}/g)!;
  const writes = chunks.map(
    (chunk, index) =>
      `printf '%s' '${chunk}' ${index === 0 ? ">" : ">>"} "$_trm_dir/payload"`,
  );

  // This is a cooperative serial-shell protocol, not an isolation boundary.
  // Each call uses a fresh noninteractive shell; cwd and environment changes
  // do not persist. Guest files do persist until reset or checkpoint restore.
  // stdin is closed so read/cat cannot consume later protocol input.
  return [
    // Execute before the shell parses the compound frame. BusyBox otherwise
    // line-edits/echoes the entire encoded payload before reaching stty.
    "_trm_tty=$(stty -g); stty -echo",
    "{",
    `printf '\\n__TRM_BEGIN_${token}__\\n'`,
    "_trm_dir=$(mktemp -d /tmp/terrarium.XXXXXX)",
    'if [ -n "$_trm_dir" ] && [ -d "$_trm_dir" ]; then',
    ...writes,
    'if base64 -d "$_trm_dir/payload" > "$_trm_dir/run.sh"; then',
    '/bin/sh "$_trm_dir/run.sh" </dev/null',
    "_trm_rc=$?",
    "else",
    "_trm_rc=125",
    "fi",
    'rm -f "$_trm_dir/payload" "$_trm_dir/run.sh"',
    'rmdir "$_trm_dir"',
    "else",
    "_trm_rc=125",
    "fi",
    'stty "$_trm_tty" 2>/dev/null || stty sane echo -ixon -ixoff',
    `printf '\\n__TRM_END_${token}__:%s\\n' "$_trm_rc"`,
    "}",
    "",
  ].join("\n");
}

export function recoveryFrame(token: string): string {
  validateToken(token);
  return `case "\${_trm_dir-}" in /tmp/terrarium.??????) rm -f "$_trm_dir/payload" "$_trm_dir/run.sh"; rmdir "$_trm_dir" 2>/dev/null;; esac; stty "\${_trm_tty-}" 2>/dev/null || stty sane echo -ixon -ixoff; printf '\\n__TRM_READY_${token}__\\n'\n`;
}

export function hasRecoveryFrame(data: string, token: string): boolean {
  validateToken(token);
  return data.replace(/\r\n/g, "\n").includes(`\n__TRM_READY_${token}__\n`);
}

export function parseCommandFrame(
  data: string,
  token: string,
): { output: string; exitCode: number } | null {
  validateToken(token);
  const normalized = data.replace(/\r\n/g, "\n");
  const begin = `\n__TRM_BEGIN_${token}__\n`;
  const start = normalized.indexOf(begin);
  if (start === -1) return null;
  const remaining = normalized.slice(start + begin.length);
  const endings = new RegExp(`\\n__TRM_END_${token}__:(\\d{1,3})\\n`, "g");
  for (const end of remaining.matchAll(endings)) {
    const exitCode = Number(end[1]);
    if (exitCode <= 255)
      return { output: remaining.slice(0, end.index), exitCode };
  }
  return null;
}

function incompleteEndLength(text: string, token: string): number {
  const prefix = `\n__TRM_END_${token}__:`;
  const position = text.lastIndexOf("\n");
  if (position === -1) return 0;
  const tail = text.slice(position);
  if (prefix.startsWith(tail)) return tail.length;
  if (tail.startsWith(prefix) && /^\d{0,3}\r?$/.test(tail.slice(prefix.length)))
    return tail.length;
  return 0;
}

export function partialCommandOutput(data: string, token: string): string {
  validateToken(token);
  const normalized = data.replace(/\r\n/g, "\n");
  const begin = `\n__TRM_BEGIN_${token}__\n`;
  const start = normalized.indexOf(begin);
  if (start === -1) return "";
  const completed = parseCommandFrame(data, token);
  if (completed) return truncateUtf8(completed.output, MAX_OUTPUT_BYTES);
  const remaining = normalized.slice(start + begin.length);
  const pendingLength = incompleteEndLength(remaining, token);
  return truncateUtf8(
    pendingLength ? remaining.slice(0, -pendingLength) : remaining,
    MAX_OUTPUT_BYTES,
  );
}

/** Bounded stream collector: historical output must be excluded by the caller. */
export class CommandFrameReader {
  private buffer = "";
  private begun = false;
  private readonly begin: string;
  private readonly token: string;

  constructor(token: string) {
    validateToken(token);
    this.token = token;
    this.begin = `\n__TRM_BEGIN_${token}__\n`;
  }

  push(data: string): {
    output: string;
    exitCode: number | null;
    complete: boolean;
    limited: boolean;
  } {
    // Do not concatenate an arbitrarily large output event before enforcing
    // the cap. The collector retains only a bounded piece at a time.
    if (!data) return this.readPiece("");
    let result = {
      output: "",
      exitCode: null as number | null,
      complete: false,
      limited: false,
    };
    for (let offset = 0; offset < data.length; offset += 4_096) {
      result = this.readPiece(data.slice(offset, offset + 4_096));
      if (result.complete || result.limited) return result;
    }
    return result;
  }

  private readPiece(data: string): {
    output: string;
    exitCode: number | null;
    complete: boolean;
    limited: boolean;
  } {
    this.buffer = (this.buffer + data).replace(/\r\n/g, "\n");
    if (!this.begun) {
      const start = this.buffer.indexOf(this.begin);
      if (start === -1) {
        this.buffer = this.buffer.slice(-(this.begin.length + 1));
        return { output: "", exitCode: null, complete: false, limited: false };
      }
      this.buffer = this.buffer.slice(start);
      this.begun = true;
    }
    const completed = parseCommandFrame(this.buffer, this.token);
    const content = this.buffer.slice(this.begin.length);
    const pendingLength = incompleteEndLength(content, this.token);
    const output =
      completed?.output ??
      (pendingLength ? content.slice(0, -pendingLength) : content);
    const limited = encoder.encode(output).byteLength > MAX_OUTPUT_BYTES;
    const bounded = truncateUtf8(output, MAX_OUTPUT_BYTES);
    if (limited) this.buffer = this.begin + bounded;
    return {
      output: bounded,
      exitCode: completed?.exitCode ?? null,
      complete: !!completed,
      limited,
    };
  }

  getOutput(): string {
    return partialCommandOutput(this.buffer, this.token);
  }
}
