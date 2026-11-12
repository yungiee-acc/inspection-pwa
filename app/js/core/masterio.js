// 管理資料的 Excel 匯出／匯入（廠商、品項對照）。純邏輯，不碰資料庫與畫面。
// 原則：
//  - 以「廠商代號」「ERP品號」比對；灰色欄（簡稱、全名、品名、單位）是唯讀參考，只用來偵測拿錯檔。
//  - 只更新檔案裡出現的列；檔案沒有的廠商／品項一律不動、不刪。
//  - 任何一列有錯誤 → 整檔不套用（applicable=false）。警告不擋，但要使用者看過。
//  - ERP 品號與品名以最新版 ERP 主檔為準，這裡永遠不能新增或改它們，只能補「報告 D 欄名稱」。

export const SHEET_VENDOR = '廠商';
export const SHEET_ERP = '品項對照';
const VEN_HEAD = ['廠商代號', '廠商簡稱(既有唯讀)', '廠商全名(既有唯讀)', '報告顯示名稱', '納入手機選單(Y/空白)'];
const ERP_HEAD = ['ERP品號', 'ERP品名(唯讀)', '單位(唯讀)', '報告D欄名稱'];

const T = (v) => (v == null ? '' : String(v).replace(/　/g, ' ').trim());
const YES = new Set(['y', 'yes', 'true', '1', '是', '✔', '✓', 'v', 'x', '納入']);
const NO = new Set(['', 'n', 'no', 'false', '0', '否', '不']);

export function buildExportAoa(masters) {
  const ven = [VEN_HEAD, ...masters.vendors.map((v) => [v.code, v.short_name, v.full_name, v.report_name || '', v.in_scope ? 'Y' : ''])];
  const erp = [ERP_HEAD, ...masters.erpItems.map((i) => [i.code, i.name, i.unit || '', i.report_name || ''])];
  const help = [
    ['進貨查驗系統｜管理資料維護檔'],
    [''],
    ['使用方式'],
    ['1. 只修改「報告顯示名稱」「納入手機選單」「報告D欄名稱」三種欄位。標示「唯讀」的欄位請勿修改（僅供對照，改了會被視為拿錯檔）。'],
    ['2. 「ERP品號」不能新增（請先更新 ERP 品號主檔）。「廠商」可以新增：在廠商工作表最下面新增一列，填「廠商代號、廠商簡稱、廠商全名」（全名必須與環資 Excel 的廠商名稱一字不差），其餘欄位視需要填。既有廠商的代號、簡稱、全名請勿修改。'],
    ['3. 「納入手機選單」填 Y（或 是、1）代表納入；空白代表不納入。'],
    ['4. 「報告顯示名稱」留空＝使用廠商簡稱。'],
    ['5. 「報告D欄名稱」不可在這裡清空（要清空請到管理畫面操作）。'],
    ['6. 回到系統「管理 → Excel 維護」匯入，會先顯示差異，確認後才套用。'],
    ['7. 檔案裡沒有出現的廠商／品項不會被改動。有任何一列錯誤，整檔都不會套用。'],
  ];
  return { help, ven, erp };
}

export function buildExportWorkbook(XLSX, masters) {
  const { help, ven, erp } = buildExportAoa(masters);
  const wb = XLSX.utils.book_new();
  const mk = (aoa, widths) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = widths.map((w) => ({ wch: w })); return ws; };
  const wsHelp = XLSX.utils.aoa_to_sheet(help); wsHelp['!cols'] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wsHelp, '說明');
  XLSX.utils.book_append_sheet(wb, mk(ven, [10, 16, 34, 28, 20]), SHEET_VENDOR);
  XLSX.utils.book_append_sheet(wb, mk(erp, [10, 28, 8, 30]), SHEET_ERP);
  return wb;
}

function sheetRows(XLSX, wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

function headerIndex(head, expected) {
  // 以標題文字（去掉括號註記）找欄位，容許欄位順序被調整
  const clean = (s) => T(s).replace(/[（(].*?[)）]/g, '');
  const idx = {};
  for (const e of expected) idx[e] = (head || []).findIndex((c) => clean(c) === clean(e));
  return idx;
}

/**
 * @returns {{errors, warnings, changes, applicable, stats}}
 *  changes: [{kind:'vendor_report_name'|'vendor_in_scope'|'erp_report_name', code, label, old, new}]
 */
export function parseMasterImport(buf, XLSX, masters) {
  const errors = []; const warnings = []; const changes = [];
  const stats = { vendorRows: 0, erpRows: 0, unchanged: 0 };
  const err = (sheet, row, msg) => errors.push({ sheet, row, msg });
  const warn = (sheet, row, msg) => warnings.push({ sheet, row, msg });

  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); } catch (e) { return { errors: [{ sheet: '', row: 0, msg: '無法讀取這個檔案，請確認是 Excel（.xlsx）檔' }], warnings, changes, applicable: false, stats }; }

  const vRows = sheetRows(XLSX, wb, SHEET_VENDOR);
  const eRows = sheetRows(XLSX, wb, SHEET_ERP);
  if (!vRows && !eRows) return { errors: [{ sheet: '', row: 0, msg: `找不到「${SHEET_VENDOR}」或「${SHEET_ERP}」工作表。請使用本系統匯出的檔案` }], warnings, changes, applicable: false, stats };

  const vMap = new Map(masters.vendors.map((v) => [v.code, v]));
  const eMap = new Map(masters.erpItems.map((i) => [i.code, i]));
  const knownD = new Set(masters.erpItems.map((i) => T(i.report_name)).filter(Boolean));

  // ---- 廠商
  if (vRows) {
    const ix = headerIndex(vRows[0], ['廠商代號', '廠商簡稱', '廠商全名', '報告顯示名稱', '納入手機選單']);
    if (ix['廠商代號'] < 0 || ix['報告顯示名稱'] < 0 || ix['納入手機選單'] < 0) err(SHEET_VENDOR, 1, '標題列缺少「廠商代號／報告顯示名稱／納入手機選單」，請使用本系統匯出的檔案');
    else {
      const seen = new Set();
      vRows.slice(1).forEach((r, k) => {
        const row = k + 2;
        const code = T(r[ix['廠商代號']]);
        if (!code) return;
        stats.vendorRows++;
        if (seen.has(code)) { err(SHEET_VENDOR, row, `廠商代號 ${code} 在檔案中重複出現`); return; }
        seen.add(code);
        const v = vMap.get(code);
        if (!v) {
          // 新增廠商：代號、簡稱、全名都要填。全名是與環資比對的依據，必須與環資 Excel 的廠商名稱一字不差
          const sn = ix['廠商簡稱'] >= 0 ? T(r[ix['廠商簡稱']]) : '';
          const fn = ix['廠商全名'] >= 0 ? T(r[ix['廠商全名']]) : '';
          if (!sn || !fn) { err(SHEET_VENDOR, row, `廠商代號 ${code} 不在廠商主檔。若要新增廠商，請同時填「廠商簡稱」與「廠商全名」；若只是代號打錯請修正`); return; }
          if (/\s/.test(code)) { err(SHEET_VENDOR, row, `廠商代號「${code}」不可含空白`); return; }
          const dupName = masters.vendors.find((x) => x.full_name.replace(/\s/g, '') === fn.replace(/\s/g, '')) || changes.find((c) => c.kind === 'vendor_add' && c.full_name.replace(/\s/g, '') === fn.replace(/\s/g, ''));
          if (dupName) { err(SHEET_VENDOR, row, `新增廠商 ${code} 的全名「${fn}」與既有廠商（${dupName.code}）相同；全名必須唯一，否則環資無法配對`); return; }
          const nm = T(r[ix['報告顯示名稱']]);
          const fg = T(r[ix['納入手機選單']]).toLowerCase();
          if (!YES.has(fg) && !NO.has(fg)) { err(SHEET_VENDOR, row, `${code}「納入手機選單」的值「${fg}」看不懂，請填 Y 或留空`); return; }
          if (!/^[A-Za-z]\d{3}$/.test(code)) warn(SHEET_VENDOR, row, `新增廠商代號「${code}」不是常見格式（英文字母＋3 位數字），請確認`);
          warn(SHEET_VENDOR, row, `新增廠商 ${code}：全名「${fn}」必須與環資 Excel 上的廠商名稱一字不差，否則配對不到`);
          changes.push({ kind: 'vendor_add', code, label: `${code} ${sn}｜新增廠商`, old: '（新廠商）', new: `${sn}｜${fn}${nm ? `｜顯示名稱 ${nm}` : ''}${YES.has(fg) ? '｜納入手機選單' : ''}`, short_name: sn, full_name: fn, report_name: nm, in_scope: YES.has(fg) });
          return;
        }
        if (ix['廠商全名'] >= 0 && T(r[ix['廠商全名']]) && T(r[ix['廠商全名']]) !== T(v.full_name)) { err(SHEET_VENDOR, row, `${code} 的廠商全名與系統不符（檔案「${T(r[ix['廠商全名']])}」／系統「${v.full_name}」），可能是舊檔或改到唯讀欄，請重新匯出`); return; }
        const newName = T(r[ix['報告顯示名稱']]);
        const flagRaw = T(r[ix['納入手機選單']]).toLowerCase();
        let flag;
        if (YES.has(flagRaw)) flag = true; else if (NO.has(flagRaw)) flag = false;
        else { err(SHEET_VENDOR, row, `${code}「納入手機選單」的值「${flagRaw}」看不懂，請填 Y 或留空`); return; }
        let changed = false;
        if (newName !== T(v.report_name)) { changes.push({ kind: 'vendor_report_name', code, label: `${code} ${v.short_name}｜報告顯示名稱`, old: T(v.report_name), new: newName }); changed = true; }
        if (flag !== !!v.in_scope) { changes.push({ kind: 'vendor_in_scope', code, label: `${code} ${v.short_name}｜納入手機選單`, old: v.in_scope ? 'Y' : '空白', new: flag ? 'Y' : '空白' }); changed = true; }
        if (!changed) stats.unchanged++;
      });
    }
  }

  // ---- 品項對照
  if (eRows) {
    const ix = headerIndex(eRows[0], ['ERP品號', 'ERP品名', '單位', '報告D欄名稱']);
    if (ix['ERP品號'] < 0 || ix['報告D欄名稱'] < 0) err(SHEET_ERP, 1, '標題列缺少「ERP品號／報告D欄名稱」，請使用本系統匯出的檔案');
    else {
      const seen = new Set();
      eRows.slice(1).forEach((r, k) => {
        const row = k + 2;
        const code = T(r[ix['ERP品號']]);
        if (!code) return;
        stats.erpRows++;
        if (seen.has(code)) { err(SHEET_ERP, row, `ERP品號 ${code} 在檔案中重複出現`); return; }
        seen.add(code);
        const it = eMap.get(code);
        if (!it) { err(SHEET_ERP, row, `ERP品號 ${code} 不在 ERP 品號主檔（不能在這裡新增品號，請先更新 ERP 主檔）`); return; }
        if (ix['ERP品名'] >= 0 && T(r[ix['ERP品名']]) && T(r[ix['ERP品名']]) !== T(it.name)) { err(SHEET_ERP, row, `${code} 的品名與系統不符（檔案「${T(r[ix['ERP品名']])}」／系統「${it.name}」），請重新匯出`); return; }
        const nv = T(r[ix['報告D欄名稱']]); const ov = T(it.report_name);
        if (nv === ov) { stats.unchanged++; return; }
        if (!nv) { err(SHEET_ERP, row, `${code} ${it.name}：不可在匯入時清空 D 欄對照名稱（原為「${ov}」）。要清空請到管理畫面操作，或把原名稱填回`); return; }
        if (ov) warn(SHEET_ERP, row, `${code} ${it.name}：將覆蓋既有對照名稱「${ov}」→「${nv}」，請確認`);
        else if (!knownD.has(nv)) warn(SHEET_ERP, row, `${code} ${it.name}：「${nv}」是目前 D 欄清單沒有的新名稱，請確認拼寫與年度`);
        changes.push({ kind: 'erp_report_name', code, label: `${code} ${it.name}｜報告D欄名稱`, old: ov, new: nv });
      });
    }
  }

  return { errors, warnings, changes, applicable: errors.length === 0 && changes.length > 0, stats };
}

/** 依序套用；回傳 {done, failed:[{change,message}]}。失敗不回滾已套用者（資料庫沒有跨列交易），會明確回報。 */
export async function applyMasterChanges(db, changes) {
  let done = 0; const failed = [];
  for (const c of changes) {
    try {
      if (c.kind === 'vendor_add') await db.addVendor({ code: c.code, short_name: c.short_name, full_name: c.full_name, report_name: c.report_name || null, in_scope: !!c.in_scope });
      else if (c.kind === 'vendor_report_name') await db.setVendorReportName(c.code, c.new);
      else if (c.kind === 'vendor_in_scope') await db.setVendorInScope(c.code, c.new === 'Y');
      else if (c.kind === 'erp_report_name') await db.setErpReportName(c.code, c.new);
      done++;
    } catch (e) { failed.push({ change: c, message: e.message }); }
  }
  return { done, failed };
}
