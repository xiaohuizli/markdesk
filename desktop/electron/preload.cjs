const { contextBridge, ipcRenderer, webUtils } = require('electron');
const allowed = new Set(['chooseFile', 'chooseFolder', 'rendererReady', 'workspaceDidChange', 'documentDidChange', 'saveTrace']);
contextBridge.exposeInMainWorld('paperDesktop', Object.freeze({
  request(method, data = {}) {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作'));
    return ipcRenderer.invoke('paper-native', method, data);
  },
}));
ipcRenderer.on('paper-command', (_event, detail) => window.dispatchEvent(new CustomEvent('paper-command', { detail })));
ipcRenderer.on('paper-open-file', (_event, path) => window.dispatchEvent(new CustomEvent('paper-open-file', { detail: { path } })));
ipcRenderer.on('paper-open-workspace', (_event, path) => window.dispatchEvent(new CustomEvent('paper-open-workspace', { detail: { path } })));
window.addEventListener('dragover', (event) => { event.preventDefault(); });
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) ipcRenderer.invoke('paper-open-dropped-file', webUtils.getPathForFile(file)).catch(() => {});
});
