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
const MAX_BACKS = 10;
const SEAT_3D = {
  me:   { x: 0.0,   z: 3.50, labelZ: 4.35 },
  up:   { x: -4.45, z: -0.45, labelZ: -0.75 },
  down: { x: 4.45,  z: -0.45, labelZ: -0.75 },
};

let canvas, stage, overlayHook;
let renderer, scene, camera, rig, body, screenGroup, screenMesh, screenMat;
let tableScene, tableCam, rt;
let cardGroup, anchors = {}, frontMats = {}, backMat, edgeMat, cardGeo;
let handMeshes = [], handHits = [], handRows = [], hitGeo, hitMat;
let screenSize = new THREE.Vector2(0.001, 0.001), screenPx = null;
let buttons = [], buttonZones = [], modelSize = new THREE.Vector3(10, 4.2, 1.0);
let screenCenter = new THREE.Vector3();
let stageW = 0, stageH = 0, dpr = 1, observedW = 0, observedH = 0;
let lastSnap = null, lastMeta = null, narrowHand = false, tinyHand = false;
let pointerTarget = { x: 0, y: 0 }, view = { x: 0, y: 0 };
let parallaxRunning = false, parallaxStart = 0;
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
function asTexture(c){
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function faceTexture(rank){
  const c = makeCanvas(52, 74), g = c.getContext('2d');
  g.fillStyle = cssVar('--ground'); g.fillRect(0, 0, 52, 74);
  g.strokeStyle = cssVar('--ink'); g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 49, 71);
  // 手牌叠扇后只露出左侧约半张牌。点数必须落在这条可见带里，
  // 并且把 10 缩成两字符宽、王缩成小/大，避免只露出半个字。
  const label = { T: '10', B: '小', R: '大' }[rank] || NAME[rank] || rank;
  g.fillStyle = cssVar('--ink');
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.font = `${label.length > 1 ? 18 : 24}px Pixel, monospace`;
  g.fillText(label, 3, 3);
  g.font = '16px Pixel, monospace';
  g.fillText('♠', 5, 37);
  return asTexture(c);
}
function backTexture(){
  const c = makeCanvas(52, 74), g = c.getContext('2d');
  g.fillStyle = cssVar('--side-a'); g.fillRect(0, 0, 52, 74);
  g.strokeStyle = cssVar('--ground'); g.lineWidth = 3;
  g.strokeRect(7.5, 9.5, 37, 55);
  g.beginPath(); g.moveTo(26, 26); g.lineTo(38, 37); g.lineTo(26, 48); g.lineTo(14, 37);
  g.closePath(); g.stroke();
  g.strokeStyle = cssVar('--ink'); g.lineWidth = 4;
  g.strokeRect(2, 2, 48, 70);
  return asTexture(c);
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
  return new THREE.MeshPhongMaterial({
    color, shininess: 0, specular: 0x000000, flatShading: true,
  });
}
function buildTable(){
  const base = hex('--ink');
  const wood = hex('--ground').clone().lerp(hex('--side-b'), 0.55);
  const felt = hex('--side-a').clone().offsetHSL(0, 0, -0.05);
  const feltHi = hex('--side-a').clone().offsetHSL(0, 0, 0.07);
  const CZ = 1.30;
  const TW = 15.2, TD = 10.0, TC = 2.3;
  const FW = 13.6, FD = 8.4, FC = 1.9;
  const put = (shape, d, color, topY) => {
    const m = new THREE.Mesh(extrude(shape, d, 0.02), matOf(color));
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, topY - d / 2, CZ);
    tableScene.add(m);
  };
  put(octaShape(TW + 0.5, TD + 0.5, TC + 0.25), 0.9, base, -0.06);
  put(octaRing(TW, TD, TC, FW, FD, FC), 1.1, wood, 0.26);
  put(octaShape(FW - 0.02, FD - 0.02, FC), 0.7, felt, 0.0);
  put(octaRing(FW - 0.42, FD - 0.42, FC - 0.12, FW - 0.68, FD - 0.68, FC - 0.2),
      0.04, feltHi, 0.012);
}
function cardMesh(rank, faceUp){
  const mats = faceUp
    ? [edgeMat, edgeMat, edgeMat, edgeMat,
       frontMats[rank] || (frontMats[rank] = new THREE.MeshBasicMaterial({ map: faceTexture(rank) })),
       backMat]
    : [edgeMat, edgeMat, edgeMat, edgeMat, backMat, backMat];
  return new THREE.Mesh(cardGeo, mats);
}
function layRow(ranks, x, z, faceUp, tilt, spacing, scale = 1, track = false,
                offset = 0, fan = 0, yaw = 0){
  const n = ranks.length;
  if (!n) return;
  const mid = (n - 1) / 2;
  ranks.forEach((rank, i) => {
    const off = i - mid;
    const roll = fan * off;
    const lift = (CARD_H * scale / 2) * Math.cos(tilt) + 0.03;
    const px = x + off * spacing, pz = z + i * 0.0016;
    const m = cardMesh(rank, faceUp);
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
      hit.userData = { handIndex: offset + i,
                       visibleShift: n > 1 ? (spacing - CARD_W * scale) / 2 : 0 };
      handHits.push(hit);
      cardGroup.add(hit);
    }
    cardGroup.add(m);
  });
}
function drawCards(){
  if (!lastSnap || !lastMeta || !cardGroup) return;
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
                 row.offset, -0.012);
          handRows.push({ start: row.offset, count: row.cards.length });
        }
      } else {
        const n = Math.max(hand.length, 1);
        const per = (n - 1) * 0.46 + 1;
        const szMax = 13.0 / (CARD_W * per);
        const sz = Math.max(narrowHand ? 1.26 : 1.22,
                            tinyHand ? Math.min(2.10, szMax) : 0);
        const gap = n > 1 ? CARD_W * sz * 0.46 : 0;
        layRow(hand, place.x, place.z, true, HAND_TILT, gap, sz, true, 0, -0.018);
        handRows.push({ start: 0, count: hand.length });
      }
    } else {
      const back = Math.min(lastSnap.remaining[player], MAX_BACKS);
      const dir = rel === 'up' ? 1 : -1;
      layRow(Array(back).fill('T'), place.x, place.z, false, BACK_TILT, 0.18,
             1.06, false, 0, dir * 0.18, -dir * 0.5);
    }
    anchors[player] = new THREE.Vector3(place.x, 0.06, place.labelZ);
  });
  const trick = lastSnap.last_move || [];
  const trickScale = tinyHand ? 1.90 : (narrowHand ? 1.06 : 1.16);
  const cardW = CARD_W * trickScale;
  const want = 0.86 * trickScale;
  const fit = trick.length > 1 ? 13.0 / (trick.length - 1) : want;
  const trickGap = Math.max(cardW * 0.46, Math.min(want, fit));
  layRow(trick, 0, tinyHand ? -1.10 : (narrowHand ? 0.55 : 1.45),
         true, TRICK_TILT, trickGap, trickScale, false, 0, -0.02);
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
  const top = topNode ? projectFrontBox(modelBox(topNode)) : null;
  const tablet = projectFrontBox(modelBox(body));
  const left = unionRects(buttons.filter(b => ['dpad-up','dpad-down','dpad-left','dpad-right','play-clear','new-round'].includes(b.id)));
  const right = unionRects(buttons.filter(b => ['play-hint-btn','undo','play-go','play-pass'].includes(b.id)));

  if (rt){
    const aspect = screenSize.x / screenSize.y;
    tableCam.aspect = aspect;
    tableCam.updateProjectionMatrix();
    const rtW = Math.max(64, Math.min(2048, Math.round(screen.w * dpr * 1.08)));
    const rtH = Math.max(64, Math.min(2048, Math.round(rtW / aspect)));
    if (rt.width !== rtW || rt.height !== rtH) rt.setSize(rtW, rtH);
  }
  emit({ seats, rects: { screen, left, right, top, tablet }, buttons });
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
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch (err){
    failNoWebGL(err);
    return false;
  }
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.NoToneMapping;   // ADR-0004：与 /glb 一致，不套 ACES
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(cssVar('--ground'));
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
  tableScene.background = hex('--side-a').clone().offsetHSL(0, 0, -0.16);
  tableCam = new THREE.PerspectiveCamera(28, screenSize.x / screenSize.y, 0.1, 200);
  tableCam.position.set(0, 13.0, 7.6);
  tableCam.lookAt(0, 0, 1.5);
  tableScene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const tkey = new THREE.DirectionalLight(0xffffff, 1.5); tkey.position.set(-4, 9, 7); tableScene.add(tkey);
  const tfill = new THREE.DirectionalLight(0xcfe0ff, 0.5); tfill.position.set(6, 4, 5); tableScene.add(tfill);
  buildTable();
  cardGroup = new THREE.Group();
  tableScene.add(cardGroup);
  edgeMat = new THREE.MeshBasicMaterial({ color: cssVar('--ink') });
  backMat = new THREE.MeshBasicMaterial({ map: backTexture() });
  cardGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_T);
  hitGeo = new THREE.PlaneGeometry(CARD_W * 1.02, CARD_H * 1.02);
  hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  screenMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  rt = new THREE.WebGLRenderTarget(512, 256, { depthBuffer: true, samples: 4 });
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
  rig.position.set(view.x, view.y, 0);
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
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return null;
  ndc.set(((px - s.x) / s.w) * 2 - 1, -(((py - s.y) / s.h) * 2 - 1));
  raycaster.setFromCamera(ndc, tableCam);
  const hit = raycaster.intersectObjects(handHits, false)[0];
  return hit ? hit.object.userData.handIndex : null;
}
export function setSelected(rankCounts){
  const left = Object.assign({}, rankCounts || {});
  const ordered = handMeshes.slice().sort((a, b) => a.userData.handIndex - b.userData.handIndex);
  for (const m of ordered){
    const base = m.userData.baseY, r = m.userData.rank;
    if (left[r] > 0){ left[r] -= 1; m.position.y = base + 0.46; }
    else m.position.y = base;
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
const TONE_MAPPING_NAMES = ['None', 'Linear', 'Reinhard', 'Cineon', 'ACESFilmic'];
export function machineStatus(){
  // ADR-0004：验收要能直接读到环境贴图、色调映射、曝光和三盏灯的参数。
  const lights = [];
  if (scene) scene.traverse(o => {
    if (!o.isLight) return;
    lights.push({ type: o.type, color: '#' + o.color.getHexString(), intensity: o.intensity,
                  position: [o.position.x, o.position.y, o.position.z] });
  });
  let tablet = null;
  if (ready && body && camera){
    camera.updateMatrixWorld(true);
    body.updateWorldMatrix(true, true);
    tablet = projectFrontBox(modelBox(body));
  }
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
