// ===== 部署設定 =====
// 1. 沒填 SUPABASE_URL / SUPABASE_ANON_KEY → 「示範模式」：資料只存在這台裝置的瀏覽器，僅供試用，【不會】多人同步。
// 2. 填入你自己的 Supabase 專案網址與 anon（公開）金鑰 → 「正式模式」：資料存在共用資料庫，有登入與權限。
//    anon key 本來就設計成可以公開在網頁裡，安全靠資料庫的 RLS 規則（見 supabase/schema.sql）。
//    ⚠ 絕對不要把 service_role 金鑰貼在這裡。
export const APP_CONFIG = {
  SUPABASE_URL: 'https://noagyicsqopdzynlbhho.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_PlPxy_nGiv3qOWN9q9Fszg_QRaAhCqT',
  APP_TITLE: '進貨查驗',
};


