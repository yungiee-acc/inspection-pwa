# 進貨查驗 PWA 自動化系統（第一版）

手機輸入一次查驗資料 → 辦公室匯入環資 Excel 自動配對 → 預覽、審核 → 產生正式查驗報告 Excel（含「VBA匯入資料」工作表，供之後的 VBA 匯入模組讀取）。**不修改**現有進貨自動化中心的任何扣重計算。

## 先看這幾份
1. [docs/01_分析報告與待確認事項.md](docs/01_分析報告與待確認事項.md) ← **請回覆剩餘的待確認項目**
2. [docs/02_部署指引.md](docs/02_部署指引.md)（含免費額度與限制）
3. [docs/03_測試方法.md](docs/03_測試方法.md)（已測／未測）
4. [docs/04_VBA串接規劃.md](docs/04_VBA串接規劃.md)

## 五分鐘本機試用
```
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```
開 http://localhost:8080/app/ → 點「一般使用者／審核者／後台管理者」三個帳號之一（示範模式）。可用 `tests/samples/hz_20261109.xls` 當環資範例匯入。

## 專案結構
| 路徑 | 說明 |
|---|---|
| `app/` | PWA 網頁（部署到 GitHub Pages 的內容） |
| `app/js/core/` | 核心邏輯：`hz.js` 環資解析、`match.js` 配對、`validate.js` 表單檢查、`report.js` 報告與 VBA 資料、`exporter.js` Excel 輸出、`config.js` 可調參數 |
| `app/js/ui/` | 畫面：現場查驗、環資配對、報告、管理 |
| `app/js/db.js` | 資料層：正式模式（Supabase）／示範模式（本機） |
| `app/js/app-config.js` | 填 Supabase 網址與金鑰的地方 |
| `supabase/schema.sql`、`seed.sql`、`accounts.sql` | 資料庫結構、權限、異動紀錄；主檔資料；三個帳號的角色設定 |
| `tools/` | 啟動伺服器、轉換主檔、產生 seed、轉圖等 PowerShell 腳本 |
| `tests/` | 核心測試頁與樣本 |

## 目前狀態
- ✔ 手機查驗、紀錄查詢與更正、環資匯入、自動配對與異常處理、報告預覽、審核、版本與更正紀錄、正式 Excel（依範例版型）
- ✔ 資料庫結構與權限（已在 PostgreSQL 測過）
- ⚠ Supabase 實機串接尚待你建立專案後驗收；登入暫用 Email＋密碼（三個角色帳號）
- ⏳ 第四階段 VBA 匯入模組：等你提供 VBA 原始碼
