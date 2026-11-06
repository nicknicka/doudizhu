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
// 页面的反馈文案是异步落下来的（提交 → 分析 → 写文案）。慢机器上固定等待会误报，
// 所以需要什么就轮询到什么为止，只有超时才算失败。
const waitUntil = async (page, cond, timeout = 15000) => {
  const t0 = Date.now();
  for (;;){
    if (await cond()) return true;
    if (Date.now() - t0 > timeout) return false;
    await page.waitForTimeout(100);
  }
};
const waitText = (page, sel, needle, timeout = 15000) =>
  waitUntil(page, async () => (((await page.locator(sel).textContent()) || '').includes(needle)), timeout);
const waitBanner = (page, needle, timeout = 15000) => waitText(page, '#banner', needle, timeout);
// 手牌在画布上的中心点：直接问 3D 场景，脚本据此点"真牌"
const handPts = page => page.evaluate(async () => (await import('/app/machine.js')).handPoints());

// 布局 / 3D 投影没落定时，#stage 的盒或手牌坐标会是 null/NaN；直接丢给 mouse.move
// 只会报 "Invalid parameters"，看不出是哪一处（#60 在 CI 上实际踩到过）。这里等到
// 值可用再动手，超时则带出是哪一处 —— 把偶发 NaN 变成「等一下就好」，而不是硬失败。
const finitePoint = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
async function stageBoxOf(page){
  for (let i = 0; i < 50; i++){
    const box = await page.locator('#stage').boundingBox();
    if (box && Number.isFinite(box.x) && Number.isFinite(box.y)) return box;
    await page.waitForTimeout(100);
  }
  throw new Error('#stage 的点击盒一直取不到（布局没落定）');
}
async function handPointOf(page, k){
  for (let i = 0; i < 50; i++){
    const pt = (await handPts(page))[k];
    if (finitePoint(pt)) return pt;
    await page.waitForTimeout(100);
  }
  throw new Error(`第 ${k} 张手牌坐标不是有限数：${JSON.stringify((await handPts(page))[k])}`);
}

// 在屏幕里点第 k 张手牌：先把鼠标移过去让视差收敛，再按收敛后的真实落点点击
const clickCard = async (page, k) => {
  // machine.js 投影出来的手牌坐标是 .stage 局部坐标；机身铺满视口渲染后画布比 .stage 大，
  // 所以点击基准必须取 .stage 而不是画布本身。
  const box = await stageBoxOf(page);
  let pt = await handPointOf(page, k);
  await page.mouse.move(box.x + pt.x, box.y + pt.y);
  await page.waitForTimeout(650);
  pt = await handPointOf(page, k);
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
};

// 操作台是 dock 上沿的浮层，默认收起；需要操作前先展开。
// 展开的是 #panel（不是机身），所以机身版式不受它影响。
const openDeck = async page => {
  const opened = await page.evaluate(() => {
    const p = document.getElementById('panel');
    if (!p) return true;
    if (p.classList.contains('is-open')) return true;
    p.classList.add('is-open');
    return false;
  });
  if (!opened) await page.waitForTimeout(150);
  await page.waitForTimeout(400); // 等浮层拉起动画落位
};
const machineStatus = page => page.evaluate(async () =>
  (await import('/app/machine.js')).machineStatus());

// 操作台浮层的版式硬约束：接在 dock 上沿之上、不压真屏、不出屏、内容不外溢。
// 机身投影的下沿允许被浮层压掉一点点（浮层是立体的一块，最下沿的机座压边 <=24px），
// 但真屏必须完整露出 —— 展开态只平移不缩放，所以 stage + 投影坐标是 1:1 的。
const checkPanelLayout = async (page, label) => {
  const geo = await page.evaluate(async () => {
    const rect = el => el.getBoundingClientRect();
    const stage = rect(document.getElementById('stage'));
    const panel = rect(document.getElementById('panel'));
    const dock = rect(document.getElementById('dock'));
    const deck = rect(document.getElementById('deckbar'));
    const ms = (await import('/app/machine.js')).machineStatus();
    const scr = ms.screen || {}, tab = ms.tablet || {};
    return {
      open: document.getElementById('panel').classList.contains('is-open'),
      panel: panel.toJSON(), dock: dock.toJSON(), deck: deck.toJSON(),
      scrollH: document.getElementById('panel').scrollHeight,
      clientH: document.getElementById('panel').clientHeight,
      screenBottom: stage.top + (scr.y || 0) + (scr.h || 0),
      machineBottom: tab.h ? stage.top + tab.y + tab.h : null,
      vw: innerWidth,
    };
  });
  if (!geo.open) problems.push(`${label}：操作台浮层没有展开`);
  if (geo.panel.bottom > geo.dock.top + 1) {
    problems.push(`${label}：操作台浮层没接在 dock 上沿之上`
      + `（浮层底 ${geo.panel.bottom.toFixed(1)} > dock 顶 ${geo.dock.top.toFixed(1)}）`);
  }
  if (geo.panel.top < geo.screenBottom - 1) {
    problems.push(`${label}：操作台浮层压住真屏`
      + `（浮层顶 ${geo.panel.top.toFixed(1)} < 真屏底 ${geo.screenBottom.toFixed(1)}）`);
  }
  if (geo.machineBottom !== null && geo.panel.top < geo.machineBottom - 24) {
    problems.push(`${label}：操作台浮层把机身投影吃掉了`
      + `（浮层顶 ${geo.panel.top.toFixed(1)}，机底 ${geo.machineBottom.toFixed(1)}）`);
  }
  if (geo.panel.left < -1 || geo.panel.right > geo.vw + 1) {
    problems.push(`${label}：操作台浮层横向出屏`
      + `（${geo.panel.left.toFixed(1)}..${geo.panel.right.toFixed(1)}，视口宽 ${geo.vw}）`);
  }
  if (geo.deck.left < geo.panel.left - 1 || geo.deck.right > geo.panel.right + 1) {
    problems.push(`${label}：操作台内容横向溢出了浮层`);
  }
  if (geo.scrollH > geo.clientH + 1) {
    problems.push(`${label}：操作台内容被浮层裁掉（需要滚动 ${geo.scrollH - geo.clientH}px）`);
  }
};
const frameStats = page => page.evaluate(async () =>
  (await import('/app/machine.js')).frameStats());

// 读副屏的真实 DOM，并检查每一行都落在副屏矩形内；仅看 innerHTML 抓不到裁切。
const probabilityScreen = page => page.evaluate(async () => {
  const { S } = await import('/app/state.js');
  const { label } = await import('/app/labels.js');
  const counter = document.getElementById('counter');
  const box = counter.getBoundingClientRect();
  const rows = [...counter.querySelectorAll('.prob-row')].map(row => {
    const r = row.getBoundingClientRect();
    return {
      label: row.querySelector('.prob-action')?.textContent.trim() || '',
      type: row.querySelector('.prob-type')?.textContent.trim() || '',
      pct: row.querySelector('.prob-pct')?.textContent.trim() || '',
      clipped: r.left < box.left - 1 || r.right > box.right + 1
        || r.top < box.top - 1 || r.bottom > box.bottom + 1,
      // 出了裁切要能直接从日志判断是哪条边、越了多少，不用再猜
      rect: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
      box: { l: Math.round(box.left), r: Math.round(box.right), t: Math.round(box.top), b: Math.round(box.bottom) },
    };
  });
  return {
    mode: counter.dataset.mode,
    hasPoint: Boolean(S.point),
    actor: S.point?.actor || '',
    actorLabel: S.point?.actor ? label(S.point.actor) : '',
    mine: Boolean(S.point?.mine),
    hasCandidates: Boolean(S.point?.candidates?.length),
    predictions: (S.point?.predictions || []).map(a => ({
      label: a.label, type: a.type, probability: a.probability,
    })),
    actions: (S.point?.actions || []).map(a => a.probability),
    rows,
    title: counter.querySelector('.prob-title')?.textContent.trim() || '',
    empty: counter.querySelector('.prob-empty')?.textContent.trim() || '',
    text: counter.textContent,
    buttons: counter.querySelectorAll('button').length,
  };
});

async function checkProbabilityTop3(page, label, expectedMine = true){
  const got = await probabilityScreen(page);
  if (got.mode !== 'prob') problems.push(`${label} 副屏不在概率模式`);
  if (got.buttons) problems.push(`${label} 副屏里出现了 ${got.buttons} 个可点击按钮`);
  const expectedTitle = `${got.actorLabel} · 模型动作选择概率`;
  if (got.title !== expectedTitle) {
    problems.push(`${label} 概率标题不对：${got.title || '(空)'}，应为 ${expectedTitle}`);
  }
  if (got.mine !== expectedMine) problems.push(`${label} 行动者归属标记不对`);
  if (/胜率/.test(got.text)) problems.push(`${label} 把模型动作选择概率写成了胜率`);
  if (!got.hasPoint || !got.predictions.length) problems.push(`${label} 没有拿到 Top-3 概率`);
  if (got.rows.length > 3) problems.push(`${label} 概率行超过 3 条：${got.rows.length}`);
  if (got.rows.length !== got.predictions.length) {
    problems.push(`${label} 概率行数与 predictions 不一致：${got.rows.length}/${got.predictions.length}`);
  }
  for (const [i, row] of got.rows.entries()){
    const want = got.predictions[i];
    if (!want) continue;
    const pct = `${Math.round(want.probability * 100)}%`;
    if (row.label !== want.label || row.type !== want.type || row.pct !== pct) {
      problems.push(`${label} 第 ${i + 1} 行与后端动作不一致：`
        + `${row.label}/${row.type}/${row.pct}，应为 ${want.label}/${want.type}/${pct}`);
    }
    if (row.clipped) {
      problems.push(`${label} 第 ${i + 1} 行被副屏裁切`
        + `（行 l/r/t/b=${row.rect.l}/${row.rect.r}/${row.rect.t}/${row.rect.b}`
        + ` vs 副屏 ${row.box.l}/${row.box.r}/${row.box.t}/${row.box.b}）`);
    }
  }
  for (let i = 1; i < got.predictions.length; i++){
    if (got.predictions[i - 1].probability < got.predictions[i].probability) {
      problems.push(`${label} Top-3 没有按概率降序`);
      break;
    }
  }
  if (!got.actions.length) problems.push(`${label} 没有拿到动作概率`);
  if (!got.actions.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) {
    problems.push(`${label} 存在非法动作概率`);
  }
  const total = got.actions.reduce((sum, p) => sum + p, 0);
  if (Math.abs(total - 1) > 1e-9) problems.push(`${label} 全部合法动作概率合计 ${total}，不是 1`);
  return got;
}

async function checkProbabilityEmpty(page, label, expected){
  const got = await probabilityScreen(page);
  if (got.mode !== 'prob') problems.push(`${label} 副屏不在概率模式`);
  if (got.buttons) problems.push(`${label} 副屏里出现了 ${got.buttons} 个可点击按钮`);
  if (got.rows.length) problems.push(`${label} 不该有概率行，实际有 ${got.rows.length} 条`);
  if (got.empty !== expected) problems.push(`${label} 空态文案不对：${got.empty || '(空)'}，应为 ${expected}`);
  return got;
}

async function goToMyTurn(page, label){
  const turnState = () => page.evaluate(async () => {
    const { S } = await import('/app/state.js');
    return { mine: S.snap.acting === S.snap.me, hasPoint: Boolean(S.point),
             current: S.snap.step, mySteps: S.meta.my_steps };
  });
  const before = await turnState();
  if (before.mine && before.hasPoint) return before;
  const target = [...before.mySteps]
    .sort((a, b) => Math.abs(a - before.current) - Math.abs(b - before.current))[0];
  if (target === undefined || target === before.current) {
    problems.push(`${label} 找不到可切换的我方出牌机会`);
    return before;
  }
  await page.click(target < before.current ? '#dpad-left' : '#dpad-right');
  // 点完 dpad 不能固定等：慢 runner 上 1200ms 可能还没重排完，读到的仍是点击前
  // 的状态，于是误报"没回到我方出牌机会"（CI 实测约 2/3 的运行栽在这一条）。
  // 按本文件其余等待的口径轮询到条件成立，超时才算失败 —— 既不掩盖真回归，
  // 也不会因为机器慢而误报。
  const ok = await waitUntil(page, async () => {
    const s = await turnState();
    return s.mine && s.hasPoint;
  }, 8000);
  const after = await turnState();
  if (!ok || !after.mine || !after.hasPoint) problems.push(`${label} 没回到我方出牌机会`);
  return after;
}

// 保真像素基准（ADR-0004）：同一条归一化坐标，在主页画布与 /glb 原貌页画布上取 5×5 中位色块。
// 机身取景会随布局和相机收敛变化，所以"取景矩形 + 像素"必须在同一次 evaluate 里读完，
// 分两次读会错位。色块靠极值找（金取最黄、靛蓝取最暗），但打分的是 5×5 中位数本身 ——
// 零散的抗锯齿暗点会在中位数里被淘汰，只有真是整块色的位置才留得下。
// 靛蓝描边只有几个像素宽，锚点必须落在足够宽的斜边段上；机身正中的右侧轮廓更细，
// 5×5 里大部分是背景，取不到描边本身。
const FIDELITY_PROBES = [
  { id: '壳-左',   fx: 0.100, fy: 0.72, mode: 'flat' },
  { id: '壳-右',   fx: 0.865, fy: 0.72, mode: 'flat' },
  { id: '饰条-左', fx: 0.020, fy: 0.50, mode: 'gold',   wx: 0.016, wy: 0.04 },
  { id: '饰条-右', fx: 0.980, fy: 0.50, mode: 'gold',   wx: 0.016, wy: 0.04 },
  { id: '靛蓝-左上', fx: 0.021, fy: 0.20, mode: 'indigo', wx: 0.010, wy: 0.014 },
  { id: '靛蓝-右下', fx: 0.979, fy: 0.80, mode: 'indigo', wx: 0.010, wy: 0.014 },
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
  // 主页机身铺满视口渲染，画布比 .stage 大：frame 是 .stage 局部坐标，
  // 取像素前先补上 .stage 左上角到画布左上角的偏移。/glb 页画布就是视口，偏移为 0。
  const stageEl = document.getElementById('stage');
  const cr = c.getBoundingClientRect(), sr = stageEl ? stageEl.getBoundingClientRect() : cr;
  const ox = sr.left - cr.left, oy = sr.top - cr.top;
  if (!frame || !(frame.w > 0)) return { frame: null, out: [] };
  const out = [];
  for (const s of probes) {
    const x0 = ox + frame.x + frame.w * s.fx, y0 = oy + frame.y + frame.h * s.fy;
    const wx = Math.max(0, Math.round(frame.w * (s.wx || 0)));
    const wy = Math.max(0, Math.round(frame.h * (s.wy || 0)));
    let best = null;
    const hits = [];
    for (let j = -wy; j <= wy; j++) for (let i = -wx; i <= wx; i++) {
      const x = Math.round(x0) + i, y = Math.round(y0) + j;
      const pm = patch(x, y), sc = score(pm, s.mode);
      if (sc === null) continue;
      hits.push(pm);
      const d = Math.hypot(i, j);
      if (!best || sc > best.sc || (sc === best.sc && d < best.d)) best = { sc, d, p5: pm };
    }
    // 靛蓝描边只有几个像素宽：取极值会各自锁到两侧的抗锯齿过渡（主页面压着透明底、
    // /glb 压着米色底），两边必然不同。取窗口内全部命中像素的中位色，量的才是描边本身。
    const p5 = s.mode === 'indigo' && hits.length
      ? [0, 1, 2].map(k => median(hits.map(p => p[k])))
      : (best ? best.p5 : null);
    out.push({ id: s.id, p5 });
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
async function waitForFramesToSettle(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  let last = (await frameStats(page)).frameCount;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    const now = (await frameStats(page)).frameCount;
    // 连续两次采样都没有新帧才算稳定，单次空闲可能只是恰好落在两帧之间的停顿。
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 2) return;
  }
  throw new Error('渲染在 60 秒内没有稳定');
}

try {
  if (!(await portIsFree())) throw new Error(`端口 ${PORT} 已被占用，请先停止占用进程`);
  // PYTHONPATH 指到本 checkout 的 src：共享 .venv 的 editable 安装指向主 checkout，
  // 不设的话 `python -m ddz` 会服务别的 checkout 的 web/，脚本与后端就来自两棵树（见 #66）。
  server = spawn('.venv/bin/python', ['-m', 'ddz', 'serve', '--port', String(PORT)],
    { cwd: REPO, env: { ...process.env, PYTHONPATH: path.join(REPO, 'src') },
      stdio: ['ignore', 'pipe', 'pipe'] });
  serverExited = new Promise(resolve => server.once('exit', resolve));
  await waitForHealth();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(90000);
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
  await page.waitForSelector('#strip-sub', { state: 'attached', timeout: 40000 });
  await page.waitForFunction(() => (document.getElementById('strip-sub')?.textContent || '').includes('全局第'), null,
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
  // ADR-0006：真投影软阴影。灯仍是三盏（key 灯兼职投影，castShadow 不改灯自己的贡献），
  // 机身背后一块只吃阴影的接影面；验收要能读到这一层，并且影子真的落到画布上。
  const shadow = shell.shadow || {};
  if (!shadow.mapEnabled) problems.push('主页面没开阴影贴图（ADR-0006 真投影）');
  if (shadow.mapTypeName !== 'VSM') problems.push(`主页面阴影类型不是 VSM：${shadow.mapTypeName}`);
  if (shadow.caster !== 'key') problems.push(`投影灯不是兼职的 key 灯：${shadow.caster}`);
  if (!shadow.backdrop) problems.push('主页面没有接影面');
  if (!(shadow.casters > 0)) problems.push(`机身上没有开投影的 mesh：${shadow.casters}`);
  if (!(shadow.radius > 0) || !(shadow.opacity > 0)) {
    problems.push(`阴影参数不成立：radius=${shadow.radius} opacity=${shadow.opacity}`);
  }
  // 影子是画布上真画出来的：机下条带被压暗，而机身左下的空场不该被涂满（影子偏右下，有方向）。
  const band = await page.evaluate(async () => {
    const c = document.getElementById('scene');
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    const px = new Uint8Array(c.width * c.height * 4);
    ctx.readPixels(0, 0, c.width, c.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    const dpr = c.width / c.clientWidth;
    const alphaAt = (x, y) => {
      const X = Math.round(x * dpr), Y = Math.round(y * dpr);
      if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) return -1;
      return px[((c.height - 1 - Y) * c.width + X) * 4 + 3];
    };
    const r = (await import('/app/machine.js')).machineStatus().tablet;
    // 同保真探针：tablet 是 .stage 局部坐标，画布铺满视口后要补偏移才能取到对像素。
    const sr = document.getElementById('stage').getBoundingClientRect();
    const cr = c.getBoundingClientRect(), ox = sr.left - cr.left, oy = sr.top - cr.top;
    let peak = 0, left = 0, n = 0;
    for (const dy of [6, 12, 20, 30]) for (let i = 0; i <= 12; i++) {
      const x = ox + r.x + r.w * (0.06 + 0.08 * i), y = oy + r.y + r.h + dy;
      peak = Math.max(peak, alphaAt(x, y));
      if (i <= 1) { left += alphaAt(x, y); n++; }
    }
    return { peak, left: n ? left / n : -1, corner: [alphaAt(4, 4), alphaAt(c.clientWidth - 4, 6)] };
  });
  if (!(band.peak >= 60)) problems.push(`机下没有影子：条带 alpha 峰值只有 ${band.peak}`);
  if (!(band.left <= 25)) problems.push(`机身左下的影子铺满了整条（${band.left}），影子没有方向`);
  for (const a of band.corner) if (a !== 0) problems.push(`机身外空场被涂了东西：alpha=${a}`);
  if (!shell.screen || shell.screen.w < 2 || shell.screen.h < 2) problems.push('没有从 GLB 量出真屏矩形');
  if (!shell.screenSize || shell.screenSize.w <= 0 || shell.screenSize.h <= 0) problems.push('真屏包围盒尺寸无效');
  // ADR-0008：座位徽章内嵌进主屏纹理，DOM 只留锚点；否则机身一转圆点就浮到屏外。
  const mainHud = shell.mainHud || {};
  if (!mainHud.ready) problems.push('主屏 HUD 没就绪：座位徽章没画进真屏');
  if (!mainHud.texture || !(mainHud.texture.w > 0) || !(mainHud.texture.h > 0)) {
    problems.push(`主屏 HUD 纹理尺寸无效：${JSON.stringify(mainHud.texture)}`);
  }
  const hudInk = await page.evaluate(async () => (await import('/app/machine.js')).mainHudInk());
  if (!(hudInk > 0)) problems.push(`主屏 HUD 画布是空的（ink=${hudInk}），徽章没画进去`);
  if (!(await page.locator('#screen-hud').evaluate(el => el.classList.contains('is-3d')))) {
    problems.push('#screen-hud 没标成 is-3d：DOM 圆点还压在机身上');
  } else {
    const domOpacity = await page.locator('#board .seat-label').first().evaluate(el => getComputedStyle(el).opacity);
    if (domOpacity !== '0') problems.push(`is-3d 下 DOM 座位圆点没隐身：opacity=${domOpacity}`);
  }
  // 10 颗机身按键 + 副屏右侧那颗实体返回键（切机顶屏模式）= 11 个可量热区
  if (shell.buttons.length !== 11) problems.push(`透明键热区数量不是 11：${shell.buttons.length}`);
  for (const id of ['bar-mode', 'dpad-up', 'dpad-left', 'play-clear', 'dpad-right',
                    'dpad-down', 'new-round', 'play-hint-btn', 'undo', 'play-go', 'play-pass']) {
    if (!shell.buttons.some(b => b.id === id)) problems.push(`模型投影热区缺少 ${id}`);
  }

  const hotspots = await page.locator('#controls .key').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id, w: r.width, h: r.height, disabled: el.disabled,
             clip: getComputedStyle(el).clipPath };
  }));
  if (hotspots.length !== 11) problems.push(`HTML 键热区数量不是 11：${hotspots.length}`);
  for (const h of hotspots){
    if (h.w < 8 || h.h < 8) problems.push(`键热区 ${h.id} 尺寸过小：${h.w}×${h.h}`);
    if (h.clip === 'none' && ['play-hint-btn','undo','play-go','play-pass'].includes(h.id)) {
      problems.push(`菱形键热区 ${h.id} 没有贴合描边`);
    }
  }
  for (const id of ['dpad-up','dpad-left','play-clear','dpad-right','dpad-down','new-round',
                    'play-hint-btn','undo','play-go','play-pass','bar-mode']) {
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
  const deckState = await page.evaluate(() => {
    const p = document.getElementById('panel');
    const cs = getComputedStyle(p);
    return { open: p.classList.contains('is-open'), visibility: cs.visibility,
             opacity: Number(cs.opacity), pointerEvents: cs.pointerEvents };
  });
  if (deckState.open || deckState.visibility === 'visible'
      || deckState.opacity > 0.01 || deckState.pointerEvents !== 'none') {
    problems.push('操作台浮层默认没有收起：应该只留 dock 上的「出牌机会」入口');
  }
  if (await page.locator('#dock .dock-btn').count() !== 5) {
    problems.push('底部工具区应只保留 5 个图标入口');
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
  const stageBox = await stageBoxOf(page);
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

  // 副屏只有两种状态；切换入口只能是机身右侧的实体 BackKey，屏内不能有按钮。
  if ((await page.locator('#counter button').count()) !== 0) problems.push('副屏里出现了模式切换按钮');
  if ((await page.locator('#counter .cc').count()) !== 15) problems.push('记牌副屏不是 15 个点数');
  if ((await page.locator('#counter .cc i s').count()) < 20) problems.push('记牌模式没有画出红点');
  await page.click('#bar-mode');
  await page.waitForTimeout(300);
  if ((await probabilityScreen(page)).mode !== 'prob') problems.push('实体 BackKey 没切到概率模式');
  await checkProbabilityTop3(page, '宽屏我方回合');
  await page.screenshot({ path: '/tmp/ddz-web-prob.png', fullPage: true });
  await page.click('#dpad-down');
  await page.waitForTimeout(200);
  if ((await probabilityScreen(page)).mode !== 'prob') problems.push('按 D-pad ↓ 不该切换副屏模式');
  await page.click('#dpad-up');
  await page.waitForTimeout(200);
  if ((await probabilityScreen(page)).mode !== 'prob') problems.push('按 D-pad ↑ 不该切换副屏模式');
  await page.click('#bar-mode');
  await page.waitForTimeout(250);
  if ((await probabilityScreen(page)).mode !== 'count') problems.push('实体 BackKey 没切回记牌模式');
  if ((await page.locator('#counter .cc i s').count()) < 20) problems.push('记牌模式没有画出红点');

  // 副屏必须**绑在模型上**：机顶条按副屏四角做透视映射，转机身时跟着一起斜，
  // 而不是一块固定矩形（那会在转动时顶出槽位）。
  const counterQuad = () => page.evaluate(() => {
    const el = document.getElementById('counter');
    const cs = getComputedStyle(el);
    const m = new DOMMatrix(cs.transform);
    const W = el.offsetWidth, H = el.offsetHeight;
    const box = el.offsetParent.getBoundingClientRect();
    const at = (x, y) => {
      const p = m.transformPoint(new DOMPoint(x, y));
      return { x: p.x + box.left, y: p.y + box.top };
    };
    return { transform: cs.transform, inline: el.style.transform, W, tl: at(0, 0), tr: at(W, 0), bl: at(0, H), br: at(W, H) };
  });
  // 上面的点击会把鼠标带进舞台，触发悬停视差让机身歪着——先移出去等它回正再取基准。
  await page.mouse.move(stageBox.x - 5, stageBox.y - 5);
  await waitForFramesToSettle(page);
  const restQuad = await counterQuad();
  // 内联 style 才是 board.js 实际写入的值：计算样式在透视分量极小时会被序列化成 matrix()，不可靠。
  if (!/^matrix3d\(/.test(restQuad.inline)) {
    problems.push(`机顶条没走四边形映射（回落到固定矩形）：${restQuad.inline}`);
  }
  const bodyPoint = await page.evaluate(async () => {
    const r = document.getElementById('stage').getBoundingClientRect();
    const scr = document.getElementById('screen-hud').getBoundingClientRect();
    const m = await import('/app/machine.js');
    for (let fy = 0.06; fy <= 0.92; fy += 0.04) {
      for (let fx = 0.06; fx <= 0.94; fx += 0.04) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x > scr.left && x < scr.right && y > scr.top && y < scr.bottom) continue;
        if (m.isOnBody(x, y)) return { x, y };
      }
    }
    return null;
  });
  if (!finitePoint(bodyPoint)) {
    problems.push('机身上找不到可拖的点，没法验证副屏跟随');
  } else {
    await page.mouse.move(bodyPoint.x, bodyPoint.y);
    await page.mouse.down();
    await page.mouse.move(bodyPoint.x + 160, bodyPoint.y, { steps: 8 });
    await page.waitForTimeout(80);
    const turned = await counterQuad();
    await page.mouse.up();
    // 松手后旋转/视差弹簧约 900ms 才收敛，先等它停稳再采样，否则会读到回弹中途的角度。
    await page.waitForTimeout(1200);
    const tilt = Math.abs(turned.tr.y - turned.tl.y);
    if (tilt < 1) problems.push(`转机身后机顶条没跟着斜：顶边高差 ${tilt.toFixed(2)}px`);
    if (turned.W >= restQuad.W) {
      problems.push(`转机身后机顶条没有随副屏收窄：${restQuad.W.toFixed(1)} → ${turned.W.toFixed(1)}px`);
    }
    // 先移出舞台，避免悬停视差让机身停在与初始不同的角度。
    await page.mouse.move(stageBox.x - 5, stageBox.y - 5);
    await waitForFramesToSettle(page);
    const backQuad = await counterQuad();
    if (Math.abs(backQuad.tl.y - restQuad.tl.y) > 1.5) {
      problems.push(`松手机顶条没回弹归位：${restQuad.tl.y.toFixed(1)} → ${backQuad.tl.y.toFixed(1)}px`);
    }
  }

  // 数据面板：默认不占页面，点"数据面板"才盖在屏幕上
  if (await page.locator('#crt').evaluate(el => el.classList.contains('is-open'))) {
    problems.push('数据面板默认就打开着（应该是点开才盖上来）');
  }
  await page.click('#dock-data');
  await page.waitForTimeout(400);
  if (!(await page.locator('#crt').evaluate(el => el.classList.contains('is-open')))) {
    problems.push('数据面板点不开');
  }
  if (!(await page.locator('#crt').isVisible())) problems.push('数据面板打开后不可见');
  if ((await page.locator('#calib tr').count()) < 2) problems.push('校准表是空的');
  if ((await page.locator('#plist li[data-card]').count()) < 1) problems.push('逐张概率列表是空的');
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

  // 操作台默认收起，先展开才能操作内部控件
  await openDeck(page);
  await checkPanelLayout(page, '宽屏');
    // 交互 1：在屏幕里点自己的牌 → 选中；再点同一张 → 取消；清空
  // 选中的是「具体哪一张」（按下标记身份），所以点同一张两次能反转，
  // 同点数的第二、三张也各自独立。
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

  // 滑动选牌：进入一张牌的区域就反转它。滑过去再滑回来必须回到原状态，
  // 而且同点数的第 2/3 张也要能各自反转（历史上会残留一张取消不掉）。
  {
    if (await page.locator('#play-clear').isEnabled()) { await page.click('#play-clear'); await page.waitForTimeout(120); }
    const seq = await page.evaluate(async () => {
      const c = await import('/app/console.js');
      const { S, SEL } = await import('/app/state.js');
      const hand = S.snap.my_hand;
      let g = -1;
      for (let i = 0; i + 2 < hand.length; i++)
        if (hand[i] === hand[i + 1] && hand[i + 1] === hand[i + 2]) { g = i; break; }
      const got = [];
      for (const k of [g, g + 1, g + 2, g, g + 1, g + 2]) { c.toggleCard(k); got.push(SEL.play.length); }
      return { g, rank: hand[g], got, leftover: SEL.play.length };
    });
    if (seq.g < 0) problems.push('手牌里没有同点数三张，滑动选牌的身份用例没法跑');
    else if (seq.got.join(',') !== '1,2,3,2,1,0' || seq.leftover !== 0) {
      problems.push(`同点数三张没能各自反转：${seq.rank}×3 → ${seq.got.join('→')}（末态 ${seq.leftover}）`);
    }
    if (seq.g >= 0) {
      const chipN = () => page.locator('#play-chips i.c').count();
      const n0 = await chipN();
      const slideAcross = async () => {
        const box = await stageBoxOf(page);
        const p0 = await handPointOf(page, seq.g);
        await page.mouse.move(box.x + p0.x, box.y + p0.y);
        await page.waitForTimeout(600);
        await page.mouse.down();
        const p1 = await handPointOf(page, seq.g + 1);
        await page.mouse.move(box.x + p1.x, box.y + p1.y, { steps: 8 });
        const p2 = await handPointOf(page, seq.g + 2);
        await page.mouse.move(box.x + p2.x, box.y + p2.y, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(150);
      };
      await slideAcross();
      const n1 = await chipN();
      await slideAcross();
      const n2 = await chipN();
      if (n1 - n0 < 2) problems.push(`鼠标滑过 3 张牌只反转了 ${n1 - n0} 张（每滑到一张就该反转一张）`);
      if (n2 !== n0) problems.push(`鼠标沿同一路径滑两次没有回到起点：${n0} → ${n1} → ${n2}`);
      if (n2 !== 0) { await page.click('#play-clear'); await page.waitForTimeout(120); }
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
  // 演示局开屏就落在「该我出牌、真有得选」的最新一手了 —— 先退回上一手，制造出历史局面再验回放
  if (!(await page.locator('#step-prev').isDisabled())) {
    await page.click('#step-prev'); await page.waitForTimeout(900);
  }
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

  // 交互 2b：终局 —— 演示局开屏只接到「该我出牌」的那一手（整局随后端下发，
  // 前端只切到接手的起点）。要看终局，用「打开记录」把整局载进来，再跳到最后。
  const fullDemo = await (await fetch(`${BASE}/api/demo`)).json();
  await page.setInputFiles('#dock-file', {
    name: 'demo-full.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(fullDemo.record)),
  });
  if (!(await waitText(page, '#strip-sub', '/66 手'))) {
    problems.push('「打开记录」没把整局载进来（演示局只接到该我出牌的一手）');
  }
  await page.click('#play-latest');
  if (!(await waitText(page, '#play-who', '牌局已结束'))) {
    problems.push('终局时操作台没报「牌局已结束」');
  }
  if (!(await page.locator('#play-go').isDisabled())
      || !(await page.locator('#play-pass').isDisabled())) {
    problems.push('终局时「出牌 / 不要」还能点');
  }
  if (await page.locator('#opp-cell').isVisible()) problems.push('终局时还留着录对手牌的入口');
  if (!(await text(page, '#banner')).includes('牌局已结束')) problems.push('终局横幅没说明牌局已结束');
  await page.click('#bar-mode');
  await page.waitForTimeout(250);
  await checkProbabilityEmpty(page, '宽屏终局', '本局已结束');
  await page.click('#bar-mode');
  await page.waitForTimeout(250);

  // 交互 3：左握把那个方键开新一轮 → 屏幕里录入 → 开局（我方当地主，第一手由我领出）
  await page.click('#new-round');
  await page.waitForTimeout(300);
  if (!(await page.locator('#newgame').isVisible())) problems.push('开新一轮的浮层没打开');
  // 身份只有「地主 / 农民」；是农民时再指定地主在我上家还是下家
  const pickSeat = async (role, pos) => {
    await page.click(`#new-role button[data-role="${role}"]`);
    if (pos) await page.click(`#new-pos button[data-pos="${pos}"]`);
  };
  for (const [role, pos, size] of [['landlord', null, 20],
                                   ['peasant', 'landlord_down', 17],
                                   ['peasant', 'landlord_up', 17]]) {
    await pickSeat(role, pos);
    if (!(await text(page, '#new-count')).includes(`0/${size}`)) {
      problems.push(`${pos || role} 的手牌进度没有使用服务端张数 ${size}`);
    }
  }
  await pickSeat('landlord', null);
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
  if (!(await waitBanner(page, '已开局'))) problems.push('开新局没有反馈');
  if (!(await text(page, '#board')).includes('该你出')) problems.push('开新局后第一手不是我方');

  // 20 张满手牌也必须每一张都能从屏里点中；扇面外缘不能跑出可拾取区域。
  const fullHand = await page.evaluate(async () => {
    const m = await import('/app/machine.js');
    const { S } = await import('/app/state.js');
    const hits = m.handPoints().map(p => ({ i: p.i, pick: m.pickCardAt(p.x, p.y) }));
    return { n: S.snap.my_hand.length, pts: hits.length,
             miss: hits.filter(p => p.i !== p.pick) };
  });
  if (fullHand.n !== 20 || fullHand.pts !== fullHand.n || fullHand.miss.length) {
    problems.push(`20 张满手牌拾取错位：${fullHand.pts}/${fullHand.n} 个点，`
      + `错 ${fullHand.miss.length} 张 ${JSON.stringify(fullHand.miss)}`);
  }

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
      // 拒绝是异步回来的；固定 900ms 在慢机器上会漏掉那条控制台消息
      await waitUntil(page, async () =>
        (await page.locator('#banner').getAttribute('data-kind')) === 'error', 8000);
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
  // 顺带验 #48：点的若是同点数的**非首张**，出牌区必须显示被点那张的花色，
  // 而不是"按下标/排序猜"的首张（只有点非首张，两种结果才不同，才验得出接线）。
  const n4 = (await handPts(page)).length;
  const faceCheck = await page.evaluate(async () => {
    const { S } = await import('/app/state.js');
    const vc = await import('/app/virtual-cards.js');
    const hand = S.snap.my_hand;
    const played = (S.snap.played || {})[S.snap.me] || [];
    const cards = vc.handCards(S.record.record_id, hand, vc.rankCounts(played));
    const seen = {};
    let k = -1;
    for (let i = 0; i < hand.length; i++){
      const j = seen[hand[i]] || 0; seen[hand[i]] = j + 1;
      if (j > 0 && hand[i] !== 'B' && hand[i] !== 'R'){ k = i; break; }
    }
    let other = -1;
    for (let i = 0; i < hand.length; i++) if (hand[i] !== hand[k]){ other = i; break; }
    return {
      k, other,
      rank: k >= 0 ? hand[k] : null,
      otherRank: other >= 0 ? hand[other] : null,
      suit: k >= 0 ? cards[k].suit : null,
    };
  });
  await clickCard(page, faceCheck.k >= 0 ? faceCheck.k : Math.round((n4 - 1) * 0.5));
  await page.waitForTimeout(220);
  if (!(await page.locator('#play-chips i.c').count())) problems.push('轮到我方时，屏幕里点牌没选上');

  // #48 回归（评审反例）：再加选一张别的点数，删掉它的牌片后，先点的那张同点数牌
  // 身份不能丢 —— 旧实现用 adoptPlay() 按下标重排，会把身份挪回同点数的第一张。
  if (faceCheck.k >= 0 && faceCheck.other >= 0) {
    await clickCard(page, faceCheck.other);
    await page.waitForTimeout(220);
    const both = await page.locator('#play-chips i.c').count();
    if (both !== 2) problems.push(`#48 删牌片回归：想选两张不同点数的牌，实际选上 ${both} 张`);
    else {
      const drop = await page.evaluate(async rank => {
        const { SEL } = await import('/app/state.js');
        const { RANKS } = await import('/app/labels.js');
        return SEL.play.slice().sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b)).indexOf(rank);
      }, faceCheck.otherRank);
      if (drop < 0) problems.push('#48 删牌片回归：找不到另一张点数的牌片');
      else {
        await page.click(`#play-chips [data-drop="${drop}"]`);
        await page.waitForTimeout(220);
        const left = await page.locator('#play-chips i.c').count();
        if (left !== 1) problems.push(`#48 删牌片回归：删掉另一张后应剩 1 张，实际 ${left} 张`);
      }
    }
  }
  // 回归步骤若没把选择收敛到一张，先清空再只点最初那张，保证主断言能独立跑。
  if ((await page.locator('#play-chips i.c').count()) !== 1) {
    await page.click('#play-clear');
    await page.waitForTimeout(150);
    await clickCard(page, faceCheck.k >= 0 ? faceCheck.k : Math.round((n4 - 1) * 0.5));
    await page.waitForTimeout(220);
  }
  await page.click('#play-go');
  if (!(await waitBanner(page, '已录'))) problems.push('录我方的牌没有反馈');
  if (faceCheck.k >= 0) {
    const got = await page.evaluate(async rank => {
      const { S } = await import('/app/state.js');
      const vc = await import('/app/virtual-cards.js');
      const played = (S.snap.played || {})[S.snap.me] || [];
      const trick = S.snap.last_move || [];
      const mine = vc.isMyTrick(played, trick);
      const suits = vc.trickCards(S.record.record_id, trick, vc.rankCounts(played), mine)
                      .filter(c => c.rank === rank).map(c => c.suit);
      return { mine, suits };
    }, faceCheck.rank);
    if (!got.mine) problems.push('刚打完一手，出牌区却不认这是我的牌');
    if (!got.suits.includes(faceCheck.suit)) {
      problems.push(`#48 出牌区花色没跟着被点的那张走：${faceCheck.rank} 点的是 ${faceCheck.suit}，`
        + `出牌区给了 ${JSON.stringify(got.suits)}`);
    }
  }

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
    // 轮到对手：概率副屏显示对手 Top-3，但对手动作不能进入我方可录候选。
    await page.click('#bar-mode');
    await page.waitForTimeout(250);
    await checkProbabilityTop3(page, '宽屏对手回合', false);
    const opponentDeck = await page.evaluate(async () => {
      const { S } = await import('/app/state.js');
      return {
        hasCandidates: Boolean(S.point?.candidates?.length),
        picksHidden: document.getElementById('play-picks').hidden,
        hintDisabled: document.getElementById('play-hint-btn').disabled,
      };
    });
    if (opponentDeck.hasCandidates || !opponentDeck.picksHidden || !opponentDeck.hintDisabled) {
      problems.push('对手动作被错误地放进了我方可录候选');
    }
    await page.click('#bar-mode');
    await page.waitForTimeout(250);
    // 这一手按"不要"记下去（对手的牌是背面，实际牌型由服务端裁定）
    await page.click('#play-pass');
    if (!(await waitBanner(page, '已录'))) problems.push('录对手不要没有反馈');
  }

  await page.screenshot({ path: '/tmp/ddz-web-2.png', fullPage: true });

  // 交互 7：撤销
  await page.click('#undo');
  if (!(await waitBanner(page, '已撤销'))) problems.push('撤销没有反馈');

  // 窄屏：不出横向滚动条，保留 3D 正视，数据面板在机下且不遮屏
  await page.setViewportSize({ width: 420, height: 1200 });
  // 切窄后版式要重排（面板入机下布局、机身重新量尺）；固定等待在慢机器上会量到重排中途那一帧。
  // 轮到"不再横向溢出"为止，只有一直溢出才算失败。
  await waitUntil(page, async () =>
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 2, 8000);
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    panel: document.getElementById('crt').getBoundingClientRect().toJSON(),
    screen: document.getElementById('screen-hud').getBoundingClientRect().toJSON(),
    panelOpen: document.getElementById('board').classList.contains('panel-open'),
    status: document.getElementById('board').classList.contains('is-stacked'),
  }));
  if (narrow.overflow > 2) {
    // 上一版按 innerWidth 找越界元素，CI 上给出了空列表 —— innerWidth 含滚动条宽度，
    // 而元素是撑在 clientWidth 的内容盒里。改成按 clientWidth 找，并报出滚动条宽度，
    // 一眼就能区分"经典滚动条吃宽"和"真·100vw 撑破"。
    const diag = await page.evaluate(() => {
      const de = document.documentElement;
      const cw = de.clientWidth;
      const off = [...document.querySelectorAll('*')]
        .map(e => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.right > cw + 2 || r.width > cw + 2)
        .sort((a, b) => b.r.right - a.r.right)
        .slice(0, 8)
        .map(({ e, r }) => `${e.tagName}#${e.id}.${(e.className||'').toString().slice(0,26)}`
          + ` r=${Math.round(r.right)} w=${Math.round(r.width)}`
          + ` w:${getComputedStyle(e).width} min:${getComputedStyle(e).minWidth}`);
      return {
        inner: window.innerWidth, client: cw, scroll: de.scrollWidth,
        body: document.body.scrollWidth, scrollbar: window.innerWidth - cw, off,
      };
    });
    problems.push(`窄屏出现横向溢出 ${narrow.overflow}px`
      + `［inner=${diag.inner} client=${diag.client} scroll=${diag.scroll}`
      + ` body=${diag.body} 滚动条=${diag.scrollbar}］`
      + ` :: ${diag.off.join(' | ') || '(没有元素超过 clientWidth)'}`);
  }
  if (!narrow.panelOpen || !narrow.status) problems.push('窄屏数据面板没有进入机下布局');
  if (rectOverlap(narrow.panel, narrow.screen)) problems.push('窄屏数据面板盖住了真屏');
  if (narrow.panel.top < narrow.screen.bottom) problems.push('窄屏数据面板不在机身下方');
  const touchTargets = await page.locator('#touchbar button').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, visible: getComputedStyle(el).display !== 'none' };
  }));
  if (touchTargets.length !== 8) problems.push(`窄屏操作条按钮数量不是 8：${touchTargets.length}`);
  for (const [i, t] of touchTargets.entries()) {
    if (!t.visible || t.w < 44 || t.h < 44) {
      problems.push(`窄屏操作条第 ${i + 1} 个目标不足 44px：${t.w}×${t.h}`);
    }
  }
  // #25 窄屏机身/机顶屏/操作台的版式硬约束：机身留主角位，记牌字能读，
  // 托盘各层不互相压住，触控条不把页面撑宽。
  const narrowLayout = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const stage = r('stage');
    const deck = r('deckbar'), touch = r('touchbar');
    const counterEl = document.getElementById('counter'), counter = counterEl.getBoundingClientRect();
    const cell = document.querySelector('#counter .cc');
    const handline = document.getElementById('handline');
    const handstrip = document.getElementById('handstrip');
    const stripChip = handstrip && handstrip.querySelector('i[data-hand]');
    const counterButtons = counterEl.querySelectorAll('button').length;
    const rowTops = {};
    document.querySelectorAll('#counter .cc').forEach(el => {
      const y = el.offsetTop;
      rowTops[y] = (rowTops[y] || 0) + 1;
    });
    return {
      stageH: stage.height,
      deckTop: deck.top, deckBottom: deck.bottom,
      touchTop: touch.top, touchBottom: touch.bottom,
      counterFs: parseFloat(getComputedStyle(counterEl).fontSize),
      counterCellW: cell ? cell.offsetWidth : 0,
      counterRows: Object.values(rowTops),
      handlineHidden: !handline || getComputedStyle(handline).display === 'none',
      stripShown: !!handstrip && getComputedStyle(handstrip).display !== 'none',
      stripFs: stripChip ? parseFloat(getComputedStyle(stripChip).fontSize) : 0,
      counterButtons,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
      innerW: innerWidth,
      clientW: document.documentElement.clientWidth,
      scrollbarW: innerWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - innerWidth,
    };
  });
  if (!narrowLayout.handlineHidden) problems.push('420px 浮层里仍显示平面手牌副本，和机身下方的常驻条重复');
  // 3D 那张牌在 420px 只有约 6px 的点数：这一档只能靠机身下方的常驻条逐张读。
  if (!narrowLayout.stripShown) problems.push('420px 没有常驻的平面手牌条，点数读不出来');
  if (narrowLayout.stripFs < 12) problems.push(`420px 常驻手牌条字号过小：${narrowLayout.stripFs}px`);
  // 窄屏手牌条点一下 = 点屏幕上那张牌：420px 下这是唯一读得出点数的选择入口
  if (narrowLayout.stripShown) {
    if (await page.locator('#play-clear').isEnabled()) {
      await page.click('#play-clear'); await page.waitForTimeout(150);
    }
    const before = await page.locator('#play-chips i.c').count();
    await page.locator('#handstrip i[data-hand]').first().click();
    await page.waitForTimeout(180);
    const after = await page.locator('#play-chips i.c').count();
    if (after !== before + 1) problems.push(`420px 点常驻手牌条没有选中：${before} → ${after}`);
    else if ((await page.locator('#handstrip i.is-picked').count()) !== after) {
      problems.push('420px 常驻手牌条没有把选中的那张标出来');
    }
    await page.locator('#handstrip i[data-hand]').first().click();
    await page.waitForTimeout(180);
    if ((await page.locator('#play-chips i.c').count()) !== before) {
      problems.push('420px 再点一次没有取消选中');
    }
  }
  if (narrowLayout.counterButtons) problems.push('420px 副屏里仍显示模式切换按钮');
  if (narrowLayout.counterFs < 10) problems.push(`420px 机顶记牌字号过小：${narrowLayout.counterFs}px`);
  if (narrowLayout.counterCellW < 20) problems.push(`420px 机顶记牌格宽过窄：${narrowLayout.counterCellW.toFixed(1)}px`);
  if (JSON.stringify(narrowLayout.counterRows) !== JSON.stringify([8, 7])) {
    problems.push(`420px 机顶记牌不是 8+7 两行：${narrowLayout.counterRows.join('+')}`);
  }
  if (narrowLayout.deckBottom > narrowLayout.touchTop + 1) {
    problems.push(`窄屏操作台与触控条相撞：${narrowLayout.deckBottom.toFixed(1)} > ${narrowLayout.touchTop.toFixed(1)}`);
  }
  await checkPanelLayout(page, '窄屏');
  if (narrowLayout.docOverflow > 2 || narrowLayout.bodyOverflow > 2) {
    problems.push(`420px 页面级横向溢出：html ${narrowLayout.docOverflow}px / body ${narrowLayout.bodyOverflow}px`
      + `［inner=${narrowLayout.innerW} client=${narrowLayout.clientW} 滚动条=${narrowLayout.scrollbarW}］`);
  }
  await goToMyTurn(page, '窄屏我方回合');
  await page.click('#bar-mode');
  await page.waitForTimeout(300);
  await checkProbabilityTop3(page, '窄屏我方回合');
  await page.click('#bar-mode');
  await page.waitForTimeout(250);

  // 新开一页复核 17 张这个真实高频状态；主流程此时已经改过手牌，不能拿它冒充 17 张。
  const fresh420 = await browser.newPage({ viewport: { width: 420, height: 1200 } });
  fresh420.setDefaultTimeout(90000);
  watchPage(fresh420, '420 复核');
  await fresh420.goto(`${BASE}/`);
  await fresh420.waitForSelector('#strip-sub', { state: 'attached', timeout: 40000 });
  await fresh420.waitForFunction(() => (document.getElementById('strip-sub')?.textContent || '').includes('全局第'), null,
    { timeout: 40000 });
  await waitForMachineState(fresh420, s => s.status === 'ready' && s.ready);
  await fresh420.waitForTimeout(1200);
  const freshHand = await fresh420.evaluate(async () => {
    const m = await import('/app/machine.js');
    const { S } = await import('/app/state.js');
    const pts = m.handPoints();
    // 手牌向右叠压（右压左）：靠左那张的**中心**可能被右邻盖住 —— 那不是 bug，
    // 用户看到的就是盖在上面那张，点下去也该选它。所以每张牌只要在它露出来的那一段
    // 点得中即可：中心点叠加左侧若干偏移，任一命中就算过（#60：仅最左一张会踩到这条）。
    const OFFS = [0, -4, -8, -12, 4, 8];
    const hits = pts.map(p => {
      const hit = OFFS.map(dx => m.pickCardAt(p.x + dx, p.y)).find(v => v === p.i);
      return { i: p.i, pick: hit === undefined ? m.pickCardAt(p.x, p.y) : hit, x: p.x, y: p.y };
    });
    const miss = hits.filter(p => p.i !== p.pick);
    const byIndex = new Map(pts.map(p => [p.i, p]));
    const missDetail = miss.map(h => {
      const target = byIndex.get(h.pick);
      const d = target ? Math.hypot(target.x - h.x, target.y - h.y) : NaN;
      const card = S.snap.my_hand[h.i];
      return `牌#${h.i}(${card || '?'}) 落点 ${Math.round(h.x)},${Math.round(h.y)}`
        + ` → 拾到 #${h.pick}，两心距 ${Number.isFinite(d) ? d.toFixed(1) : '?'}px`;
    });
    return { n: S.snap.my_hand.length, rows: m.machineStatus().handRows,
             pts: hits.length, miss, missDetail };
  });
  if (freshHand.n !== 17) problems.push(`420px 复核样本不是 17 张：${freshHand.n}`);
  if (freshHand.rows.length !== 1 || freshHand.rows[0]?.count !== freshHand.n) {
    problems.push(`420px 17 张手牌不是单行：${freshHand.rows.map(r => r.count).join('+')}`);
  }
  if (freshHand.pts !== freshHand.n || freshHand.miss.length) {
    // 只报"错 N 张"在 CI 上没法定位：到底是哪张牌的落点被邻牌盖住了、差多少。
    // 报出每张错牌自己的投影点、实际拾取到谁，以及它到邻牌中心的距离。
    problems.push(`420px 手牌拾取错位：${freshHand.pts}/${freshHand.n} 个点，`
      + `错 ${freshHand.miss.length} 张 :: ${(freshHand.missDetail || []).join(' | ')}`);
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
  const nsNav = await page.evaluate(async () => {
    const { S } = await import('/app/state.js');
    return { other: S.meta.my_steps.some(st => st !== S.snap.step) };
  });
  if (!nsNav.other) {
    // 只有当前这一手时，两个方向都不可点是正确状态
    if (!(ns0.nextOff && ns0.prevOff)) problems.push('窄屏只有一个出牌机会，回放按钮却仍可点');
  } else if (ns0.nextOff && ns0.prevOff) {
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

  // 加载层：常规态只有动画（说明由设计说），模块没起来才给文字与重试
  {
    const boot = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    watchPage(boot, '加载层');
    // 加载层常规态只活很短一瞬（最短停留 900ms + 退场，见 ADR-0011）。用"此刻还在不在"
    // 量宽度，会偶发量到退场中/已撤的 0（#60）。改成从进页起就记录：只要折叠立方体在
    // 常规态里画出来过（宽 ≥ 40 且未进入退场），就把那一帧的数值存下来。
    await boot.addInitScript(() => {
      window.__bootQuiet = null;
      const tick = () => {
        if (!window.__bootQuiet){
          const bootEl = document.getElementById('boot');
          const fold = bootEl && bootEl.querySelector('.boot-fold');
          if (bootEl && fold && document.body.classList.contains('is-booting')
              && !bootEl.classList.contains('is-exiting')
              && fold.getBoundingClientRect().width >= 40){
            const t = document.getElementById('boot-text');
            const r = t.getBoundingClientRect();
            window.__bootQuiet = {
              textW: Math.round(r.width), textH: Math.round(r.height),
              clip: getComputedStyle(t).clipPath, copy: t.textContent.trim(),
              aria: bootEl.getAttribute('aria-live'),
              foldW: Math.round(fold.getBoundingClientRect().width),
            };
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // 拖住模块入口：常规态多停一会儿，好让记录器一定采到一帧。
    await boot.route('**/app/main.js', async route => {
      await new Promise(r => setTimeout(r, 3000));
      await route.continue();
    });
    await boot.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await boot.waitForFunction(() => window.__bootQuiet, null, { timeout: 15000 });
    const quiet = await boot.evaluate(() => window.__bootQuiet);
    if (quiet.textW > 4 || quiet.textH > 4) problems.push(`加载层常规态还显示着文字（${quiet.textW}×${quiet.textH}）`);
    if (quiet.clip !== 'inset(50%)') problems.push(`加载层文字没沉到 sr-only（clip=${quiet.clip}）`);
    if (!quiet.copy) problems.push('加载层没有留给读屏的文案');
    if (quiet.aria !== 'polite') problems.push('加载层没挂 aria-live');
    if (quiet.foldW < 40) problems.push(`加载层没画出折叠立方体（宽 ${quiet.foldW}）`);
    await boot.close();
  }

  // 加载层兜底：模块挂了要把文字与重试入口放出来
  {
    const dead = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    watchPage(dead, '加载层兜底', msg => /net::ERR_FAILED|Failed to load resource/i.test(msg));
    await dead.route('**/app/main.js', route => route.abort());
    await dead.goto(`${BASE}/`);
    const shown = await waitUntil(dead, async () =>
      ((await dead.locator('#boot-text').boundingBox())?.width ?? 0) > 20);
    if (!shown) problems.push('模块挂了以后加载层没把报错文字放出来');
    if (await dead.locator('#boot-reload').isHidden()) problems.push('模块挂了以后没有「重新加载」入口');
    await dead.close();
  }

  // 加载层交接（ADR-0011）：最短停留兜住"闪屏"，收尾动画播完才摘幕布
  {
    const short = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    watchPage(short, '加载层最短停留', msg => /net::ERR_FAILED|Failed to load resource/i.test(msg));
    // 掐掉模块入口：不会有人替它提前放行，于是能干净地量"首帧就喊交接"这一情况
    await short.route('**/app/main.js', route => route.abort());
    await short.goto(`${BASE}/`, { waitUntil: 'commit' });
    await short.waitForSelector('#boot .sk-fold');
    await short.evaluate(() => window.__bootHandoff());
    await waitUntil(short, async () => await short.evaluate(() => !!window.__bootAt.done), 8000);
    const at = await short.evaluate(() => ({ ...window.__bootAt }));
    const dwell = at.done - at.shown, exit = at.done - at.exitStart;
    if (dwell < 840) problems.push(`加载层最短停留没兜住：只停 ${Math.round(dwell)}ms（应 ≥900ms）`);
    if (exit < 180 || exit > 600) problems.push(`收尾动画没播完就被摘掉：${Math.round(exit)}ms（应 ≈260ms）`);
    await short.close();
  }

  // 机身的入场必须等在幕布收完之后（ADR-0011）
  {
    const seq = await browser.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
    watchPage(seq, '加载层交接');
    await seq.goto(`${BASE}/`);
    const done = await waitUntil(seq, async () => await seq.evaluate(() => !!window.__bootAt?.done), 40000);
    if (!done) {
      problems.push('加载层没走完交接（__bootAt.done 没落）');
    } else {
      const at = await seq.evaluate(() => ({ ...window.__bootAt }));
      const st = await machineStatus(seq);
      if (st.entranceStartedAt == null) problems.push('机身入场没有播（entranceStartedAt 为空）');
      else if (st.entranceStartedAt < at.done - 40) {
        problems.push(`机身在幕布收完之前就入场了：入场 ${Math.round(st.entranceStartedAt)}ms vs 幕布 ${Math.round(at.done)}ms`);
      }
      if (await seq.locator('#boot').isVisible()) problems.push('幕布该摘了却还看得见');
    }
    await seq.close();
  }

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
    await failed.click('#dock-data');
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
    await noGl.click('#dock-data');
    await noGl.waitForTimeout(250);
    if (!(await noGl.locator('#crt').isVisible())) problems.push('无 WebGL 后数据面板不可读');
    await noGl.close();
  }

  await browser.close();
} catch (err) {
  // 出错也要能定位：只报 message 时，"mouse.move: Invalid parameters"（NaN 坐标）
  // 这类问题完全看不出是哪一次调用 —— #60 排查时就卡在这里。
  const where = String(err.stack || '').split('\n').slice(0, 3).join(' ⏎ ');
  problems.push(`验证本身出错：${err.message}${where ? ' @ ' + where : ''}`);
} finally {
  await stopServer();
}

console.log(problems.length
  ? '发现问题:\n- ' + problems.join('\n- ')
  : '✔ 无 pageerror / console error；根路径 GLB 机身 + 模型按键透明热区 + 屏内点牌选牌 + 记牌/概率 + 机侧/机下数据面板 + 窄屏操作条 + 错误态 + 机身原貌保真色块 + 按需渲染 均正常');
process.exit(problems.length ? 1 : 0);
