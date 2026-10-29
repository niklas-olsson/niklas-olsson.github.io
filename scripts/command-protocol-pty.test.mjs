// SPDX-License-Identifier: Apache-2.0
// Linux PTY integration: actual shell parsing and terminal restoration.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { commandFrame, recoveryFrame } from '../src/lib/command-protocol.ts';
const probe = String.raw`
import json, os, pty, select, subprocess, sys, termios, time
frame, original_echo, expected_rc, recovery = json.loads(sys.stdin.read())
master, slave = pty.openpty()
flags = termios.tcgetattr(slave)
if not original_echo: flags[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, flags)
original = termios.tcgetattr(slave)
child = subprocess.Popen(['/bin/sh', '-i'], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
def drain():
 data = b''
 while select.select([master], [], [], 0.02)[0]: data += os.read(master, 65536)
 return data
try:
 drain()
 # Stop before the compound frame: its payload must not be needed for no-echo.
 boundary = frame.index('{\n')
 os.write(master, frame[:boundary].encode())
 deadline = time.monotonic() + 2
 while termios.tcgetattr(slave)[3] & termios.ECHO and time.monotonic() < deadline: time.sleep(0.005)
 assert not (termios.tcgetattr(slave)[3] & termios.ECHO), 'ECHO still enabled before the compound frame'
 os.write(master, frame[boundary:].encode())
 output = b''; deadline = time.monotonic() + 3
 marker = ('\n__TRM_END_pty__:%s\n' % expected_rc).encode()
 while time.monotonic() < deadline:
  output += drain()
  if marker in output.replace(b'\r\n', b'\n'): break
 assert marker in output.replace(b'\r\n', b'\n'), repr(output)
 assert termios.tcgetattr(slave) == original, 'Original terminal settings were not restored'
 os.write(master, recovery.encode())
 ready = b'\n__TRM_READY_pty__\n'; output = b''; deadline = time.monotonic() + 2
 while time.monotonic() < deadline:
  output += drain()
  if ready in output.replace(b'\r\n', b'\n'): break
 assert ready in output.replace(b'\r\n', b'\n'), repr(output)
 assert termios.tcgetattr(slave) == original, 'Recovery changed the original terminal settings' 
 print(json.dumps({'echoBeforePayload': False, 'restored': True, 'exitCode': expected_rc}))
finally:
 child.kill(); child.wait(timeout=3); os.close(master); os.close(slave)
`;
for (const [command, echo, rc] of [['printf ok', true, 0], ['exit 7', true, 7], ['printf ok', false, 0]]) {
 test(`pre-frame no-echo and exact terminal restoration: echo=${echo}, exit=${rc}`, () => {
  const child = spawnSync('python3', ['-B', '-c', probe], { input: JSON.stringify([commandFrame(command, 'pty'), echo, rc, recoveryFrame('pty')]), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
 });
}
