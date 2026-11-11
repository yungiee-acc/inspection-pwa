// 共用小工具（純函式，不依賴瀏覽器畫面）
export const TZ = 'Asia/Taipei';

const dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** 取得台北時區的各個時間欄位 */
export function taipeiParts(input) {
  const d = input instanceof Date ? input : new Date(input);
  const o = {};
  for (const p of dtf.formatToParts(d)) o[p.type] = p.value;
  return { y: o.year, m: o.month, d: o.day, hh: o.hour, mm: o.minute, ss: o.second };
}
/** ISO 時間 → 台北日期 'YYYY-MM-DD' */
export function taipeiDate(input) {
  const p = taipeiParts(input);
  return `${p.y}-${p.m}-${p.d}`;
}
/** 'YYYY-MM-DD' → 民國資訊：{ code:'1151109', text:'115 年 11 月 9 日', year:115 } */
export function rocInfo(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const ry = y - 1911;
  return {
    year: ry, code: `${ry}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`,
    text: `${ry} 年 ${m} 月 ${d} 日`,
  };
}
export function nowIso() { return new Date().toISOString(); }
/** 給 <input type="datetime-local"> 用的本地(台北)時間字串 */
export function toLocalInput(input) {
  const p = taipeiParts(input);
  return `${p.y}-${p.m}-${p.d}T${p.hh}:${p.mm}`;
}
/** datetime-local 字串（視為台北時間）→ ISO */
export function fromLocalInput(s) { return new Date(`${s}:00+08:00`).toISOString(); }
export function fmtDateTime(input) {
  const p = taipeiParts(input);
  return `${p.y}/${p.m}/${p.d} ${p.hh}:${p.mm}`;
}

/** 文字正規化：全形轉半形、去空白、轉大寫（用於比對，不用於顯示） */
export function normText(s) {
  return String(s ?? '').normalize('NFKC').replace(/[\s　]+/g, '').toUpperCase();
}
/** 車號正規化：再去掉 - _ . 等符號（KLM-5278 與 KLM5278 視為相同） */
export function normPlate(s) {
  return normText(s).replace(/[-_.·‧•/\\]/g, '');
}

/** 轉數字；空白/無法解析 → null */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/,/g, '').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** 小數位數 */
export function decimals(n) {
  const s = String(n);
  if (s.includes('e')) return 99;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
export function round(n, p = 3) { const f = 10 ** p; return Math.round((n + Number.EPSILON) * f) / f; }

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 去掉易混淆的 I L O U
/** 產生查驗編號：INS-YYYYMMDD-XXXXX（日期為台北時間；後綴為隨機碼，由資料庫唯一鍵把關） */
export function genInspectionId(when = new Date()) {
  const p = taipeiParts(when);
  const bytes = new Uint8Array(5);
  (globalThis.crypto || { getRandomValues: (a) => a.map(() => (Math.random() * 256) | 0) }).getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += B32[b % 32];
  return `INS-${p.y}${p.m}${p.d}-${s}`;
}

export async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** 穩定的 JSON（鍵排序），用於產生一致的雜湊 */
export function stableStringify(o) {
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  if (o && typeof o === 'object') {
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(o);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function fmtKg(n, d = 0) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
}
