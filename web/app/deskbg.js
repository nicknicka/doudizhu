// 桌面像素方块田：方向 B「慢波方块田 · 中档」，纯 Canvas2D。
// 不碰 WebGL 上下文（那是 three.js 的），只做背景层；光池/浮尘仍在 template.html 里。
// 参数与配色出自 .oil-ui/pixel-wave-bg 设计稿（参考 React Bits Shape Waves 的速度手感，未搬代码）。

const INK = '#141310', ACCENT = '#e0442a';
const PITCH = 12, SIZE = 5;
const L1 = 220, L2 = 340, T1 = 7200, T2 = 11000;
const RAD = 24 * Math.PI / 180, CX = Math.cos(RAD), CY = Math.sin(RAD);
const A_LO = 0.025, A_HI = 0.085;            // 中档强度
const SIDE_LO = 0.32;
const STEP = (A_HI - A_LO) / 4;              // 透明度量化成 4 级台阶
const ACC = 0.02, PEAK = 0.80;               // 只有波峰中央极少几颗走强调色
const FPS = 30;                              // 波很慢，30fps 够用，别占满主线程

export function initDeskPixels(canvas){
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  let w = 1, h = 1, dpr = 1, cols = 0, rows = 0, acc = [];
  let raf = 0, disposed = false;

  function build(){
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    cols = Math.ceil(w / PITCH); rows = Math.ceil(h / PITCH);
    acc = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) acc.push(Math.random() < ACC);
  }

  function draw(t){
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx0 = w * 0.5, band = w * 0.20;     // 强调色只落在中央 40% 宽
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++){
      const x = i * PITCH + SIZE / 2, y = j * PITCH + SIZE / 2;
      const u = x * CX + y * CY;              // 沿 24° 方向的投影
      const s1 = Math.sin(2 * Math.PI * u / L1 - 2 * Math.PI * t / T1);
      const s2 = Math.sin(2 * Math.PI * u / L2 - 2 * Math.PI * t / T2 + 1.7);
      const v = 0.5 + 0.25 * s1 + 0.25 * s2;
      const side = SIZE * (SIDE_LO + (1 - SIDE_LO) * v);
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
