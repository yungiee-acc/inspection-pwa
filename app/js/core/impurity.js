// 雜質種類清單：預設值、新增時的名稱檢查、手機選單要顯示哪些
import { IMPURITY_TYPES } from './config.js';

/** 資料庫還沒有雜質種類表（尚未執行補丁 SQL）或示範模式第一次使用時的預設清單 */
export const defaultImpurityTypes = () => IMPURITY_TYPES.map((name, i) => ({ name, sort_order: (i + 1) * 10, active: true }));

const BAD_CHARS = /[、；;,，]/;
const key = (s) => String(s).trim().toLowerCase();

/** 新增名稱檢查（名稱會原樣存進查驗紀錄、印在報告上，且不能改名，所以先擋掉會造成麻煩的寫法） */
export function validateImpurityName(raw, existing = []) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, error: '請輸入種類名稱' };
  if (name.length > 20) return { ok: false, error: '名稱最多 20 個字' };
  if (BAD_CHARS.test(name)) return { ok: false, error: '名稱不能包含「、」「；」逗號等分隔符號（報告會用「、」把多個種類連起來）' };
  const dup = existing.find((t) => key(t.name) === key(name));
  if (dup) return { ok: false, error: dup.active === false ? `「${dup.name}」已存在但目前停用，請直接啟用它` : `「${dup.name}」已經在清單裡` };
  return { ok: true, name };
}

/** 清單依順序排好 */
export const sortedTypes = (list) => [...list].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));

/** 手機表單要顯示的選項：啟用中的依順序；另外把「這筆已選、但現在已停用」的也保留，避免編輯舊紀錄時被悄悄拿掉 */
export function selectableNames(list, selected = []) {
  const act = sortedTypes(list).filter((t) => t.active !== false).map((t) => t.name);
  const extra = selected.filter((n) => !act.includes(n));
  return [...act, ...extra];
}
