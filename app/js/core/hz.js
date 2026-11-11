// 解析「環資」進廠過磅報表（.xls / .xlsx）。
// 依「表頭文字」找欄位，不寫死欄位位置；遇到不認得的格式會明確報錯，不亂猜。
import { normText, num } from './util.js';

const HEADERS = {
  seq: '序號', time: '總重時間', category: '類別', vendor: '回收機構', item: '物料名稱',
  vehicle: '車號', ship: '出貨序號', gross: '總重', tare: '空車重', deduct: '扣重', net: '淨重',
  bricks: '磚數', remark: '備註', weigher: '過磅人',
};
const REQUIRED = ['seq', 'time', 'vendor', 'item', 'vehicle', 'ship', 'gross', 'tare', 'net', 'bricks'];

function cleanHeader(s) {
  return normText(s).replace(/[(（].*?[)）]/g, '');
}
const pad = (n) => String(n).padStart(2, '0');

/** "2026/11/9 上午 08:12:48" → { date:'2026-11-09', iso:'2026-11-09T08:12:48+08:00' } */
export function parseHzTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') { // Excel 序列值
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    return { date: `${y}-${pad(m)}-${pad(dd)}`, iso: `${y}-${pad(m)}-${pad(dd)}T${t}+08:00` };
  }
  const m = String(v).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(上午|下午|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (!m) return null;
  let hh = Number(m[5]);
  const ap = (m[4] || '').toUpperCase();
  if ((ap === '下午' || ap === 'PM') && hh < 12) hh += 12;
  if ((ap === '上午' || ap === 'AM') && hh === 12) hh = 0;
  const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return { date, iso: `${date}T${pad(hh)}:${m[6]}:${pad(m[7] || 0)}+08:00` };
}

/**
 * @param {ArrayBuffer} buf  檔案內容
 * @param {object} XLSX     SheetJS（瀏覽器為 window.XLSX）
 * @returns {{rows:Array, weighDate:string|null, warnings:string[], errors:string[], skipped:number}}
 */
export function parseHz(buf, XLSX) {
  const out = { rows: [], weighDate: null, warnings: [], errors: [], skipped: 0 };
  let wb;
  try { wb = XLSX.read(buf, { type: 'array', cellDates: false }); }
  catch (e) { out.errors.push(`無法讀取檔案：${e.message}`); return out; }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) { out.errors.push('檔案沒有工作表'); return out; }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });

  // 1) 找表頭列
  let hr = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const hs = (aoa[i] || []).map(cleanHeader);
    if (hs.includes('出貨序號') && hs.includes('車號')) { hr = i; break; }
  }
  if (hr < 0) { out.errors.push('找不到表頭列（需含「出貨序號」與「車號」）。這可能不是環資「進廠過磅報表」。'); return out; }
  const hs = aoa[hr].map(cleanHeader);
  const col = {};
  for (const [k, label] of Object.entries(HEADERS)) {
    const idx = hs.findIndex((h) => h === label || (k === 'tare' && h === '空重'));
    if (idx >= 0) col[k] = idx;
  }
  const missing = REQUIRED.filter((k) => col[k] === undefined).map((k) => HEADERS[k]);
  if (missing.length) { out.errors.push(`表頭缺少必要欄位：${missing.join('、')}`); return out; }

  // 2) 過磅日期（表頭上方）
  for (let i = 0; i < hr; i++) {
    for (const c of aoa[i] || []) {
      const m = typeof c === 'string' && c.match(/過磅日期[:：]\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (m) out.weighDate = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    }
  }

  // 3) 資料列
  const seen = new Set();
  for (let i = hr + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const seqRaw = r[col.seq];
    const seq = seqRaw === null || seqRaw === undefined ? '' : String(seqRaw).trim();
    if (!/^\d+$/.test(seq)) { if (r.some((c) => c !== null && c !== '')) out.skipped++; continue; } // 合計列、總筆數列等略過
    const t = parseHzTime(r[col.time]);
    const rowNo = i + 1;
    const item = String(r[col.item] ?? '').trim();
    const vendor = String(r[col.vendor] ?? '').trim();
    const vehicle = String(r[col.vehicle] ?? '').trim();
    let ship = r[col.ship] === null ? '' : String(r[col.ship]).trim();
    if (ship && /^\d+$/.test(ship) && typeof r[col.ship] === 'number') { // 若被當成數字，前導 0 已遺失
      ship = ship.padStart(11, '0');
      out.warnings.push(`第 ${rowNo} 列：出貨序號是「數字」格式，已補回前導 0 → ${ship}，請核對`);
    }
    const row = {
      seq_no: seq, weigh_date: t?.date || out.weighDate, weigh_time: t?.iso || null,
      category: String(r[col.category] ?? '').trim(), vendor_name: vendor, item_name: item,
      vehicle_no: vehicle, ship_no: ship,
      gross_kg: num(r[col.gross]), tare_kg: num(r[col.tare]),
      deduct_kg: col.deduct !== undefined ? (num(r[col.deduct]) ?? 0) : 0,
      net_kg: num(r[col.net]), bricks: num(r[col.bricks]),
      remark: col.remark !== undefined ? String(r[col.remark] ?? '').trim() : '',
      weigher: col.weigher !== undefined ? String(r[col.weigher] ?? '').trim() : '',
      src_row: rowNo,
    };
    const bad = [];
    if (!t) bad.push('總重時間');
    if (!vendor) bad.push('回收機構');
    if (!item) bad.push('物料名稱');
    if (!vehicle) bad.push('車號');
    if (!ship) bad.push('出貨序號');
    for (const k of ['gross_kg', 'tare_kg', 'net_kg', 'bricks']) if (row[k] === null) bad.push(k.replace('_kg', '').replace('gross', '總重').replace('tare', '空重').replace('net', '淨重').replace('bricks', '磚數'));
    if (bad.length) { out.errors.push(`第 ${rowNo} 列（序號 ${seq}）缺少或無法判讀：${bad.join('、')}`); continue; }
    if (seen.has(seq)) { out.errors.push(`第 ${rowNo} 列：序號 ${seq} 在檔案內重複`); continue; }
    seen.add(seq);
    if (Math.abs(row.gross_kg - row.tare_kg - row.deduct_kg - row.net_kg) > 0.5) {
      out.warnings.push(`第 ${rowNo} 列（序號 ${seq}）：總重 − 空重 − 扣重 ≠ 淨重（${row.gross_kg} − ${row.tare_kg} − ${row.deduct_kg} ≠ ${row.net_kg}）`);
    }
    if (out.weighDate && row.weigh_date && row.weigh_date !== out.weighDate) {
      out.warnings.push(`第 ${rowNo} 列：過磅日期 ${row.weigh_date} 與表頭日期 ${out.weighDate} 不同`);
    }
    out.rows.push(row);
  }
  if (!out.rows.length && !out.errors.length) out.errors.push('沒有讀到任何有效的過磅資料列');
  if (!out.weighDate && out.rows.length) out.weighDate = out.rows[0].weigh_date;
  return out;
}
