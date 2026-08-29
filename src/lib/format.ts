/** 金额格式化：千分位 + 两位小数 */
export function fmtMoney(n: number, withSign = false): string {
  const abs = Math.abs(n).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (withSign) return (n > 0 ? "+" : n < 0 ? "-" : "") + abs;
  return (n < 0 ? "-" : "") + abs;
}

/** 今天，YYYY-MM-DD（本地时区） */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/** 当前月份，YYYY-MM */
export function currentMonth(): string {
  return todayStr().slice(0, 7);
}

/** "2026-07" -> "2026年7月" */
export function monthLabel(m: string): string {
  return `${m.slice(0, 4)}年${Number(m.slice(5, 7))}月`;
}

/** "2026-07-21" -> "07-21" */
export function shortDate(d: string): string {
  return d.slice(5);
}

/** "2026-08-02" -> "8月2日 周六"；若是今天则显示"8月2日 · 今天" */
export function dayLabel(d: string): string {
  const date = new Date(d + "T00:00:00");
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (d === todayStr()) return `${md} · 今天`;
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  return `${md} ${wk}`;
}

/** 0.1234 -> "12.34%"；null/NaN -> "—" */
export function fmtPct(r: number | null, digits = 2): string {
  if (r === null || !Number.isFinite(r)) return "—";
  return (r * 100).toFixed(digits) + "%";
}
