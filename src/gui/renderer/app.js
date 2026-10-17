'use strict';

/** 渲染进程逻辑：设置、任务队列、进度渲染、日志 */

const api = window.vgrab;
const $ = (sel) => document.querySelector(sel);

const state = {
  settings: {},
  tasks: new Map(), // taskId -> {url, node, ...}
  queue: [],
  active: 0,
};

// ---------------------------------------------------------------- 小工具

function formatBytes(n) {
  n = Number(n) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatSpeed(bps) {
  return bps > 0 ? `${formatBytes(bps)}/s` : '';
}

function formatDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message, level = '') {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast ${level}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, level === 'error' ? 7000 : 4200);
}

function logLine(message, level = '') {
  const log = $('#log');
  const line = el('div', level);
  const time = el('span', 'time', `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} `);
  line.appendChild(time);
  line.appendChild(document.createTextNode(message));
  log.appendChild(line);
  while (log.childElementCount > 600) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- 设置

async function loadSettings() {
  const s = await api.getSettings();
  state.settings = s;
  $('#out-dir').value = s.outDir || '';
  $('#quality').value = s.quality || 'best';
  $('#codec').value = s.codec || 'h264';
  $('#engine').value = s.engine || 'auto';
  $('#concurrency').value = s.concurrency || 8;
  $('#parallel').value = s.parallel || 2;
  $('#cookies-file').value = s.cookiesFile || '';
  $('#cookies-browser').value = s.cookiesFromBrowser || '';
  $('#proxy').value = s.proxy || '';
  $('#overwrite').checked = Boolean(s.overwrite);
  $('#live').checked = Boolean(s.live);
  $('#auto-ytdlp').checked = s.autoDownloadYtDlp !== false;
  $('#auto-ffmpeg').checked = s.autoFetchFfmpeg !== false;
  $('#browser-assist').checked = s.browserAssist !== false;
  $('#version').textContent = s.version ? ` · v${s.version}` : '';
}

function collectOptions() {
  return {
    outDir: $('#out-dir').value,
    quality: $('#quality').value,
    codec: $('#codec').value,
    engine: $('#engine').value,
    concurrency: Number($('#concurrency').value) || 8,
    parallel: Number($('#parallel').value) || 2,
    cookiesFile: $('#cookies-file').value.trim(),
    cookiesFromBrowser: $('#cookies-browser').value,
    proxy: $('#proxy').value.trim(),
    overwrite: $('#overwrite').checked,
    live: $('#live').checked,
    autoDownloadYtDlp: $('#auto-ytdlp').checked,
    autoFetchFfmpeg: $('#auto-ffmpeg').checked,
    browserAssist: $('#browser-assist').checked,
  };
}

let saveTimer = null;
function persist() {
  const patch = collectOptions();
  state.settings = { ...state.settings, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(patch), 250);
}

// ---------------------------------------------------------------- 工具状态

async function refreshTools() {
  const s = await api.toolsStatus();
  const yt = $('#chip-ytdlp');
  const ff = $('#chip-ffmpeg');
  if (s.ytDlp) {
    yt.classList.add('ok');
    yt.classList.remove('missing');
    $('#ytdlp-value').textContent = `${s.ytDlpSize ? formatBytes(s.ytDlpSize) : '就绪'}`;
    $('#btn-get-ytdlp').textContent = '更新';
  } else {
    yt.classList.add('missing');
    yt.classList.remove('ok');
    $('#ytdlp-value').textContent = '未安装';
    $('#btn-get-ytdlp').textContent = '获取';
  }
  if (s.ffmpeg) {
    ff.classList.add('ok');
    ff.classList.remove('missing');
    $('#ffmpeg-value').textContent = s.ffmpegSize ? formatBytes(s.ffmpegSize) : '就绪';
    $('#btn-get-ffmpeg').textContent = '更换';
  } else {
    ff.classList.add('missing');
    ff.classList.remove('ok');
    $('#ffmpeg-value').textContent = '未安装（可选）';
    $('#btn-get-ffmpeg').textContent = '获取';
  }
  return s;
}

function setSetupBar(label, percent, bytes, total) {
  const bar = $('#setup-bar');
  if (label == null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('#setup-label').textContent = label;
  const fill = $('#setup-fill');
  const pct = percent >= 0 ? percent : 0;
  fill.style.width = `${pct}%`;
  fill.classList.toggle('indeterminate', !(percent >= 0));
  $('#setup-text').textContent = `${pct.toFixed(1)}% ${formatBytes(bytes)}${total ? ` / ${formatBytes(total)}` : ''}`;
}

async function installYtDlp(forceUpdate) {
  try {
    const res = forceUpdate ? await api.updateYtDlp() : await api.getYtDlp();
    if (!res.ok) throw new Error(res.error || '获取失败');
    toast('yt-dlp 已就绪', 'ok');
    logLine(`yt-dlp 就绪：${res.path}`, 'ok');
    await refreshTools();
  } catch (err) {
    toast(`获取 yt-dlp 失败：${err.message}`, 'error');
    logLine(`获取 yt-dlp 失败：${err.message}`, 'err');
  } finally {
    setSetupBar(null);
  }
}

async function installFfmpeg() {
  try {
    const res = await api.getFfmpeg();
    if (!res.ok) throw new Error(res.error || '获取失败');
    toast('ffmpeg 已就绪', 'ok');
    logLine(`ffmpeg 就绪：${res.path}`, 'ok');
    await refreshTools();
  } catch (err) {
    toast(`获取 ffmpeg 失败：${err.message}`, 'error');
    logLine(`获取 ffmpeg 失败：${err.message}`, 'err');
  } finally {
    setSetupBar(null);
  }
}

// ---------------------------------------------------------------- 任务卡片

function createTaskCard(taskId, url) {
  const node = el('div', 'task');
  node.dataset.id = taskId;

  const title = el('div', 'title', '解析中…');
  const urlLine = el('div', 'url', url);
  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill');
  bar.appendChild(fill);

  const meta = el('div', 'meta');
  const pct = el('span', 'pct', '0%');
  const bytes = el('span', 'bytes', '');
  const speed = el('span', 'speed', '');
  const eta = el('span', 'eta', '');
  const badge = el('span', 'badge', '排队中');
  meta.append(pct, bytes, speed, eta, badge);

  const actions = el('div', 'actions');
  const btnCancel = el('button', 'mini act-cancel', '取消');
  const btnOpen = el('button', 'mini act-open', '播放');
  const btnFolder = el('button', 'mini act-folder', '打开文件夹');
  const btnCopy = el('button', 'mini act-copy', '复制路径');
  btnOpen.hidden = true;
  btnFolder.hidden = true;
  btnCopy.hidden = true;
  actions.append(btnCancel, btnOpen, btnFolder, btnCopy);

  node.append(title, urlLine, bar, meta, actions);
  $('#tasks-empty').hidden = true;
  $('#tasks').prepend(node);

  const refs = { node, title, urlLine, fill, pct, bytes, speed, eta, badge, btnCancel, btnOpen, btnFolder, btnCopy };
  btnCancel.addEventListener('click', () => {
    api.cancel(taskId);
    badge.textContent = '正在结束…';
    badge.className = 'badge warn';
  });
  return refs;
}

function updateTaskCounter() {
  $('#task-counter').textContent = String(state.tasks.size);
  $('#queue-hint').textContent = state.queue.length ? `排队中 ${state.queue.length} 个` : '';
}

// ---------------------------------------------------------------- 队列

/** 从任意文本（含抖音那种带中文和话题的分享文案）里挑出有效链接 */
async function extractLinksFromText(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { urls: [], noisy: false };
  try {
    const res = await api.extractUrls(raw);
    return { urls: (res && res.urls) || [], noisy: Boolean(res && res.noisy) };
  } catch {
    // 主进程不可用时退回简单按行处理
    return { urls: raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), noisy: false };
  }
}

async function enqueueText(text) {
  const { urls, noisy } = await extractLinksFromText(text);
  if (!urls.length) {
    toast('没有识别到有效链接：可以直接粘贴整段分享文案，我会自动挑出里面的链接', 'error');
    logLine('没有在输入内容中识别到链接', 'err');
    return;
  }
  enqueue(urls);
  if (noisy) {
    toast(`已从文本中识别出 ${urls.length} 个链接`);
    logLine(`已从粘贴的文本中识别出 ${urls.length} 个链接`, 'ok');
  }
}

function enqueue(urls) {
  const list = urls.map((u) => String(u).trim()).filter(Boolean);
  if (!list.length) {
    toast('请先粘贴至少一个链接', 'error');
    return;
  }
  const seen = new Set();
  let added = 0;
  for (const url of list) {
    if (seen.has(url)) continue;
    seen.add(url);
    const refs = createTaskCard(`pending-${Math.random().toString(16).slice(2)}`, url);
    state.queue.push({ url, refs });
    added += 1;
  }
  updateTaskCounter();
  logLine(`已加入 ${added} 个链接`);
  pump();
}

async function pump() {
  const limit = Math.max(1, Number($('#parallel').value) || 1);
  while (state.active < limit && state.queue.length) {
    const item = state.queue.shift();
    state.active += 1;
    updateTaskCounter();
    try {
      const res = await api.startDownload(item.url, collectOptions());
      const taskId = res.taskId;
      state.tasks.set(taskId, { url: item.url, refs: item.refs });
      item.refs.node.dataset.id = taskId;
      item.refs.badge.textContent = '准备中';
      item.refs.badge.className = 'badge';
      item.refs.btnCancel.onclick = () => {
        api.cancel(taskId);
        item.refs.badge.textContent = '正在结束…';
        item.refs.badge.className = 'badge warn';
      };
      updateTaskCounter();
    } catch (err) {
      item.refs.badge.textContent = '启动失败';
      item.refs.badge.className = 'badge err';
      state.active -= 1;
      logLine(`启动任务失败：${err.message}`, 'err');
    }
  }
}

function taskFinished(taskId) {
  state.active = Math.max(0, state.active - 1);
  updateTaskCounter();
  pump();
}

// ---------------------------------------------------------------- 输入框右键菜单（复制 / 粘贴）

let ctxMenu = null;
let ctxTarget = null;

function buildContextMenu() {
  const menu = el('div', 'ctx-menu');
  menu.id = 'ctx-menu';
  menu.hidden = true;
  const copyBtn = el('button', 'ctx-item', '复制');
  copyBtn.id = 'ctx-copy';
  const pasteBtn = el('button', 'ctx-item', '粘贴');
  pasteBtn.id = 'ctx-paste';
  menu.append(copyBtn, pasteBtn);
  document.body.appendChild(menu);
  return { menu, copyBtn, pasteBtn };
}

function hideContextMenu() {
  if (ctxMenu) ctxMenu.menu.hidden = true;
  ctxTarget = null;
}

function showContextMenu(field, x, y) {
  const { menu, pasteBtn } = ctxMenu;
  ctxTarget = field;
  // 只读输入框（如保存目录）不提供粘贴
  pasteBtn.hidden = Boolean(field.readOnly);
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

async function copyFromField() {
  const field = ctxTarget;
  if (!field) return;
  const selected = field.value.slice(field.selectionStart || 0, field.selectionEnd || 0);
  const text = selected || field.value;
  if (!text.trim()) {
    toast('没有可复制的内容', 'error');
    return;
  }
  const res = await api.clipboardWrite(text);
  toast(res && res.ok ? (selected ? '已复制选中内容' : '已复制全部内容') : '复制失败', res && res.ok ? 'ok' : 'error');
}

async function pasteIntoField() {
  const field = ctxTarget;
  if (!field) return;
  const res = await api.clipboardRead();
  const text = res && res.ok ? String(res.text || '') : '';
  if (!text) {
    toast('剪贴板里没有文本', 'error');
    return;
  }
  const start = field.selectionStart == null ? field.value.length : field.selectionStart;
  const end = field.selectionEnd == null ? field.value.length : field.selectionEnd;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.focus();
  const caret = start + text.length;
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    /* 某些输入类型不支持 */
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  toast(`已粘贴${text.includes('\n') ? `（${text.split(/\r?\n/).filter(Boolean).length} 行）` : ''}`);
}

function bindContextMenu() {
  ctxMenu = buildContextMenu();
  const { menu, copyBtn, pasteBtn } = ctxMenu;
  copyBtn.addEventListener('click', () => {
    copyFromField().catch(() => {}).finally(hideContextMenu);
  });
  pasteBtn.addEventListener('click', () => {
    pasteIntoField().catch(() => {}).finally(hideContextMenu);
  });

  for (const field of document.querySelectorAll('textarea, input[type="text"], input[type="number"]')) {
    field.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (document.activeElement !== field) field.focus();
      showContextMenu(field, e.clientX, e.clientY);
    });
    // 键盘也用得上：Ctrl+A 全选 / Ctrl+V 粘贴保持原生行为
  }

  document.addEventListener('mousedown', (e) => {
    if (ctxMenu && !ctxMenu.menu.hidden && !ctxMenu.menu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#login-modal') && !$('#login-modal').hidden) closeLoginModal();
      hideContextMenu();
    }
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
}

// ---------------------------------------------------------------- 清空输入栏

/** 输入为空时把「清空」按钮置灰，避免无意义的点击 */
function updateClearButton() {
  const btn = $('#btn-clear-input');
  const input = $('#url-input');
  if (!btn || !input) return;
  btn.disabled = input.value.length === 0;
}

/** 一键清空链接输入栏（连同解析结果一起收起） */
function clearUrlInput(silent = false) {
  const input = $('#url-input');
  if (!input) return;
  const had = input.value.length > 0;
  input.value = '';
  const box = $('#probe-result');
  if (box) {
    box.hidden = true;
    box.textContent = '';
  }
  const hint = $('#queue-hint');
  if (hint) hint.textContent = state.queue.length ? `排队中 ${state.queue.length} 个` : '';
  updateClearButton();
  input.focus();
  if (silent) return;
  if (had) {
    logLine('已清空输入栏');
    toast('已清空输入栏');
  } else {
    toast('输入栏本来就是空的');
  }
}

// ---------------------------------------------------------------- 下载历史

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function refreshHistory() {
  const box = $('#history-list');
  if (!box) return;
  let data;
  try {
    data = await api.historyList();
  } catch {
    return;
  }
  const records = (data && data.records) || [];
  $('#history-counter').textContent = String(records.length);
  if (document.activeElement !== $('#history-limit')) $('#history-limit').value = String((data && data.limit) || 20);
  box.textContent = '';
  if (!records.length) {
    const empty = el('div', 'empty');
    empty.appendChild(el('p', 'small', '还没有下载记录'));
    box.appendChild(empty);
    return;
  }
  for (const r of records) {
    box.appendChild(renderHistoryItem(r));
  }
}

function renderHistoryItem(r) {
  const node = el('div', `history-item${r.ok ? '' : ' failed'}`);
  const main = el('div', 'hi-main');
  const name = r.fileName || r.title || r.url || '(未知)';
  main.appendChild(el('div', 'hi-name', name));
  const meta = el('div', 'hi-meta');
  meta.appendChild(el('span', '', r.ok ? (r.stopped ? '已结束录制' : '成功') : r.cancelled ? '已取消' : '失败'));
  meta.appendChild(el('span', '', formatTime(r.at)));
  if (r.bytes) meta.appendChild(el('span', '', formatBytes(r.bytes)));
  if (r.durationSec) meta.appendChild(el('span', '', formatDuration(r.durationSec)));
  if (r.engine) meta.appendChild(el('span', '', r.engine));
  if (!r.ok && r.error) meta.appendChild(el('span', '', String(r.error).split('\n')[0].slice(0, 60)));
  main.appendChild(meta);
  node.appendChild(main);

  const actions = el('div', 'hi-actions');
  const mk = (label, title, handler, cls = 'mini') => {
    const b = el('button', cls, label);
    if (title) b.title = title;
    b.addEventListener('click', handler);
    return b;
  };
  if (r.url) {
    actions.appendChild(
      mk('重下', '重新下载这个链接', () => {
        const input = $('#url-input');
        input.value = [input.value.trim(), r.url].filter(Boolean).join('\n');
        updateClearButton();
        enqueue([r.url]);
        toast('已加入下载队列');
      }),
    );
  }
  if (r.filePath && r.ok) {
    actions.appendChild(mk('播放', '用默认播放器打开', () => api.openPath(r.filePath)));
    actions.appendChild(mk('文件夹', '在资源管理器中显示', () => api.showItem(r.filePath)));
    actions.appendChild(
      mk('复制路径', '复制文件完整路径', async () => {
        const res = await api.clipboardWrite(r.filePath);
        toast(res && res.ok ? '路径已复制' : '复制失败', res && res.ok ? 'ok' : 'error');
      }),
    );
  }
  actions.appendChild(
    mk('删除', '从历史中移除这条记录', async () => {
      await api.historyRemove(r.id);
      await refreshHistory();
    }),
  );
  node.appendChild(actions);
  return node;
}

function bindHistory() {
  $('#btn-history-refresh').addEventListener('click', () => {
    refreshHistory();
    toast('历史已刷新');
  });
  $('#btn-history-clear').addEventListener('click', async () => {
    if (!window.confirm('确定清空全部下载历史吗？（不会删除已下载的文件）')) return;
    await api.historyClear();
    await refreshHistory();
    toast('已清空下载历史');
    logLine('已清空下载历史');
  });
  const limitInput = $('#history-limit');
  const applyLimit = async () => {
    const n = Math.max(1, Math.min(2000, Number(limitInput.value) || 20));
    limitInput.value = String(n);
    const res = await api.historySetLimit(n);
    await refreshHistory();
    toast(`历史保留条数已设为 ${res.limit || n} 条`);
  };
  limitInput.addEventListener('change', applyLimit);
  limitInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyLimit();
  });
}

// ---------------------------------------------------------------- 事件绑定

function bindUi() {
  bindContextMenu();
  bindHistory();

  const urlInput = $('#url-input');
  urlInput.addEventListener('input', () => {
    updateClearButton();
  });
  $('#btn-clear-input').addEventListener('click', () => clearUrlInput());
  updateClearButton();

  // Ctrl+Shift+X 也能清空
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
      e.preventDefault();
      clearUrlInput();
    }
  });

  $('#btn-download').addEventListener('click', () => {
    enqueueText($('#url-input').value);
  });

  $('#btn-parse').addEventListener('click', async () => {
    const { urls } = await extractLinksFromText($('#url-input').value);
    const first = urls[0];
    if (!first) return toast('没有识别到有效链接', 'error');
    const box = $('#probe-result');
    box.hidden = false;
    box.textContent = '解析中…';
    try {
      const info = await api.probe(first);
      renderProbe(info, first);
    } catch (err) {
      box.textContent = `解析失败：${err.message}`;
    }
  });

  $('#btn-cancel-all').addEventListener('click', async () => {
    state.queue.length = 0;
    updateTaskCounter();
    await api.cancelAll();
    toast('已请求取消所有任务');
  });

  $('#btn-pick-dir').addEventListener('click', async () => {
    const dir = await api.pickDir();
    if (dir) {
      $('#out-dir').value = dir;
      persist();
      logLine(`保存目录：${dir}`);
    }
  });
  $('#btn-open-dir').addEventListener('click', async () => {
    const res = await api.openFolder($('#out-dir').value);
    if (!res.ok) toast(`打开目录失败：${res.error}`, 'error');
  });
  $('#btn-pick-cookies').addEventListener('click', async () => {
    const file = await api.pickCookies();
    if (file) {
      $('#cookies-file').value = file;
      persist();
    }
  });

  // Pixiv 搜图：搜索框 + R18 开关（走公开检索接口 + pixiv.re 反代，不需要代理）
  /**
   * 给 Pixiv 这类"不是普通链接下载"的流程也开一张任务卡。
   *
   * 任务卡的 DOM 和事件处理与普通下载完全一样（`state.tasks` 里注册同一个 taskId，
   * 主进程发 task:progress/done/error 时它就会动）—— 唯一的区别是**取消按钮不显示**：
   * 这类任务不受 downloader 的取消队列管，点了也没用，不如不显示。
   */
  const startPixivTask = (label, url) => {
    const taskId = `pixiv-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const refs = createTaskCard(taskId, url || label);
    refs.title.textContent = label;
    refs.badge.textContent = '进行中';
    refs.btnCancel.hidden = true;
    state.tasks.set(taskId, { url: url || label, refs });
    return taskId;
  };

  /**
   * 兜底收尾：主进程没发事件（IPC 直接抛错等）时，别让任务卡永远停在"进行中"。
   * 正常路径下主进程会先发 task:error，这里再补一次也不会重复（卡片已经变成失败态了）。
   */
  const failPixivTask = (taskId, message) => {
    const task = state.tasks.get(taskId);
    if (!task) return;
    state.tasks.delete(taskId);
    const { refs } = task;
    if (refs.node.classList.contains('error') || refs.node.classList.contains('done')) return;
    refs.node.classList.add('error');
    refs.badge.textContent = '失败';
    refs.badge.className = 'badge err';
    refs.eta.textContent = String(message || '未知错误').slice(0, 60);
  };

  const runPixivSearch = async (listOnly) => {
    const keyword = $('#pixiv-keyword').value.trim();
    const status = $('#pixiv-status');
    const box = $('#pixiv-results');
    const count = Math.max(1, Math.min(20, Number($('#pixiv-count').value) || 3));
    const allowR18 = $('#pixiv-r18').checked;
    if (!keyword) {
      status.className = 'ps-status hint err';
      status.textContent = '✖ 请先填搜索关键词';
      toast('请先填搜索关键词', 'error');
      return;
    }
    const btnSearch = $('#btn-pixiv-search');
    const btnList = $('#btn-pixiv-list');
    btnSearch.disabled = true;
    btnList.disabled = true;
    status.className = 'ps-status hint';
    status.textContent = `正在搜索「${keyword}」${listOnly ? '（只列出）' : '并下载'}…${allowR18 ? '（含成人向）' : ''}`;
    box.hidden = true;
    box.innerHTML = '';
    // 任务卡：搜图/下载都会出现在右侧「下载任务」里，完成后进「下载记录」
    const taskId = startPixivTask(
      listOnly ? `Pixiv 检索：${keyword}` : `Pixiv 搜图：${keyword}`,
      `pixiv-search:${keyword}`,
    );
    try {
      const res = await api.pixivSearch({
        keyword,
        count,
        allowR18,
        listOnly,
        taskId,
        outDir: $('#out-dir').value.trim(),
      });
      if (!res.ok) {
        status.className = 'ps-status hint err';
        status.textContent = `✖ ${res.error || (res.errors && res.errors.length ? res.errors.join('；') : '没有搜到作品')}`;
        return;
      }
      const okItems = res.items.filter((it) => it.ok);
      const totalFiles = okItems.reduce((sum, it) => sum + (it.files || 0), 0);
      status.className = 'ps-status hint ok';
      status.textContent = listOnly
        ? `✔ 命中 ${res.items.length} 个作品（来源 ${res.backend}）：勾选要的，然后点「下载选中」`
        : `✔ 命中 ${res.items.length} 个，成功 ${okItems.length} 个，共 ${totalFiles} 张 → ${res.dir}`;
      box.hidden = false;
      box.textContent = '';

      // 「只列出」时的操作条：全选 / 全不选 / 下载选中
      let selected = new Set(listOnly ? res.items.map((_, i) => i) : []);
      if (listOnly) {
        const bar = document.createElement('div');
        bar.className = 'ps-actions';
        const btnAll = document.createElement('button');
        btnAll.type = 'button';
        btnAll.className = 'ps-open';
        btnAll.textContent = '全选';
        const btnNone = document.createElement('button');
        btnNone.type = 'button';
        btnNone.className = 'ps-open';
        btnNone.textContent = '全不选';
        const btnDl = document.createElement('button');
        btnDl.type = 'button';
        btnDl.className = 'ps-open primary-ish';
        const refreshBar = () => {
          btnDl.textContent = `下载选中（${selected.size}）`;
          btnDl.disabled = selected.size === 0;
          for (const cb of box.querySelectorAll('.ps-pick input')) {
            cb.checked = selected.has(Number(cb.closest('.ps-item').dataset.idx));
          }
        };
        btnAll.addEventListener('click', () => {
          selected = new Set(res.items.map((_, i) => i));
          refreshBar();
        });
        btnNone.addEventListener('click', () => {
          selected = new Set();
          refreshBar();
        });
        btnDl.addEventListener('click', async () => {
          const picked = [...selected].sort((a, b) => a - b).map((i) => res.items[i]);
          if (!picked.length) return;
          btnDl.disabled = true;
          const before = btnDl.textContent;
          btnDl.textContent = `正在下载 ${picked.length} 个…`;
          status.className = 'ps-status hint';
          status.textContent = `正在下载选中的 ${picked.length} 个作品…（每个作品一个子目录）`;
          let pickTaskId = '';
          try {
            pickTaskId = startPixivTask(`Pixiv 下载选中（${picked.length} 个）`, `pixiv-pick:${picked.length}`);
            const dl = await api.pixivDownload({
              items: picked,
              taskId: pickTaskId,
              outDir: $('#out-dir').value.trim(),
            });
            if (!dl.ok) {
              status.className = 'ps-status hint err';
              status.textContent = `✖ 下载失败：${dl.error}`;
              failPixivTask(pickTaskId, dl.error);
              return;
            }
            // 把下载结果显示回原条目上（编号对得上：picked 的顺序 ≠ 列表顺序，所以按 pid 回填）
            const byPid = new Map(dl.items.map((it) => [String(it.pid), it]));
            for (const [idx, it] of res.items.entries()) {
              const got = byPid.get(String(it.pid));
              if (!got) continue;
              res.items[idx] = { ...it, ...got };
              const el = box.querySelector(`.ps-item[data-idx="${idx}"]`);
              if (!el) continue;
              const badge = el.querySelector('.ps-badge');
              if (badge) badge.textContent = got.ok ? `${got.files} 张 · 已下载` : `失败：${got.error}`;
              const open = el.querySelector('.ps-open:not(.primary-ish)');
              if (open && got.dir) open.dataset.dir = got.dir;
            }
            const okCount = dl.items.filter((x) => x.ok).length;
            status.className = 'ps-status hint ok';
            status.textContent = `✔ 下载完成：成功 ${okCount}/${dl.items.length} 个 → ${dl.dir}`;
            logLine(`Pixiv 下载选中：成功 ${okCount}/${dl.items.length} 个 → ${dl.dir}`, 'ok');
            await fillThumbs(res.items.filter((x) => x.ok && (x.fileList || []).length));
          } catch (err) {
            status.className = 'ps-status hint err';
            status.textContent = `✖ 下载失败：${err.message}`;
            failPixivTask(pickTaskId, err.message);
          } finally {
            btnDl.textContent = before;
            refreshBar();
          }
        });
        bar.append(btnAll, btnNone, btnDl);
        box.appendChild(bar);
      }

      // 每个作品一行：标题 + 徽标 + 预览图（预览图由主进程缩好之后异步回填）
      res.items.forEach((it, idx) => {
        const badge = [
          it.rating ? '⚠️成人向' : '全年龄',
          it.ok ? (listOnly ? `pid ${it.pid}` : `${it.files} 张`) : `失败：${it.error}`,
        ].join(' · ');
        const name = `${it.title || '(无题)'}${it.author ? ` — ${it.author}` : ''}`;

        const el = document.createElement('div');
        el.className = 'ps-item';
        el.dataset.idx = String(idx);

        const head = document.createElement('div');
        head.className = 'ps-head';

        if (listOnly) {
          const pick = document.createElement('label');
          pick.className = 'ps-pick';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(idx);
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(idx);
            else selected.delete(idx);
            const btn = box.querySelector('.ps-actions .primary-ish');
            if (btn) {
              btn.textContent = `下载选中（${selected.size}）`;
              btn.disabled = selected.size === 0;
            }
          });
          pick.appendChild(cb);
          head.appendChild(pick);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'ps-name';
        nameEl.title = String(it.url || '');
        nameEl.textContent = name;
        const badgeEl = document.createElement('span');
        badgeEl.className = 'ps-badge';
        badgeEl.textContent = badge;
        head.append(nameEl, badgeEl);

        if (listOnly) {
          const one = document.createElement('button');
          one.type = 'button';
          one.className = 'ps-open';
          one.textContent = '下载这个';
          one.addEventListener('click', async () => {
            one.disabled = true;
            const before = one.textContent;
            one.textContent = '下载中…';
            let oneTaskId = '';
            try {
              oneTaskId = startPixivTask(`Pixiv 下载：${it.title || it.pid}`, it.url || `pixiv:${it.pid}`);
              const dl = await api.pixivDownload({
                items: [it],
                taskId: oneTaskId,
                outDir: $('#out-dir').value.trim(),
              });
              if (dl.ok && dl.items[0]) {
                const got = dl.items[0];
                res.items[idx] = { ...it, ...got };
                badgeEl.textContent = got.ok ? `${got.files} 张 · 已下载` : `失败：${got.error}`;
                if (got.dir) openBtn.dataset.dir = got.dir;
                status.className = 'ps-status hint ok';
                status.textContent = got.ok ? `✔ 已下载「${it.title}」（${got.files} 张）→ ${dl.dir}` : `✖ ${it.title}：${got.error}`;
                await fillThumbs([res.items[idx]]);
              } else {
                status.className = 'ps-status hint err';
                status.textContent = `✖ 下载失败：${(dl && dl.error) || '未知错误'}`;
                failPixivTask(oneTaskId, (dl && dl.error) || '未知错误');
              }
            } catch (err) {
              failPixivTask(oneTaskId, err.message);
            } finally {
              one.textContent = before;
              one.disabled = false;
            }
          });
          head.appendChild(one);
        }

        // 「打开文件夹」：只列出时先没有目录，下载完才有 —— 所以用 dataset.dir 延迟取
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ps-open';
        openBtn.textContent = '打开文件夹';
        openBtn.dataset.dir = it.dir || '';
        openBtn.hidden = !it.dir;
        openBtn.addEventListener('click', () => {
          const dir = openBtn.dataset.dir;
          if (dir) api.openFolder(dir);
        });
        head.appendChild(openBtn);
        el.appendChild(head);

        const thumbs = document.createElement('div');
        thumbs.className = 'ps-thumbs';
        // 预览图只在「只列出」时铺（挑图用）；「搜图并下载」直接下完就完事，不再解码/加载预览
        if (listOnly) thumbs.textContent = '正在取预览图…';
        el.appendChild(thumbs);
        box.appendChild(el);
      });

      refreshSelectedBar();

      /**
       * 把本地文件的预览图填到条目里（下载完成后也会再调一次刷新）。
       * 一张张缩图比"一次性几十张"更不容易让窗口卡住，先出来的作品能立刻看到图。
       */
      async function fillThumbs(list) {
        let shown = 0;
        for (const it of list) {
          const idx = res.items.indexOf(it);
          if (idx < 0) continue;
          const files = it.ok ? it.fileList || [] : [];
          const holder = box.querySelector(`.ps-item[data-idx="${idx}"] .ps-thumbs`);
          if (!holder) continue;
          if (!files.length) {
            holder.textContent = '';
            continue;
          }
          try {
            const t = await api.pixivThumbs({ files, width: 200 });
            const got = (t && t.thumbs) || [];
            holder.textContent = '';
            for (const th of got) {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'ps-thumb';
              btn.title = `${th.name}（点击用系统看图打开）`;
              const im = document.createElement('img');
              im.src = th.dataUrl;
              im.alt = th.name;
              im.loading = 'lazy';
              btn.appendChild(im);
              btn.addEventListener('click', () => api.openPath(th.file));
              holder.appendChild(btn);
              shown += 1;
            }
            const rest = files.length - got.length;
            if (rest > 0) {
              const more = document.createElement('span');
              more.className = 'ps-more';
              more.textContent = `+${rest}`;
              more.title = `还有 ${rest} 张没有预览（点"打开文件夹"看全部）`;
              holder.appendChild(more);
            }
            if (!got.length) holder.textContent = '（这些图没能生成预览，点"打开文件夹"直接看）';
          } catch {
            holder.textContent = '（预览生成失败，点"打开文件夹"直接看）';
          }
        }
        if (shown) logLine(`已显示 ${shown} 张预览图（点图用系统看图打开）`, 'ok');
        return shown;
      }

      function refreshSelectedBar() {
        const btn = box.querySelector('.ps-actions .primary-ish');
        if (!btn) return;
        btn.textContent = `下载选中（${selected.size}）`;
        btn.disabled = selected.size === 0;
      }

      if (listOnly) {
        // 预览图走反代缩略图（60KB 上下，不拉原图）；失败就留个占位，不影响勾选下载
        void (async () => {
          try {
            const pv = await api.pixivPreviews({ items: res.items.map((it) => ({ pid: it.pid, previewUrl: it.previewUrl, originalUrl: it.originalUrl })), width: 260 });
            const byPid = new Map(((pv && pv.previews) || []).map((p) => [String(p.pid), p.dataUrl]));
            let shown = 0;
            for (const [idx, it] of res.items.entries()) {
              const holder = box.querySelector(`.ps-item[data-idx="${idx}"] .ps-thumbs`);
              if (!holder) continue;
              const dataUrl = byPid.get(String(it.pid));
              holder.textContent = '';
              if (!dataUrl) {
                holder.textContent = '（预览拿不到，可照常勾选下载）';
                continue;
              }
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'ps-thumb';
              btn.title = `${it.title || ''}（点开原作品页）`;
              const im = document.createElement('img');
              im.src = dataUrl;
              im.alt = it.title || '';
              btn.appendChild(im);
              btn.addEventListener('click', () => {
                if (it.url) api.openPath(it.url);
              });
              holder.appendChild(btn);
              shown += 1;
            }
            if (shown) logLine(`只列出：已铺 ${shown} 张缩略图（挑完点「下载选中」）`, 'ok');
          } catch (err) {
            logLine(`预览图获取失败（不影响下载）：${err.message}`, 'warn');
          }
        })();
      } else {
        // 「搜图并下载」：**不加载预览图** —— 图已经下好了，再解码一遍纯属白等
        // （要看图就直接点「打开文件夹」，或者用「只列出」先挑）
      }
      logLine(`Pixiv 搜图「${keyword}」：${status.textContent}`, 'ok');
    } catch (err) {
      status.className = 'ps-status hint err';
      status.textContent = `✖ 搜图失败：${err.message}`;
      logLine(`Pixiv 搜图失败：${err.message}`, 'err');
      failPixivTask(taskId, err.message);
    } finally {
      btnSearch.disabled = false;
      btnList.disabled = false;
    }
  };
  $('#btn-pixiv-search').addEventListener('click', () => runPixivSearch(false));
  $('#btn-pixiv-list').addEventListener('click', () => runPixivSearch(true));
  $('#pixiv-keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runPixivSearch(false);
    }
  });
  // R18 开关：打开时给一句提醒（默认关）
  $('#pixiv-r18').addEventListener('change', () => {
    const on = $('#pixiv-r18').checked;
    const status = $('#pixiv-status');
    status.className = `ps-status hint${on ? ' err' : ''}`;
    status.textContent = on ? '⚠️ 已允许成人向作品：搜出来的图可能不适合在公开场合展示' : '';
  });

  // 代理自检：立即生效（无需重启），并给出「直连 vs 经代理」的对比结论
  $('#btn-proxy-test').addEventListener('click', async () => {
    const btn = $('#btn-proxy-test');
    const status = $('#proxy-status');
    const proxy = $('#proxy').value.trim();
    btn.disabled = true;
    status.className = 'hint';
    status.textContent = `正在测试${proxy ? ` ${proxy}` : '（留空 = 跟随系统代理）'}…`;
    logLine(`代理自检开始${proxy ? `：${proxy}` : '（留空 = 跟随系统代理）'}`);
    try {
      const res = await api.checkProxy(proxy);
      if (res.proxy && res.proxy !== state.settings.proxy) {
        state.settings = { ...state.settings, proxy: res.proxy };
        $('#proxy').value = res.proxy;
      }
      status.className = res.ok ? 'hint ok' : 'hint err';
      status.textContent = `${res.ok ? '✔' : '✖'} ${res.verdict}${res.applied ? '（已立即生效，无需重启）' : ''}`;
      logLine(`代理自检：${res.verdict}${res.applied ? '（已立即生效，无需重启）' : ''}`, res.ok ? 'ok' : 'err');
      for (const item of res.results || []) {
        logLine(`  ${item.ok ? '✓' : '✗'} [${item.via === 'proxy' ? '经代理' : '直连'}] ${item.name}：${item.note}`, item.ok ? '' : 'err');
      }
      toast(res.ok ? '代理可用，已立即生效' : '代理自检未通过，请看日志', res.ok ? 'ok' : 'error');
    } catch (err) {
      status.className = 'hint err';
      status.textContent = `✖ 自检失败：${err.message}`;
      logLine(`代理自检失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  // 手填代理后立刻提示可以点「测试代理」
  $('#proxy').addEventListener('change', () => {
    const status = $('#proxy-status');
    if (!status.textContent) status.textContent = '改完可以点「测试代理」立即验证（不用重启）';
  });

  $('#btn-get-ytdlp').addEventListener('click', () => {
    const installed = $('#chip-ytdlp').classList.contains('ok');
    installYtDlp(installed);
  });
  $('#btn-get-ffmpeg').addEventListener('click', () => installFfmpeg());

  // 登录：打开站点选择弹窗（可选常用站点，也可填任意网址）
  $('#btn-login').addEventListener('click', () => openLoginModal());
  $('#btn-login-close').addEventListener('click', () => closeLoginModal());
  $('#btn-login-go').addEventListener('click', () => submitCustomLogin());
  $('#login-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCustomLogin();
    }
  });
  $('#login-modal').addEventListener('mousedown', (e) => {
    if (e.target === $('#login-modal')) closeLoginModal();
  });
  $('#btn-logout').addEventListener('click', () => clearLogin());

  $('#btn-toggle-log').addEventListener('click', () => {
    const log = $('#log');
    log.classList.toggle('hidden');
    $('#btn-toggle-log').textContent = log.classList.contains('hidden') ? '展开' : '折叠';
  });
  $('#btn-clear-log').addEventListener('click', () => {
    $('#log').textContent = '';
  });

  $('#btn-clear-done').addEventListener('click', () => {
    for (const [id, task] of [...state.tasks.entries()]) {
      if (task.refs.node.classList.contains('done') || task.refs.node.classList.contains('error')) {
        task.refs.node.remove();
        state.tasks.delete(id);
      }
    }
    updateTaskCounter();
    if (!state.tasks.size) $('#tasks-empty').hidden = false;
  });

  // 选项变化即保存
  for (const sel of ['#out-dir', '#quality', '#codec', '#engine', '#concurrency', '#parallel', '#cookies-file', '#cookies-browser', '#proxy', '#overwrite', '#live', '#auto-ytdlp', '#auto-ffmpeg', '#browser-assist']) {
    $(sel).addEventListener('change', persist);
  }
  $('#parallel').addEventListener('change', pump);

  // 拖拽链接
  const zone = $('#dropzone');
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('dragover', (e) => {
    stop(e);
    zone.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => {
    stop(e);
    zone.classList.remove('dragover');
  });
  window.addEventListener('drop', (e) => {
    stop(e);
    zone.classList.remove('dragover');
    const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    if (text) {
      const input = $('#url-input');
      input.value = [input.value.trim(), ...text.split(/\r?\n/)].filter(Boolean).join('\n');
      updateClearButton();
      toast('已添加拖入的链接');
    }
  });

  // Ctrl+Enter 开始下载
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') $('#btn-download').click();
  });
}

function renderProbe(info, url) {
  const box = $('#probe-result');
  box.textContent = '';
  if (!info.ok) {
    box.appendChild(el('div', 'line', `解析失败：${info.error}`));
    return;
  }
  const add = (k, v, isTag) => {
    const line = el('div', 'line');
    line.appendChild(el('span', 'k', k));
    line.appendChild(isTag ? el('span', 'tag', v) : el('span', '', v));
    box.appendChild(line);
  };
  add('类型', { direct: '直链媒体', hls: 'HLS(m3u8) 流', dash: 'DASH 流', page: '网页', api: '接口', unknown: '未知' }[info.type] || info.type, true);
  add('标题', info.title || '(未获取到)');
  add('文件名', info.filename || '-');
  add('大小', info.contentLength ? formatBytes(info.contentLength) : '未知');
  add('地址', info.finalUrl);
  if (info.candidates?.length) {
    add('内嵌媒体', `${info.candidates.length} 个可直接下载的地址`);
    for (const c of info.candidates.slice(0, 4)) {
      box.appendChild(el('div', 'cand', `[${c.type}] ${c.url.slice(0, 150)}`));
    }
  }

  // 网页类链接：询问 yt-dlp 该站点实际提供哪些清晰度
  if (['page', 'api', 'dash', 'unknown'].includes(info.type)) {
    const line = el('div', 'line');
    line.appendChild(el('span', 'k', '站点解析'));
    const value = el('span', '', '查询中…');
    line.appendChild(value);
    box.appendChild(line);
    api
      .formats(url)
      .then((res) => {
        if (res && res.formats && res.formats.length) {
          const heights = [...new Set(res.formats.filter((f) => f.height).map((f) => f.height))].sort((a, b) => b - a);
          value.textContent = heights.length
            ? `${res.formats.length} 个格式，可用清晰度：${heights.map((h) => `${h}P`).join(' / ')}`
            : `${res.formats.length} 个格式（未提供分辨率信息）`;
          mergeQualityOptions(heights);
        } else if (res && res.message) {
          value.textContent = res.message;
        } else if (res && res.error) {
          value.textContent = `解析失败：${res.error}`;
        } else {
          value.textContent = '未获取到格式信息';
        }
      })
      .catch((err) => {
        value.textContent = `查询失败：${err.message}`;
      });
  }
}

/** 把站点实际提供的清晰度补进下拉框（已存在则不重复添加） */
function mergeQualityOptions(heights) {
  const select = $('#quality');
  for (const h of heights) {
    if (!h) continue;
    if ([...select.options].some((o) => o.value === String(h))) continue;
    const option = el('option', '', `${h}P`);
    option.value = String(h);
    select.appendChild(option);
  }
}

// ---------------------------------------------------------------- 登录站点选择弹窗

let loginSiteCache = null;

async function openLoginModal() {
  const modal = $('#login-modal');
  const grid = $('#login-site-grid');
  if (!loginSiteCache) {
    try {
      loginSiteCache = await api.loginSites();
    } catch {
      loginSiteCache = [];
    }
  }
  grid.textContent = '';
  for (const site of loginSiteCache) {
    const btn = el('button', '', site.name);
    btn.title = site.url;
    btn.dataset.site = site.key;
    btn.addEventListener('click', () => {
      closeLoginModal();
      startLogin(site.key);
    });
    grid.appendChild(btn);
  }
  // 想登录的站点不在上面：直接输入网址
  const custom = el('button', '', '其他网站…');
  custom.id = 'btn-login-other';
  custom.title = '输入任意网址或域名';
  custom.addEventListener('click', () => {
    const input = $('#login-custom');
    if (!input.value.trim()) {
      input.focus();
      toast('在下面输入要登录的网址或域名');
      return;
    }
    const value = input.value.trim();
    closeLoginModal();
    startLogin(value);
  });
  grid.appendChild(custom);

  const st = await refreshLogin();
  $('#login-current').textContent = st.loggedIn
    ? `当前已登录约 ${st.domains || 0} 个域名（${st.count} 项 Cookie）`
    : '当前未登录';
  modal.hidden = false;
  setTimeout(() => $('#login-custom').focus(), 30);
}

function closeLoginModal() {
  const modal = $('#login-modal');
  if (modal) modal.hidden = true;
}

async function submitCustomLogin() {
  const value = $('#login-custom').value.trim();
  if (!value) {
    toast('请输入要登录的网址或域名', 'error');
    return;
  }
  closeLoginModal();
  await startLogin(value);
}

// ---------------------------------------------------------------- 登录

async function refreshLogin() {
  try {
    const s = await api.loginStatus();
    const chip = $('#chip-login');
    chip.classList.toggle('logged-in', s.loggedIn);
    const domains = s.domains || 0;
    $('#login-value').textContent = s.loggedIn ? `已登录（${s.count} 项）` : '未登录';
    $('#btn-login').textContent = s.loggedIn ? '重新登录' : '登录';
    $('#btn-logout').hidden = !s.loggedIn;
    chip.title = s.loggedIn
      ? `已登录约 ${domains} 个域名；登录状态文件：${s.file}\n点击可继续登录其它站点`
      : '用内置浏览器登录任意站点，之后即可下载高画质 / 会员内容';
    return { ...s, domains };
  } catch {
    return { loggedIn: false, domains: 0 };
  }
}

async function startLogin(site) {
  const chip = $('#chip-login');
  chip.classList.remove('logged-in');
  $('#login-value').textContent = '登录中…';
  $('#btn-login').disabled = true;
  logLine('已打开登录窗口：请扫码或输入账号登录，登录完成后关闭那个窗口即可');
  try {
    const res = await api.loginStart(site);
    if (res.ok) {
      toast(`登录成功：已保存 ${res.count} 项登录状态，现在可以下载高画质了`, 'ok');
      logLine(`登录状态已保存（${res.count} 项 → ${res.file}），之后的下载会自动带上它`, 'ok');
    } else {
      toast(`登录未完成：${res.error || '没有拿到登录状态'}`, 'error');
      logLine(`登录未完成：${res.error || '没有拿到登录状态'}`, 'err');
    }
  } catch (err) {
    toast(`登录失败：${err.message}`, 'error');
  } finally {
    $('#btn-login').disabled = false;
    await refreshLogin();
    const s = await api.getSettings();
    if (s.cookiesFile) $('#cookies-file').value = s.cookiesFile;
  }
}

async function clearLogin() {
  try {
    const res = await api.loginClear();
    toast(res.ok ? `已退出登录（清除 ${res.cleared} 项）` : `退出失败：${res.error}`, res.ok ? 'ok' : 'error');
    logLine(res.ok ? '已清除登录状态' : `清除登录状态失败：${res.error}`, res.ok ? 'ok' : 'err');
    $('#cookies-file').value = '';
  } finally {
    await refreshLogin();
  }
}

// ---------------------------------------------------------------- 主进程事件

function wireEvents() {
  api.onLog((p) => logLine(p.notice ? `ⓘ ${p.message}` : p.message, p.notice ? 'ok' : ''));

  api.onProgress((p) => {
    const task = state.tasks.get(p.taskId);
    if (!task) return;
    const { refs } = task;
    if (p.label && refs.title.textContent === '解析中…') refs.title.textContent = p.label;
    if (p.title) refs.title.textContent = p.title;
    if (p.stage === 'probe') {
      refs.badge.textContent = '解析中';
      return;
    }
    if (p.stage === 'download') {
      if (p.live) {
        // 直播录制：进度条此刻是「已录制多少」，随时可以手动结束
        refs.badge.textContent = p.done ? '收尾中' : '录制中';
        refs.badge.className = 'badge warn';
        refs.btnCancel.hidden = false;
        refs.btnCancel.textContent = '结束录制';
        refs.node.classList.add('recording');
      } else {
        refs.badge.textContent = p.done ? '收尾中' : '下载中';
        refs.badge.className = 'badge';
      }
      const pct = typeof p.percent === 'number' && p.percent >= 0 ? p.percent : -1;
      refs.fill.classList.toggle('indeterminate', pct < 0);
      refs.fill.style.width = pct >= 0 ? `${pct}%` : '';
      refs.pct.textContent = pct >= 0 ? `${pct.toFixed(1)}%` : '—';
      refs.bytes.textContent = p.total ? `${formatBytes(p.bytes)} / ${formatBytes(p.total)}` : formatBytes(p.bytes);
      refs.speed.textContent = formatSpeed(p.speed);
      refs.eta.textContent = p.eta > 0 ? `剩余 ${formatDuration(p.eta)}` : p.live ? '可随时结束' : '';
    }
  });

  api.onDone((p) => {
    const task = state.tasks.get(p.taskId);
    taskFinished(p.taskId);
    // 历史列表在写入后刷新（主进程会发 history:changed，这里兜底再刷一次）
    refreshHistory();
    if (!task) return;
    const { refs } = task;
    refs.node.classList.add('done');
    refs.node.classList.remove('recording');
    refs.fill.classList.remove('indeterminate');
    refs.fill.style.width = '100%';
    refs.title.textContent = p.fileName || p.title || '已完成';
    refs.pct.textContent = '100%';
    refs.bytes.textContent = formatBytes(p.bytes);
    refs.speed.textContent = '';
    refs.eta.textContent = p.stopped
      ? `已保存 ${formatDuration(p.durationSec || 0)}`
      : `耗时 ${formatDuration(p.durationMs / 1000)}`;
    refs.badge.textContent = p.stopped ? '已结束录制' : `完成 · ${p.engine || ''}`;
    refs.badge.className = p.stopped ? 'badge warn' : 'badge ok';
    refs.btnCancel.hidden = true;
    refs.btnOpen.hidden = false;
    refs.btnFolder.hidden = false;
    refs.btnCopy.hidden = false;
    // Pixiv 下的是图片，按钮写"播放"很怪；顺带把"打开"的目标也对准文件
    refs.btnOpen.textContent = String(p.engine || '').includes('pixiv') ? '打开图片' : '播放';
    refs.btnOpen.onclick = () => api.openPath(p.filePath);
    refs.btnFolder.onclick = () => api.showItem(p.filePath);
    refs.btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(p.filePath);
        toast('路径已复制');
      } catch {
        toast('复制失败，请手动复制', 'error');
      }
    };
    logLine(`完成：${p.filePath}（${formatBytes(p.bytes)}）${p.stopped ? '（录制已结束）' : ''}`, 'ok');
    toast(p.stopped ? `录制已结束并保存：${p.fileName}` : `下载完成：${p.fileName}`, 'ok');
  });

  api.onError((p) => {
    const task = state.tasks.get(p.taskId);
    taskFinished(p.taskId);
    if (!task) return;
    const { refs } = task;
    refs.node.classList.add('error');
    refs.fill.classList.remove('indeterminate');
    refs.badge.textContent = p.cancelled ? '已取消' : '失败';
    refs.badge.className = 'badge err';
    refs.btnCancel.hidden = true;
    refs.eta.textContent = p.error ? String(p.error).slice(0, 60) : '';
    logLine(`失败（${task.url}）：${p.error}`, 'err');
    if (!p.cancelled) toast(`下载失败：${p.error}`, 'error');
  });

  api.onSetupProgress((p) => {
    if (p.label) setSetupBar(`正在准备 ${p.label}`, p.percent, p.bytes, p.total);
  });
}

// ---------------------------------------------------------------- 启动

(async function start() {
  bindUi();
  await loadSettings();
  wireEvents();
  await refreshLogin();
  api.onLoginChanged(() => refreshLogin());
  api.onHistoryChanged(() => refreshHistory());
  await refreshHistory();
  logLine('界面已就绪，等待链接…');
  const s = await refreshTools();
  if (!s.ytDlp) logLine('提示：未检测到 yt-dlp，下载 B站/YouTube 等站点时会自动获取（约 20MB）');
  if (!s.ffmpeg) logLine('提示：未安装 ffmpeg，下载 B站等高清视频时会自动获取一次（约 30MB）；如需关闭，取消勾选「自动获取 ffmpeg」');
})();
