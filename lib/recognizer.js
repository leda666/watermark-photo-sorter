// OCR 识别模块 v1.0.3：Tesseract.js 离线识别 + jimp 预处理（实时调参）
// v1.0.3 变化：新增底部60%区域 + PSM6 变体（实测对日期水印命中率最高）；
// 提取算法 v2：时间屏蔽、紧凑日期滑窗、混淆修复按"年份就近"择优
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { createWorker } = require('tesseract.js');
const { Jimp } = require('jimp');

const TESSDATA_DIR = path.join(__dirname, '..', 'tessdata');

// ---------- PaddleOCR 系引擎（v1.2.1 主引擎：RapidOCR-json，PP-OCRv4 ONNX 模型） ----------
const ENGINE_DIR = path.join(__dirname, '..', 'engine', 'RapidOCR-json_v0.2.0');
const ENGINE_EXE = path.join(ENGINE_DIR, 'RapidOCR-json.exe');
const TMP_ROOT = path.join(os.tmpdir(), 'wmsorter_ocr'); // 必须 ASCII 路径（引擎对中文路径会失败）
function paddleAvailable() {
  try { return fs.existsSync(ENGINE_EXE); } catch (e) { return false; }
}
function engineLabel() {
  return paddleAvailable() ? 'RapidOCR-json（PaddleOCR PP-OCRv4 模型）' : 'Tesseract.js（兜底引擎）';
}

// 调一次引擎进程，返回识别文本行数组
function runPaddle(imagePath, maxSideLen) {
  return new Promise((resolve, reject) => {
    execFile(ENGINE_EXE, ['--image=' + imagePath, '--maxSideLen=' + (maxSideLen || 1600)], {
      cwd: ENGINE_DIR, timeout: 90000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (err, stdout) => {
      const s = String(stdout || '');
      const i = s.lastIndexOf('{"code"');
      if (i < 0) return reject(new Error('引擎无有效输出' + (err ? '：' + err.message : '') + '｜' + s.slice(0, 100)));
      let j;
      try { j = JSON.parse(s.slice(i)); } catch (e) { return reject(new Error('引擎输出解析失败')); }
      if (j.code !== 100) return reject(new Error('引擎返回 code ' + j.code + '：' + (typeof j.data === 'string' ? j.data : '')));
      resolve((j.data || []).map(x => x.text).filter(Boolean));
    });
  });
}

// PaddleOCR 识别：全图 → 下部裁剪逐级重试（水印字小的时候裁剪放大更稳），支持手动框选
async function recognizeWithPaddle(source, img, cfg) {
  if (!fs.existsSync(TMP_ROOT)) fs.mkdirSync(TMP_ROOT, { recursive: true });
  const tmpFiles = [];
  const saveTmp = async (buf, ext) => {
    const p = path.join(TMP_ROOT, 'ocr_' + process.pid + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + (ext || '.png'));
    await fs.promises.writeFile(p, buf);
    tmpFiles.push(p);
    return p;
  };
  try {
    let basePath = null;
    if (Buffer.isBuffer(source)) {
      basePath = await saveTmp(source, '.png');
    } else {
      const p = String(source);
      if (/[^\x00-\x7F]/.test(p)) basePath = await saveTmp(await fs.promises.readFile(p), path.extname(p) || '.jpg');
      else basePath = p;
    }
    const attempts = cfg.customRegion
      ? [{ name: '框选', region: cfg.customRegion }, { name: '全图' }]
      : [{ name: '全图' }, { name: '下部55%', cropBottom: 0.55 }, { name: '下部35%', cropBottom: 0.35 }];

    const texts = [];
    for (const a of attempts) {
      let p = basePath;
      if (a.region || a.cropBottom) {
        const v = img.clone();
        const w = v.bitmap.width, h = v.bitmap.height;
        if (a.region) {
          const x0 = Math.max(0, Math.floor(w * a.region.x0)), y0 = Math.max(0, Math.floor(h * a.region.y0));
          const x1 = Math.min(w, Math.ceil(w * a.region.x1)), y1 = Math.min(h, Math.ceil(h * a.region.y1));
          if (x1 - x0 < 4 || y1 - y0 < 4) continue;
          v.crop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        } else {
          const ch = Math.max(8, Math.floor(h * a.cropBottom));
          v.crop({ x: 0, y: h - ch, w, h: ch });
        }
        p = await saveTmp(await v.getBuffer('image/png'), '.png');
      }
      let lines;
      try { lines = await runPaddle(p); } catch (e) {
        if (attempts.length === 1) throw e;
        texts.push('[' + a.name + '失败:' + e.message + ']');
        continue;
      }
      const text = lines.join('\n');
      texts.push(text);
      const d = extractDate(text, cfg.dateRange);
      if (d) return { date: d, text };
    }
    return { date: null, text: texts.join(' | ').slice(0, 800) };
  } finally {
    for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch (e) {} }
  }
}

let workers = [];
let initPromise = null;

// ---------- 默认参数 ----------
const DEFAULT_CFG = {
  region: 'auto',    // auto=区域智能序列 | lb/rb/lt/rt=固定四角 | full/bottom/top
  regionMode: 'cascade', // cascade=先左下角失败再升级（快）| probe=每张先探测（准）
  smart: true,       // 智能自适应：maxWidth/crop/psm 按图片分辨率自动决定
  invert: 'auto',    // auto=两种都试 | on=只反色(白字) | off=只灰度(黑字)
  crop: 0.3,         // 裁剪比例（0.1 ~ 0.9）
  maxWidth: 1200,    // 缩放宽度
  threshold: -1,     // -1=自适应(Otsu)；0=不二值化；1-255=固定阈值
  psm: '6',          // 分割模式
  whitelist: true,   // 是否只认日期相关字符
};

function normalizeCfg(raw) {
  const cfg = { ...DEFAULT_CFG };
  if (!raw || typeof raw !== 'object') return cfg;
  if (['auto', 'full', 'bottom', 'top', 'lb', 'rb', 'lt', 'rt'].includes(raw.region)) cfg.region = raw.region;
  // 探测模式（v1.0.8）：cascade=先左下角失败再升级（快）| probe=每张先探测四角（准）
  if (['cascade', 'probe'].includes(raw.regionMode)) cfg.regionMode = raw.regionMode;
  // 智能自适应开关（v1.0.8）：默认开，开启时 maxWidth/crop/psm 按图片分辨率自动决定
  if (typeof raw.smart === 'boolean') cfg.smart = raw.smart;
  if (['auto', 'on', 'off'].includes(raw.invert)) cfg.invert = raw.invert;
  const crop = parseFloat(raw.crop);
  if (crop >= 0.1 && crop <= 0.9) cfg.crop = crop;
  const mw = parseInt(raw.maxWidth, 10);
  if (mw >= 500 && mw <= 4000) cfg.maxWidth = mw;
  const th = parseInt(raw.threshold, 10);
  if (th >= -1 && th <= 255) cfg.threshold = th; // -1=自适应(Otsu)
  if (['3', '6', '7', '11', '12'].includes(String(raw.psm))) cfg.psm = String(raw.psm);
  if (typeof raw.whitelist === 'boolean') cfg.whitelist = raw.whitelist;
  // 手动框选区域（v1.0.9 修复：此前 normalizeCfg 丢弃该字段，导致框选识别失效）
  if (raw.customRegion && typeof raw.customRegion === 'object') {
    const x0 = parseFloat(raw.customRegion.x0), y0 = parseFloat(raw.customRegion.y0);
    const x1 = parseFloat(raw.customRegion.x1), y1 = parseFloat(raw.customRegion.y1);
    if ([x0, y0, x1, y1].every(v => v >= 0 && v <= 1) && x1 > x0 && y1 > y0) {
      cfg.customRegion = { x0, y0, x1, y1 };
    }
  }
  // 日期范围约束（v1.0.5）：{ min, max } 范围模式 或 { list: [yyyymmdd...] } 白名单模式
  if (raw.dateRange && typeof raw.dateRange === 'object') {
    if (Array.isArray(raw.dateRange.list) && raw.dateRange.list.length) {
      const list = raw.dateRange.list.filter(v => v >= 20000101 && v <= 20381231);
      if (list.length) cfg.dateRange = { list };
    } else {
      const r = {};
      const mn = parseInt(raw.dateRange.min, 10);
      const mx = parseInt(raw.dateRange.max, 10);
      if (mn >= 20000101 && mn <= 20381231) r.min = mn;
      if (mx >= 20000101 && mx <= 20381231) r.max = mx;
      if (r.min || r.max) cfg.dateRange = r;
    }
  }
  return cfg;
}

async function initWorkers(count = 2, onLog = () => {}) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!fs.existsSync(TESSDATA_DIR)) fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    for (let i = 0; i < count; i++) {
      const w = await createWorker('eng+chi_sim', 1, { cachePath: TESSDATA_DIR });
      workers.push(w);
    }
    onLog(`OCR 引擎初始化完成（${count} 个 worker，eng+chi_sim）`);
  })();
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

// 退出前释放 worker，避免进程残留锁住程序目录
async function shutdown() {
  const list = workers.splice(0, workers.length);
  initPromise = null;
  await Promise.all(list.map(w => Promise.resolve().then(() => w.terminate()).catch(() => {})));
}

async function applyCfg(worker, cfg, psm) {
  await worker.setParameters({
    tessedit_pageseg_mode: psm || cfg.psm,
    tessedit_char_whitelist: cfg.whitelist ? '0123456789/:.-年月日' : '',
    preserve_interword_spaces: '1',
  });
}

// ---------- 日期提取 v2 ----------
// OCR 数字误读对照（一个数字可能被误读成多个候选）
const CONFUSION = {
  '4': ['1', '2', '7'], '7': ['1', '2'], '1': ['7'], '9': ['4', '2'],
  '6': ['5'], '5': ['6'], '3': ['8', '2'], '8': ['3', '6'], '0': ['8', '6'], '2': ['7'],
};

function normalizeText(t) {
  return String(t)
    .replace(/[OoＯ]/g, '0')
    .replace(/[Il|¦]/g, '1')
    .replace(/[B]/g, '8');
}

// 屏蔽时间（14:47 / 17：36 等），防止时间的数字污染日期
function maskTimes(t) {
  return t.replace(/\d{1,2}\s*[:：]\s*\d{1,4}/g, ' ');
}

function validate(y, mo, d) {
  if (!(y >= 2000 && y <= 2038)) return false;
  if (!(mo >= 1 && mo <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  return d <= new Date(y, mo, 0).getDate();
}

function tryMatch(text, range) {
  const re = /(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/g; // 2025/10/07 2025.10.7 2025年10月7日
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (validate(y, mo, d) && inRange(y, mo, d, range)) return { y, mo, d };
  }
  return null;
}

// 日期范围约束（v1.0.5）：设置后只有范围内的日期才算命中，
// 范围外的直读值会被丢弃，而修复通道会尝试把误读数字修进范围内
function inRange(y, mo, d, range) {
  if (!range) return true;
  const t = y * 10000 + mo * 100 + d;
  if (range.list) return range.list.includes(t); // 白名单模式
  if (range.min && t < range.min) return false;
  if (range.max && t > range.max) return false;
  return true;
}

// 紧凑日期：8~10 位数字串上滑动 8 位窗口（20260418、202604181、2026041817 等）
function tryCompactRuns(s, range) {
  const runs = s.match(/\d{8,10}/g) || [];
  for (const run of runs) {
    for (let start = 0; start + 8 <= run.length; start++) {
      const w = run.slice(start, start + 8);
      const y = parseInt(w.slice(0, 4), 10), mo = parseInt(w.slice(4, 6), 10), d = parseInt(w.slice(6, 8), 10);
      if (validate(y, mo, d) && inRange(y, mo, d, range)) return { y, mo, d };
    }
  }
  return null;
}

// 对候选段做单字符混淆修复，收集所有可通过校验的结果
function repairSegment(seg, out, subs, range) {
  for (let i = 0; i < seg.length; i++) {
    const alts = CONFUSION[seg[i]];
    if (!alts) continue;
    for (const sub of alts) {
      const v = seg.slice(0, i) + sub + seg.slice(i + 1);
      const r = tryMatch(v, range);
      if (r) out.push({ ...r, subs: subs + 1 });
    }
  }
}

function collectCandidates(out, s, subs, range) {
  if (!s) return;
  // 分隔符式
  const re = /(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/g;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (validate(y, mo, d) && inRange(y, mo, d, range)) out.push({ y, mo, d, subs });
    repairSegment(m[0], out, subs, range);
  }
  // 紧凑式（含滑窗 + 修复）
  const direct = tryCompactRuns(s, range);
  if (direct) out.push({ ...direct, subs });
  const runs = s.match(/\d{8,10}/g) || [];
  for (const run of runs) {
    for (let start = 0; start + 8 <= run.length; start++) {
      repairSegment(run.slice(start, start + 8), out, subs, range);
    }
  }
}

function extractDate(text, range) {
  if (!text) return null;
  const norm = normalizeText(text);
  const masked = maskTimes(norm);
  const cands = [];

  // 1) 逐行（已屏蔽时间）：日期优先从同一视觉行提取
  for (const line of masked.split(/\n+/)) collectCandidates(cands, line.replace(/\s+/g, ''), 0, range);
  // 2) 整体（已屏蔽时间）
  collectCandidates(cands, masked.replace(/\s+/g, ''), 1, range);
  // 3) 兜底：未屏蔽时间（旧行为）
  collectCandidates(cands, norm.replace(/\s+/g, ''), 2, range);

  if (!cands.length) return null;
  // 择优：直读（零修复）永远优先；同等修复次数下年份越接近当前年越可信
  const now = new Date().getFullYear();
  cands.sort((a, b) => a.subs - b.subs || Math.abs(a.y - now) - Math.abs(b.y - now));
  return { y: cands[0].y, mo: cands[0].mo, d: cands[0].d, subs: cands[0].subs };
}

// ---------- 预处理变体 ----------
function makeVariant(img, { invert, region, crop, customRegion }) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  let v = img.clone();
  if (customRegion && customRegion.x1 > customRegion.x0 && customRegion.y1 > customRegion.y0) {
    // 手动框选区域（相对坐标 0~1）
    const x0 = Math.max(0, Math.floor(w * customRegion.x0));
    const y0 = Math.max(0, Math.floor(h * customRegion.y0));
    const x1 = Math.min(w, Math.ceil(w * customRegion.x1));
    const y1 = Math.min(h, Math.ceil(h * customRegion.y1));
    v = v.crop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  } else if (region === 'bottom') {
    const y = Math.floor(h * (1 - crop));
    v = v.crop({ x: 0, y, w, h: h - y });
  } else if (region === 'top') {
    const ch = Math.max(1, Math.floor(h * crop));
    v = v.crop({ x: 0, y: 0, w, h: ch });
  } else if (region === 'lb' || region === 'rb' || region === 'lt' || region === 'rt') {
    // 四角区域（v1.0.6）：宽 50%、高 = crop 比例，识别范围小→速度快
    const isLeft = region === 'lb' || region === 'lt';
    const isBottom = region === 'lb' || region === 'rb';
    const cw = Math.floor(w * 0.5);
    const ch = Math.max(1, Math.floor(h * crop));
    const x0 = isLeft ? 0 : w - cw;
    const y0 = isBottom ? h - ch : 0;
    v = v.crop({ x: x0, y: y0, w: cw, h: ch });
  }
  v = v.greyscale();
  if (invert) v = v.invert();
  return v;
}

// ---------- 自适应阈值（v1.0.7：Otsu 大津算法） ----------
// 按每个识别区域的灰度直方图自动算出最佳切分点，深色/浅色场景都自适应
function otsuThreshold(img) {
  try {
    const data = img.bitmap.data;
    const hist = new Array(256).fill(0);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      hist[data[i]]++; // 已灰度化，r=g=b
      n++;
    }
    if (!n) return 0;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return Math.min(245, Math.max(10, best)); // 夹在合理区间，避免极端值
  } catch (e) {
    return 0;
  }
}

// 应用阈值：variantTh 优先；-1 = 该变体自适应；否则用 cfg 的全局阈值（-1 也自适应）
function applyThreshold(vimg, variantTh, cfgTh) {
  const th = (variantTh !== undefined && variantTh !== null) ? variantTh : cfgTh;
  if (th === -1) {
    const t = otsuThreshold(vimg);
    if (t > 0) { try { return { img: vimg.threshold({ max: t }), used: t }; } catch (e) { return { img: vimg, used: 0 }; } }
    return { img: vimg, used: 0 };
  }
  if (th > 0) {
    try { return { img: vimg.threshold({ max: th }), used: th }; } catch (e) { return { img: vimg, used: 0 }; }
  }
  return { img: vimg, used: 0 };
}

// 生成待尝试变体列表：[{ img, psm }]
function buildVariants(img, cfg) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  if (w > cfg.maxWidth) {
    const scale = cfg.maxWidth / w;
    img.resize({ w: cfg.maxWidth, h: Math.round(h * scale) });
  }
  const needInv = cfg.invert === 'auto' ? [false, true] : [cfg.invert === 'on'];
  const variants = [];

  if (cfg.customRegion) {
    // 手动框选模式：只识别框内
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, customRegion: cfg.customRegion }), psm: cfg.psm });
  } else if (cfg.region === 'auto') {
    // 全图（PSM 11 稀疏）
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'full' }), psm: '11' });
    // 底部 60% 区域 + PSM 6（实测对日期水印命中率最高，大号时间不再压制小号日期）
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'bottom', crop: 0.6 }), psm: '6' });
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'bottom', crop: 0.6 }), psm: '11' });
    // 底部 45% 裁剪
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'bottom', crop: cfg.crop }), psm: '11' });
    // 顶部 45% 裁剪
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'top', crop: cfg.crop }), psm: '11' });
    // 低对比度兜底：自适应阈值（Otsu）
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'bottom', crop: 0.75 }), psm: '6', th: -1 });
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: 'bottom', crop: 0.9 }), psm: '6', th: -1 });
  } else {
    for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: cfg.region, crop: cfg.crop }), psm: cfg.psm });
    // v1.0.7：四角小区域补一轮自适应阈值（深色/浅色场景通吃，最多多 2 次 OCR）
    if (cfg.threshold === 0 && ['lb', 'rb', 'lt', 'rt'].includes(cfg.region)) {
      for (const inv of needInv) variants.push({ img: makeVariant(img, { invert: inv, region: cfg.region, crop: cfg.crop }), psm: cfg.psm, th: -1 });
    }
  }
  return variants;
}

// 用某个 worker 识别一张图的全部变体
// auto 模式：只有"零修复直读且年份=当前年"才提前停；否则收集全部变体结果，
// 按多变体共识票数 → 修复次数 → 年份就近 择优（防止个别变体的低置信度错值抢跑）
async function recognizeWithWorker(worker, img, cfg) {
  const variants = buildVariants(img, cfg);
  const tried = [];
  const hits = [];
  let cleanHit = null;
  const nowYear = new Date().getFullYear();
  for (const v of variants) {
    const r0 = applyThreshold(v.img, v.th, cfg.threshold);
    const vimg = r0.img;
    const buf = await vimg.getBuffer('image/png');
    try {
      await applyCfg(worker, cfg, v.psm);
      const { data } = await worker.recognize(buf);
      tried.push(data.text.trim().replace(/\s+/g, ' ').slice(0, 120));
      const d = extractDate(data.text, cfg.dateRange);
      if (d) {
        if (cfg.region !== 'auto') return { date: d, text: data.text };
        hits.push({ ...d, text: data.text });
        if (d.subs === 0 && d.y === nowYear) { cleanHit = { date: d, text: data.text }; break; }
      }
    } catch (e) {
      tried.push(`[OCR error: ${e.message}]`);
    }
  }
  if (cleanHit) return cleanHit;
  if (hits.length) {
    // 共识投票：同一日期被越多变体读出越可信
    const votes = {};
    for (const h of hits) {
      const k = `${h.y}-${h.mo}-${h.d}`;
      votes[k] = votes[k] || { count: 0, minSubs: 99, hit: h };
      votes[k].count++;
      votes[k].minSubs = Math.min(votes[k].minSubs, h.subs);
    }
    const arr = Object.values(votes);
    arr.sort((a, b) =>
      b.count - a.count ||
      a.minSubs - b.minSubs ||
      Math.abs(a.hit.y - nowYear) - Math.abs(b.hit.y - nowYear)
    );
    const best = arr[0].hit;
    return { date: { y: best.y, mo: best.mo, d: best.d }, text: best.text };
  }
  return { date: null, text: tried.join(' | ') };
}

// 识别单个文件或图片 Buffer（需先 acquireWorker 获取空闲 worker）
// v1.0.8 智能参数：
//  1. 同尺寸已学参数优先
//  2. 智能开启时：maxWidth/crop/psm 按图片分辨率自适应（autoParams），忽略手填值
//  3. 区域智能（region=auto 时）：
//     cascade = 先扫左下角，读不出再升级 rb/lt/rt/下部/全管道（默认，快）
//     probe   = 每张先快速探测四角选最优区域再识别（每张多 1~2 秒）
//  4. 获胜参数（含阈值）按图片分辨率尺寸记入学习库
async function recognizeOnWorker(worker, source, cfgRaw) {
  const img = await Jimp.read(source);
  const learn = require('./learn');
  const dims = { w: img.bitmap.width, h: img.bitmap.height };
  const cfg = normalizeCfg(cfgRaw);

  // v1.2.1：PaddleOCR 系引擎优先（worker 可为 null）
  if (paddleAvailable()) {
    // 纠错学习复用（v1.2.1）：同尺寸照片优先沿用上次框选的区域
    const learned = learn.find(dims.w, dims.h);
    let cfgP = cfg;
    if (learned && !cfg.customRegion) {
      const lc = normalizeCfg(learned);
      if (lc.customRegion) cfgP = { ...cfg, customRegion: lc.customRegion };
    }
    const r = await recognizeWithPaddle(source, img, cfgP);
    if (learned && cfgP !== cfg) learn.markHit(dims.w, dims.h, !!r.date);
    return r;
  }
  if (!worker) throw new Error('OCR 引擎未就绪');

  const smart = cfg.smart !== false; // 智能自适应默认开
  const auto = autoParams(img);
  const baseCfg = smart
    ? { ...cfg, maxWidth: auto.maxWidth, crop: auto.crop, psm: auto.psm }
    : cfg;

  // 1) 同尺寸已学参数优先（重放也受日期范围约束）
  const learned = learn.find(dims.w, dims.h);
  if (learned && !cfg.customRegion) {
    // v1.0.9 热修：不再手动回填 learned.customRegion（零面积坏框会被 normalizeCfg 校验剔除）
    const learnedCfg = { ...normalizeCfg(learned), dateRange: cfg.dateRange, smart: false };
    const r = await recognizeWithWorker(worker, img.clone(), learnedCfg);
    if (r.date && r.date.subs === 0) {
      learn.markHit(dims.w, dims.h, true);
      return r;
    }
    learn.markHit(dims.w, dims.h, false);
  }

  // 2) 手选区域或手动框选（v1.0.9：框选也走直识通道，不再落入区域智能序列）
  if (cfg.region !== 'auto' || cfg.customRegion) {
    const r = await recognizeWithWorker(worker, img, baseCfg);
    if (r.date && r.date.subs === 0) learnLearn(learn, dims, baseCfg, r);
    return r;
  }

  // 3) 区域智能序列
  const regionSeq = ['lb', 'rb', 'lt', 'rt'];
  const bestHits = [];
  const tryStep = async (stepCfg) => {
    const r = await recognizeWithWorker(worker, img.clone(), stepCfg);
    if (r.date && r.date.subs === 0) {
      learnLearn(learn, dims, stepCfg, r);
      return { done: true, r };
    }
    if (r.date) bestHits.push({ ...r.date, subs: r.date.subs, text: r.text, cfg: stepCfg });
    return { done: false, r };
  };

  if (cfg.regionMode === 'probe') {
    // 每张先探测：四角各快扫一次（白字反色+自适应阈值），选最先读出日期的角
    let picked = null;
    for (const rg of regionSeq) {
      const stepCfg = { ...baseCfg, region: rg, invert: 'on', psm: '6', threshold: -1, smart: false };
      const r = await recognizeWithWorker(worker, img.clone(), stepCfg);
      if (r.date) { picked = rg; break; }
    }
    if (picked) {
      const stepCfg = { ...baseCfg, region: picked, invert: 'auto', psm: '6', threshold: -1, smart: false };
      const { done, r } = await tryStep(stepCfg);
      if (done) return r;
    }
  } else {
    // cascade：先左下角（反色→黑字），再其他角
    for (const rg of regionSeq) {
      for (const inv of ['on', 'off']) {
        const stepCfg = { ...baseCfg, region: rg, invert: inv, psm: '6', threshold: -1, smart: false };
        const { done, r } = await tryStep(stepCfg);
        if (done) return r;
      }
    }
  }

  // 4) 阈值 30-80 序列（用户实测高发区间，仅左下角）
  for (const th of [30, 45, 60, 80]) {
    const stepCfg = { ...baseCfg, region: 'lb', invert: 'on', psm: '6', threshold: th, smart: false };
    const { done, r } = await tryStep(stepCfg);
    if (done) return r;
  }

  // 5) 下部带 + 完整 auto 管道兜底
  {
    const stepCfg = { ...baseCfg, region: 'bottom', crop: 0.6, invert: 'auto', psm: '6', threshold: -1, smart: false };
    const { done, r } = await tryStep(stepCfg);
    if (done) return r;
  }
  {
    const r = await recognizeWithWorker(worker, img, { ...baseCfg, region: 'auto', smart: false });
    if (r.date) bestHits.push({ ...r.date, subs: r.date.subs, text: r.text, cfg: { ...baseCfg, region: 'auto' } });
  }

  // 6) 统一择优（修复级命中按 修复次数→年份就近）
  if (bestHits.length) {
    const nowYear = new Date().getFullYear();
    bestHits.sort((a, b) => a.subs - b.subs || Math.abs(a.y - nowYear) - Math.abs(b.y - nowYear));
    const best = bestHits[0];
    learnLearn(learn, dims, best.cfg, { date: best, subs: best.subs });
    return { date: { y: best.y, mo: best.mo, d: best.d }, text: best.text };
  }
  return { date: null, text: '' };
}

// 获胜参数自动记入学习库（v1.0.8：按图片分辨率尺寸学习）
function learnLearn(learn, dims, cfg, r) {
  try {
    const slim = {
      region: cfg.region, crop: cfg.crop, psm: cfg.psm,
      invert: cfg.invert, maxWidth: cfg.maxWidth,
      threshold: cfg.threshold, whitelist: cfg.whitelist,
      customRegion: cfg.customRegion || null,
    };
    learn.learn(dims.w, dims.h, slim, null, 'auto');
  } catch (e) { /* 学习库写入失败不影响识别 */ }
}

// 按图片分辨率自适应 高度/缩放/分割模式（v1.0.8）
function autoParams(img) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const long = Math.max(w, h);
  const portrait = h > w;
  let maxWidth;
  if (long >= 3000) maxWidth = 2000;
  else if (long >= 2000) maxWidth = 1600;
  else if (long >= 1200) maxWidth = 1200;
  else maxWidth = Math.min(1200, w);
  const crop = portrait ? 0.25 : 0.3; // 竖屏水印相对更靠底部边缘，带窄一点
  return { maxWidth, crop, psm: '6' };
}

// 学习搜索：给定期望日期，网格搜索能读出该日期的参数组合（供喂养/纠错）
// 维度：带宽 / 横向滑窗（避开大号时间对小号日期的干扰）/ 阈值 / PSM / 缩放
async function searchLearning(worker, source, expectedDate, onProgress) {
  const img = await Jimp.read(source);
  const base = normalizeCfg(null);
  const grid = [];
  const windows = [0, 0.15, 0.3, 0.45, 0.6, 0.75]; // 横向滑窗起点（宽 0.4）

  function pushBand(mw, crop, psm, th) {
    grid.push({ ...base, maxWidth: mw, threshold: th, region: 'bottom', crop, psm, invert: 'auto' });
  }
  function pushWindow(mw, crop, psm, th) {
    for (const x0 of windows) {
      grid.push({
        ...base, maxWidth: mw, threshold: th, psm, invert: 'auto',
        customRegion: { x0, y0: +(1 - crop).toFixed(3), x1: +(x0 + 0.4).toFixed(3), y1: 1 },
      });
    }
  }

  // 1) 窄带直读（最快的通用招）
  for (const th of [-1, 0, 210]) for (const crop of [0.25, 0.35, 0.6, 0.8]) {
    pushBand(1200, crop, '6', th);
    pushBand(1200, crop, '11', th);
  }
  // 2) 横向滑窗（专治大号时间压制小号日期）
  for (const th of [-1, 210, 0]) for (const psm of ['6', '7']) pushWindow(1200, 0.3, psm, th);
  pushWindow(1200, 0.5, '6', 210);
  // 3) 全图兜底
  grid.push({ ...base, maxWidth: 1200, region: 'full', psm: '11', invert: 'auto' });
  // 4) 2000px 精扫
  for (const th of [0, 210]) for (const crop of [0.25, 0.6]) {
    pushBand(2000, crop, '6', th);
    pushBand(2000, crop, '11', th);
  }
  for (const th of [210, 0]) pushWindow(2000, 0.3, '6', th);

  const exp = { y: expectedDate.y, mo: expectedDate.mo, d: expectedDate.d };
  for (let i = 0; i < grid.length; i++) {
    if (onProgress) onProgress(i + 1, grid.length);
    const cfg = grid[i];
    const variants = buildVariants(img.clone(), cfg);
    for (const v of variants) {
      const vimg = applyThreshold(v.img, v.th, cfg.threshold).img;
      const buf = await vimg.getBuffer('image/png');
      try {
        await applyCfg(worker, cfg, v.psm);
        const { data } = await worker.recognize(buf);
        const d = extractDate(data.text);
        if (d && d.y === exp.y && d.mo === exp.mo && d.d === exp.d) {
          // 找到获胜参数（阈值记录进 cfg；invert 保持 auto：重放时同样能命中）
          const winCfg = {
            region: cfg.region, crop: cfg.crop, psm: v.psm,
            invert: cfg.invert, maxWidth: cfg.maxWidth,
            threshold: (v.th !== undefined && v.th !== null) ? v.th : cfg.threshold,
            whitelist: cfg.whitelist,
            customRegion: cfg.customRegion || null,
          };
          return { found: true, cfg: winCfg };
        }
      } catch (e) { /* 忽略单变体失败 */ }
    }
  }
  return { found: false };
}

// worker 池：取空闲 / 归还
const busy = new Set();
function acquireWorker() {
  const w = workers.find(x => !busy.has(x));
  if (!w) return null;
  busy.add(w);
  return w;
}
function releaseWorker(w) { busy.delete(w); }

function getWorkerCount() { return workers.length; }

module.exports = { initWorkers, recognizeOnWorker, recognizeWithWorker, recognizeWithPaddle, searchLearning, applyCfg, acquireWorker, releaseWorker, extractDate, getWorkerCount, TESSDATA_DIR, DEFAULT_CFG, normalizeCfg, buildVariants, paddleAvailable, engineLabel, shutdown };
