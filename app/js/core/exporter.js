// 以「115年進貨查驗報告 [範例].xlsx」為範本，產生正式報告 Excel（ExcelJS）。
// 作法：讀入範本 → 複製「一頁(16列)」的格式（框線、字型、對齊、合併、列高、數字格式）→ 依需要的頁數重複 →
// 另外加上「VBA匯入資料」與「報告資訊」兩張工作表。
// 已知限制：範本的「併車大括號」是繪圖形狀，ExcelJS 無法保留，改用 O 欄框線畫成近似的括號。
import { VBA_COLUMNS } from './report.js';
import { RULES } from './config.js';
import { fmtDateTime } from './util.js';

const PAGE_ROWS = 16;         // 一頁含：表頭2 + 資料10 + 簽章1 + 空白3
const FIRST_PAGE_TOP = 3;     // 範本第一頁表頭起始列
const COLS = 18;              // A..R

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const STATUS_LABEL = { draft: '草稿（未審核）', approved: '已審核', superseded: '已被新版取代' };
export const statusLabel = (s) => STATUS_LABEL[s] || s;

function parseRange(ref) { // 'A3:B4' → {c1,r1,c2,r2}
  const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  const col = (s) => [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
  return { c1: col(m[1]), r1: +m[2], c2: col(m[3]), r2: +m[4] };
}

export async function exportReportXlsx({ ExcelJS, templateBuf, reportModel, meta, vbaRows, changeLog = [], erpItems = [] }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuf);
  const tpl = wb.worksheets[0];
  const sheetName = reportModel.roc.code;
  tpl.name = '__template__'; // 先讓出名稱（範本與新報告頁同名）
  const ws = wb.addWorksheet(sheetName, { views: [{ zoomScale: 110 }] });

  // ---- 版面基本設定（與範本相同）
  ws.properties.defaultRowHeight = 16.2;
  ws.properties.defaultColWidth = 9;
  // ExcelJS 存檔會把活頁簿預設字型(新細明體 12)改成 11，欄寬「字元數」換算的像素會少 1/8，
  // 所以依 8/7 補償，讓實際畫面/列印寬度與範本一致（已用圖片逐一比對驗證）
  const WIDTH_FIX = 8 / 7;
  for (let c = 1; c <= COLS; c++) ws.getColumn(c).width = Math.round(tpl.getColumn(c).width * WIDTH_FIX * 100) / 100;

  // ---- 範本第一頁區塊的樣式快照
  const snap = [];
  for (let rr = 0; rr < PAGE_ROWS; rr++) {
    const tr = FIRST_PAGE_TOP + rr;
    const row = { height: tpl.getRow(tr).height, cells: [] };
    for (let c = 1; c <= COLS; c++) {
      const cell = tpl.getCell(tr, c);
      row.cells.push({ style: clone(cell.style), value: cell.isMerged && cell.master !== cell ? null : cell.value });
    }
    snap.push(row);
  }
  const titleSnap = [1, 2].map((tr) => ({
    height: tpl.getRow(tr).height,
    cells: Array.from({ length: COLS }, (_, i) => { const cell = tpl.getCell(tr, i + 1); return { style: clone(cell.style), value: cell.isMerged && cell.master !== cell ? null : cell.value }; }),
  }));
  const tplMerges = (tpl.model.merges || []).filter((x) => typeof x === 'string' && x.includes(':'));
  const blockMerges = tplMerges.map(parseRange).filter((m) => m.r1 >= FIRST_PAGE_TOP && m.r2 < FIRST_PAGE_TOP + PAGE_ROWS);
  const titleMerges = tplMerges.map(parseRange).filter((m) => m.r2 <= 2);
  const notes = [];
  for (let r = 5; r <= 12; r++) notes.push(tpl.getCell(r, 18).value);

  // ---- 標題兩列
  for (let rr = 0; rr < 2; rr++) {
    ws.getRow(rr + 1).height = titleSnap[rr].height;
    titleSnap[rr].cells.forEach((cs, i) => { const cell = ws.getCell(rr + 1, i + 1); cell.style = clone(cs.style); if (cs.value !== null) cell.value = cs.value; });
  }
  for (const m of titleMerges) ws.mergeCells(m.r1, m.c1, m.r2, m.c2);
  ws.getCell('M2').value = `稽核日期： ${reportModel.roc.text}`;

  // ---- 每一頁
  const pageCount = reportModel.pages.length;
  const E_LIST = [...new Set(erpItems.map((i) => i.report_name).filter(Boolean))];
  for (let p = 0; p < pageCount; p++) {
    const top = FIRST_PAGE_TOP + p * PAGE_ROWS;
    for (let rr = 0; rr < PAGE_ROWS; rr++) {
      const r = top + rr;
      ws.getRow(r).height = snap[rr].height;
      snap[rr].cells.forEach((cs, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.style = clone(cs.style);
        // ExcelJS 讀字型大小時會取整數（9.5→9），範本「雜質/備註」欄(P)是 9.5，這裡補回
        if (i === 15 && rr >= 2 && rr <= 11) cell.font = { ...(cell.font || {}), size: 9.5 };
        if (cs.value !== null && cs.value !== undefined && (rr < 2 || rr === 12)) cell.value = cs.value; // 表頭、簽章列文字
      });
    }
    for (const m of blockMerges) ws.mergeCells(m.r1 - FIRST_PAGE_TOP + top, m.c1, m.r2 - FIRST_PAGE_TOP + top, m.c2);
    if (p === 0) notes.forEach((v, i) => { if (v) ws.getCell(5 + i, 18).value = v; }); // 範本「注意事項」說明（列印範圍外）

    // 資料列
    const rows = reportModel.pages[p];
    rows.forEach((row, k) => {
      const r = top + 2 + k;
      const set = (col, v) => { ws.getCell(r, col).value = v; };
      if (row) {
        const h = row.hz;
        if (row.tripIndex === 0) {
          set(1, h.ship_no.slice(0, 9)); set(2, h.ship_no.slice(9));
          set(3, row.trip.vendorDisplay); set(4, row.trip.vehicle_no);
        }
        set(5, h.item_name); set(6, h.bricks); set(7, h.gross_kg); set(8, h.tare_kg);
        ws.getCell(r, 9).value = { formula: `G${r}-H${r}`, result: h.gross_kg - h.tare_kg };
        set(10, row.inspection ? '▓' : '□');
        if (row.sample) { set(11, row.sample.code); set(12, row.sample.gross); set(13, row.sample.water); set(14, row.sample.impurity); }
        if (row.pText) set(16, row.pText);
      } else {
        ws.getCell(r, 9).value = { formula: `G${r}-H${r}`, result: 0 };
        set(10, '□');
      }
    });
    // 併車括號（近似）：整趟 ≥2 列時，在 O 欄畫「]」
    rows.forEach((row, k) => {
      if (!row || !row.trip.multi) return;
      const r = top + 2 + k;
      const first = row.tripIndex === 0, last = row.tripIndex === row.trip.rows.length - 1;
      const c = ws.getCell(r, 15);
      c.border = { ...(c.border || {}), right: { style: 'thin' }, ...(first ? { top: { style: 'thin' } } : {}), ...(last ? { bottom: { style: 'thin' } } : {}) };
    });
    // 下拉選單
    for (let k = 0; k < RULES.rowsPerPage; k++) {
      const r = top + 2 + k;
      ws.getCell(r, 10).dataValidation = { type: 'list', allowBlank: true, formulae: ['"▓,□"'] };
      if (E_LIST.length && E_LIST.join(',').length < 250) {
        ws.getCell(r, 5).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: true, errorStyle: 'warning', formulae: [`"${E_LIST.join(',')}"`] };
      }
    }
    if (p < pageCount - 1) ws.getRow(top + PAGE_ROWS - 1).addPageBreak();
  }

  const lastRow = FIRST_PAGE_TOP + (pageCount - 1) * PAGE_ROWS + 12; // 最後一頁的簽章列
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', horizontalCentered: true, scale: 100,
    printArea: `A1:P${lastRow}`, printTitlesRow: '1:2',
    margins: { left: 0.3937007874015748, right: 0.3937007874015748, top: 0.3149606299212598, bottom: 0.1968503937007874, header: 0.3149606299212598, footer: 0.2755905511811024 },
  };
  ws.headerFooter.oddFooter = `&C第 &P 頁，共 &N 頁&R版次 v${meta.version}｜${statusLabel(meta.status)}｜${(meta.dataHash || '').slice(0, 8)}`;

  // ================= 工作表：VBA匯入資料 =================
  const vs = wb.addWorksheet('VBA匯入資料', { views: [{ state: 'frozen', ySplit: 2, xSplit: 7 }] });
  vs.addRow(VBA_COLUMNS.map((c) => c[0]));
  vs.addRow(VBA_COLUMNS.map((c) => c[1]));
  for (const r of vbaRows) vs.addRow(VBA_COLUMNS.map((c) => r[c[0]] ?? ''));
  vs.getRow(1).font = { bold: true, name: 'Consolas' };
  vs.getRow(2).font = { bold: true };
  vs.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  VBA_COLUMNS.forEach((c, i) => {
    const col = vs.getColumn(i + 1);
    col.width = Math.max(10, Math.min(28, c[1].length * 2 + 2));
    if (['HzShipNo', 'SampleCode', 'ErpCode', 'HzSeqNo', 'InspectionID', 'VendorCode'].includes(c[0])) col.numFmt = '@'; // 文字，保留前導 0
  });
  vs.getColumn(1).width = 10;

  // ================= 工作表：報告資訊 =================
  const info = wb.addWorksheet('報告資訊');
  info.columns = [{ width: 22 }, { width: 70 }, { width: 22 }, { width: 22 }, { width: 40 }];
  const kv = [
    ['報告日期', reportModel.weighDate], ['報告編號', meta.reportId], ['版次', `v${meta.version}`], ['審核狀態', statusLabel(meta.status)],
    ['製作人', meta.preparedBy || ''], ['審核人', meta.approvedBy || ''], ['審核時間', meta.approvedAt ? fmtDateTime(meta.approvedAt) : ''],
    ['產生時間', fmtDateTime(meta.createdAt || new Date().toISOString())], ['資料校驗碼(SHA-256)', meta.dataHash || ''],
    ['VBA匯入筆數', vbaRows.length], ['說明', '本檔「VBA匯入資料」工作表與上方報告頁由同一份資料產生。若報告有更正，請產生新版次，不要手改本檔。'],
  ];
  info.addRow(['進貨查驗報告資訊']).font = { bold: true, size: 14 };
  info.addRow([]);
  kv.forEach(([k, v]) => { const r = info.addRow([k, v]); r.getCell(1).font = { bold: true }; });
  info.addRow([]);
  info.addRow(['更正紀錄']).font = { bold: true, size: 12 };
  const hdr = info.addRow(['版次', '更正原因／內容', '更正人', '時間', '狀態']);
  hdr.font = { bold: true }; hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  if (!changeLog.length) info.addRow(['v1', '初版', meta.preparedBy || '', fmtDateTime(meta.createdAt || new Date().toISOString()), '']);
  for (const c of changeLog) info.addRow([`v${c.version}`, c.reason || '', c.by || '', c.at ? fmtDateTime(c.at) : '', statusLabel(c.status)]);

  wb.removeWorksheet(tpl.id);
  wb.views = [{ activeTab: 0 }];
  return wb.xlsx.writeBuffer();
}
