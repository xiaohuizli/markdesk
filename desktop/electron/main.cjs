const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
app.setName('MarkDesk');
const root = path.resolve(__dirname, '../..');
const extensions = ['md', 'markdown', 'mdx', 'mdown', 'mkd', 'txt', 'text', 'rmd', 'qmd'];
const filters = [{ name: 'Markdown / 文本', extensions }];
const smoke = process.argv.includes('--smoke-test');
let window, backend, origin, rendererReady = false, stopping = false;
let pendingFile = process.argv.slice(app.isPackaged ? 1 : 2).find(supportedFile);
let workspaceFile;
function supportedFile(value) { return path.isAbsolute(value) && extensions.includes(path.extname(value).slice(1).toLowerCase()); }
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== origin + '/') throw new Error('会话无效');
}
function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function openFile(value) {
  if (!supportedFile(value)) return;
  if (rendererReady) send('paper-open-file', value); else pendingFile = value;
  window?.show(); window?.focus();
}
async function chooseFile() {
  const result = await dialog.showOpenDialog(window, { title: '打开 Markdown 或文本文件', properties: ['openFile'], filters });
  return result.canceled ? null : result.filePaths[0];
}
async function chooseFolder(currentPath) {
  const result = await dialog.showOpenDialog(window, { title: '打开文档文件夹', defaultPath: currentPath, properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}
function command(name) { send('paper-command', name); }
function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: async () => { const value = await chooseFile(); if (value) openFile(value); } },
      { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Alt+O', click: async () => { const value = await chooseFolder(); if (value) send('paper-open-workspace', value); } },
      { label: '快速打开…', accelerator: 'CmdOrCtrl+Shift+O', click: () => command('quick') },
      { label: '导出搜索记录…', accelerator: 'CmdOrCtrl+Shift+E', click: () => window.webContents.executeJavaScript("document.querySelector('#export-trace').click()") },
      { type: 'separator' }, { role: 'quit', label: '退出 MarkDesk' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [
      { label: '文件', click: () => command('files') }, { label: '大纲', click: () => command('outline') },
      { label: '显示/隐藏侧边栏', accelerator: 'CmdOrCtrl+Shift+L', click: () => command('sidebar') },
      { label: '源代码模式', accelerator: 'CmdOrCtrl+/', click: () => command('source') },
    ] },
    { label: '搜索', submenu: [
      { label: '文件夹搜索', accelerator: 'CmdOrCtrl+Shift+F', click: () => command('search') },
      { label: '文内查找', accelerator: 'CmdOrCtrl+F', click: () => command('find') },
    ] },
  ]));
}
ipcMain.handle('paper-native', async (event, method, data = {}) => {
  trusted(event);
  switch (method) {
    case 'chooseFile': return { path: await chooseFile() };
    case 'chooseFolder': return { path: await chooseFolder(typeof data.currentPath === 'string' ? data.currentPath : undefined) };
    case 'rendererReady': {
      rendererReady = true; const value = pendingFile; pendingFile = null;
      if (smoke) setImmediate(() => verifySmoke().catch(fail));
      return { path: value || null };
    }
    case 'workspaceDidChange':
      if (typeof data.path !== 'string' || !path.isAbsolute(data.path)) throw new Error('文件夹路径无效');
      if (!smoke) await fs.writeFile(workspaceFile, JSON.stringify({ workspace: data.path }));
      return { ok: true };
    case 'documentDidChange':
      if (typeof data.name !== 'string') throw new Error('文档名称无效');
      window.setTitle(data.name + ' — MarkDesk'); return { ok: true };
    case 'saveTrace': {
      const result = await dialog.showSaveDialog(window, { title: '导出搜索记录', defaultPath: 'MarkDesk 记录.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePath) return { saved: false };
      await fs.writeFile(result.filePath, JSON.stringify(data.data, null, 2)); return { saved: true };
    }
    default: throw new Error('不支持的操作');
  }
});
ipcMain.handle('paper-open-dropped-file', (event, value) => { trusted(event); if (typeof value === 'string') openFile(value); });
function fail(error) {
  console.error(error);
  if (smoke) app.exit(1);
  else { dialog.showErrorBox('MarkDesk 无法启动', error.message); app.quit(); }
}
async function verifySmoke() {
  let ui;
  for (let attempt = 0; attempt < 200; attempt++) {
    ui = await window.webContents.executeJavaScript("({bridge:typeof window.paperDesktop?.request, files:document.querySelectorAll('.file-link').length, error:document.querySelector('#search-error').textContent})");
    if (ui.files || ui.error) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (ui.bridge !== 'function' || !ui.files || ui.error) throw new Error('桌面界面未就绪: ' + JSON.stringify(ui));
  const response = await fetch(origin + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-token': backend.token }, body: JSON.stringify({ query: '搜索', clientId: 'desktop-smoke', requestId: 'smoke-1', revision: 0, options: {} }), signal: AbortSignal.timeout(10000) });
  const stream = await response.text();
  if (!response.ok || !stream.includes('"type":"file"') || !stream.includes('"type":"done"') || stream.includes('"type":"error"')) throw new Error('真实搜索验证失败: ' + stream.slice(-1000));
  const result = { event: 'smoke.passed', product: app.getName(), platform: process.platform, arch: process.arch, ui, packaged: app.isPackaged };
  if (process.env.PAPER_SMOKE_RESULT) await fs.writeFile(process.env.PAPER_SMOKE_RESULT, JSON.stringify(result));
  console.log(JSON.stringify(result));
  app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { const value = argv.find(supportedFile); if (value) openFile(value); else { window?.show(); window?.focus(); } });
  app.on('open-file', (event, value) => { event.preventDefault(); openFile(value); });
  app.whenReady().then(async () => {
    workspaceFile = path.join(app.getPath('userData'), 'workspace.json');
    let workspace = path.join(root, 'demo');
    if (!smoke) {
      // Import the previous product's workspace without changing or deleting its settings.
      const settings = [workspaceFile, ...['paper-search', 'Paper Search'].map(name => path.join(app.getPath('appData'), name, 'workspace.json'))];
      for (const file of settings) try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8')).workspace;
        if (typeof saved === 'string' && path.isAbsolute(saved) && (await fs.stat(saved)).isDirectory()) { workspace = saved; break; }
      } catch {}
    }
    const { createApp } = await import(pathToFileURL(path.join(root, 'src/server.js')).href);
    backend = await createApp({ workspace });
    await new Promise((resolve, reject) => { backend.server.once('error', reject); backend.server.listen(0, '127.0.0.1', resolve); });
    origin = 'http://127.0.0.1:' + backend.server.address().port;
    window = new BrowserWindow({ width: 1280, height: 840, minWidth: 700, minHeight: 450, title: 'MarkDesk', icon: path.join(root, 'desktop/assets/icon.png'), backgroundColor: '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== origin + '/') event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
    menus();
    if (smoke) setTimeout(() => fail(new Error('桌面验证超时')), 30000).unref();
    await window.loadURL(origin + '/');
  }).catch(fail);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!backend || stopping) return;
    event.preventDefault(); stopping = true;
    backend.close().then(() => app.quit()).catch(() => app.exit(1));
  });
}
