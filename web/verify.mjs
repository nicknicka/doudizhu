// 展示页的浏览器验证：自己起后端，跑真实交互，抓 pageerror。
// 交付前的硬检查点 —— AI 写的代码经常有 interaction bug。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const problems = [];
let server = null;
let serverExited = null;
async function stopServer(){
  if (!server || !serverExited) return;
  const proc = server;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([
    serverExited,
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (proc.exitCode === null && proc.signalCode === null){
    proc.kill('SIGKILL');
    await serverExited;
  }
}

function portIsFree() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: PORT });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', err => { socket.destroy(); resolve(err.code === 'ECONNREFUSED'); });
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('后端没能在 30 秒内起来');
}

// 每个页面只白名单自己的预期错误；pageerror 永不吞。
function watchPage(page, label, isAllowed = () => false) {
  page.on('pageerror', e => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const msg = m.text();
    if (!isAllowed(msg)) problems.push(`${label} console: ${msg}`);
  });
}
const text = async (page, sel) => ((await page.locator(sel).textContent()) ?? '').trim();
// 手牌在画布上的中心点：直接问 3D 场景，脚本据此点"真牌"
const handPts = page => page.evaluate(async () => (await import('/app/machine.js')).handPoints());
// 在屏幕里点第 k 张手牌：先把鼠标移过去让视差收敛，再按收敛后的真实落点点击
const clickCard = async (page, k) => {
  const box = await page.locator('#scene').boundingBox();
  let pt = (await handPts(page))[k];
  if (!pt) throw new Error(`没有第 ${k} 张手牌坐标`);
  await page.mouse.move(box.x + pt.x, box.y + pt.y);
  await page.waitForTimeout(650);
  pt = (await handPts(page))[k];
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
};
const machineStatus = page => page.evaluate(async () =>
  (await import('/app/machine.js')).machineStatus());
const frameStats = page => page.evaluate(async () =>
  (await import('/app/machine.js')).frameStats());

// 保真像素基准（ADR-0004）：同一条归一化坐标，在主页画布与 /glb 原貌页画布上取 5×5 中位色块。
// 机身取景会随布局和相机收敛变化，所以"取景矩形 + 像素"必须在同一次 evaluate 里读完，
// 分两次读会错位。色块靠极值找（金取最黄、靛蓝取最暗），但打分的是 5×5 中位数本身 ——
// 零散的抗锯齿暗点会在中位数里被淘汰，只有真是整块色的位置才留得下。
const FIDELITY_PROBES = [
  { id: '壳-左',   fx: 0.100, fy: 0.72, mode: 'flat' },
  { id: '壳-右',   fx: 0.865, fy: 0.72, mode: 'flat' },
  { id: '饰条-左', fx: 0.020, fy: 0.50, mode: 'gold',   wx: 0.016, wy: 0.04 },
  { id: '饰条-右', fx: 0.980, fy: 0.50, mode: 'gold',   wx: 0.016, wy: 0.04 },
  { id: '靛蓝-左', fx: 0.021, fy: 0.20, mode: 'indigo', wx: 0.010, wy: 0.014 },
  { id: '靛蓝-右', fx: 0.986, fy: 0.50, mode: 'indigo', wx: 0.016, wy: 0.018 },
];
const FIDELITY_MAX_DIFF = 8;    // 单通道：必须过
const FIDELITY_MEAN_DIFF = 4;   // 六个探针的均值：参考线
const colorHex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const sampleFidelity = (page, sel) => page.evaluate(async ({ sel, probes }) => {
  const c = document.querySelector(sel);
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const dpr = c.width / c.clientWidth;
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => {                       // CSS px → 画布像素，翻转 y
    const X = Math.round(x * dpr), Y = Math.round(y * dpr);
    if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) return null;
    const k = ((c.height - 1 - Y) * c.width + X) * 4;
    return [px[k], px[k + 1], px[k + 2]];
  };
  const median = list => { const s = [...list].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
  const patch = (x, y) => {
    const rs = [], gs = [], bs = [];
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const p = at(x + i, y + j);
      if (!p) return null;
      rs.push(p[0]); gs.push(p[1]); bs.push(p[2]);
    }
    return [median(rs), median(gs), median(bs)];
  };
  const score = (p, mode) => {
    if (!p) return null;
    if (mode === 'gold') return p[0] - p[2];
    if (mode === 'indigo') {
      return (p[2] - p[0]) >= 6 && p[0] + p[1] + p[2] <= 300 ? -(p[0] + p[1] + p[2]) : null;
    }
    return 0;
  };
  // /glb 页自己暴露取景框；主页面问 machine.js 现算的投影
  const frame = typeof window.__glbFrame === 'function'
    ? window.__glbFrame()
    : (await import('/app/machine.js')).machineStatus().tablet;
  if (!frame || !(frame.w > 0)) return { frame: null, out: [] };
  const out = [];
  for (const s of probes) {
    const x0 = frame.x + frame.w * s.fx, y0 = frame.y + frame.h * s.fy;
    const wx = Math.max(0, Math.round(frame.w * (s.wx || 0)));
    const wy = Math.max(0, Math.round(frame.h * (s.wy || 0)));
    let best = null;
    for (let j = -wy; j <= wy; j++) for (let i = -wx; i <= wx; i++) {
      const x = Math.round(x0) + i, y = Math.round(y0) + j;
      const pm = patch(x, y), sc = score(pm, s.mode);
      if (sc === null) continue;
      const d = Math.hypot(i, j);
      if (!best || sc > best.sc || (sc === best.sc && d < best.d)) best = { sc, d, p5: pm };
    }
    out.push({ id: s.id, p5: best ? best.p5 : null });
  }
  return { frame, out };
}, { sel, probes: FIDELITY_PROBES });

// 比色：逐探针单通道差 ≤8 必须过；均值只报不卡（ADR-0004 的参考线）。
function compareFidelity(mainSample, refSample) {
  let worst = 0, sum = 0, n = 0;
  for (const p of FIDELITY_PROBES) {
    const ref = (refSample.out || []).find(o => o.id === p.id);
    const own = (mainSample.out || []).find(o => o.id === p.id);
    if (!ref?.p5 || !own?.p5) { problems.push(`保真探针「${p.id}」没取到色块`); continue; }
    const d = Math.max(...ref.p5.map((v, i) => Math.abs(v - own.p5[i])));
    worst = Math.max(worst, d); sum += d; n++;
    if (d > FIDELITY_MAX_DIFF) {
      problems.push(`保真探针「${p.id}」比 /glb 原貌差 ${d}/255（上限 ${FIDELITY_MAX_DIFF}）：` +
        `主页面 ${colorHex(own.p5)} vs 原貌 ${colorHex(ref.p5)}`);
    }
  }
  const mean = n ? sum / n : NaN;
  console.log(`保真色块 ${n}/${FIDELITY_PROBES.length} 个：最大单通道差 ${worst}，均值 ${mean.toFixed(2)}` +
    `（上限 ${FIDELITY_MAX_DIFF} / 参考 ${FIDELITY_MEAN_DIFF}）`);
}
async function waitForMachineState(page, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await machineStatus(page);
    const retryHidden = await page.locator('#machine-retry')
      .evaluate(el => el.hidden);
    if (predicate(state, retryHidden)) return state;
    await page.waitForTimeout(100);
  }
  throw new Error('机身状态在 30 秒内没有达到预期');
}
const rectOverlap = (a, b) =>
  !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
async function waitForFramesToSettle(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = (await frameStats(page)).frameCount;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = (await frameStats(page)).frameCount;
    if (now === last) return;
    last = now;
  }
  throw new Error('渲染在 20 秒内没有稳定');
}

try {
  if (!(await portIsFree())) throw new Error(`端口 ${PORT} 已被占用，请先停止占用进程`);
  server = spawn('.venv/bin/python', ['-m', 'ddz', 'serve', '--port', String(PORT)],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExited = new Promise(resolve => server.once('exit', resolve));
  await waitForHealth();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  // 故意造一次被服务端拒掉的出牌时，浏览器会记一条 400；只有那一下放行
  let expectReject = false;
  watchPage(page, '主页面', msg => expectReject && /400 \(Bad Request\)/.test(msg));

  // 机身还在下载时是 loading，不是失败：这时不能先弹「机身不可用」
  let holdGlb = true;
  await page.route('**/assets/console-b.glb', async route => {
    if (holdGlb) await new Promise(r => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto(`${BASE}/`);
  if (!(await page.locator('#machine-error').evaluate(el => el.hidden))) {
    problems.push('3D 机身还在加载（loading）时就弹出了错误提示');
  }
  holdGlb = false;
  await page.waitForSelector('#who', { timeout: 40000 });
  await page.waitForFunction(() => (document.getElementById('who')?.textContent || '').includes('·'), null,
    { timeout: 40000 });
  await waitForMachineState(page, s => s.status === 'ready' && s.ready);
  await page.waitForTimeout(900);

  // 座位与人称：以我方为参照；身份是徽章不是座位名
  const boardText = await text(page, '#board');
  for (const word of ['我', '上家', '下家']) {
    if (!boardText.includes(word)) problems.push(`牌桌上没出现「${word}」——座位名没有以我方为参照`);
  }
  if ((await page.locator('#board .seat-label .badge.landlord').count()) !== 1) {
    problems.push('地主身份徽章不是恰好一个');
  }
  if ((await page.locator('#board .seat-label').count()) !== 3) problems.push('牌桌不是三个座位');
  if ((await page.locator('#board .seat-label.is-me').count()) !== 1) problems.push('没标出哪个座位是我');
  if (!/\d+ 张/.test(boardText)) problems.push('牌桌没显示张数');

  // 3D 画布真的在画东西
  const gl = await page.evaluate(() => {
    const c = document.getElementById('scene');
    if (!c) return { ok: false, why: '找不到 3D 画布' };
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    if (!ctx) return { ok: false, why: '没有 WebGL 上下文' };
    const px = new Uint8Array(c.width * c.height * 4);
    ctx.readPixels(0, 0, c.width, c.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    const seen = new Set();
    for (let i = 0; i < px.length; i += 4) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
    return { ok: true, colors: seen.size };
  });
  if (!gl.ok) problems.push(`3D 画布：${gl.why}`);
  else if (gl.colors < 3) problems.push(`3D 画布几乎是纯色（${gl.colors} 种颜色），场景没画出来`);

  // 根路径就是 GLB 机身；屏、键热区都由模型量出
  const shell = await machineStatus(page);
  const requiredNodes = ['Shell','SideBand','Bezel','Screen','Trim','Buttons','KeyWell_L','KeyWell_R','Screws','SubDisplay','BackKey'];
  if (shell.source !== 'glb') problems.push(`根路径机身来源不是 glb：${shell.source}`);
  if (shell.status !== 'ready' || !shell.ready) problems.push(`根路径 GLB 机身未就绪：${shell.status} ${shell.error}`);
  for (const name of requiredNodes) if (!shell.nodes.includes(name)) problems.push(`GLB 缺少节点 ${name}`);
  if (!shell.buttonsVisible) problems.push('GLB Buttons 节点不可见');
  // ADR-0004 保真：主页面就是原貌渲染 —— 无环境贴图、不套色调映射、固定三盏基础灯
  if (shell.environment) problems.push('主页面不该有环境贴图（IBL）');
  if (shell.toneMappingName !== 'None') problems.push(`主页面色调映射不是 None：${shell.toneMappingName}`);
  if (shell.toneMappingExposure !== 1) problems.push(`主页面曝光不是 1：${shell.toneMappingExposure}`);
  const lights = shell.lights || [];
  const lightKey = l => `${l.type}|${l.intensity}|${l.color}|${l.position.map(v => v.toFixed(3)).join(',')}`;
  const wantedLights = ['AmbientLight|1.2|#ffffff|0.000,0.000,0.000',
                        'DirectionalLight|1.6|#ffffff|-4.000,6.000,8.000',
                        'DirectionalLight|0.5|#dfe8ff|6.000,2.000,6.000'];
  if (lights.length !== 3) problems.push(`主页面灯光数量不是 3：${lights.length}`);
  else for (const want of wantedLights) {
    if (!lights.map(lightKey).includes(want)) problems.push(`主页面缺少灯 ${want}`);
  }
  if (!shell.contactShadow) problems.push('主页面没有机底接触阴影');
  if (!shell.screen || shell.screen.w < 2 || shell.screen.h < 2) problems.push('没有从 GLB 量出真屏矩形');
  if (!shell.screenSize || shell.screenSize.w <= 0 || shell.screenSize.h <= 0) problems.push('真屏包围盒尺寸无效');
  if (shell.buttons.length !== 10) problems.push(`透明键热区数量不是 10：${shell.buttons.length}`);

  const hotspots = await page.locator('#controls .key').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id, w: r.width, h: r.height, disabled: el.disabled,
             clip: getComputedStyle(el).clipPath };
  }));
  if (hotspots.length !== 10) problems.push(`HTML 键热区数量不是 10：${hotspots.length}`);
  for (const h of hotspots){
    if (h.w < 8 || h.h < 8) problems.push(`键热区 ${h.id} 尺寸过小：${h.w}×${h.h}`);
    if (h.clip === 'none' && ['play-hint-btn','undo','play-go','play-pass'].includes(h.id)) {
      problems.push(`菱形键热区 ${h.id} 没有贴合描边`);
    }
  }
  for (const id of ['dpad-up','dpad-left','play-clear','dpad-right','dpad-down','new-round',
                    'play-hint-btn','undo','play-go','play-pass']) {
    if (!hotspots.some(h => h.id === id)) problems.push(`缺少主键热区 ${id}`);
  }

  // 静止后不再出帧；DPR 不超过 2
  await waitForFramesToSettle(page);

  // #25 操作台归位：出牌机会箱是台面第一个箱子，托盘顶边贴住机身下沿（画布留白用等量负 margin 收掉）
  const deck = await page.evaluate(() => {
    const bar = document.getElementById('deckbar');
    const cells = [...bar.querySelectorAll(':scope > .cell')];
    return { first: cells[0] ? cells[0].id : '', ids: cells.map(c => c.id) };
  });
  if (deck.first !== 'step-cell') {
    problems.push(`操作台最左的箱子不是出牌机会：${deck.first || '(空)'}（${deck.ids.join(',')}）`);
  }
  const seam = await page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const chassis = document.getElementById('chassis').getBoundingClientRect();
    return { stageTop: stage.top, chassisTop: chassis.top,
             lip: document.getElementById('board').style.getPropertyValue('--lip') };
  });
  const tab = (await machineStatus(page)).tablet;
  if (!tab) problems.push('量不到机身取景框，操作台贴合判定不成立');
  else {
    const gap = seam.chassisTop - (seam.stageTop + tab.y + tab.h);
    if (gap > 12) problems.push(`操作台没贴住机身下沿：缝隙 ${gap.toFixed(1)}px（上限 12px，lip=${seam.lip}）`);
    if (gap < -1) problems.push(`操作台压进了机身：${gap.toFixed(1)}px`);
  }

  // 取景和相机都停了才取样，否则探针坐标会落在机身别的地方
  const mainFidelity = await sampleFidelity(page, '#scene');
  const idleA = await frameStats(page);
  await page.waitForTimeout(500);
  const idleB = await frameStats(page);
  if (idleB.frameCount !== idleA.frameCount) {
    problems.push(`静止 500ms 后仍在出帧：${idleA.frameCount} → ${idleB.frameCount}`);
  }
  if (idleB.dpr > 2) problems.push(`DPR 超过 2：${idleB.dpr}`);

  // 视差动画也必须有明确终点：鼠标停住后 500ms 不再续帧
  const stageBox = await page.locator('#scene').boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width * 0.18, stageBox.y + stageBox.height * 0.28);
  await page.mouse.move(stageBox.x + stageBox.width * 0.72, stageBox.y + stageBox.height * 0.62);
  await page.waitForTimeout(400);
  await waitForFramesToSettle(page);
  const parallaxA = await frameStats(page);
  await page.waitForTimeout(500);
  const parallaxB = await frameStats(page);
  if (parallaxB.frameCount !== parallaxA.frameCount) {
    problems.push(`视差停止 500ms 后仍在出帧：${parallaxA.frameCount} → ${parallaxB.frameCount}`);
  }
  await page.mouse.move(stageBox.x - 5, stageBox.y - 5);

  // 机顶条：15 个点数；↓ 切到概率模式
  if ((await page.locator('#counter .cc').count()) !== 15) problems.push('机顶条不是 15 个点数');
  await page.click('#dpad-down');
  await page.waitForTimeout(300);
  if ((await text(page, '#bar-mode')) !== '出牌概率') problems.push('机顶条没切到出牌概率');
  if ((await page.locator('#counter .cc .bar').count()) < 10) problems.push('概率模式没有画出双色条');
  // 机顶那个按钮本身也能切
  await page.click('#bar-mode');
  await page.waitForTimeout(250);
  if ((await text(page, '#bar-mode')) !== '记牌') problems.push('机顶按钮切不回记牌');
  if ((await page.locator('#counter .cc i s').count()) < 20) problems.push('记牌模式没有画出红点');

  // 数据面板：默认不占页面，点"数据面板"才盖在屏幕上
  if (await page.locator('#crt').evaluate(el => el.classList.contains('is-open'))) {
    problems.push('数据面板默认就打开着（应该是点开才盖上来）');
  }
  await page.click('#data-toggle');
  await page.waitForTimeout(400);
  if (!(await page.locator('#crt').evaluate(el => el.classList.contains('is-open')))) {
    problems.push('数据面板点不开');
  }
  if (!(await page.locator('#crt').isVisible())) problems.push('数据面板打开后不可见');
  if ((await page.locator('#calib tr').count()) < 2) problems.push('校准表是空的');
  const canvasBlank = await page.evaluate(() => {
    const c = document.getElementById('cloud');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
    return true;
  });
  if (canvasBlank) problems.push('粒子云画布是空的');
  const panelRects = await page.evaluate(() => ({
    panel: document.getElementById('crt').getBoundingClientRect().toJSON(),
    screen: document.getElementById('screen-hud').getBoundingClientRect().toJSON(),
    panelOpen: document.getElementById('board').classList.contains('panel-open'),
  }));
  if (!panelRects.panelOpen) problems.push('数据面板打开后没有进入机侧布局');
  if (rectOverlap(panelRects.panel, panelRects.screen)) problems.push('宽屏数据面板盖住了真屏');
  if (panelRects.panel.left < panelRects.screen.right) problems.push('宽屏数据面板不在机身右侧');
  await page.screenshot({ path: '/tmp/ddz-web-1.png', fullPage: true });

  // 交互 1：在屏幕里点自己的牌 → 选中；再点同一张 → 取消；清空
  // 选中模型是"按点数计数、从左往右抬起"的，所以要点那张真正会被抬起的牌
  // （它自己的点数在它左边没出现过），否则点在重复点数的第二/三张上是"再加一张"。
  const hand = await page.evaluate(async () => (await import('/app/state.js')).S.snap.my_hand);
  let first = hand.length - 1;
  while (first > 0 && hand.indexOf(hand[first]) !== first) first--;
  const pts1 = await handPts(page);
  if (pts1.length < 3) problems.push('屏里拿不到足够的手牌坐标');
  else {
    await clickCard(page, first); await page.waitForTimeout(180);
    if ((await page.locator('#play-chips i.c').count()) !== 1) problems.push('点一张牌没有选中');
    await clickCard(page, first); await page.waitForTimeout(180);
    if ((await page.locator('#play-chips i.c').count()) !== 0) problems.push('再点同一张没有取消选中');
    const at = [0.2, 0.5, 0.8].map(f => Math.round((pts1.length - 1) * f));
    for (const k of at) { await clickCard(page, k); await page.waitForTimeout(140); }
    if ((await page.locator('#play-chips i.c').count()) < 2) problems.push('连点几张牌没有都选上');
    if (await page.locator('#play-chips i.c').count()) {
      await page.click('#play-clear'); await page.waitForTimeout(150);
      if ((await page.locator('#play-chips i.c').count()) !== 0) problems.push('清空没有清掉选中的牌');
    }
  }

  // #25 出牌机会切换：台面里的 ←/→ 与握把上的 ←/→ 同源，点了真的换局面
  const stepState = () => page.evaluate(() => ({
    now: document.getElementById('step-now').textContent.trim(),
    prevOff: document.getElementById('step-prev').disabled,
    nextOff: document.getElementById('step-next').disabled,
    leftOff: document.getElementById('dpad-left').disabled,
    rightOff: document.getElementById('dpad-right').disabled,
    latestHidden: document.getElementById('play-latest').hidden,
    hint: document.getElementById('play-hint').textContent,
  }));
  const st0 = await stepState();
  if (!/第\s*\d+/.test(st0.now)) problems.push(`出牌机会没显示编号：${st0.now}`);
  if (st0.prevOff !== st0.leftOff || st0.nextOff !== st0.rightOff) {
    problems.push('台面的 ←/→ 与握把上的 ←/→ 可用状态不一致');
  }
  if (st0.latestHidden) problems.push('在看历史局面时没有给出「回到最新」的入口');
  if (!st0.hint.includes('回到最新')) problems.push('看历史局面时没提示「回到最新才能继续录」');
  if (st0.nextOff) problems.push('历史局面下「下一次出牌机会」却点不动');
  else {
    await page.click('#step-next'); await page.waitForTimeout(900);
    const st1 = await stepState();
    if (st1.now === st0.now) problems.push('点「下一次出牌机会」没有换局面');
    await page.click('#step-prev'); await page.waitForTimeout(900);
    const st2 = await stepState();
    if (st2.now !== st0.now) problems.push(`点「上一次出牌机会」没回到原来那一手：${st0.now} → ${st2.now}`);
  }

  // 交互 2：推荐键 → 选中模型给的那一手（并在提示里说明是第几个候选）
  await page.click('#play-hint-btn');
  await page.waitForTimeout(250);
  if (!(await text(page, '#play-hint')).includes('推荐')) problems.push('推荐键没有给出反馈');

  // 交互 2b：终局 —— 跳到最后那一手，操作台必须收手，不再提示"该谁出牌"
  await page.click('#play-latest');
  await page.waitForTimeout(1200);
  if (!(await text(page, '#play-who')).includes('牌局已结束')) {
    problems.push('终局时操作台没报「牌局已结束」');
  }
  if (!(await page.locator('#play-go').isDisabled())
      || !(await page.locator('#play-pass').isDisabled())) {
    problems.push('终局时「出牌 / 不要」还能点');
  }
  if (await page.locator('#opp-cell').isVisible()) problems.push('终局时还留着录对手牌的入口');
  if (!(await text(page, '#banner')).includes('牌局已结束')) problems.push('终局横幅没说明牌局已结束');

  // 交互 3：左握把那个方键开新一轮 → 屏幕里录入 → 开局（我方当地主，第一手由我领出）
  await page.click('#new-round');
  await page.waitForTimeout(300);
  if (!(await page.locator('#newgame').isVisible())) problems.push('开新一轮的浮层没打开');
  for (const [me, size] of [['landlord', 20], ['landlord_down', 17], ['landlord_up', 17]]) {
    await page.selectOption('#new-me', me);
    if (!(await text(page, '#new-count')).includes(`0/${size}`)) {
      problems.push(`${me} 的手牌进度没有使用服务端张数 ${size}`);
    }
  }
  await page.selectOption('#new-me', 'landlord');
  const tapNew = async keys => { for (const k of keys) await page.click(`#new-keys button[data-key="${k}"]`); };
  // ① 粘贴牌串这一条路：地主的底牌必须在自己手上，所以 T/J/Q 既算手牌也算底牌
  await page.fill('#new-paste', '33344455566677889TJQ');
  await page.click('#new-paste-go');
  await page.waitForTimeout(250);
  if (!(await text(page, '#new-count')).includes('20/20')) problems.push('粘贴牌串没有把手牌录进去');
  // ② 点牌盘这一条路：补 3 张底牌
  await tapNew(['T','J','Q']);
  if (!(await text(page, '#new-count')).includes('20/20')) problems.push('牌盘没数对手牌张数');
  await page.click('#new-go');
  await page.waitForTimeout(1600);
  if (!(await text(page, '#banner')).includes('已开局')) problems.push('开新局没有反馈');
  if (!(await text(page, '#board')).includes('该你出')) problems.push('开新局后第一手不是我方');

  // #25 服务端拒掉一手时，已经选中的牌不能被清空（点了两张不同点数，凑不成牌型）
  {
    const handNow = await page.evaluate(async () => (await import('/app/state.js')).S.snap.my_hand);
    let other = 1;
    while (other < handNow.length && handNow[other] === handNow[0]) other++;
    if (other >= handNow.length) problems.push('开局手牌清一色，没法造非法出牌');
    else {
      await clickCard(page, 0); await page.waitForTimeout(150);
      await clickCard(page, other); await page.waitForTimeout(150);
      const picked = await page.locator('#play-chips i.c').count();
      if (picked !== 2) problems.push(`想选两张不同点数的牌，实际选上 ${picked} 张`);
      expectReject = true;
      await page.click('#play-go');
      await page.waitForTimeout(900);
      expectReject = false;
      const afterReject = await page.locator('#play-chips i.c').count();
      if (afterReject !== picked) {
        problems.push(`出牌被服务端拒掉后已选中的牌被清空了：${picked} → ${afterReject} 张`);
      }
      const kind = await page.locator('#banner').getAttribute('data-kind');
      if (kind !== 'error') problems.push(`出牌被服务端拒掉后横幅没报错（kind=${kind}）：${await text(page, '#banner')}`);
      await page.click('#play-clear'); await page.waitForTimeout(150);
    }
  }

  // 交互 4：在屏幕里点一张自己的牌 → 出牌（领出时单张一定合法）
  const n4 = (await handPts(page)).length;
  await clickCard(page, Math.round((n4 - 1) * 0.5));
  await page.waitForTimeout(220);
  if (!(await page.locator('#play-chips i.c').count())) problems.push('轮到我方时，屏幕里点牌没选上');
  await page.click('#play-go');
  await page.waitForTimeout(1400);
  if (!(await text(page, '#banner')).includes('已录')) problems.push('录我方的牌没有反馈');

  // 交互 5：轮到对手 → 出场"录对手牌"的点数条，且能选、受牌池上限约束
  if (!(await page.locator('#opp-cell').isVisible())) {
    problems.push('轮到对手时没有给出录对手牌的入口');
  } else {
    const key = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#play-keys button[data-key]')].find(x => !x.disabled);
      return b ? b.dataset.key : null;
    });
    if (!key) problems.push('点数条上没有任何可点的点数');
    else {
      await page.click(`#play-keys button[data-key="${key}"]`);
      await page.waitForTimeout(150);
      const one = await page.locator('#play-chips i.c').count();
      await page.click(`#play-keys button[data-key="${key}"]`);
      await page.waitForTimeout(150);
      const two = await page.locator('#play-chips i.c').count();
      if (one !== 1) problems.push('点数条点了没反应');
      if (two === one && !(await text(page, '#banner')).includes('只剩')) {
        problems.push('点数条超过牌池时没有说明原因');
      }
      await page.click('#play-clear');
      await page.waitForTimeout(150);
    }
    // 这一手按"不要"记下去（对手的牌是背面，实际牌型由服务端裁定）
    await page.click('#play-pass');
    await page.waitForTimeout(1400);
    if (!(await text(page, '#banner')).includes('已录')) problems.push('录对手不要没有反馈');
  }

  await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });

  // 交互 7：撤销
  await page.click('#undo');
  await page.waitForTimeout(1000);
  if (!(await text(page, '#banner')).includes('已撤销')) problems.push('撤销没有反馈');

  // 窄屏：不出横向滚动条，保留 3D 正视，数据面板在机下且不遮屏
  await page.setViewportSize({ width: 420, height: 1200 });
  await page.waitForTimeout(700);
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    panel: document.getElementById('crt').getBoundingClientRect().toJSON(),
    screen: document.getElementById('screen-hud').getBoundingClientRect().toJSON(),
    panelOpen: document.getElementById('board').classList.contains('panel-open'),
    status: document.getElementById('board').classList.contains('is-stacked'),
  }));
  if (narrow.overflow > 2) problems.push(`窄屏出现横向溢出 ${narrow.overflow}px`);
  if (!narrow.panelOpen || !narrow.status) problems.push('窄屏数据面板没有进入机下布局');
  if (rectOverlap(narrow.panel, narrow.screen)) problems.push('窄屏数据面板盖住了真屏');
  if (narrow.panel.top < narrow.screen.bottom) problems.push('窄屏数据面板不在机身下方');
  const touchTargets = await page.locator('#touchbar button').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, visible: getComputedStyle(el).display !== 'none' };
  }));
  if (touchTargets.length !== 10) problems.push(`窄屏操作条按钮数量不是 10：${touchTargets.length}`);
  for (const [i, t] of touchTargets.entries()) {
    if (!t.visible || t.w < 44 || t.h < 44) {
      problems.push(`窄屏操作条第 ${i + 1} 个目标不足 44px：${t.w}×${t.h}`);
    }
  }
  // #25 窄屏机身/机顶屏/操作台的版式硬约束：机身留主角位，记牌字能读，
  // 托盘各层不互相压住，触控条不把页面撑宽。
  const narrowLayout = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const stage = r('stage'), chassis = r('chassis'), score = r('scoreboard');
    const deck = r('deckbar'), touch = r('touchbar');
    const counterEl = document.getElementById('counter'), counter = counterEl.getBoundingClientRect();
    const cell = document.querySelector('#counter .cc');
    const handline = document.getElementById('handline');
    const barMode = document.getElementById('bar-mode');
    const rowTops = {};
    document.querySelectorAll('#counter .cc').forEach(el => {
      const y = Math.round(el.getBoundingClientRect().top);
      rowTops[y] = (rowTops[y] || 0) + 1;
    });
    return {
      stageH: stage.height, chassisH: chassis.height,
      scoreTop: score.top, scoreBottom: score.bottom,
      deckTop: deck.top, deckBottom: deck.bottom,
      touchTop: touch.top, touchBottom: touch.bottom,
      chassisTop: chassis.top, chassisBottom: chassis.bottom,
      counterFs: parseFloat(getComputedStyle(counterEl).fontSize),
      counterCellW: cell ? cell.getBoundingClientRect().width : 0,
      counterRows: Object.values(rowTops),
      handlineHidden: !handline || getComputedStyle(handline).display === 'none',
      barModeHidden: !barMode || getComputedStyle(barMode).display === 'none',
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      bodyOverflow: document.body.scrollWidth - innerWidth,
    };
  });
  if (narrowLayout.stageH < narrowLayout.chassisH) {
    problems.push(`窄屏机身比台面还矮：stage ${narrowLayout.stageH.toFixed(1)}px < chassis ${narrowLayout.chassisH.toFixed(1)}px`);
  }
  if (!narrowLayout.handlineHidden) problems.push('420px 仍显示平面手牌副本，和 3D 9+8 手牌重复占高');
  if (!narrowLayout.barModeHidden) problems.push('420px 机顶屏仍占宽显示切换键');
  if (narrowLayout.counterFs < 10) problems.push(`420px 机顶记牌字号过小：${narrowLayout.counterFs}px`);
  if (narrowLayout.counterCellW < 20) problems.push(`420px 机顶记牌格宽过窄：${narrowLayout.counterCellW.toFixed(1)}px`);
  if (JSON.stringify(narrowLayout.counterRows) !== JSON.stringify([8, 7])) {
    problems.push(`420px 机顶记牌不是 8+7 两行：${narrowLayout.counterRows.join('+')}`);
  }
  if (narrowLayout.scoreBottom > narrowLayout.deckTop + 1) {
    problems.push(`窄屏计分板与操作台相撞：${narrowLayout.scoreBottom.toFixed(1)} > ${narrowLayout.deckTop.toFixed(1)}`);
  }
  if (narrowLayout.deckBottom > narrowLayout.touchTop + 1) {
    problems.push(`窄屏操作台与触控条相撞：${narrowLayout.deckBottom.toFixed(1)} > ${narrowLayout.touchTop.toFixed(1)}`);
  }
  if (narrowLayout.scoreTop < narrowLayout.chassisTop - 1
      || narrowLayout.deckBottom > narrowLayout.chassisBottom + 1) {
    problems.push('窄屏计分板/操作台没有收进机身壳体');
  }
  if (Math.abs(narrowLayout.touchTop - narrowLayout.chassisBottom) > 2) {
    problems.push(`窄屏触控条没有从机身底边接出：差 ${(narrowLayout.touchTop - narrowLayout.chassisBottom).toFixed(1)}px`);
  }
  if (narrowLayout.docOverflow > 2 || narrowLayout.bodyOverflow > 2) {
    problems.push(`420px 页面级横向溢出：html ${narrowLayout.docOverflow}px / body ${narrowLayout.bodyOverflow}px`);
  }

  // 新开一页复核 17 张这个真实高频状态；主流程此时已经改过手牌，不能拿它冒充 17 张。
  const fresh420 = await browser.newPage({ viewport: { width: 420, height: 1200 } });
  watchPage(fresh420, '420 复核');
  await fresh420.goto(`${BASE}/`);
  await fresh420.waitForSelector('#who', { timeout: 40000 });
  await fresh420.waitForFunction(() => (document.getElementById('who')?.textContent || '').includes('·'), null,
    { timeout: 40000 });
  await waitForMachineState(fresh420, s => s.status === 'ready' && s.ready);
  await fresh420.waitForTimeout(1200);
  const freshHand = await fresh420.evaluate(async () => {
    const m = await import('/app/machine.js');
    const { S } = await import('/app/state.js');
    const pts = m.handPoints();
    const hits = pts.map(p => ({ i: p.i, pick: m.pickCardAt(p.x, p.y) }));
    return { n: S.snap.my_hand.length, rows: m.machineStatus().handRows,
             pts: hits.length, miss: hits.filter(p => p.i !== p.pick) };
  });
  if (freshHand.n !== 17) problems.push(`420px 复核样本不是 17 张：${freshHand.n}`);
  if (freshHand.rows.length !== 2 || freshHand.rows[0]?.count !== 9 || freshHand.rows[1]?.count !== 8) {
    problems.push(`420px 17 张手牌不是 9+8 双排：${freshHand.rows.map(r => r.count).join('+')}`);
  }
  if (freshHand.pts !== freshHand.n || freshHand.miss.length) {
    problems.push(`420px 手牌拾取错位：${freshHand.pts}/${freshHand.n} 个点，错 ${freshHand.miss.length} 张`);
  }
  await fresh420.close();

  // 窄屏仍能从屏里点中真牌
  const narrowPts = await handPts(page);
  if (narrowPts.length < 3) problems.push('窄屏屏里拿不到手牌坐标');
  else {
    await clickCard(page, 0);
    await page.waitForTimeout(180);
    if ((await page.locator('#play-chips i.c').count()) < 1) problems.push('窄屏点真牌没有选中');
  }
  const narrowCloud = await page.evaluate(async () => {
    const c = document.getElementById('cloud');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blank = true;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { blank = false; break; }
    const { S } = await import('/app/state.js');
    return { blank, empty: document.getElementById('cloud-wrap').classList.contains('is-empty'),
             hasPoint: Boolean(S.point) };
  });
  if (narrowCloud.hasPoint && (narrowCloud.blank || narrowCloud.empty)) {
    problems.push('窄屏有分析数据时粒子云却是空的');
  }
  // #25 窄屏上出牌机会箱也要在台面里、能被点，不溢出屏幕
  await page.evaluate(() => document.getElementById('play-clear')?.click());
  await page.waitForTimeout(150);
  const narrowStep = () => page.evaluate(() => {
    const cell = document.getElementById('step-cell');
    const r = cell.getBoundingClientRect();
    const prev = document.getElementById('step-prev').getBoundingClientRect();
    const next = document.getElementById('step-next').getBoundingClientRect();
    return { w: r.width, h: r.height, right: r.right, vw: innerWidth,
             now: document.getElementById('step-now').textContent.trim(),
             btnW: Math.min(prev.width, next.width), btnH: Math.min(prev.height, next.height),
             prevOff: document.getElementById('step-prev').disabled,
             nextOff: document.getElementById('step-next').disabled };
  });
  const ns0 = await narrowStep();
  if (ns0.w < 60 || ns0.h < 30) problems.push(`窄屏出牌机会箱被压没了：${ns0.w}×${ns0.h}`);
  if (!ns0.now) problems.push('窄屏出牌机会没有显示编号');
  if (ns0.btnW < 20 || ns0.btnH < 20) problems.push(`窄屏出牌机会按钮过小：${ns0.btnW}×${ns0.btnH}`);
  if (ns0.right > ns0.vw + 2) problems.push('窄屏出牌机会箱溢出屏幕');
  if (ns0.nextOff && ns0.prevOff) {
    problems.push('窄屏出牌机会两个方向都点不动（历史局面应有可换的一手）');
  } else {
    const fwd = !ns0.nextOff;
    await page.click(fwd ? '#step-next' : '#step-prev');
    await page.waitForTimeout(900);
    const ns1 = await narrowStep();
    if (ns1.now === ns0.now) problems.push('窄屏点出牌机会按钮没有换局面');
    // 回到最新那一手：有「回到最新」就用它，否则反向点一次
    if (!(await page.locator('#play-latest').isHidden())) {
      await page.click('#play-latest'); await page.waitForTimeout(900);
    } else {
      await page.click(fwd ? '#step-prev' : '#step-next');
      await page.waitForTimeout(900);
    }
  }

  // 最后一次点牌/按键操作后也必须归于静止
  await waitForFramesToSettle(page);
  const lastInputA = await frameStats(page);
  await page.waitForTimeout(500);
  const lastInputB = await frameStats(page);
  if (lastInputB.frameCount !== lastInputA.frameCount) {
    problems.push(`最后一次操作后静止 500ms 仍在出帧：${lastInputA.frameCount} → ${lastInputB.frameCount}`);
  }
  await page.screenshot({ path: '/tmp/ddz-web-3.png', fullPage: true });

  // /glb：原样查看模型，不加环境贴图、不加色调映射
  {
    // 视口必须能把整机装进画布：这是保真比色的坐标系，被裁掉就会取不到边缘色块
    const glb = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    watchPage(glb, '/glb');
    await glb.goto(`${BASE}/glb`);
    await glb.waitForFunction(() => window.__glbPage?.(), null, { timeout: 30000 });
    const status = await glb.evaluate(() => window.__glbStatus());
    if (!status.ready) problems.push('/glb：模型没有加载上');
    if (status.environment) problems.push('/glb：不应有环境贴图');
    if (status.toneMapping !== 0) problems.push(`/glb：不应设置色调映射（${status.toneMapping}）`);
    const refFrame = await glb.evaluate(() => ({ frame: window.__glbFrame(), w: innerWidth, h: innerHeight }));
    const rf = refFrame.frame;
    if (!rf || rf.x < 0 || rf.y < 0 || rf.x + rf.w > refFrame.w || rf.y + rf.h > refFrame.h) {
      problems.push(`/glb：${refFrame.w}×${refFrame.h} 没把机身完整放进画布，保真比色不成立`);
    }
    if (mainFidelity.frame) compareFidelity(mainFidelity, await sampleFidelity(glb, '#c'));
    else problems.push('主页面没量出机身取景框，保真比色不成立');
    await glb.screenshot({ path: '/tmp/ddz-web-glb.png' });
    await glb.close();
  }

  // GLB 失败：明确错误 + 重试，数据面板仍可读
  {
    const failed = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
    let allowGlbAbort = true;
    watchPage(failed, 'GLB 失败态',
      msg => allowGlbAbort && /net::ERR_FAILED|Failed to load resource/i.test(msg));
    await failed.route('**/assets/console-b.glb', route => route.abort());
    await failed.goto(`${BASE}/`);
    await waitForMachineState(failed, s => s.status === 'error' && !s.ready);
    const status = await machineStatus(failed);
    if (status.status !== 'error' || !status.error) problems.push('GLB 失败后没有明确错误状态');
    if (await failed.locator('#machine-error').isHidden()) problems.push('GLB 失败后错误提示不可见');
    if (await failed.locator('#machine-retry').isHidden()) problems.push('GLB 失败后没有重试按钮');
    if ((status.nodes || []).length) problems.push('GLB 失败后仍报告模型节点');
    await failed.click('#data-toggle');
    await failed.waitForTimeout(250);
    if (!(await failed.locator('#crt').isVisible())) problems.push('GLB 失败后数据面板不可读');
    if ((await failed.locator('#calib tr').count()) < 2) problems.push('GLB 失败后校准表不可读');
    allowGlbAbort = false;
    let glbRequests = 0;
    failed.on('request', req => {
      if (req.url().includes('/assets/console-b.glb')) glbRequests++;
    });
    const loaded = failed.waitForResponse(
      r => r.url().includes('/assets/console-b.glb') && r.ok(),
      { timeout: 30000 });
    await failed.unroute('**/assets/console-b.glb');
    await failed.click('#machine-retry');
    await loaded;
    await waitForMachineState(failed,
      (s, retryHidden) => s.status === 'ready' && s.buttonsVisible && retryHidden);
    if (glbRequests !== 1) problems.push(`GLB 重试请求次数不是 1：${glbRequests}`);
    const retried = await machineStatus(failed);
    if (retried.status !== 'ready' || !retried.buttonsVisible) {
      problems.push(`GLB 重试后没有恢复到 ready：${retried.status}, Buttons=${retried.buttonsVisible}, ${retried.error || ''}`);
    }
    await failed.close();
  }

  // 无 WebGL：同样明确提示且数据面板可读
  {
    const noGl = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
    await noGl.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return original.call(this, type, ...args);
      };
    });
    watchPage(noGl, '无 WebGL 态',
      msg => /Error creating WebGL context|WebGL is not supported/i.test(msg));
    await noGl.goto(`${BASE}/`);
    await waitForMachineState(noGl, s => s.status === 'no-webgl' && !s.ready);
    const status = await machineStatus(noGl);
    if (status.status !== 'no-webgl' || !status.error) problems.push('无 WebGL 后没有明确错误状态');
    if (await noGl.locator('#machine-error').isHidden()) problems.push('无 WebGL 后错误提示不可见');
    if (await noGl.locator('#machine-retry').isHidden()) problems.push('无 WebGL 后没有重试按钮');
    await noGl.click('#data-toggle');
    await noGl.waitForTimeout(250);
    if (!(await noGl.locator('#crt').isVisible())) problems.push('无 WebGL 后数据面板不可读');
    await noGl.close();
  }

  await browser.close();
} catch (err) {
  problems.push(`验证本身出错：${err.message}`);
} finally {
  await stopServer();
}

console.log(problems.length
  ? '发现问题:\n- ' + problems.join('\n- ')
  : '✔ 无 pageerror / console error；根路径 GLB 机身 + 模型按键透明热区 + 屏内点牌选牌 + 记牌/概率 + 机侧/机下数据面板 + 窄屏操作条 + 错误态 + 机身原貌保真色块 + 按需渲染 均正常');
process.exit(problems.length ? 1 : 0);
