'use strict';

/** 预加载脚本：只暴露白名单 API 给渲染进程（contextIsolation 开启） */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('vgrab', {
  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  checkProxy: (proxy) => ipcRenderer.invoke('proxy:check', proxy),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 对话框
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pickCookies: () => ipcRenderer.invoke('dialog:pickCookies'),

  // Pixiv 搜图（不需要代理：公开检索接口 + pixiv.re 反代）
  pixivSearch: (payload) => ipcRenderer.invoke('pixiv:search', payload),
  // 搜图结果的预览图：主进程把本地原图缩成小图（data: URL）后回传
  pixivThumbs: (payload) => ipcRenderer.invoke('pixiv:thumbs', payload),
  // 「只列出」时的远端缩略图（反代上的 240x480 小图，不拉原图）+ 下载选中的作品
  pixivPreviews: (payload) => ipcRenderer.invoke('pixiv:previews', payload),
  pixivDownload: (payload) => ipcRenderer.invoke('pixiv:download', payload),

  // 解析与下载
  probe: (url) => ipcRenderer.invoke('probe', url),
  formats: (url) => ipcRenderer.invoke('formats', url),
  startDownload: (url, options) => ipcRenderer.invoke('download:start', { url, options }),
  cancel: (taskId) => ipcRenderer.invoke('download:cancel', taskId),
  cancelAll: () => ipcRenderer.invoke('download:cancelAll'),

  // 组件管理
  toolsStatus: () => ipcRenderer.invoke('tools:status'),
  getYtDlp: () => ipcRenderer.invoke('tools:getYtDlp'),
  updateYtDlp: () => ipcRenderer.invoke('tools:updateYtDlp'),
  getFfmpeg: () => ipcRenderer.invoke('tools:getFfmpeg'),

  // 从文本里提取有效链接（抖音等分享文案会混着中文和话题标签）
  extractUrls: (text) => ipcRenderer.invoke('urls:extract', text),

  // 下载历史
  historyList: (limit) => ipcRenderer.invoke('history:list', limit),
  historySetLimit: (limit) => ipcRenderer.invoke('history:setLimit', limit),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', id),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyAdd: (record) => ipcRenderer.invoke('history:add', record),
  historyFile: () => ipcRenderer.invoke('history:file'),
  onHistoryChanged: on('history:changed'),

  // 剪贴板（输入框右键菜单）
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),

  // 登录（用内置浏览器登录站点，以获取高画质 / 会员内容）
  loginSites: () => ipcRenderer.invoke('login:sites'),
  loginStatus: () => ipcRenderer.invoke('login:status'),
  loginStart: (site) => ipcRenderer.invoke('login:start', site),
  loginClear: () => ipcRenderer.invoke('login:clear'),
  onLoginChanged: on('login:changed'),

  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),

  // 事件
  onLog: on('log'),
  onProgress: on('task:progress'),
  onDone: on('task:done'),
  onError: on('task:error'),
  onLine: on('task:line'),
  onSetupProgress: on('setup:progress'),
});
