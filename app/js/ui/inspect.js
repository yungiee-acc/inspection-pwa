// 手機現場查驗輸入、查驗紀錄查詢與更正
import { $, $$, h, esc, toast, modal, confirmBox, promptBox, badge, today, can } from './common.js';
import { validateInspection } from '../core/validate.js';
import { IMPURITY_TYPES } from '../core/config.js';
import { uuid, genInspectionId, toLocalInput, fromLocalInput, fmtDateTime, taipeiDate } from '../core/util.js';

const isMine = (app, i) => (app.db.mode === 'local' ? i.created_by === app.profile.display_name : i.created_by === app.profile.id);
const dayRange = (ymd) => ({ from: `${ymd}T00:00:00+08:00`, to: new Date(new Date(`${ymd}T00:00:00+08:00`).getTime() + 86400000).toISOString() });
const vendorLabel = (v) => `${v.code} ${v.short_name}`;
const erpLabel = (i) => `${i.code} ${i.name}`;

export function canEdit(app, i) {
  if (i.status === 'void') return false;
  if (i.locked && !can(app, 'admin')) return false;
  if (can(app, 'inspector') && !isMine(app, i)) return false;
  return true;
}

export function recordItem(app, i) {
  const erp = app.masters.erpItems.find((x) => x.code === i.erp_code);
  const v = app.masters.vendors.find((x) => x.code === i.vendor_code);
  const b = [];
  if (i.status === 'void') b.push(badge('已作廢', 'r'));
  if (i.locked) b.push(badge('已鎖定(已審核報告)', 'b'));
  if (i.rev > 1) b.push(badge(`已更正 ${i.rev - 1} 次`, 'y'));
  return `<button class="item" data-id="${esc(i.inspection_id)}">
    <div class="t1"><span>${esc(i.vehicle_no)}　${esc(v?.short_name || i.vendor_name || i.vendor_code)}</span><span class="small muted">${esc(fmtDateTime(i.inspected_at).slice(11))}</span></div>
    <div class="t2">${esc(i.erp_code)} ${esc(erp?.name || '')}　樣磚 ${esc(i.sample_code)}</div>
    <div class="t3">毛重 ${i.gross_kg}｜含水 ${i.water_kg ?? 0}｜雜質 ${i.impurity_kg ?? 0}${Number(i.wire_kg) ? `｜鐵絲 ${i.wire_kg}` : ''} kg　檢驗人：${esc(i.inspector_name)}</div>
    <div class="t3 muted">${esc(i.inspection_id)} ${b.join('')}</div></button>`;
}

// =====================================================================
// 表單（新增與編輯共用）
// =====================================================================
export function buildForm(app, { init = null, mode = 'new', last = null, onSaved, onCancel }) {
  const { erpItems, vendors } = app.masters;
  const f = init ? {
    ...init, inspected_at: toLocalInput(init.inspected_at), impurity_types: [...(init.impurity_types || [])],
    gross_kg: String(init.gross_kg ?? ''), water_kg: init.water_kg ? String(init.water_kg) : '', impurity_kg: init.impurity_kg ? String(init.impurity_kg) : '', wire_kg: init.wire_kg ? String(init.wire_kg) : '',
  } : {
    client_uuid: uuid(), inspection_id: genInspectionId(), inspected_at: toLocalInput(new Date()),
    vendor_code: last?.vendor_code || '', vehicle_no: last?.vehicle_no || '', erp_code: '', sample_code: '', gross_kg: '', water_kg: '', impurity_kg: '', wire_kg: '',
    impurity_types: [], inspector_name: last?.inspector_name || app.profile.display_name, note: '',
  };
  let showAllVendors = !!(f.vendor_code && !vendors.find((v) => v.code === f.vendor_code)?.in_scope);
  let saving = false;

  const root = h(`<form class="card" novalidate autocomplete="off">
    <label>查驗日期時間 <span class="req">*</span></label><input type="datetime-local" name="inspected_at" value="${esc(f.inspected_at)}">
    <div class="fe" data-e="inspected_at"></div>

    <label>廠商 <span class="req">*</span> <span class="opt">（輸入代號或名稱搜尋）</span></label>
    <div class="combo"><input name="vq" placeholder="搜尋廠商代號／名稱" autocomplete="off"><div class="dd" hidden></div></div>
    <div class="hint" id="vsel"></div>
    <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin:4px 0 0"><input type="checkbox" id="vall" style="width:auto;min-height:0"> 顯示全部廠商（預設只顯示「納入本次測試」的廠商）</label>
    <div class="fe" data-e="vendor_code"></div>

    <label>車號 <span class="req">*</span></label><input name="vehicle_no" value="${esc(f.vehicle_no)}" autocapitalize="characters" placeholder="例：KLM-5278">
    <div class="fe" data-e="vehicle_no"></div><div class="fw" data-w="vehicle_no"></div>

    <label>抽驗品項 <span class="req">*</span></label>
    <select name="erp_code"><option value="">請選擇品項</option>${erpItems.map((i) => `<option value="${esc(i.code)}">${esc(erpLabel(i))}</option>`).join('')}</select>
    <div class="hint" id="erphint"></div><div class="fe" data-e="erp_code"></div>

    <label>樣磚代號 <span class="opt">（可先空白，產生報告前須補填）</span></label><input name="sample_code" value="${esc(f.sample_code)}" inputmode="text" placeholder="例：521">
    <div class="fe" data-e="sample_code"></div>

    <div class="row2">
      <div><label>樣磚毛重 kg <span class="req">*</span></label><input name="gross_kg" value="${esc(f.gross_kg)}" inputmode="decimal" placeholder="例：512.5"><div class="fe" data-e="gross_kg"></div><div class="fw" data-w="gross_kg"></div></div>
      <div><label>含水重 kg <span class="opt">（無則留空）</span></label><input name="water_kg" value="${esc(f.water_kg)}" inputmode="decimal"><div class="fe" data-e="water_kg"></div><div class="fw" data-w="water_kg"></div></div>
      <div><label>雜質重 kg <span class="opt">（無則留空）</span></label><input name="impurity_kg" value="${esc(f.impurity_kg)}" inputmode="decimal"><div class="fe" data-e="impurity_kg"></div><div class="fw" data-w="impurity_kg"></div></div>
    </div>

    <label>雜質種類 <span class="opt">（可複選；會印在報告「雜質/備註」欄）</span></label>
    <div class="chips" id="types">${IMPURITY_TYPES.map((t) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>

    <label>檢驗人 <span class="req">*</span></label><input name="inspector_name" value="${esc(f.inspector_name)}"><div class="fe" data-e="inspector_name"></div>
    <label>備註 <span class="opt">（選填）</span></label><textarea name="note">${esc(f.note || '')}</textarea>
    ${mode === 'edit' ? `<label>更正原因 <span class="req">*</span></label><textarea name="reason" placeholder="為什麼要修改？（會留下紀錄）"></textarea><div class="fe" data-e="reason"></div>` : ''}
    <div class="card warn small" id="warnbox" hidden><b>請注意：</b><ul id="warnlist" style="margin:4px 0 8px 18px;padding:0"></ul>
      <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin:0"><input type="checkbox" id="warnack" style="width:auto;min-height:0"> 我已確認以上數字無誤</label></div>
    <div class="fe" id="formerr"></div>
    <div class="actions"><button type="submit" id="save">${mode === 'edit' ? '儲存更正' : '儲存查驗'}</button>
      ${mode === 'edit' ? '<button type="button" class="dng" id="void">作廢此筆</button><button type="button" class="sec" id="cancel">取消</button>' : ''}</div>
  </form>`);

  const q = (n) => $(`[name="${n}"]`, root);
  q('erp_code').value = f.erp_code;
  const sync = () => { for (const n of ['inspected_at', 'vehicle_no', 'erp_code', 'sample_code', 'gross_kg', 'water_kg', 'impurity_kg', 'inspector_name', 'note']) f[n] = q(n).value; };

  // --- 廠商搜尋下拉
  const vq = q('vq'), dd = $('.dd', root);
  const showVendor = () => { const v = vendors.find((x) => x.code === f.vendor_code); $('#vsel', root).innerHTML = v ? `已選：<b>${esc(v.code)} ${esc(v.short_name)}</b>　${esc(v.full_name)}` : '尚未選擇'; if (v) vq.value = vendorLabel(v); };
  const renderDd = () => {
    const t = vq.value.trim().toLowerCase();
    const sel = vendors.find((x) => x.code === f.vendor_code);
    const key = sel && vq.value === vendorLabel(sel) ? '' : t; // 剛選完時不要用選到的文字過濾
    const list = vendors.filter((v) => (showAllVendors || v.in_scope) && (!key || [v.code, v.short_name, v.full_name, v.report_name || ''].some((s) => s.toLowerCase().includes(key)))).slice(0, 60);
    dd.innerHTML = list.length ? list.map((v) => `<div data-c="${esc(v.code)}">${esc(v.code)} ${esc(v.short_name)}<br><small>${esc(v.full_name)}</small></div>`).join('') : '<div class="muted">找不到。可勾選「顯示全部廠商」</div>';
    dd.hidden = false;
  };
  vq.addEventListener('focus', () => { vq.select(); renderDd(); });
  vq.addEventListener('input', renderDd);
  dd.addEventListener('mousedown', (e) => { const d = e.target.closest('[data-c]'); if (!d) return; f.vendor_code = d.dataset.c; showVendor(); dd.hidden = true; });
  vq.addEventListener('blur', () => setTimeout(() => { dd.hidden = true; showVendor(); }, 150));
  $('#vall', root).checked = showAllVendors;
  $('#vall', root).addEventListener('change', (e) => { showAllVendors = e.target.checked; renderDd(); });
  showVendor();

  // --- 品項提示
  const erpHint = () => {
    const i = erpItems.find((x) => x.code === q('erp_code').value);
    $('#erphint', root).innerHTML = !i ? '' : i.report_name ? `報告顯示名稱：<b>${esc(i.report_name)}</b>` : `<span class="fw">⚠ 此品項尚無報告對照名稱（可正常查驗儲存；但產生正式報告前，需由管理員補齊）</span>`;
  };
  q('erp_code').addEventListener('change', erpHint); erpHint();

  // --- 雜質種類
  const typesBox = $('#types', root);
  const paintTypes = () => $$('.chip', typesBox).forEach((c) => c.classList.toggle('on', f.impurity_types.includes(c.dataset.t)));
  typesBox.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; const t = c.dataset.t; f.impurity_types = f.impurity_types.includes(t) ? f.impurity_types.filter((x) => x !== t) : [...f.impurity_types, t]; paintTypes(); });
  paintTypes();

  const clearMsgs = () => { $$('[data-e],[data-w]', root).forEach((e) => { e.textContent = ''; }); $$('.bad', root).forEach((e) => e.classList.remove('bad')); $('#formerr', root).textContent = ''; };
  const markBad = (field) => { const el = field === 'vendor_code' ? $('.combo', root) : q(field); el?.classList.add('bad'); };

  let done = false;
  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;                       // 防止連點重複送出（第一層：送出中就鎖住；第二層：資料庫以 client_uuid 去重）
    saving = true;
    try { await doSubmit(); } finally { if (!done) saving = false; }
  };
  const doSubmit = async () => {
    sync(); clearMsgs();
    const day = f.inspected_at ? taipeiDate(fromLocalInput(f.inspected_at)) : today();
    let existing = [];
    try { existing = await app.db.listInspections(dayRange(day)); } catch { /* 離線時略過重複提示 */ }
    const res = validateInspection({ ...f, inspected_at: f.inspected_at ? fromLocalInput(f.inspected_at) : '', vehicle_no: f.vehicle_no.trim() }, { vendors, erpItems, existing });
    for (const er of res.errors) { const el = $(`[data-e="${er.field}"]`, root); if (el) el.textContent = er.msg; markBad(er.field); }
    let reason = '';
    if (mode === 'edit') { reason = q('reason').value.trim(); if (!reason) { $('[data-e="reason"]', root).textContent = '請填寫更正原因'; q('reason').classList.add('bad'); res.errors.push({ field: 'reason' }); } }
    if (res.errors.length) { $('#formerr', root).textContent = `有 ${res.errors.length} 個欄位需要修正`; (root.querySelector('.bad') || root).scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    const warnBox = $('#warnbox', root);
    if (res.warnings.length) {
      $('#warnlist', root).innerHTML = res.warnings.map((w) => `<li>${esc(w.msg)}</li>`).join('');
      res.warnings.forEach((w) => { const el = $(`[data-w="${w.field}"]`, root); if (el) el.textContent = '⚠ ' + w.msg; });
      const first = warnBox.hidden; warnBox.hidden = false;
      if (!$('#warnack', root).checked) { $('#formerr', root).textContent = first ? '請先確認上方警告，勾選後再按一次儲存' : '請勾選「我已確認」'; warnBox.scrollIntoView({ block: 'center' }); return; }
    }
    const v = res.values;
    const row = {
      inspection_id: f.inspection_id, client_uuid: f.client_uuid, inspected_at: fromLocalInput(f.inspected_at),
      vendor_code: f.vendor_code, vendor_name: vendors.find((x) => x.code === f.vendor_code).full_name,
      vehicle_no: f.vehicle_no.trim().toUpperCase(), erp_code: f.erp_code, sample_code: f.sample_code.trim(),
      gross_kg: v.gross, water_kg: v.water, impurity_kg: v.imp, wire_kg: v.wire, impurity_types: f.impurity_types,
      inspector_name: f.inspector_name.trim(), note: f.note.trim(),
    };
    const btn = $('#save', root); btn.disabled = true; btn.textContent = '儲存中…';
    try {
      if (mode === 'edit') {
        const { inspection_id, client_uuid, ...patch } = row;
        const saved = await app.db.updateInspection(init.inspection_id, patch, init.rev, reason);
        done = true; toast('已儲存更正', 'ok'); onSaved?.(saved);
      } else {
        const r = await app.db.insertInspection(row);
        done = true;
        if (r.status === 'duplicate') toast('這筆已經儲存過了（沒有重複新增）', 'ok');
        else if (r.status === 'queued') toast('沒有網路：已暫存在手機，恢復網路後自動上傳', '');
        else toast('✔ 儲存成功', 'ok');
        onSaved?.(r.row, r.status);
      }
    } catch (err) {
      saving = false; btn.disabled = false; btn.textContent = mode === 'edit' ? '儲存更正' : '儲存查驗';
      const msg = err.code === 'CONFLICT' ? '這筆紀錄剛剛被其他人修改過，請關閉後重新開啟再修改。'
        : err.code === 'LOCKED' ? '這筆查驗已納入「已審核」報告並鎖定。請洽管理員解鎖後再更正。'
        : err.code === '23505' ? '查驗編號重複，請再按一次儲存。' : `儲存失敗：${err.message || err}`;
      $('#formerr', root).textContent = msg; if (err.code === '23505') f.inspection_id = genInspectionId();
    }
  };
  root.addEventListener('submit', submit);
  if (mode === 'edit') {
    $('#cancel', root).onclick = () => onCancel?.();
    $('#void', root).onclick = async () => {
      const reason = await promptBox('作廢後這筆不會再參與配對與報告（紀錄仍會保留）。請填寫作廢原因：', { title: '作廢查驗', okText: '作廢' });
      if (!reason) return;
      try { const saved = await app.db.updateInspection(init.inspection_id, { status: 'void' }, init.rev, `作廢：${reason}`); toast('已作廢', 'ok'); onSaved?.(saved); }
      catch (err) { $('#formerr', root).textContent = err.code === 'LOCKED' ? '已鎖定，請洽管理員解鎖' : err.code === 'CONFLICT' ? '剛被他人修改，請重新開啟' : err.message; }
    };
  }
  return root;
}

// =====================================================================
// 頁面：現場查驗
// =====================================================================
export async function renderInspect(app, view) {
  const box = h('<div></div>'); view.appendChild(box);
  let onlyMine = true, last = null;

  const draw = async (okMsg) => {
    box.innerHTML = '';
    box.appendChild(h('<h2>現場查驗輸入</h2>'));
    if (okMsg) {
      const ok = h(`<div class="card okc"><b>✔ ${esc(okMsg.title)}</b><div class="small">查驗編號：${esc(okMsg.id)}</div><div class="actions"><button id="again">再輸入一筆（沿用廠商／車號）</button></div></div>`);
      box.appendChild(ok);
      $('#again', ok).onclick = () => draw();
    }
    box.appendChild(buildForm(app, {
      last, onSaved: (row, status) => { last = row; draw({ title: status === 'queued' ? '已暫存在手機（待上傳）' : '儲存成功', id: row.inspection_id }); window.scrollTo(0, 0); },
    }));
    box.appendChild(h('<h3>今日查驗紀錄</h3>'));
    box.appendChild(h(`<div class="chips" style="margin-bottom:8px"><button class="chip ${onlyMine ? 'on' : ''}" data-m="1">我的</button><button class="chip ${onlyMine ? '' : 'on'}" data-m="0">全部</button></div>`));
    const listEl = h('<div class="list"><p class="muted small">載入中…</p></div>'); box.appendChild(listEl);
    $$('[data-m]', box).forEach((b) => b.onclick = () => { onlyMine = b.dataset.m === '1'; draw(); });
    try {
      let rows = await app.db.listInspections(dayRange(today()));
      if (onlyMine) rows = rows.filter((i) => isMine(app, i));
      listEl.innerHTML = rows.length ? rows.map((i) => recordItem(app, i)).join('') : '<p class="muted small">今天還沒有紀錄</p>';
      $$('.item', listEl).forEach((b) => b.onclick = () => openDetail(app, rows.find((r) => r.inspection_id === b.dataset.id), () => draw()));
    } catch (e) { listEl.innerHTML = `<p class="fe">讀取失敗：${esc(e.message)}</p>`; }
  };
  await draw();
}

// =====================================================================
// 頁面：查驗紀錄（查詢、修改）
// =====================================================================
export async function renderRecords(app, view) {
  const t = today();
  view.innerHTML = `<h2>查驗紀錄</h2>
    <div class="card"><div class="row2"><div><label style="margin-top:0">起</label><input type="date" id="f1" value="${t}"></div><div><label style="margin-top:0">迄</label><input type="date" id="f2" value="${t}"></div></div>
    <label>搜尋 <span class="opt">（車號、廠商、樣磚代號、編號、檢驗人）</span></label><input id="fq" placeholder="輸入關鍵字">
    <div class="row2"><div><label>狀態</label><select id="fs"><option value="active">有效</option><option value="void">已作廢</option><option value="">全部</option></select></div>
    <div><label>範圍</label><select id="fm"><option value="">全部人員</option><option value="1">只看我的</option></select></div></div></div>
    <div id="cnt" class="muted small"></div><div class="list" id="lst"></div>`;
  const load = async () => {
    const d1 = $('#f1', view).value, d2 = $('#f2', view).value || d1;
    const lst = $('#lst', view); lst.innerHTML = '<p class="muted small">載入中…</p>';
    try {
      let rows = await app.db.listInspections({ from: dayRange(d1).from, to: dayRange(d2).to });
      const kw = $('#fq', view).value.trim().toLowerCase(), st = $('#fs', view).value;
      if (st) rows = rows.filter((i) => i.status === st);
      if ($('#fm', view).value) rows = rows.filter((i) => isMine(app, i));
      if (kw) rows = rows.filter((i) => [i.vehicle_no, i.vendor_name, i.vendor_code, i.sample_code, i.inspection_id, i.inspector_name, i.erp_code].join(' ').toLowerCase().includes(kw));
      $('#cnt', view).textContent = `共 ${rows.length} 筆`;
      lst.innerHTML = rows.length ? rows.map((i) => recordItem(app, i)).join('') : '<p class="muted">沒有符合的紀錄</p>';
      $$('.item', lst).forEach((b) => b.onclick = () => openDetail(app, rows.find((r) => r.inspection_id === b.dataset.id), load));
    } catch (e) { lst.innerHTML = `<p class="fe">讀取失敗：${esc(e.message)}</p>`; }
  };
  ['f1', 'f2', 'fs', 'fm'].forEach((id) => $('#' + id, view).addEventListener('change', load));
  $('#fq', view).addEventListener('input', load);
  await load();
}

// 單筆詳情（含異動歷程；可編輯）
export async function openDetail(app, i, onChange) {
  if (!i) return;
  const erp = app.masters.erpItems.find((x) => x.code === i.erp_code);
  const m = modal('<p class="muted">載入中…</p>');
  const paint = async () => {
    let hist = [];
    try { hist = await app.db.listAudit({ pk: i.inspection_id, limit: 30 }); } catch { /* 無權限時略過 */ }
    m.el.innerHTML = `<h3>查驗 ${esc(i.inspection_id)} ${i.status === 'void' ? badge('已作廢', 'r') : ''}${i.locked ? badge('已鎖定', 'b') : ''}</h3>
      <dl class="kv"><dt>時間</dt><dd>${esc(fmtDateTime(i.inspected_at))}</dd><dt>廠商</dt><dd>${esc(i.vendor_code)} ${esc(i.vendor_name || '')}</dd><dt>車號</dt><dd>${esc(i.vehicle_no)}</dd>
      <dt>品項</dt><dd>${esc(i.erp_code)} ${esc(erp?.name || '')}<br><span class="muted small">報告名稱：${esc(erp?.report_name || '（尚未對照）')}</span></dd>
      <dt>樣磚</dt><dd>${esc(i.sample_code)}</dd><dt>重量(kg)</dt><dd>毛重 ${i.gross_kg}｜含水 ${i.water_kg ?? 0}｜雜質 ${i.impurity_kg ?? 0}</dd>
      <dt>雜質種類</dt><dd>${esc((i.impurity_types || []).join('、') || '—')}</dd><dt>檢驗人</dt><dd>${esc(i.inspector_name)}</dd><dt>備註</dt><dd>${esc(i.note || '—')}</dd><dt>版次</dt><dd>${i.rev}</dd></dl>
      <div class="actions">${canEdit(app, i) ? '<button id="ed">編輯／更正</button>' : ''}<button class="sec" id="cl">關閉</button></div>
      ${i.locked && !can(app, 'admin') ? '<p class="small muted">此筆已納入已審核報告，需管理員解鎖後才能更正。</p>' : ''}
      <h3>異動紀錄</h3>${hist.length ? `<div class="small">${hist.map((a) => `<div style="border-top:1px solid var(--bd);padding:4px 0">${esc(fmtDateTime(a.at))}｜${esc(a.actor_name || '')}｜${esc(a.action)}${a.new?.change_reason ? `｜原因：${esc(a.new.change_reason)}` : ''}</div>`).join('')}</div>` : '<p class="muted small">無</p>'}`;
    $('#cl', m.el).onclick = () => m.close();
    const ed = $('#ed', m.el);
    if (ed) ed.onclick = () => {
      m.el.innerHTML = '<h3>編輯查驗</h3>';
      m.el.appendChild(buildForm(app, { init: i, mode: 'edit', onSaved: (saved) => { m.close(); onChange?.(saved); }, onCancel: () => paint() }));
    };
  };
  await paint();
}
