// 本地 OCR 水印照片分类服务 v1.0.4 — 端口 3872
// v1.0.4：学习喂养 + 任务暂停/继续/停止 + 进度持久化
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const rec = require('./lib/recognizer');
const learn = require('./lib/learn');

const PORT = parseInt(process.env.PORT, 10) || 3872; // 可用环境变量 PORT 覆盖
// OCR 并行度（v1.0.9）：按 CPU 核数自适应 2~4，前后端共用（前端经 /api/logs 获取）
// ---------- 并行线程（v1.2.1：自适应 / 自定义，运行时可调） ----------
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { threadMode: 'auto', threads: 4 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch (e) { /* 首次运行无文件 */ }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { /* 忽略 */ } }
// 按 CPU 线程数与内存给出建议并行数
function recommendedThreads() {
  const t = os.cpus().length, memGB = os.totalmem() / 1073741824;
  let r = t <= 4 ? 2 : t <= 8 ? 4 : t <= 16 ? 6 : 8;
  if (memGB < 8) r = Math.min(r, 2);
  else if (memGB < 12) r = Math.min(r, 4);
  return Math.max(1, Math.min(12, r));
}
function currentThreads() {
  if (settings.threadMode === 'custom') {
    const n = parseInt(settings.threads, 10);
    return Math.max(1, Math.min(16, n > 0 ? n : 2));
  }
  return recommendedThreads();
}

// ---------- 引擎（v1.2.1：PaddleOCR 系 RapidOCR-json 为主，Tesseract.js 兜底） ----------
let engineLogged = false;
async function ensureEngine() {
  if (rec.paddleAvailable()) {
    if (!engineLogged) { engineLogged = true; log('OCR 引擎：' + rec.engineLabel() + ' 已就绪（每张独立进程，并行 ' + currentThreads() + ' 路）'); }
    return true;
  }
  await rec.initWorkers(currentThreads(), log).catch(e => log('OCR 引擎初始化失败：' + e.message));
  return rec.getWorkerCount() > 0;
}
const PARALLEL = () => rec.paddleAvailable() ? currentThreads() : Math.min(Math.max(1, rec.getWorkerCount()), 4);
function takeWorker() { return rec.paddleAvailable() ? null : rec.acquireWorker(); }
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);
const DATE_DIR_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const TMP_DIR = path.join(__dirname, '_learning_tmp');

// 兜底：模型下载失败等异常不致进程崩溃
process.on('unhandledRejection', err => log(`未处理异常：${err && err.message}`));
process.on('uncaughtException', err => log(`未捕获异常：${err && err.message}`));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 日志 ----------
const logs = [];
const cats = []; // 与 logs 平行的分类标签
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.log$/; // 存档文件名白名单（防路径穿越）
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function log(msg, cat) {
  // 自动分类（v1.0.8 批次5）：识别 / 学习 / 失败 / 系统
  if (!cat) {
    if (/失败|⚠|❌|异常|未识别水印/.test(msg)) cat = 'fail';
    else if (/学习|喂养|已学会|已学习/.test(msg)) cat = 'learn';
    else if (/✔|归档|重跑|扫描|试提取|手动改归类/.test(msg)) cat = 'recognize';
    else cat = 'system';
  }
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  logs.push(line);
  cats.push(cat);
  if (logs.length > 2000) { logs.shift(); cats.shift(); }
  console.log(line);
  // v1.0.10：按日期存档到 logs/YYYY-MM-DD.log
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, todayStr() + '.log'), line + '\n', 'utf8');
  } catch (e) { /* 存档失败不影响运行 */ }
}

// ---------- 任务状态（持久化，刷新/重启可恢复显示） ----------
const JOB_FILE = path.join(__dirname, 'job_state.json');
let job = null;
let state = { running: false, paused: false, stopped: false };

function saveJob() {
  try { fs.writeFileSync(JOB_FILE, JSON.stringify(job), 'utf8'); } catch (e) { /* 忽略 */ }
}
function loadJob() {
  try {
    job = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    if (job && job.running) { job.running = false; job.paused = false; saveJob(); }
  } catch (e) { job = null; }
}
loadJob();

function newJob(type, extra) {
  job = {
    type,
    running: true, paused: false, stopped: false,
    stats: { total: 0, done: 0, sorted: 0, unknown: 0, failed: 0 },
    files: [],
    current: '',
    startedAt: Date.now(),
    ...extra,
  };
  saveJob();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitWhilePaused(send) {
  while (state.paused && !state.stopped) {
    if (job && !job.paused) { job.paused = true; saveJob(); if (send) send({ type: 'paused' }); }
    await sleep(300);
  }
  if (job && job.paused && !state.stopped) {
    job.paused = false; saveJob();
    if (send) send({ type: 'resumed' });
    log('任务已继续');
  }
}

// ---------- 工具 ----------
function listImages(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (IMAGE_EXT.has(ext)) out.push({ name: e.name, path: path.join(dir, e.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return out;
}

function safeMove(src, dstDir, name) {
  fs.mkdirSync(dstDir, { recursive: true });
  let dst = path.join(dstDir, name);
  let i = 1;
  while (fs.existsSync(dst)) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    dst = path.join(dstDir, `${base}(${i})${ext}`);
    i++;
  }
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); } else throw e;
  }
  return dst;
}

function parseDateStr(s) {
  const m = String(s || '').trim().match(DATE_DIR_RE);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (y < 2000 || y > 2038 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

// ---------- API ----------
app.post('/api/scan', (req, res) => {
  try {
    const dir = String(req.body.dir || '').trim().replace(/^"|"$/g, '');
    if (!dir || !fs.existsSync(dir)) return res.json({ ok: false, error: '目录不存在：' + dir });
    const files = listImages(dir);
    log(`扫描 ${dir}：${files.length} 张图片`);
    res.json({ ok: true, count: files.length, files });
  } catch (e) {
    log(`扫描失败：${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// 路径模式归档（SSE，支持暂停/继续/停止）
app.post('/api/process', async (req, res) => {
  if (state.running) return res.json({ ok: false, error: '已有任务在运行中' });
  const srcDir = String(req.body.srcDir || '').trim().replace(/^"|"$/g, '');
  const outDir = String(req.body.outDir || '').trim().replace(/^"|"$/g, '') || srcDir;
  const cfg = req.body.cfg || null;
  if (!fs.existsSync(srcDir)) return res.json({ ok: false, error: '源目录不存在：' + srcDir });

  sseHead(res);
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  state.running = true; state.paused = false; state.stopped = false;
  await ensureEngine();
  if (!rec.paddleAvailable() && rec.getWorkerCount() === 0) {
    send({ type: 'done', stats: { total: 0, done: 0, sorted: 0, unknown: 0, failed: 0 }, error: 'OCR 引擎未就绪，请查看日志' });
    res.end();
    state.running = false;
    return;
  }
  const files = listImages(srcDir);
  const stats = { total: files.length, done: 0, sorted: 0, unknown: 0, failed: 0 };
  newJob('path', { srcDir, outDir, stats, files: files.map(f => ({ name: f.name, path: f.path, status: 'pending' })) });
  log(`开始归档：${srcDir}（共 ${files.length} 张）`);
  send({ type: 'start', stats, outDir });

  let idx = 0;
  async function runOne() {
    while (true) {
      if (state.stopped) return;
      const i = idx++;
      if (i >= files.length) return;
      await waitWhilePaused(send);
      if (state.stopped) return;
      const f = files[i];
      job.current = f.name; job.files[i] = { name: f.name, path: f.path, status: 'processing' }; saveJob();
      send({ type: 'file', index: i, name: f.name, path: f.path, status: 'processing' });
      let worker = null;
      try {
        worker = rec.acquireWorker();
        const { date, text } = await rec.recognizeOnWorker(worker, f.path, cfg);
        if (date) {
          const folder = `${date.y}.${date.mo}.${date.d}`;
          const dst = safeMove(f.path, path.join(outDir, folder), f.name);
          stats.sorted++;
          log(`✔ ${f.name} → ${folder}/`);
          job.files[i] = { name: f.name, path: dst, status: 'sorted', folder }; saveJob();
          send({ type: 'file', index: i, name: f.name, path: dst, status: 'sorted', folder });
        } else {
          const dst = safeMove(f.path, path.join(outDir, '未识别'), f.name);
          stats.unknown++;
          log(`✖ 未识别水印：${f.name}（OCR片段：${(text || '').slice(0, 60)}）`);
          job.files[i] = { name: f.name, path: dst, status: 'unknown', folder: '未识别' }; saveJob();
          send({ type: 'file', index: i, name: f.name, path: dst, status: 'unknown', folder: '未识别' });
        }
      } catch (e) {
        stats.failed++;
        log(`⚠ 处理失败：${f.name} — ${e.message}`);
        job.files[i] = { name: f.name, path: f.path, status: 'failed' }; saveJob();
        send({ type: 'file', index: i, name: f.name, path: f.path, status: 'failed', error: e.message });
      } finally {
        if (worker) rec.releaseWorker(worker);
        stats.done++;
        job.stats = { ...stats }; saveJob();
        send({ type: 'progress', stats, current: f.name, percent: Math.round(stats.done / Math.max(1, stats.total) * 100) });
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL() }, runOne));

  job.running = false; job.stopped = state.stopped; job.stats = { ...stats }; saveJob();
  const word = state.stopped ? '已停止' : '完成';
  log(`归档${word}：归类 ${stats.sorted}，未识别 ${stats.unknown}，失败 ${stats.failed}`);
  send({ type: 'done', stats, stopped: state.stopped, percent: 100 });
  res.end();
  state.running = false;
});

// 拖拽模式进度上报（前端逐张汇报，服务端持久化，刷新可恢复显示）
app.post('/api/job/report', (req, res) => {
  const t = String(req.body.type || '');
  if (t === 'start') {
    newJob('handle', { stats: req.body.stats || { total: 0, done: 0, sorted: 0, unknown: 0, failed: 0 }, files: [] });
  } else if (job) {
    if (t === 'file' && typeof req.body.index === 'number') {
      job.files[req.body.index] = { name: req.body.name, status: req.body.status, folder: req.body.folder || null };
      if (req.body.status === 'processing') job.current = req.body.name;
    } else if (t === 'progress') {
      job.stats = req.body.stats || job.stats;
      job.current = req.body.current || job.current;
    } else if (t === 'done') {
      job.running = false; job.stats = req.body.stats || job.stats;
    } else if (t === 'paused') { job.paused = true; }
    else if (t === 'resumed') { job.paused = false; }
    else if (t === 'stopped') { job.running = false; job.stopped = true; }
    else if (t === 'error') { log(`前端处理失败 #${req.body.index}：${req.body.message}`); }
    saveJob();
  }
  res.json({ ok: true });
});

app.get('/api/job', (req, res) => res.json({ ok: true, job, running: state.running }));

app.post('/api/job/pause', (req, res) => {
  state.paused = true;
  if (job && job.running) { job.paused = true; saveJob(); }
  log('任务暂停中（处理完当前这张后停下）…');
  res.json({ ok: true });
});
app.post('/api/job/resume', (req, res) => {
  state.paused = false;
  res.json({ ok: true });
});
app.post('/api/job/stop', (req, res) => {
  state.stopped = true; state.paused = false;
  log('任务停止请求已发出…');
  res.json({ ok: true });
});
app.delete('/api/job', (req, res) => {
  if (state.running) return res.json({ ok: false, error: '任务运行中，请先停止' });
  job = null;
  try { fs.unlinkSync(JOB_FILE); } catch (e) {}
  log('进度记录已清空');
  res.json({ ok: true });
});

app.get('/api/file', (req, res) => {
  const p = String(req.query.p || '');
  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_EXT.has(ext) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.get('/api/browse', (req, res) => {
  try {
    const dir = String(req.query.dir || '').trim();
    if (!dir || !fs.existsSync(dir)) return res.json({ ok: false, error: '目录不存在' });
    const folders = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const fp = path.join(dir, e.name);
        const imgs = fs.readdirSync(fp).filter(n => IMAGE_EXT.has(path.extname(n).toLowerCase()));
        return { name: e.name, path: fp, count: imgs.length, files: imgs };
      })
      .filter(f => f.count > 0)
      .sort((a, b) => {
        if (a.name === '未识别' || a.name === '识别错误') return 1;
        if (b.name === '未识别' || b.name === '识别错误') return -1;
        return b.name.localeCompare(a.name);
      });
    res.json({ ok: true, dir, folders });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/open', (req, res) => {
  const dir = String(req.body.dir || '');
  if (!fs.existsSync(dir)) return res.json({ ok: false, error: '目录不存在' });
  execFile('explorer', [dir], () => {});
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => res.json({ ok: true, logs, cats, workerCount: currentThreads(), threads: { mode: settings.threadMode, value: currentThreads(), recommended: recommendedThreads() }, defaultCfg: rec.DEFAULT_CFG }));

// v1.2.1：电脑配置 + 线程设置
app.get('/api/sys', (req, res) => {
  try {
    const cpus = os.cpus();
    res.json({
      ok: true,
      cpu: (cpus[0] && cpus[0].model || '未知').replace(/\s+/g, ' ').trim(),
      cores: cpus.length,
      memGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
      platform: os.platform() + ' ' + os.arch(),
      engine: rec.engineLabel(),
      recommended: recommendedThreads(),
      mode: settings.threadMode,
      value: currentThreads(),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/threads', (req, res) => {
  const mode = String(req.body.mode || 'auto');
  const n = parseInt(req.body.value, 10);
  if (mode === 'custom') {
    if (!(n >= 1 && n <= 16)) return res.json({ ok: false, error: '线程数需在 1~16 之间' });
    settings.threadMode = 'custom'; settings.threads = n;
  } else {
    settings.threadMode = 'auto';
  }
  saveSettings();
  log(`识别并行数已设为 ${currentThreads()} 路（${settings.threadMode === 'auto' ? '自适应，本机建议 ' + recommendedThreads() : '自定义'}）`);
  res.json({ ok: true, mode: settings.threadMode, value: currentThreads(), recommended: recommendedThreads() });
});

// v1.0.10：日志存档管理（按日期文件）
app.get('/api/log-files', (req, res) => {
  try {
    const files = fs.existsSync(LOGS_DIR)
      ? fs.readdirSync(LOGS_DIR)
          .filter(n => LOG_FILE_RE.test(n))
          .map(n => { const st = fs.statSync(path.join(LOGS_DIR, n)); return { name: n, size: st.size }; })
          .sort((a, b) => b.name.localeCompare(a.name))
      : [];
    res.json({ ok: true, files });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/log-file', (req, res) => {
  const name = String(req.query.name || '');
  if (!LOG_FILE_RE.test(name)) return res.json({ ok: false, error: '文件名非法' });
  try {
    const p = path.join(LOGS_DIR, name);
    if (!fs.existsSync(p)) return res.json({ ok: false, error: '存档不存在' });
    res.json({ ok: true, name, content: fs.readFileSync(p, 'utf8') });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/log-delete', (req, res) => {
  const name = String(req.body.name || '');
  if (!LOG_FILE_RE.test(name)) return res.json({ ok: false, error: '文件名非法' });
  try {
    const p = path.join(LOGS_DIR, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    log('已删除日志存档：' + name);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/logs/clear', (req, res) => {
  logs.length = 0; cats.length = 0;
  log('页面日志已清空（本地日期存档不受影响）');
  res.json({ ok: true });
});

// 单张 OCR（支持实时调参 + 手动框选区域）
app.post('/api/ocr', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    await ensureEngine();
    const worker = takeWorker();
    if ((!rec.paddleAvailable() && !worker) || !req.body || !req.body.length) {
      if (worker) rec.releaseWorker(worker);
      return res.json({ ok: false, error: 'OCR 引擎未就绪或图片数据为空' });
    }
    let cfg = null;
    try { cfg = req.query.cfg ? JSON.parse(req.query.cfg) : null; } catch (e) { cfg = null; }
    // v1.0.9：实时识别日志（拖拽模式识别发生在前端，此前首页工作日志看不到识别步骤）
    const qname = String(req.query.name || '');
    const isPreview = String(req.query.preview || '') === '1';
    const label = qname || '灯箱预览';
    log((isPreview ? '🔍 预览识别：' : '🔍 识别：') + label + (cfg && cfg.customRegion ? '（框选区域）' : ''), 'recognize');
    try {
      const { date, text } = await rec.recognizeOnWorker(worker, req.body, cfg);
      if (date) log(`✔ ${label} → ${date.y}.${date.mo}.${date.d}`, 'recognize');
      else log(`✖ ${label} 未识别到日期（OCR片段：${(text || '').slice(0, 60)}）`, 'recognize');
      // v1.0.8：无水印判定从严——只要有任何 ≥2 位连续字母/数字（时间/日期/编号碎片）都算有水印，
      // 仅当 OCR 全部变体几乎读不到字符（纯符号/空白）才算「无水印」
      const wmLike = date ? undefined : /[0-9A-Za-z]{2,}/.test(String(text || '').replace(/\s+/g, ' '));
      // 诊断建议（v1.0.8 批次4：试提取失败时告诉用户大概率原因）
      let hint = '';
      if (!date && cfg.threshold > 0 && cfg.invert !== 'on') {
        hint = '当前是「手动阈值' + cfg.threshold + '+未反色」组合：白字和浅色背景都会被切成白色，OCR 无字可读。白字水印请开反色，或把阈值模式改回自适应。';
      } else if (!date && cfg.threshold === 0 && cfg.region !== 'auto') {
        hint = '未开二值化：若背景与文字对比度低（白字压浅色墙面等），建议阈值模式改回自适应。';
      }
      res.json({ ok: true, date, wm: wmLike, hint, text: String(text || '').slice(0, 600) });
    } finally {
      if (worker) rec.releaseWorker(worker);
    }
  } catch (e) {
    log(`/api/ocr 失败：${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// 按路径识别单个文件（学习/纠错后复查用）
app.post('/api/recognize-file', async (req, res) => {
  try {
    const p = String(req.body.path || '');
    if (!fs.existsSync(p)) return res.json({ ok: false, error: '文件不存在' });
    await ensureEngine();
    const worker = takeWorker();
    if (!rec.paddleAvailable() && !worker) return res.json({ ok: false, error: 'OCR 引擎未就绪' });
    try {
      const { date, text } = await rec.recognizeOnWorker(worker, p, req.body.cfg || null);
      res.json({ ok: true, date, text: String(text || '').slice(0, 300) });
    } finally { if (worker) rec.releaseWorker(worker); }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 学习：纠错（识别出错 → 输入正确日期 → 网格搜索能读对的参数并记住）
app.post('/api/learn', async (req, res) => {
  try {
    const imagePath = String(req.body.imagePath || '');
    const expected = parseDateStr(req.body.expected);
    if (!fs.existsSync(imagePath)) return res.json({ ok: false, error: '图片文件不存在' });
    if (!expected) return res.json({ ok: false, error: '日期格式应为 2026.4.17' });
    if (rec.paddleAvailable()) return res.json({ ok: false, error: '当前引擎为 PaddleOCR 系，无需参数搜索：直接重新识别，或在灯箱框选后用「试提取」' });
    await ensureEngine();
    const worker = takeWorker();
    if (!worker) return res.json({ ok: false, error: 'OCR 引擎未就绪' });
    try {
      log(`学习搜索：${path.basename(imagePath)} 期望 ${expected.y}.${expected.mo}.${expected.d}`);
      const r = await rec.searchLearning(worker, imagePath, expected,
        (i, n) => { if (i % 5 === 0) log(`  学习搜索进度 ${i}/${n}`); });
      if (!r.found) {
        log(`学习搜索未找到能读出 ${expected.y}.${expected.mo}.${expected.d} 的参数（可尝试手动框选区域）`);
        return res.json({ ok: true, found: false });
      }
      const { Jimp } = require('jimp');
      const img = await Jimp.read(imagePath);
      learn.learn(img.bitmap.width, img.bitmap.height, r.cfg, expected, 'correction');
      log(`✅ 已学习：${img.bitmap.width}x${img.bitmap.height} → 参数 ${JSON.stringify(r.cfg)}`);
      res.json({ ok: true, found: true, cfg: r.cfg });
    } finally { rec.releaseWorker(worker); }
  } catch (e) {
    log(`/api/learn 失败：${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// 学习：拖拽模式上传图片二进制 + 期望日期（图片只传一次）
const learnProgress = new Map(); // v1.0.8 批次4：学习搜索进度上报（pid -> {i,n}）
app.get('/api/learn-progress', (req, res) => {
  const pid = String(req.query.pid || '');
  const p = learnProgress.get(pid);
  res.json({ ok: true, i: p ? p.i : 0, n: p ? p.n : 0 });
});
app.post('/api/learn-upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    const expected = parseDateStr(req.query.expected);
    const pid = String(req.query.pid || '');
    const w = parseInt(req.query.w, 10), h = parseInt(req.query.h, 10);
    if (!req.body || !req.body.length) return res.json({ ok: false, error: '图片数据为空' });
    if (!expected) return res.json({ ok: false, error: '日期格式应为 2026.4.17' });
    if (rec.paddleAvailable()) return res.json({ ok: false, error: '当前引擎为 PaddleOCR 系，无需参数搜索：直接重新识别，或在灯箱框选后用「试提取」' });
    await ensureEngine();
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmp = path.join(TMP_DIR, `learn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(String(req.query.name || 'x.jpg')) || '.jpg'}`);
    fs.writeFileSync(tmp, req.body);
    const worker = rec.acquireWorker();
    if (!worker) { fs.unlinkSync(tmp); return res.json({ ok: false, error: 'OCR 引擎未就绪' }); }
    try {
      log(`学习搜索：${path.basename(tmp)} 期望 ${expected.y}.${expected.mo}.${expected.d}`);
      const r = await rec.searchLearning(worker, tmp, expected,
        (i, n) => { if (pid) learnProgress.set(pid, { i, n }); if (i % 10 === 0) log(`  学习搜索进度 ${i}/${n}`); });
      if (r.found) {
        let useW = w > 0 ? w : null, useH = h > 0 ? h : null;
        if (!useW || !useH) {
          // v1.0.6：未传尺寸时从图片自身读取（学习模式/试提取调用）
          try {
            const { Jimp } = require('jimp');
            const im = await Jimp.read(tmp);
            useW = im.bitmap.width; useH = im.bitmap.height;
          } catch (e) { /* 读尺寸失败则不记录 */ }
        }
        if (useW && useH) {
          learn.learn(useW, useH, r.cfg, expected, 'upload');
          log(`✅ 已学习：${useW}x${useH} → ${JSON.stringify(r.cfg)}`);
        }
        learnProgress.delete(pid);
        res.json({ ok: true, found: true, cfg: r.cfg, w: useW, h: useH });
      } else {
        learnProgress.delete(pid);
        res.json({ ok: true, found: false });
      }
    } finally {
      rec.releaseWorker(worker);
      try { fs.unlinkSync(tmp); } catch (e) {}
    }
  } catch (e) {
    log(`/api/learn-upload 失败：${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

// 学习：手动框选区域后直接保存参数（不做搜索）
app.post('/api/learn-save', (req, res) => {
  try {
    const w = parseInt(req.body.w, 10), h = parseInt(req.body.h, 10);
    const expected = parseDateStr(req.body.expected);
    const cfg = req.body.cfg;
    if (!(w > 0 && h > 0)) return res.json({ ok: false, error: '缺少图片尺寸' });
    if (!cfg) return res.json({ ok: false, error: '缺少参数' });
    // v1.0.9 热修：框选必须有效（有面积），防止单击产生的零面积框污染学习库
    if (cfg.customRegion) {
      const cr = cfg.customRegion;
      const valid = [cr.x0, cr.y0, cr.x1, cr.y1].every(v => typeof v === 'number' && v >= 0 && v <= 1)
        && cr.x1 - cr.x0 >= 0.01 && cr.y1 - cr.y0 >= 0.01;
      if (!valid) return res.json({ ok: false, error: '框选区域无效（面积近乎为零）。请按住鼠标拖出一个框，框住日期文字后再保存' });
    }
    learn.learn(w, h, cfg, expected, 'region');
    log(`✅ 已学习（手动框选）：${w}x${h} → ${JSON.stringify(cfg)}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 喂养：扫描 未识别/<正确日期>/ 里的照片，逐张学习并自动归位（路径模式，SSE）
app.post('/api/feed', async (req, res) => {
  if (state.running) return res.json({ ok: false, error: '已有任务在运行中' });
  const dir = String(req.body.dir || '').trim().replace(/^"|"$/g, '');
  const unknownDir = path.join(dir, '未识别');
  if (!fs.existsSync(unknownDir)) return res.json({ ok: false, error: '未找到「未识别」文件夹' });

  sseHead(res);
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  state.running = true; state.paused = false; state.stopped = false;
  await ensureEngine();
  const worker = takeWorker();
  if (!rec.paddleAvailable() && !worker) { send({ type: 'done', stats: { total: 0, learned: 0, moved: 0 } }); res.end(); state.running = false; return; }

  try {
    // 收集喂养清单
    const tasks = [];
    for (const e of fs.readdirSync(unknownDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const expected = parseDateStr(e.name);
      if (!expected) continue;
      for (const f of listImages(path.join(unknownDir, e.name))) {
        tasks.push({ path: f.path, name: f.name, expected });
      }
    }
    const stats = { total: tasks.length, learned: 0, moved: 0 };
    log(`喂养学习：共 ${tasks.length} 张（未识别/<日期>/）`);
    send({ type: 'start', stats });
    for (let i = 0; i < tasks.length; i++) {
      if (state.stopped) break;
      await waitWhilePaused(send);
      if (state.stopped) break;
      const t = tasks[i];
      send({ type: 'file', index: i, name: t.name, path: t.path, status: 'processing' });
      try {
        let r;
        if (rec.paddleAvailable()) {
          // v1.2.1：Paddle 引擎不需要参数学习，直接重新识别，日期与文件夹一致即归位
          const rr = await rec.recognizeOnWorker(null, t.path, null);
          r = { found: false };
          if (rr.date) {
            const got = rr.date.y * 10000 + rr.date.mo * 100 + rr.date.d;
            const exp = t.expected.y * 10000 + t.expected.mo * 100 + t.expected.d;
            if (got === exp) r = { found: true, cfg: null, direct: true };
          }
        } else {
          r = await rec.searchLearning(worker, t.path, t.expected);
        }
        if (r.found) {
          stats.learned++;
          if (!r.direct) {
            const { Jimp } = require('jimp');
            const img = await Jimp.read(t.path);
            learn.learn(img.bitmap.width, img.bitmap.height, r.cfg, t.expected, 'feed');
          }
          // 归位到正确日期目录
          const dst = safeMove(t.path, path.join(dir, `${t.expected.y}.${t.expected.mo}.${t.expected.d}`), t.name);
          stats.moved++;
          log(`✅ 喂养成功：${t.name} → ${t.expected.y}.${t.expected.mo}.${t.expected.d}/（参数已记住）`);
          send({ type: 'file', index: i, name: t.name, path: dst, status: 'learned', folder: `${t.expected.y}.${t.expected.mo}.${t.expected.d}` });
        } else {
          log(`⚠ 喂养未找到参数：${t.name}（可手动框选区域后保存学习）`);
          send({ type: 'file', index: i, name: t.name, path: t.path, status: 'notfound' });
        }
      } catch (e) {
        send({ type: 'file', index: i, name: t.name, path: t.path, status: 'failed', error: e.message });
      }
      send({ type: 'progress', stats, percent: Math.round((i + 1) / Math.max(1, stats.total) * 100) });
    }
    send({ type: 'done', stats, stopped: state.stopped });
  } finally {
    rec.releaseWorker(worker);
    res.end();
    state.running = false;
  }
});

// 学习库查看/清空
// 删除单条学习（v1.0.8：按尺寸键删除，用于纠正错误学习）
app.post('/api/learnings/remove', (req, res) => {
  learn.remove(String(req.body.dims || ''));
  log('已删除学习条目：' + req.body.dims);
  res.json({ ok: true });
});
app.get('/api/learnings', (req, res) => {
  const st = learn.stats();
  const src = { auto: 0, feed: 0, correction: 0, region: 0, upload: 0 };
  for (const e of learn.list()) { if (src[e.source] !== undefined) src[e.source]++; }
  res.json({ ok: true, entries: learn.list(), stats: { total: learn.list().length, hits: st.hits || 0, src } });
});
app.post('/api/learnings/clear', (req, res) => {
  learn.clear();
  log('学习库已清空');
  res.json({ ok: true });
});

// 手动改归类
app.post('/api/move', (req, res) => {
  try {
    const src = String(req.body.srcPath || '');
    const dstDir = String(req.body.dstDir || '');
    if (!fs.existsSync(src)) return res.json({ ok: false, error: '源文件不存在' });
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
    const name = path.basename(src);
    let dst = path.join(dstDir, name);
    let i = 1;
    while (fs.existsSync(dst)) {
      const ext = path.extname(name);
      dst = path.join(dstDir, `${path.basename(name, ext)}(${i})${ext}`);
      i++;
    }
    try { fs.renameSync(src, dst); } catch (e) {
      if (e.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); } else throw e;
    }
    log(`手动改归类：${name} → ${dstDir}`);
    res.json({ ok: true, dst });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 重跑未识别
app.post('/api/rerun', async (req, res) => {
  if (state.running) return res.json({ ok: false, error: '已有任务在运行中' });
  const dir = String(req.body.dir || '').trim().replace(/^"|"$/g, '');
  const cfg = req.body.cfg || null;
  const unknownDir = path.join(dir, '未识别');
  if (!fs.existsSync(unknownDir)) return res.json({ ok: false, error: '未找到「未识别」文件夹' });

  sseHead(res);
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  state.running = true; state.paused = false; state.stopped = false;
  await ensureEngine();
  const files = listImages(unknownDir);
  const stats = { total: files.length, done: 0, sorted: 0, unknown: 0, failed: 0 };
  newJob('rerun', { srcDir: dir, stats, files: files.map(f => ({ name: f.name, path: f.path, status: 'pending' })) });
  log(`重跑未识别（新参数）：共 ${files.length} 张`);
  send({ type: 'start', stats });

  let idx = 0;
  async function runOne() {
    while (true) {
      if (state.stopped) return;
      const i = idx++;
      if (i >= files.length) return;
      await waitWhilePaused(send);
      if (state.stopped) return;
      const f = files[i];
      job.current = f.name; saveJob();
      send({ type: 'file', index: i, name: f.name, path: f.path, status: 'processing' });
      let worker = null;
      try {
        worker = rec.acquireWorker();
        const { date } = await rec.recognizeOnWorker(worker, f.path, cfg);
        if (date) {
          const folder = `${date.y}.${date.mo}.${date.d}`;
          safeMove(f.path, path.join(dir, folder), f.name);
          stats.sorted++;
          log(`✔ ${f.name} → ${folder}/`);
          job.files[i] = { name: f.name, status: 'sorted', folder }; saveJob();
          send({ type: 'file', index: i, name: f.name, status: 'sorted', folder });
        } else {
          stats.unknown++;
          job.files[i] = { name: f.name, status: 'unknown', folder: '未识别' }; saveJob();
          send({ type: 'file', index: i, name: f.name, status: 'unknown', folder: '未识别' });
        }
      } catch (e) {
        stats.failed++;
        job.files[i] = { name: f.name, status: 'failed' }; saveJob();
        send({ type: 'file', index: i, name: f.name, status: 'failed', error: e.message });
      } finally {
        if (worker) rec.releaseWorker(worker);
        stats.done++;
        job.stats = { ...stats }; saveJob();
        send({ type: 'progress', stats, percent: Math.round(stats.done / Math.max(1, stats.total) * 100) });
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL() }, runOne));
  job.running = false; job.stopped = state.stopped; job.stats = { ...stats }; saveJob();
  log(`重跑${state.stopped ? '已停止' : '完成'}：归类 ${stats.sorted}，仍未识别 ${stats.unknown}，失败 ${stats.failed}`);
  send({ type: 'done', stats, stopped: state.stopped, percent: 100 });
  res.end();
  state.running = false;
});

// 端口被其他程序占用时自动向后避让（3872 → 3881），避免与本机其他 node 工具冲突
const PORT_FILE = path.join(__dirname, '.port');
function startServer(port, attempt) {
  const srv = app.listen(port, () => {
    try { fs.writeFileSync(PORT_FILE, String(port)); } catch (e) { /* 忽略 */ }
    log(`水印照片智能分类 v1.2.2 已启动：http://localhost:${port}`);
    const lanIPs = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    if (lanIPs.length) log(`局域网访问：${lanIPs.map(ip => `http://${ip}:${port}`).join('   ')}（同一 Wi-Fi/网段的其他设备可用，需放行防火墙）`);
    log(`识别引擎：${rec.engineLabel()} | 学习库：${learn.LEARN_FILE}（当前 ${learn.list().length} 条存档）`);
    ensureEngine().catch(e => log('OCR 引擎初始化失败：' + e.message));
  });
  srv.on('error', e => {
    if (e.code === 'EADDRINUSE' && attempt < 9) {
      log(`端口 ${port} 已被其他程序占用，自动尝试 ${port + 1}`);
      startServer(port + 1, attempt + 1);
    } else {
      log(`启动失败：${e.message}`);
      process.exit(1);
    }
  });
}
startServer(PORT, 0);

// 退出时释放 worker 子进程，避免残留占用程序目录文件
let closing = false;
async function gracefulExit(code) {
  if (closing) return;
  closing = true;
  try { await rec.shutdown(); } catch (e) { /* 忽略 */ }
  process.exit(code == null ? 0 : code);
}
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(sig => {
  try { process.on(sig, () => gracefulExit(0)); } catch (e) { /* 平台不支持则跳过 */ }
});
