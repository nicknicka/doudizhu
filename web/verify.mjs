// 展示页的浏览器验证：截图 + 关键交互 + pageerror。
// huashu-design 把它列为交付前的硬检查点 —— AI 写的代码经常有 interaction bug。
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const file = pathToFileURL(path.resolve('web/index.html')).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });

const problems = [];
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

await page.goto(file);
await page.waitForTimeout(2200);
await page.screenshot({ path: '/tmp/ddz-web-1.png', fullPage: true });

// 交互 1：切到第二个决策点
const buttons = page.locator('#steps button');
const n = await buttons.count();
if (n < 2) problems.push(`步号按钮只有 ${n} 个，切不动`);
else await buttons.nth(1).click();
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });

// 交互 2：切回去
if (n >= 1) await buttons.nth(0).click();
await page.waitForTimeout(900);

// 交互 3：窄屏
await page.setViewportSize({ width: 420, height: 1200 });
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ddz-web-3.png', fullPage: true });

// 数据是否真的渲染出来了
const facts = await page.locator('#f-hand').textContent();
if (!facts || facts.trim().length < 5) problems.push('手牌区是空的');
const canvasBlank = await page.evaluate(() => {
  const c = document.getElementById('cloud');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
  return lit === 0;
});
if (canvasBlank) problems.push('粒子云是空白的');

await browser.close();
console.log(problems.length ? '发现问题:\n- ' + problems.join('\n- ') : '✔ 无 pageerror、无 console error，三处交互与渲染均正常');
process.exit(problems.length ? 1 : 0);
