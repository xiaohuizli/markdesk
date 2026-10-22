import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SearchJob, LineDecoder, listFiles, MAX_FILE_BYTES } from '../src/search.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'paper-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await Promise.all(Object.entries({
    'note.md': '# Note\r\n中文🙂 needle and needle\r\nCoffee coffee coffees\r\na.b axb\r\n-n safe\r\n',
    'needle.md': 'needle\n', 'needle-empty.md': '', 'nested/other.MD': 'needle\n',
    'unrelated.md': 'nothing relevant\n', 'needle\nnewline.md': '',
    '.hidden.md': 'needle hidden\n', 'ignored.md': 'needle ignored\n', '.gitignore': 'ignored.md\n',
    'unsupported.js': 'needle\n',
  }).map(([file, content]) => writeFile(path.join(root, file), content)));
  return root;
}
async function search(root, query, options, extra = {}) {
  const events = [], trace = []; const job = new SearchJob({ root, query, options, requestId: 'test-query', trace: (type, data) => trace.push({ type, ...data }), ...extra });
  job.on('event', (e) => events.push(e)); await job.start(); return { events, trace, job, done: events.at(-1) };
}
test('incremental UTF-8 decoder handles every byte boundary, CRLF and EOF without newline', () => {
  const rows = [], decoder = new LineDecoder((line) => rows.push(JSON.parse(line)));
  const expected = [{ text: '中文🙂' }, { text: 'tail' }];
  for (const byte of Buffer.from(expected.map(JSON.stringify).join('\r\n'))) decoder.write(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(rows, expected);
  assert.throws(() => new LineDecoder(() => {}, 2).write(Buffer.from('123')), /过大/);
});
test('real rg searches content and filenames, merges duplicate paths and includes empty/newline names', async (t) => {
  const root = await fixture(t), result = await search(root, 'needle');
  assert.equal(result.done.failed, false); assert.equal(result.done.files, 5);
  const paths = [...result.job.files.keys()]; assert.equal(new Set(paths).size, paths.length);
  assert(paths.includes('needle-empty.md')); assert(paths.includes('needle\nnewline.md')); assert(paths.includes('nested/other.MD'));
  assert.equal(result.job.files.get('needle.md').kind, 'content');
  const hit = result.job.files.get('note.md').matches[0];
  assert.equal(hit.line, 2); assert.equal(hit.text, '中文🙂 needle and needle');
  assert.equal(hit.text.slice(hit.ranges[0].start, hit.ranges[0].end), 'needle');
  assert.equal(hit.ranges[0].start, '中文🙂 '.length); assert.equal(hit.ranges.length, 2);
  assert.equal(result.trace.find((e) => e.type === 'process.spawn' && e.role === 'content').args.at(-3), '--');
  assert.equal(result.job.children.size, 0);
});
test('case, whole-word, literal metacharacters and dash-prefixed patterns use real rg semantics', async (t) => {
  const root = await fixture(t);
  const a = await search(root, 'Coffee', { caseSensitive: true, wholeWord: true });
  assert.equal(a.job.files.get('note.md').matches[0].ranges.length, 1);
  const b = await search(root, 'coffee', { wholeWord: true }); assert.equal(b.job.files.get('note.md').matches[0].ranges.length, 2);
  const c = await search(root, 'a.b'); assert.equal(c.job.files.get('note.md').matches[0].ranges.length, 1);
  const d = await search(root, '-n'); assert.equal(d.job.files.get('note.md').matches[0].text, '-n safe');
  const e = await search(root, 'a.b', { regexp: true }); assert.equal(e.job.files.get('note.md').matches[0].ranges.length, 2);
  const f = await search(root, '中文🙂'); assert.equal(f.job.files.get('note.md').matches[0].ranges[0].end, '中文🙂'.length);
});
test('hidden, ignore, maximum file size, file types and symlink policy are enforced', async (t) => {
  const root = await fixture(t), outside = await mkdtemp(path.join(tmpdir(), 'paper-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret.md'), 'needle'); await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  await writeFile(path.join(root, 'large.md'), 'needle\n' + 'x'.repeat(MAX_FILE_BYTES));
  const normal = await search(root, 'needle');
  for (const file of ['.hidden.md', 'ignored.md', 'unsupported.js', 'link.md', 'large.md']) assert(!normal.job.files.has(file), file);
  const expanded = await search(root, 'needle', { hidden: true, ignore: true });
  assert(expanded.job.files.has('.hidden.md')); assert(expanded.job.files.has('ignored.md')); assert(!expanded.job.files.has('link.md'));
  const files = await listFiles(root); assert(files.includes('needle\nnewline.md')); assert(!files.includes('ignored.md'));
});
test('empty queries, no matches, invalid regex and zero-width regex finish distinctly', async (t) => {
  const root = await fixture(t);
  const empty = await search(root, '   '); assert.equal(empty.done.files, 0); assert.equal(empty.trace.filter((r) => r.type === 'process.spawn').length, 0);
  const none = await search(root, 'absolutely-not-present'); assert.equal(none.done.failed, false); assert.equal(none.done.files, 0);
  const invalid = await search(root, '[', { regexp: true }); assert.equal(invalid.done.failed, true); assert(invalid.events.some((e) => e.type === 'error')); assert.equal(invalid.job.children.size, 0);
  const zero = await search(root, '^', { regexp: true }); assert.equal(zero.done.failed, false); assert(zero.done.lines > 0);
  assert.equal(zero.job.files.get('note.md').matches[0].ranges[0].start, zero.job.files.get('note.md').matches[0].ranges[0].end);
});
test('global result limit reports truncation and shuts down every owned process', async (t) => {
  const root = await fixture(t), result = await search(root, 'needle', {}, { maxFiles: 1 });
  assert.equal(result.done.truncated, true); assert.equal(result.done.failed, false); assert.equal(result.done.files, 1); assert.equal(result.job.children.size, 0);
});
test('global line cap does not count a file that was never emitted', async (t) => {
  const root = await fixture(t), result = await search(root, 'needle', { regexp: true }, { maxLines: 1 });
  const emittedFiles = new Set(result.events.filter((e) => e.type === 'file').map((e) => e.path));
  assert.equal(result.done.truncated, true); assert.equal(result.done.lines, 1); assert.equal(result.done.files, emittedFiles.size);
});
test('cancellation terminates actual child processes and emits exactly one terminal event', async (t) => {
  const root = await fixture(t), binary = path.join(root, 'slow-worker');
  await writeFile(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n'); await chmod(binary, 0o755);
  const events = [], pids = [], job = new SearchJob({ root, query: 'needle', binary, requestId: 'cancel', trace: (type, data) => { if (type === 'process.spawn') { pids.push(data.pid); job.cancel('test'); } } });
  job.on('event', (e) => events.push(e)); await job.start();
  assert.equal(events.at(-1).cancelled, true); assert.equal(events.filter((e) => e.type === 'done').length, 1); assert.equal(job.children.size, 0);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('spawn failure becomes a recoverable search error', async (t) => {
  const root = await fixture(t), result = await search(root, 'needle', {}, { binary: path.join(root, 'missing-program') });
  assert.equal(result.done.failed, true); assert(result.events.some((e) => e.type === 'error' && /npm install/.test(e.message))); assert.equal(result.job.children.size, 0);
});
test('per-file line limits and Unicode word boundaries are verified against real rg', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'many.md'), 'bounded-hit\n'.repeat(25));
  const capped = await search(root, 'bounded-hit', { regexp: true });
  assert.equal(capped.job.files.get('many.md').matches.length, 21); assert.equal(capped.job.files.get('many.md').limited, true);
  await writeFile(path.join(root, 'unicode.md'), '中文词 中文 中文🙂\n');
  const words = await search(root, '中文', { wholeWord: true }); assert.equal(words.job.files.get('unicode.md').matches[0].ranges.length, 2);
  const lookaround = await search(root, '(?<=中文)词', { regexp: true }); assert.equal(lookaround.done.failed, true);
  assert(lookaround.events.some((e) => e.type === 'error' && /正则表达式/.test(e.message)));
});
test('malformed JSON aborts the producer and does not leave a live process', async (t) => {
  const root = await fixture(t), binary = path.join(root, 'bad-worker');
  await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write("not-json\\n");setInterval(()=>{},1000);\n'); await chmod(binary, 0o755);
  const result = await search(root, 'needle', { regexp: true }, { binary });
  assert.equal(result.done.failed, true); assert.equal(result.job.children.size, 0);
  const pid = result.trace.find((e) => e.type === 'process.spawn').pid; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('a child ignoring SIGTERM is force-terminated after the grace period', { timeout: 5000 }, async (t) => {
  const root = await fixture(t), binary = path.join(root, 'stubborn-worker');
  await writeFile(binary, '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>{});process.stdout.write(\'{"type":"ready"}\\n\');setInterval(()=>{},1000);\n'); await chmod(binary, 0o755);
  const trace = [], job = new SearchJob({ root, query: 'needle', options: { regexp: true }, binary, requestId: 'stubborn', trace: (type, data) => { trace.push({ type, ...data }); if (type === 'rg.record' && data.recordType === 'ready') job.cancel('test'); } });
  await job.start(); const close = trace.find((e) => e.type === 'process.close');
  assert.equal(close.signal, 'SIGKILL'); assert.equal(job.children.size, 0); assert.throws(() => process.kill(close.pid, 0), { code: 'ESRCH' });
});

test('file enumeration times out and force-terminates a producer that ignores SIGTERM', {timeout:5000}, async t=>{
  const root=await fixture(t), script=path.join(root,'blocked-rg'), pidFile=path.join(root,'blocked.pid');
  await writeFile(script, '#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);\n');
  await chmod(script,0o755);
  await assert.rejects(listFiles(root,{binary:script,timeoutMs:1000}),/超时/);
  const {readFile}=await import('node:fs/promises');const pid=Number(await readFile(pidFile,'utf8'));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
