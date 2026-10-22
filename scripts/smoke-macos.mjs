import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd(), arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const scratch = mkdtempSync(path.join(tmpdir(), 'paper-macos-smoke-'));
const diagnostics = path.join(root, 'work', 'macos-smoke'); mkdirSync(diagnostics, { recursive: true });
const application = path.join(scratch, 'Paper Search.app');
const logFile = path.join(diagnostics, 'launch.jsonl'); rmSync(logFile, { force: true });
execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(root, 'dist', `Paper Search-mac-${arch}.app.zip`), scratch]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { stdio: 'inherit' });
execFileSync('/usr/bin/open', ['-n', application, '--env', 'PAPER_DESKTOP_LOG=' + logFile, '--env', 'PAPER_WORKSPACE=' + path.join(application, 'Contents/Resources/app/demo')]);
let records = [];
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { records = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
    const error = records.find(record => record.event === 'app.error');
    if (error) throw new Error(error.message);
    if (records.some(record => record.event === 'ui.ready') && records.some(record => record.event === 'bridge.request' && record.method === 'rendererReady')) break;
    await delay(500);
  }
  if (!records.some(record => record.event === 'ui.ready')) throw new Error('macOS 桌面界面启动超时');
  if (!records.some(record => record.event === 'bridge.request' && record.method === 'rendererReady')) throw new Error('macOS 桌面桥接未就绪');
  const origin = records.find(record => record.event === 'backend.ready')?.url;
  const html = await (await fetch(origin)).text();
  const token = /name="paper-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error('会话令牌不存在');
  const response = await fetch(origin + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-token': token }, body: JSON.stringify({ query: '搜索', clientId: 'macos-smoke', requestId: 'smoke-1', revision: 0, options: {} }), signal: AbortSignal.timeout(10000) });
  const stream = await response.text();
  if (!response.ok || !stream.includes('"type":"file"') || !stream.includes('"type":"done"') || stream.includes('"type":"error"')) throw new Error('macOS 搜索验证失败: ' + stream.slice(-1000));
  console.log(JSON.stringify({ event: 'smoke.passed', platform: 'darwin', arch, packaged: true }));
} finally {
  const pid = records.find(record => record.event === 'app.launch')?.appPid;
  if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
