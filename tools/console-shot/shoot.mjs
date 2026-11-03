import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8931;
const OUT = '/tmp/console-compare';
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: REPO, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/tools/console-shot/viewer.html`); if (r.ok) break; } catch {}
  await sleep(250);
}

const browser = await chromium.launch();
const jobs = [];
for (const [tag, glb] of [['a', '/web/assets/console-a.glb'], ['b', '/web/assets/console-b.glb']]) {
  for (const view of ['front', 'iso']) {
    for (const flip of ['0', '1']) jobs.push({ tag, glb, view, flip });
  }
}
for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tools/console-shot/viewer.html?glb=${j.glb}&view=${j.view}&flip=${j.flip}`);
  await page.waitForFunction(() => window.__ready === true || window.__error, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => ({ info: window.__info, error: window.__error || null }));
  await page.screenshot({ path: `${OUT}/${j.tag}-${j.view}-flip${j.flip}.png` });
  console.log(j.tag, j.view, 'flip' + j.flip, info.error ? 'ERROR ' + info.error : JSON.stringify(info.info) + (errs.length ? ' errs:' + errs.join('|') : ''));
  await page.close();
}
await browser.close();
stop();
console.log('out:', OUT);
