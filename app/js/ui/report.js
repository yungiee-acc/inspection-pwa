// 報告：預覽 → 審核 → 正式 Excel；版本、審核狀態、更正紀錄
import { $, $$, h, esc, toast, modal, confirmBox, promptBox, badge, can, loadExcelJs, download } from './common.js';
import { loadMatchContext } from './office.js';
import { buildReportModel, buildVbaRows, hashPayload, reportFileName } from '../core/report.js';
import { exportReportXlsx, statusLabel } from '../core/exporter.js';
import { sha256, stableStringify, fmtDateTime, fmtKg } from '../core/util.js';
import { RULES } from '../core/config.js';

/** 依目前資料算出報告模型與校驗碼（建立草稿、檢查是否過期都用它） */
export async function computeReport(app, ctx) {
  const reportModel = buildReportModel({ model: ctx.model, vendors: app.masters.vendors, weighDate: ctx.date });
  const vbaRows = buildVbaRows(reportModel, { reportId: '', version: 0, status: 'draft', dataHash: '' }, app.masters.erpItems);
  const dataHash = await sha256(stableStringify(hashPayload(vbaRows, ctx.model)));
  return { reportModel, vbaRows, dataHash, inspectionIds: vbaRows.map((r) => r.InspectionID) };
}

function previewHtml(rm, info) {
  const stamp = info.status === 'approved' ? `<span class="stamp" style="color:#1d7a3a;border-color:#1d7a3a">已審核 v${info.version}</span>`
    : info.status === 'superseded' ? `<span class="stamp" style="color:#888;border-color:#888">已被新版取代 v${info.version}</span>`
    : `<span class="stamp" style="color:#b26a00;border-color:#b26a00">草稿 v${info.version}（未審核）</span>`;
  return rm.pages.map((pg, pi) => `<div class="scroll"><div class="rpt">
    <h4>應回收廢棄物(廢塑膠容器類)  進廠查驗紀錄表</h4>
    <div class="meta"><span>受補貼機構：永溢綠能材料股份有限公司</span><span>${stamp}　稽核日期： ${esc(rm.roc.text)}</span></div>
    <table><tr><th rowspan="2" style="width:11%">出貨序號</th><th rowspan="2">回收商</th><th rowspan="2">車號</th><th rowspan="2">容器項目</th><th rowspan="2">磚數</th><th rowspan="2">總重</th><th rowspan="2">空重</th><th rowspan="2">粗重</th><th rowspan="2">抽驗<br>項目</th><th rowspan="2">樣磚<br>代號</th><th rowspan="2">樣磚<br>毛重</th><th colspan="2">扣重</th><th rowspan="2" style="width:20%">雜質/備註</th></tr><tr><th>含水重</th><th>雜質重</th></tr>
    ${pg.map((r) => {
      if (!r) return '<tr>' + '<td></td>'.repeat(8) + '<td>□</td>' + '<td></td>'.repeat(5) + '</tr>';
      const h2 = r.hz, first = r.tripIndex === 0, s = r.sample;
      return `<tr>${first ? `<td>${esc(h2.ship_no.slice(0, 9))} <b style="color:#1f5fa8">${esc(h2.ship_no.slice(9))}</b></td><td>${esc(r.trip.vendorDisplay)}</td><td>${esc(r.trip.vehicle_no)}</td>` : '<td></td><td></td><td></td>'}
        <td style="font-size:12px">${esc(h2.item_name)}</td><td>${h2.bricks}</td><td class="n">${fmtKg(h2.gross_kg)}</td><td class="n">${fmtKg(h2.tare_kg)}</td><td class="n">${fmtKg(h2.gross_kg - h2.tare_kg)}</td>
        <td>${r.inspection ? '▓' : '□'}</td><td>${s ? esc(s.code) : ''}</td><td>${s ? esc(s.gross) : ''}</td><td>${s ? esc(s.water) : ''}</td><td>${s ? esc(s.impurity) : ''}</td><td class="l">${esc(r.pText || '')}</td></tr>`;
    }).join('')}</table>
    <div class="sig"><div>受補貼機構簽章</div><div>稽核員簽章</div></div><div class="pg">第 ${pi + 1} 頁，共 ${rm.pages.length} 頁</div></div></div>`).join('');
}

export async function renderReport(app, host, params) {
  const view = h('<div></div>'); host.appendChild(view);
  const isAdmin = can(app, 'admin'), canApprove = can(app, 'office', 'admin'), me = app.profile.display_name;
  let date = params.date || null, sel = null;

  const dates = await app.db.listHzDates();
  if (!date && dates.length) date = dates[0].date;
  view.innerHTML = `<h2>查驗報告</h2>${dates.length ? `<div class="card"><label style="margin-top:0">報告日期</label><select id="dsel">${dates.map((d) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${d.date}</option>`).join('')}</select></div>` : '<div class="card info">還沒有環資資料，請先到「環資配對」匯入。</div>'}<div id="body"></div>`;
  const ds = $('#dsel', view); if (ds) ds.onchange = () => { date = ds.value; sel = null; draw(); };
  if (!date) return;

  async function draw() {
    const body = $('#body', view); body.innerHTML = '<p class="muted">載入中…</p>';
    const ctx = await loadMatchContext(app, date);
    const reports = await app.db.listReports(date);
    const cur = await computeReport(app, ctx);
    const latest = reports[0] || null;
    const shown = (sel && reports.find((r) => r.id === sel)) || reports.find((r) => r.status === 'approved') || latest;
    const hasDraft = reports.some((r) => r.status === 'draft');
    const model = ctx.model;
    const stale = !!shown && shown.data_hash !== cur.dataHash; // 此版次的內容是否已和目前資料不同

    let html = '';
    // ---- 前置條件
    if (!model.ready) html += `<div class="card warn"><b>還不能產生新版次：尚有 ${model.blockers.length} 項待處理</b><ul class="small" style="margin:4px 0 0 18px;padding:0">${model.blockers.slice(0, 8).map((b) => `<li>${esc(b.msg)}</li>`).join('')}</ul><div class="actions"><a class="btn sm" href="#/office?date=${date}">回到配對處理</a></div></div>`;
    else if (!hasDraft && (!latest || latest.data_hash !== cur.dataHash)) {
      html += `<div class="card okc"><b>✔ 配對已全部確認</b>${latest ? '<div class="small">目前資料與最新版次不同，需要建立新版次（需填更正原因）。</div>' : ''}<div class="actions"><button id="mk">${latest ? `建立更正版次 v${latest.version + 1}` : '建立報告預覽（v1）'}</button></div></div>`;
    } else if (!hasDraft && latest && latest.data_hash === cur.dataHash) html += '<div class="card okc small">目前資料與最新版次一致，不需要新版次。</div>';
    if (cur.reportModel.warnings.length) html += `<div class="card warn small"><b>報告提醒：</b><ul style="margin:4px 0 0 18px;padding:0">${[...new Set(cur.reportModel.warnings)].map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;

    // ---- 版本列表
    html += `<h3>版本與審核紀錄</h3>${reports.length ? `<div class="scroll"><table class="tbl"><tr><th>版次</th><th>狀態</th><th>製作</th><th>審核</th><th>原因／說明</th><th></th></tr>${reports.map((r) => `<tr ${shown?.id === r.id ? 'style="background:#e3f2ec"' : ''}><td>v${r.version}</td><td>${badge(statusLabel(r.status), r.status === 'approved' ? 'g' : r.status === 'draft' ? 'y' : '')}</td><td>${esc(r.created_by || '')}<br><span class="small muted">${esc(fmtDateTime(r.created_at))}</span></td><td>${r.approved_by ? `${esc(r.approved_by)}<br><span class="small muted">${esc(fmtDateTime(r.approved_at))}</span>` : '—'}</td><td class="small">${esc(r.reason || '')}</td><td><button class="sm sec" data-v="${r.id}">檢視</button></td></tr>`).join('')}</table></div>` : '<p class="muted small">尚無任何版次</p>'}`;

    // ---- 預覽
    if (shown) {
      const snap = shown.snapshot;
      html += `<h3>預覽：v${shown.version} ${esc(statusLabel(shown.status))}</h3>`;
      if (stale && shown.status !== 'superseded') html += `<div class="card ${shown.status === 'approved' ? 'warn' : 'err'} small"><b>${shown.status === 'approved' ? '注意：目前的查驗／配對資料已和這個已審核版次不同。' : '這份草稿已過期：資料在草稿建立後有變動。'}</b>${shown.status === 'approved' ? '正式報告仍以此版次為準；若要更正，請由管理員「解鎖更正」後建立新版次。' : '請刪除這份草稿並重新建立。'}</div>`;
      html += `<div class="actions noprint" style="margin:0 0 10px">
        ${shown.status === 'draft' && canApprove ? '<button id="ap">審核確認（正式生效）</button>' : ''}
        ${shown.status === 'draft' ? '<button class="sec dng" id="dd">刪除草稿</button>' : ''}
        ${shown.status === 'approved' ? '<button id="xl">下載正式報告 Excel</button>' : ''}
        ${shown.status === 'approved' && isAdmin ? '<button class="sec" id="ul">解鎖本日查驗（更正用）</button>' : ''}
        <button class="sec" id="pr">列印預覽</button></div>
        ${shown.status === 'draft' ? '<div class="small muted">草稿不能下載正式 Excel；請先審核確認。</div>' : ''}
        <div class="small muted noprint" style="margin-bottom:6px">下方畫面為示意排版；正式 Excel 依你提供的範例版型輸出（含「VBA匯入資料」與「報告資訊」工作表，共 ${snap.vbaRows.length} 筆查驗）。</div>
        ${previewHtml(snap.reportModel, { status: shown.status, version: shown.version })}`;
    }
    body.innerHTML = html;

    // ---- 事件
    $$('[data-v]', body).forEach((b) => b.onclick = () => { sel = b.dataset.v; draw(); });
    const mk = $('#mk', body);
    if (mk) mk.onclick = async () => {
      let reason = '初版';
      if (latest) { reason = await promptBox('請填寫這次更正的原因（會記錄在更正紀錄與正式報告的「報告資訊」）：', { title: `建立更正版次 v${latest.version + 1}`, placeholder: '例：序號 221740 樣磚毛重輸入錯誤，已更正' }); if (!reason) return; }
      mk.disabled = true;
      try {
        const r = await app.db.createReportDraft({ report_date: date, snapshot: { reportModel: cur.reportModel, vbaRows: cur.vbaRows }, data_hash: cur.dataHash, inspection_ids: cur.inspectionIds, reason });
        sel = r.id; toast('已建立草稿，請檢查預覽後審核', 'ok'); draw();
      } catch (e) { toast('建立失敗：' + e.message, 'er', 6000); mk.disabled = false; }
    };
    const ap = $('#ap', body);
    if (ap) ap.onclick = async () => {
      if (stale) { toast('草稿已過期，請刪除後重建', 'er'); return; }
      if (!await confirmBox(`審核後 v${shown.version} 會成為正式版本，本日 ${cur.inspectionIds.length} 筆查驗將被鎖定，之後要更正需解鎖並建立新版次。\n\n確定審核？`, { okText: '審核確認' })) return;
      ap.disabled = true;
      try { await app.db.approveReport(shown.id); toast('已審核', 'ok'); draw(); } catch (e) { toast('審核失敗：' + e.message, 'er', 6000); ap.disabled = false; }
    };
    const dd = $('#dd', body);
    if (dd) dd.onclick = async () => { if (await confirmBox('確定刪除這份草稿？', { danger: true, okText: '刪除' })) { try { await app.db.deleteDraft(shown.id); sel = null; draw(); } catch (e) { toast(e.message, 'er'); } } };
    const pr = $('#pr', body); if (pr) pr.onclick = () => window.print();
    const ul = $('#ul', body);
    if (ul) ul.onclick = async () => {
      const reason = await promptBox('解鎖後，本日查驗可以被修改。請填寫原因：', { title: '解鎖更正', placeholder: '例：發現樣磚毛重輸入錯誤' }); if (!reason) return;
      try { await app.db.unlockDate(date, reason); toast('已解鎖。請到「查驗紀錄」更正，再回「環資配對」重新確認，最後建立新版次。', 'ok', 7000); draw(); } catch (e) { toast('解鎖失敗：' + e.message, 'er', 6000); }
    };
    const xl = $('#xl', body);
    if (xl) xl.onclick = async () => {
      xl.disabled = true; xl.textContent = '產生中…';
      try {
        await loadExcelJs();
        const tpl = await (await fetch('data/report_template.xlsx')).arrayBuffer();
        const snap = shown.snapshot;
        const meta = { reportId: `RPT-${date.replace(/-/g, '')}`, version: shown.version, status: 'approved', preparedBy: shown.created_by, approvedBy: shown.approved_by, approvedAt: shown.approved_at, createdAt: shown.created_at, dataHash: shown.data_hash };
        const vbaRows = snap.vbaRows.map((r) => ({ ...r, ReportId: meta.reportId, ReportVersion: meta.version, ReportStatus: 'approved', DataHash: meta.dataHash }));
        const changeLog = [...reports].reverse().map((r) => ({ version: r.version, reason: r.reason, by: r.created_by, at: r.created_at, status: r.status }));
        const buf = await exportReportXlsx({ ExcelJS: window.ExcelJS, templateBuf: tpl, reportModel: snap.reportModel, meta, vbaRows, changeLog, erpItems: app.masters.erpItems });
        download(buf, reportFileName(date, shown.version), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        toast('已下載正式報告', 'ok');
      } catch (e) { console.error(e); toast('匯出失敗：' + e.message, 'er', 7000); }
      xl.disabled = false; xl.textContent = '下載正式報告 Excel';
    };
  }
  await draw();
}
