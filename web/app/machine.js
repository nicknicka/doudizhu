// 模型壳子与真屏：three.js 只负责机身、离屏牌桌、投影、拾取和按需渲染。
// 文字、数字和控件全部留在 HTML；按键外观来自 GLB，可点性由 HTML 热区提供。

import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { reduce } from './state.js';
import { NAME } from './labels.js';

const MODEL_URL = new URL('../assets/console-b.glb', import.meta.url);
const MODEL_SCALE = 1 / 20;                 // 建模单位是 mm；20mm = 1 three.js 单位
const FOV = 30;
const TILT = -0.055;

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
let tableScene, tableCam, rt;
let cardGroup, anchors = {}, frontMats = {}, backMat, edgeMat, shadowMat, shadowGeo, cardGeo;
let handMeshes = [], handHits = [], handRows = [], hitGeo, hitMat;
let screenSize = new THREE.Vector2(0.001, 0.001), screenPx = null;
let buttons = [], buttonZones = [], modelSize = new THREE.Vector3(10, 4.2, 1.0);
let screenCenter = new THREE.Vector3();
let stageW = 0, stageH = 0, dpr = 1, observedW = 0, observedH = 0;
let lastSnap = null, lastMeta = null, narrowHand = false, tinyHand = false;
let pointerTarget = { x: 0, y: 0 }, view = { x: 0, y: 0 };
let parallaxRunning = false, parallaxStart = 0;
let dragYaw = 0, dragTilt = 0, dragFromYaw = 0, dragFromTilt = 0;
let dragStartX = 0, dragStartY = 0, isDraggingRig = false, dragSpringRunning = false;
let rigZoom = 1, rigZoomTarget = 1, zoomSpringRunning = false, zoomSpringFrom = 1;
// 拖空白背景的平移偏移（rig 单位），和视差 view 叠加，松手弹回 0
let panX = 0, panY = 0, panScale = 0.01;
let panDragging = false, panSpringRunning = false;
let panStartX = 0, panStartY = 0, panFromX = 0, panFromY = 0, panSpringStart = 0;
const ZOOM_MIN = 0.75, ZOOM_MAX = 1.6, ZOOM_STEP = 0.12;
let dragSpringFrom = 0, dragSpringStart = 0;
let parallaxFrom = { x: 0, y: 0 }, parallaxTo = { x: 0, y: 0 };
let started = false, ready = false, status = 'idle', error = '';
let nodes = [], buttonsVisible = false, contactShadow = null;
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
function faceTexture(rank){
  const c = makeCanvas(52, 74), g = c.getContext('2d');
  // 参考图质感：贴纸白 + 硬黑描边 + 切角 + 角上红点
  g.fillStyle = '#201a26'; g.fillRect(0, 0, 52, 74);          // 切角露出的桌色
  g.fillStyle = '#fbfaf6';
  g.beginPath();
  g.moveTo(0, 6); g.lineTo(6, 0); g.lineTo(46, 0); g.lineTo(52, 6);
  g.lineTo(52, 68); g.lineTo(46, 74); g.lineTo(6, 74); g.lineTo(0, 68);
  g.closePath(); g.fill();
  g.strokeStyle = cssVar('--ink'); g.lineWidth = 2; g.stroke();
  // 手牌叠扇后只露出左侧约半张牌。点数必须落在这条可见带里，
  // 并且把 10 缩成两字符宽、王缩成小/大，避免只露出半个字。
  const label = { T: '10', B: '小', R: '大' }[rank] || NAME[rank] || rank;
  g.fillStyle = cssVar('--ink');
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.font = `${label.length > 1 ? 19 : 26}px Pixel, monospace`;
  g.fillText(label, 3, 2);
  if (rank !== 'B' && rank !== 'R'){
    g.textAlign = 'center'; g.font = '26px Pixel, monospace';
    g.fillText('♠', 28, 40);
    g.textAlign = 'left';
  }
  g.fillStyle = cssVar('--accent');
  g.fillRect(45, 5, 3, 3); g.fillRect(4, 66, 3, 3);
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
function cardMesh(rank, faceUp){
  const mats = faceUp
    ? [edgeMat, edgeMat, edgeMat, edgeMat,
       frontMats[rank] || (frontMats[rank] = new THREE.MeshBasicMaterial({ map: faceTexture(rank), depthTest: false })),
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
function layRow(ranks, x, z, faceUp, tilt, spacing, scale = 1, track = false,
                offset = 0, fan = 0, yaw = 0, arc = 0, surf = 0.18, order = 0){
  const n = ranks.length;
  if (!n) return;
  const mid = (n - 1) / 2, rowHits = [];
  ranks.forEach((rank, i) => {
    const off = i - mid;
    const roll = fan * off;
    let lift = surf + (CARD_H * scale / 2) * Math.cos(tilt) + 0.02 - arc * off * off;
    let px = x + off * spacing, pz = z + i * 0.03 + arc * off * off * 1.9;
    if (track){
      const c = clampHandCenter(px, lift, pz);
      if (c){ px = c.x; lift = c.y; pz = c.z; }
    }
    const m = cardMesh(rank, faceUp);
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
  Object.keys(lastMeta.seats).forEach(player => {
    const rel = lastMeta.seats[player].relative;
    const place = SEAT_3D[rel] || SEAT_3D.down;
    if (rel === 'me'){
      const hand = lastSnap.my_hand || [];
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
      layRow(Array(back).fill('T'), place.x, place.z, false, BACK_TILT, 0.17,
             1.25, false, 0, dir * 0.06, -dir * 0.55, 0, 0.32, 100);
    }
    anchors[player] = new THREE.Vector3(place.x, 0.06, place.labelZ);
  });
  const trick = lastSnap.last_move || [];
  const trickScale = tinyHand ? 2.10 : (narrowHand ? 1.30 : 1.42);
  const cardW = CARD_W * trickScale;
  const want = 0.86 * trickScale;
  const fit = trick.length > 1 ? 13.0 / (trick.length - 1) : want;
  const trickGap = Math.max(cardW * 0.46, Math.min(want, fit));
  layRow(trick, 0, tinyHand ? -1.10 : (narrowHand ? 0.55 : 0.95),
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
function projectPoint(x, y, z){
  tmp.set(x, y, z).project(camera);
  return { x: (tmp.x * 0.5 + 0.5) * stageW, y: (-tmp.y * 0.5 + 0.5) * stageH };
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
  const topNode = body.getObjectByName('SubDisplay');
  const topBox = topNode ? modelLocalBox(topNode) : null;
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
    if (rt.width !== rtW || rt.height !== rtH) rt.setSize(rtW, rtH);
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
  });
}
function resize(w, h){
  if (!renderer || !w || !h) return;
  if (w === observedW && h === observedH) return;
  observedW = w; observedH = h;
  stageW = w; stageH = h;
  camera.aspect = w / h;
  rig.rotation.x = isNarrow() ? 0 : TILT;
  const fitH = Math.max(modelSize.y * 1.18, modelSize.x * 1.10 / camera.aspect);
  const dist = (fitH / 2) / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  panScale = fitH / h;                   // z=0 平面上 1 CSS px 对应的世界单位
  camera.position.set(0, 0.05, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
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
  // 副屏右侧那颗实体返回键：机顶屏「记牌 ↔ 出牌概率」的切换点。
  // 它不是 Buttons 连通块里的键，所以单独量一次几何。
  const backBox = modelLocalBox(body.getObjectByName('BackKey'));
  if (!backBox) throw new Error('BackKey 节点没有可量的几何');
  measuredZones.push(['bar-mode', {
    minX: backBox.min.x, maxX: backBox.max.x,
    minY: backBox.min.y, maxY: backBox.max.y, maxZ: backBox.max.z,
  }, '']);
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
  modelSize = nextModelSize;
  placeContactShadow(bb);
  ready = true; status = 'ready'; error = '';
  resize(stageW, stageH);
  // installModel 时画布尺寸通常没变，resize 会提前返回；这里必须立即布局，
  // 否则 ready 后到入场动画结束前，屏与键热区都会短暂读成空。
  relayout();
  if (!reduce && window.gsap){
    // 入场缩放只改变投影，不会重新 emit；结束时补一次 relayout，
    // 让座位标签/热区/机下托盘的贴合都用"落定后"的 rect，而不是动画中途的。
    gsap.from(rig.scale, { x: 0.94, y: 0.94, z: 0.94, duration: 0.8,
      ease: 'power2.out', onUpdate: requestRender, onComplete: relayout });
  }
}
function loadModel(){
  ready = false; status = 'loading'; error = '';
  nodes = []; buttonsVisible = false; buttons = []; buttonZones = [];
  if (contactShadow) contactShadow.visible = false;
  if (body && rig){ rig.remove(body); body = null; screenGroup = null; screenMesh = null; }
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
  emit();
  requestRender();
}
function failNoWebGL(err){
  status = 'no-webgl'; ready = false;
  error = '浏览器没有提供 WebGL，机身无法显示。启用 WebGL 后点重试；数据面板仍可查看。';
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
  renderer.shadowMap.enabled = false;

  scene = new THREE.Scene();   // 背景交给 DOM 桌面层，机身自己浮在桌面上
  camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 400);
  rig = new THREE.Group();
  rig.rotation.x = TILT;
  scene.add(rig);
  contactShadow = makeContactShadow();
  rig.add(contactShadow);
  // ADR-0004：沿用 /glb 的三盏基础灯，不开环境贴图、不加 rim 光。
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-4, 6, 8); scene.add(key);
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
  rig.position.set(view.x + panX, view.y + panY - kick * 0.045, -kick * 0.06);
  const baseTilt = isNarrow() ? 0 : TILT;
  rig.rotation.x = baseTilt + dragTilt + kick * 0.02;
  rig.rotation.y = dragYaw;
  rig.scale.setScalar(rigZoom);
}
/* 按一次键：整机往后沉一下再弹回，和键帽的下压描边一起构成"真机器"的手感 */
let pressKick = 0, pressRunning = false, pressStart = 0;
export function pressFeedback(){
  if (reduce || !renderer) return;
  pressStart = performance.now();
  if (pressRunning) return;
  pressRunning = true;
  requestAnimationFrame(stepPress);
}
function stepPress(now){
  const t = Math.min(1, (now - pressStart) / 200);
  // 0→1→0 的单峰 + 尾部一次轻微回弹过冲
  pressKick = Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.22 * Math.sin(Math.PI * 2 * t));
  applyRigPose(); relayout(); requestRender();
  if (t >= 1){
    pressKick = 0; pressRunning = false;
    applyRigPose(); relayout(); requestRender();
    return;
  }
  requestAnimationFrame(stepPress);
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
  const r = stage.getBoundingClientRect();
  // 屏幕上是 1:1：拖多少像素机身就走多少像素（俯仰把竖直方向拉回一点）
  const dx = clientX - panStartX, dy = clientY - panStartY;
  panX = panFromX + dx * panScale;
  panY = panFromY + dy * panScale / Math.cos(TILT);
  panX = Math.max(-r.width * 0.35 * panScale, Math.min(r.width * 0.35 * panScale, panX));
  panY = Math.max(-r.height * 0.30 * panScale, Math.min(r.height * 0.30 * panScale, panY));
  applyRigPose(); relayout(); requestRender();
}
export function endPan(){
  if (!panDragging) return;
  panDragging = false;
  document.body.classList.remove('is-panning');
  startPanSpring();
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
  rigZoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rigZoomTarget - delta * ZOOM_STEP));
  startZoomSpring();
}
export function zoomReset(){
  rigZoomTarget = 1;
  resetPan();
  startZoomSpring();
}
export function getZoom(){ return rigZoom; }
function startZoomSpring(){
  if (Math.abs(rigZoom - rigZoomTarget) < 0.001) return;
  zoomSpringFrom = rigZoom;
  zoomSpringRunning = true;
  zoomSpringStart = performance.now();
  requestAnimationFrame(stepZoomSpring);
}
function stepZoomSpring(now){
  if (!zoomSpringRunning) return;
  const dur = 450;
  const t = Math.min(1, (now - zoomSpringStart) / dur);
  const s = springOut(t);
  rigZoom = zoomSpringFrom + (rigZoomTarget - zoomSpringFrom) * s;
  applyRigPose();
  relayout();
  requestRender();
  if (t >= 1){
    zoomSpringRunning = false;
    rigZoom = rigZoomTarget;
    applyRigPose();
    relayout();
    requestRender();
    return;
  }
  requestAnimationFrame(stepZoomSpring);
}

function springOut(t){
  // 近似 cubic-bezier(0.34, 1.56, 0.64, 1)
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function animateParallax(){
  if (isNarrow()) return;
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
export function machineStatus(){
  // ADR-0004：验收要能直接读到环境贴图、色调映射、曝光和三盏灯的参数。
  const lights = [];
  if (scene) scene.traverse(o => {
    if (!o.isLight) return;
    lights.push({ type: o.type, color: '#' + o.color.getHexString(), intensity: o.intensity,
                  position: [o.position.x, o.position.y, o.position.z] });
  });
  const tablet = bodyRect();
  return {
    source: 'glb', status, ready, error, nodes, buttonsVisible,
    environment: !!(scene && scene.environment),
    toneMapping: renderer ? renderer.toneMapping : null,
    toneMappingName: renderer
      ? (TONE_MAPPING_NAMES[renderer.toneMapping] ?? String(renderer.toneMapping)) : null,
    toneMappingExposure: renderer ? renderer.toneMappingExposure : null,
    lights,
    contactShadow: !!(contactShadow && contactShadow.visible),
    tablet,
    screen: screenPx, screenSize: { w: screenSize.x, h: screenSize.y },
    buttons: buttons.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
    handRows,
  };
}
export function frameStats(){
  return { frameCount, dpr };
}
