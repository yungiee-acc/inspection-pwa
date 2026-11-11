// 畫面共用小工具
import { esc, sha256 } from '../core/util.js';
export { esc };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export function toast(msg, kind = '', ms = 3200) {
  const box = $('#toast');
  const el = h(`<div class="t ${kind}">${esc(msg)}</div>`);
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 開一個底部彈出視窗；回傳 { el, close } */
export function modal(content, { onClose } = {}) {
  const root = $('#modal');
  const ov = h('<div class="ov"><div class="sheet"></div></div>');
  const sheet = $('.sheet', ov);
  if (typeof content === 'string') sheet.innerHTML = content; else sheet.appendChild(content);
  const close = (v) => { ov.remove(); onClose?.(v); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  root.appendChild(ov);
  return { el: sheet, close };
}

export function confirmBox(msg, { okText = '確定', danger = false, title = '請確認' } = {}) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><p style="white-space:pre-wrap">${esc(msg)}</p><div class="actions"><button class="sec" data-x="0">取消</button><button class="${danger ? 'dng' : ''}" data-x="1">${esc(okText)}</button></div>`, { onClose: () => res(false) });
    m.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { const v = b.dataset.x === '1'; m.el.closest('.ov').remove(); res(v); }));
  });
}

/** 要求輸入文字（例如原因）。取消回傳 null */
export function promptBox(msg, { required = true, placeholder = '', okText = '確定', title = '請輸入', initial = '' } = {}) {
  return new Promise((res) => {
    const m = modal(`<h3>${esc(title)}</h3><p style="white-space:pre-wrap">${esc(msg)}</p><textarea id="pb" placeholder="${esc(placeholder)}">${esc(initial)}</textarea><div class="fe" id="pbe"></div><div class="actions"><button class="sec" data-x="0">取消</button><button data-x="1">${esc(okText)}</button></div>`, { onClose: () => res(null) });
    const ta = $('#pb', m.el);
    m.el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.x === '0') { m.el.closest('.ov').remove(); res(null); return; }
      const v = ta.value.trim();
      if (required && !v) { $('#pbe', m.el).textContent = '這一欄必填'; return; }
      m.el.closest('.ov').remove(); res(v);
    }));
    ta.focus();
  });
}

const loaded = {};
export function loadScript(src) {
  if (loaded[src]) return loaded[src];
  loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('載入失敗：' + src)); document.head.appendChild(s); });
  return loaded[src];
}
export const loadXlsx = () => loadScript('vendor/xlsx.full.min.js');
export const loadExcelJs = () => loadScript('vendor/exceljs.min.js');

export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function bufferHash(buf) {
  const h2 = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h2)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export { sha256 };

export function badge(text, cls = '') { return `<span class="badge ${cls}">${esc(text)}</span>`; }
export function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); }
export function can(app, ...roles) { return roles.includes(app.profile?.role); }
