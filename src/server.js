import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SearchJob, listFiles, supported, within, MAX_FILE_BYTES } from './search.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const body = async (req) => {
  let content = ''; for await (const chunk of req) { content += chunk; if (content.length > 32768) throw new Error('请求过大'); }
  try { return JSON.parse(content || '{}'); } catch { throw new Error('请求格式无效'); }
};

export async function createApp({ workspace = path.join(project, 'demo'), maxFiles = 200, maxLines = 1000, binary } = {}) {
  let root = await realpath(workspace), revision = 0;
  if (!(await stat(root)).isDirectory()) throw new Error('工作区必须是文件夹');
  const token = randomUUID(), sessions = new Map(), traces = new Map(), shutdown = new AbortController();
  const trace = (type, data) => {
    const id = data.requestId; if (!id) return;
    if (!traces.has(id)) { if (traces.size >= 30) traces.delete(traces.keys().next().value); traces.set(id, { events: [], dropped: 0 }); }
    const record = traces.get(id);
    if (record.events.length < 4000) record.events.push({ seq: record.events.length + 1, at: new Date().toISOString(), monotonicMs: performance.now(), type, ...data }); else record.dropped++;
  };
  const workspaceInfo = () => ({ root, name: path.basename(root), revision });
  async function readDocument(resolved, relative) {
    if (!supported(resolved)) throw new Error('文件类型不受支持');
    const info = await stat(resolved); if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('仅支持读取 2 MiB 以内的文本文件');
    const raw = await readFile(resolved);
    if (raw.length > MAX_FILE_BYTES) throw new Error('仅支持读取 2 MiB 以内的文本文件');
    if (raw.includes(0)) throw new Error('无法读取二进制文件');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return { path: relative, text, size: raw.length, modified: info.mtimeMs };
  }
  async function safeFile(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('文件路径无效');
    const candidate = path.resolve(root, relative); if (!within(root, candidate)) throw new Error('文件超出当前工作区');
    const resolved = await realpath(candidate); if (!within(root, resolved) || !supported(resolved)) throw new Error('文件不在工作区内，或类型不受支持');
    return readDocument(resolved, relative);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const authority = req.headers.host;
    if (!/^127\.0\.0\.1:\d+$/.test(authority || '')) return json(res, 403, { error: '仅接受本地连接' });
    const url = new URL(req.url, 'http://' + authority);
    if (req.headers.origin && req.headers.origin !== url.origin) return json(res, 403, { error: '来源不匹配' });
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-paper-token'] !== token) return json(res, 403, { error: '会话无效，请刷新页面' });
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, workspaceInfo());
        if (req.method === 'POST' && url.pathname === '/api/workspace') {
          const input = await body(req); if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new Error('请输入文件夹的绝对路径');
          const next = await realpath(input.path); if (!(await stat(next)).isDirectory()) throw new Error('请选择文件夹');
          for (const job of sessions.values()) job.cancel('workspace-change');
          root = next; revision++; return json(res, 200, workspaceInfo());
        }
        if (req.method === 'POST' && url.pathname === '/api/open-file') {
          const input = await body(req);
          if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0')) throw new Error('请选择文件的绝对路径');
          const resolved = await realpath(input.path);
          // Validate before changing workspace: failed opens preserve the current document.
          const document = await readDocument(resolved, path.basename(resolved));
          for (const job of sessions.values()) job.cancel('file-open');
          root = path.dirname(resolved); revision++;
          return json(res, 200, { workspace: workspaceInfo(), document: { ...document, revision } });
        }
        if (req.method === 'GET' && url.pathname === '/api/files') {
          const version = revision, workspaceRoot = root;
          const files = await listFiles(workspaceRoot, { hidden: url.searchParams.get('hidden') === 'true', ignore: url.searchParams.get('ignore') === 'true', signal: shutdown.signal });
          return json(res, 200, { revision: version, files, capped: files.length >= 10000 });
        }
        if (req.method === 'GET' && url.pathname === '/api/document') {
          const relative = url.searchParams.get('path'), requestId = url.searchParams.get('requestId');
          const version = revision, document = await safeFile(relative);
          if (version !== revision) throw new Error('工作区已切换，请重试');
          trace('navigation.read', { requestId, path: relative, line: Number(url.searchParams.get('line') || 1) });
          return json(res, 200, { ...document, revision: version });
        }
        if (req.method === 'GET' && url.pathname === '/api/trace') {
          const requestId = url.searchParams.get('requestId'); return json(res, 200, { requestId, ...(traces.get(requestId) || { events: [], dropped: 0 }) });
        }
        if (req.method === 'POST' && url.pathname === '/api/interaction') {
          const data = await body(req);
          if (data.type === 'navigation.ready') trace(data.type, { requestId: data.requestId, path: data.path, line: data.line, selectedText: String(data.selectedText || '').slice(0, 300) });
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/cancel') {
          const data = await body(req), job = sessions.get(data.clientId);
          if (job?.requestId === data.requestId) { job.cancel('user'); await job.done; }
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/search') {
          const input = await body(req);
          if (typeof input.query !== 'string' || input.query.length > 2000 || !/^[\w-]{1,80}$/.test(input.requestId || '') || !/^[\w-]{1,80}$/.test(input.clientId || '')) throw new Error('搜索请求无效');
          if (input.revision !== revision) throw new Error('工作区已改变，请重新搜索');
          if (sessions.size >= 12 && !sessions.has(input.clientId)) throw new Error('搜索会话过多，请关闭多余页面');
          const options = Object.fromEntries(['caseSensitive', 'wholeWord', 'regexp', 'hidden', 'ignore'].map((k) => [k, input.options?.[k] === true]));
          const old = sessions.get(input.clientId);
          const job = new SearchJob({ root, query: input.query, options, requestId: input.requestId, trace, maxFiles, maxLines, ...(binary ? { binary } : {}) });
          sessions.set(input.clientId, job);
          if (old) { old.cancel('superseded'); await old.done; }
          if (input.revision !== revision) job.cancel('workspace-change');
          if (res.destroyed) job.cancel('disconnect');
          trace('input.submit', { requestId: input.requestId, query: input.query, options });
          trace('transport.request', { requestId: input.requestId, method: 'POST', endpoint: '/api/search', root, revision });
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
          res.flushHeaders(); let pendingBytes = 0;
          const send = (event) => {
            if (res.destroyed) return job.cancel('disconnect');
            pendingBytes = res.writableLength;
            if (pendingBytes > 4 * 1024 * 1024) return job.cancel('slow-client');
            res.write('data: ' + JSON.stringify(event) + '\n\n');
          };
          job.on('event', send); res.on('close', () => { if (!res.writableEnded) job.cancel('disconnect'); });
          await job.start(); res.end();
          if (sessions.get(input.clientId) === job) sessions.delete(input.clientId);
          return;
        }
        return json(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '方法不支持' });
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/markdown.js': ['markdown.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (url.pathname.startsWith('/assets/')) {
        const assetRoot = path.join(project, 'public/assets'), asset = path.resolve(project, 'public', '.' + decodeURIComponent(url.pathname));
        if (!asset.startsWith(assetRoot + path.sep)) return json(res, 404, { error: '资源不存在' });
        const types = { '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.eot':'application/vnd.ms-fontobject' };
        const type = types[path.extname(asset)]; if (!type) return json(res, 404, { error: '资源不存在' });
        const content = await readFile(asset);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'no-store' }); return res.end(content);
      }
      const file = files[url.pathname]; if (!file) return json(res, 404, { error: '页面不存在' });
      let content = await readFile(path.join(project, 'public', file[0]), 'utf8');
      if (file[0] === 'index.html') content = content.replace('__PAPER_TOKEN__', token);
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(content);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.code === 'ENOENT' ? '找不到这个文件或文件夹' : error.message });
      else res.end();
    }
  });
  return { server, token, trace, async close() { shutdown.abort(); for (const job of sessions.values()) job.cancel('shutdown'); await Promise.all([...sessions.values()].map((j) => j.done)); await new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp({ workspace: process.env.PAPER_WORKSPACE || path.join(project, 'demo') });
  app.server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + app.server.address().port;
    console.log(process.env.PAPER_DESKTOP === '1' ? JSON.stringify({ event: 'ready', url }) : 'Paper Search ' + url);
  });
  const parent = Number(process.env.PAPER_PARENT_PID);
  if (Number.isInteger(parent) && parent > 1) {
    const watch = setInterval(() => { try { process.kill(parent, 0); } catch { app.close().then(() => process.exit()); } }, 1000); watch.unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close().then(() => process.exit()); });
}
