// 辦公室：匯入環資 Excel、自動配對、異常處理（人工確認）
import { $, $$, h, esc, toast, modal, confirmBox, promptBox, badge, today, can, loadXlsx, bufferHash } from './common.js';
import { parseHz } from '../core/hz.js';
import { buildMatchModel, autoConfirmDecisions } from '../core/match.js';
import { fmtDateTime, taipeiDate, fmtKg } from '../core/util.js';

const dayRange = (ymd) => ({ from: `${ymd}T00:00:00+08:00`, to: new Date(new Date(`${ymd}T00:00:00+08:00`).getTime() + 86400000).toISOString() });

/** 載入某一天的環資＋查驗＋決定，並算出配對模型（報告頁也會用） */
export async function loadMatchContext(app, date) {
  const [hzRows, inspections, decisions] = await Promise.all([app.db.listHzRows(date), app.db.listInspections(dayRange(date)), app.db.listDecisions(date)]);
  const { erpItems, vendors } = app.masters;
  const model = buildMatchModel({ hzRows, inspections, erpItems, vendors, decisions });
  return { date, hzRows, inspections, decisions, model };
}

const STATE = {
  auto: ['建議配對（待確認）', 'y'], confirmed: ['已確認', 'g'], exception: ['異常：需人工選擇', 'r'], uninspected: ['未抽驗', ''],
  none_confirmed: ['已確認未抽驗', 'g'], stale: ['需重新確認', 'r'], conflict: ['重複確認', 'r'],
};
const inspLine = (i) => `樣磚 ${esc(i.raw.sample_code)}${i.raw.bricks ? `｜${i.raw.bricks} 磚` : ''}｜毛重 ${i.raw.gross_kg} kg｜雜質 ${i.raw.impurity_kg ?? 0}｜${esc(fmtDateTime(i.raw.inspected_at).slice(11))}｜${esc(i.raw.inspector_name)}`;

export async function renderOffice(app, host, params) {
  const view = h('<div></div>'); host.appendChild(view); // 本頁專屬容器（避免事件監聽器累積在共用的 #view 上）
  const isAdmin = can(app, 'admin');
  const me = app.profile.display_name;
  let date = params.date || null;
  let ctx = null;

  const mkDec = (choice, insp, extra = {}) => ({ choice, inspection_id: insp?.id || null, inspection_rev: insp?.rev ?? null, manual: false, note: '', decided_by: me, decided_at: new Date().toISOString(), ...extra });
  const save = async (list) => { await app.db.setDecisions(list, date); await refresh(); };

  view.innerHTML = '<h2>環資匯入與配對</h2><div id="imp"></div><div id="sel"></div><div id="main"></div>';

  // ---------------- 匯入
  $('#imp', view).innerHTML = `<div class="card"><b>① 匯入環資 Excel</b>
    <div class="hint">選擇當天的「進廠過磅報表」（.xls 或 .xlsx）。系統會先顯示預覽，確認後才存入。</div>
    <input type="file" id="file" accept=".xls,.xlsx" style="margin-top:8px"></div>`;
  $('#file', view).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      await loadXlsx();
      const buf = await file.arrayBuffer();
      const r = parseHz(buf, window.XLSX);
      const hash = await bufferHash(buf);
      const trips = new Set(r.rows.map((x) => x.ship_no)).size;
      const m = modal(`<h3>匯入預覽：${esc(file.name)}</h3>
        ${r.errors.length ? `<div class="card err"><b>無法匯入，請修正檔案：</b><ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${r.rows.length ? `<dl class="kv"><dt>過磅日期</dt><dd><b>${esc(r.weighDate)}</b></dd><dt>明細筆數</dt><dd>${r.rows.length} 筆（${trips} 趟出貨序號）</dd><dt>略過列</dt><dd>${r.skipped}（合計列、總筆數列等）</dd>
        <dt>淨重合計</dt><dd>${fmtKg(r.rows.reduce((a, x) => a + x.net_kg, 0))} kg</dd><dt>磚數合計</dt><dd>${r.rows.reduce((a, x) => a + x.bricks, 0)}</dd></dl>` : ''}
        ${r.warnings.length ? `<div class="card warn small"><b>提醒：</b><ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        ${r.rows.length ? `<div class="scroll"><table class="tbl"><tr><th>序號</th><th>廠商</th><th>車號</th><th>出貨序號</th><th>品項</th><th>磚</th><th>淨重</th></tr>${r.rows.map((x) => `<tr><td>${esc(x.seq_no)}</td><td>${esc(x.vendor_name)}</td><td>${esc(x.vehicle_no)}</td><td>${esc(x.ship_no)}</td><td>${esc(x.item_name)}</td><td>${x.bricks}</td><td>${x.net_kg}</td></tr>`).join('')}</table></div>` : ''}
        <div class="actions"><button class="sec" id="x">取消</button>${r.errors.length || !r.rows.length ? '' : '<button id="ok">確認匯入</button>'}</div>`);
      $('#x', m.el).onclick = () => m.close();
      const ok = $('#ok', m.el);
      if (ok) ok.onclick = async () => {
        ok.disabled = true;
        try {
          let res = await app.db.saveHzImport({ fileName: file.name, fileHash: hash, weighDate: r.weighDate, rows: r.rows });
          if (res.changed?.length) {
            if (res.approvedLock) toast(`有 ${res.changed.length} 筆與先前匯入內容不同，但該日報告已審核，不能覆蓋。請洽管理員。`, 'er', 6000);
            else if (await confirmBox(`有 ${res.changed.length} 筆（序號 ${res.changed.slice(0, 5).join('、')}${res.changed.length > 5 ? '…' : ''}）與先前匯入的內容不同。\n要用新檔案內容覆蓋嗎？（覆蓋後相關配對會要求重新確認）`, { okText: '覆蓋', danger: true })) {
              res = await app.db.saveHzImport({ fileName: file.name, fileHash: hash, weighDate: r.weighDate, rows: r.rows, overwrite: true });
            }
          }
          m.close();
          toast(`匯入完成：新增 ${res.added}、相同略過 ${res.same}${res.overwritten ? `、覆蓋 ${res.overwritten}` : ''}${res.dupFile ? '（此檔案先前已匯入過）' : ''}`, 'ok', 5000);
          date = r.weighDate; await drawSelector(); await refresh();
        } catch (err) { ok.disabled = false; toast('匯入失敗：' + err.message, 'er', 6000); }
      };
    } catch (err) { toast('讀取檔案失敗：' + err.message, 'er', 6000); }
    e.target.value = '';
  };

  // ---------------- 日期選擇
  async function drawSelector() {
    const dates = await app.db.listHzDates();
    if (!date && dates.length) date = dates[0].date;
    $('#sel', view).innerHTML = dates.length ? `<div class="card"><b>② 選擇要配對的日期</b>
      <select id="dsel" style="margin-top:8px">${dates.map((d) => `<option value="${d.date}" ${d.date === date ? 'selected' : ''}>${d.date}（${d.count} 筆）</option>`).join('')}</select></div>`
      : '<div class="card info small">還沒有匯入任何環資資料。請先在上方匯入。</div>';
    const s = $('#dsel', view); if (s) s.onchange = () => { date = s.value; refresh(); };
  }

  // ---------------- 主畫面
  async function refresh() {
    const main = $('#main', view);
    if (!date) { main.innerHTML = ''; return; }
    main.innerHTML = '<p class="muted">載入中…</p>';
    ctx = await loadMatchContext(app, date);
    draw();
  }

  function draw() {
    const { model } = ctx, S = model.summary, main = $('#main', view);
    const blockN = model.blockers.length;
    main.innerHTML = `
      <h3>③ 配對結果　${esc(date)}</h3>
      <div class="sum"><div><b>${S.trips}</b>趟車</div><div><b>${S.rows}</b>環資明細</div><div><b>${S.inspections}</b>當日查驗</div>
        <div><b>${S.confirmed}</b>已確認</div><div class="${S.auto ? 'bad' : ''}"><b>${S.auto}</b>建議待確認</div>
        <div class="${S.exception + S.stale ? 'bad' : ''}"><b>${S.exception + S.stale}</b>異常</div><div class="${S.orphans ? 'bad' : ''}"><b>${S.orphans}</b>無歸屬查驗</div>
        <div class="${S.tripsNoInspection ? 'bad' : ''}"><b>${S.tripsNoInspection}</b>整車無查驗</div></div>
      <div class="actions" style="margin:0 0 12px">
        ${S.auto ? `<button id="all">一鍵確認全部建議配對（${S.auto} 筆）</button>` : ''}
        <a class="btn ${model.ready ? '' : 'sec'}" href="#/report?date=${date}">${model.ready ? '④ 前往產生報告預覽' : '前往報告頁（尚有 ' + blockN + ' 項待處理）'}</a></div>
      ${blockN ? `<div class="card warn small"><b>尚未完成（${blockN} 項）：</b><ul style="margin:4px 0 0 18px;padding:0">${model.blockers.slice(0, 12).map((b) => `<li>${esc(b.msg)}</li>`).join('')}${blockN > 12 ? `<li>…還有 ${blockN - 12} 項</li>` : ''}</ul></div>` : '<div class="card okc"><b>✔ 所有項目都已處理，可以產生報告預覽。</b></div>'}
      ${model.orphans.filter((o) => !o.dismissed).length ? '<h3>無對應環資的查驗紀錄</h3>' + model.orphans.filter((o) => !o.dismissed).map(orphanCard).join('') : ''}
      <h3>全部趟次</h3>${model.trips.map(tripCard).join('')}
      ${model.orphans.filter((o) => o.dismissed).length ? `<h3>已排除的查驗（不納入報告）</h3>${model.orphans.filter((o) => o.dismissed).map((o) => `<div class="card small">${esc(o.inspection.id)}｜${esc(o.inspection.raw.vehicle_no)}｜原因：${esc(o.dismissed.note)} <button class="sm sec" data-a="undis" data-id="${esc(o.inspection.id)}">復原</button></div>`).join('')}` : ''}`;
    const all = $('#all', main); if (all) all.onclick = async () => { if (await confirmBox(`將確認 ${S.auto} 筆「唯一符合」的建議配對。\n請確定你已看過下方配對內容。`, { okText: '全部確認' })) save(autoConfirmDecisions(model, me)); };
  }

  const rowActions = (r) => {
    const seq = r.hz.seq_no, a = [];
    if (r.state === 'auto') a.push(`<button class="sm" data-a="ok" data-seq="${seq}">確認</button>`);
    if (r.state === 'stale') { if (r.suggested) a.push(`<button class="sm" data-a="ok" data-seq="${seq}">重新確認</button>`); a.push(`<button class="sm sec" data-a="undo" data-seq="${seq}">取消先前決定</button>`); }
    if (['confirmed', 'none_confirmed', 'conflict'].includes(r.state)) a.push(`<button class="sm sec" data-a="undo" data-seq="${seq}">取消</button>`);
    if (r.state === 'exception') {
      a.push(`<select data-sel="${seq}" style="min-height:36px;padding:4px"><option value="">選擇符合的查驗…</option>${r.candidates.map((c) => `<option value="${esc(c.id)}">${esc(c.raw.sample_code)}${c.raw.bricks ? `｜${c.raw.bricks}磚` : ''}｜${c.raw.gross_kg}kg｜${esc(fmtDateTime(c.raw.inspected_at).slice(11))}｜${esc(c.raw.inspector_name)}</option>`).join('')}</select>`);
      a.push(`<button class="sm" data-a="pick" data-seq="${seq}">確認此筆</button>`);
    }
    if (['exception', 'uninspected', 'auto'].includes(r.state)) a.push(`<button class="sm sec" data-a="manual" data-seq="${seq}">手動指定查驗</button>`);
    if (['exception', 'auto'].includes(r.state)) a.push(`<button class="sm sec" data-a="none" data-seq="${seq}">此列未抽驗</button>`);
    return a.join(' ');
  };

  function tripCard(t) {
    const tb = { ok: ['已有查驗', 'g'], pending: ['待處理', 'y'], none_confirmed: ['已確認本車未抽驗', 'g'], no_inspection: ['整車無查驗紀錄', 'r'] }[t.state];
    return `<div class="card ${t.state === 'no_inspection' ? 'err' : ''}">
      <div><b>${esc(t.vehicle_no)}</b>　${esc(t.vendor_name)}　<span class="small muted">出貨序號 ${esc(t.ship_no)}</span></div>
      <div style="margin:4px 0">${badge(tb[0], tb[1])}${t.flags.map((f) => badge(f.msg, f.level === 'warn' ? 'y' : '')).join('')}</div>
      ${t.rows.map((r) => {
        const pair = r.confirmed || r.suggested;
        const [sl, sc] = STATE[r.state];
        return `<div style="border-top:1px solid var(--bd);padding:8px 0">
          <div class="t1"><span>${esc(r.hz.item_name)}</span><span class="small">${r.hz.bricks} 磚｜淨重 ${fmtKg(r.hz.net_kg)} kg</span></div>
          <div>${badge(sl, sc)}${r.flags.map((f) => badge(f.msg, f.level === 'block' ? 'r' : f.level === 'warn' ? 'y' : 'b')).join('')}</div>
          ${pair ? `<div class="small" style="margin-top:4px">${r.confirmed ? '✔' : '→'} ${inspLine(pair)}　<span class="muted">${esc(pair.id)}</span></div>` : ''}
          ${r.decision?.note ? `<div class="small muted">備註：${esc(r.decision.note)}（${esc(r.decision.decided_by || '')}）</div>` : ''}
          ${r.reasons.map((x) => `<div class="fe">${esc(x.msg)}</div>`).join('')}
          ${r.flags.some((f) => f.code === 'UNKNOWN_ITEM' && f.level === 'block') ? (isAdmin ? `<button class="sm" data-a="ack" data-seq="${r.hz.seq_no}">管理員確認此品名可用</button>` : '<div class="small fe">需管理員確認此品名</div>') : ''}
          <div class="actions" style="margin-top:6px">${rowActions(r)}</div></div>`;
      }).join('')}
      ${t.state === 'no_inspection' ? '<div class="hint">規定：每一車至少要有一個品項被查驗。請請現場補輸入查驗，或對上方任一品項用「手動指定查驗」。</div>' : ''}
    </div>`;
  }

  function orphanCard(o) {
    const i = o.inspection;
    return `<div class="card err"><div class="t1"><span>${esc(i.raw.vehicle_no)}　${esc(i.vendor?.short_name || i.raw.vendor_code)}</span><span class="small">${esc(fmtDateTime(i.raw.inspected_at).slice(11))}</span></div>
      <div class="small">${esc(i.raw.erp_code)} ${esc(i.erp?.name || '')}｜樣磚 ${esc(i.raw.sample_code)}｜${i.raw.gross_kg} kg｜${esc(i.id)}</div>
      ${o.reasons.map((r) => `<div class="fe">${esc(r.msg)}</div>`).join('')}
      <div class="actions"><button class="sm" data-a="assign" data-id="${esc(i.id)}">手動指定環資列</button><button class="sm sec" data-a="dismiss" data-id="${esc(i.id)}">排除此查驗（不納入報告）</button></div></div>`;
  }

  // ---------------- 事件
  const rowBySeq = (seq) => ctx.model.rows.find((r) => r.hz.seq_no === seq);
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, seq = b.dataset.seq, r = seq ? rowBySeq(seq) : null;
    b.disabled = true;
    try {
      if (a === 'ok') await save([{ key: `row:${seq}`, value: mkDec('confirmed', r.suggested) }]);
      else if (a === 'pick') {
        const id = $(`[data-sel="${seq}"]`, view).value;
        if (!id) { toast('請先選擇一筆查驗', 'er'); b.disabled = false; return; }
        await save([{ key: `row:${seq}`, value: mkDec('confirmed', r.candidates.find((c) => c.id === id)) }]);
      } else if (a === 'undo') { await app.db.clearDecision(`row:${seq}`); await refresh(); }
      else if (a === 'none') { const note = await promptBox(`序號 ${seq}（${r.hz.item_name}）這一列沒有抽驗。請填原因：`, { placeholder: '例：同車其他品項已抽驗' }); if (note) await save([{ key: `row:${seq}`, value: mkDec('none', null, { note }) }]); else b.disabled = false; }
      else if (a === 'manual') await manualAssign(r);
      else if (a === 'ack') { const note = await promptBox(`確認「${r.hz.item_name}」可作為正式報告的品項名稱？請填依據：`, { placeholder: '例：與 ERP 的 XX 品號相同，名稱新增中' }); if (note) await save([{ key: `ack:${seq}`, value: { note, decided_by: me, decided_at: new Date().toISOString() } }]); else b.disabled = false; }
      else if (a === 'dismiss') { const note = await promptBox('排除後，這筆查驗不會出現在這份報告。請填原因：', { placeholder: '例：車號輸入錯誤，已另行重新輸入' }); if (note) await save([{ key: `insp:${b.dataset.id}`, value: { choice: 'dismiss', note, decided_by: me, decided_at: new Date().toISOString() } }]); else b.disabled = false; }
      else if (a === 'undis') { await app.db.clearDecision(`insp:${b.dataset.id}`); await refresh(); }
      else if (a === 'assign') await assignOrphan(ctx.model.orphans.find((o) => o.inspection.id === b.dataset.id).inspection);
    } catch (err) { toast('操作失敗：' + err.message, 'er', 5000); b.disabled = false; }
  });

  // 為某環資列「手動指定」一筆查驗
  async function manualAssign(r) {
    const taken = new Set(ctx.model.rows.filter((x) => x.confirmed).map((x) => x.confirmed.id));
    const all = ctx.inspections.filter((i) => i.status !== 'void').map((i) => ({ i, id: i.inspection_id })).filter((x) => !taken.has(x.id));
    if (!all.length) { toast('當天沒有可指定的查驗紀錄', 'er'); return; }
    const m = modal(`<h3>手動指定查驗</h3><p class="small">環資：${esc(r.trip.vehicle_no)}｜${esc(r.hz.vendor_name)}｜${esc(r.hz.item_name)}｜${r.hz.bricks} 磚</p>
      <p class="small fe">請選擇要對應到這一列的查驗紀錄。若廠商／車號／品項與環資不一致，必須填寫原因。</p>
      <div class="list">${all.map((x) => `<label style="display:flex;gap:8px;font-weight:400;border:1px solid var(--bd);border-radius:10px;padding:8px;background:#fff"><input type="radio" name="mi" value="${esc(x.id)}" style="width:auto;min-height:0"><span class="small">${esc(x.i.vehicle_no)}｜${esc(x.i.vendor_name || x.i.vendor_code)}｜${esc(x.i.erp_code)}｜樣磚 ${esc(x.i.sample_code)}｜${x.i.gross_kg}kg</span></label>`).join('')}</div>
      <label>原因 <span class="req">*</span></label><textarea id="mn"></textarea><div class="fe" id="me"></div>
      <div class="actions"><button class="sec" id="mx">取消</button><button id="mok">確認指定</button></div>`);
    $('#mx', m.el).onclick = () => m.close();
    $('#mok', m.el).onclick = async () => {
      const id = ($('input[name=mi]:checked', m.el) || {}).value, note = $('#mn', m.el).value.trim();
      if (!id) { $('#me', m.el).textContent = '請選擇一筆查驗'; return; }
      if (!note) { $('#me', m.el).textContent = '請填原因'; return; }
      const insp = ctx.inspections.find((i) => i.inspection_id === id);
      m.close(); await save([{ key: `row:${r.hz.seq_no}`, value: mkDec('confirmed', { id, rev: insp.rev ?? 1 }, { manual: true, note }) }]);
    };
  }

  // 為「無歸屬的查驗」指定環資列
  async function assignOrphan(insp) {
    const rows = ctx.model.rows;
    const m = modal(`<h3>指定環資列</h3><p class="small">查驗：${esc(insp.raw.vehicle_no)}｜${esc(insp.raw.vendor_name || '')}｜${esc(insp.raw.erp_code)} ${esc(insp.erp?.name || '')}｜樣磚 ${esc(insp.raw.sample_code)}</p>
      <div class="list">${rows.map((r) => `<label style="display:flex;gap:8px;font-weight:400;border:1px solid var(--bd);border-radius:10px;padding:8px;background:#fff"><input type="radio" name="ar" value="${esc(r.hz.seq_no)}" style="width:auto;min-height:0"><span class="small">${esc(r.trip.vehicle_no)}｜${esc(r.hz.vendor_name)}｜${esc(r.hz.item_name)}｜${r.hz.bricks} 磚${r.confirmed ? '｜<b class="fe">已有確認配對（指定後會取代）</b>' : ''}</span></label>`).join('')}</div>
      <label>原因 <span class="req">*</span></label><textarea id="an" placeholder="為什麼這筆查驗屬於這一列？"></textarea><div class="fe" id="ae"></div>
      <div class="actions"><button class="sec" id="ax">取消</button><button id="aok">確認指定</button></div>`);
    $('#ax', m.el).onclick = () => m.close();
    $('#aok', m.el).onclick = async () => {
      const seq = ($('input[name=ar]:checked', m.el) || {}).value, note = $('#an', m.el).value.trim();
      if (!seq) { $('#ae', m.el).textContent = '請選擇環資列'; return; }
      if (!note) { $('#ae', m.el).textContent = '請填原因'; return; }
      m.close(); await save([{ key: `row:${seq}`, value: mkDec('confirmed', insp, { manual: true, note }) }]);
    };
  }

  await drawSelector();
  await refresh();
}
