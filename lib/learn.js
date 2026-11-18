// 学习引擎 v1.0.4：喂养式参数记忆
// 学习库按图片原始 尺寸（宽x高）键值存储"能读出正确日期的参数组合"
// 同尺寸新照片处理时优先尝试已学参数（正对横屏/竖屏、分辨率差异导致的识别失败）
const fs = require('fs');
const path = require('path');

const LEARN_FILE = path.join(__dirname, '..', 'learnings.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, stats: { total: 0, hits: 0 } };
  }
}

function save(db) {
  try {
    fs.writeFileSync(LEARN_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('学习库保存失败:', e.message);
  }
}

function keyOf(w, h) { return `${w}x${h}`; }

// 查同尺寸已学参数
function find(w, h) {
  const db = load();
  const e = db.entries[keyOf(w, h)];
  return e ? e.cfg : null;
}

// 记录一条学习（同键覆盖旧记录）
function learn(w, h, cfg, expectedDate, source) {
  const db = load();
  db.entries[keyOf(w, h)] = {
    cfg,
    expected: expectedDate,
    source: source || 'manual',
    ts: Date.now(),
  };
  db.stats.total = Object.keys(db.entries).length;
  save(db);
  return db.entries[keyOf(w, h)];
}

// 命中统计（处理时同尺寸学习参数确实读对了）
function markHit(w, h, ok) {
  const db = load();
  db.stats.hits = (db.stats.hits || 0) + (ok ? 1 : 0);
  save(db);
}

function list() {
  const db = load();
  return Object.entries(db.entries).map(([k, v]) => ({ dims: k, ...v }));
}

// 学习统计（v1.0.8 批次5：累计学习条数据源）
function stats() {
  return load().stats || { total: 0, hits: 0 };
}

function remove(dims) {
  const db = load();
  delete db.entries[dims];
  db.stats.total = Object.keys(db.entries).length;
  save(db);
}

function clear() {
  save({ entries: {}, stats: { total: 0, hits: 0 } });
}

module.exports = { find, learn, markHit, list, remove, clear, stats, LEARN_FILE };
