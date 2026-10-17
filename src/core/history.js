'use strict';

/**
 * 下载历史：把每次任务的结果记录到 history.json（默认保留最近 20 条，条数可设置）。
 * 命令行与图形界面共用同一个文件（都放在工具目录下），所以两边看到的历史是一致的。
 */

const fs = require('fs');
const path = require('path');
const { toolsDir } = require('./config');
const { ensureDir, randomId } = require('./util');

const DEFAULT_LIMIT = 20;
const HARD_CAP = 2000; // 防止设置得过大导致文件失控

/** 历史文件位置（与 yt-dlp / 登录状态放在同一目录，便于 CLI 与界面共享） */
function historyFile() {
  return process.env.VIDEOGRAB_HISTORY_FILE || path.join(toolsDir(), 'history.json');
}

/** 规范化条数设置：非法值回退默认，并限制在 1~HARD_CAP */
function normalizeLimit(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(HARD_CAP, Math.round(v)));
}

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (Array.isArray(parsed)) return { version: 1, limit: DEFAULT_LIMIT, records: parsed };
    if (parsed && Array.isArray(parsed.records)) {
      return { version: parsed.version || 1, limit: normalizeLimit(parsed.limit), records: parsed.records };
    }
  } catch {
    /* 文件不存在或损坏时视为空历史 */
  }
  return { version: 1, limit: DEFAULT_LIMIT, records: [] };
}

/** 统一的排序：时间新 → 旧（读取、裁剪都用它，保证「保留最新 N 条」的语义一致） */
function sortRecords(records) {
  return (records || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

/** 读取历史（时间新→旧）。limit 可选，用于只取前 N 条 */
function loadHistory(limit) {
  const { records } = readRaw();
  const list = sortRecords(records);
  if (limit && Number(limit) > 0) return list.slice(0, normalizeLimit(limit));
  return list;
}

/** 当前记录条数设置（未显式指定时用它） */
function currentLimit() {
  return normalizeLimit(readRaw().limit);
}

/** 只保留关心的字段，避免把超大对象写进历史 */
function sanitize(record = {}) {
  const str = (v, max) => {
    if (v == null) return '';
    const s = String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    id: record.id ? String(record.id) : randomId('h'),
    url: str(record.url, 800),
    title: str(record.title, 200),
    fileName: str(record.fileName, 200),
    filePath: str(record.filePath, 600),
    outDir: str(record.outDir, 400),
    engine: str(record.engine, 30),
    quality: str(record.quality, 20),
    bytes: num(record.bytes),
    durationSec: num(record.durationSec),
    elapsedMs: num(record.elapsedMs),
    ok: Boolean(record.ok),
    stopped: Boolean(record.stopped),
    live: Boolean(record.live),
    cancelled: Boolean(record.cancelled),
    error: str(record.error, 500),
    at: num(record.at) || Date.now(),
  };
}

// 串行写入，避免多个任务同时完成时互相覆盖
let writeChain = Promise.resolve();

/**
 * 追加一条记录（新记录在前），并按条数限制裁剪。
 * @param {object} record
 * @param {number} [limit] 不传则沿用文件里保存的设置
 */
function appendHistory(record, limit) {
  const explicit = Number(limit) > 0 ? normalizeLimit(limit) : null;
  writeChain = writeChain
    .then(() => {
      const raw = readRaw();
      const max = explicit || normalizeLimit(raw.limit);
      const list = [sanitize(record), ...raw.records];
      const trimmed = sortRecords(list).slice(0, Math.min(HARD_CAP, Math.max(1, max)));
      ensureDir(path.dirname(historyFile()));
      fs.writeFileSync(
        historyFile(),
        JSON.stringify({ version: 1, limit: max, updatedAt: Date.now(), records: trimmed }, null, 2),
        'utf8',
      );
      return trimmed;
    })
    .catch(() => []);
  return writeChain;
}

/** 只更新条数设置（并按新设置裁剪已有记录） */
function setHistoryLimit(limit) {
  const max = normalizeLimit(limit);
  writeChain = writeChain
    .then(() => {
      const raw = readRaw();
      const records = sortRecords(raw.records).slice(0, max);
      ensureDir(path.dirname(historyFile()));
      fs.writeFileSync(
        historyFile(),
        JSON.stringify({ version: 1, limit: max, updatedAt: Date.now(), records }, null, 2),
        'utf8',
      );
      return { limit: max, records };
    })
    .catch(() => ({ limit: max, records: [] }));
  return writeChain;
}

/** 删除一条记录（按 id） */
function removeHistory(id) {
  writeChain = writeChain
    .then(() => {
      const raw = readRaw();
      const records = raw.records.filter((r) => r && r.id !== id);
      ensureDir(path.dirname(historyFile()));
      fs.writeFileSync(
        historyFile(),
        JSON.stringify({ version: 1, limit: normalizeLimit(raw.limit), updatedAt: Date.now(), records }, null, 2),
        'utf8',
      );
      return records;
    })
    .catch(() => []);
  return writeChain;
}

/** 清空历史（保留条数设置） */
function clearHistory() {
  writeChain = writeChain
    .then(() => {
      const raw = readRaw();
      ensureDir(path.dirname(historyFile()));
      fs.writeFileSync(
        historyFile(),
        JSON.stringify({ version: 1, limit: normalizeLimit(raw.limit), updatedAt: Date.now(), records: [] }, null, 2),
        'utf8',
      );
      return [];
    })
    .catch(() => []);
  return writeChain;
}

module.exports = {
  DEFAULT_LIMIT,
  HARD_CAP,
  historyFile,
  normalizeLimit,
  currentLimit,
  loadHistory,
  appendHistory,
  setHistoryLimit,
  removeHistory,
  clearHistory,
  sanitize,
};
