// 管理員：品項對照名稱（ERP D 欄）、廠商報告顯示名稱、異動紀錄、備份
import { $, $$, h, esc, toast, confirmBox, badge, download } from './common.js';
import { fmtDateTime } from '../core/util.js';

export async function renderAdmin(app, host) {
  const view = h('<div></div>'); host.appendChild(view);
  let tab = 'erp';
  const tabs = [['erp', '品項對照'], ['ven', '廠商'], ...(app.db.mode === 'supabase' ? [['usr', '使用者']] : []), ['audit', '異動紀錄'], ['sys', '備份／系統']];
  view.innerHTML = `<h2>管理</h2><div class="tabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tb"></div>`;
  $$('[data-t]', view).forEach((b) => b.onclick = () => { tab = b.dataset.t; $$('[data-t]', view).forEach((x) => x.classList.toggle('on', x === b)); draw(); });

  async function draw() {
    const tb = $('#tb', view);
    if (tab === 'erp') {
      const items = app.masters.erpItems, blanks = items.filter((i) => !i.report_name);
      tb.innerHTML = `<div class="card info small">對照名稱 = ERP 品號主檔 D 欄「對照查驗報告」。<b>以最新版 ERP 主檔為唯一依據</b>；目前有 ${blanks.length} 筆空白（進貨少、尚未確認正式名稱）。空白品項仍可正常查驗儲存，但要輸出含它們的正式報告前，必須在這裡補齊。<br>⚠ 補齊後請同步更新你的 ERP 主檔 Excel，避免兩邊不一致。</div>
        ${items.map((i) => `<div class="card ${i.report_name ? '' : 'warn'}"><div><b>${esc(i.code)}</b> ${esc(i.name)} <span class="small muted">單位 ${esc(i.unit)}</span></div>
          <div style="display:flex;gap:8px;margin-top:6px"><input data-c="${esc(i.code)}" value="${esc(i.report_name || '')}" placeholder="（空白：尚未對照）"><button class="sm" data-s="${esc(i.code)}">儲存</button></div></div>`).join('')}`;
      $$('[data-s]', tb).forEach((b) => b.onclick = async () => {
        const code = b.dataset.s, val = $(`[data-c="${code}"]`, tb).value.trim();
        const old = items.find((i) => i.code === code).report_name || '';
        if (val === old) { toast('沒有變更'); return; }
        if (!await confirmBox(`品號 ${code} 的報告對照名稱：\n「${old || '空白'}」→「${val || '空白'}」\n\n確定變更？（會影響之後的配對與報告；已審核的報告不受影響）`, { okText: '儲存' })) return;
        try { await app.db.setErpReportName(code, val); await app.reloadMasters(); toast('已儲存', 'ok'); draw(); } catch (e) { toast('儲存失敗：' + e.message, 'er', 5000); }
      });
    } else if (tab === 'ven') {
      tb.innerHTML = `<div class="card info small">「報告顯示名稱」是印在報告「回收商」欄的文字。留空則使用廠商簡稱。目前已預填範例報告上出現過的 5 家（鍊金寶、呈泓興業、協治企業、金祥達、鈞城），<b>請確認</b>；其餘廠商首次出現在報告時請在此設定。</div>
        <input id="vs" placeholder="搜尋廠商代號／名稱" style="margin-bottom:8px"><div id="vl"></div>`;
      const paint = () => {
        const k = $('#vs', tb).value.trim().toLowerCase();
        const vs = app.masters.vendors.filter((v) => !k || [v.code, v.short_name, v.full_name].some((s) => s.toLowerCase().includes(k))).slice(0, 80);
        $('#vl', tb).innerHTML = vs.map((v) => `<div class="card"><div><b>${esc(v.code)}</b> ${esc(v.short_name)} ${v.in_scope ? badge('納入本次測試', 'g') : ''}<br><span class="small muted">${esc(v.full_name)}</span></div>
          <div style="display:flex;gap:8px;margin-top:6px"><input data-vc="${esc(v.code)}" value="${esc(v.report_name || '')}" placeholder="報告顯示名稱（空白＝${esc(v.short_name)}）"><button class="sm" data-vs="${esc(v.code)}">儲存</button></div>
          <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0 0"><input type="checkbox" data-sc="${esc(v.code)}" ${v.in_scope ? 'checked' : ''} style="width:auto;min-height:0"> 納入手機廠商選單</label></div>`).join('') + (app.masters.vendors.length > 80 ? '<p class="muted small">僅顯示前 80 筆，請用搜尋縮小範圍</p>' : '');
        $$('[data-vs]', tb).forEach((b) => b.onclick = async () => { try { await app.db.setVendorReportName(b.dataset.vs, $(`[data-vc="${b.dataset.vs}"]`, tb).value.trim()); await app.reloadMasters(); toast('已儲存', 'ok'); } catch (e) { toast('儲存失敗：' + e.message, 'er', 5000); } });
        $$('[data-sc]', tb).forEach((c) => c.onchange = async () => { try { await app.db.setVendorInScope(c.dataset.sc, c.checked); await app.reloadMasters(); toast('已更新', 'ok'); } catch (e) { toast('失敗：' + e.message, 'er'); } });
      };
      $('#vs', tb).oninput = paint; paint();
    } else if (tab === 'usr') {
      const ps = await app.db.listProfiles();
      tb.innerHTML = `<div class="card info small">帳號由 Supabase 後台「Authentication → Users」建立（登入方式尚未定案，目前暫用電子郵件＋密碼）。新帳號預設<b>停用</b>，請在這裡設定姓名、角色並啟用。</div>
        ${ps.map((p) => `<div class="card ${p.active ? '' : 'warn'}"><div style="display:flex;gap:8px"><input data-n="${p.id}" value="${esc(p.display_name)}"></div>
          <div class="row2" style="margin-top:8px"><select data-r="${p.id}">${['inspector', 'office', 'admin'].map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${{ inspector: '一般使用者', office: '審核者', admin: '後台管理者' }[r]}</option>`).join('')}</select>
          <select data-a="${p.id}"><option value="1" ${p.active ? 'selected' : ''}>啟用</option><option value="0" ${p.active ? '' : 'selected'}>停用</option></select></div>
          <div class="actions"><button class="sm" data-u="${p.id}">儲存</button></div></div>`).join('')}`;
      $$('[data-u]', tb).forEach((b) => b.onclick = async () => {
        const id = b.dataset.u;
        try { await app.db.updateProfile(id, { display_name: $(`[data-n="${id}"]`, tb).value.trim(), role: $(`[data-r="${id}"]`, tb).value, active: $(`[data-a="${id}"]`, tb).value === '1' }); toast('已儲存', 'ok'); }
        catch (e) { toast('儲存失敗：' + e.message, 'er', 5000); }
      });
    } else if (tab === 'audit') {
      tb.innerHTML = '<p class="muted">載入中…</p>';
      const rows = await app.db.listAudit({ limit: 150 });
      tb.innerHTML = `<div class="scroll"><table class="tbl"><tr><th>時間</th><th>人員</th><th>資料表</th><th>主鍵</th><th>動作</th><th>原因／內容</th></tr>${rows.map((a) => `<tr><td class="small">${esc(fmtDateTime(a.at))}</td><td>${esc(a.actor_name || '')}</td><td>${esc(a.table_name)}</td><td class="small">${esc(a.pk)}</td><td>${esc(a.action)}</td><td class="small">${esc(a.new?.change_reason || a.new?.reason || a.new?.note || '')}</td></tr>`).join('')}</table></div>${rows.length ? '' : '<p class="muted">沒有紀錄</p>'}`;
    } else {
      tb.innerHTML = `<div class="card"><b>備份</b><p class="small">下載所有資料（JSON）。建議每週備份一次並存放在公司雲端硬碟。${app.db.mode === 'supabase' ? '<br>Supabase 免費方案<b>沒有</b>自動備份，請務必定期執行。' : ''}</p><button id="bk">下載完整備份</button></div>
        <div class="card small"><b>系統資訊</b><br>模式：${app.db.mode === 'supabase' ? '正式（共用資料庫）' : '示範（只存在本機）'}<br>ERP 品號：${app.masters.erpItems.length} 筆（已對照 ${app.masters.erpItems.filter((i) => i.report_name).length}）<br>廠商：${app.masters.vendors.length} 筆</div>
        ${app.db.mode === 'local' ? '<div class="card err small"><b>清除示範資料</b><p>會刪除這台裝置上所有示範資料（查驗、環資、報告）。</p><button class="dng" id="rs">清除</button></div>' : ''}`;
      $('#bk', tb).onclick = async () => { try { const d = await app.db.exportBackup(); download(JSON.stringify(d, null, 1), `進貨查驗備份_${new Date().toISOString().slice(0, 10)}.json`, 'application/json'); toast('已下載', 'ok'); } catch (e) { toast('備份失敗：' + e.message, 'er', 5000); } };
      const rs = $('#rs', tb); if (rs) rs.onclick = async () => { if (await confirmBox('確定清除所有示範資料？無法復原。', { danger: true, okText: '清除' })) { app.db.resetLocal(); location.reload(); } };
    }
  }
  await draw();
}
