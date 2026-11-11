// 業務參數集中管理。
// ⚠ 標示「待確認」的數值只是暫定，真正的標準請由業務單位確認後修改這裡。
export const RULES = {
  // 樣磚重量合理性門檻：業務單位決定「先不設定」(null＝不檢查)。
  // 日後要啟用時填數字即可，例：grossMin: 100, grossMax: 1000, waterRatioWarn: 0.10 ...
  // （仍保留的硬性檢查：必填、不可負數、含水＋雜質＋鐵絲 必須小於毛重）
  grossMin: null,         // 樣磚毛重低於此值 → 警告
  grossMax: null,         // 樣磚毛重高於此值 → 警告
  waterRatioWarn: null,   // 含水重 / 毛重 超過 → 警告
  impurityRatioWarn: null,// 雜質重 / 毛重 超過 → 警告
  wireRatioWarn: null,    // 鐵絲重 / 毛重 超過 → 警告
  maxDecimals: 2,         // 重量欄位最多小數位

  // 配對輔助檢查：同樣先不啟用（填 0.25 代表差距 >25% 時警示，僅提醒、不影響配對）
  brickWeightRatioWarn: null,

  // 報告版面（依範例檔）
  rowsPerPage: 10,        // 每頁資料列數
  maxPages: 200,
};

// 雜質種類選項（取自範例報告「雜質/備註」欄的實際用字）— 待確認是否完整
export const IMPURITY_TYPES = ['無色', '有色', '其他', '無標', '非容器', '瓶中水', 'PET', 'PVC', 'PP', 'PE'];

// 角色代碼不變（資料庫用），顯示名稱：一般使用者＝現場查驗；審核者＝匯入環資、配對、審核報告；後台管理者＝另可維護主檔、使用者、解鎖更正
export const ROLES = { inspector: '一般使用者', office: '審核者', admin: '後台管理者' };
// 三個固定帳號（示範模式的登入按鈕；正式模式請依 docs/02_部署指引.md 建立同名角色的帳號）
export const DEMO_ACCOUNTS = [
  { name: '一般使用者', role: 'inspector', hint: '現場查驗輸入、查驗紀錄' },
  { name: '審核者', role: 'office', hint: '另可匯入環資、配對、產生並審核報告' },
  { name: '後台管理者', role: 'admin', hint: '另可維護品項對照／廠商／使用者、解鎖更正' },
];
