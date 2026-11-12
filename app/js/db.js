// 資料存取層。畫面程式只呼叫這裡的方法，不直接碰資料庫。
//  - createSupabaseDb：正式模式（共用資料庫）
//  - createLocalDb   ：示範模式（只存在本機瀏覽器，僅供試用）
import { APP_CONFIG } from './app-config.js';
import { nowIso, uuid } from './core/util.js';

const LS = 'ipwa:v1';

export async function createDb() {
  if (APP_CONFIG.SUPABASE_URL && APP_CONFIG.SUPABASE_ANON_KEY && window.supabase) return createSupabaseDb();
  return createLocalDb();
}

// ======================================================================
// 示範模式（localStorage）
// ======================================================================
async function createLocalDb() {
  const load = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
  const save = (s) => localStorage.setItem(LS, JSON.stringify(s));
  let S = load();
  for (const k of ['inspections', 'hz_rows', 'hz_imports', 'reports', 'audit']) S[k] ||= [];
  S.decisions ||= {}; S.erp_edit ||= {}; S.vendor_edit ||= {};
  const persist = () => save(S);
  const me = () => S.session;
  const audit = (table, pk, action, oldv, newv) => { S.audit.unshift({ id: uuid(), at: nowIso(), actor_name: me()?.display_name || '?', table_name: table, pk: String(pk), action, old: oldv ?? null, new: newv ?? null }); S.audit = S.audit.slice(0, 2000); };

  const [erp0, ven0] = await Promise.all([fetch('data/erp_items.json').then((r) => r.json()), fetch('data/vendors.json').then((r) => r.json())]);
  const needRole = (roles) => { if (!roles.includes(me()?.role)) throw new Error('權限不足'); };

  const db = {
    mode: 'local',
    async init() { return me() ? { user: { id: 'local' }, profile: me() } : null; },
    async signIn() { throw new Error('示範模式請用「選擇身分」登入'); },
    async localSignIn(name, role) { S.session = { display_name: name, role }; persist(); return { user: { id: 'local' }, profile: S.session }; },
    async signOut() { delete S.session; persist(); },

    async loadMasters() {
      const erpItems = erp0.map((i) => ({ ...i, ...(S.erp_edit[i.code] || {}) }));
      const vendors = [...ven0, ...(S.vendor_new || [])].map((v) => ({ ...v, ...(S.vendor_edit[v.code] || {}) })).sort((a, b) => a.code.localeCompare(b.code));
      return { erpItems, vendors };
    },
    async setErpReportName(code, name) { needRole(['admin']); const o = S.erp_edit[code]?.report_name ?? erp0.find((i) => i.code === code)?.report_name; S.erp_edit[code] = { report_name: name || null }; audit('erp_items', code, 'update', { report_name: o }, { report_name: name || null }); persist(); },
    async setVendorReportName(code, name) { needRole(['admin']); const o = S.vendor_edit[code]?.report_name ?? ven0.find((v) => v.code === code)?.report_name; S.vendor_edit[code] = { ...(S.vendor_edit[code] || {}), report_name: name || null }; audit('vendors', code, 'update', { report_name: o }, { report_name: name || null }); persist(); },
    async setVendorInScope(code, v) { needRole(['admin']); S.vendor_edit[code] = { ...(S.vendor_edit[code] || {}), in_scope: !!v }; persist(); },
    async addVendor(v) {
      needRole(['admin']);
      S.vendor_new ||= [];
      if (ven0.some((x) => x.code === v.code) || S.vendor_new.some((x) => x.code === v.code)) throw new Error(`廠商代號 ${v.code} 已存在`);
      S.vendor_new.push({ tax_id: null, ...v }); audit('vendors', v.code, 'insert', null, v); persist();
    },

    async listInspections({ from, to } = {}) {
      return S.inspections.filter((i) => (!from || i.inspected_at >= from) && (!to || i.inspected_at < to)).sort((a, b) => b.inspected_at.localeCompare(a.inspected_at));
    },
    async insertInspection(row) {
      const dup = S.inspections.find((i) => i.client_uuid === row.client_uuid);
      if (dup) return { status: 'duplicate', row: dup };
      const r = { ...row, status: 'active', rev: 1, locked: false, created_by: me().display_name, created_at: nowIso(), updated_at: nowIso() };
      S.inspections.push(r); audit('inspections', r.inspection_id, 'insert', null, r); persist();
      return { status: 'ok', row: r };
    },
    async updateInspection(id, patch, expectedRev, reason) {
      const r = S.inspections.find((i) => i.inspection_id === id);
      if (!r) throw new Error('找不到這筆查驗');
      if (r.rev !== expectedRev) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
      if (r.locked && me().role !== 'admin') throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
      if (me().role === 'inspector' && r.created_by !== me().display_name) throw new Error('只能修改自己建立的查驗');
      const old = { ...r };
      Object.assign(r, patch, { rev: r.rev + 1, updated_at: nowIso(), updated_by: me().display_name, change_reason: reason || null });
      audit('inspections', id, 'update', old, { ...r }); persist();
      return r;
    },
    async listProfiles() { return []; }, async updateProfile() {},
    async listAudit({ pk, limit = 200 } = {}) { return S.audit.filter((a) => !pk || a.pk === pk).slice(0, limit); },

    async saveHzImport({ fileName, fileHash, weighDate, rows, overwrite }) {
      needRole(['office', 'admin']);
      const dupFile = S.hz_imports.find((x) => x.file_hash === fileHash);
      const approved = S.reports.some((r) => r.report_date === weighDate && r.status === 'approved');
      const res = { added: 0, same: 0, changed: [], overwritten: 0, dupFile: !!dupFile, approvedLock: approved };
      const imp = { id: uuid(), file_name: fileName, file_hash: fileHash, weigh_date: weighDate, row_count: rows.length, imported_by: me().display_name, imported_at: nowIso() };
      for (const r of rows) {
        const ex = S.hz_rows.find((x) => x.weigh_date === r.weigh_date && x.seq_no === r.seq_no);
        if (!ex) { S.hz_rows.push({ ...r, import_id: imp.id }); res.added++; continue; }
        const same = ['vendor_name', 'item_name', 'vehicle_no', 'ship_no', 'gross_kg', 'tare_kg', 'net_kg', 'bricks'].every((k) => ex[k] === r[k]);
        if (same) { res.same++; continue; }
        if (overwrite && !approved) { Object.assign(ex, r, { import_id: imp.id }); res.overwritten++; audit('hz_rows', r.seq_no, 'update', null, r); } else res.changed.push(r.seq_no);
      }
      if (!dupFile) S.hz_imports.push(imp);
      audit('hz_imports', imp.id, 'insert', null, { ...imp, ...res }); persist();
      return res;
    },
    async listHzRows(date) { return S.hz_rows.filter((r) => r.weigh_date === date).sort((a, b) => Number(a.seq_no) - Number(b.seq_no)); },
    async listHzDates() {
      const m = {}; for (const r of S.hz_rows) m[r.weigh_date] = (m[r.weigh_date] || 0) + 1;
      return Object.entries(m).map(([date, count]) => ({ date, count })).sort((a, b) => b.date.localeCompare(a.date));
    },

    async listDecisions(date) { const o = {}; for (const [k, v] of Object.entries(S.decisions)) if (v._date === date) { const { _date, ...rest } = v; o[k] = rest; } return o; },
    async setDecisions(list, date) { needRole(['office', 'admin']); for (const { key, value } of list) { audit('match_decisions', key, S.decisions[key] ? 'update' : 'insert', S.decisions[key], value); S.decisions[key] = { ...value, _date: date }; } persist(); },
    async clearDecision(key) { needRole(['office', 'admin']); audit('match_decisions', key, 'delete', S.decisions[key], null); delete S.decisions[key]; persist(); },

    async listReports(date) { return S.reports.filter((r) => r.report_date === date).sort((a, b) => b.version - a.version); },
    async createReportDraft({ report_date, snapshot, data_hash, inspection_ids, reason }) {
      needRole(['office', 'admin']);
      const version = Math.max(0, ...S.reports.filter((r) => r.report_date === report_date).map((r) => r.version)) + 1;
      const r = { id: uuid(), report_date, version, status: 'draft', snapshot, data_hash, inspection_ids, reason: reason || (version === 1 ? '初版' : ''), created_by: me().display_name, created_at: nowIso() };
      S.reports.push(r); audit('reports', r.id, 'insert', null, { report_date, version, status: 'draft', data_hash }); persist(); return r;
    },
    async approveReport(id) {
      needRole(['office', 'admin']);
      const r = S.reports.find((x) => x.id === id); if (!r) throw new Error('找不到報告');
      for (const o of S.reports) if (o.report_date === r.report_date && o.status === 'approved') { o.status = 'superseded'; audit('reports', o.id, 'update', { status: 'approved' }, { status: 'superseded' }); }
      r.status = 'approved'; r.approved_by = me().display_name; r.approved_at = nowIso();
      for (const i of S.inspections) if (r.inspection_ids.includes(i.inspection_id)) i.locked = true;
      audit('reports', id, 'update', { status: 'draft' }, { status: 'approved', version: r.version }); persist(); return r;
    },
    async unlockDate(date, reason) {
      needRole(['admin']);
      const r = S.reports.find((x) => x.report_date === date && x.status === 'approved'); if (!r) throw new Error('這一天沒有已審核的報告');
      for (const i of S.inspections) if (r.inspection_ids.includes(i.inspection_id)) i.locked = false;
      audit('reports', r.id, 'unlock', null, { reason }); persist();
    },
    async deleteDraft(id) { needRole(['office', 'admin']); const r = S.reports.find((x) => x.id === id); if (r?.status !== 'draft') throw new Error('只能刪除草稿'); S.reports = S.reports.filter((x) => x.id !== id); audit('reports', id, 'delete', { version: r.version }, null); persist(); },

    outboxCount() { return 0; }, async flushOutbox() { return 0; },
    async exportBackup() { return { exported_at: nowIso(), mode: 'local', ...S, session: undefined }; },
    resetLocal() { localStorage.removeItem(LS); },
  };
  return db;
}

// ======================================================================
// 正式模式（Supabase）
// ======================================================================
async function createSupabaseDb() {
  const sb = window.supabase.createClient(String(APP_CONFIG.SUPABASE_URL).trim().replace(/^(https?:\/\/[^/]+).*$/i, '$1'),APP_CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const OUTBOX = 'ipwa:outbox';
  const getBox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX)) || []; } catch { return []; } };
  const setBox = (b) => localStorage.setItem(OUTBOX, JSON.stringify(b));
  const must = ({ data, error }) => { if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error }); return data; };
  let profile = null;
  const isNetErr = (e) => /fetch|network|Failed to|load failed/i.test(e?.message || '') && !e?.code;

  async function loadProfile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const p = must(await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
    profile = p ? { ...p } : null;
    return profile ? { user: session.user, profile } : null;
  }
  const db = {
    mode: 'supabase', sb,
    async init() { const s = await loadProfile(); if (s) db.flushOutbox().catch(() => {}); return s; },
    async signIn(email, password) { must(await sb.auth.signInWithPassword({ email, password })); const s = await loadProfile(); if (!s) throw new Error('帳號已登入，但管理員尚未為你建立使用者資料（profiles）'); return s; },
    async signOut() { await sb.auth.signOut(); profile = null; },

    async loadMasters() {
      const [erpItems, vendors] = await Promise.all([
        sb.from('erp_items').select('*').order('code').then(must),
        sb.from('vendors').select('*').order('code').then(must)]);
      return { erpItems, vendors };
    },
    async setErpReportName(code, name) { must(await sb.from('erp_items').update({ report_name: name || null }).eq('code', code)); },
    async setVendorReportName(code, name) { must(await sb.from('vendors').update({ report_name: name || null }).eq('code', code)); },
    async setVendorInScope(code, v) { must(await sb.from('vendors').update({ in_scope: !!v }).eq('code', code)); },
    async addVendor(v) { must(await sb.from('vendors').insert({ code: v.code, short_name: v.short_name, full_name: v.full_name, report_name: v.report_name || null, in_scope: !!v.in_scope })); },

    async listInspections({ from, to } = {}) {
      let q = sb.from('inspections').select('*').order('inspected_at', { ascending: false }).limit(2000);
      if (from) q = q.gte('inspected_at', from);
      if (to) q = q.lt('inspected_at', to);
      return must(await q);
    },
    async insertInspection(row) {
      const body = { ...row, created_by: undefined };
      try {
        const { data, error } = await sb.from('inspections').insert(body).select().single();
        if (error) {
          if (error.code === '23505' && /client_uuid/.test(error.message)) { // 重複送出：以 client_uuid 辨識，回傳既有那筆
            const ex = must(await sb.from('inspections').select('*').eq('client_uuid', row.client_uuid).single());
            return { status: 'duplicate', row: ex };
          }
          throw Object.assign(new Error(error.message), { code: error.code });
        }
        return { status: 'ok', row: data };
      } catch (e) {
        if (isNetErr(e)) { const b = getBox(); if (!b.find((x) => x.client_uuid === row.client_uuid)) b.push(row); setBox(b); return { status: 'queued', row }; }
        throw e;
      }
    },
    async updateInspection(id, patch, expectedRev, reason) {
      const { data, error } = await sb.from('inspections').update({ ...patch, change_reason: reason || null }).eq('inspection_id', id).eq('rev', expectedRev).select();
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      if (!data?.length) { // 沒更新到：可能版次已被別人改過，或已鎖定/無權限
        const cur = must(await sb.from('inspections').select('rev,locked').eq('inspection_id', id).maybeSingle());
        if (cur && cur.rev !== expectedRev) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
        if (cur?.locked) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
        throw new Error('無法更新（可能沒有權限）');
      }
      return data[0];
    },
    async listProfiles() { return must(await sb.from('profiles').select('*').order('created_at')); },
    async updateProfile(id, patch) { must(await sb.from('profiles').update(patch).eq('id', id)); },
    async listAudit({ pk, limit = 200 } = {}) {
      let q = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(limit);
      if (pk) q = q.eq('pk', pk);
      return must(await q);
    },

    async saveHzImport({ fileName, fileHash, weighDate, rows, overwrite }) {
      const { data, error } = await sb.rpc('import_hz', { p_file_name: fileName, p_file_hash: fileHash, p_weigh_date: weighDate, p_rows: rows, p_overwrite: !!overwrite });
      if (error) throw new Error(error.message);
      return data;
    },
    async listHzRows(date) { return must(await sb.from('hz_rows').select('*').eq('weigh_date', date).order('seq_no')); },
    async listHzDates() {
      const rows = must(await sb.from('hz_rows').select('weigh_date').order('weigh_date', { ascending: false }).limit(3000));
      const m = {}; for (const r of rows) m[r.weigh_date] = (m[r.weigh_date] || 0) + 1;
      return Object.entries(m).map(([date, count]) => ({ date, count }));
    },

    async listDecisions(date) { const rows = must(await sb.from('match_decisions').select('key,value').eq('report_date', date)); const o = {}; rows.forEach((r) => { o[r.key] = r.value; }); return o; },
    async setDecisions(list, date) {
      if (!list.length) return;
      must(await sb.from('match_decisions').upsert(list.map(({ key, value }) => ({ key, report_date: date, value })), { onConflict: 'key' }));
    },
    async clearDecision(key) { must(await sb.from('match_decisions').delete().eq('key', key)); },

    async listReports(date) { return must(await sb.from('reports').select('*').eq('report_date', date).order('version', { ascending: false })); },
    async createReportDraft({ report_date, snapshot, data_hash, inspection_ids, reason }) {
      const { data, error } = await sb.rpc('create_report_draft', { p_date: report_date, p_snapshot: snapshot, p_hash: data_hash, p_ids: inspection_ids, p_reason: reason || '' });
      if (error) throw new Error(error.message);
      return data;
    },
    async approveReport(id) { const { data, error } = await sb.rpc('approve_report', { p_id: id }); if (error) throw new Error(error.message); return data; },
    async unlockDate(date, reason) { const { error } = await sb.rpc('unlock_report_date', { p_date: date, p_reason: reason }); if (error) throw new Error(error.message); },
    async deleteDraft(id) { must(await sb.from('reports').delete().eq('id', id).eq('status', 'draft')); },

    outboxCount() { return getBox().length; },
    async flushOutbox() {
      const box = getBox(); let ok = 0; const rest = [];
      for (const row of box) { try { const r = await db.insertInspection(row); if (r.status === 'queued') rest.push(row); else ok++; } catch { rest.push(row); } }
      setBox(rest); return ok;
    },
    async exportBackup() {
      const out = { exported_at: nowIso(), mode: 'supabase' };
      for (const t of ['erp_items', 'vendors', 'inspections', 'hz_imports', 'hz_rows', 'match_decisions', 'reports', 'profiles']) out[t] = must(await sb.from(t).select('*').limit(50000));
      return out;
    },
  };
  window.addEventListener('online', () => db.flushOutbox().catch(() => {}));
  return db;
}
