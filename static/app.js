'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  opened: false, name: '', handle: null, source: '', baseline: '', selected: -1,
  rows: [], view: 'record', page: 0, pageSize: 80, draft: null,
  undo: [], redo: [], busy: false, version: null, checked: new Set(), typeFilter: '', sync: null,
};
const local = { token: '', tableOffset: 0, mode: 'conversation', row: null, chatRequest: 0, tableRequest: 0,
  groups: [], expanded: new Set(), groupsInitialized: false, searchCollapsed: new Set(), sidebarQuery: '',
  projectOrder: [], projectDrag: null, projectLimits: new Map(), loadingProjects: new Map(),
  ignoredProjects: new Map(), searchScope: null, menuProject: null, menuAnchor: null, lastDataMode: 'conversation',
  recoveryPlan: null, recoveryDraft: null, backupRequest: 0 };
const transcript = { source: null, inheritedRef: null, messages: [], prompts: [], expanded: new Set(), active: '', hover: null, observer: null, edit: null };
let toastTimer, inputTimer;
function icons() { window.lucide?.createIcons(); }
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000);
}
function dirty() { return state.draft !== null || state.source !== state.baseline ||
  !!(transcript.edit && transcript.edit.value !== transcript.edit.originalValue); }
function splitSource(text) {
  const rows = []; const linePattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match;
  while ((match = linePattern.exec(text)) && match[0].length) {
    rows.push({ raw: match[1], eol: match[2], error: null, value: null });
  }
  rows.forEach((row, i) => {
    row.line = i + 1;
    try { row.value = JSON.parse(row.raw); }
    catch (error) { row.error = row.raw.trim() ? error.message : '空行不是有效的 JSON 记录'; }
  });
  return rows;
}
function textFromRows(rows) { return rows.map((row) => row.raw + row.eol).join(''); }
function checkpoint() {
  state.undo.push({ source: state.source, selected: state.selected });
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}
function applySource(text, selected = state.selected, remember = true, preserveChecks = false) {
  if (text !== state.source && remember) checkpoint();
  // Row numbers may shift after structural or full-file edits.
  if (text !== state.source && !preserveChecks) state.checked.clear();
  state.source = text; state.rows = splitSource(text);
  state.selected = state.rows.length ? Math.max(0, Math.min(selected, state.rows.length - 1)) : -1;
}
function currentError() {
  if (state.draft !== null) {
    try { JSON.parse(state.draft); } catch (error) { return error.message; }
  }
  if (state.view === 'record') return state.rows[state.selected]?.error ?? null;
  const errors = state.rows.filter((row) => row.error);
  return errors.length ? `第 ${errors[0].line} 行：${errors[0].error}（共 ${errors.length} 行错误）` : null;
}
function finishDraft() {
  if (transcript.edit && !applyMessageEdit(false)) return false;
  clearTimeout(inputTimer);
  if (state.view !== 'record' || state.draft === null) return true;
  let value;
  try { value = JSON.parse(state.draft); }
  catch { toast('当前记录有 JSON 错误，请修正后再切换或保存。'); $('editor').focus(); return false; }
  const rows = state.rows.map((row) => ({ ...row }));
  rows[state.selected].raw = JSON.stringify(value);
  const text = textFromRows(rows);
  if (text !== state.source) applySource(text, state.selected, true, true);
  state.draft = null;
  return true;
}
function rowTypeKey(row) {
  if (row.error) return '$invalid';
  if (!row.value || typeof row.value !== 'object' || !Object.hasOwn(row.value, 'type')) return '$missing';
  return 'value:' + JSON.stringify(row.value.type);
}
function typeLabel(key) {
  if (key === '$missing') return '缺少 type';
  if (key === '$invalid') return '无效 JSON';
  const value = JSON.parse(key.slice(6));
  if (typeof value === 'string') return value || '""（空字符串）';
  return `${JSON.stringify(value)}（${value === null ? 'null' : Array.isArray(value) ? '数组' : { number: '数字', boolean: '布尔', object: '对象' }[typeof value]}）`;
}
function renderTypeFilter() {
  const counts = new Map();
  for (const row of state.rows) {
    const key = rowTypeKey(row); counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (state.typeFilter && !counts.has(state.typeFilter)) counts.set(state.typeFilter, 0);
  const options = [new Option(`全部类型（${state.rows.length}）`, '')];
  for (const [key, count] of counts) options.push(new Option(`${typeLabel(key)}（${count}）`, key));
  $('type-filter').replaceChildren(...options); $('type-filter').value = state.typeFilter;
}
function filteredRows() {
  const query = $('search').value.toLowerCase();
  return state.rows.map((row, i) => ({ row, i })).filter(({ row }) =>
    (!query || row.raw.toLowerCase().includes(query)) && (!$('errors-only').checked || row.error) &&
    (!state.typeFilter || rowTypeKey(row) === state.typeFilter));
}
function recordTitle(row) {
  if (row.error) return '无效 JSON';
  if (row.value === null) return 'null';
  if (Array.isArray(row.value)) return `数组 · ${row.value.length} 项`;
  if (typeof row.value !== 'object') return String(row.value);
  for (const key of ['title', 'name', 'id', 'role', 'type']) {
    if (typeof row.value[key] === 'string' || typeof row.value[key] === 'number') return String(row.value[key]);
  }
  return `${Object.keys(row.value).length} 个字段`;
}
function renderList() {
  renderTypeFilter();
  const matches = filteredRows(); const pages = Math.ceil(matches.length / state.pageSize);
  state.page = Math.max(0, Math.min(state.page, Math.max(0, pages - 1)));
  $('records').replaceChildren();
  for (const { row, i } of matches.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
    const entry = document.createElement('div'); entry.className = 'record-entry'; entry.setAttribute('role', 'listitem');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'record-checkbox';
    checkbox.checked = state.checked.has(i); checkbox.disabled = state.busy;
    checkbox.setAttribute('aria-label', `勾选第 ${i + 1} 行`);
    checkbox.onchange = () => {
      if (state.busy) return;
      if (checkbox.checked) state.checked.add(i); else state.checked.delete(i);
      renderSelection();
    };
    const item = document.createElement('button'); item.className = 'record-item';
    item.classList.toggle('selected', i === state.selected); item.classList.toggle('invalid', !!row.error);
    item.setAttribute('aria-current', String(i === state.selected));
    const top = document.createElement('div'); top.className = 'record-top';
    const title = document.createElement('span'); title.textContent = recordTitle(row);
    title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const number = document.createElement('span'); number.className = 'record-number'; number.textContent = `#${i + 1}`;
    top.append(title, number);
    const preview = document.createElement('div'); preview.className = 'record-preview'; preview.textContent = row.raw || '(空行)';
    item.append(top, preview); item.title = `第 ${i + 1} 行`;
    item.addEventListener('click', () => {
      if (state.busy) return;
      if (!finishDraft()) return;
      state.selected = i; state.view = 'record'; render();
    });
    entry.append(checkbox, item); $('records').append(entry);
  }
  if (!matches.length) {
    const message = document.createElement('div'); message.className = 'list-empty';
    message.textContent = state.opened ? (state.rows.length ? '没有匹配的记录' : '暂无记录') : '未打开文件';
    $('records').append(message);
  }
  $('list-count').textContent = `${matches.length} 条记录`;
  $('count').textContent = state.rows.length; $('page').textContent = `/ ${pages}`;
  $('page-number').value = pages ? state.page + 1 : 0;
  $('page-number').max = Math.max(1, pages); $('page-number').disabled = !pages;
  $('jump').disabled = !pages;
  $('prev').disabled = !pages || state.page === 0; $('next').disabled = !pages || state.page >= pages - 1;
  renderSelection();
}
function renderSelection() {
  const visible = filteredRows().slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
  const selectedCount = visible.filter(({ i }) => state.checked.has(i)).length;
  $('select-page').checked = !!visible.length && selectedCount === visible.length;
  $('select-page').indeterminate = selectedCount > 0 && selectedCount < visible.length;
  $('select-page').disabled = !visible.length || state.busy;
  $('checked-count').textContent = `已选 ${state.checked.size}`;
  $('clear-checked').disabled = !state.checked.size || state.busy;
  $('delete-checked').disabled = !state.checked.size || state.busy;
  $('delete-checked').title = `删除 ${state.checked.size} 条勾选记录`;
}
function editorText() {
  if (state.view === 'source') return state.source;
  if (state.draft !== null) return state.draft;
  const row = state.rows[state.selected];
  return row ? (row.error ? row.raw : JSON.stringify(row.value, null, 2)) : '';
}
function updateGutter() {
  const count = $('editor').value.split('\n').length;
  $('gutter').textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  $('gutter').scrollTop = $('editor').scrollTop;
}
function updateCursor() {
  const before = $('editor').value.slice(0, $('editor').selectionStart);
  const lines = before.split('\n'); $('cursor').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
}
function renderStatus() {
  const errors = state.rows.filter((row) => row.error).length;
  const error = currentError(); $('validation').hidden = !error; $('validation-text').textContent = error ?? '';
  $('dirty').hidden = !dirty(); document.title = `${dirty() ? '* ' : ''}${state.name || 'JSONL 编辑器'}`;
  $('summary').textContent = `${state.rows.length} 条记录${errors ? ` · ${errors} 行错误` : ''}`;
  $('file-meta').textContent = `UTF-8 · ${state.source.includes('\r\n') ? 'CRLF' : 'LF'} · ${new Blob([state.source]).size.toLocaleString()} B`;
  $('save').disabled = !state.opened || state.busy;
  $('save').querySelector('span').textContent = state.sync ? '同步保存' : state.handle ? '保存原文件' : '选择位置保存';
  $('save-as').disabled = !state.opened || state.busy;
  $('manual-backup').disabled = $('backup-current').disabled = !state.sync || state.busy;
  $('preview-recovery').disabled = !state.sync || state.busy || dirty();
  $('open-backups').disabled = $('recovery-mode').disabled = state.busy;
  $('create-recovery-copy').disabled = state.busy || !local.recoveryPlan?.selectedTurns ||
    Number($('recovery-keep').value) !== local.recoveryPlan?.keep;
  $('export-handoff').disabled = state.busy || !local.recoveryPlan;
  $('recovery-handoff').readOnly = state.busy || $('recovery-copy-mode').value !== 'handoff';
  $('recovery-copy-mode').disabled = state.busy;
  $('recovery-keep').disabled = state.busy;
  $('backup-list').querySelectorAll('button').forEach((button) => { button.disabled = state.busy || button.dataset.unavailable === 'true'; });
  $('open').disabled = state.busy; $('new').disabled = state.busy; $('empty-open').disabled = state.busy;
  $('add').disabled = !state.opened || state.busy;
  $('format').disabled = !state.opened || state.busy || (state.view === 'record' && state.selected < 0);
  $('delete').disabled = state.view !== 'record' || state.selected < 0 || state.busy;
  $('delete-before').disabled = state.view !== 'record' || state.selected <= prefixDeletionStart() || state.busy;
  $('delete-after').disabled = state.view !== 'record' || state.selected < 0 || state.selected >= state.rows.length - 1 || state.busy;
  $('undo').disabled = (!state.undo.length && state.draft === null) || state.busy;
  $('redo').disabled = !state.redo.length || state.busy;
  $('editor').readOnly = state.busy; $('record-tab').disabled = state.busy; $('source-tab').disabled = state.busy;
  $('search').disabled = !state.opened; $('errors-only').disabled = !state.opened;
  $('type-filter').disabled = !state.opened || state.busy;
  $('status').lastChild.textContent = state.busy ? '正在保存...' : error ? '存在 JSON 错误' : '就绪';
  $('save-status').textContent = !state.opened ? '未打开文件' : dirty() ? '有未保存的修改' : state.sync ? 'JSONL / SQLite 已读取' : state.handle ? '与原文件一致' : '尚未关联原文件';
  $('sqlite-mode').disabled = !state.sync || state.busy;
  $('reload-chat').disabled = !state.sync || state.busy;
  $('repair-index').disabled = !state.sync || state.busy || dirty();
  $('chat-search').disabled = state.busy;
  $('refresh-chats').disabled = state.busy;
  $('expand-all-projects').disabled = $('collapse-all-projects').disabled = state.busy || !visibleProjectGroups().length;
  $('project-context-menu').querySelectorAll('button').forEach((button) => { button.disabled = state.busy; });
  $('show-ignored-projects').disabled = state.busy;
  $('restore-all-projects').disabled = state.busy || !local.ignoredProjects.size;
  document.querySelectorAll('.project-menu-trigger, .ignored-project-row button').forEach((button) => { button.disabled = state.busy; });
  document.querySelectorAll('.project-more, .project-less').forEach((button) => { button.disabled = state.busy || button.dataset.loading === 'true'; });
  $('mirror-messages').disabled = !state.sync || state.busy;
  document.querySelectorAll('.project-grip').forEach((grip) => {
    grip.disabled = state.busy || !!$('chat-search').value.trim() || !!local.searchScope || visibleProjectGroups().length < 2;
  });
  $('conversation-workspace').querySelectorAll('button').forEach((button) => { button.disabled = state.busy; });
  renderSyncInfo();
  document.querySelectorAll('.record-checkbox').forEach((input) => { input.disabled = state.busy; });
  renderSelection();
}
function render(resetEditor = true) {
  renderList(); renderStatus();
  $('filename').textContent = state.name || '未打开文件';
  const show = state.opened && (state.view === 'source' || state.selected >= 0);
  $('empty').hidden = show; $('editor-wrap').hidden = !show;
  $('empty').querySelector('h2').textContent = state.opened ? '文件中暂无记录' : '选择一条聊天';
  $('empty-open').hidden = state.opened; $('new').hidden = state.opened;
  $('record-tab').setAttribute('aria-selected', String(state.view === 'record'));
  $('source-tab').setAttribute('aria-selected', String(state.view === 'source'));
  $('selection-label').textContent = state.view === 'record' && state.selected >= 0 ? `第 ${state.selected + 1} 行` : '';
  $('view-meta').textContent = state.view === 'source' ? 'JSONL' : 'JSON';
  if (resetEditor) $('editor').value = editorText();
  updateGutter(); updateCursor(); icons();
  if (local.mode === 'conversation') renderConversation();
}
function confirmAction(title, message, action = '继续') {
  $('dialog-title').textContent = title; $('dialog-message').textContent = message; $('dialog-confirm').textContent = action;
  return new Promise((resolve) => {
    $('confirm-dialog').addEventListener('close', () => resolve($('confirm-dialog').returnValue === 'confirm'), { once: true });
    $('confirm-dialog').showModal();
  });
}
async function allowReplace() {
  return !dirty() || await confirmAction('放弃未保存的修改？', '当前修改尚未写入文件。打开其他文件会丢弃这些修改。', '放弃修改');
}
async function readFile(file, handle = null, sync = null) {
  // Fatal decoding prevents silently overwriting non-UTF-8 files with replacement characters.
  const bytes = await file.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (new Uint8Array(bytes).slice(0, 3).join(',') === '239,187,191') throw new Error('文件包含 UTF-8 BOM。请先移除 BOM，避免保存时改变原文件。');
  state.opened = true; state.name = file.name; state.handle = handle; state.baseline = text; state.sync = sync;
  state.source = ''; state.undo = []; state.redo = []; state.draft = null; state.view = 'record'; state.page = 0; state.checked.clear(); state.typeFilter = '';
  state.version = { size: file.size, modified: file.lastModified };
  $('search').value = ''; $('errors-only').checked = false; $('clear-search').hidden = true;
  transcript.source = null; transcript.expanded.clear(); transcript.active = ''; $('prompt-search').value = '';
  transcript.edit = null;
  local.recoveryPlan = null;
  local.recoveryDraft = null;
  $('conversation-scroll').scrollTop = 0;
  if (innerWidth < 850) $('prompt-nav').classList.add('collapsed');
  applySource(text, 0, false); render();
  switchMode(sync || window.ChatTranscript.readMessages(state.rows).length ? 'conversation' : 'jsonl');
  if (!handle && !sync) toast('普通文件未关联 SQLite。');
}
async function openFile() {
  if (state.busy || !await allowReplace()) return;
  try {
    if ('showOpenFilePicker' in window) {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON Lines', accept: { 'application/json': ['.jsonl', '.ndjson', '.json', '.txt'] } }] });
      await readFile(await handle.getFile(), handle);
    } else { $('file-input').value = ''; $('file-input').click(); }
  } catch (error) { if (error.name !== 'AbortError') toast(`无法打开文件：${error.message}`); }
}
function validatedText() {
  if (!finishDraft()) throw new Error('请先修正当前记录中的 JSON 错误。');
  const error = state.rows.find((row) => row.error);
  if (error) { state.selected = error.line - 1; state.view = 'record'; switchMode('jsonl'); render(); throw new Error(`第 ${error.line} 行不是有效 JSON，未保存文件。`); }
  return state.source;
}
function downloadFile(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = state.name || 'untitled.jsonl'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('已下载副本；浏览器不支持直接覆盖原文件。');
}
async function saveFile(asNew = false) {
  if (!state.opened || state.busy) return;
  let text;
  try { text = validatedText(); } catch (error) { toast(error.message); return; }
  if (state.sync) {
    if (asNew) { downloadFile(text); return; }
    await saveSynced(text); return;
  }
  let handle = asNew ? null : state.handle;
  try {
    if (!handle) {
      if (!('showSaveFilePicker' in window)) { downloadFile(text); return; }
      handle = await window.showSaveFilePicker({ suggestedName: state.name || 'untitled.jsonl', types: [{ description: 'JSON Lines', accept: { 'application/json': ['.jsonl', '.ndjson'] } }] });
    }
    state.busy = true; renderStatus();
    if (state.handle && await handle.isSameEntry(state.handle)) {
      const current = await handle.getFile();
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await current.arrayBuffer());
      if (content !== state.baseline) throw new Error('原文件已被外部修改。为避免覆盖其他修改，请重新打开文件或另存为。');
    }
    const writable = await handle.createWritable();
    try { await writable.write(text); await writable.close(); }
    catch (error) { try { await writable.abort(); } catch {} throw error; }
    state.handle = handle; state.name = handle.name; state.baseline = text;
    toast('已保存到文件。');
  } catch (error) {
    if (error.name !== 'AbortError') toast(`保存失败：${error.message}`);
  } finally { state.busy = false; render(false); }
}
function formatContent() {
  if (state.view === 'record') {
    try { $('editor').value = JSON.stringify(JSON.parse($('editor').value), null, 2); state.draft = $('editor').value; }
    catch (error) { toast(`无法格式化：${error.message}`); return; }
  } else {
    const error = state.rows.find((row) => row.error);
    if (error) { toast(`第 ${error.line} 行无效，无法格式化。`); return; }
    applySource(textFromRows(state.rows.map((row) => ({ ...row, raw: JSON.stringify(row.value) }))), state.selected, true, true);
  }
  render(state.view === 'source');
}
function addRecord() {
  if (!finishDraft()) return;
  const eol = state.source.includes('\r\n') ? '\r\n' : '\n';
  const prefix = state.source && !/[\r\n]$/.test(state.source) ? eol : '';
  applySource(state.source + prefix + '{}' + eol, state.rows.length);
  state.view = 'record'; $('search').value = ''; $('errors-only').checked = false; state.typeFilter = '';
  state.page = Math.floor(state.selected / state.pageSize); render(); $('editor').focus();
}
async function deleteRecord() {
  if (state.selected < 0 || state.busy) return;
  const index = state.selected;
  if (!await confirmAction('删除这条记录？', `第 ${index + 1} 行将被删除。保存后才会写入原文件。`, '删除记录')) return;
  state.draft = null; applySource(textFromRows(state.rows.filter((_, i) => i !== index)), index); render();
}
async function deleteAfter() {
  if (state.busy || state.view !== 'record' || state.selected < 0 || state.selected >= state.rows.length - 1) return;
  const index = state.selected; const count = state.rows.length - index - 1;
  if (!await confirmAction('删除后续所有记录？', `保留第 ${index + 1} 行及之前的记录，删除原文件第 ${index + 2} 至 ${state.rows.length} 行，共 ${count} 条。此操作不受搜索、type 或错误筛选影响。保存后才会写入原文件。`, `删除 ${count} 条`)) return;
  if (!finishDraft()) return;
  applySource(textFromRows(state.rows.slice(0, index + 1)), index);
  render(); toast(`已删除后续 ${count} 条记录，保留第 ${index + 1} 行，尚未保存到文件。`);
}
function prefixDeletionStart() {
  return state.sync && state.rows[0]?.value?.type === 'session_meta' ? 1 : 0;
}
async function deleteBefore() {
  if (state.busy || state.view !== 'record') return;
  const index = state.selected, start = prefixDeletionStart(), count = index - start;
  if (count <= 0) return;
  const protectedHeader = start ? '首行 session_meta 会保留。删除任务上下文后，可能无法通过同步校验；校验失败不会写回。' : '';
  if (!await confirmAction('删除之前所有记录？',
    `保留第 ${index + 1} 行及之后的记录，删除原文件第 ${start + 1} 至 ${index} 行，共 ${count} 条。${protectedHeader}此操作不受搜索、type 或错误筛选影响。保存后才会写入原文件。`, `删除 ${count} 条`)) return;
  if (!finishDraft()) return;
  applySource(textFromRows([...state.rows.slice(0, start), ...state.rows.slice(index)]), start);
  state.page = 0; render();
  toast(`已删除之前 ${count} 条记录，保留当前记录及后续数据，尚未保存到文件。`);
}
async function deleteChecked() {
  if (!state.checked.size || state.busy) return;
  const targets = new Set(state.checked);
  if (!await confirmAction('批量删除勾选记录？', `将删除共 ${targets.size} 条已勾选记录（包括其他页或筛选中隐藏的勾选项）。保存后才会写入原文件。`, `删除 ${targets.size} 条`)) return;
  if (targets.has(state.selected)) state.draft = null;
  else if (!finishDraft()) return;
  const selected = state.rows.slice(0, state.selected).filter((_, i) => !targets.has(i)).length;
  applySource(textFromRows(state.rows.filter((_, i) => !targets.has(i))), selected);
  state.checked.clear(); render();
  toast(`已删除 ${targets.size} 条记录，尚未保存到文件。`);
}
function jumpToPage(event) {
  event.preventDefault(); flushSource();
  const pages = Math.ceil(filteredRows().length / state.pageSize);
  const page = Number($('page-number').value);
  if (!Number.isInteger(page) || page < 1 || page > pages) {
    toast(`请输入 1 到 ${pages} 之间的页码。`); return;
  }
  state.page = page - 1; renderList(); $('records').scrollTop = 0;
}
function history(direction) {
  if (state.busy) return;
  if (state.draft !== null) {
    if (direction === 'undo') { state.draft = null; render(); }
    return;
  }
  const from = state[direction], to = state[direction === 'undo' ? 'redo' : 'undo'];
  if (!from.length) return;
  to.push({ source: state.source, selected: state.selected });
  const snapshot = from.pop(); applySource(snapshot.source, snapshot.selected, false); render();
}
$('open').onclick = $('empty-open').onclick = openFile;
$('file-input').onchange = async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try { await readFile(file); } catch (error) { toast(`无法打开文件：${error.message}`); }
};
$('new').onclick = async () => {
  if (!await allowReplace()) return;
  await readFile(new File(['{}\n'], 'untitled.jsonl', { type: 'application/x-ndjson' }));
  state.baseline = ''; renderStatus();
};
$('save').onclick = () => saveFile();
$('save-as').onclick = () => saveFile(true);
$('add').onclick = addRecord; $('delete').onclick = deleteRecord; $('format').onclick = formatContent;
$('delete-after').onclick = deleteAfter;
$('delete-before').onclick = deleteBefore;
$('undo').onclick = () => history('undo'); $('redo').onclick = () => history('redo');
for (const view of ['record', 'source']) {
  $(view + '-tab').onclick = () => {
    if (state.busy || !finishDraft()) return; state.view = view; render();
  };
}
$('search').oninput = () => { state.page = 0; $('clear-search').hidden = !$('search').value; renderList(); };
$('clear-search').onclick = () => { $('search').value = ''; $('clear-search').hidden = true; state.page = 0; renderList(); };
$('errors-only').onchange = () => { state.page = 0; renderList(); };
$('type-filter').onchange = () => {
  const value = $('type-filter').value; flushSource();
  state.typeFilter = value; state.page = 0; renderList(); renderStatus(); $('records').scrollTop = 0;
};
$('prev').onclick = () => { state.page--; renderList(); };
$('next').onclick = () => { state.page++; renderList(); };
$('page-jump').onsubmit = jumpToPage;
$('select-page').onchange = () => {
  if (state.busy) return;
  const checked = $('select-page').checked;
  for (const { i } of filteredRows().slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
    if (checked) state.checked.add(i); else state.checked.delete(i);
  }
  renderList();
};
$('clear-checked').onclick = () => { if (state.busy) return; state.checked.clear(); renderList(); };
$('delete-checked').onclick = deleteChecked;
$('editor').oninput = () => {
  if (state.view === 'source') {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { applySource($('editor').value); renderList(); renderStatus(); }, 180);
  } else { state.draft = $('editor').value; renderStatus(); }
  updateGutter(); updateCursor();
};
// Flush raw edits synchronously before actions; debounced parsing never outruns a save.
function flushSource() {
  if (state.view === 'source' && state.opened) {
    clearTimeout(inputTimer); applySource($('editor').value);
  }
}
document.addEventListener('click', (event) => {
  if (event.target.closest('button') && !event.target.closest('dialog')) flushSource();
}, true);
$('editor').onscroll = () => { $('gutter').scrollTop = $('editor').scrollTop; };
$('editor').onkeyup = $('editor').onclick = updateCursor;
$('editor').onkeydown = (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const editor = $('editor'), start = editor.selectionStart, end = editor.selectionEnd;
    editor.setRangeText('  ', start, end, 'end'); editor.dispatchEvent(new Event('input'));
  }
};
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); flushSource(); saveFile(event.shiftKey);
  }
});
window.addEventListener('beforeunload', (event) => {
  flushSource(); if (dirty()) { event.preventDefault(); event.returnValue = ''; }
});
if (document.modelContext?.registerTool) {
  for (const tool of [{
    name: 'read_jsonl_status', description: 'Read the current local JSONL editor status without file contents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() { flushSource(); return { file: state.name, records: state.rows.length, errors: state.rows.filter((r) => r.error).length, unsaved: dirty() }; },
  }, {
    name: 'select_jsonl_record', description: 'Select an existing record for editing; does not save the file.',
    inputSchema: { type: 'object', properties: { line: { type: 'integer', minimum: 1 } }, required: ['line'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute(input) {
      flushSource();
      if (!Number.isInteger(input?.line) || input.line < 1 || input.line > state.rows.length) throw new Error('Invalid record line');
      if (!finishDraft()) throw new Error('Current record contains invalid JSON');
      state.selected = input.line - 1; state.view = 'record'; state.page = Math.floor(state.selected / state.pageSize); render();
      return { selectedLine: input.line };
    },
  }]) {
    try { Promise.resolve(document.modelContext.registerTool(tool)).catch(() => {}); } catch {}
  }
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Chat-Sync-Token': local.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function renderSyncInfo() {
  const info = state.sync?.info;
  const labels = { aligned: '偏移一致', ahead: '索引超出文件', behind: '索引待更新', missing: '尚无索引' };
  $('index-health').textContent = info ? labels[info.health] || info.health : '未关联 SQLite';
  $('index-health').className = 'health ' + (info?.health || '');
  $('index-offset').textContent = info ? `${(info.projection?.next_rollout_byte_offset ?? 0).toLocaleString()} / ${info.fileBytes.toLocaleString()} B` : '';
  $('filename').title = info?.path || state.name;
  $('sync-bar').title = info?.metadata.id || '';
  $('open-parent').hidden = !info?.historyBase?.thread_id;
  $('open-parent').disabled = state.busy;
  $('open-parent').title = `打开继承历史的父聊天：${info?.historyBase?.thread_id || ''}`;
  $('copy-backup').hidden = !state.sync?.backup;
  $('copy-backup').disabled = state.busy;
  $('copy-backup').title = state.sync?.backup || '复制最近一次备份路径';
}
function switchMode(mode) {
  if (mode === 'sqlite' && !state.sync) return;
  if (mode === 'ignored' && local.mode !== 'ignored') local.lastDataMode = local.mode;
  local.mode = mode;
  closeProjectMenu();
  $('prompt-hover').hidden = true;
  $('ignored-workspace').hidden = mode !== 'ignored';
  $('backup-workspace').hidden = mode !== 'backups';
  $('recovery-workspace').hidden = mode !== 'recovery';
  $('conversation-workspace').hidden = mode !== 'conversation';
  $('jsonl-workspace').hidden = mode !== 'jsonl';
  $('sqlite-workspace').hidden = mode !== 'sqlite';
  $('jsonl-mode').setAttribute('aria-selected', String(mode === 'jsonl'));
  $('sqlite-mode').setAttribute('aria-selected', String(mode === 'sqlite'));
  $('conversation-mode').setAttribute('aria-selected', String(mode === 'conversation'));
  $('recovery-mode').setAttribute('aria-selected', String(mode === 'recovery'));
  if (mode === 'conversation') renderConversation();
  if (mode === 'ignored') renderIgnoredProjects();
  if (mode === 'backups') loadBackups();
  if (mode === 'recovery') renderRecoveryPlan();
  $('show-ignored-projects').setAttribute('aria-current', String(mode === 'ignored'));
}
function messageButton(icon, label, action, className = '') {
  const button = document.createElement('button'); button.className = 'icon-button ' + className;
  button.title = label; button.setAttribute('aria-label', label);
  const graphic = document.createElement('i'); graphic.dataset.lucide = icon; button.append(graphic);
  button.onclick = action; return button;
}
async function backupCurrentSession() {
  if (!state.sync || state.busy) return;
  if (!await confirmAction('备份当前会话？', '备份磁盘上的 JSONL、关联数据库和继承记录。未保存的编辑不在这次备份内；不会修改会话。', '创建备份')) return;
  state.busy = true; renderStatus();
  try {
    const result = await api('/api/backup', { id: state.sync.id });
    state.sync.backup = result.backupPath;
    toast('备份已完成。');
    if (local.mode === 'backups') await loadBackups();
  } catch (error) { toast(`备份失败：${error.message}`); }
  finally { state.busy = false; renderStatus(); }
}
async function loadBackups() {
  const request = ++local.backupRequest;
  const parameters = new URLSearchParams();
  if ($('backup-current-only').checked && state.sync) parameters.set('id', state.sync.id);
  try {
    const data = await api('/api/backups?' + parameters);
    if (request !== local.backupRequest) return;
    const fragment = document.createDocumentFragment();
    for (const backup of data.rows) {
      const row = document.createElement('div'); row.className = 'backup-row';
      const details = document.createElement('div'); details.className = 'backup-details';
      const title = document.createElement('strong'); title.textContent = backup.title || backup.threadId;
      const meta = document.createElement('span');
      const date = backup.createdAt && Number.isFinite(Date.parse(backup.createdAt)) ?
        new Date(backup.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : backup.backupId;
      meta.textContent = `${date} · ${(backup.fileBytes / 1024).toFixed(1)} KiB · ${backup.kind} · ${backup.status}`;
      details.append(title, meta);
      const location = messageButton('copy', '复制备份路径', async () => {
        try { await navigator.clipboard.writeText(backup.backupPath); toast('备份路径已复制。'); } catch { toast('无法访问剪贴板。'); }
      });
      const restore = messageButton('rotate-ccw', `恢复备份 ${backup.backupId}`, () => restoreBackup(backup));
      restore.dataset.backupId = backup.backupId; restore.dataset.unavailable = String(!backup.restorable);
      restore.disabled = state.busy || !backup.restorable;
      row.append(details, location, restore); fragment.append(row);
    }
    if (!data.rows.length) { const empty = document.createElement('div'); empty.className = 'list-empty'; empty.textContent = '暂无备份'; fragment.append(empty); }
    $('backup-list').replaceChildren(fragment); icons();
  } catch (error) { toast(`读取备份失败：${error.message}`); }
}
async function restoreBackup(backup) {
  if (state.busy) return;
  if (!state.sync || state.sync.id !== backup.threadId) {
    await openChat(backup.threadId);
    if (state.sync?.id !== backup.threadId) return;
  }
  if (dirty()) { toast('当前有未保存编辑，请先保存或重新读取后再恢复。'); return; }
  if (!await confirmAction('恢复这条会话的历史？', '恢复备份的 JSONL 并重建该会话索引。恢复前会再次备份当前状态，不恢复其他会话。停止并关闭 Codex 中的目标会话后再操作。', '恢复备份')) return;
  state.busy = true; renderStatus();
  try {
    const result = await api('/api/restore', { id: state.sync.id, version: state.sync.version, backupId: backup.backupId });
    state.sync.version = result.version; state.sync.info = result.info; state.sync.inherited = result.inherited || [];
    state.sync.backup = result.backup;
    applySource(result.source, state.selected, false); state.baseline = result.source; state.draft = null;
    transcript.source = null; local.recoveryPlan = null; local.recoveryDraft = null;
    render(); toast('此会话已恢复，恢复前状态也已备份。'); await loadBackups();
  } catch (error) { toast(`恢复失败：${error.message}`); }
  finally { state.busy = false; renderStatus(); }
}
function renderRecoveryPlan() {
  const plan = local.recoveryPlan;
  $('recovery-stats').textContent = plan ?
    `完整轮次 ${plan.completeTurns} · 保留 ${plan.selectedTurns} · 工具 ${plan.selectedToolCalls} 次 · 所选原始数据 ${(plan.selectedRawBytes / 1024).toFixed(1)} KiB` : '';
  const fragment = document.createDocumentFragment();
  for (const turn of plan?.turns || []) {
    const row = document.createElement('div'); row.className = 'recovery-turn' + (turn.selected ? ' selected' : '');
    const prompt = document.createElement('strong'); prompt.textContent = turn.prompt || '无用户文本';
    const meta = document.createElement('span'); meta.textContent = `${turn.status === 'completed' ? '完整' : '未完成'} · ${turn.records} 条记录 · ${turn.messages} 条消息 · ${turn.toolCalls} 次工具 · ${(turn.bytes / 1024).toFixed(1)} KiB`;
    row.append(prompt, meta); fragment.append(row);
  }
  $('recovery-turn-list').replaceChildren(fragment);
  $('recovery-handoff').value = local.recoveryDraft ?? plan?.handoff ?? '';
  const conversation = $('recovery-copy-mode').value === 'conversation';
  $('recovery-handoff').hidden = conversation;
  $('recovery-conversation').hidden = !conversation;
  $('recovery-preview-label').textContent = conversation ? '所选对话' : '续聊文本';
  $('handoff-bytes').textContent = conversation ? `${(plan?.selectedRawBytes || 0).toLocaleString()} B` :
    `${new Blob([$('recovery-handoff').value]).size.toLocaleString()} B / 65,536 B`;
  const messages = document.createDocumentFragment();
  for (const item of plan?.conversation || []) {
    const entry = document.createElement(item.role === 'tool' ? 'details' : 'article');
    entry.className = 'recovery-message ' + item.role;
    const heading = document.createElement(item.role === 'tool' ? 'summary' : 'strong');
    heading.textContent = item.role === 'tool' ? item.name : item.role === 'user' ? '用户' : '助手';
    const body = document.createElement(item.role === 'tool' ? 'pre' : 'div');
    if (item.role === 'tool') body.textContent = item.text + (item.output ? '\n\n' + item.output : '');
    else { body.className = 'message-markdown'; body.innerHTML = window.ChatTranscript.markdown(item.text, window.marked); }
    entry.append(heading, body); messages.append(entry);
  }
  $('recovery-conversation').replaceChildren(messages);
  $('create-recovery-copy').disabled = state.busy || !plan?.selectedTurns;
  $('export-handoff').disabled = state.busy || !plan;
}
async function previewRecovery() {
  if (!state.sync || state.busy) return;
  if (dirty()) { toast('请先保存当前会话编辑，再生成恢复预览。'); return; }
  if (local.recoveryPlan && local.recoveryDraft !== null && local.recoveryDraft !== local.recoveryPlan.handoff &&
      !await confirmAction('重新生成续聊文本？', '将替换当前编辑的续聊文本。', '重新生成')) return;
  state.busy = true; renderStatus();
  try {
    const result = await api('/api/recovery/preview', { id: state.sync.id, version: state.sync.version, keep: Number($('recovery-keep').value) });
    local.recoveryPlan = result; local.recoveryDraft = result.handoff; renderRecoveryPlan();
    if (!result.selectedTurns) toast('没有可选的完整轮次，可以导出模板手工整理。');
  } catch (error) { toast(`恢复预览失败：${error.message}`); }
  finally { state.busy = false; renderStatus(); }
}
async function createRecoveryCopy() {
  if (!local.recoveryPlan || state.busy || !state.sync) return;
  if (dirty()) { toast('请先保存当前会话编辑。'); return; }
  if (Number($('recovery-keep').value) !== local.recoveryPlan.keep) { toast('轮次选择已变更，请重新生成预览。'); return; }
  const mode = $('recovery-copy-mode').value;
  const description = mode === 'conversation' ?
    `保留 ${local.recoveryPlan.selectedTurns} 个完整轮次、${local.recoveryPlan.selectedToolCalls} 次工具调用及返回值，保持用户和助手角色。移除旧的压缩检查点，不继承更早历史。` :
    '创建仅含当前续聊文本的一条用户消息，工具和推理记录不会复制。';
  if (!await confirmAction('备份并创建独立副本？',
    description + ' 原会话不会裁剪，创建前自动备份。未验证模型续聊。', '备份并创建')) return;
  state.busy = true; renderStatus();
  let created = null;
  try {
    created = await api('/api/recovery/create', { id: state.sync.id, version: local.recoveryPlan.version,
      keep: Number($('recovery-keep').value), handoff: $('recovery-handoff').value, mode });
    state.sync.backup = created.backupPath;
    toast('独立副本已创建，原会话已备份且未裁剪。');
  } catch (error) { toast(`创建恢复副本失败：${error.message}`); }
  finally { state.busy = false; renderStatus(); }
  if (created) { await refreshChats(); await openChat(created.threadId); }
}
function exportHandoff() {
  const text = $('recovery-handoff').value;
  if (!text) return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'codex-handoff.md'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function currentTranscriptMessage(message) {
  if (state.busy || !finishDraft()) return null;
  renderConversation();
  return transcript.messages.find((item) => item.key === message.key ||
    (message.recordId && item.recordId === message.recordId && item.sourceThreadId === message.sourceThreadId)) || null;
}
async function startMessageEdit(message) {
  let current = currentTranscriptMessage(message);
  if (!current) return;
  if (current.inherited && current.sourceThreadId !== state.sync?.id) {
    if (!await confirmAction('编辑父会话中的消息？',
      '此消息来自父会话。修改可能影响继承此段历史的分支，且不会自动修改分支的继承边界。继续打开父会话编辑？', '打开父会话')) return;
    const id = current.recordId, key = current.key, owner = current.sourceThreadId;
    await openChat(owner);
    if (state.sync?.id !== owner) return;
    current = transcript.messages.find((item) => item.sourceThreadId === owner && (id ? item.recordId === id : item.key === key));
    if (!current) { toast('父会话中的消息已发生变化。'); return; }
  }
  try {
    const value = window.ChatTranscript.editableText(state.rows, current);
    const plan = window.ChatTranscript.editMessage(state.rows, current, value, $('mirror-messages').checked);
    transcript.edit = { message: current, originalValue: value, value, relatedCount: plan.relatedCount, source: state.source };
    transcript.source = null; renderConversation(); renderStatus();
    const editor = $('message-log').querySelector('.message-textarea');
    editor?.focus({ preventScroll: true });
  } catch (error) { toast(`无法编辑消息：${error.message}`); }
}
function applyMessageEdit() {
  const edit = transcript.edit;
  if (!edit) return true;
  try {
    if (state.source !== edit.source) throw new Error('原始草稿在编辑期间发生变化，请取消后重新编辑。');
    const plan = window.ChatTranscript.editMessage(state.rows, edit.message, edit.value, $('mirror-messages').checked);
    const rows = state.rows.map((row, index) => plan.updates.has(index) ?
      { ...row, raw: JSON.stringify(plan.updates.get(index)) } : row);
    transcript.edit = null;
    applySource(textFromRows(rows), state.selected);
    transcript.source = null;
    render();
    return true;
  } catch (error) { toast(`消息修改未应用：${error.message}`); return false; }
}
function cancelMessageEdit() {
  transcript.edit = null; transcript.source = null; render();
}
async function locateMessageSource(message) {
  let current = currentTranscriptMessage(message);
  if (!current) { if (!state.busy) toast('该消息已不在当前草稿中。'); return; }
  if (current.sourceThreadId && current.sourceThreadId !== state.sync?.id) {
    const parentId = current.sourceThreadId, recordId = current.recordId, key = current.key;
    await openChat(parentId);
    if (state.sync?.id !== parentId) return;
    current = transcript.messages.find((item) => item.sourceThreadId === parentId &&
      (recordId ? item.recordId === recordId : item.key === key));
    if (!current) { toast('父会话中的对应消息已发生变化。'); return; }
  }
  state.selected = current.rowIndex; state.view = 'record';
  $('search').value = ''; $('clear-search').hidden = true; $('errors-only').checked = false; state.typeFilter = '';
  state.page = Math.floor(current.rowIndex / state.pageSize);
  switchMode('jsonl'); render();
  $('records').querySelector('.record-item.selected')?.scrollIntoView({ block: 'nearest' });
  $('editor').focus({ preventScroll: true });
}
function activatePrompt(key) {
  transcript.active = key;
  $('prompt-list').querySelectorAll('.prompt-entry').forEach((node) => node.classList.toggle('selected', node.dataset.messageKey === key));
  $('prompt-rail').querySelectorAll('.rail-dot').forEach((node) => {
    const selected = node.dataset.messageKey === key;
    node.classList.toggle('selected', selected); node.setAttribute('aria-current', String(selected));
  });
}
function jumpToMessage(message) {
  const current = currentTranscriptMessage(message);
  if (!current) return;
  switchMode('conversation'); $('prompt-hover').hidden = true;
  if (innerWidth < 850) $('prompt-nav').classList.add('collapsed');
  const article = Array.from($('message-log').children).find((node) => node.dataset.messageKey === current.key);
  article?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activatePrompt(current.key);
}
function renderPromptNavigation() {
  const query = $('prompt-search').value.toLowerCase().trim();
  const visible = transcript.prompts.filter((message) => !query || message.text.toLowerCase().includes(query));
  $('prompt-count').textContent = query ? `${visible.length}/${transcript.prompts.length}` : transcript.prompts.length;
  const fragment = document.createDocumentFragment();
  for (const message of visible) {
    const entry = document.createElement('div'); entry.className = 'prompt-entry';
    entry.dataset.messageKey = message.key;
    const jump = document.createElement('button'); jump.className = 'prompt-jump'; jump.title = message.text.slice(0, 600);
    const snippet = document.createElement('span'); snippet.className = 'prompt-snippet'; snippet.textContent = message.text;
    const location = document.createElement('small'); location.textContent = `第 ${message.promptNumber} 条发言 · ${message.inherited ? '继承 ' : ''}#${message.rowIndex + 1}`;
    jump.append(snippet, location); jump.onclick = () => jumpToMessage(message);
    const source = messageButton('file-code-2', `定位第 ${message.promptNumber} 条发言的原始数据`, () => locateMessageSource(message), 'prompt-source');
    entry.append(jump, source); fragment.append(entry);
  }
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'list-empty'; empty.textContent = query ? '没有匹配的发言' : '暂无发言'; fragment.append(empty); }
  $('prompt-list').replaceChildren(fragment); activatePrompt(transcript.active); icons();
}
let promptHoverTimer;
function hidePromptHoverSoon() {
  clearTimeout(promptHoverTimer); promptHoverTimer = setTimeout(() => $('prompt-hover').hidden = true, 180);
}
function previewPrompt(message, anchor) {
  clearTimeout(promptHoverTimer); transcript.hover = message;
  $('prompt-hover-meta').textContent = `第 ${message.promptNumber} 条发言 · ${message.inherited ? '父会话' : '原始数据'} #${message.rowIndex + 1}`;
  $('prompt-hover-text').textContent = message.text.slice(0, 180);
  const following = transcript.messages.slice(transcript.messages.indexOf(message) + 1);
  const reply = following[0]?.role === 'assistant' ? following[0] : null;
  $('prompt-hover-reply').textContent = reply?.text.slice(0, 240) || '';
  $('prompt-hover-reply').hidden = !reply;
  const box = anchor.getBoundingClientRect();
  $('prompt-hover').style.left = Math.max(8, box.left - 300) + 'px';
  $('prompt-hover').hidden = false;
  const height = $('prompt-hover').getBoundingClientRect().height;
  $('prompt-hover').style.top = Math.min(Math.max(8, box.top - 30), Math.max(8, innerHeight - height - 8)) + 'px';
}
function renderConversation() {
  $('conversation-title').textContent = state.sync?.info?.metadata?.name || (state.opened ? state.name : '对话');
  if (transcript.source === state.source && transcript.inheritedRef === state.sync?.inherited) return;
  transcript.source = state.source; transcript.observer?.disconnect();
  transcript.inheritedRef = state.sync?.inherited;
  const sources = (state.sync?.inherited || []).map((source) => {
    source.rows ||= splitSource(source.source);
    return { id: source.id, rows: source.rows, inherited: true };
  });
  sources.push({ id: state.sync?.id || '', rows: state.rows, inherited: false });
  transcript.messages = sources.flatMap((source) => window.ChatTranscript.readMessages(source.rows).map((message) => ({
    ...message, key: source.id + '|' + message.key, sourceThreadId: source.id, inherited: source.inherited,
  })));
  transcript.prompts = transcript.messages.filter((message) => message.role === 'user');
  transcript.prompts.forEach((message, index) => message.promptNumber = index + 1);
  $('conversation-count').textContent = `${transcript.prompts.length} 条发言 · ${transcript.messages.length - transcript.prompts.length} 条回复`;
  $('conversation-empty').hidden = !!transcript.messages.length;
  $('conversation-empty').textContent = state.opened ? '暂无本地对话消息' : '选择一条聊天';
  const fragment = document.createDocumentFragment(), scroll = $('conversation-scroll').scrollTop;
  for (let index = 0; index < transcript.messages.length; index++) {
    const message = transcript.messages[index];
    const article = document.createElement('article'); article.className = 'conversation-message ' + message.role;
    article.dataset.messageKey = message.key; article.dataset.sourceLine = message.rowIndex + 1;
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const role = document.createElement('span'); role.textContent = message.role === 'user' ? '你' : '助手';
    meta.append(role);
    if (message.inherited) { const inherited = document.createElement('span'); inherited.className = 'message-phase'; inherited.textContent = '继承'; meta.append(inherited); }
    if (message.phase === 'commentary') { const phase = document.createElement('span'); phase.className = 'message-phase'; phase.textContent = '过程'; meta.append(phase); }
    if (message.timestamp && Number.isFinite(Date.parse(message.timestamp))) {
      const time = document.createElement('time'); time.dateTime = message.timestamp;
      time.textContent = new Date(message.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
      meta.append(time);
    }
    const actions = document.createElement('div'); actions.className = 'message-actions';
    actions.append(messageButton('copy', `复制第 ${index + 1} 条消息`, async () => {
      try { await navigator.clipboard.writeText(message.text); toast('消息已复制。'); } catch { toast('无法访问剪贴板。'); }
    }), messageButton('pencil', `编辑第 ${index + 1} 条消息`, () => startMessageEdit(message)),
    messageButton('file-code-2', `查看第 ${index + 1} 条消息的原始数据`, () => locateMessageSource(message)));
    meta.append(actions);
    if (transcript.edit?.message.key === message.key) {
      article.classList.add('is-editing'); article.append(meta);
      const editor = document.createElement('textarea'); editor.className = 'message-textarea';
      editor.setAttribute('aria-label', '编辑消息文本'); editor.spellcheck = false; editor.wrap = 'soft';
      editor.value = transcript.edit.value;
      editor.oninput = () => { if (transcript.edit) { transcript.edit.value = editor.value; renderStatus(); } };
      const controls = document.createElement('div'); controls.className = 'message-edit-controls';
      const count = document.createElement('span'); count.textContent = `${transcript.edit.relatedCount} 条关联记录`;
      const cancel = document.createElement('button'); cancel.className = 'button'; cancel.textContent = '取消';
      cancel.onclick = cancelMessageEdit;
      const save = document.createElement('button'); save.className = 'button primary';
      const icon = document.createElement('i'); icon.dataset.lucide = 'save';
      const label = document.createElement('span'); label.textContent = '保存修改'; save.append(icon, label);
      save.onclick = async () => { if (!state.busy && applyMessageEdit()) await saveFile(); };
      controls.append(count, cancel, save); article.append(editor, controls); fragment.append(article);
      continue;
    }
    const content = document.createElement('div'); content.className = 'message-markdown';
    const limit = message.role === 'user' ? 900 : 1600;
    const updateContent = () => {
      const text = message.text.length > limit && !transcript.expanded.has(message.key) ? message.text.slice(0, limit) + '\n\n…' : message.text;
      content.innerHTML = window.ChatTranscript.markdown(text, window.marked);
    };
    updateContent(); article.append(meta, content);
    if (message.text.length > limit) {
      const expand = document.createElement('button'); expand.className = 'message-expand';
      const label = () => expand.textContent = transcript.expanded.has(message.key) ? '收起' : '展开全文';
      label(); expand.onclick = () => {
        if (transcript.expanded.has(message.key)) transcript.expanded.delete(message.key); else transcript.expanded.add(message.key);
        updateContent(); label();
      };
      article.append(expand);
    }
    fragment.append(article);
  }
  $('message-log').replaceChildren(fragment); $('conversation-scroll').scrollTop = scroll;
  const rail = document.createDocumentFragment();
  for (const message of transcript.prompts) {
    const dot = document.createElement('button'); dot.className = 'rail-dot'; dot.dataset.messageKey = message.key;
    dot.setAttribute('aria-label', `跳转到第 ${message.promptNumber} 条发言`);
    dot.onmouseenter = dot.onfocus = () => previewPrompt(message, dot);
    dot.onmouseleave = dot.onblur = hidePromptHoverSoon;
    dot.onclick = () => jumpToMessage(message); rail.append(dot);
  }
  $('prompt-rail').replaceChildren(rail); renderPromptNavigation(); icons();
  transcript.observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible.length) activatePrompt(visible[0].target.dataset.messageKey);
  }, { root: $('conversation-scroll'), threshold: 0.1 });
  $('message-log').querySelectorAll('.conversation-message.user').forEach((node) => transcript.observer.observe(node));
}
async function refreshChats() {
  const request = ++local.chatRequest;
  try {
    const parameters = { q: $('chat-search').value };
    if (local.searchScope) parameters.project = local.searchScope.key;
    const data = await api('/api/sidebar?' + new URLSearchParams(parameters));
    if (request !== local.chatRequest) return;
    const query = $('chat-search').value.trim();
    if (query !== local.sidebarQuery) { local.searchCollapsed.clear(); local.projectLimits.clear(); }
    local.sidebarQuery = query;
    $('chat-total').textContent = data.groups.length;
    $('chat-total').title = `${data.total} 条对话`;
    local.groups = data.groups;
    if (!local.groupsInitialized) {
      try {
        const savedOrder = JSON.parse(localStorage.getItem('chat-sync-project-order'));
        if (Array.isArray(savedOrder)) local.projectOrder = [...new Set(savedOrder.filter((key) => typeof key === 'string'))];
      } catch {}
      try {
        const saved = JSON.parse(localStorage.getItem('chat-sync-ignored-projects'));
        if (Array.isArray(saved)) for (const project of saved) {
          if (typeof project?.key === 'string' && typeof project.name === 'string') local.ignoredProjects.set(project.key, project);
        }
      } catch {}
      local.expanded.clear();
      local.groupsInitialized = true;
    }
    renderChatTree();
  } catch (error) { toast(`读取聊天失败：${error.message}`); }
}
function setAllProjectsExpanded(expanded) {
  if (state.busy) return;
  if ($('chat-search').value.trim()) {
    local.searchCollapsed = new Set(expanded ? [] : visibleProjectGroups().map((group) => group.key));
  } else {
    local.expanded = new Set(expanded ? visibleProjectGroups().map((group) => group.key) : []);
  }
  if (!expanded) local.projectLimits.clear();
  renderChatTree();
}
async function showMoreProject(group) {
  if (state.busy || local.loadingProjects.has(group.key)) return;
  const query = $('chat-search').value.trim();
  const shown = Math.min(local.projectLimits.get(group.key) || 5, group.threads.length);
  if (shown < group.threads.length) {
    const expanded = query ? !local.searchCollapsed.has(group.key) : local.expanded.has(group.key);
    if (expanded) local.projectLimits.set(group.key, Math.min(shown + 5, group.threads.length));
    renderChatTree(); return;
  }
  const revision = local.chatRequest, token = Symbol();
  local.loadingProjects.set(group.key, token); renderChatTree();
  try {
    const data = await api('/api/sidebar/group?' + new URLSearchParams({
      key: group.key, q: query, offset: group.nextOffset ?? group.threads.length, limit: 5,
    }));
    if (revision !== local.chatRequest || query !== $('chat-search').value.trim() || !local.groups.includes(group)) return;
    const byId = new Map(group.threads.map((row) => [row.id, row]));
    for (const row of data.rows) byId.set(row.id, row);
    group.threads = [...byId.values()]; group.total = data.total; group.nextOffset = data.nextOffset;
    const expanded = query ? !local.searchCollapsed.has(group.key) : local.expanded.has(group.key);
    if (expanded) local.projectLimits.set(group.key, Math.min(shown + 5, group.threads.length));
  } catch (error) {
    if (revision === local.chatRequest && query === $('chat-search').value.trim()) toast(`加载更多对话失败：${error.message}`);
  }
  finally {
    if (local.loadingProjects.get(group.key) === token) local.loadingProjects.delete(group.key);
    renderChatTree();
  }
}
function orderedProjectGroups() {
  const rank = new Map(local.projectOrder.map((key, index) => [key, index]));
  return local.groups.slice().sort((a, b) =>
    (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}
function visibleProjectGroups() {
  return orderedProjectGroups().filter((group) => !local.ignoredProjects.has(group.key) &&
    (!local.searchScope || local.searchScope.key === group.key));
}
function persistIgnoredProjects() {
  try { localStorage.setItem('chat-sync-ignored-projects', JSON.stringify([...local.ignoredProjects.values()])); }
  catch { toast('忽略状态已调整，但浏览器无法保存设置。'); }
}
function setProjectExpanded(group, expanded) {
  if (state.busy) return;
  if ($('chat-search').value.trim()) {
    if (expanded) local.searchCollapsed.delete(group.key); else local.searchCollapsed.add(group.key);
  } else {
    if (expanded) local.expanded.add(group.key); else local.expanded.delete(group.key);
  }
  if (!expanded) local.projectLimits.delete(group.key);
  renderChatTree();
}
function closeProjectMenu(focus = false) {
  $('project-context-menu').hidden = true;
  if (focus && local.menuAnchor?.isConnected) local.menuAnchor.focus({ preventScroll: true });
  local.menuProject = null;
}
function openProjectMenu(event, group, anchor) {
  event.preventDefault(); event.stopPropagation();
  if (state.busy) return;
  endProjectDrag();
  local.menuProject = { key: group.key, name: group.name }; local.menuAnchor = anchor;
  const menu = $('project-context-menu'); menu.hidden = false;
  const rect = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
  const x = event.clientX || rect.left + 12, y = event.clientY || rect.bottom;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - size.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - size.height - 8)) + 'px';
  menu.querySelector('button').focus({ preventScroll: true });
}
function ignoreProject(project) {
  if (state.busy) return;
  local.ignoredProjects.set(project.key, { key: project.key, name: project.name });
  local.expanded.delete(project.key); local.projectLimits.delete(project.key);
  persistIgnoredProjects(); closeProjectMenu(); renderChatTree(); switchMode('ignored');
  if (local.searchScope?.key === project.key) clearProjectSearch();
}
function restoreProject(key) {
  if (state.busy) return;
  local.ignoredProjects.delete(key); persistIgnoredProjects(); renderIgnoredProjects(); renderChatTree();
}
function renderIgnoredProjects() {
  const query = $('ignored-search').value.trim().toLowerCase();
  const entries = [...local.ignoredProjects.values()].filter((project) => !query || project.name.toLowerCase().includes(query));
  $('ignored-project-count').textContent = local.ignoredProjects.size;
  $('ignored-total').textContent = `${local.ignoredProjects.size} 个项目`;
  $('restore-all-projects').disabled = state.busy || !local.ignoredProjects.size;
  const fragment = document.createDocumentFragment();
  for (const project of entries) {
    const row = document.createElement('div'); row.className = 'ignored-project-row'; row.dataset.project = project.key;
    const icon = document.createElement('i'); icon.dataset.lucide = 'folder';
    const name = document.createElement('span'); name.textContent = project.name;
    const restore = messageButton('rotate-ccw', `恢复项目 ${project.name}`, () => restoreProject(project.key));
    restore.disabled = state.busy; row.append(icon, name, restore); fragment.append(row);
  }
  if (!entries.length) { const empty = document.createElement('div'); empty.className = 'list-empty'; empty.textContent = query ? '没有匹配的项目' : '暂无已忽略项目'; fragment.append(empty); }
  $('ignored-project-list').replaceChildren(fragment); icons();
}
function searchInProject(project) {
  if (state.busy) return;
  local.searchScope = { key: project.key, name: project.name };
  local.expanded.add(project.key); $('chat-search').value = ''; closeProjectMenu();
  $('project-search-scope').hidden = false; $('project-search-name').textContent = project.name;
  $('chat-search').placeholder = '搜索此项目的对话标题、ID...';
  refreshChats(); $('chat-search').focus();
}
function clearProjectSearch() {
  if (state.busy) return;
  local.searchScope = null; $('project-search-scope').hidden = true;
  $('chat-search').placeholder = '标题、ID、项目...'; $('chat-search').value = ''; refreshChats();
}
function reorderProject(source, target, before) {
  if (state.busy || $('chat-search').value.trim() || local.searchScope || source === target) return false;
  const order = orderedProjectGroups().map((group) => group.key);
  if (!order.includes(source) || !order.includes(target)) return false;
  const updated = order.filter((key) => key !== source);
  updated.splice(updated.indexOf(target) + (before ? 0 : 1), 0, source);
  if (updated.every((key, index) => key === order[index])) return false;
  const missing = local.projectOrder.filter((key) => !updated.includes(key));
  local.projectOrder = [...updated, ...missing];
  try {
    localStorage.setItem('chat-sync-project-order', JSON.stringify(local.projectOrder));
    toast('分组顺序已保存。');
  } catch { toast('顺序已调整，但浏览器无法保存排序设置。'); }
  renderChatTree();
  return true;
}
function clearProjectDropMarks() {
  $('chat-list').querySelectorAll('.drop-before, .drop-after').forEach((node) =>
    node.classList.remove('drop-before', 'drop-after'));
}
function updateProjectDrop(drag) {
  clearProjectDropMarks(); drag.target = null;
  const section = document.elementFromPoint(drag.x, drag.y)?.closest('.project-group');
  if (!section || !$('chat-list').contains(section) || section.dataset.project === drag.key) return;
  const rect = section.querySelector('.project-heading').getBoundingClientRect();
  drag.target = section.dataset.project; drag.before = drag.y < rect.top + rect.height / 2;
  section.classList.add(drag.before ? 'drop-before' : 'drop-after');
}
function endProjectDrag(commit = false) {
  const drag = local.projectDrag;
  if (!drag) return;
  local.projectDrag = null; cancelAnimationFrame(drag.frame);
  clearProjectDropMarks();
  drag.section.classList.remove('dragging'); document.body.classList.remove('sorting-projects');
  if (drag.grip.hasPointerCapture(drag.pointerId)) drag.grip.releasePointerCapture(drag.pointerId);
  if (commit && drag.active && drag.target) reorderProject(drag.key, drag.target, drag.before);
}
function startProjectDrag(event, group, section, grip) {
  if (event.button !== 0 || event.isPrimary === false || state.busy || $('chat-search').value.trim() || local.searchScope || visibleProjectGroups().length < 2) return;
  event.preventDefault(); endProjectDrag(); grip.focus({ preventScroll: true });
  local.projectDrag = { key: group.key, section, grip, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
    active: false, target: null, before: false, frame: null };
  grip.setPointerCapture(event.pointerId);
}
function scrollProjectDrag() {
  const drag = local.projectDrag;
  if (!drag?.active) return;
  const list = $('chat-list'), rect = list.getBoundingClientRect();
  if (drag.x >= rect.left && drag.x <= rect.right) {
    if (drag.y < rect.top + 28) list.scrollTop -= 10;
    else if (drag.y > rect.bottom - 28) list.scrollTop += 10;
  }
  updateProjectDrop(drag); drag.frame = requestAnimationFrame(scrollProjectDrag);
}
function moveProjectDrag(event) {
  const drag = local.projectDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (state.busy) { endProjectDrag(); return; }
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
    drag.active = true; drag.section.classList.add('dragging'); document.body.classList.add('sorting-projects');
    drag.frame = requestAnimationFrame(scrollProjectDrag);
  }
  if (drag.active) { event.preventDefault(); updateProjectDrop(drag); }
}
function renderChatTree() {
  endProjectDrag();
  closeProjectMenu();
  const visible = visibleProjectGroups();
  $('expand-all-projects').disabled = $('collapse-all-projects').disabled = state.busy || !visible.length;
  $('chat-total').textContent = visible.length;
  $('chat-total').title = `${visible.reduce((sum, group) => sum + (group.total ?? group.threads.length), 0)} 条对话`;
  $('ignored-project-count').textContent = local.ignoredProjects.size;
  const fragment = document.createDocumentFragment();
  const searching = !!$('chat-search').value.trim();
  for (const group of visible) {
    const section = document.createElement('section'); section.className = 'project-group'; section.dataset.project = group.key;
    const heading = document.createElement('div'); heading.className = 'project-heading';
    const header = document.createElement('button'); header.className = 'project-toggle';
    const expanded = searching ? !local.searchCollapsed.has(group.key) : local.expanded.has(group.key);
    header.setAttribute('aria-expanded', String(expanded)); header.title = group.name;
    const chevron = document.createElement('i'); chevron.dataset.lucide = expanded ? 'chevron-down' : 'chevron-right';
    const folder = document.createElement('i'); folder.dataset.lucide = group.key === 'archived' ? 'archive' : 'folder';
    const name = document.createElement('span'); name.textContent = group.name;
    header.append(chevron, folder, name);
    header.onclick = () => {
      setProjectExpanded(group, !expanded);
    };
    heading.oncontextmenu = (event) => openProjectMenu(event, group, header);
    heading.onkeydown = (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openProjectMenu(event, group, header);
    };
    const menuButton = messageButton('ellipsis', `项目 ${group.name} 的菜单`,
      (event) => openProjectMenu(event, group, header), 'project-menu-trigger');
    const grip = document.createElement('button'); grip.className = 'icon-button project-grip';
    grip.title = searching ? '搜索时不能调整分组顺序' : '拖动调整分组顺序';
    grip.setAttribute('aria-label', `调整 ${group.name} 的分组位置`);
    grip.disabled = state.busy || searching || !!local.searchScope || visible.length < 2;
    const gripIcon = document.createElement('i'); gripIcon.dataset.lucide = 'grip-vertical'; grip.append(gripIcon);
    grip.onpointerdown = (event) => startProjectDrag(event, group, section, grip);
    grip.onpointermove = moveProjectDrag;
    grip.onpointerup = (event) => { if (local.projectDrag?.pointerId === event.pointerId) endProjectDrag(true); };
    grip.onpointercancel = grip.onlostpointercapture = (event) => {
      if (local.projectDrag?.pointerId === event.pointerId) endProjectDrag();
    };
    grip.onkeydown = (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || grip.disabled) return;
      event.preventDefault();
      const keys = visibleProjectGroups().map((item) => item.key), index = keys.indexOf(group.key);
      const target = keys[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target && reorderProject(group.key, target, event.key === 'ArrowUp')) {
        Array.from($('chat-list').querySelectorAll('.project-group'))
          .find((node) => node.dataset.project === group.key)?.querySelector('.project-grip').focus();
      }
    };
    heading.append(header, menuButton, grip);
    const children = document.createElement('div'); children.className = 'project-chats'; children.hidden = !expanded;
    const shown = Math.min(local.projectLimits.get(group.key) || 5, group.threads.length);
    if (expanded) for (const row of group.threads.slice(0, shown)) {
      const button = document.createElement('button');
      button.className = 'chat-item' + (row.id === state.sync?.id ? ' selected' : '');
      button.dataset.threadId = row.id; button.textContent = row.title; button.title = row.title;
      button.onclick = () => openChat(row.id); children.append(button);
    }
    if (expanded && (group.total ?? group.threads.length) > shown) {
      const loading = local.loadingProjects.has(group.key);
      const more = document.createElement('button'); more.className = 'project-more';
      more.dataset.loading = String(loading); more.disabled = state.busy || loading;
      more.title = '再显示 5 条对话';
      const icon = document.createElement('i'); icon.dataset.lucide = loading ? 'loader-circle' : 'chevron-down';
      const label = document.createElement('span'); label.textContent = loading ? '加载中...' : '显示更多';
      const remaining = document.createElement('small'); remaining.textContent = `剩余 ${(group.total ?? group.threads.length) - shown}`;
      more.append(icon, label, remaining); more.onclick = () => showMoreProject(group); children.append(more);
    }
    if (expanded && shown > 5) {
      const less = document.createElement('button'); less.className = 'project-less';
      less.dataset.loading = String(local.loadingProjects.has(group.key));
      less.disabled = state.busy || local.loadingProjects.has(group.key);
      const icon = document.createElement('i'); icon.dataset.lucide = 'chevron-up';
      const label = document.createElement('span'); label.textContent = '收起更多';
      less.append(icon, label); less.onclick = () => {
        if (state.busy) return;
        local.projectLimits.delete(group.key); renderChatTree();
      };
      children.append(less);
    }
    section.append(heading, children); fragment.append(section);
  }
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'list-empty'; empty.textContent = '没有匹配的聊天'; fragment.append(empty);
  }
  const scroll = $('chat-list').scrollTop;
  $('chat-list').replaceChildren(fragment); $('chat-list').scrollTop = scroll; icons();
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && local.projectDrag) { event.preventDefault(); endProjectDrag(); }
});
async function openChat(id) {
  if (state.busy || !await allowReplace()) return;
  state.busy = true; renderStatus(); local.tableRequest++;
  try {
    const data = await api('/api/open?' + new URLSearchParams({ id }));
    await readFile(new File([data.source], data.name), null,
      { id, version: data.version, info: data.info, inherited: data.inherited || [] });
    local.tableOffset = 0; local.row = null; $('db-row-detail').textContent = '未选择数据行';
    document.querySelectorAll('.chat-item').forEach((button) => button.classList.toggle('selected', button.dataset.threadId === id));
    if (innerWidth < 1050) $('chats-panel').classList.add('collapsed');
    if (data.info.blocked) toast('这条聊天存在待恢复的保存记录，暂时禁止写入。');
  } catch (error) { toast(`无法读取聊天：${error.message}`); }
  finally { state.busy = false; renderStatus(); }
}
async function saveSynced(source) {
  if (!await confirmAction('同步保存 JSONL 和 SQLite？',
    `将写入 ${state.name}，重新编号 ordinal，并重建这条聊天的 SQLite 索引。${$('mirror-messages').checked ? '同 ID 的单段文本消息副本和删除也会联动。' : ''}原文件和数据库将自动备份；Codex 正在使用该聊天或数据已发生变化时会拒绝写入。`, '同步保存')) return;
  state.busy = true; renderStatus();
  try {
    const data = await api('/api/save', { id: state.sync.id, version: state.sync.version, source, mirror: $('mirror-messages').checked });
    state.sync.version = data.version; state.sync.info = data.info;
    state.sync.inherited = data.inherited || [];
    state.sync.backup = data.backup;
    applySource(data.source, state.selected, false);
    state.baseline = data.source; state.draft = null;
    if (local.mode === 'sqlite') await loadTable();
    toast(`同步完成${data.linkedChanges ? `，联动 ${data.linkedChanges} 条记录` : ''}，原数据已备份。`);
  } catch (error) { toast(`同步失败：${error.message}`); }
  finally { state.busy = false; render(); }
}
function tableColumns(rows) {
  const first = rows[0] || {};
  const candidates = ['title', 'turn_id', 'item_id', 'status', 'item_type', 'rollout_ordinal', 'updated_at_ordinal',
    'next_rollout_ordinal', 'next_rollout_byte_offset', 'rollout_end_byte_offset', 'cwd', 'history_mode'];
  return candidates.filter((name) => Object.hasOwn(first, name)).slice(0, 6);
}
async function loadTable() {
  if (!state.sync) return;
  const request = ++local.tableRequest;
  const id = state.sync.id, table = $('db-table').value;
  $('db-count').textContent = '读取中...';
  try {
    const data = await api('/api/table?' + new URLSearchParams({ id, table, offset: local.tableOffset, limit: 25 }));
    if (request !== local.tableRequest || state.sync?.id !== id) return;
    $('db-count').textContent = `${data.total.toLocaleString()} 行`;
    $('db-page').textContent = `${data.total ? Math.floor(local.tableOffset / 25) + 1 : 0} / ${Math.ceil(data.total / 25)}`;
    $('db-prev').disabled = local.tableOffset === 0; $('db-next').disabled = local.tableOffset + 25 >= data.total;
    $('db-source').textContent = table === 'threads' ? 'state_5.sqlite' : 'thread_history_1.sqlite';
    const columns = tableColumns(data.rows), header = document.createElement('tr');
    for (const column of columns) { const th = document.createElement('th'); th.textContent = column; header.append(th); }
    $('db-grid').querySelector('thead').replaceChildren(header);
    const body = $('db-grid').querySelector('tbody'); body.replaceChildren();
    local.row = null; $('db-row-detail').textContent = '未选择数据行'; $('copy-db-row').disabled = true; $('locate-event').disabled = true;
    for (const row of data.rows) {
      const tr = document.createElement('tr'); tr.tabIndex = 0;
      for (const column of columns) {
        const td = document.createElement('td'); td.textContent = row[column] ?? 'null'; td.title = td.textContent; tr.append(td);
      }
      const select = () => {
        body.querySelectorAll('tr').forEach((node) => node.classList.toggle('selected', node === tr));
        local.row = row;
        const display = { ...row };
        if (display.item_json) { try { display.item_json = JSON.parse(display.item_json); } catch {} }
        $('db-row-detail').textContent = JSON.stringify(display, null, 2);
        $('copy-db-row').disabled = false;
        $('locate-event').disabled = !Object.hasOwn(row, 'rollout_ordinal');
      };
      tr.onclick = select; tr.onkeydown = (event) => { if (event.key === 'Enter') select(); };
      body.append(tr);
    }
    $('db-empty').hidden = !!data.rows.length;
    icons();
  } catch (error) { if (request === local.tableRequest) { $('db-count').textContent = '读取失败'; toast(error.message); } }
}
$('toggle-chats').onclick = () => {
  $('chats-panel').classList.toggle('collapsed');
  if (innerWidth < 1050 && !$('chats-panel').classList.contains('collapsed')) $('prompt-nav').classList.add('collapsed');
};
$('manual-backup').onclick = $('backup-current').onclick = backupCurrentSession;
$('open-backups').onclick = () => { if (!state.busy) switchMode('backups'); };
$('refresh-backups').onclick = loadBackups;
$('backup-current-only').onchange = loadBackups;
$('recovery-mode').onclick = () => { if (finishDraft()) switchMode('recovery'); };
$('preview-recovery').onclick = previewRecovery;
$('create-recovery-copy').onclick = createRecoveryCopy;
$('export-handoff').onclick = exportHandoff;
$('recovery-handoff').oninput = () => {
  local.recoveryDraft = $('recovery-handoff').value;
  $('handoff-bytes').textContent = `${new Blob([local.recoveryDraft]).size.toLocaleString()} B / 65,536 B`;
};
$('recovery-keep').oninput = renderStatus;
$('recovery-copy-mode').onchange = () => { renderRecoveryPlan(); renderStatus(); };
$('conversation-mode').onclick = () => { if (finishDraft()) switchMode('conversation'); };
$('toggle-prompts').onclick = () => {
  $('prompt-nav').classList.toggle('collapsed');
  if (innerWidth < 850 && !$('prompt-nav').classList.contains('collapsed')) $('chats-panel').classList.add('collapsed');
};
$('prompt-search').oninput = renderPromptNavigation;
$('conversation-top').onclick = () => $('conversation-scroll').scrollTo({ top: 0, behavior: 'smooth' });
$('conversation-bottom').onclick = () => $('conversation-scroll').scrollTo({ top: $('conversation-scroll').scrollHeight, behavior: 'smooth' });
$('prompt-hover').onmouseenter = () => clearTimeout(promptHoverTimer);
$('prompt-hover').onmouseleave = hidePromptHoverSoon;
$('prompt-hover-jump').onclick = () => { if (transcript.hover) jumpToMessage(transcript.hover); };
$('prompt-hover-source').onclick = () => { if (transcript.hover) locateMessageSource(transcript.hover); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('prompt-hover').hidden = true; });
$('jsonl-mode').onclick = () => switchMode('jsonl');
$('sqlite-mode').onclick = () => { if (!finishDraft()) return; switchMode('sqlite'); loadTable(); };
$('reload-chat').onclick = () => openChat(state.sync.id);
$('open-parent').onclick = () => openChat(state.sync.info.historyBase.thread_id);
$('copy-backup').onclick = async () => {
  try { await navigator.clipboard.writeText(state.sync.backup); toast('备份路径已复制。'); }
  catch { toast('无法访问剪贴板。'); }
};
$('repair-index').onclick = () => { if (!dirty()) saveSynced(state.baseline); };
$('refresh-chats').onclick = refreshChats;
$('project-menu-expand').onclick = () => { const project = local.menuProject; closeProjectMenu(); if (project) setProjectExpanded(project, true); };
$('project-menu-collapse').onclick = () => { const project = local.menuProject; closeProjectMenu(); if (project) setProjectExpanded(project, false); };
$('project-menu-ignore').onclick = () => { const project = local.menuProject; if (project) ignoreProject(project); };
$('project-menu-search').onclick = () => { const project = local.menuProject; if (project) searchInProject(project); };
$('clear-project-scope').onclick = clearProjectSearch;
$('show-ignored-projects').onclick = () => { if (!state.busy) switchMode('ignored'); };
$('ignored-back').onclick = () => switchMode(local.lastDataMode);
$('ignored-search').oninput = renderIgnoredProjects;
$('restore-all-projects').onclick = () => {
  if (state.busy) return;
  local.ignoredProjects.clear(); persistIgnoredProjects(); renderIgnoredProjects(); renderChatTree();
};
$('project-context-menu').onkeydown = (event) => {
  const buttons = [...$('project-context-menu').querySelectorAll('button:not(:disabled)')];
  if (event.key === 'Escape') { event.preventDefault(); closeProjectMenu(true); return; }
  if (event.key === 'Tab') { closeProjectMenu(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
    (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
};
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#project-context-menu')) closeProjectMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('project-context-menu').hidden) closeProjectMenu(true); });
window.addEventListener('resize', () => closeProjectMenu());
document.addEventListener('scroll', () => closeProjectMenu(), true);
$('expand-all-projects').onclick = () => setAllProjectsExpanded(true);
$('collapse-all-projects').onclick = () => setAllProjectsExpanded(false);
let chatSearchTimer;
$('chat-search').oninput = () => { clearTimeout(chatSearchTimer); chatSearchTimer = setTimeout(refreshChats, 220); };
$('db-table').onchange = () => { local.tableOffset = 0; loadTable(); };
$('refresh-table').onclick = loadTable;
$('db-prev').onclick = () => { local.tableOffset = Math.max(0, local.tableOffset - 25); loadTable(); };
$('db-next').onclick = () => { local.tableOffset += 25; loadTable(); };
$('copy-db-row').onclick = async () => { try { await navigator.clipboard.writeText($('db-row-detail').textContent); toast('已复制行数据。'); } catch { toast('无法访问剪贴板。'); } };
$('locate-event').onclick = () => {
  if (!local.row || !finishDraft()) return;
  const ordinal = local.row.updated_at_ordinal ?? local.row.rollout_ordinal;
  const index = state.rows.findIndex((row) => row.value?.ordinal === ordinal);
  if (index < 0) { toast('对应事件不在当前草稿中。'); return; }
  $('search').value = ''; $('errors-only').checked = false; state.typeFilter = '';
  state.selected = index; state.page = Math.floor(index / state.pageSize); state.view = 'record';
  switchMode('jsonl'); render();
};
async function bootstrap() {
  try {
    const data = await (await fetch('/api/bootstrap')).json();
    if (!data.token) throw new Error(data.error || '本地服务不可用');
    local.token = data.token; $('connection-label').textContent = '本机连接';
    $('connection-label').title = data.databases.join('\n');
    await refreshChats();
  } catch (error) { $('connection-label').textContent = '连接失败'; toast(error.message); }
}
const narrowConversation = window.matchMedia('(max-width: 849px)');
if (narrowConversation.matches) $('prompt-nav').classList.add('collapsed');
narrowConversation.addEventListener('change', (event) => { if (event.matches) $('prompt-nav').classList.add('collapsed'); });
render(); bootstrap();
