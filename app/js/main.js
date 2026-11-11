// 程式進入點：載入資料層 → 檢查登入 → 依身分顯示功能 → 路由
import { createDb } from './db.js';
import { APP_CONFIG } from './app-config.js';
import { $, esc, loadScript, toast } from './ui/common.js';
import { ROLES } from './core/config.js';
import { renderLogin } from './ui/login.js';
import { renderInspect, renderRecords } from './ui/inspect.js';
import { renderOffice } from './ui/office.js';
import { renderReport } from './ui/report.js';
import { renderAdmin } from './ui/admin.js';

const ROUTES = {
  inspect: { label: '現場查驗', icon: '✚', roles: ['inspector', 'office', 'admin'], fn: renderInspect },
  records: { label: '查驗紀錄', icon: '☰', roles: ['inspector', 'office', 'admin'], fn: renderRecords },
  office: { label: '環資配對', icon: '⇄', roles: ['office', 'admin'], fn: renderOffice },
  report: { label: '報告', icon: '▤', roles: ['office', 'admin'], fn: renderReport },
  admin: { label: '管理', icon: '⚙', roles: ['admin'], fn: renderAdmin },
};

const app = {
  db: null, profile: null, masters: null,
  go(hash) { location.hash = hash; },
  async reloadMasters() { app.masters = await app.db.loadMasters(); },
  async boot() {
    const s = await app.db.init();
    app.profile = s?.profile || null;
    if (app.profile) await app.reloadMasters();
    drawChrome(); route();
  },
};
window.__app = app; // 方便除錯與自動化測試

function drawChrome() {
  const p = app.profile;
  $('#title').textContent = APP_CONFIG.APP_TITLE;
  $('#who').innerHTML = p ? `${esc(p.display_name)}（${ROLES[p.role] || p.role}）<a href="#" id="lo" style="color:#fff;margin-left:8px">登出</a>` : '';
  const lo = $('#lo'); if (lo) lo.onclick = async (e) => { e.preventDefault(); await app.db.signOut(); app.profile = null; drawChrome(); route(); };
  const nav = $('#nav');
  nav.innerHTML = p ? Object.entries(ROUTES).filter(([, r]) => r.roles.includes(p.role)).map(([k, r]) => `<a href="#/${k}" data-k="${k}"><b>${r.icon}</b>${r.label}</a>`).join('') : '';
  drawBanner();
}

function drawBanner() {
  const parts = [];
  if (app.db?.mode === 'local') parts.push('<div class="b">示範模式：資料只存在這台裝置，不會多人同步（僅供試用）</div>');
  if (!navigator.onLine) parts.push('<div class="b off">目前沒有網路。已儲存的畫面可開啟；新增的查驗會先暫存在手機，恢復網路後自動上傳。</div>');
  const n = app.db?.outboxCount?.() || 0;
  if (n) parts.push(`<div class="b off">有 ${n} 筆查驗尚未上傳（等待網路）。請保持此頁面開啟或稍後再開。</div>`);
  $('#banner').innerHTML = parts.join('');
}
window.addEventListener('online', drawBanner); window.addEventListener('offline', drawBanner);
setInterval(drawBanner, 5000);

function route() {
  const view = $('#view');
  if (!app.profile) { renderLogin(app, view); return; }
  const key = (location.hash.replace(/^#\//, '').split('?')[0]) || 'inspect';
  let r = ROUTES[key];
  if (!r || !r.roles.includes(app.profile.role)) { location.hash = '#/inspect'; return; }
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === key));
  const params = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  view.innerHTML = '';
  Promise.resolve(r.fn(app, view, params)).catch((e) => { console.error(e); view.innerHTML = `<div class="card err"><b>發生錯誤</b><br>${esc(e.message || e)}</div>`; });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

(async function start() {
  try {
    if (APP_CONFIG.SUPABASE_URL && APP_CONFIG.SUPABASE_ANON_KEY) await loadScript('vendor/supabase.js');
    app.db = await createDb();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
    await app.boot();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card err"><b>啟動失敗</b><br>${esc(e.message || e)}<br><span class="small">請確認網路與 app-config.js 設定。</span></div>`;
  }
})();
