// 模型壳子与真屏：three.js 只负责机身、离屏牌桌、投影、拾取和按需渲染。
// 文字、数字和控件全部留在 HTML；按键外观来自 GLB，可点性由 HTML 热区提供。

import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { reduce } from './state.js';
import { NAME, SHORT, SUIT_GLYPH } from './labels.js';
import { handCards, trickCards, isMyTrick, rankCounts, isRedSuit } from './virtual-cards.js';
import { drawFace, FACE_W, FACE_H } from './card-face.js';

const MODEL_URL = new URL('../assets/console-b.glb', import.meta.url);
const MODEL_SCALE = 1 / 20;                 // 建模单位是 mm；20mm = 1 three.js 单位
const FOV = 30;
const TILT = -0.055;

// ADR-0006：真投影软阴影。key 灯兼职投影灯（castShadow 不改灯自己的贡献，只多一遍深度图），
// 机身背后立一块只吃阴影的接影面；机壳把 key 灯的光挡在它上面，落下的影子随姿态实时重算。
const SHADOW_MAP = 1024;             // 深度图边长
const SHADOW_SPAN = 12;              // 投影相机正交半宽：机身 |x|≤5.02 × 最大 1.6 倍缩放
const SHADOW_BACKDROP_Z = -1.30;     // 接影面的 z：机身最后沿 z≈-0.52，贴在它后面
const SHADOW_OPACITY = 0.24;
const SHADOW_COLOR = 0x241f2e;        // 暖底上的影子偏冷紫，比纯黑自然
const SHADOW_RADIUS = 18;            // VSM 半径（texel）：影子的软边就靠它
const SHADOW_BLUR_SAMPLES = 16;

const CARD_W = 0.74, CARD_H = 1.04, CARD_T = 0.05;
const FLAT = -Math.PI / 2;
const HAND_TILT = FLAT + 0.25;
const TRICK_TILT = FLAT + 0.50;
const BACK_TILT = FLAT + 0.62;
const MAX_BACKS = 4;
const SEAT_3D = {
  me:   { x: 0.0,   z: 3.30, labelZ: 5.40 },
  up:   { x: -4.55, z: -0.55, labelZ: -0.85 },
  down: { x: 4.55,  z: -0.55, labelZ: -0.85 },
};

let canvas, stage, overlayHook;
let renderer, scene, camera, rig, body, screenGroup, screenMesh, screenMat;
// 副屏是**真 3D 面**：内容画进一张 canvas，再当纹理贴到玻璃面前沿。
// DOM 那层 #counter 退化成「量尺寸 + 断言锚点」，不再往画布上面盖。
let subGroup = null, subMesh = null, subMat = null, subTex = null, subCanvas = null;
let subFace = null;   // { w, h, z }：玻璃面在机身坐标系里的尺寸与前沿
const SUB_TEX = { w: 1216, h: 80 };   // 1216×80 ≈ 玻璃面 113.90×7.50 的长宽比
// 主屏 HUD 同一套路数：座位徽章画进一张 canvas，再合成进主屏的离屏画面。
// 盖在画布上的 HTML 永远压在最上层——机身一转它就浮到屏外；画进屏的纹理，
// 才会跟着屏一块转、被凸边框挡住、翻到背面就看不见。
let hudScene = null, hudCam = null, hudTex = null, hudCanvas = null;
const HUD_TEX = { w: 1536, h: 804 };   // ≈ 主屏 104×54.4 的长宽比；按大屏 RT 的实际像素留够采样率
let tableScene, tableCam, rt;
let cardGroup, anchors = {}, frontMats = {}, backMat, edgeMat, shadowMat, shadowGeo, cardGeo;
let handMeshes = [], handHits = [], handRows = [], hitGeo, hitMat;
let screenSize = new THREE.Vector2(0.001, 0.001), screenPx = null;
let buttons = [], buttonZones = [], modelSize = new THREE.Vector3(10, 4.2, 1.0);
// 键帽按热区拆出来的独立组：按下时只有那一颗往 -Z 沉，机身不再替它做假动作。
let keyGroups = new Map();
let screenCenter = new THREE.Vector3();
let stageW = 0, stageH = 0, dpr = 1, observedW = 0, observedH = 0;
// 渲染画布铺满视口（比 .stage 设计盒大）；热区/叠加层仍按设计盒坐标算
let canvasW = 0, canvasH = 0, observedCW = 0, observedCH = 0;
let lastSnap = null, lastMeta = null, narrowHand = false, tinyHand = false;
let pointerTarget = { x: 0, y: 0 }, view = { x: 0, y: 0 };
let parallaxRunning = false, parallaxStart = 0;
let dragYaw = 0, dragTilt = 0, dragFromYaw = 0, dragFromTilt = 0;
let dragStartX = 0, dragStartY = 0, isDraggingRig = false, dragSpringRunning = false;
let rigZoom = 1, rigZoomTarget = 1, zoomSpringRunning = false, zoomSpringStart = 0;
// 拖空白背景的平移偏移（rig 单位），和视差 view 叠加，松手弹回 0
let panX = 0, panY = 0, panScale = 0.01;
let panDragging = false, panSpringRunning = false;
let panStartX = 0, panStartY = 0, panFromX = 0, panFromY = 0, panSpringStart = 0;
const ZOOM_MIN = 0.75, ZOOM_MAX = 1.6, ZOOM_STEP = 0.04;
let dragSpringFrom = 0, dragSpringStart = 0;
let parallaxFrom = { x: 0, y: 0 }, parallaxTo = { x: 0, y: 0 };
let started = false, ready = false, status = 'idle', error = '';
// 入场动画占用 rig.scale；期间不接受滚轮缩放，免得两条动画抢同一根轴。
let entranceDone = true;
// 入场（ADR-0011）：就绪时先落到起点、但不播；等加载层收完尾（boot:done）再浮现。
// 没有幕布可等（例如 8s 强放行之后才就绪）就直接播。
const ENTRANCE_FROM = 0.94;
let entranceStartedAt = null;
function armEntrance(){
  if (reduce || !window.gsap || !rig){ entranceDone = true; return; }
  entranceDone = false;
  const to = rigZoom;
  rig.scale.setScalar(to * ENTRANCE_FROM);      // 先落到起点，别在幕布后面偷偷播完
  if (canvas) canvas.style.opacity = '0';
  requestRender();
  if (document.body.classList.contains('is-booting')) {
    document.addEventListener('boot:done', playEntrance, { once: true });
  } else {
    playEntrance();
  }
}
function playEntrance(){
  if (entranceStartedAt) return;
  entranceStartedAt = performance.now();
  const to = rigZoom;
  // 淡入用 ease-in-out：起手慢，才读得出是「浮现」而不是「弹出来」
  if (canvas) gsap.fromTo(canvas, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'power1.inOut' });
  gsap.to(rig.scale, { x: to, y: to, z: to, duration: 0.8, ease: 'power2.out',
    onUpdate: requestRender, onComplete: () => { entranceDone = true; relayout(); } });
}
// boot 交接用：机身就绪或明确失败时兑现一次；重复装载会换新的 Promise。
let readyResolve = null;
let readyPromise = new Promise(res => { readyResolve = res; });
/** 机身进入终态时兑现，值就是那个状态：'ready' | 'error' | 'no-webgl'。 */
export function whenSettled(){ return readyPromise; }
let nodes = [], buttonsVisible = false, contactShadow = null, backdrop = null;
let frameCount = 0, renderQueued = false, dirty = true;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmp = new THREE.Vector3();

const cssVar = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const hex = name => new THREE.Color(cssVar(name));
const isNarrow = () => stageW > 0 && stageW < 950;
const isTiny = () => stageW > 0 && stageW < 620;

/* ---------- 牌面贴图：仍在离屏牌桌里现画，不往仓库塞图片 ---------- */
const TEX_SCALE = 4;
function makeCanvas(w, h){
  const c = document.createElement('canvas');
  c.width = w * TEX_SCALE; c.height = h * TEX_SCALE;
  const g = c.getContext('2d');
  g.scale(TEX_SCALE, TEX_SCALE);
  return c;
}
function asTexture(c, crisp = false){
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  // crisp：牌面这类小贴图走最近邻缩小，保留像素硬边（参考图质感）
  t.minFilter = crisp ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = !crisp;
  t.anisotropy = crisp ? 1 : 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function faceTexture(rank, suit){
  // 造型在 card-face.js：A 一个大花色、2–10 对称排点、J/Q/K 半身像、大小王王冠人像。
  // 这里只管配色与字形：红色只给红桃方片，大王按老规矩也是红的，其余走墨色。
  // 手牌叠扇后只露出左侧窄条，大小王写成「小 / 大」、10 缩成两字符，避免只露出半个字。
  const c = makeCanvas(FACE_W, FACE_H);
  drawFace(c.getContext('2d'), {
    rank,
    glyph: SUIT_GLYPH[suit],
    label: SHORT[rank] || NAME[rank] || rank,
    color: rank === 'R' || isRedSuit(suit) ? cssVar('--accent') : cssVar('--ink'),
    accent: cssVar('--accent'),
  });
  return asTexture(c, true);
}
function backTexture(){
  // 参考图的牌背：白边 + periwinkle 底 + 浅色斜纹与中心菱花
  const c = makeCanvas(52, 74), g = c.getContext('2d');
  g.fillStyle = '#fbfaf6'; g.fillRect(0, 0, 52, 74);
  g.fillStyle = '#7787b8'; g.fillRect(3, 3, 46, 68);
  g.fillStyle = '#93a1c9';
  for (let y = 5; y < 69; y += 6)
    for (let x = 5 + ((y / 6) % 2 ? 3 : 0); x < 47; x += 6) g.fillRect(x, y, 2, 2);
  g.strokeStyle = '#55639a'; g.lineWidth = 2;
  g.strokeRect(8.5, 9.5, 35, 55);
  g.beginPath(); g.moveTo(26, 25); g.lineTo(37, 37); g.lineTo(26, 49); g.lineTo(15, 37);
  g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(26, 31); g.lineTo(31, 37); g.lineTo(26, 43); g.lineTo(21, 37);
  g.closePath(); g.stroke();
  g.strokeStyle = cssVar('--ink'); g.lineWidth = 2;
  g.strokeRect(1, 1, 50, 72);
  return asTexture(c, true);
}

/* ---------- 牌桌几何 ---------- */
function octaShape(w, h, c){
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2, k = Math.min(c, Math.min(w, h) / 2 - 0.01);
  s.moveTo(x + k, y);        s.lineTo(x + w - k, y);
  s.lineTo(x + w, y + k);    s.lineTo(x + w, y + h - k);
  s.lineTo(x + w - k, y + h);s.lineTo(x + k, y + h);
  s.lineTo(x, y + h - k);    s.lineTo(x, y + k);
  s.closePath();
  return s;
}
function octaRing(w, h, c, iw, ih, ic){
  const s = octaShape(w, h, c);
  s.holes.push(octaShape(iw, ih, ic));
  return s;
}
function extrude(shape, d, bevel = 0.02){
  const depth = Math.max(0.004, d - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 1, curveSegments: 2, steps: 1,
  });
  g.center();
  return g;
}
function matOf(color){
  // 参考图是平涂像素：不开光照响应，颜色才不被灯打出渐变
  return new THREE.MeshBasicMaterial({ color });
}
function feltTexture(){
  // 绒面：蓝绿底 + 边缘暗角 + 一圈缝线，全部画在低分辨率画布上
  const c = makeCanvas(168, 116), g = c.getContext('2d');
  g.fillStyle = '#266083'; g.fillRect(0, 0, 168, 116);
  g.fillStyle = '#235a7a';
  for (let y = 0; y < 116; y += 4)
    for (let x = ((y / 4) % 2 ? 2 : 0); x < 168; x += 4) g.fillRect(x, y, 2, 2);
  const edge = g.createRadialGradient(84, 58, 30, 84, 58, 96);
  edge.addColorStop(0, 'rgba(10,32,43,0)');
  edge.addColorStop(1, 'rgba(10,32,43,0.55)');
  g.fillStyle = edge; g.fillRect(0, 0, 168, 116);
  g.strokeStyle = '#123f5a'; g.lineWidth = 2; g.setLineDash([5, 4]);
  g.beginPath();
  const k = 14;
  g.moveTo(k + 6, k); g.lineTo(168 - k - 6, k); g.lineTo(168 - k, k + 6);
  g.lineTo(168 - k, 116 - k - 6); g.lineTo(168 - k - 6, 116 - k);
  g.lineTo(k + 6, 116 - k); g.lineTo(k, 116 - k - 6); g.lineTo(k, k + 6);
  g.closePath(); g.stroke();
  g.setLineDash([]);
  return asTexture(c);
}
function buildTable(){
  const base = new THREE.Color('#201a26');      // 桌体外壳：近黑梅色
  const wood = new THREE.Color('#bc633d');      // 铜木圈
  const woodSide = new THREE.Color('#74242e');  // 圈侧壁：暗红
  const rim = new THREE.Color('#d99a4e');       // 金内沿
  const CZ = 0.90;
  const TW = 13.8, TD = 9.3, TC = 2.6;
  const FW = 11.4, FD = 7.0, FC = 2.0;
  const put = (shape, d, color, topY, sideColor) => {
    const mats = sideColor ? [matOf(color), matOf(sideColor)] : matOf(color);
    const m = new THREE.Mesh(extrude(shape, d, 0.02), mats);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, topY - d / 2, CZ);
    tableScene.add(m);
  };
  put(octaShape(TW + 0.9, TD + 0.9, TC + 0.4), 0.6, base, -1.72);
  // 侧壁只在近侧（画面下沿）露出暗红一条，远侧被桌体挡住 —— 与参考图一致
  put(octaRing(TW, TD, TC, FW, FD, FC), 1.3, wood, 0.26, woodSide);
  // 金内沿外缘塞进木圈底下，避免两道之间露缝
  put(octaRing(FW + 0.10, FD + 0.10, FC + 0.04, FW - 0.30, FD - 0.30, FC - 0.10),
      0.10, rim, 0.05);
  const fw = FW - 0.28, fd = FD - 0.28;
  const ft = feltTexture();
  // ExtrudeGeometry 的盖面 UV 就是形状坐标（世界单位），缩到 0..1 才铺满整块绒面
  ft.repeat.set(1 / fw, 1 / fd); ft.offset.set(0.5, 0.5);
  const felt = new THREE.Mesh(extrude(octaShape(fw, fd, FC - 0.09), 0.34, 0.02),
    [new THREE.MeshBasicMaterial({ map: ft }),
     new THREE.MeshBasicMaterial({ color: '#1d4f6e' })]);
  felt.rotation.x = -Math.PI / 2;
  felt.position.set(0, -0.06, CZ);
  tableScene.add(felt);
  // 参考图顶心的牌堆：奶油圆角牌垫 + 金色双菱纹
  const dc = makeCanvas(64, 40), dg = dc.getContext('2d');
  dg.fillStyle = '#efe0b8'; dg.fillRect(0, 0, 64, 40);
  dg.strokeStyle = '#c8a05e'; dg.lineWidth = 2; dg.strokeRect(4, 4, 56, 32);
  dg.beginPath(); dg.moveTo(32, 12); dg.lineTo(44, 20); dg.lineTo(32, 28); dg.lineTo(20, 20);
  dg.closePath(); dg.stroke();
  dg.beginPath(); dg.moveTo(32, 16); dg.lineTo(38, 20); dg.lineTo(32, 24); dg.lineTo(26, 20);
  dg.closePath(); dg.stroke();
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.7),
    new THREE.MeshBasicMaterial({ map: asTexture(dc) }));
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(0, 0.13, CZ - 2.60);
  tableScene.add(deck);
}
function cardMesh(rank, suit, faceUp){
  const key = suit ? `${rank}${suit}` : rank;   // 同点数的四张牌各画各的花色
  const mats = faceUp
    ? [edgeMat, edgeMat, edgeMat, edgeMat,
       frontMats[key] || (frontMats[key] = new THREE.MeshBasicMaterial({ map: faceTexture(rank, suit), depthTest: false })),
       backMat]
    : [edgeMat, edgeMat, edgeMat, edgeMat, backMat, backMat];
  const m = new THREE.Mesh(cardGeo, mats);
  // 参考图的牌是"贴纸"：牌身后垫一块偏移硬阴影，叠扇时自然分出层次
  const sh = new THREE.Mesh(shadowGeo, shadowMat);
  sh.position.set(0.055, -0.055, -CARD_T / 2 - 0.012);
  m.add(sh);
  return m;
}
const _hcW = new THREE.Vector3(), _hcC = new THREE.Vector3();
// 手牌扇面两端的投影可能越出屏幕（NDC 超出 ±1），拾取落点会掉到屏幕 rect 外被边界挡掉。
// 在相机空间里把牌心拉回屏内（保持深度不变），拾取与渲染就永远一致。
function clampHandCenter(px, lift, pz){
  if (!tableCam) return null;
  tableCam.updateMatrixWorld();
  cardGroup.updateWorldMatrix(true, false);
  _hcW.set(px, lift, pz);
  cardGroup.localToWorld(_hcW);
  _hcC.copy(_hcW).applyMatrix4(tableCam.matrixWorldInverse);
  const e = tableCam.projectionMatrix.elements;
  const nz = -_hcC.z;
  if (!(nz > 0.001)) return null;
  const ndcX = (_hcC.x * e[0]) / nz, ndcY = (_hcC.y * e[5]) / nz;
  const M = 0.94;
  if (Math.abs(ndcX) <= M && Math.abs(ndcY) <= M) return null;
  _hcC.x = Math.min(M, Math.max(-M, ndcX)) * nz / e[0];
  _hcC.y = Math.min(M, Math.max(-M, ndcY)) * nz / e[5];
  _hcC.applyMatrix4(tableCam.matrixWorld);
  cardGroup.worldToLocal(_hcC);
  return _hcC;
}
function layRow(cards, x, z, faceUp, tilt, spacing, scale = 1, track = false,
                offset = 0, fan = 0, yaw = 0, arc = 0, surf = 0.18, order = 0){
  const n = cards.length;
  if (!n) return;
  const mid = (n - 1) / 2, rowHits = [];
  cards.forEach((card, i) => {
    const { rank, suit } = card;
    const off = i - mid;
    const roll = fan * off;
    let lift = surf + (CARD_H * scale / 2) * Math.cos(tilt) + 0.02 - arc * off * off;
    let px = x + off * spacing, pz = z + i * 0.03 + arc * off * off * 1.9;
    if (track){
      const c = clampHandCenter(px, lift, pz);
      if (c){ px = c.x; lift = c.y; pz = c.z; }
    }
    const m = cardMesh(rank, suit, faceUp);
    m.renderOrder = order + i * 2;
    m.children[0].renderOrder = order + i * 2 - 1;
    m.position.set(px, lift, pz);
    m.rotation.set(tilt, yaw, roll, 'YXZ');
    m.scale.setScalar(scale);
    if (track){
      m.userData = { handIndex: offset + i, rank, baseY: lift };
      handMeshes.push(m);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(px, lift, pz);
      hit.rotation.set(tilt, yaw, roll, 'YXZ');
      hit.scale.setScalar(scale);
      // 手牌是叠扇：牌 i 的可见部分被右邻压住，投影点必须落在可见带内，
      // 否则落点会命中的右邻（拾取与点击错位）。
      hit.userData = { handIndex: offset + i, visibleShift: 0 };
      // 拾取优先级与渲染叠放一致：renderOrder 大的牌压在上方，先被点中。
      hit.renderOrder = order + i * 2;
      handHits.push(hit);
      rowHits.push(hit);
      cardGroup.add(hit);
    }
    cardGroup.add(m);
  });
  // clampHandCenter 可能把边缘牌拉离等距扇面；落点要按实际相邻中心算，
  // 否则最外侧牌的可点区域会压到邻牌下面。
  const half = CARD_W * scale / 2;
  rowHits.forEach((hit, i) => {
    const next = rowHits[i + 1];
    hit.userData.visibleShift = next
      ? (next.position.x - hit.position.x) / 2 - half
      : 0;
  });
}
function drawCards(){
  if (!lastSnap || !lastMeta || !cardGroup) return;
  // clampHandCenter 依赖 tableCam 的投影矩阵；画牌前先同步副屏宽高比，
  // 否则入场/初始化时序不同会让边缘牌的位置漂移。
  if (screenSize.x > 0 && screenSize.y > 0){
    tableCam.aspect = screenSize.x / screenSize.y;
    tableCam.updateProjectionMatrix();
  }
  narrowHand = isNarrow(); tinyHand = isTiny();
  while (cardGroup.children.length) cardGroup.remove(cardGroup.children[0]);
  anchors = {};
  // 虚拟牌身份（ADR-0007）：花色按 record_id 确定性合成，只为了让牌面像一副真扑克，
  // 不参与任何斗地主判断。我已打出的张数决定手牌从第几个花色接着发。
  const recordId = lastMeta.record_id;
  const myPlayed = (lastSnap.played || {})[lastSnap.me] || [];
  const myCounts = rankCounts(myPlayed);
  Object.keys(lastMeta.seats).forEach(player => {
    const rel = lastMeta.seats[player].relative;
    const place = SEAT_3D[rel] || SEAT_3D.down;
    if (rel === 'me'){
      const hand = handCards(recordId, lastSnap.my_hand || [], myCounts);
      handMeshes = []; handHits = []; handRows = [];
      if (tinyHand && hand.length > 9){
        // 420px 下 17 张牌塞单排时每张只露约 11px，点数必然糊成一条。
        // 分成 9+8 两排，索引仍按原手牌顺序连续；前排靠近玩家，后排靠桌心。
        const split = Math.ceil(hand.length / 2);
        const sz = 2.20;
        const gap = CARD_W * sz * 0.62;
        const rows = [
          { cards: hand.slice(0, split), offset: 0, z: place.z + 0.86 },
          { cards: hand.slice(split), offset: split, z: place.z - 0.86 },
        ];
        for (const row of rows){
          layRow(row.cards, place.x, row.z, true, HAND_TILT, gap, sz, true,
                 row.offset, -0.012, 0, 0, 0.55, row.offset ? 500 : 600);
          handRows.push({ start: row.offset, count: row.cards.length });
        }
      } else {
        const n = Math.max(hand.length, 1);
        const per = (n - 1) * 0.44 + 1;
        const szMax = 13.0 / (CARD_W * per);
        const sz = Math.max(narrowHand ? 1.52 : 1.62,
                            tinyHand ? Math.min(2.30, szMax) : 0);
        const gap = n > 1 ? CARD_W * sz * 0.46 : 0;
        // 20 张是满手牌的上限；弧度过大会把两端投影出副屏。
        const arc = n > 18 ? 0.005 : n > 15 ? 0.009 : 0.014;
        layRow(hand, place.x, place.z + 0.42, true, HAND_TILT, gap, sz, true, 0, -0.018, 0, arc, 0.85, 500);
        handRows.push({ start: 0, count: hand.length });
      }
    } else {
      const back = Math.min(lastSnap.remaining[player], MAX_BACKS);
      const dir = rel === 'up' ? 1 : -1;
      // 牌背不露牌面，塞个占位点数走同一条 layRow
      layRow(Array.from({ length: back }, () => ({ rank: 'T', suit: null })),
             place.x, place.z, false, BACK_TILT, 0.17,
             1.25, false, 0, dir * 0.06, -dir * 0.55, 0, 0.32, 100);
    }
    anchors[player] = new THREE.Vector3(place.x, 0.06, place.labelZ);
  });
  const trick = lastSnap.last_move || [];
  const trickRow = trickCards(recordId, trick, myCounts, isMyTrick(myPlayed, trick));
  const trickScale = tinyHand ? 2.10 : (narrowHand ? 1.30 : 1.42);
  const cardW = CARD_W * trickScale;
  const want = 0.86 * trickScale;
  const fit = trick.length > 1 ? 13.0 / (trick.length - 1) : want;
  const trickGap = Math.max(cardW * 0.46, Math.min(want, fit));
  layRow(trickRow, 0, tinyHand ? -1.10 : (narrowHand ? 0.55 : 0.95),
         true, TRICK_TILT, trickGap, trickScale, false, 0, -0.02, 0, 0, 0.32, 300);
}

/* ---------- GLB 测量 ---------- */
function modelBox(obj){
  obj.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(obj);
}
function nodeGeometryBoxLocal(node, parent){
  const geo = node.geometry;
  if (!geo) return null;
  geo.computeBoundingBox();
  node.updateWorldMatrix(true, true);
  parent.updateWorldMatrix(true, true);
  const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    .multiply(node.matrixWorld);
  return geo.boundingBox.clone().applyMatrix4(toParent);
}
// 按键连通块在模型的正面（+Z）上量。GLTFLoader 会把每个 primitive 拆成
// 独立 mesh，所以按材质名筛选；这里读的是模型自身坐标系，不受整机 1/20 缩放影响。
function collectFrontTriangles(root, materialName){
  const out = [];
  root.updateWorldMatrix(true, true);
  root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const mat = mats[0];
    if (!mat || mat.name !== materialName) return;
    const geo = mesh.geometry, pos = geo.getAttribute('position');
    if (!pos) return;
    const count = geo.index ? geo.index.count : pos.count;
    for (let i = 0; i < count; i += 3){
      const ia = geo.index ? geo.index.getX(i) : i;
      const ib = geo.index ? geo.index.getX(i + 1) : i + 1;
      const ic = geo.index ? geo.index.getX(i + 2) : i + 2;
      const a = new THREE.Vector3().fromBufferAttribute(pos, ia);
      const b = new THREE.Vector3().fromBufferAttribute(pos, ib);
      const c = new THREE.Vector3().fromBufferAttribute(pos, ic);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.z <= 0.5) continue;
      out.push({
        minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
        minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y),
        minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z),
      });
    }
  });
  return out;
}
function clusterTriangles(tris, gap = 0.02){
  const parent = tris.map((_, i) => i);
  const find = i => {
    while (parent[i] !== i){ parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < tris.length; i++){
    for (let j = 0; j < i; j++){
      const a = tris[i], b = tris[j];
      if (a.minX <= b.maxX + gap && b.minX <= a.maxX + gap &&
          a.minY <= b.maxY + gap && b.minY <= a.maxY + gap) union(i, j);
    }
  }
  const groups = new Map();
  tris.forEach((t, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  });
  return [...groups.values()].map(parts => {
    const minX = Math.min(...parts.map(p => p.minX));
    const maxX = Math.max(...parts.map(p => p.maxX));
    const minY = Math.min(...parts.map(p => p.minY));
    const maxY = Math.max(...parts.map(p => p.maxY));
    const maxZ = Math.max(...parts.map(p => p.maxZ));
    return { minX, maxX, minY, maxY, maxZ, w: maxX - minX, h: maxY - minY,
             cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, parts: parts.length };
  }).filter(c => c.w > 0.25 && c.h > 0.25);
}
// 画布比设计盒大，但两者中心重合：先映射到画布像素，再减掉偏移，
// 输出的仍是 .stage 局部坐标，叠加层和 isOnBody 的口径完全不用改。
function projectPoint(x, y, z){
  tmp.set(x, y, z).project(camera);
  const cw = canvasW || stageW, ch = canvasH || stageH;
  return { x: (tmp.x * 0.5 + 0.5) * cw - (cw - stageW) / 2,
           y: (-tmp.y * 0.5 + 0.5) * ch - (ch - stageH) / 2 };
}
function projectModelPoint(x, y, z){
  tmp.set(x, y, z).applyMatrix4(body.matrixWorld);
  return projectPoint(tmp.x, tmp.y, tmp.z);
}
function rectFromPoints(points){
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function projectZone(z, clip = '') {
  const p = [
    projectModelPoint(z.minX, z.minY, z.maxZ),
    projectModelPoint(z.maxX, z.minY, z.maxZ),
    projectModelPoint(z.maxX, z.maxY, z.maxZ),
    projectModelPoint(z.minX, z.maxY, z.maxZ),
  ];
  const r = rectFromPoints(p);
  return {
    ...r,
    clip: clip && `polygon(50% 0,100% 50%,50% 100%,0 50%)`,
  };
}
function projectFrontBox(box){
  return rectFromPoints([
    projectPoint(box.min.x, box.min.y, box.max.z),
    projectPoint(box.max.x, box.min.y, box.max.z),
    projectPoint(box.max.x, box.max.y, box.max.z),
    projectPoint(box.min.x, box.max.y, box.max.z),
  ]);
}
// 节点在**机身自己坐标系**里的包围盒：整机旋转不该把它撑胖，
// 否则转起来量到的就不是那个平面本身了。
function modelLocalBox(obj){
  // 先刷到世界矩阵（含父级）：body.matrixWorld 过期的瞬间量出来的是错盒子。
  obj.updateWorldMatrix(true, true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const box = new THREE.Box3();
  obj.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const m = new THREE.Matrix4().copy(toBody).multiply(mesh.matrixWorld);
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(m));
  });
  return box.isEmpty() ? null : box;
}
// 正面四角的投影**四边形**（不是包围盒）：机身转起来以后副屏是斜的，
// 用 AABB 贴上去必然顶到区域外面；角点才能让覆盖层跟着一起转。
function projectFrontQuad(box){
  const z = box.max.z;
  return {
    tl: projectModelPoint(box.min.x, box.max.y, z),
    tr: projectModelPoint(box.max.x, box.max.y, z),
    br: projectModelPoint(box.max.x, box.min.y, z),
    bl: projectModelPoint(box.min.x, box.min.y, z),
  };
}
function unionRects(list){
  if (!list.length) return null;
  const x = Math.min(...list.map(r => r.x));
  const y = Math.min(...list.map(r => r.y));
  const right = Math.max(...list.map(r => r.x + r.w));
  const bottom = Math.max(...list.map(r => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}
function measureButtons(root){
  // 键底和键沿分属两个 primitive；并集后才是每个物理键完整的外轮廓。
  const keyClusters = clusterTriangles([
    ...collectFrontTriangles(root, 'keyMat'),
    ...collectFrontTriangles(root, 'keyEdgeMat'),
  ], 0.2);
  const centerClusters = clusterTriangles(collectFrontTriangles(root, 'keyCenterMat'));
  const dpad = keyClusters.filter(c => c.cx < 0 && c.w > 0.8 && c.h > 0.8)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const square = keyClusters.filter(c => c.cx < 0 && c.w <= 12 && c.h <= 12)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const diamonds = keyClusters.filter(c => c.cx > 0 && c.w <= 12 && c.h <= 12)
    .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 4);
  if (!dpad || !square || diamonds.length !== 4){
    throw new Error('Buttons 里量不出 10 个物理键（D-pad / 4 菱形 / 1 方键）');
  }
  const center = centerClusters
    .filter(c => c.cx > dpad.minX && c.cx < dpad.maxX && c.cy > dpad.minY && c.cy < dpad.maxY)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const cw = center ? center.w : Math.min(dpad.w, dpad.h) / 3.2;
  const ch = center ? center.h : Math.min(dpad.w, dpad.h) / 3.2;
  const cx = center ? center.cx : dpad.cx;
  const cy = center ? center.cy : dpad.cy;
  const diamondClip = 'polygon(50% 0,100% 50%,50% 100%,0 50%)';
  const right = {
    up: diamonds.slice().sort((a, b) => b.cy - a.cy)[0],
    down: diamonds.slice().sort((a, b) => a.cy - b.cy)[0],
    left: diamonds.slice().sort((a, b) => a.cx - b.cx)[0],
    right: diamonds.slice().sort((a, b) => b.cx - a.cx)[0],
  };
  const zones = [
    ['dpad-up', { minX: cx - cw / 2, maxX: cx + cw / 2, minY: cy + ch / 2, maxY: dpad.maxY, maxZ: dpad.maxZ }, ''],
    ['dpad-down', { minX: cx - cw / 2, maxX: cx + cw / 2, minY: dpad.minY, maxY: cy - ch / 2, maxZ: dpad.maxZ }, ''],
    ['dpad-left', { minX: dpad.minX, maxX: cx - cw / 2, minY: cy - ch / 2, maxY: cy + ch / 2, maxZ: dpad.maxZ }, ''],
    ['dpad-right', { minX: cx + cw / 2, maxX: dpad.maxX, minY: cy - ch / 2, maxY: cy + ch / 2, maxZ: dpad.maxZ }, ''],
    ['play-clear', { minX: cx - cw / 2, maxX: cx + cw / 2, minY: cy - ch / 2, maxY: cy + ch / 2, maxZ: center ? center.maxZ : dpad.maxZ }, ''],
    ['play-hint-btn', right.up, diamondClip],
    ['undo', right.left, diamondClip],
    ['play-go', right.right, diamondClip],
    ['play-pass', right.down, diamondClip],
    ['new-round', square, ''],
  ];
  return zones;
}

// 键面材质：按下去时往 -Z 沉的是这几款；键沿/台阶（keyEdgeMat）留在原地当键井，
// 于是能看到"键帽陷进井里"，而不是整块（含井圈）一起平移。
const FACE_MATERIALS = new Set(['keyMat', 'keyCenterMat', 'symbolMat', 'keyMarkMat']);

// 把一个合并键网格按量出的热区拆成"每个键一组"：几何只在内存里重排成非索引三角，
// 顶点数据逐个照抄，静止时与原网格逐像素一致。每组再分 root（键沿，静止）/ face
// （键面，可位移）两层，按下的那颗键帽才能单独往 -Z 沉一点再弹回来。
function splitKeyNode(keyNode, zones, rootName){
  const meshes = [];
  keyNode.traverse(m => { if (m.isMesh && m.geometry) meshes.push(m); });
  const parent = keyNode.parent;
  const root = new THREE.Group();
  root.name = rootName;                   // 节点名得留着：节点清单与验收都按它找
  parent.add(root);
  const groups = new Map();
  zones.forEach(([id]) => {
    const g = new THREE.Group();
    g.name = `Key_${id}`;
    const face = new THREE.Group();
    face.name = `Key_${id}_face`;
    g.add(face);
    root.add(g);
    groups.set(id, { root: g, face });
  });
  // 热区盒子拼不出键帽的全部边角（D-pad 连体裙边、菱形键的斜角），所以取"落在盒内
  // 优先、否则最近"，保证每一片三角都有归属。
  const nearest = (x, y) => {
    let best = 0, bestD = Infinity;
    zones.forEach(([, z], i) => {
      const dx = Math.max(z.minX - x, 0, x - z.maxX);
      const dy = Math.max(z.minY - y, 0, y - z.maxY);
      const d = dx * dx + dy * dy;
      if (d < bestD){ bestD = d; best = i; }
    });
    return best;
  };
  for (const mesh of meshes){
    const geo = mesh.geometry, pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal'), uv = geo.getAttribute('uv');
    const index = geo.index;
    const count = index ? index.count : pos.count;
    const buckets = new Map();             // 热区序号 → 摊平的顶点序号
    for (let i = 0; i < count; i += 3){
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      const cx = (pos.getX(ia) + pos.getX(ib) + pos.getX(ic)) / 3;
      const cy = (pos.getY(ia) + pos.getY(ib) + pos.getY(ic)) / 3;
      const zi = nearest(cx, cy);
      let list = buckets.get(zi);
      if (!list){ list = []; buckets.set(zi, list); }
      list.push(ia, ib, ic);
    }
    for (const [zi, list] of buckets){
      const n = list.length;
      const np = new Float32Array(n * 3);
      const nn = nor ? new Float32Array(n * 3) : null;
      const nu = uv ? new Float32Array(n * 2) : null;
      for (let k = 0; k < n; k++){
        const src = list[k];
        np[k * 3] = pos.getX(src); np[k * 3 + 1] = pos.getY(src); np[k * 3 + 2] = pos.getZ(src);
        if (nn){ nn[k * 3] = nor.getX(src); nn[k * 3 + 1] = nor.getY(src); nn[k * 3 + 2] = nor.getZ(src); }
        if (nu){ nu[k * 2] = uv.getX(src); nu[k * 2 + 1] = uv.getY(src); }
      }
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.BufferAttribute(np, 3));
      if (nn) ng.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      if (nu) ng.setAttribute('uv', new THREE.BufferAttribute(nu, 2));
      ng.computeBoundingBox(); ng.computeBoundingSphere();
      const nm = new THREE.Mesh(ng, mesh.material);
      nm.name = `${mesh.name}__${zones[zi][0]}`;
      nm.castShadow = mesh.castShadow; nm.receiveShadow = mesh.receiveShadow;
      const g = groups.get(zones[zi][0]);
      (FACE_MATERIALS.has(mesh.material.name) ? g.face : g.root).add(nm);
    }
  }
  parent.remove(keyNode);
  return groups;
}

/* ---------- 布局 / 投影 ---------- */
function projectScreenLocal(lx, ly){
  const v = new THREE.Vector3(lx, ly, 0);
  screenGroup.localToWorld(v);
  return projectPoint(v.x, v.y, v.z);
}
function relayout(){
  if (!started || !stageW) return;
  if (!ready){
    emit();
    return;
  }
  rig.updateMatrixWorld(true);
  body.updateWorldMatrix(true, true);
  camera.updateMatrixWorld(true);
  tableCam.updateMatrixWorld(true);

  const screen = rectFromPoints([
    projectScreenLocal(-screenSize.x / 2, -screenSize.y / 2),
    projectScreenLocal(screenSize.x / 2, -screenSize.y / 2),
    projectScreenLocal(screenSize.x / 2, screenSize.y / 2),
    projectScreenLocal(-screenSize.x / 2, screenSize.y / 2),
  ]);
  screenPx = screen;

  const seats = {};
  for (const [player, v] of Object.entries(anchors)){
    const n = v.clone().project(tableCam);
    seats[player] = projectScreenLocal(n.x * screenSize.x / 2, n.y * screenSize.y / 2);
  }
  buttons = buttonZones.map(([id, z, clip]) => ({ id, ...projectZone(z, clip) }));
  // 量玻璃面本身：整组盒子含凸边框，投影会往外多出一圈。
  const topNode = body.getObjectByName('SubDisplay_1') || body.getObjectByName('SubDisplay');
  const topBox = topNode ? (topNode.isMesh ? nodeGeometryBoxLocal(topNode, body) : modelLocalBox(topNode)) : null;
  const topQuad = topBox ? projectFrontQuad(topBox) : null;
  const top = topQuad ? rectFromPoints([topQuad.tl, topQuad.tr, topQuad.br, topQuad.bl]) : null;
  const tablet = projectFrontBox(modelBox(body));
  const left = unionRects(buttons.filter(b => ['dpad-up','dpad-down','dpad-left','dpad-right','play-clear','new-round'].includes(b.id)));
  const right = unionRects(buttons.filter(b => ['play-hint-btn','undo','play-go','play-pass'].includes(b.id)));

  if (rt){
    const aspect = screenSize.x / screenSize.y;
    tableCam.aspect = aspect;
    tableCam.updateProjectionMatrix();
    // 屏内按实际像素渲染：RT 与真屏 1:1，画面不再被放大成马赛克
    const rtW = Math.max(160, Math.min(2048, Math.round(screen.w * dpr)));
    const rtH = Math.max(100, Math.min(2048, Math.round(rtW / aspect)));
    // 旋转时屏的投影宽高每帧都抖零点几像素；差得不多就别重建 render target
    if (Math.abs(rt.width - rtW) > 2 || Math.abs(rt.height - rtH) > 2) rt.setSize(rtW, rtH);
  }
  emit({ seats, rects: { screen, left, right, top, topQuad, tablet }, buttons });
  requestRender();
}
function emit(extra = {}){
  if (!overlayHook) return;
  overlayHook({
    status: ready ? 'ready' : status,
    error,
    seats: extra.seats || {},
    rects: extra.rects || {},
    buttons: extra.buttons || buttons,
    sub3d: ready && !!subMesh,
    screen3d: ready && !!screenMesh,
  });
}
function resize(w, h){
  if (!renderer || !w || !h) return;
  // w/h 是设计盒（.stage）尺寸，决定机身画多大、热区落在哪；
  // 画布本身铺满视口，只负责别把拖出去的机身切掉。
  const cw = Math.max(1, Math.round(canvas.clientWidth || w));
  const ch = Math.max(1, Math.round(canvas.clientHeight || h));
  if (w === observedW && h === observedH && cw === observedCW && ch === observedCH) return;
  observedW = w; observedH = h; observedCW = cw; observedCH = ch;
  stageW = w; stageH = h;
  canvasW = cw; canvasH = ch;
  camera.aspect = cw / ch;
  rig.rotation.x = isNarrow() ? 0 : TILT;
  // 取景（机身多大、热区落在哪）仍按设计盒 .stage 定，画布变大只把竖向视锥撑开：
  // 相机位置不动、z=0 平面上的「世界→像素」比不动，机身投影才和改动前逐像素一致
  // （拉远相机去凑视锥会改透视，机身会缩水几个百分点）。
  const fitH = Math.max(modelSize.y * 1.18, modelSize.x * 1.10 / (w / h));
  const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  const dist = (fitH / 2) / halfTan;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfTan * (ch / h)));
  panScale = fitH / h;                   // z=0 平面上 1 CSS px 对应的世界单位
  camera.position.set(0, 0.05, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(cw, ch, false);
  if (ready && lastSnap && (isNarrow() !== narrowHand || isTiny() !== tinyHand)) drawCards();
  relayout();
  requestRender();
}

/* ---------- 机底接触阴影 ---------- */
// ADR-0004 允许的唯一额外层：不改材质响应，只在机身下面压一块软贴片。
function contactShadowTexture(){
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 64, 0, 128, 64, 126);
  grd.addColorStop(0, 'rgba(20,19,16,0.30)');
  grd.addColorStop(0.45, 'rgba(20,19,16,0.13)');
  grd.addColorStop(1, 'rgba(20,19,16,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeContactShadow(){
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true,
      depthWrite: false, toneMapped: false }),
  );
  mesh.name = 'ContactShadow';
  mesh.visible = false;
  return mesh;
}
// ADR-0006：只吃阴影的接影面。ShadowMaterial 不参与光照，所以它不改变机身亮度，
// 只在被 key 灯挡住的像素上压一层暗 —— 保真色块不受影响。
function makeShadowBackdrop(){
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(SHADOW_SPAN * 2, SHADOW_SPAN * 2),
    new THREE.ShadowMaterial({ color: SHADOW_COLOR, opacity: SHADOW_OPACITY, depthWrite: false }),
  );
  mesh.name = 'ShadowBackdrop';
  mesh.position.z = SHADOW_BACKDROP_Z;
  mesh.receiveShadow = true;
  mesh.visible = false;
  return mesh;
}
function placeContactShadow(box){
  if (!contactShadow) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const w = size.x * 1.02, h = size.y * 0.26;
  contactShadow.scale.set(w, h, 1);
  contactShadow.position.set(center.x, box.min.y - h * 0.16, box.min.z - 0.42);
  contactShadow.visible = true;
}

/* ---------- 模型 ---------- */
function installModel(gltf){
  body = gltf.scene;
  body.name = 'ConsoleB';
  body.scale.setScalar(MODEL_SCALE);
  rig.add(body);
  body.updateWorldMatrix(true, true);

  const required = ['Shell','SideBand','Bezel','Screen','Trim','Buttons','KeyWell_L','KeyWell_R','Screws','SubDisplay','BackKey'];
  const missing = required.filter(name => !body.getObjectByName(name));
  if (missing.length) throw new Error(`GLB 缺少节点：${missing.join(' / ')}`);

  const buttonsNode = body.getObjectByName('Buttons');
  if (!buttonsNode.visible) throw new Error('GLB 的 Buttons 节点不可见');
  const measuredZones = measureButtons(buttonsNode);
  // 拆成每键一组，给「按下的那颗键帽自己回弹」留出可独立位移的对象。
  keyGroups = splitKeyNode(buttonsNode, measuredZones, 'Buttons');
  // 副屏右侧那颗实体返回键：机顶屏「记牌 ↔ 出牌概率」的切换点。
  // 它不是 Buttons 连通块里的键，所以单独量一次几何，也单独拆一次。
  const backNode = body.getObjectByName('BackKey');
  const backBox = modelLocalBox(backNode);
  if (!backBox) throw new Error('BackKey 节点没有可量的几何');
  const backZone = ['bar-mode', {
    minX: backBox.min.x, maxX: backBox.max.x,
    minY: backBox.min.y, maxY: backBox.max.y, maxZ: backBox.max.z,
  }, ''];
  measuredZones.push(backZone);
  for (const [id, g] of splitKeyNode(backNode, [backZone], 'BackKey')) keyGroups.set(id, g);
  const screenNode = body.getObjectByName('Screen');
  const sb = nodeGeometryBoxLocal(screenNode, body);
  if (!sb) throw new Error('Screen 节点没有可量的几何');
  const size = sb.getSize(new THREE.Vector3());
  const center = sb.getCenter(new THREE.Vector3());
  const nextScreenGroup = new THREE.Group();
  nextScreenGroup.name = 'MachineScreen';
  nextScreenGroup.position.set(center.x, center.y, sb.max.z + 0.012);
  const nextScreenMesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), screenMat);
  nextScreenMesh.name = 'MachineScreenSurface';
  nextScreenGroup.add(nextScreenMesh);
  body.add(nextScreenGroup);
  nextScreenGroup.updateWorldMatrix(true, true);

  // 副屏照抄主屏：量玻璃面（SubDisplay_1）本身的盒子，平面贴到它的前沿。
  // 整组 SubDisplay 的最前面是凸边框（z=9.82），玻璃面只到 9.47；贴边框会浮出来。
  const subNode = body.getObjectByName('SubDisplay_1') || body.getObjectByName('SubDisplay');
  const subBox = subNode ? (subNode.isMesh ? nodeGeometryBoxLocal(subNode, body) : modelLocalBox(subNode)) : null;
  if (!subBox) throw new Error('SubDisplay 节点没有可量的几何');
  const subSize = subBox.getSize(new THREE.Vector3());
  const subCenter = subBox.getCenter(new THREE.Vector3());
  const nextSubGroup = new THREE.Group();
  nextSubGroup.name = 'MachineSubDisplay';
  nextSubGroup.position.set(subCenter.x, subCenter.y, subBox.max.z + 0.02);
  const nextSubMesh = new THREE.Mesh(new THREE.PlaneGeometry(subSize.x, subSize.y), subMat);
  nextSubMesh.name = 'MachineSubDisplaySurface';
  nextSubGroup.add(nextSubMesh);
  body.add(nextSubGroup);
  nextSubGroup.updateWorldMatrix(true, true);

  const bb = modelBox(body);
  const nextModelSize = bb.getSize(new THREE.Vector3());

  // 全部检查通过后才提交安装结果；失败态不能报告一组完整节点。
  nodes = required.map(name => body.getObjectByName(name).name);
  buttonsVisible = true;
  buttonZones = measuredZones;
  screenSize.set(size.x, size.y);
  screenCenter.copy(center);
  screenGroup = nextScreenGroup;
  screenMesh = nextScreenMesh;
  subGroup = nextSubGroup;
  subMesh = nextSubMesh;
  subFace = { w: subSize.x, h: subSize.y, z: nextSubGroup.position.z };
  modelSize = nextModelSize;
  placeContactShadow(bb);
  body.traverse(o => { if (o.isMesh) o.castShadow = true; });   // ADR-0006：机壳全件投影
  if (backdrop) backdrop.visible = true;
  ready = true; status = 'ready'; error = '';
  settle();
  resize(stageW, stageH);
  // installModel 时画布尺寸通常没变，resize 会提前返回；这里必须立即布局，
  // 否则 ready 后到入场动画结束前，屏与键热区都会短暂读成空。
  relayout();
  // 入场缩放只改变投影，不会重新 emit；结束时补一次 relayout，
  // 让座位标签/热区/机下托盘的贴合都用"落定后"的 rect，而不是动画中途的。
  armEntrance();
}
function settle(){
  const res = readyResolve; readyResolve = null;
  if (res) res(status);
}
function loadModel(){
  ready = false; status = 'loading'; error = '';
  entranceDone = true;   // 未就绪期间同样不该收缩放；装载后由入场动画自己改
  if (!readyResolve) readyPromise = new Promise(res => { readyResolve = res; });
  nodes = []; buttonsVisible = false; buttons = []; buttonZones = [];
  keyGroups = new Map(); pressKey = '';
  if (contactShadow) contactShadow.visible = false;
  if (backdrop) backdrop.visible = false;
  if (body && rig){ rig.remove(body); body = null; screenGroup = null; screenMesh = null;
    subGroup = null; subMesh = null; subFace = null; }
  emit();
  requestRender();
  new GLTFLoader().load(MODEL_URL.href, gltf => {
    try { installModel(gltf); }
    catch (err){ fail(err); }
  }, undefined, fail);
}
function fail(err){
  ready = false; status = 'error';
  error = err && err.message ? err.message : String(err || '未知错误');
  settle();
  emit();
  requestRender();
}
function failNoWebGL(err){
  status = 'no-webgl'; ready = false;
  error = '浏览器没有提供 WebGL，机身无法显示。启用 WebGL 后点重试；数据面板仍可查看。';
  settle();
  emit();
  if (window.console && console.warn) console.warn('WebGL 初始化失败', err);
}
export function retry(){
  if (status === 'no-webgl'){ location.reload(); return; }
  if (status === 'loading' || ready) return;   // 重试必须幂等，防止重复请求
  loadModel();
}

/* ---------- 生命周期与按需渲染 ---------- */
export function init(canvasEl, hook){
  canvas = canvasEl;
  stage = canvas.parentElement;
  overlayHook = hook;
  try {
    // alpha 画布：机身之外透出 DOM 桌面层（光池 / 浮尘），桌面不再被画布方块框住
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true,
      preserveDrawingBuffer: true });
  } catch (err){
    failNoWebGL(err);
    return false;
  }
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setClearAlpha(0);
  renderer.toneMapping = THREE.NoToneMapping;   // ADR-0004：与 /glb 一致，不套 ACES
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;   // ADR-0006：要的是软影，不是硬边

  scene = new THREE.Scene();   // 背景交给 DOM 桌面层，机身自己浮在桌面上
  camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 400);
  rig = new THREE.Group();
  rig.rotation.x = TILT;
  scene.add(rig);
  contactShadow = makeContactShadow();
  rig.add(contactShadow);
  // ADR-0006：接影面挂在 scene 上（不是 rig），它就是「机身背后的那面墙」——
  // 机身转动/缩放时墙不动，影子跟着几何重算，这才是投影该有的样子。
  backdrop = makeShadowBackdrop();
  scene.add(backdrop);
  // ADR-0004/0006：沿用 /glb 的三盏基础灯，不开环境贴图、不加 rim 光、灯光参数一个不动；
  // key 灯兼职投影灯 —— castShadow 只多渲一遍深度图，不改它对材质的贡献。
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-4, 6, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const shadowCam = key.shadow.camera;
  shadowCam.left = -SHADOW_SPAN; shadowCam.right = SHADOW_SPAN;
  shadowCam.top = SHADOW_SPAN; shadowCam.bottom = -SHADOW_SPAN;
  shadowCam.near = 0.5; shadowCam.far = 40;
  shadowCam.updateProjectionMatrix();
  key.shadow.bias = 0;                 // VSM 不吃 bias，留 0 防重影
  key.shadow.radius = SHADOW_RADIUS;
  key.shadow.blurSamples = SHADOW_BLUR_SAMPLES;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5); fill.position.set(6, 2, 6); scene.add(fill);

  tableScene = new THREE.Scene();
  tableScene.background = new THREE.Color('#3a2b40');  // 屏内四角露出的梅色底
  tableCam = new THREE.PerspectiveCamera(33, screenSize.x / screenSize.y, 0.1, 200);
  tableCam.position.set(0, 12.4, 8.2);
  tableCam.lookAt(0, 0, 1.70);
  tableScene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const tkey = new THREE.DirectionalLight(0xffffff, 1.5); tkey.position.set(-4, 9, 7); tableScene.add(tkey);
  const tfill = new THREE.DirectionalLight(0xcfe0ff, 0.5); tfill.position.set(6, 4, 5); tableScene.add(tfill);
  buildTable();
  cardGroup = new THREE.Group();
  tableScene.add(cardGroup);
  edgeMat = new THREE.MeshBasicMaterial({ color: cssVar('--ink'), depthTest: false });
  backMat = new THREE.MeshBasicMaterial({ map: backTexture(), depthTest: false });
  shadowMat = new THREE.MeshBasicMaterial({ color: '#17141a', side: THREE.DoubleSide, depthTest: false });
  shadowGeo = new THREE.PlaneGeometry(CARD_W + 0.05, CARD_H + 0.05);
  cardGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T);
  hitGeo = new THREE.PlaneGeometry(CARD_W * 1.02, CARD_H * 1.02);
  hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  screenMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  rt = new THREE.WebGLRenderTarget(512, 256, { depthBuffer: true, samples: 4 });
  // 屏内是"能读的牌桌"：线性过滤，尺寸在 relayout 里按真屏像素 1:1 跟随
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  screenMat.map = rt.texture;
  // 副屏纹理：分辨率按玻璃面长宽比固定，不随视口重画；颜色走 sRGB，与页面底色一致。
  subCanvas = document.createElement('canvas');
  subCanvas.width = SUB_TEX.w; subCanvas.height = SUB_TEX.h;
  subTex = new THREE.CanvasTexture(subCanvas);
  subTex.colorSpace = THREE.SRGBColorSpace;
  subTex.magFilter = THREE.LinearFilter;
  subTex.minFilter = THREE.LinearFilter;
  subTex.generateMipmaps = false;
  subMat = new THREE.MeshBasicMaterial({ map: subTex, toneMapped: false });
  // 主屏 HUD：正交相机 + 一张铺满视口的透明平面，叠在牌桌画面之上，画进同一个 RenderTarget。
  hudCanvas = document.createElement('canvas');
  hudCanvas.width = HUD_TEX.w; hudCanvas.height = HUD_TEX.h;
  hudTex = new THREE.CanvasTexture(hudCanvas);
  hudTex.colorSpace = THREE.SRGBColorSpace;
  hudTex.magFilter = THREE.LinearFilter;
  hudTex.minFilter = THREE.LinearFilter;
  hudTex.generateMipmaps = false;
  hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  hudScene = new THREE.Scene();
  const hudPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  hudPlane.position.z = -0.5;   // 正交相机 near=0，贴在 z=0 上正好落在近平面
  hudScene.add(hudPlane);

  started = true;
  resize(stage.clientWidth || window.innerWidth, stage.clientHeight || 400);
  if (typeof ResizeObserver === 'function'){
    new ResizeObserver(() => resize(stage.clientWidth, stage.clientHeight)).observe(stage);
  } else {
    addEventListener('resize', () => resize(stage.clientWidth, stage.clientHeight));
  }
  capParallax();
  loadModel();
  return true;
}
function requestRender(){
  dirty = true;
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(renderNow);
}
function renderNow(){
  renderQueued = false;
  if (!dirty || !renderer) return;
  dirty = false;
  if (ready && rt && tableScene && tableCam && screenMat){
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(tableScene, tableCam);
    // 座位徽章叠在牌桌之上，但同样落在屏的纹理里：不清屏，续画一遍 HUD。
    if (hudScene){
      renderer.autoClear = false;
      renderer.render(hudScene, hudCam);
      renderer.autoClear = true;
    }
    renderer.setRenderTarget(null);
  }
  renderer.render(scene, camera);
  frameCount++;
  if (dirty) requestRender();
}
function capParallax(){
  if (reduce) return;
  stage.addEventListener('mousemove', e => {
    if (stageW < 820) return;
    const r = stage.getBoundingClientRect();
    pointerTarget.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    pointerTarget.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    animateParallax();
  });
  stage.addEventListener('mouseleave', () => {
    pointerTarget.x = pointerTarget.y = 0;
    animateParallax();
  });
}

/* ---------- 机身拖拽旋转 + 弹簧回弹 ---------- */
function applyRigPose(){
  // 视差平移 + 拖拽旋转 + 缩放；保留原 TILT 作为基准
  // 按键冲量：机身被按下去一点、轻微后仰，松手弹回（pressKick 是 0→1→0 的脉冲）
  const kick = pressKick;
  // 机身只跟着轻轻一顿：真正的"按下去了"由键帽自己的行程给，机子不用大幅回弹。
  rig.position.set(view.x + panX, view.y + panY - kick * 0.012, -kick * 0.015);
  const baseTilt = isNarrow() ? 0 : TILT;
  rig.rotation.x = baseTilt + dragTilt + kick * 0.006;
  rig.rotation.y = dragYaw;
  rig.scale.setScalar(rigZoom);
}
/* 按一次键：那颗键帽自己往 -Z 沉下去再带一次过冲弹回来，机身只跟着轻轻一顿。
   pressFeedback(id) 收的是热区 id（= 热区按钮的 id），不传就只做机身那一顿。 */
let pressKick = 0, pressRunning = false, pressStart = 0, pressKey = '';
// 键帽能看到的行程只有 0.4mm：模型里键帽正面只比它周围那圈键沿（keyEdgeMat）高出
// 0.40mm，再往下沉就整个躲到键沿后面去了（1.8mm 时键帽整片消失，看着像键没了）。
// 所以压到「快齐平」为止 —— 键沿不动、键帽自己沉下去再带一次过冲弹回来，就是按压感。
const KEY_TRAVEL = 0.32;     // 键帽下压行程（模型 mm，约键沿高度的 80%）
const KEY_PRESS_MS = 220;
export function pressFeedback(id = ''){
  if (reduce || !renderer) return;
  pressStart = performance.now();
  // 上一颗还没回位就又按了另一颗：先把旧键复位，免得两颗一起卡在下面
  if (pressKey && pressKey !== id && keyGroups.has(pressKey)){
    const prev = keyGroups.get(pressKey); prev.face.position.z = 0; prev.face.position.x = 0;
  }
  pressKey = (id && keyGroups.has(id)) ? id : '';
  if (pressRunning) return;
  pressRunning = true;
  requestAnimationFrame(stepPress);
}
// 键帽行程曲线：前 30% 快下，之后是带一次过冲的弹簧回位 ——"按下去"和"弹回来"都看得见
function keyTravel(t){
  if (t < 0.3){ const u = t / 0.3; return 1 - Math.pow(1 - u, 3); }
  const u = (t - 0.3) / 0.7;
  return Math.cos(Math.PI * 2.2 * u) * Math.exp(-4.2 * u);
}
function stepPress(now){
  const t = Math.min(1, (now - pressStart) / KEY_PRESS_MS);
  // 0→1→0 的单峰 + 尾部一次轻微回弹过冲（幅度已被 applyRigPose 压到很小）
  pressKick = Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.22 * Math.sin(Math.PI * 2 * t));
  const g = keyGroups.get(pressKey);
  if (g) g.face.position.z = -KEY_TRAVEL * keyTravel(t);
  applyRigPose(); relayout(); requestRender();
  if (t >= 1){
    pressKick = 0; pressRunning = false;
    if (g) g.face.position.z = 0;
    pressKey = '';
    applyRigPose(); relayout(); requestRender();
    return;
  }
  requestAnimationFrame(stepPress);
}
/* 灰键被按：也要有回应，但语义是"按不动"，不是"按下了" —— 键帽原地左右轻摇两下
   （**不下沉**）+ 机身轻轻一顿。下沉表示"记下了这一手"，灰键什么都没记下，
   拿同一套下沉动画去回它就把"禁用"讲成了"成功"。 */
let rejectRunning = false, rejectStart = 0, rejectKey = '';
const REJECT_MS = 280;
export function rejectFeedback(id = ''){
  if (reduce || !renderer) return;
  rejectStart = performance.now();
  if (rejectKey && rejectKey !== id && keyGroups.has(rejectKey)){
    const prev = keyGroups.get(rejectKey);
    prev.face.position.x = 0; prev.face.position.z = 0;
  }
  rejectKey = (id && keyGroups.has(id)) ? id : '';
  if (rejectRunning) return;
  rejectRunning = true;
  requestAnimationFrame(stepReject);
}
function stepReject(now){
  const t = Math.min(1, (now - rejectStart) / REJECT_MS);
  pressKick = Math.sin(Math.PI * t) * 0.35;                 // 机身只有正常按压约三分之一
  const g = keyGroups.get(rejectKey);
  if (g){ g.face.position.x = Math.sin(Math.PI * 6 * t) * (1 - t) * 0.9; g.face.position.z = 0; }
  applyRigPose(); relayout(); requestRender();
  if (t >= 1){
    pressKick = 0; rejectRunning = false;
    if (g){ g.face.position.x = 0; g.face.position.z = 0; }
    rejectKey = '';
    applyRigPose(); relayout(); requestRender();
    return;
  }
  requestAnimationFrame(stepReject);
}
// 灰键：把这组键帽换成同款但压暗的材质（只压暗、不改模型材质响应），旋转时跟着
// 键帽一起转，不像 DOM 覆盖层那样飘在键面外面。
export function setKeyDisabled(id, disabled){
  const g = keyGroups.get(id);
  if (!g) return;
  let changed = false;
  g.root.traverse(m => {
    if (!m.isMesh) return;
    if (!m.userData.baseMat) m.userData.baseMat = m.material;
    if (disabled){
      if (!m.userData.dimMat){
        const dim = m.userData.baseMat.clone();
        dim.color.multiplyScalar(0.42);
        m.userData.dimMat = dim;
      }
      if (m.material !== m.userData.dimMat){ m.material = m.userData.dimMat; changed = true; }
    } else if (m.material !== m.userData.baseMat){
      m.material = m.userData.baseMat; changed = true;
    }
  });
  if (changed) requestRender();
}
export function startDrag(clientX, clientY){
  if (!ready) return;
  isDraggingRig = true;
  dragSpringRunning = false;
  dragStartX = clientX; dragStartY = clientY;
  dragFromYaw = dragYaw; dragFromTilt = dragTilt;
  document.body.classList.add('is-dragging');
}
export function moveDrag(clientX, clientY){
  if (!isDraggingRig) return;
  const dx = clientX - dragStartX;
  const dy = clientY - dragStartY;
  const r = stage.getBoundingClientRect();
  // 拖满屏宽 ≈ 转 90°
  dragYaw = dragFromYaw + (dx / r.width) * Math.PI * 0.9;
  dragTilt = dragFromTilt + (dy / r.height) * 0.4;
  // 限制俯仰范围
  dragTilt = Math.max(-0.5, Math.min(0.5, dragTilt));
  applyRigPose();
  relayout();
  requestRender();
}
export function endDrag(){
  if (!isDraggingRig) return;
  isDraggingRig = false;
  document.body.classList.remove('is-dragging');
  // 弹簧回弹到默认角度（dragYaw=0, dragTilt=0）
  startDragSpring();
  animateParallax();
}
function startDragSpring(){
  if (Math.abs(dragYaw) < 0.001 && Math.abs(dragTilt) < 0.001) return;
  dragSpringRunning = true;
  dragSpringFrom = dragYaw;
  dragSpringFromTilt = dragTilt;
  dragSpringStart = performance.now();
  requestAnimationFrame(stepDragSpring);
}
let dragSpringFromTilt = 0;
function stepDragSpring(now){
  if (!dragSpringRunning) return;
  const t = Math.min(1, (now - dragSpringStart) / 900);
  // 阻尼弹簧：过冲 + 回弹
  const s = springOut(t);
  dragYaw = dragSpringFrom * (1 - s);
  dragTilt = dragSpringFromTilt * (1 - s);
  applyRigPose();
  relayout();
  requestRender();
  if (t >= 1){
    dragSpringRunning = false;
    dragYaw = 0; dragTilt = 0;
    applyRigPose();
    relayout();
    requestRender();
    return;
  }
  requestAnimationFrame(stepDragSpring);
}
/* ---------- 空白背景拖拽平移 + 弹簧回弹 ---------- */
// 视差只让机身轻轻跟鼠标；平移是用户主动把机身推走，松手要回到原位。
export function startPan(clientX, clientY){
  if (!ready) return;
  panDragging = true;
  panSpringRunning = false;
  panStartX = clientX; panStartY = clientY;
  panFromX = panX; panFromY = panY;
  document.body.classList.add('is-panning');
}
export function movePan(clientX, clientY){
  if (!panDragging) return;
  // 屏幕上是 1:1：拖多少像素机身就走多少像素（俯仰把竖直方向拉回一点）。
  // 不做范围夹取：机身跟手，可以一直拖到视口外，松手由弹簧送回原位。
  const dx = clientX - panStartX, dy = clientY - panStartY;
  panX = panFromX + dx * panScale;
  // 世界 y 向上、屏幕 y 向下：往下拖要往上减，机身才会跟着手走而不是反着跑。
  panY = panFromY - dy * panScale / Math.cos(TILT);
  applyRigPose(); relayout(); requestRender();
}
export function endPan(){
  if (!panDragging) return;
  panDragging = false;
  document.body.classList.remove('is-panning');
  startPanSpring();
  animateParallax();
}
export function resetPan(){
  panSpringRunning = false;
  if (panX === 0 && panY === 0) return;
  panX = 0; panY = 0;
  applyRigPose(); relayout(); requestRender();
}
function startPanSpring(){
  if (Math.abs(panX) < 0.0005 && Math.abs(panY) < 0.0005){
    panX = 0; panY = 0;
    applyRigPose(); relayout(); requestRender();
    return;
  }
  panSpringRunning = true;
  panFromX = panX; panFromY = panY;
  panSpringStart = performance.now();
  requestAnimationFrame(stepPanSpring);
}
function stepPanSpring(now){
  if (!panSpringRunning) return;
  const t = Math.min(1, (now - panSpringStart) / 900);
  const s = springOut(t);
  panX = panFromX * (1 - s);
  panY = panFromY * (1 - s);
  applyRigPose(); relayout(); requestRender();
  if (t >= 1){
    panSpringRunning = false;
    panX = 0; panY = 0;
    applyRigPose(); relayout(); requestRender();
    return;
  }
  requestAnimationFrame(stepPanSpring);
}

// 滚轮缩放
export function zoomBy(delta){
  if (!ready || !entranceDone) return;   // 加载/入场期间不抢 rig.scale
  rigZoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rigZoomTarget - delta * ZOOM_STEP));
  startZoomGlide();
}
export function zoomReset(){
  if (!ready || !entranceDone) return;
  rigZoomTarget = 1;
  resetPan();
  startZoomGlide();
}
export function getZoom(){ return rigZoom; }
// 指数逼近（时间常数 ~140ms）：中途改目标只挪终点，值保持连续 —— 连续滚动
// 因此单调跟手、不回跳；到上下限后 target 不动，一帧就收敛，不抖不出帧。
const ZOOM_TAU = 140;
function startZoomGlide(){
  if (Math.abs(rigZoom - rigZoomTarget) < 0.001){
    rigZoom = rigZoomTarget;
    applyRigPose(); relayout(); requestRender();
    return;
  }
  if (zoomSpringRunning){ zoomSpringStart = performance.now(); return; }  // 已在滑：只改目标
  zoomSpringRunning = true;
  zoomSpringStart = performance.now();
  requestAnimationFrame(stepZoomGlide);
}
function stepZoomGlide(now){
  if (!zoomSpringRunning) return;
  const dt = Math.max(1, now - zoomSpringStart);
  zoomSpringStart = now;
  const k = 1 - Math.exp(-dt / ZOOM_TAU);
  rigZoom += (rigZoomTarget - rigZoom) * k;
  applyRigPose();
  relayout();
  requestRender();
  if (Math.abs(rigZoomTarget - rigZoom) < 0.001){
    zoomSpringRunning = false;
    rigZoom = rigZoomTarget;
    applyRigPose();
    relayout();
    requestRender();
    return;
  }
  requestAnimationFrame(stepZoomGlide);
}

function springOut(t){
  // 近似 cubic-bezier(0.34, 1.56, 0.64, 1)
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function animateParallax(){
  if (isNarrow()) return;
  // 拖动旋转 / 拖空白平移期间冻结视差：视差弹簧每帧都会 applyRigPose + relayout，
  // 和拖动弹簧抢同一帧的姿态写入，是拖动中抖动的主因。松手后由 end* 重新启动。
  if (isDraggingRig || panDragging) return;
  const tx = -pointerTarget.x * 0.16, ty = pointerTarget.y * 0.10;
  if (parallaxRunning){
    if (Math.abs(tx - parallaxTo.x) > 0.001 || Math.abs(ty - parallaxTo.y) > 0.001){
      parallaxFrom.x = view.x; parallaxFrom.y = view.y;
      parallaxTo.x = tx; parallaxTo.y = ty;
      parallaxStart = performance.now();
    }
    return;
  }
  parallaxRunning = true;
  parallaxFrom.x = view.x; parallaxFrom.y = view.y;
  parallaxTo.x = tx; parallaxTo.y = ty;
  parallaxStart = performance.now();
  requestAnimationFrame(stepParallax);
}
function stepParallax(now){
  if (!parallaxRunning) return;
  if (isDraggingRig || panDragging){ parallaxRunning = false; return; }
  const t = Math.min(1, (now - parallaxStart) / 220);
  const e = 1 - Math.pow(1 - t, 3);
  view.x = parallaxFrom.x + (parallaxTo.x - parallaxFrom.x) * e;
  view.y = parallaxFrom.y + (parallaxTo.y - parallaxFrom.y) * e;
  applyRigPose();
  relayout();
  if (t >= 1){
    parallaxRunning = false;
    return;
  }
  requestAnimationFrame(stepParallax);
}

/* ---------- 牌桌状态 / 拾取 ---------- */
export function apply(snapshot, meta){
  if (!started) return;
  lastSnap = snapshot; lastMeta = meta;
  drawCards();
  relayout();
  requestRender();
}
export function pickCardAt(px, py){
  const s = screenPx;
  if (!ready || !s || !handMeshes.length) return null;
  // 手牌扇面会略微探出屏幕投影rect的下沿（贴近下边框渲染），
  // 边界判断留一点余量，否则最外侧牌的落点会被挡在拾取区外。
  const M = 12;
  if (px < s.x - M || px > s.x + s.w + M || py < s.y - M || py > s.y + s.h + M) return null;
  ndc.set(((px - s.x) / s.w) * 2 - 1, -(((py - s.y) / s.h) * 2 - 1));
  raycaster.setFromCamera(ndc, tableCam);
  // 手牌叠扇按 renderOrder 决定谁压谁（右压左），与相机距离无关；
  // 拾取必须取 renderOrder 最大的命中，否则重叠带会点中下层牌。
  let best = null;
  for (const hit of raycaster.intersectObjects(handHits, false)){
    if (!best || hit.object.renderOrder > best.object.renderOrder) best = hit;
  }
  return best ? best.object.userData.handIndex : null;
}
export function setSelected(indices){
  // 抬哪几张按「手牌下标」定，不再按点数。同点数的牌要能各自反转，
  // 按点数记的话滑过三张 5 只抬得起第一张。
  const on = new Set(indices || []);
  const ordered = handMeshes.slice().sort((a, b) => a.userData.handIndex - b.userData.handIndex);
  for (const m of ordered){
    const base = m.userData.baseY;
    m.position.y = on.has(m.userData.handIndex) ? base + 0.46 : base;
  }
  requestRender();
}
export function handPoints(){
  if (!ready || !handHits.length) return [];
  rig.updateMatrixWorld(true);
  tableScene.updateMatrixWorld(true);
  return handHits.map(hit => {
    const v = hit.position.clone();
    const shift = hit.userData.visibleShift;
    if (shift) v.add(tmp.set(shift, 0, 0).applyQuaternion(hit.quaternion));
    cardGroup.localToWorld(v);
    const n = v.project(tableCam);
    return { i: hit.userData.handIndex,
             ...projectScreenLocal(n.x * screenSize.x / 2, n.y * screenSize.y / 2) };
  }).sort((a, b) => a.i - b.i);
}
/** 机身正面投影矩形（stage 坐标系 CSS px）—— 随拖动/缩放实时变化。 */
function bodyRect(){
  if (!ready || !body || !camera) return null;
  camera.updateMatrixWorld(true);
  body.updateWorldMatrix(true, true);
  return projectFrontBox(modelBox(body));
}

/** 指针（视口坐标）是否落在机身本体上。拖动机身才旋转；屏幕和机身外空场不接管。 */
export function isOnBody(clientX, clientY){
  const t = bodyRect();
  if (!t || !stage) return false;
  const r = stage.getBoundingClientRect();
  const x = clientX - r.left, y = clientY - r.top;
  return x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h;
}

const TONE_MAPPING_NAMES = ['None', 'Linear', 'Reinhard', 'Cineon', 'ACESFilmic'];
const SHADOW_TYPE_NAMES = ['Basic', 'PCF', 'PCFSoft', 'VSM'];
export function machineStatus(){
  // ADR-0004：验收要能直接读到环境贴图、色调映射、曝光和三盏灯的参数。
  const lights = [];
  if (scene) scene.traverse(o => {
    if (!o.isLight) return;
    lights.push({ type: o.type, color: '#' + o.color.getHexString(), intensity: o.intensity,
                  position: [o.position.x, o.position.y, o.position.z] });
  });
  const tablet = bodyRect();
  // ADR-0006：验收要能直接读到投影层 —— 阴影贴图开关、投影灯、接影面、机身里开了投影的 mesh 数。
  let shadowCasters = 0;
  if (body) body.traverse(o => { if (o.isMesh && o.castShadow) shadowCasters++; });
  return {
    source: 'glb', status, ready, error, nodes, buttonsVisible,
    entranceDone, entranceStartedAt,          // 入场有没有播、什么时候开始（ADR-0011 验收用）
    environment: !!(scene && scene.environment),
    toneMapping: renderer ? renderer.toneMapping : null,
    toneMappingName: renderer
      ? (TONE_MAPPING_NAMES[renderer.toneMapping] ?? String(renderer.toneMapping)) : null,
    toneMappingExposure: renderer ? renderer.toneMappingExposure : null,
    lights,
    contactShadow: !!(contactShadow && contactShadow.visible),
    shadow: renderer ? {
      mapEnabled: !!renderer.shadowMap.enabled,
      mapType: renderer.shadowMap.type,
      mapTypeName: SHADOW_TYPE_NAMES[renderer.shadowMap.type] ?? String(renderer.shadowMap.type),
      caster: 'key',                       // 兼职投影的那盏 key 灯
      backdrop: !!(backdrop && backdrop.visible),
      map: SHADOW_MAP, span: SHADOW_SPAN, z: SHADOW_BACKDROP_Z,
      opacity: SHADOW_OPACITY, radius: SHADOW_RADIUS, blurSamples: SHADOW_BLUR_SAMPLES,
      // 机身上真正开了 castShadow 的 mesh 数：0 就说明影子根本没东西可投
      casters: shadowCasters,
    } : { mapEnabled: false, backdrop: false, casters: 0 },
    subDisplay: (subMesh && subFace) ? {
      ready: true,
      w: subFace.w, h: subFace.h, z: subFace.z,
      side: subMesh.material.side === THREE.FrontSide ? 'front'
        : subMesh.material.side === THREE.BackSide ? 'back' : 'double',
      depthTest: subMesh.material.depthTest,
      depthWrite: subMesh.material.depthWrite,
      texture: { w: subCanvas.width, h: subCanvas.height },
    } : { ready: false },
    // 主屏 HUD：座位徽章画在屏的纹理里（与副屏同一个做法），DOM 那层只留锚点。
    mainHud: hudCanvas ? {
      ready: ready && !!screenMesh,
      texture: { w: hudCanvas.width, h: hudCanvas.height },
    } : { ready: false },
    tablet,
    screen: screenPx, screenSize: { w: screenSize.x, h: screenSize.y },
    buttons: buttons.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
    // 按键反馈：验收要能直接读到"哪颗键在动、键帽沉了多少、机身顿了多少"
    press: { key: pressKey, kick: pressKick,
             travel: keyGroups.get(pressKey) ? keyGroups.get(pressKey).face.position.z : 0,
             reject: { key: rejectKey, running: rejectRunning },
             count: keyGroups.size, keys: [...keyGroups.keys()] },
    handRows,
  };
}
/* ---------- 副屏画布（板层往里画，画完 commit 一次） ---------- */
export function subDisplayCanvas(){ return subCanvas; }
export function commitSubDisplay(){
  if (subTex) subTex.needsUpdate = true;
  requestRender();
}
// 画布上非背景像素的比例：给验收一个"确实画了东西"的硬指标。
// 单独导出：getImageData 是全量回读，不能挂在 300ms 轮询的 machineStatus 上。
export function subDisplayInk(){
  if (!subCanvas) return 0;
  const g = subCanvas.getContext('2d');
  const d = g.getImageData(0, 0, subCanvas.width, subCanvas.height).data;
  const bg = [d[0], d[1], d[2]];
  let n = 0;
  for (let i = 0; i < d.length; i += 4){
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
  }
  return n / (d.length / 4);
}
/* ---------- 主屏 HUD 画布（板层往里画座位徽章，画完 commit 一次） ---------- */
export function mainHudCanvas(){ return hudCanvas; }
export function commitMainHud(){
  if (hudTex) hudTex.needsUpdate = true;
  requestRender();
}
// 画布上有多少非透明像素：给验收一个"徽章确实画进屏里了"的硬指标。
// 单独导出，理由同 subDisplayInk。
export function mainHudInk(){
  if (!hudCanvas) return 0;
  const g = hudCanvas.getContext('2d');
  const d = g.getImageData(0, 0, hudCanvas.width, hudCanvas.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 16) n++;
  return n / (d.length / 4);
}
export function frameStats(){
  return { frameCount, dpr };
}
