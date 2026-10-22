import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';

export const EXTENSIONS = ['md', 'markdown', 'mdx', 'mdown', 'mkd', 'txt', 'text', 'rmd', 'qmd'];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const supported = (name) => EXTENSIONS.includes(path.extname(name).slice(1).toLowerCase());
export const comparePaths = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Use slash-separated relative paths in the UI and HTTP API on every platform.
export const normalizeRelative = (name, platform = process.platform) => (platform === 'win32' ? name.replaceAll('\\', '/') : name).replace(/^\.\//, '');
export const within = (root, file) => file === root || (!path.relative(root, file).startsWith('..' + path.sep) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
export const utf16Offset = (text, bytes) => Buffer.from(text).subarray(0, bytes).toString('utf8').length;

export class LineDecoder {
  constructor(onLine, maxBytes = 16 * 1024 * 1024, separator = '\n') {
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.onLine = onLine; this.maxBytes = maxBytes; this.separator = separator;
  }
  write(chunk) { this.buffer += this.decoder.write(chunk); this.flush(false); }
  end() { this.buffer += this.decoder.end(); this.flush(true); }
  flush(final) {
    let i;
    while ((i = this.buffer.indexOf(this.separator)) >= 0) {
      const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + this.separator.length);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('搜索输出单条记录过大');
      this.onLine(this.separator === '\n' ? line.replace(/\r$/, '') : line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('搜索输出单条记录过大');
    if (final && this.buffer) { this.onLine(this.buffer); this.buffer = ''; }
  }
}

const textValue = (v) => v?.text ?? (v?.bytes ? Buffer.from(v.bytes, 'base64').toString('utf8') : '');
const stripEnding = (s) => s.replace(/\r?\n$/, '');
const flags = (options) => [
  '--no-require-git',
  ...(options.hidden ? ['--hidden'] : ['-g', '!.*']),
  ...(options.ignore ? ['--no-ignore'] : []),
  '-g', '!.git/**', ...EXTENSIONS.flatMap((e) => ['--type-add', 'paper:*.' + [...e].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')]), '-t', 'paper',
];

export class SearchJob extends EventEmitter {
  constructor({ root, query, options = {}, requestId, trace = () => {}, binary = rgPath, maxFiles = 200, maxLines = 1000 }) {
    super(); Object.assign(this, { root, query, options, requestId, trace, binary, maxFiles, maxLines });
    this.files = new Map(); this.children = new Set(); this.cancelled = false; this.truncated = false; this.finished = false; this.lines = 0;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  log(type, data = {}) { this.trace(type, { requestId: this.requestId, ...data }); }
  send(type, data) { if (!this.finished) { this.log('stream.' + type, { ...(type === 'file' ? { path: data.path, matches: data.matches.length } : data) }); this.emit('event', { type, requestId: this.requestId, ...data }); } }
  cancel(reason = 'cancelled') { if (this.finished || this.cancelled) return; this.cancelled = true; this.reason = reason; this.log('search.cancel', { reason }); this.stopChildren(); }
  stopChildren() {
    for (const child of this.children) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (this.children.has(child)) child.kill('SIGKILL'); }, 250);
      timer.unref(); child.once('close', () => clearTimeout(timer));
    }
  }
  cap() { if (!this.truncated) { this.truncated = true; this.log('search.limit'); this.stopChildren(); } }
  file(name) {
    name = normalizeRelative(name);
    if (!name || !supported(name) || !within(this.root, path.resolve(this.root, name))) return null;
    if (!this.files.has(name)) {
      if (this.files.size >= this.maxFiles) { this.cap(); return null; }
      this.files.set(name, { path: name, kind: 'name', matches: [], limited: false });
    }
    return this.files.get(name);
  }
  runProcess(role, args, onLine, separator = '\n') {
    return new Promise((resolve, reject) => {
      if (this.cancelled || this.truncated) return resolve();
      const child = spawn(this.binary, args, { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.children.add(child); let stderr = '', failure = null;
      child.on('spawn', () => this.log('process.spawn', { role, pid: child.pid, parentPid: process.pid, executable: this.binary, args }));
      const parser = new LineDecoder((line) => { if (!this.cancelled && !this.truncated && line) onLine(line); }, 16 * 1024 * 1024, separator);
      child.stdout.on('data', (chunk) => {
        this.log('process.stdout', { role, pid: child.pid, bytes: chunk.length });
        try { parser.write(chunk); } catch (e) { failure = e; this.stopChildren(); }
      });
      child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk.toString('utf8'); });
      child.on('error', (error) => { failure = new Error(error.code === 'ENOENT' ? '找不到搜索程序，请运行 npm install' : error.message); });
      child.on('close', (code, signal) => {
        this.children.delete(child);
        try { parser.end(); } catch (e) { failure = e; }
        this.log('process.close', { role, pid: child.pid, code, signal });
        if (!this.cancelled && !this.truncated && (failure || code > 1 || signal)) {
          const message = /regex parse error/i.test(stderr) ? '正则表达式无效或不受支持。\n' + stderr.trim().replace(/^rg: /, '') : stderr.trim() || '搜索程序异常退出';
          reject(failure || new Error(message));
        }
        else resolve();
      });
    });
  }
  async start() {
    this.send('start', { query: this.query });
    const tasks = [];
    if (this.query.trim()) {
      const args = ['--json', '--line-number', '--no-multiline', '--max-count', '21', '--max-filesize', String(MAX_FILE_BYTES),
        ...flags(this.options), ...(!this.options.caseSensitive ? ['-i'] : []), ...(this.options.wholeWord ? ['-w'] : []),
        ...(!this.options.regexp ? ['-F'] : []), '--', this.query, '.'];
      tasks.push(this.runProcess('content', args, (line) => {
        const record = JSON.parse(line); this.log('rg.record', { recordType: record.type, path: textValue(record.data?.path) });
        if (record.type !== 'match') return;
        if (this.lines >= this.maxLines) return this.cap();
        const file = this.file(textValue(record.data.path)); if (!file) return;
        const raw = textValue(record.data.lines), text = stripEnding(raw);
        file.kind = 'content';
        const ranges = record.data.submatches.map((m) => ({ start: utf16Offset(raw, m.start), end: utf16Offset(raw, m.end) }));
        file.matches.push({ line: record.data.line_number, text, ranges }); this.lines++;
        file.limited = file.matches.length >= 21;
        this.send('file', { ...file, matches: [...file.matches] });
      }));
      if (!this.options.regexp) {
        const needle = this.options.caseSensitive ? this.query.normalize('NFC') : this.query.normalize('NFC').toLowerCase();
        tasks.push(this.runFileNames(needle));
      }
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !this.cancelled && !this.truncated) this.send('error', { message: failed.reason.message });
    this.send('done', { cancelled: this.cancelled, truncated: this.truncated, failed: !!failed && !this.cancelled && !this.truncated, files: this.files.size, lines: this.lines });
    this.finished = true; this.resolveDone(); return this;
  }
  runFileNames(needle) {
    return this.runProcess('filenames', ['--files', '-0', ...flags(this.options), '.'], (line) => {
      const name = normalizeRelative(line);
      const hay = this.query.includes('/') ? name : path.basename(name);
      const normalized = this.options.caseSensitive ? hay.normalize('NFC') : hay.normalize('NFC').toLowerCase();
      if (!normalized.includes(needle)) return;
      const file = this.file(name); if (file && !file.matches.length) this.send('file', { ...file });
    }, '\0');
  }
}

export async function listFiles(root, options = {}) {
  const args = ['--files', '-0', ...flags(options), '.'];
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary || rgPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const paths = [], decoder = new StringDecoder('utf8'); let buffer = '', stderr = '', failure, killTimer, settled = false;
    const stop = (message) => {
      if (failure || settled) return;
      failure = new Error(message); child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 250); killTimer.unref();
    };
    const timer = setTimeout(() => stop('读取文件夹超时，请重新选择文件夹。'), options.timeoutMs ?? 15000); timer.unref();
    const abort = () => stop('已取消读取文件夹。');
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', abort); err ? reject(err) : resolve(value); };
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk); const parts = buffer.split('\0'); buffer = parts.pop();
      for (const name of parts) { const relative = normalizeRelative(name); if (supported(relative) && paths.length < 10000) paths.push(relative); }
    });
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-4000); }); child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => finish(failure || (signal || code > 1 ? new Error(stderr || '读取文件夹失败') : null), paths.sort(comparePaths)));
  });
}
