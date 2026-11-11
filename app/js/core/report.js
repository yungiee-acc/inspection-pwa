// 由「已確認的配對結果」產生報告資料模型。
// 預覽畫面、正式 Excel、「VBA匯入資料」工作表都從同一個模型產生，三者不會不一致。
import { RULES } from './config.js';
import { normText, rocInfo, fmtDateTime, taipeiDate } from './util.js';

/** 報告上顯示的廠商名稱：優先「報告顯示名稱」→ 廠商簡稱。找不到唯一廠商時退回環資原名並標警示 */
export function resolveVendorDisplay(hzVendorName, vendors) {
  const hits = vendors.filter((v) => normText(v.full_name) === normText(hzVendorName));
  if (hits.length === 1) {
    const v = hits[0];
    return { name: v.report_name || v.short_name, vendor: v, warn: v.report_name ? null : null };
  }
  return { name: hzVendorName, vendor: null, warn: hits.length ? `廠商全名「${hzVendorName}」對應到多個廠商代號` : `廠商「${hzVendorName}」不在廠商主檔` };
}

function fmtSampleGross(n) { // 範例檔：512.5、521.0（一位小數文字）
  const s = String(n); const d = s.includes('.') ? s.split('.')[1].length : 0;
  return Number(n).toFixed(d <= 1 ? 1 : 2);
}
const fmt2 = (n) => Number(n).toFixed(2);

/**
 * @param model  buildMatchModel 的結果（必須 model.ready）
 * @returns {pages, rows, warnings}
 */
export function buildReportModel({ model, vendors, weighDate }) {
  const warnings = [];
  const trips = [];
  for (const t of model.trips) {
    const vd = resolveVendorDisplay(t.vendor_name, vendors);
    if (vd.warn) warnings.push(vd.warn);
    const multi = t.rows.length > 1;
    const rows = t.rows.map((r, k) => {
      const insp = r.confirmed?.raw || null;
      let p = multi && k === 0 ? '併車:' : '';
      let sample = null;
      if (insp) {
        const types = (insp.impurity_types || []).join('、');
        const text = [types, insp.note].filter(Boolean).join('；');
        p += text;
        sample = {
          code: String(insp.sample_code), gross: fmtSampleGross(insp.gross_kg),
          water: Number(insp.water_kg || 0) === 0 ? '-' : fmt2(insp.water_kg),
          impurity: fmt2(insp.impurity_kg || 0),
        };
      }
      return {
        hz: r.hz, inspection: insp, inspectionModel: r.confirmed, decision: r.decision,
        first: k === 0, sample, pText: p,
      };
    });
    trips.push({ ship_no: t.ship_no, vendorDisplay: vd.name, vendor: vd.vendor, vehicle_no: t.vehicle_no, rows, multi, key: t.key });
  }

  // 分頁：每頁 rowsPerPage 列；整趟車不跨頁（與範例檔相同：剩餘列數不足就換頁）
  const per = RULES.rowsPerPage;
  const pages = [[]];
  for (const t of trips) {
    const n = t.rows.length;
    let cur = pages[pages.length - 1];
    if (n <= per && cur.length + n > per) { pages.push([]); cur = pages[pages.length - 1]; }
    if (n > per) warnings.push(`出貨序號 ${t.ship_no} 有 ${n} 列，超過一頁（${per} 列），會跨頁`);
    t.rows.forEach((row, k) => {
      if (pages[pages.length - 1].length >= per) pages.push([]);
      pages[pages.length - 1].push({ ...row, trip: t, tripIndex: k });
    });
  }
  for (const pg of pages) while (pg.length < per) pg.push(null);
  if (pages.length > RULES.maxPages) warnings.push('頁數過多');

  return { weighDate, roc: rocInfo(weighDate), trips, pages, warnings };
}

// ---------------- VBA 匯入資料 ----------------
export const VBA_COLUMNS = [
  ['FormatVersion', '格式版本'], ['ReportId', '報告編號'], ['ReportVersion', '報告版次'], ['ReportStatus', '審核狀態'], ['DataHash', '資料校驗碼'],
  ['ReportDate', '報告日期'], ['InspectionID', '查驗編號'], ['InspectionRev', '查驗修訂次'], ['InspectedAt', '查驗時間'],
  ['VendorCode', '廠商代號'], ['VendorName', '廠商全名'], ['VehicleNo', '車號'],
  ['ErpCode', 'ERP品號(手機原始選擇)'], ['ErpName', 'ERP品名'], ['ReportItemName', '報告品項名稱(D欄)'],
  ['HzSeqNo', '環資序號'], ['HzShipNo', '環資出貨序號'], ['HzGrossKg', '環資總重'], ['HzTareKg', '環資空重'], ['HzNetKg', '環資粗重(淨)'], ['HzBricks', '磚數'],
  ['ErpWeighTicketNo', 'ERP地磅單號(留空,待ERP)'],
  ['SampleCode', '樣磚代號'], ['SampleGrossKg', '樣磚毛重kg'], ['WaterKg', '樣磚含水重kg'], ['ImpurityKg', '樣磚雜質重kg'], ['WireKg', '樣磚鐵絲重kg'],
  ['ImpurityTypes', '雜質種類'], ['Inspector', '檢驗人'], ['Note', '備註'],
  ['MatchMode', '配對方式'], ['ConfirmedBy', '配對確認人'], ['ConfirmedAt', '配對確認時間'],
];

/** 每一筆「已確認配對的查驗」產生一列；保留手機原始 ERP 品號，不做任何合併 */
export function buildVbaRows(reportModel, meta, erpItems) {
  const erpByCode = new Map(erpItems.map((i) => [i.code, i]));
  const out = [];
  for (const pg of reportModel.pages) for (const row of pg) {
    if (!row || !row.inspection) continue;
    const i = row.inspection, h = row.hz, erp = erpByCode.get(i.erp_code);
    const vendor = row.inspectionModel?.vendor;
    out.push({
      FormatVersion: '1.0', ReportId: meta.reportId, ReportVersion: meta.version, ReportStatus: meta.status, DataHash: meta.dataHash || '',
      ReportDate: reportModel.weighDate, InspectionID: i.inspection_id, InspectionRev: i.rev ?? 1, InspectedAt: fmtDateTime(i.inspected_at),
      VendorCode: i.vendor_code, VendorName: vendor?.full_name || i.vendor_name || '', VehicleNo: i.vehicle_no,
      ErpCode: i.erp_code, ErpName: erp?.name || '', ReportItemName: erp?.report_name || '',
      HzSeqNo: h.seq_no, HzShipNo: h.ship_no, HzGrossKg: h.gross_kg, HzTareKg: h.tare_kg, HzNetKg: h.net_kg, HzBricks: h.bricks,
      ErpWeighTicketNo: '',
      SampleCode: String(i.sample_code), SampleGrossKg: Number(i.gross_kg), WaterKg: Number(i.water_kg || 0), ImpurityKg: Number(i.impurity_kg || 0), WireKg: Number(i.wire_kg || 0),
      ImpurityTypes: (i.impurity_types || []).join('、'), Inspector: i.inspector_name, Note: i.note || '',
      MatchMode: row.decision?.manual ? 'manual' : 'confirmed', ConfirmedBy: row.decision?.decided_by || '', ConfirmedAt: row.decision?.decided_at ? fmtDateTime(row.decision.decided_at) : '',
    });
  }
  return out;
}

/** 資料校驗碼的輸入：只含「內容」；排除報告編號／版次／狀態／校驗碼本身，所以草稿與正式版的內容相同時校驗碼也相同 */
export function hashPayload(vbaRows, model) {
  const strip = (r) => { const { ReportId, ReportVersion, ReportStatus, DataHash, ...rest } = r; return rest; };
  return {
    vba: vbaRows.map(strip),
    hz: (model?.rows || []).map((r) => [r.hz.seq_no, r.hz.ship_no, r.hz.vendor_name, r.hz.vehicle_no, r.hz.item_name, r.hz.bricks, r.hz.gross_kg, r.hz.tare_kg, r.state]),
  };
}

export function reportFileName(weighDate, version) {
  const r = rocInfo(weighDate);
  return `${r.year}年進貨查驗報告_${r.code}_v${version}.xlsx`;
}
export { taipeiDate };
