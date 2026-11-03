// 取数：所有网络往返都从这里走，页面别处不直接 fetch。

import { S, reduce, $ } from './state.js';
import { actorName, label } from './labels.js';

export function setBanner(text, kind){
  const b = $('banner');
  const changed = b.textContent !== (text || '');
  b.hidden = !text; b.textContent = text || ''; b.dataset.kind = kind || '';
  // 变了就闪一下：反馈要看得见，而不是悄悄换行字
  if (changed && text && !reduce){
    b.classList.remove('flash');
    void b.offsetWidth;          // 强制重排，动画才会重放
    b.classList.add('flash');
  }
}

export async function api(path, body){
  let res;
  try {
    res = await fetch(path, body === undefined ? undefined : {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('连不上后端 —— 先在本机运行 ddz serve，再打开这个页面。');
  }
  let data = null;
  try { data = await res.json(); } catch { /* 不是 JSON，用状态码兜底 */ }
  if (!res.ok) throw new Error((data && data.detail) || `后端返回 ${res.status}`);
  return data;
}

/** 轮不到我方时给横幅的默认话术。 */
export function idleNote(){
  if (!S.snap) return '';
  if (S.snap.finished) return `牌局已结束 —— ${actorName(S.snap.winner)}先出完牌。`;
  if (S.point) return '';
  return `现在该 ${label(S.snap.acting)} 出牌 —— 还没轮到你，把这一手录进去。`;
}
