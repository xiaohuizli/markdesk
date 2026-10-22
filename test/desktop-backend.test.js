import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/server.js', import.meta.url));
function launch(t, parent = process.pid) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: '0', PAPER_DESKTOP: '1', PAPER_PARENT_PID: String(parent), PAPER_WORKSPACE: path.resolve('demo') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) { try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (e) { reject(e); } } });
  });
  return { child, ready, exited };
}
test('desktop backend starts on an ephemeral loopback port and exits cleanly', { timeout: 5000 }, async (t) => {
  const { child, ready, exited } = launch(t), result = await ready;
  assert.equal(result.event, 'ready'); assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.notEqual(new URL(result.url).port, '0');
  const response = await fetch(result.url); assert.equal(response.status, 200); assert.match(await response.text(), /paper-token/);
  child.kill('SIGTERM'); const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null);
});
test('desktop backend shuts down when the native parent no longer exists', { timeout: 5000 }, async (t) => {
  const { ready, exited } = launch(t, 2147483646); await ready;
  const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null);
});
