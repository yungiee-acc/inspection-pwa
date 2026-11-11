// 手機查驗表單檢查：errors 必須修正才能存；warnings 需勾選「已確認」才能存
import { RULES } from './config.js';
import { num, decimals, taipeiDate, normPlate } from './util.js';

export function validateInspection(f, ctx) {
  const errors = [], warnings = [];
  const E = (field, msg) => errors.push({ field, msg });
  const W = (field, msg) => warnings.push({ field, msg });

  if (!f.inspected_at) E('inspected_at', '請填查驗日期時間');
  if (!f.vendor_code) E('vendor_code', '請選擇廠商');
  else if (!ctx.vendors.find((v) => v.code === f.vendor_code)) E('vendor_code', '廠商代號不在主檔內');
  if (!String(f.vehicle_no || '').trim()) E('vehicle_no', '請填車號');
  if (!f.erp_code) E('erp_code', '請選擇抽驗品項');
  else if (!ctx.erpItems.find((i) => i.code === f.erp_code)) E('erp_code', '品號不在 ERP 主檔內');
  // 樣磚代號：現場可先不填，產生報告前必須補齊（見 match.js 的 NO_SAMPLE_CODE）
  if (!String(f.inspector_name || '').trim()) E('inspector_name', '請填檢驗人');

  const gross = num(f.gross_kg);
  const water = f.water_kg === '' || f.water_kg == null ? 0 : num(f.water_kg);
  const imp = f.impurity_kg === '' || f.impurity_kg == null ? 0 : num(f.impurity_kg);
  const wire = f.wire_kg === '' || f.wire_kg == null ? 0 : num(f.wire_kg);

  if (gross === null) E('gross_kg', '請填樣磚毛重（數字）');
  else if (gross <= 0) E('gross_kg', '樣磚毛重必須大於 0');
  for (const [k, v, label] of [['water_kg', water, '含水重'], ['impurity_kg', imp, '雜質重'], ['wire_kg', wire, '鐵絲重']]) {
    if (v === null) E(k, `${label}請填數字（沒有就填 0 或留空）`);
    else if (v < 0) E(k, `${label}不可為負數`);
  }
  for (const [k, v, label] of [['gross_kg', gross, '樣磚毛重'], ['water_kg', water, '含水重'], ['impurity_kg', imp, '雜質重'], ['wire_kg', wire, '鐵絲重']]) {
    if (v !== null && decimals(v) > RULES.maxDecimals) E(k, `${label}最多 ${RULES.maxDecimals} 位小數`);
  }
  if (gross > 0 && water !== null && imp !== null && wire !== null) {
    const sum = water + imp + wire;
    if (sum >= gross) E('gross_kg', `含水＋雜質＋鐵絲（${+sum.toFixed(3)} kg）不可大於或等於毛重（${gross} kg）`);
    else {
      // 合理性門檻：業務單位決定「先不設定」→ config.js 的值為 null 時不檢查
      if (RULES.grossMin != null && (gross < RULES.grossMin || gross > RULES.grossMax)) W('gross_kg', `樣磚毛重 ${gross} kg 超出一般範圍（${RULES.grossMin}～${RULES.grossMax} kg），請確認單位與數字`);
      if (RULES.waterRatioWarn != null && water / gross > RULES.waterRatioWarn) W('water_kg', `含水重占毛重 ${(water / gross * 100).toFixed(1)}%，偏高`);
      if (RULES.impurityRatioWarn != null && imp / gross > RULES.impurityRatioWarn) W('impurity_kg', `雜質重占毛重 ${(imp / gross * 100).toFixed(1)}%，偏高`);
      if (RULES.wireRatioWarn != null && wire / gross > RULES.wireRatioWarn) W('wire_kg', `鐵絲重占毛重 ${(wire / gross * 100).toFixed(1)}%，偏高`);
    }
  }

  // 疑似重複：同一天、同車號、同品號已有其他有效查驗
  if (f.inspected_at && f.vehicle_no && f.erp_code && ctx.existing) {
    const day = taipeiDate(f.inspected_at);
    const dup = ctx.existing.filter((x) => x.status === 'active' && x.inspection_id !== f.inspection_id
      && taipeiDate(x.inspected_at) === day && normPlate(x.vehicle_no) === normPlate(f.vehicle_no) && x.erp_code === f.erp_code);
    if (dup.length) W('vehicle_no', `當天已有相同車號＋品項的查驗（${dup.map((d) => d.sample_code).join('、')}）。若是同車第二趟請確認`);
  }
  return { errors, warnings, values: { gross, water: water ?? 0, imp: imp ?? 0, wire: wire ?? 0 } };
}
