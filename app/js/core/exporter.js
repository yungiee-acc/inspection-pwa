// 以「115年進貨查驗報告 [範例].xlsx」為範本，產生正式報告 Excel（ExcelJS）。
// 作法：讀入範本 → 複製「一頁(16列)」的格式（框線、字型、對齊、合併、列高、數字格式）→ 依需要的頁數重複 →
// 另外加上「VBA匯入資料」與「報告資訊」兩張工作表。
// 併車大括號：範本裡是繪圖形狀，ExcelJS 讀不到也寫不出，所以存檔後用 zip.js 把「右大括弧」形狀加回去（見檔尾 addBraces）。
import { VBA_COLUMNS, vbaChecksumText } from './report.js';
import { RULES } from './config.js';
import { fmtDateTime, sha256 } from './util.js';
import { readZip, writeZip, _td, _te } from './zip.js';

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

  // ---- 標題兩列（先合併、再套樣式：ExcelJS 合併時會把被合併格的框線蓋成左上角格的框線，
  //      先合併再套樣式才能保留範本每一格原本的框線）
  for (const m of titleMerges) ws.mergeCells(m.r1, m.c1, m.r2, m.c2);
  for (let rr = 0; rr < 2; rr++) {
    ws.getRow(rr + 1).height = titleSnap[rr].height;
    titleSnap[rr].cells.forEach((cs, i) => { const cell = ws.getCell(rr + 1, i + 1); cell.style = clone(cs.style); if (cs.value !== null) cell.value = cs.value; });
  }
  ws.getCell('M2').value = `稽核日期： ${reportModel.roc.text}`;

  // ---- 每一頁
  const pageCount = reportModel.pages.length;
  const braces = [];
  const E_LIST = [...new Set(erpItems.map((i) => i.report_name).filter(Boolean))];
  for (let p = 0; p < pageCount; p++) {
    const top = FIRST_PAGE_TOP + p * PAGE_ROWS;
    for (const m of blockMerges) ws.mergeCells(m.r1 - FIRST_PAGE_TOP + top, m.c1, m.r2 - FIRST_PAGE_TOP + top, m.c2);
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
    // 併車括號：整趟 ≥2 列時記下位置，存檔後以「右大括弧」繪圖形狀加進去（不放在儲存格內）
    for (let k = 0; k < rows.length;) {
      const row = rows[k];
      if (!row || !row.trip.multi) { k++; continue; }
      let e = k;
      while (e + 1 < rows.length && rows[e + 1] && rows[e + 1].trip.key === row.trip.key) e++;
      if (e > k) braces.push({ r1: top + 2 + k, r2: top + 2 + e });
      k = e + 1;
    }
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
    paperSize: 9, orientation: 'landscape', horizontalCentered: true,
    // 寬度強制縮放到一頁寬（高度不限），避免欄寬換算差異時 P 欄被擠到下一頁，需要手動拉邊界
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printArea: `A1:P${lastRow}`, printTitlesRow: '1:2',
    margins: { left: 0.3937007874015748, right: 0.3937007874015748, top: 0.3149606299212598, bottom: 0.3937007874015748, header: 0.3149606299212598, footer: 0.1968503937007874 },
  };
  ws.headerFooter.oddFooter = `&C第&P頁，共&N頁`;

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
    ['VBA匯入筆數', vbaRows.length], ['VBA資料校驗碼(SHA-256)', await sha256(vbaChecksumText(vbaRows))], ['說明', '本檔「VBA匯入資料」工作表與上方報告頁由同一份資料產生。若報告有更正，請產生新版次，不要手改本檔。'],
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
  const buf = await wb.xlsx.writeBuffer();
  if (!braces.length) return buf;
  try { return await addBraces(buf, sheetName, braces, (r) => ws.getRow(r).height || 34.2); }
  catch (e) { console.warn('加入併車括號失敗，已輸出不含括號的報告：', e); return buf; }
}

// ---------- 把「右大括弧」形狀加進已產生的 xlsx ----------
const EMU_PT = 12700;
function braceXml(id, r1, r2, h1, h2) {
  // 與範本相同：藍色(0000CC)、線寬 1pt、rightBrace；位置貼在 O 欄（括號欄）
  const inset = 40000;
  return `<xdr:twoCellAnchor><xdr:from><xdr:col>14</xdr:col><xdr:colOff>2000</xdr:colOff><xdr:row>${r1 - 1}</xdr:row><xdr:rowOff>${inset}</xdr:rowOff></xdr:from><xdr:to><xdr:col>14</xdr:col><xdr:colOff>48000</xdr:colOff><xdr:row>${r2 - 1}</xdr:row><xdr:rowOff>${Math.max(0, Math.round(h2 * EMU_PT) - inset)}</xdr:rowOff></xdr:to>` +
    `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="右大括弧 ${id - 1}"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="45719" cy="1000000"/></a:xfrm><a:prstGeom prst="rightBrace"><a:avLst><a:gd name="adj1" fmla="val 64474"/><a:gd name="adj2" fmla="val 11318"/></a:avLst></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="0000CC"/></a:solidFill></a:ln></xdr:spPr>` +
    `<xdr:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></xdr:style>` +
    `<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip" rtlCol="0" anchor="t"/><a:lstStyle/><a:p><a:endParaRPr lang="zh-TW" altLang="en-US"/></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`;
}

async function addBraces(buf, sheetName, braces, heightOf) {
  const files = await readZip(buf);
  const txt = (n) => _td.decode(files.get(n));
  // 找出報告頁對應的 sheet 檔
  const wbXml = txt('xl/workbook.xml'), rels = txt('xl/_rels/workbook.xml.rels');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sm = wbXml.match(new RegExp(`<sheet [^>]*name="${esc(sheetName)}"[^>]*>`));
  if (!sm) throw new Error('找不到報告工作表');
  const rid = sm[0].match(/r:id="([^"]+)"/)[1];
  const rm = rels.match(new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*>`))[0];
  const target = rm.match(/Target="([^"]+)"/)[1].replace(/^\/?(xl\/)?/, '');
  const sheetPath = `xl/${target}`;
  const relPath = `xl/worksheets/_rels/${sheetPath.split('/').pop()}.rels`;

  const drawingPath = 'xl/drawings/drawing_braces.xml';
  const body = braces.map((b, i) => braceXml(i + 2, b.r1, b.r2, heightOf(b.r1), heightOf(b.r2))).join('');
  files.set(drawingPath, _te.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${body}</xdr:wsDr>`));

  // 工作表關聯
  const relType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
  let relId;
  if (files.has(relPath)) {
    let rx = txt(relPath);
    relId = 'rIdBr1';
    rx = rx.replace('</Relationships>', `<Relationship Id="${relId}" Type="${relType}" Target="../drawings/drawing_braces.xml"/></Relationships>`);
    files.set(relPath, _te.encode(rx));
  } else {
    relId = 'rId1';
    files.set(relPath, _te.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${relId}" Type="${relType}" Target="../drawings/drawing_braces.xml"/></Relationships>`));
  }
  // 工作表本體加 <drawing>（位置需在 pageSetup/headerFooter/rowBreaks 之後、legacyDrawing/tableParts/extLst 之前）
  let sx = txt(sheetPath);
  if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  const tag = `<drawing r:id="${relId}"/>`;
  const m = sx.match(/<(legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[ />]/);
  sx = m ? sx.slice(0, m.index) + tag + sx.slice(m.index) : sx.replace('</worksheet>', `${tag}</worksheet>`);
  files.set(sheetPath, _te.encode(sx));
  // Content types
  let ct = txt('[Content_Types].xml');
  if (!ct.includes('/xl/drawings/drawing_braces.xml')) ct = ct.replace('</Types>', '<Override PartName="/xl/drawings/drawing_braces.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  files.set('[Content_Types].xml', _te.encode(ct));
  return await writeZip(files);
}
