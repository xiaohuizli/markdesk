import { renderMarkdown } from '/markdown.js';
const $ = (selector) => document.querySelector(selector);
const token = $('meta[name="paper-token"]').content;
const clientId = crypto.randomUUID();
const state = { sidebar: 'files', tree: true, collapsed: new Set(), resultCollapsed: new Set(), source: false, findOptions: {caseSensitive:false, wholeWord:false, regexp:false}, workspace: null, files: [], results: new Map(), requestId: null, busy: false, document: null, nav: 0, findHits: [], findIndex: -1, quickIndex: 0, recent: [] };
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function api(url, data, signal) {
  const res = await fetch(url, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-paper-token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal });
  if (!res.ok) throw new Error((await res.json()).error || '请求失败'); return res;
}
async function get(url) { return (await api(url)).json(); }
function options() { return Object.fromEntries(['caseSensitive', 'wholeWord', 'regexp', 'hidden', 'ignore'].map((key) => [key, $('#' + key).checked])); }
function error(id, message) { const el = $(id); el.hidden = !message; el.textContent = message || ''; }
function setBusy(value) { state.busy = value; $('#cancel').hidden = !value; $('#search-button').textContent = value ? '开始新搜索' : '搜索文件夹'; }
function status(text) { $('#search-status').textContent = text; }
function appendMarked(parent, text, ranges = []) {
  let offset = 0;
  for (const range of ranges) {
    const start = Math.max(offset, Math.min(text.length, range.start)), end = Math.max(start, Math.min(text.length, range.end));
    parent.append(document.createTextNode(text.slice(offset, start)));
    const mark = node('mark', start === end ? 'zero-width' : '', text.slice(start, end)); parent.append(mark); offset = end;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
async function loadFiles() {
  const loadId = state.fileLoad = (state.fileLoad || 0) + 1;
  const version = state.workspace.revision, opts = options();
  const data = await get(`/api/files?hidden=${opts.hidden}&ignore=${opts.ignore}`);
  if (loadId !== state.fileLoad || version !== state.workspace.revision || data.revision !== version) return;
  state.files = [...new Set([...data.files, ...(state.document ? [state.document.path] : [])])]; $('#file-count').textContent = state.files.length + (data.capped ? '+' : '');
  renderFiles();
}
function icon(className) { const el = node('i', className); el.setAttribute('aria-hidden', 'true'); return el; }
function nameParts(parent, name) {
  const split = name.lastIndexOf('.');
  parent.append(node('span', '', split > 0 ? name.slice(0, split) : name));
  if (split > 0) parent.append(node('span', 'file-ext', name.slice(split)));
}
function renderFiles() {
  const fragment = document.createDocumentFragment(), folders = new Map();
  $('#file-list').classList.toggle('file-list-view', !state.tree);
  if (state.tree) {
    const rootButton = node('button', 'folder-row'); rootButton.style.paddingLeft='8px';
    rootButton.append(icon('tree-arrow fa fa-caret-down'), icon('file-icon fa fa-folder'), node('span','file-label',state.workspace.name));
    rootButton.setAttribute('aria-label', '折叠或展开根目录');
    rootButton.addEventListener('click',()=>{state.collapsed.has('')?state.collapsed.delete(''):state.collapsed.add('');renderFiles();});
    rootButton.firstChild.className='tree-arrow fa '+(state.collapsed.has('')?'fa-caret-right':'fa-caret-down'); fragment.append(rootButton);
  }
  if (!state.tree || !state.collapsed.has('')) for (const file of state.files.slice(0,500)) {
    const parts=file.split('/'); let parent='', blocked=false;
    if (state.tree) for(let i=0;i<parts.length-1;i++) {
      const folder=parts.slice(0,i+1).join('/');
      if(!folders.has(folder)) {
        const b=node('button','folder-row'); b.style.paddingLeft=(16+i*8)+'px'; b.title=folder;
        b.append(icon('tree-arrow fa '+(state.collapsed.has(folder)?'fa-caret-right':'fa-caret-down')),icon('file-icon fa fa-folder'),node('span','file-label',parts[i]));
        b.setAttribute('aria-expanded',String(!state.collapsed.has(folder))); b.addEventListener('click',()=>{state.collapsed.has(folder)?state.collapsed.delete(folder):state.collapsed.add(folder);renderFiles();});
        fragment.append(b); folders.set(folder,true);
      }
      if(state.collapsed.has(folder)){blocked=true;break;} parent=folder;
    }
    if(blocked) continue;
    const button=node('button','file-link'+(state.document?.path===file?' active':'')); button.dataset.path=file; button.title=file;
    button.setAttribute('aria-label',file);
    if(!state.tree) {button.append(node('span','file-list-path',parts.slice(0,-1).join(' / ')||'/'));button.append(node('time','file-list-time'));}
    if(state.tree) {button.style.paddingLeft=(28+(parts.length-1)*8)+'px';button.append(icon('file-icon fa fa-file-text-o'));}
    const label=node('span','file-label');nameParts(label,parts.at(-1));button.append(label);
    if(!state.tree) button.append(node('span','file-list-summary',''));
    button.addEventListener('click',()=>openDocument(file));fragment.append(button);
  }
  if (state.files.length>500) fragment.append(node('p','file-limit','更多文档请使用快速打开。'));
  $('#file-list').replaceChildren(fragment);
  if(!state.tree) hydrateFileList();
}
async function hydrateFileList() {
  const revision=state.workspace.revision, list=$('#file-list');
  let pending=[...list.querySelectorAll('.file-link')];
  const observer=new IntersectionObserver(entries=>{for(const entry of entries) if(entry.isIntersecting){observer.unobserve(entry.target);const button=entry.target;previewQueue.push(async()=>{try{const data=await get('/api/document?'+new URLSearchParams({path:button.dataset.path}));if(revision!==state.workspace.revision||!button.isConnected)return;button.querySelector('.file-list-summary').textContent=data.text.replace(/^#{1,6}\s+/gm,'').replace(/\s+/g,' ').slice(0,240);button.querySelector('.file-list-time').textContent=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'}).format(data.modified);}catch{if(button.isConnected)button.querySelector('.file-list-summary').textContent='无法读取预览';}});drainPreviews();}}, {root:$('.sidebar-content'),rootMargin:'80px'});
  state.previewObserver?.disconnect();state.previewObserver=observer;pending.forEach(button=>observer.observe(button));
}
const previewQueue=[];let previewsActive=0;
function drainPreviews(){while(previewsActive<3&&previewQueue.length){const task=previewQueue.shift();previewsActive++;task().finally(()=>{previewsActive--;drainPreviews();});}}
function showSidebar(mode) {
  state.sidebar=mode; document.body.classList.remove('sidebar-hidden'); document.body.classList.toggle('search-active',mode==='search');
  $('#search-form').hidden=mode!=='search'; $('.sidebar-tabs').hidden=mode==='search';
  for(const type of ['files','outline','search']) $('#'+type+'-panel').hidden=type!==mode;
  for(const type of ['files','outline']) {$('#tab-'+type).classList.toggle('active',type===mode);$('#tab-'+type).setAttribute('aria-selected',String(type===mode));}
  $('#folder-menu').hidden=true;
  if(mode==='outline') renderOutline();
}
function renderOutline() {
  const items=[];
  if(state.document) state.document.lines.forEach((line,index)=>{const match=/^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);if(!match)return;const b=node('button','',match[2]);b.style.paddingLeft=((match[1].length-1)*12)+'px';b.addEventListener('click',()=>renderDocument(index+1));items.push(b);});
  $('#outline-panel').replaceChildren(...items);
  if(!items.length) $('#outline-panel').append(node('p','no-results','大纲为空。'));

}
function showWorkspace(data) {
  state.workspace = data; $('#workspace-name').textContent = data.name; $('#workspace-path').textContent = data.root; $('#workspace-path').title = data.root;
  window.paperDesktop?.request('workspaceDidChange', { path: data.root, name: data.name }).catch(() => {});
}
let resultFrame;
function scheduleResults() { if (!resultFrame) resultFrame = requestAnimationFrame(() => { resultFrame = null; renderResults(); }); }
function renderResults() {
  const fragment = document.createDocumentFragment();
  const entries = [...state.results.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  for(const file of entries) {
    const group=node('article','result-group');group.dataset.path=file.path;
    const heading=node('button','result-file');heading.setAttribute('aria-label','打开 '+file.path);
    const collapsed=state.resultCollapsed.has(file.path);
    const toggle=node('button','collapse-result');toggle.setAttribute('aria-label','展开或折叠 '+file.path);toggle.setAttribute('aria-expanded',String(!collapsed));toggle.append(icon('fa '+(collapsed?'fa-caret-right':'fa-caret-down')));
    toggle.addEventListener('click',()=>{state.resultCollapsed.has(file.path)?state.resultCollapsed.delete(file.path):state.resultCollapsed.add(file.path);renderResults();});group.append(toggle);
    const title=node('span','result-name');nameParts(title,file.path.split('/').at(-1));heading.append(title);
    heading.append(node('span','match-badge',file.matches.length?(file.limited?'20+':file.matches.length):'1'));
    if(file.path.includes('/')) heading.append(node('span','result-parent',file.path.slice(0,file.path.lastIndexOf('/')).replaceAll('/',' / ')+' /'));
    heading.addEventListener('click',()=>openDocument(file.path));group.append(heading);
    if(!collapsed) for(const match of file.matches) {
      const button=node('button','result-line');button.dataset.line=match.line;button.setAttribute('aria-label',file.path+' 第 '+match.line+' 行');
      const snippet=node('span','snippet');appendMarked(snippet,match.text,match.ranges);button.append(snippet);
      button.addEventListener('click',()=>{document.querySelectorAll('.result-line.active').forEach(el=>el.classList.remove('active'));button.classList.add('active');openDocument(file.path,{...match,requestId:state.requestId});});group.append(button);
    }
    if(!file.matches.length){const b=node('button','result-line',file.path.split('/').at(-1));b.addEventListener('click',()=>openDocument(file.path));group.append(b);}
    fragment.append(group);
  }
  $('#results').replaceChildren(fragment);
}
async function search() {
  clearTimeout(searchDelay);
  showSidebar('search');
  const query = $('#query').value;
  if (!query.trim()) { status('输入词句后按 Enter 搜索。'); $('#query').focus(); return; }
  const oldController = state.controller;
  const requestId = crypto.randomUUID(), controller = new AbortController();
  state.requestId = requestId; state.controller = controller; state.results.clear(); state.resultCollapsed.clear();
  oldController?.abort(); setBusy(true); error('#search-error', ''); status('正在搜索「' + query + '」…'); $('#results').replaceChildren(); $('#export-trace').disabled = false;
  try {
    const res = await api('/api/search', { clientId, requestId, query, options: options(), revision: state.workspace.revision }, controller.signal);
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const consume = (final = false) => {
      const frames = buffer.split('\n\n'); buffer = frames.pop(); if (final && buffer) { frames.push(buffer); buffer = ''; }
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: ')); if (!data) continue;
        const event = JSON.parse(data.slice(6)); if (state.requestId !== event.requestId) continue;
        if (event.type === 'file') { state.results.set(event.path, event); scheduleResults(); status('已找到 ' + state.results.size + ' 个文件，继续搜索…'); }
        if (event.type === 'error') error('#search-error', event.message);
        if (event.type === 'done') {
          setBusy(false); renderResults();
          const perFileLimited = [...state.results.values()].some((file) => file.limited);
          const count = event.files + ' 个文件 · ' + event.lines + ' 个匹配行' + (perFileLimited ? '（部分文件达到每文件上限）' : '');
          status(event.cancelled ? '已停止搜索。' : event.failed ? '搜索未完成，请检查下方提示。' : event.truncated ? count + '。已达到结果上限，请缩小搜索范围。' : count);
          if (!event.files && !event.failed && !event.cancelled) $('#results').append(node('div', 'no-results', '没有找到结果。试试更短的关键词，或调整搜索范围。'));
        }
      }
    };
    while (true) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); consume(); }
    buffer += decoder.decode(); consume(true);
  } catch (e) {
    if (state.requestId === requestId && e.name !== 'AbortError') { error('#search-error', e.message); status('搜索未完成。'); }
  } finally { if (state.requestId === requestId) setBusy(false); }
}
async function openDocument(file, match = {}, providedData = null) {
  const nav = ++state.nav, revision = state.workspace.revision;
  error('#document-error', '');
  try {
    const qs = new URLSearchParams({ path: file, line: String(match.line || 1), ...(match.requestId ? { requestId: match.requestId } : {}) });
    const data = providedData || await get('/api/document?' + qs);
    if (nav !== state.nav || revision !== state.workspace.revision || data.revision !== revision) return;
    state.document = { ...data, lines: data.text.split(/\r?\n/), focusLine: match.line || 1, ranges: match.ranges || [] };
    if (match.text !== undefined && state.document.lines[match.line - 1] !== match.text) {
      state.document.ranges = []; error('#document-error', '文件内容已变化。请重新搜索以更新匹配位置。');
    }
    state.recent=[file,...state.recent.filter(path=>path!==file)].slice(0,20);
    $('#document-title').textContent = file.split('/').pop(); $('#document-folder').textContent = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : state.workspace.name;
    $('#document-find').value = ''; state.findHits = []; state.findIndex = -1; $('#find-count').textContent = '';
    $('#document-meta').textContent = (data.text.match(/[\u3400-\u9fff]|[\p{L}\p{N}_]+/gu)||[]).length + ' 字';
    document.title=file.split('/').pop();
    window.paperDesktop?.request('documentDidChange',{name:file.split('/').pop(),path:file}).catch(()=>{});
    renderOutline();
    renderDocument(state.document.focusLine, state.document.ranges);
    for (const link of document.querySelectorAll('.file-link')) link.classList.toggle('active', link.dataset.path === file);
    if (match.requestId) await api('/api/interaction', { type: 'navigation.ready', requestId: match.requestId, path: file, line: match.line, selectedText: (match.ranges?.[0] ? state.document.lines[match.line - 1]?.slice(match.ranges[0].start, match.ranges[0].end) : '') });
  } catch (e) { if (nav === state.nav) error('#document-error', e.message); }
}
const markdown = window.markdownit({ html:false, linkify:true, typographer:false });
// Read-only preview never fetches remote images; display their alt text instead.
markdown.renderer.rules.image=(tokens,index)=>'<span class="image-alt">'+markdown.utils.escapeHtml(tokens[index].content||'图片')+'</span>';
function markPreview(container, text) {
  if(!text) return null;
  const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT), leaves=[]; let leaf;
  while((leaf=walker.nextNode())) leaves.push(leaf);
  const joined=leaves.map(n=>n.textContent).join(''), start=joined.indexOf(text);if(start<0)return null;
  let offset=0, first=null;
  for(const leaf of leaves) {
    const a=Math.max(0,start-offset),b=Math.min(leaf.length,start+text.length-offset);
    if(a<b) {const fragment=document.createDocumentFragment();fragment.append(document.createTextNode(leaf.textContent.slice(0,a)));const mark=node('mark','',leaf.textContent.slice(a,b));fragment.append(mark,document.createTextNode(leaf.textContent.slice(b)));leaf.replaceWith(fragment);first ||= mark;}
    offset+=leaf.length;
  }
  return first;
}
function renderDocument(focusLine=1,ranges=[]) {
  const doc=state.document;if(!doc)return;
  focusLine=Math.max(1,Math.min(doc.lines.length,focusLine));doc.focusLine=focusLine;doc.ranges=ranges;
  document.body.classList.toggle('source-view',state.source);$('#toggle-source').setAttribute('aria-pressed',String(state.source));
  const article=node('article');article.id='write';let focused;
  if(state.source) {
    const start=Math.max(0,focusLine-70),end=Math.min(doc.lines.length,start+180);
    if(start||end<doc.lines.length){const paging=node('div','document-paging');if(start){const b=node('button','', '前 100 行');b.addEventListener('click',()=>renderDocument(Math.max(1,focusLine-100)));paging.append(b);}paging.append(node('span','',`第 ${start+1}–${end} 行 / 共 ${doc.lines.length} 行`));if(end<doc.lines.length){const b=node('button','','后 100 行');b.addEventListener('click',()=>renderDocument(Math.min(doc.lines.length,focusLine+100)));paging.append(b);}article.append(paging);}
    for(let i=start;i<end;i++){const row=node('div','source-line'+(i+1===focusLine?' focused':''));row.dataset.line=i+1;row.append(node('span','source-number',i+1));const text=node('span','source-text');appendMarked(text,doc.lines[i],i+1===focusLine?ranges:[]);row.append(text);article.append(row);if(i+1===focusLine)focused=row;}
  } else {
    // Only parser-generated, HTML-disabled markup enters this controlled preview.
    article.innerHTML=renderMarkdown(markdown,doc.text);
    const blocks=[...article.querySelectorAll('[data-source-start]')].filter(el=>Number(el.dataset.sourceStart)<=focusLine&&Number(el.dataset.sourceEnd)>=focusLine);
    focused=blocks.at(-1);
    if(focused) {const block=focused;focused.classList.add('focused'); for(const range of ranges) {const value=doc.lines[focusLine-1].slice(range.start,range.end);focused=markPreview(block,value)||focused;}}
    article.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();});
  }
  $('#reader').replaceChildren(article);$('#document-position').textContent='第 '+focusLine+' 行';
  if(focusLine>1&&focused) focused.scrollIntoView({block:'center',behavior:'instant'});else $('#reader').scrollTop=0;
}

function findInDocument() {
  state.findHits = []; state.findIndex = -1;
  const query = $('#document-find').value; if (!state.document || !query) { $('#find-count').textContent = ''; if (state.document) renderDocument(); return; }
  let re;
  try {re=new RegExp(state.findOptions.regexp?query:escapeRegex(query),state.findOptions.caseSensitive?'gu':'giu');error('#document-error','');}
  catch {$('#find-count').textContent='表达式无效';return;}
  const word=(text)=>text&&/[\p{L}\p{N}_]/u.test(text);
  outer:for(let i=0;i<state.document.lines.length;i++) {
    const line=state.document.lines[i];re.lastIndex=0;let hit;
    while((hit=re.exec(line))) {
      const end=hit.index+hit[0].length;
      if(!state.findOptions.wholeWord||(!word([...line.slice(0,hit.index)].at(-1))&&!word([...line.slice(end)][0]))) state.findHits.push({line:i+1,start:hit.index,end});
      if(state.findHits.length>=5001)break outer;
      if(hit[0].length===0){const point=line.codePointAt(re.lastIndex);re.lastIndex+=point>0xffff?2:1;if(re.lastIndex>line.length)break;}
    }
  }
  state.findIndex = state.findHits.length ? 0 : -1; showFind();
}
function showFind() {
  const hit = state.findHits[state.findIndex]; $('#find-count').textContent = state.findHits.length ? (state.findIndex + 1) + '/' + (state.findHits.length > 5000 ? '5000+' : state.findHits.length) : '无匹配';
  if (hit) renderDocument(hit.line, [hit]);
}
function quickResults() {
  const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = normalize($('#quick-query').value).trim().split(/\s+/).filter(Boolean);
  const matches = state.files.map((file) => ({ file, score: words.reduce((score, word) => score + (normalize(file.split('/').pop()).includes(word) ? 2 : normalize(file).includes(word) ? 1 : -10000), 0) })).filter((r) => r.score >= 0).sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1)).slice(0, 100);
  const recents=state.recent.map(file=>matches.find(item=>item.file===file)).filter(Boolean).slice(0,5);
  const entries=[...recents.map(item=>({...item,recent:true})),...matches.filter(item=>!recents.some(recent=>recent.file===item.file))];
  state.quickEntries = entries; state.quickIndex = Math.min(state.quickIndex, Math.max(0, entries.length - 1));
  const fragment=document.createDocumentFragment();let section='';
  entries.forEach((item,i)=>{const category=item.recent?'最近文件':'文件结果';if(category!==section){fragment.append(node('div','quick-category',category));section=category;}const b=node('button','quick-result'+(state.quickIndex===i?' selected':''));b.append(node('span','quick-result-title',item.file.split('/').pop()),node('span','quick-result-path',state.workspace.root+'/'+item.file));b.addEventListener('click',()=>{$('#quick-dialog').close();openDocument(item.file);});fragment.append(b);});
  $('#quick-results').replaceChildren(fragment);
  if (!entries.length) $('#quick-results').append(node('p', 'muted', '没有匹配的文档。'));
}
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });

$('#cancel').addEventListener('click', async () => {
  const id = state.requestId;
  try { await api('/api/cancel', { clientId, requestId: id });
    if (state.requestId === id) { state.controller?.abort(); setBusy(false); status('已停止搜索。'); }
  } catch (e) { error('#search-error', e.message); }
});
$('#document-find').addEventListener('input', findInDocument);
$('#document-find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#find-' + (e.shiftKey ? 'prev' : 'next')).click(); } });
for (const [id, delta] of [['#find-prev', -1], ['#find-next', 1]]) $(id).addEventListener('click', () => { if (state.findHits.length) { state.findIndex = (state.findIndex + delta + state.findHits.length) % state.findHits.length; showFind(); } });
$('#change-workspace').addEventListener('click', async () => {
  if (window.paperDesktop) {
    try { const result = await window.paperDesktop.request('chooseFolder', { currentPath: state.workspace.root }); if (result.path) await changeWorkspace(result.path); }
    catch (e) { error('#search-error', e.message); }
    return;
  }
  $('#folder-path').value = state.workspace.root; $('#workspace-dialog').showModal(); $('#folder-path').focus();
});
$('#workspace-dismiss').addEventListener('click', () => $('#workspace-dialog').close());
async function changeWorkspace(folder) {
  const data = await (await api('/api/workspace', { path: folder })).json();
  resetWorkspace(data);
  status('文件夹已打开，输入词句开始搜索。'); await loadFiles();
}
function resetWorkspace(data) {
  clearTimeout(searchDelay); state.fileLoad = (state.fileLoad || 0) + 1; state.files=[]; state.collapsed.clear();
  state.requestId = null; state.controller?.abort(); setBusy(false); state.nav++; state.document = null; state.results.clear(); state.recent=[];
  state.findHits = []; state.findIndex = -1; $('#document-find').value = ''; $('#find-count').textContent = ''; $('#export-trace').disabled = true; error('#document-error', '');
  showWorkspace(data); renderResults(); $('#reader').replaceChildren(node('div', 'no-results', '从文件列表或搜索结果中打开文档。')); $('#document-title').textContent = '选择文档'; $('#document-folder').textContent = data.name; $('#document-position').textContent = '原文'; $('#document-meta').textContent = '';
  renderFiles();
}
async function openExternalFile(path) {
  const data = await (await api('/api/open-file', {path})).json();
  resetWorkspace(data.workspace); state.files=[data.document.path]; renderFiles(); showSidebar('files');
  await openDocument(data.document.path, {}, data.document);
  status('文件已打开，搜索范围为所在文件夹。');
  const revision=state.workspace.revision;
  loadFiles().catch(e=>{if(revision===state.workspace.revision)error('#document-error','文档已打开；无法载入同目录文件：'+e.message);});
}
let nativeOpenQueue=Promise.resolve(), nativeOpenCount=0;
function queueExternalFile(path) {
  nativeOpenCount++;
  const task=nativeOpenQueue.then(()=>openExternalFile(path));
  nativeOpenQueue=task.catch(e=>error('#document-error',e.message)); return nativeOpenQueue;
}
window.addEventListener('paper-open-file',event=>{if(event.detail?.path)queueExternalFile(event.detail.path);});
$('#open-file').hidden=!window.paperDesktop;
$('#open-file').addEventListener('click',async()=>{try {const data=await window.paperDesktop.request('chooseFile');if(data.path)await queueExternalFile(data.path);}catch(e){error('#document-error',e.message);}});
window.addEventListener('paper-open-workspace', (event) => { if (event.detail?.path) changeWorkspace(event.detail.path).catch((e) => error('#search-error', e.message)); });
$('#workspace-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#workspace-error').textContent = '';
  try {
    await changeWorkspace($('#folder-path').value.trim()); $('#workspace-dialog').close();
  } catch (e) { $('#workspace-error').textContent = e.message; }
});
for (const id of ['hidden', 'ignore']) $('#' + id).addEventListener('change', () => loadFiles().catch((e) => error('#search-error', e.message)));
$('#quick-open').addEventListener('click', () => { if($('#quick-dialog').open){$('#quick-dialog').close();return;} $('#quick-dialog').showModal(); state.quickIndex = 0; $('#quick-query').value = ''; quickResults(); $('#quick-query').focus(); });
$('#quick-dismiss').addEventListener('click', () => $('#quick-dialog').close());
$('#quick-query').addEventListener('input', () => { state.quickIndex = 0; quickResults(); });
$('#quick-query').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); state.quickIndex = Math.max(0, Math.min((state.quickEntries?.length || 1) - 1, state.quickIndex + (e.key === 'ArrowDown' ? 1 : -1))); quickResults(); $('#quick-results .selected')?.scrollIntoView({ block: 'nearest' }); }
  if (e.key === 'Enter' && state.quickEntries[state.quickIndex]) { e.preventDefault(); const file = state.quickEntries[state.quickIndex].file; $('#quick-dialog').close(); openDocument(file); }
});
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key.toLowerCase() === 'k' || (e.shiftKey && e.key.toLowerCase() === 'o')) { e.preventDefault(); $('#quick-open').click(); }
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); e.shiftKey ? openSearch() : openFind(); }
});
$('#export-trace').addEventListener('click', async () => {
  try {
    const data = await get('/api/trace?requestId=' + state.requestId);
    if (window.paperDesktop) { await window.paperDesktop.request('saveTrace', { data }); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'markdesk-trace-' + state.requestId + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { error('#search-error', e.message); }
});
document.body.classList.toggle('desktop',Boolean(window.paperDesktop));
function openSearch(){showSidebar('search');$('#query').focus();}
function openFind(){document.body.classList.add('find-open');$('#document-search').hidden=false;$('#document-find').focus();}
$('#show-search').addEventListener('click',openSearch);$('#menu-search').addEventListener('click',openSearch);
$('#search-back').addEventListener('click',()=>showSidebar('files'));
$('#tab-files').addEventListener('click',()=>showSidebar('files'));$('#tab-outline').addEventListener('click',()=>showSidebar('outline'));
function switchFiles(){state.tree=!state.tree;renderFiles();}
$('#switch-file-view').addEventListener('click',switchFiles);$('#switch-file-view-footer').addEventListener('click',switchFiles);
$('#folder-menu-toggle').addEventListener('click',()=>{$('#folder-menu').hidden=!$('#folder-menu').hidden;});
$('#refresh-files').addEventListener('click',()=>{$('#folder-menu').hidden=true;loadFiles().catch(e=>error('#search-error',e.message));});
$('#toggle-sidebar').addEventListener('click',()=>document.body.classList.toggle('sidebar-hidden'));
$('#toggle-source').addEventListener('click',()=>{state.source=!state.source;if(state.document)renderDocument(state.document.focusLine,state.document.ranges);});
$('#find-close').addEventListener('click',()=>{$('#document-search').hidden=true;document.body.classList.remove('find-open');});
for(const [id,key] of [['case','caseSensitive'],['whole','wholeWord'],['regexp','regexp']])$('#find-'+id).addEventListener('click',()=>{state.findOptions[key]=!state.findOptions[key];$('#find-'+id).setAttribute('aria-pressed',String(state.findOptions[key]));findInDocument();});
let searchDelay;
$('#query').addEventListener('input',()=>{clearTimeout(searchDelay);if(!$('#query').value.trim()){state.controller?.abort();state.results.clear();renderResults();status('');setBusy(false);return;}searchDelay=setTimeout(search,200);});
for(const id of ['caseSensitive','wholeWord','regexp'])$('#'+id).addEventListener('change',()=>{if($('#query').value.trim())search();});
window.addEventListener('paper-command',event=>{const command=event.detail;if(command==='search')openSearch();if(command==='find')openFind();if(command==='quick')$('#quick-open').click();if(command==='source')$('#toggle-source').click();if(command==='sidebar')$('#toggle-sidebar').click();if(command==='files')showSidebar('files');if(command==='outline')showSidebar('outline');});
document.addEventListener('click',event=>{if(!event.target.closest('#folder-menu,#folder-menu-toggle'))$('#folder-menu').hidden=true;});
const resizer=$('#sidebar-resizer');
function resizeSidebar(value){const width=Math.max(180,Math.min(600,window.innerWidth-320,value));document.documentElement.style.setProperty('--sidebar-width',width+'px');resizer.setAttribute('aria-valuenow',String(width));}
resizer.addEventListener('pointerdown',event=>{resizer.setPointerCapture(event.pointerId);const move=e=>resizeSidebar(e.clientX);const end=()=>{resizer.removeEventListener('pointermove',move);resizer.removeEventListener('pointerup',end);};resizer.addEventListener('pointermove',move);resizer.addEventListener('pointerup',end);});
resizer.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resizeSidebar(Number(resizer.getAttribute('aria-valuenow'))+(event.key==='ArrowRight'?10:-10));}});
try {
  showWorkspace(await get('/api/state')); showSidebar('files');
  const pending=window.paperDesktop ? await window.paperDesktop.request('rendererReady') : null;
  if(pending?.path) await queueExternalFile(pending.path);
  else {
    const nav=state.nav, revision=state.workspace.revision, openCount=nativeOpenCount;
    $('#file-list').append(node('p','no-results','正在读取文件夹…')); await loadFiles();
    const welcome=state.files.find(file=>file==='欢迎.md')||state.files[0];
    if(welcome && openCount===nativeOpenCount && nav===state.nav && revision===state.workspace.revision && !state.document)await openDocument(welcome);
  }
} catch(e){showSidebar('search');error('#search-error',e.message);}
