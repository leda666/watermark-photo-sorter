#!/usr/bin/env node
/**
 * 一键下载并解压 OCR 引擎（RapidOCR-json，PaddleOCR PP-OCRv4 模型）
 * 用法：npm run setup   （或 node scripts/download-engine.js）
 * 若 GitHub 下载缓慢，可手动下载后用 7-Zip 解压到 engine/ 目录。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const URL = process.env.ENGINE_URL
  || 'https://github.com/hiroi-sora/RapidOCR-json/releases/download/v0.2.0/RapidOCR-json_v0.2.0.7z';
const TARGET = path.join(ROOT, 'engine');
const EXE = path.join(TARGET, 'RapidOCR-json_v0.2.0', 'RapidOCR-json.exe');
const SEVEN_Z = path.join(__dirname, 'bin', '7zr.exe');

async function main() {
  if (fs.existsSync(EXE)) {
    console.log('✅ 引擎已存在，无需下载：' + EXE);
    return;
  }
  console.log('⬇️  下载引擎包（约 70MB）：' + URL);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + '\n可手动下载：' + URL);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(TARGET, { recursive: true });
  const tmp = path.join(TARGET, 'rapidocr.7z');
  fs.writeFileSync(tmp, buf);
  console.log('📦 解压中…');
  const r = spawnSync(SEVEN_Z, ['x', tmp, '-o' + TARGET, '-y'], { stdio: 'inherit' });
  if (r.error) throw new Error('调用解压器失败：' + r.error.message);
  if (r.status !== 0) throw new Error('解压失败，请用 7-Zip 手动解压 ' + tmp + ' 到 engine/ 目录');
  try { fs.unlinkSync(tmp); } catch (e) {}
  if (!fs.existsSync(EXE)) throw new Error('解压后未找到 RapidOCR-json.exe，请检查 engine/ 目录结构');
  console.log('✅ 完成。运行 npm start 启动，浏览器打开 http://localhost:3872');
}

main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
