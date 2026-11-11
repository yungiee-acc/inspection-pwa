// 登入畫面。
// ⚠ 正式登入機制尚未確認：正式模式暫用「Supabase 電子郵件＋密碼」，只是為了讓系統能運作；
//   之後若決定改用別的方式（Magic Link、手機簡訊、共用帳號＋PIN…），只需要改這個檔案與 db.js 的 signIn。
import { $, $$, esc, h, toast } from './common.js';
import { DEMO_ACCOUNTS } from '../core/config.js';

export function renderLogin(app, view) {
  if (app.db.mode === 'local') {
    view.innerHTML = `
      <h2>歡迎使用（示範模式）</h2>
      <div class="card warn small"><b>示範模式</b>：資料只存在這台裝置的瀏覽器，<b>不會與其他人同步</b>，清除瀏覽器資料就會消失。僅供試用與教學；正式使用請依「部署指引」設定共用資料庫。</div>
      <div class="card"><b>選擇帳號</b>
        ${DEMO_ACCOUNTS.map((a, i) => `<button class="block ${i ? 'sec' : ''}" data-i="${i}" style="margin-top:10px">${esc(a.name)}<br><span class="small" style="font-weight:400">${esc(a.hint)}</span></button>`).join('')}
        <label>現場檢驗人姓名 <span class="opt">（選填；一般使用者會用它當預設檢驗人）</span></label>
        <input id="nm" placeholder="例：王小明" autocomplete="off">
      </div>`;
    $$('[data-i]', view).forEach((b) => b.onclick = async () => {
      const a = DEMO_ACCOUNTS[b.dataset.i];
      await app.db.localSignIn($('#nm', view).value.trim() || a.name, a.role);
      await app.boot();
    });
    return;
  }
  view.innerHTML = `
    <h2>登入</h2>
    <div class="card">
      <label>電子郵件</label><input id="em" type="email" autocomplete="username" inputmode="email">
      <label>密碼</label><input id="pw" type="password" autocomplete="current-password">
      <div class="fe" id="er"></div>
      <button class="block" id="go" style="margin-top:14px">登入</button>
      <p class="hint">帳號由管理員建立。忘記密碼請洽管理員。</p>
    </div>`;
  const go = async () => {
    const btn = $('#go', view); btn.disabled = true; $('#er', view).textContent = '';
    try { await app.db.signIn($('#em', view).value.trim(), $('#pw', view).value); await app.boot(); }
    catch (e) { $('#er', view).textContent = '登入失敗：' + (e.message || e); btn.disabled = false; }
  };
  $('#go', view).onclick = go;
  $('#pw', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
