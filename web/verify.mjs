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
// 故意触发非法录入看错误提示时，浏览器会给那次 400 记一条 console error —— 预期内
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
  await page.waitForSelector('#steps button', { timeout: 40000 });  // 首次 /api/demo 要算校准
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/tmp/ddz-web-1.png', fullPage: true });

  // 座位与人称：以我方为参照（我 / 上家 / 下家），身份是徽章不是座位名
  const boardText = await text(page, '#board');
  for (const word of ['我', '上家', '下家']) {
    if (!boardText.includes(word)) problems.push(`牌桌上没出现「${word}」——座位名没有以我方为参照`);
  }
  if ((await page.locator('#board .seat-head .badge.landlord').count()) !== 1) {
    problems.push('地主身份徽章不是恰好一个');
  }
  if (!boardText.includes('该你出') && !boardText.includes('轮到你出牌')) {
    problems.push('没标出"该我出"');
  }
  // 决策点按"我的第几次出牌机会"编号，全局手数只作次要信息
  const firstStep = ((await page.locator('#steps button').first().textContent()) ?? '').trim();
  if (!/^第 \d+ 次$/.test(firstStep)) problems.push(`决策点编号不是「第 N 次」：${firstStep}`);
  if (!(await page.locator('#steps button').first().getAttribute('title') || '').includes('全局第')) {
    problems.push('决策点没把全局手数留作次要信息');
  }
  if (!(await text(page, '#who')).includes('我的第')) problems.push('抬头没给出"我的第几次出牌机会"');

  // 牌桌：三个座位、各自张数、我的一手是真牌面
  if ((await page.locator('#board .seat').count()) !== 3) problems.push('牌桌不是三个座位');
  if (!/\d+ 张/.test(await text(page, '#board'))) problems.push('牌桌没显示张数');
  if (!(await page.locator('#board .seat.is-me .seat-hand i.c').count())) {
    problems.push('我的座位没画出真实牌面');
  }
  if (!(await page.locator('#board .seat:not(.is-me) .seat-hand i.bk').count())) {
    problems.push('对手座位没画出牌背');
  }

  // 分布面板
  if ((await page.locator('#plist li[data-card]').count()) < 2) problems.push('概率列表是空的');
  if ((await page.locator('#calib tr').count()) < 2) problems.push('校准表是空的');
  const canvasBlank = await page.evaluate(() => {
    const c = document.getElementById('cloud');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
    return true;
  });
  if (canvasBlank) problems.push('粒子云是空白的');

  // 交互 1：点步号 / 键盘 →
  const before = await text(page, '#who');
  await page.locator('#steps button').nth(1).click();
  await page.waitForTimeout(800);
  if ((await text(page, '#who')) === before) problems.push('点步号后局面没变');
  const beforeKey = await text(page, '#who');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  if ((await text(page, '#who')) === beforeKey) problems.push('按 → 之后局面没变');

  // 交互 2：概率列表悬停高亮 / 点击钉住
  const row = page.locator('#plist li[data-card]').first();
  await row.hover(); await page.waitForTimeout(150);
  if (!(await row.evaluate(el => el.classList.contains('is-focus')))) problems.push('悬停概率列表没有高亮');
  await row.click(); await page.mouse.move(10, 10); await page.waitForTimeout(150);
  if (!(await row.evaluate(el => el.classList.contains('is-focus')))) problems.push('点击概率列表没有钉住');
  const row2 = page.locator('#plist li[data-card]').nth(1);
  await row2.focus(); await page.keyboard.press('Enter');
  await page.mouse.move(10, 10); await page.waitForTimeout(150);
  if (!(await row2.evaluate(el => el.classList.contains('is-focus')))) problems.push('概率列表无法用键盘钉住');

  // 交互 3：开新局 —— 全部用牌盘点出来，不输任何牌面字符串
  await page.click('#new-toggle');
  await page.selectOption('#new-me', 'landlord_up');
  // 开局用「开局面板」的牌盘，录一手用「录一手」的牌盘 —— 是两套，别点错
  const tapNew = async keys => { for (const k of keys) await page.click(`#new-keys button[data-key="${k}"]`); };
  const tapPlay = async keys => { for (const k of keys) await page.click(`#play-keys button[data-key="${k}"]`); };
  await tapNew(['3','3','3','4','4','4','5','5','5','6','6','6','7','7','8','A','A']); // 17 张手牌
  await tapNew(['9','T','J']);                                                          // 3 张底牌
  if (!(await text(page, '#new-count')).includes('17/17')) problems.push('牌盘没数对手牌张数');
  await page.click('#new-go');
  await page.waitForTimeout(1500);
  if (!(await text(page, '#banner')).includes('已开局')) problems.push('开新局没有反馈');
  if (!(await text(page, '#board')).includes('该他出')) problems.push('开局后没标出该谁出牌');

  // 交互 4：交给服务端拒的那种 —— 3 和 4 凑一起不是任何合法牌型
  // （牌池上限管不到这一层，它只挡"牌池里没有的牌"）
  expectingError = true;
  await tapPlay(['3','4']);
  await page.click('#play-go');
  await page.waitForTimeout(900);
  expectingError = false;
  if (!(await text(page, '#banner')).includes('不是合法牌型')) problems.push('非法出牌没被服务端拦下');
  if ((await page.locator('#play-chips i.c').count()) !== 2) problems.push('出牌被拒后把选中的牌清掉了');

  // 交互 5：合法录两手 → 轮到我方，出现候选与步号
  await page.click('#play-clear');
  await tapPlay(['9','9']);
  await page.click('#play-go');
  await page.waitForTimeout(1000);
  await page.click('#play-pass');
  await page.waitForTimeout(1200);
  if (!(await page.locator('#play-picks button').count())) problems.push('轮到我方后没有候选可选');
  if (!(await page.locator('#steps button').count())) problems.push('轮到我方后没有决策点');
  await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });

  // 交互 6：牌盘的张数上限 —— 我手上有三张 3，牌池只剩一张，第二张必须被挡下。
  // 顺带说明：老用例拿"地主打对 3"当非法出牌，现在被这一层正当地先挡住了。
  await tapPlay(['3']);
  const sup = page.locator('#play-keys button sup');
  if ((await sup.count()) !== 1) problems.push('牌盘没把已选张数标出来');
  else if ((await sup.first().textContent()).trim() !== '1') problems.push('牌盘的张数标注不对');
  await tapPlay(['3']);          // 第二张
  if ((await page.locator('#play-chips i.c').count()) !== 1) {
    problems.push('牌盘没有挡住超过牌池张数的选牌');
  }
  if (!(await text(page, '#banner')).includes('只剩')) problems.push('挡住选牌时没有说明原因');
  await page.click('#play-clear');

  // 交互 7：点候选 = 直接录这一手。
  // 注意：录完不一定就轮到我方，所以不能拿"步号变多"当判据 —— 看反馈与已出手数。
  const picks = await page.locator('#play-picks button').count();
  const boardBefore = await text(page, '#board');
  await page.locator('#play-picks button').nth(picks - 1).click();
  await page.waitForTimeout(1200);
  if (!(await text(page, '#banner')).includes('已录')) problems.push('点候选没有把这一手录进去');
  // 比整块牌桌：点「不出」时"已出"不会变，但该谁出、上一手一定变
  if ((await text(page, '#board')) === boardBefore) problems.push('点候选后牌桌没有跟着走');

  // 交互 8：撤销
  await page.click('#undo');
  await page.waitForTimeout(1000);
  if (!(await text(page, '#banner')).includes('已撤销')) problems.push('撤销没有反馈');

  // 窄屏
  await page.setViewportSize({ width: 420, height: 1200 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/ddz-web-3.png', fullPage: true });

  await browser.close();
} catch (err) {
  problems.push(`验证本身出错：${err.message}`);
} finally {
  stopServer();
}

console.log(problems.length
  ? '发现问题:\n- ' + problems.join('\n- ')
  : '✔ 无 pageerror / console error；座位以我方为参照 + 牌桌三席 + 分布四处 + 步号(点/键) + 交叉高亮 + 牌盘开局/录牌(含牌池上限) + 候选一键录 + 撤销 均正常');
process.exit(problems.length ? 1 : 0);
