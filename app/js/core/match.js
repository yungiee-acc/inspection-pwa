// 環資明細 ↔ 手機查驗紀錄 配對引擎（純函式）
//
// 設計原則（對應需求）：
//  1. 絕不只靠車號；一定要「日期 + 廠商 + 車號 + 品項(ERP D欄對照名稱)」四項全部相符才算候選。
//  2. 環資「出貨序號」只用來辨識「同一趟車」，不當成 ERP 地磅單號。
//  3. 候選不是剛好 1 筆、或同日同車多趟、或 1 筆查驗可對應多列 → 一律列為異常，由辦公室人工選擇，
//     程式不會自行選第一筆。
//  4. 就算是「唯一候選」，也只是「建議配對（auto）」，仍須辦公室按確認才會成為正式配對。
//  5. 辦公室的決定存成 decisions；查驗紀錄事後被修改（rev 變動）→ 該決定自動失效並要求重新確認。
import { normText, normPlate, taipeiDate } from './util.js';
import { RULES } from './config.js';

const num = (s) => Number(s);

export function buildMatchModel({ hzRows, inspections, erpItems, vendors, decisions = {} }) {
  const erpByCode = new Map(erpItems.map((i) => [i.code, i]));
  const vendorByCode = new Map(vendors.map((v) => [v.code, v]));
  const reportNames = new Set(erpItems.map((i) => i.report_name).filter(Boolean).map(normText));

  // ---- 準備查驗紀錄
  const enrich = (i) => {
    const erp = erpByCode.get(i.erp_code);
    const vendor = vendorByCode.get(i.vendor_code);
    return {
      raw: i, id: i.inspection_id, rev: i.rev ?? 1, date: taipeiDate(i.inspected_at),
      plate: normPlate(i.vehicle_no), erp, vendor,
      vendorFull: vendor ? normText(vendor.full_name) : '',
      reportName: erp?.report_name || null,
    };
  };
  const allActive = inspections.filter((i) => i.status !== 'void').map(enrich);
  const inspById = new Map(allActive.map((i) => [i.id, i]));
  const dates = new Set(hzRows.map((r) => r.weigh_date));
  const insps = allActive.filter((i) => dates.has(i.date));

  // ---- 分趟
  const tripMap = new Map();
  const sorted = [...hzRows].sort((a, b) => num(a.seq_no) - num(b.seq_no));
  for (const h of sorted) {
    const key = h.ship_no || `${h.weigh_date}|${normPlate(h.vehicle_no)}|${normText(h.vendor_name)}`;
    if (!tripMap.has(key)) tripMap.set(key, { key, ship_no: h.ship_no, date: h.weigh_date, vendor_name: h.vendor_name, vehicle_no: h.vehicle_no, rows: [] });
    tripMap.get(key).rows.push({ hz: h, flags: [], candidates: [], suggested: null, confirmed: null, state: '', reasons: [], decision: null });
  }
  const trips = [...tripMap.values()];

  // 同日同車多趟
  const plateTrips = new Map();
  for (const t of trips) {
    const k = `${t.date}|${normPlate(t.vehicle_no)}`;
    if (!plateTrips.has(k)) plateTrips.set(k, new Set());
    plateTrips.get(k).add(t.key);
  }
  const isMultiTrip = (t) => plateTrips.get(`${t.date}|${normPlate(t.vehicle_no)}`).size > 1;

  const allRows = trips.flatMap((t) => t.rows.map((r) => Object.assign(r, { trip: t })));

  // 手機填的「這車磚數」（選填，正整數）；沒填＝null
  const brickOf = (i) => { const b = Number(i.raw.bricks); return Number.isInteger(b) && b > 0 ? b : null; };

  // ---- 計算每列的候選
  // 磚數只在「同日同車多趟」時用來分辨趟次：有填磚數且與該環資列磚數不同 → 這筆查驗不是這一趟。
  // 沒填磚數 → 不排除（維持原本規則，交給人工選）。非多趟的車不看磚數（避免單純填錯磚數就配不上）。
  for (const r of allRows) {
    const h = r.hz;
    r.candidates = insps.filter((i) => i.date === h.weigh_date && i.plate === normPlate(h.vehicle_no)
      && i.reportName && normText(i.reportName) === normText(h.item_name)
      && i.vendorFull && i.vendorFull === normText(h.vendor_name)
      && (!isMultiTrip(r.trip) || brickOf(i) === null || brickOf(i) === Number(h.bricks)));
  }

  // ---- 第一階段：套用辦公室已做的決定
  const confirmedBy = new Map(); // inspId -> [rows]
  for (const r of allRows) {
    const dec = decisions[`row:${r.hz.seq_no}`];
    if (!dec) continue;
    r.decision = dec;
    if (dec.choice === 'none') { r.state = 'none_confirmed'; continue; }
    const insp = inspById.get(dec.inspection_id);
    if (!insp) { r.state = 'stale'; r.reasons.push({ code: 'DECISION_INSPECTION_MISSING', msg: `先前確認的查驗 ${dec.inspection_id} 已作廢或不存在，請重新確認` }); continue; }
    if (insp.rev !== dec.inspection_rev) { r.state = 'stale'; r.reasons.push({ code: 'INSPECTION_EDITED', msg: `查驗 ${dec.inspection_id} 在確認後被修改過（版次 ${dec.inspection_rev}→${insp.rev}），請重新確認` }); r.suggested = insp; continue; }
    r.state = 'confirmed'; r.confirmed = insp;
    if (!confirmedBy.has(insp.id)) confirmedBy.set(insp.id, []);
    confirmedBy.get(insp.id).push(r);
  }
  for (const rows of confirmedBy.values()) {
    if (rows.length > 1) for (const r of rows) { r.state = 'conflict'; r.reasons.push({ code: 'INSPECTION_DOUBLE_CONFIRMED', msg: '同一筆查驗被確認到多個環資列，請只保留一個' }); }
  }

  // ---- 第二階段：未決定的列，判斷 auto / exception / uninspected
  const undecided = allRows.filter((r) => !r.state);
  const claims = new Map();
  for (const r of undecided) {
    r.effective = r.candidates.filter((i) => !confirmedBy.has(i.id));
    for (const i of r.effective) { if (!claims.has(i.id)) claims.set(i.id, []); claims.get(i.id).push(r); }
  }
  for (const r of undecided) {
    const c = r.effective;
    if (c.length === 0) { r.state = 'uninspected'; continue; }
    if (c.length > 1) r.reasons.push({ code: 'MULTI_CANDIDATE', msg: `有 ${c.length} 筆符合的查驗紀錄，無法自動判斷` });
    if (c.some((i) => claims.get(i.id).length > 1)) r.reasons.push({ code: 'INSPECTION_SHARED', msg: '同一筆查驗同時符合多個環資列（同車同品項多趟？）' });
    // 同日同車多趟：只有「剛好 1 筆查驗、且有填磚數並與這一趟吻合」才不需要人工分辨（磚數已在候選階段比對過）
    if (isMultiTrip(r.trip) && !(c.length === 1 && brickOf(c[0]) !== null)) r.reasons.push({ code: 'MULTI_TRIP', msg: '同一天同車號有多趟出貨序號，須人工確認屬於哪一趟（手機查驗填「磚數」可自動分辨）' });
    if (r.reasons.length) { r.state = 'exception'; r.candidates = c; }
    else { r.state = 'auto'; r.suggested = c[0]; r.candidates = c; }
  }

  // ---- 每列附加旗標
  for (const r of allRows) {
    const h = r.hz;
    if (!reportNames.has(normText(h.item_name))) {
      const ack = decisions[`ack:${h.seq_no}`];
      r.flags.push({ code: 'UNKNOWN_ITEM', level: ack ? 'info' : 'block', acked: !!ack, msg: `環資物料名稱「${h.item_name}」不在 ERP 主檔 D 欄清單內${ack ? '（已確認可用）' : '，請管理員確認'}` });
    }
    const pair = r.confirmed || r.suggested;
    if (RULES.brickWeightRatioWarn != null && pair && h.bricks > 0 && h.net_kg > 0) {
      const avg = h.net_kg / h.bricks;
      const ratio = pair.raw.gross_kg / avg;
      if (Math.abs(ratio - 1) > RULES.brickWeightRatioWarn) {
        r.flags.push({ code: 'BRICK_WEIGHT', level: 'warn', msg: `樣磚毛重 ${pair.raw.gross_kg} kg 與該列平均每磚 ${avg.toFixed(1)} kg 差 ${((ratio - 1) * 100).toFixed(0)}%，請確認是否同一批貨` });
      }
    }
    if (pair && brickOf(pair) !== null && h.bricks > 0 && brickOf(pair) !== Number(h.bricks)) {
      r.flags.push({ code: 'BRICKS_DIFF', level: 'warn', msg: `手機填的磚數 ${brickOf(pair)} 與環資磚數 ${h.bricks} 不同，請確認` });
    }
    if (r.confirmed && r.decision?.manual) r.flags.push({ code: 'MANUAL', level: 'info', msg: '人工指定配對' });
  }

  // ---- 趟次狀態
  for (const t of trips) {
    t.flags = [];
    if (t.rows.length > 1) t.flags.push({ code: 'MULTI_ITEM', level: 'info', msg: `同車 ${t.rows.length} 個品項（併車）` });
    if (isMultiTrip(t)) t.flags.push({ code: 'MULTI_TRIP', level: 'warn', msg: '同日同車多趟' });
    // 規定：整車至少一個品項必須有查驗，沒有放行選項（其餘品項未查驗＝未抽驗，屬正常）
    t.decision = null;
    if (t.rows.some((r) => r.state === 'confirmed')) t.state = 'ok';
    else if (t.rows.some((r) => ['auto', 'exception', 'stale', 'conflict'].includes(r.state))) t.state = 'pending';
    else t.state = 'no_inspection';
  }

  // ---- 沒有歸屬的查驗紀錄（異常清單）
  const placed = new Set();
  for (const r of allRows) {
    if (r.confirmed) placed.add(r.confirmed.id);
    if (r.suggested) placed.add(r.suggested.id);
    if (r.state === 'exception') r.candidates.forEach((i) => placed.add(i.id));
  }
  const orphans = [];
  for (const i of insps) {
    if (placed.has(i.id)) continue;
    const dis = decisions[`insp:${i.id}`];
    const reasons = [];
    const sameDay = allRows.filter((r) => r.hz.weigh_date === i.date);
    const samePlate = sameDay.filter((r) => normPlate(r.hz.vehicle_no) === i.plate);
    if (!i.erp) reasons.push({ code: 'ERP_MISSING', msg: `品號 ${i.raw.erp_code} 不在 ERP 主檔` });
    else if (!i.reportName) reasons.push({ code: 'ITEM_UNMAPPED', msg: `品號 ${i.erp.code} ${i.erp.name} 尚無報告對照名稱（D 欄空白），請管理員補齊後才能配對` });
    if (!i.vendor) reasons.push({ code: 'VENDOR_UNKNOWN', msg: `廠商代號 ${i.raw.vendor_code} 不在廠商主檔` });
    if (!reasons.length) {
      const sameKey = samePlate.filter((r) => normText(r.hz.vendor_name) === i.vendorFull && normText(r.hz.item_name) === normText(i.reportName));
      if (sameKey.length && brickOf(i) !== null && sameKey.every((r) => Number(r.hz.bricks) !== brickOf(i))) {
        reasons.push({ code: 'BRICKS_MISMATCH', msg: `查驗填的磚數 ${brickOf(i)} 與同日同車同品項的環資磚數（${sameKey.map((r) => r.hz.bricks).join('、')}）都不同，請確認磚數是否填錯；或到「查驗紀錄」更正，或手動指定環資列` });
      } else if (sameKey.length) {
        const by = sameKey.map((r) => r.confirmed?.id).filter(Boolean);
        reasons.push({ code: 'ALREADY_MATCHED', msg: `符合的環資列已確認配對到${by.length ? `另一筆查驗（${by.join('、')}）` : '「未抽驗」'}，同一列只能對應一筆。若是重複輸入請作廢其中一筆；若確實是不同車次請手動指定環資列` });
      } else if (samePlate.length) {
        const sameVendor = samePlate.filter((r) => normText(r.hz.vendor_name) === i.vendorFull);
        if (!sameVendor.length) reasons.push({ code: 'VENDOR_MISMATCH', msg: `同日同車號的環資廠商是「${[...new Set(samePlate.map((r) => r.hz.vendor_name))].join('、')}」，與查驗的「${i.vendor.full_name}」不同` });
        else reasons.push({ code: 'ITEM_MISMATCH', msg: `同日同車號的環資品項是「${sameVendor.map((r) => r.hz.item_name).join('、')}」，沒有「${i.reportName}」` });
      } else {
        const sv = sameDay.filter((r) => normText(r.hz.vendor_name) === i.vendorFull);
        if (sv.length) reasons.push({ code: 'PLATE_MISMATCH', msg: `同日同廠商的環資車號是「${[...new Set(sv.map((r) => r.hz.vehicle_no))].join('、')}」，與查驗車號「${i.raw.vehicle_no}」不同` });
        else reasons.push({ code: 'NO_HZ_ROW', msg: '環資檔內找不到這個日期＋廠商＋車號的資料（環資檔可能尚未匯入或日期不同）' });
      }
    }
    orphans.push({ inspection: i, reasons, dismissed: dis || null, nearRows: samePlate.length ? samePlate : sameDay.filter((r) => normText(r.hz.vendor_name) === i.vendorFull) });
  }

  // ---- 可否產生報告
  const blockers = [];
  for (const t of trips) {
    if (t.state === 'no_inspection') blockers.push({ code: 'NO_INSPECTION', msg: `出貨序號 ${t.ship_no || '(無)'}｜${t.vendor_name}｜${t.vehicle_no}：整車沒有查驗紀錄，請補查驗或確認「本車確實未抽驗」` });
    for (const r of t.rows) {
      const where = `序號 ${r.hz.seq_no}｜${t.vehicle_no}｜${r.hz.item_name}`;
      if (r.state === 'auto') blockers.push({ code: 'UNCONFIRMED', msg: `${where}：建議配對尚未確認` });
      if (r.state === 'exception') blockers.push({ code: 'EXCEPTION', msg: `${where}：配對異常，需人工選擇` });
      if (r.state === 'stale') blockers.push({ code: 'STALE', msg: `${where}：${r.reasons[0].msg}` });
      if (r.state === 'conflict') blockers.push({ code: 'CONFLICT', msg: `${where}：同一筆查驗重複確認` });
      if (r.state === 'confirmed' && !String(r.confirmed?.raw?.sample_code ?? '').trim()) blockers.push({ code: 'NO_SAMPLE_CODE', msg: `${where}：查驗 ${r.confirmed.id} 尚未填樣磚代號，請到「查驗紀錄」補填後重新確認` });
      if (r.flags.some((f) => f.code === 'UNKNOWN_ITEM' && f.level === 'block')) blockers.push({ code: 'UNKNOWN_ITEM', msg: `${where}：品項名稱不在 ERP D 欄清單，需管理員確認` });
    }
  }
  for (const o of orphans) {
    if (!o.dismissed) blockers.push({ code: 'ORPHAN_INSPECTION', msg: `查驗 ${o.inspection.id}｜${o.inspection.raw.vehicle_no}｜${o.inspection.raw.erp_code}：沒有對應的環資列（${o.reasons[0]?.msg || ''}）` });
  }

  const count = (s) => allRows.filter((r) => r.state === s).length;
  return {
    trips, rows: allRows, orphans, blockers, ready: blockers.length === 0,
    summary: {
      trips: trips.length, rows: allRows.length, inspections: insps.length,
      auto: count('auto'), exception: count('exception'), confirmed: count('confirmed'),
      none_confirmed: count('none_confirmed'), uninspected: count('uninspected'), stale: count('stale'),
      orphans: orphans.filter((o) => !o.dismissed).length,
      tripsNoInspection: trips.filter((t) => t.state === 'no_inspection').length,
    },
  };
}

/** 一鍵確認所有「建議配對(auto)」→ 產生要寫入的 decisions */
export function autoConfirmDecisions(model, user) {
  return model.rows.filter((r) => r.state === 'auto').map((r) => ({
    key: `row:${r.hz.seq_no}`,
    value: { choice: 'confirmed', inspection_id: r.suggested.id, inspection_rev: r.suggested.rev, manual: false, note: '', decided_by: user, decided_at: new Date().toISOString() },
  }));
}
