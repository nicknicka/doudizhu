// 页面背景：方波田 —— 纯 Canvas2D，铺满整个视口。
// 两级**方波**（阶跃，不是正弦）沿 24° 叠加：同一相位上整条方块一起跳变，
// 所以看得到一条条斜向"田垄"在慢慢走。参数与配色出自 .oil-ui/pixel-wave-bg 设计稿。
// 不碰 WebGL 上下文（那是 three.js 的），只做背景层；光池/浮尘仍在 template.html 里。

const INK = '#141310', ACCENT = '#e0442a';
const RAD = 24 * Math.PI / 180, CX = Math.cos(RAD), CY = Math.sin(RAD);
const T1 = 7200, T2 = 11000;                 // 两级波的周期（ms）
const D1 = 0.46, D2 = 0.54;                  // 占空比：高电平占一个周期的比例
const COLS = 104;                            // 视口宽切多少格；格子随屏自适应
const A_LO = 0.025, A_HI = 0.085;            // 中档强度
const SIDE_LO = 0.45;                        // 方块最小边比例：对齐设计稿「推荐档」sizeLo .45
const STEP = (A_HI - A_LO) / 4;              // 透明度量化成 4 级台阶
const ACC = 0.02, PEAK = 0.80;               // 只有波峰中央极少几颗走强调色
const FPS = 30;                              // 波很慢，30fps 够用，别占满主线程

// 方波：相位落在占空比内为 +1，否则 -1
const square = (phase, duty) => (phase - Math.floor(phase)) < duty ? 1 : -1;

export function initDeskPixels(canvas){
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let w = 1, h = 1, dpr = 1, cols = 0, rows = 0, pitch = 12, size = 5, l1 = 260, l2 = 420;
  let acc = [], raf = 0, disposed = false;

  function build(){
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    // 格子按视口宽度定尺寸：宽屏不掉成一片沙，窄屏也不会糊成一团
    pitch = Math.max(9, Math.min(20, Math.round(w / COLS)));
    size = Math.max(3, Math.round(pitch * 0.42));
    l1 = Math.max(180, Math.min(420, w * 0.22));   // 一级波长跟着视口走
    l2 = l1 * 1.62;
    cols = Math.ceil(w / pitch); rows = Math.ceil(h / pitch);
    acc = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) acc.push(Math.random() < ACC);
  }

  function draw(t){
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx0 = w * 0.5, band = w * 0.20;     // 强调色只落在中央 40% 宽
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++){
      const x = i * pitch + size / 2, y = j * pitch + size / 2;
      const u = x * CX + y * CY;              // 沿 24° 方向的投影
      const s1 = square(u / l1 - t / T1, D1);
      const s2 = square(u / l2 - t / T2 + 0.31, D2);
      const v = 0.5 + 0.25 * s1 + 0.25 * s2;  // 0 / .25 / .5 / .75 / 1
      const side = size * (SIDE_LO + (1 - SIDE_LO) * v);
      let a = A_LO + (A_HI - A_LO) * v;
      a = Math.round(a / STEP) * STEP;
      ctx.globalAlpha = a;
      ctx.fillStyle = (v > PEAK && Math.abs(x - cx0) < band && acc[j * cols + i]) ? ACCENT : INK;
      ctx.fillRect(x - side / 2, y - side / 2, side, side);
    }
    ctx.globalAlpha = 1;
  }

  build();
  const ro = new ResizeObserver(() => { build(); if (reduceMotion()) draw(0); });
  ro.observe(canvas);

  // 关掉动画时只留一张静帧，别再刷帧
  if (reduceMotion()){ draw(0); return () => ro.disconnect(); }

  const t0 = performance.now();
  let last = -1e9;
  const frame = now => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS - 1) return;
    last = now;
    draw(now - t0);
  };
  raf = requestAnimationFrame(frame);

  return () => { disposed = true; cancelAnimationFrame(raf); ro.disconnect(); };
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
