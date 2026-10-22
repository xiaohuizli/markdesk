import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';

async function start(t, config = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-http-')); await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'start.md'), '# Start\n');
  await writeFile(path.join(root, 'notes/target.md'), '# Heading\r\n\r\n中文🙂 REA_CHAIN unique match\r\n');
  const app = await createApp({ workspace: root, ...config }); await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = (route, data, headers = {}) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-paper-token': app.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const search = (query, requestId, clientId = 'test-client') => request('/api/search', { clientId, requestId, query, revision: 0 });
  return { app, root, base, request, search };
}
function events(text) { return text.split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))); }
test('HTTP request → rg → SSE → document read → navigation acknowledgement share one request ID', async (t) => {
  const { request, search } = await start(t);
  const response = await search('REA_CHAIN', 'full-chain'); assert.equal(response.status, 200);
  const stream = events(await response.text()), hit = stream.find((e) => e.type === 'file').matches[0];
  assert.equal(stream.at(-1).failed, false); assert.equal(hit.line, 3);
  assert.equal(hit.text.slice(hit.ranges[0].start, hit.ranges[0].end), 'REA_CHAIN');
  const qs = new URLSearchParams({ path: 'notes/target.md', requestId: 'full-chain', line: '3' });
  const document = await (await request('/api/document?' + qs)).json(); assert(document.text.includes('中文🙂 REA_CHAIN'));
  await request('/api/interaction', { type: 'navigation.ready', requestId: 'full-chain', path: 'notes/target.md', line: 3, selectedText: 'REA_CHAIN' });
  const trace = await (await request('/api/trace?requestId=full-chain')).json();
  for (const name of ['input.submit', 'transport.request', 'process.spawn', 'rg.record', 'stream.file', 'process.close', 'stream.done', 'navigation.read', 'navigation.ready']) assert(trace.events.some((e) => e.type === name), name);
  assert(trace.events.every((e) => e.requestId === 'full-chain')); assert.equal(trace.dropped, 0);
  const processEvent = trace.events.find((e) => e.type === 'process.spawn'); assert(processEvent.pid > 0); assert(processEvent.args.includes('REA_CHAIN'));
  assert.equal(trace.events.at(-1).line, 3);
});
test('missing token, cross-origin, traversal and symlink reads are rejected', async (t) => {
  const { root, base, request } = await start(t);
  assert.equal((await fetch(base + '/api/state')).status, 403);
  assert.equal((await request('/api/state', undefined, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await request('/api/document?' + new URLSearchParams({ path: '../package.json' }))).status, 400);
  const outside = await mkdtemp(path.join(tmpdir(), 'paper-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private.md'), 'outside'); await symlink(path.join(outside, 'private.md'), path.join(root, 'escape.md'));
  assert.equal((await request('/api/document?path=escape.md')).status, 400);
});
test('workspace change increments revision and rejects stale queries', async (t) => {
  const { root, request } = await start(t);
  assert.equal((await request('/api/workspace', { path: 'relative' })).status, 400);
  const changed = await (await request('/api/workspace', { path: path.join(root, 'notes') })).json(); assert.equal(changed.revision, 1);
  assert.equal((await request('/api/search', { query: 'REA_CHAIN', requestId: 'stale', clientId: 'test', revision: 0 })).status, 400);
});
test('document API rejects oversized, binary and invalid UTF-8 documents', async (t) => {
  const { root, request } = await start(t);
  await writeFile(path.join(root, 'oversized.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await writeFile(path.join(root, 'binary.md'), Buffer.from([65, 0, 66]));
  await writeFile(path.join(root, 'invalid.md'), Buffer.from([0xff, 0xfe, 0xff]));
  for (const file of ['oversized.md', 'binary.md', 'invalid.md']) assert.equal((await request('/api/document?path=' + file)).status, 400, file);
});
test('UTF-8 BOM is decoded consistently between rg results and the document reader', async (t) => {
  const { root, request, search } = await start(t);
  await writeFile(path.join(root, 'bom.md'), '\uFEFF中文🙂 bom-marker\r\n');
  const stream = events(await (await search('bom-marker', 'bom')).text());
  const file = stream.find((e) => e.type === 'file' && e.path === 'bom.md'), match = file.matches[0];
  const document = await (await request('/api/document?path=bom.md')).json();
  assert.equal(document.text.split(/\r?\n/)[0], match.text);
  assert.equal(document.text.slice(match.ranges[0].start, match.ranges[0].end), 'bom-marker');
});
test('three overlapping requests for the same client cancel queued and running jobs without deadlock', { timeout: 10000 }, async (t) => {
  const helperDir = await mkdtemp(path.join(tmpdir(), 'paper-helper-')); t.after(() => rm(helperDir, { recursive: true, force: true }));
  const binary = path.join(helperDir, 'slow-worker'); await writeFile(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n'); await chmod(binary, 0o755);
  const { search, request } = await start(t, { binary });
  const a = await search('first', 'a'), aText = a.text();
  const [b, c] = await Promise.all([search('second', 'b'), search('third', 'c')]);
  const bText = b.text(), cText = c.text(); await delay(30);
  await request('/api/cancel', { clientId: 'test-client', requestId: 'c' });
  for (const text of await Promise.all([aText, bText, cText])) {
    const stream = events(text); assert.equal(stream.at(-1).type, 'done'); assert.equal(stream.at(-1).cancelled, true); assert(!stream.some((e) => e.type === 'file'));
  }
  for (const id of ['a', 'b', 'c']) {
    const trace = await (await request('/api/trace?requestId=' + id)).json();
    for (const spawn of trace.events.filter((e) => e.type === 'process.spawn')) {
      assert(trace.events.some((e) => e.type === 'process.close' && e.pid === spawn.pid)); assert.throws(() => process.kill(spawn.pid, 0), { code: 'ESRCH' });
    }
  }
});

test('bundled font, icon and renderer resources are served with exact MIME types without exposing project files', async () => {
  const app = await createApp(); await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  try {
    for(const [url,type] of [['/assets/open-sans-v17-latin-ext_latin-regular.woff2','font/woff2'],['/assets/search-case.svg','image/svg+xml'],['/assets/markdown-it.min.js','text/javascript'],['/markdown.js','text/javascript']]) {
      const response=await fetch(base+url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type').split(';')[0],type);assert.ok((await response.arrayBuffer()).byteLength>100);
    }
    for(const url of ['/assets/..%2f..%2fdesktop/Main.swift','/assets/%00bad.css','/desktop/Main.swift','/package.json']){const response=await fetch(base+url);assert.notEqual(response.status,200);}
  } finally {await app.close();}
});

test('single external Markdown opens atomically, changes search scope and rejects stale requests', async t => {
  const {request}=await start(t);
  const folder=await mkdtemp(path.join(tmpdir(),'paper-single-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=path.join(folder,'中文 空格🙂.MD');await writeFile(file,'\uFEFF# 单文件\r\n\r\nSINGLE_FILE_CHAIN 中文🙂\r\n');
  const result=await request('/api/open-file',{path:file});assert.equal(result.status,200);
  const opened=await result.json();assert.equal(opened.workspace.root,await (await import('node:fs/promises')).realpath(folder));assert.equal(opened.workspace.revision,1);
  assert.equal(opened.document.path,'中文 空格🙂.MD');assert(opened.document.text.startsWith('# 单文件'));assert.equal(opened.document.revision,1);
  const read=await (await request('/api/document?'+new URLSearchParams({path:opened.document.path}))).json();assert.equal(read.text,opened.document.text);
  assert.equal((await request('/api/search',{clientId:'single',requestId:'old',query:'SINGLE_FILE_CHAIN',revision:0})).status,400);
  const stream=events(await(await request('/api/search',{clientId:'single',requestId:'single',query:'SINGLE_FILE_CHAIN',revision:1})).text());
  assert.equal(stream.find(e=>e.type==='file').matches[0].line,3);assert.equal(stream.at(-1).failed,false);
  await writeFile(path.join(folder,'second.markdown'),'# Second');
  const next=await(await request('/api/open-file',{path:path.join(folder,'second.markdown')})).json();assert.equal(next.workspace.revision,2);assert.equal(next.document.path,'second.markdown');
});
test('failed single-file opens preserve workspace and revision', async t => {
  const {root,request}=await start(t);const before=await(await request('/api/state')).json();
  for(const [name,content] of [['unsupported.js','hello'],['binary.md',Buffer.from([65,0,66])],['invalid.md',Buffer.from([255])],['huge.md','x'.repeat(2*1024*1024+1)]])await writeFile(path.join(root,name),content);
  for(const file of ['relative.md',path.join(root,'missing.md'),root,...['unsupported.js','binary.md','invalid.md','huge.md'].map(name=>path.join(root,name))]) {
    assert.equal((await request('/api/open-file',{path:file})).status,400,file);
    assert.deepEqual(await(await request('/api/state')).json(),before);
  }
});
