// 展示页的浏览器验证：自己起后端，跑真实交互，抓 pageerror。
// 交付前的硬检查点 —— AI 写的代码经常有 interaction bug。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const problems = [];
// 我们**故意**触发非法录入来看错误提示；浏览器会给那次 400 记一条 console error，
// 那是预期内的，不该算问题。
let expectingError = false;
const server = spawn('.venv/bin/python', ['-m', 'ddz', 'serve', '--port', String(PORT)],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
const stopServer = () => { try { server.kill(); } catch { /* 已经退了 */ } };
process.on('exit', stopServer);

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('后端没能在 30 秒内起来');
}

const text = async (page, sel) => ((await page.locator(sel).textContent()) ?? '').trim();

try {
  await waitForHealth();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !expectingError) problems.push(`console: ${m.text()}`);
  });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('#steps button', { timeout: 40000 });   // 首次 /api/demo 要算校准
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/tmp/ddz-web-1.png', fullPage: true });

  // 四处真的渲染出来了吗
  if ((await text(page, '#state')).length < 5) problems.push('局面区是空的');
  if ((await page.locator('#bets li').count()) < 1) problems.push('候选区是空的');
  if ((await page.locator('#plist li[data-card]').count()) < 2) problems.push('概率列表是空的');
  if ((await page.locator('#calib tr').count()) < 2) problems.push('校准表是空的');
  if ((await page.locator('#steps button').count()) < 2) problems.push('步号按钮少于 2 个');

  const canvasBlank = await page.evaluate(() => {
    const c = document.getElementById('cloud');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
    return true;
  });
  if (canvasBlank) problems.push('粒子云是空白的');

  // 交互 1：点步号
  const before = await text(page, '#who');
  await page.locator('#steps button').nth(1).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });
  if ((await text(page, '#who')) === before) problems.push('点步号后局面没变');

  // 交互 2：键盘 → 切下一步
  const beforeKey = await text(page, '#who');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  if ((await text(page, '#who')) === beforeKey) problems.push('按 → 之后局面没变');

  // 交互 3：悬停概率列表的一行 → 那一行高亮
  const row = page.locator('#plist li[data-card]').first();
  await row.hover();
  await page.waitForTimeout(200);
  if (!(await row.evaluate(el => el.classList.contains('is-focus')))) {
    problems.push('悬停概率列表没有高亮');
  }
  // 交互 4：点一下 → 钉住，移开鼠标仍然亮着
  await row.click();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  if (!(await row.evaluate(el => el.classList.contains('is-focus')))) {
    problems.push('点击概率列表没有钉住该牌');
  }

  // 交互 5：概率列表能用键盘钉住（鼠标能点不够，"做好"要能 tab 到）
  const row2 = page.locator('#plist li[data-card]').nth(1);
  await row2.focus();
  await page.keyboard.press('Enter');
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  if (!(await row2.evaluate(el => el.classList.contains('is-focus')))) {
    problems.push('概率列表无法用键盘钉住');
  }

  // 交互 6：打开自己的记录
  const demo = await (await fetch(`${BASE}/api/demo`)).json();
  const file = path.join(tmpdir(), 'my-game.json');
  writeFileSync(file, JSON.stringify(demo.record));
  await page.locator('#file').setInputFiles(file);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/ddz-web-3.png', fullPage: true });
  if (!(await text(page, '#banner')).includes('my-game.json')) {
    problems.push('载入自己的记录后没有反馈');
  }

  // 交互 7：在网页上直接开局 → 录牌 → 撤销，完全不碰命令行
  await page.selectOption('#new-me', 'landlord_up');
  await page.fill('#new-hand', '333444555666778AA');
  await page.fill('#new-cards', '9TJ');
  await page.click('#new-go');
  await page.waitForTimeout(1500);
  if (!(await text(page, '#banner')).includes('已开局')) problems.push('网页开局没有反馈');
  if (!(await text(page, '#who')).includes('该 地主')) problems.push('开局后没显示该地主出牌');
  if (await page.locator('#bets li').count()) problems.push('还没轮到我方却给了候选');

  // 非法出牌必须被拦下（我手上有三张 3，地主打不出两张 3）
  expectingError = true;
  await page.fill('#play-cards', '33');
  await page.click('#play-go');
  await page.waitForTimeout(900);
  expectingError = false;
  if (!(await text(page, '#banner')).includes('已经出过')) problems.push('非法出牌没被拦下');

  // 合法录两手 → 轮到我方，候选与步号都该出现
  await page.fill('#play-cards', '99');
  await page.click('#play-go');
  await page.waitForTimeout(1000);
  await page.click('#play-pass');
  await page.waitForTimeout(1000);
  if (!(await page.locator('#bets li').count())) problems.push('录到轮我方后没有候选');
  if (!(await page.locator('#steps button').count())) problems.push('录到轮我方后没有步号');
  await page.screenshot({ path: '/tmp/ddz-web-5.png', fullPage: true });

  await page.click('#undo');
  await page.waitForTimeout(1000);
  if (!(await text(page, '#banner')).includes('已撤销')) problems.push('撤销没有反馈');

  // 窄屏
  await page.setViewportSize({ width: 420, height: 1200 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/ddz-web-4.png', fullPage: true });

  await browser.close();
} catch (err) {
  problems.push(`验证本身出错：${err.message}`);
} finally {
  stopServer();
}

console.log(problems.length
  ? '发现问题:\n- ' + problems.join('\n- ')
  : '✔ 无 pageerror / console error；渲染四处 + 步号(点/键) + 交叉高亮 + 钉住(鼠标/键盘) + 载入记录 + 网页开局/录牌/撤销 均正常');
process.exit(problems.length ? 1 : 0);
