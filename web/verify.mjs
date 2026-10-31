// 展示页的浏览器验证：截图 + 关键交互 + pageerror。
// 交付前的硬检查点 —— AI 写的代码经常有 interaction bug。
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const file = pathToFileURL(path.resolve('web/index.html')).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });

const problems = [];
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

const text = async sel => ((await page.locator(sel).textContent()) ?? '').trim();

await page.goto(file);
await page.waitForTimeout(2200);
await page.screenshot({ path: '/tmp/ddz-web-1.png', fullPage: true });

// 四处渲染出来的东西真的存在吗（旧的 #f-hand 全项目都不存在，脚本一跑就崩）
if ((await text('#state')).length < 5) problems.push('局面区是空的');
if ((await page.locator('#bets li').count()) < 1) problems.push('候选区是空的');
// 概率列表：至少一个表头 + 一行牌
if ((await page.locator('#plist li').count()) < 2) problems.push('概率列表是空的');
if ((await page.locator('#calib tr').count()) < 2) problems.push('校准表是空的');

const canvasBlank = await page.evaluate(() => {
  const c = document.getElementById('cloud');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
  return true;
});
if (canvasBlank) problems.push('粒子云是空白的');

// 交互：切到第二个决策点，头部应当随之变化
const buttons = page.locator('#steps button');
const n = await buttons.count();
if (n < 2) {
  problems.push(`步号按钮只有 ${n} 个，切不动`);
} else {
  const before = await text('#who');
  await buttons.nth(1).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });
  if ((await text('#who')) === before) problems.push('切步号后头部没有变化');
  await buttons.nth(0).click();
  await page.waitForTimeout(600);
}

// 窄屏
await page.setViewportSize({ width: 420, height: 1200 });
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ddz-web-3.png', fullPage: true });

await browser.close();
console.log(
  problems.length
    ? '发现问题:\n- ' + problems.join('\n- ')
    : '✔ 无 pageerror / console error；局面、候选、概率、校准四处渲染与切步号交互均正常'
);
process.exit(problems.length ? 1 : 0);
