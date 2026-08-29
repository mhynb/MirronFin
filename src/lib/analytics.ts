import type {
  Account,
  Asset,
  ClosePoint,
  InvestmentTxn,
  NavPoint,
  Transaction,
} from "./types";

/**
 * 收益算法（设计文档 §3.5）：
 * - XIRR 资金加权收益率（核心指标，考虑每笔资金进出时间）
 * - 最大回撤（基于每日组合市值序列）
 * - 分区间收益（期初/期末市值 + 区间现金流合成 XIRR）
 * vs 沪深300 曲线使用「按当日资金流调整」的日收益累乘。
 */

function dateMs(d: string): number {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
}

const byDateId = (a: InvestmentTxn, b: InvestmentTxn) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;

// ---------- 持仓推导 ----------

export interface Holding {
  asset: Asset;
  shares: number; // 当前份额
  cost: number; // 持有成本（移动加权平均）
  realized: number; // 已实现收益（赎回落袋部分）
  trades: InvestmentTxn[];
}

export function computeHolding(
  asset: Asset,
  trades: InvestmentTxn[]
): Holding {
  const sorted = [...trades].sort(byDateId);
  let shares = 0;
  let cost = 0;
  let realized = 0;
  for (const t of sorted) {
    if (t.type === "buy") {
      cost += t.amount;
      shares += t.shares;
    } else if (t.type === "sell") {
      const avg = shares > 0 ? cost / shares : 0;
      const costOut = avg * t.shares;
      realized += t.amount - costOut;
      cost = Math.max(0, cost - costOut);
      shares = Math.max(0, shares - t.shares);
    } else {
      // dividend：红利再投，份额累加、成本不变（设计文档 §3.3）
      shares += t.shares;
    }
  }
  return { asset, shares, cost, realized, trades: sorted };
}

/** 当月投资已实现盈亏：每个 asset 按平均成本法算当月 sell 的盈亏之和 */
export function monthRealized(trades: InvestmentTxn[], month: string): number {
  const byAsset = new Map<number, InvestmentTxn[]>();
  for (const t of trades) {
    if (!byAsset.has(t.asset_id)) byAsset.set(t.asset_id, []);
    byAsset.get(t.asset_id)!.push(t);
  }
  let total = 0;
  for (const ts of byAsset.values()) {
    const sorted = [...ts].sort(byDateId);
    let shares = 0;
    let cost = 0;
    for (const t of sorted) {
      if (t.type === "buy") {
        cost += t.amount;
        shares += t.shares;
      } else if (t.type === "sell") {
        const avg = shares > 0 ? cost / shares : 0;
        const costOut = avg * t.shares;
        if (t.date.slice(0, 7) === month) total += t.amount - costOut;
        cost = Math.max(0, cost - costOut);
        shares = Math.max(0, shares - t.shares);
      } else {
        shares += t.shares;
      }
    }
  }
  return total;
}

// ---------- XIRR ----------

export interface CashFlow {
  date: string;
  amount: number; // 负=投入，正=收回
}

export function xirr(flows: CashFlow[]): number | null {
  const f = flows.filter((x) => x.amount !== 0);
  if (!f.some((x) => x.amount < 0) || !f.some((x) => x.amount > 0)) return null;
  const t0 = Math.min(...f.map((x) => dateMs(x.date)));
  const npv = (r: number) =>
    f.reduce(
      (s, x) => s + x.amount / Math.pow(1 + r, (dateMs(x.date) - t0) / 31557600000),
      0
    );
  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

// ---------- 市值序列 ----------

export interface ValuePoint {
  date: string;
  value: number;
}

/** 单标的每日市值：净值日 × 当日累计份额（非净值日的交易顺延到下一净值日生效） */
export function buildAssetValueSeries(
  trades: InvestmentTxn[],
  navs: NavPoint[]
): ValuePoint[] {
  if (trades.length === 0 || navs.length === 0) return [];
  const sorted = [...trades].sort(byDateId);
  const firstDate = sorted[0].date;
  const points: ValuePoint[] = [];
  let ti = 0;
  let shares = 0;
  for (const n of navs) {
    if (n.date < firstDate) continue;
    while (ti < sorted.length && sorted[ti].date <= n.date) {
      const t = sorted[ti];
      if (t.type === "sell") shares -= t.shares;
      else shares += t.shares;
      ti++;
    }
    points.push({ date: n.date, value: Math.max(0, shares) * n.nav });
  }
  // 建仓日 ≥ 最后净值日时（净值当晚才公布），用最新净值补"今天"的点，
  // 否则序列整个为空 → 复盘页市值 0、XIRR 算出 -100%（真实踩过的坑）
  const lastNav = navs[navs.length - 1];
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(now.getDate()).padStart(2, "0")}`;
  if (lastNav && today > lastNav.date) {
    while (ti < sorted.length) {
      const t = sorted[ti];
      if (t.type === "sell") shares -= t.shares;
      else shares += t.shares;
      ti++;
    }
    if (shares > 0) {
      points.push({ date: today, value: shares * lastNav.nav });
    }
  }
  return points;
}

/** 多标的合并为组合每日市值（不同交易日历时按前值顺延） */
export function mergeSeries(perAsset: ValuePoint[][]): ValuePoint[] {
  const dates = [
    ...new Set(perAsset.flatMap((s) => s.map((p) => p.date))),
  ].sort();
  const idx = perAsset.map(() => 0);
  const last = perAsset.map(() => 0);
  const out: ValuePoint[] = [];
  for (const d of dates) {
    for (let i = 0; i < perAsset.length; i++) {
      while (idx[i] < perAsset[i].length && perAsset[i][idx[i]].date <= d) {
        last[i] = perAsset[i][idx[i]].value;
        idx[i]++;
      }
    }
    out.push({ date: d, value: last.reduce((a, b) => a + b, 0) });
  }
  return out;
}

export function valueAtOrBefore(series: ValuePoint[], date: string): number {
  let v = 0;
  for (const p of series) {
    if (p.date <= date) v = p.value;
    else break;
  }
  return v;
}

// ---------- 收益指标 ----------

/** 全部交易合成组合 XIRR 现金流（期末以当前市值作为收回） */
export function portfolioFlows(
  trades: InvestmentTxn[],
  endDate: string,
  endValue: number
): CashFlow[] {
  const flows: CashFlow[] = [];
  for (const t of trades) {
    if (t.type === "buy") flows.push({ date: t.date, amount: -t.amount });
    else if (t.type === "sell") flows.push({ date: t.date, amount: t.amount });
  }
  if (endValue > 0) flows.push({ date: endDate, amount: endValue });
  return flows;
}

/** 分区间年化收益：期初市值视为投入、期末市值视为收回、区间交易照实 */
export function periodXirr(
  series: ValuePoint[],
  trades: InvestmentTxn[],
  from: string,
  to: string
): number | null {
  const vFrom = valueAtOrBefore(series, from);
  const vTo = valueAtOrBefore(series, to);
  if (vFrom <= 0 && vTo <= 0) return null;
  const flows: CashFlow[] = [];
  if (vFrom > 0) flows.push({ date: from, amount: -vFrom });
  for (const t of trades) {
    if (t.date > from && t.date <= to) {
      if (t.type === "buy") flows.push({ date: t.date, amount: -t.amount });
      else if (t.type === "sell") flows.push({ date: t.date, amount: t.amount });
    }
  }
  if (vTo > 0) flows.push({ date: to, amount: vTo });
  return xirr(flows);
}

export interface Drawdown {
  pct: number;
  peakDate: string;
  troughDate: string;
}

export function maxDrawdown(series: ValuePoint[]): Drawdown | null {
  let peak = -Infinity;
  let peakDate = "";
  let best: Drawdown | null = null;
  for (const p of series) {
    if (p.value > peak) {
      peak = p.value;
      peakDate = p.date;
    }
    if (peak > 0) {
      const dd = (peak - p.value) / peak;
      if (!best || dd > best.pct) {
        best = { pct: dd, peakDate, troughDate: p.date };
      }
    }
  }
  return best;
}

/** 按当日资金流调整的累计收益曲线（vs 沪深300 用） */
export function flowAdjustedCumReturn(
  series: ValuePoint[],
  trades: InvestmentTxn[]
): ValuePoint[] {
  // 交易归集到其后的第一个序列日期（与市值序列的生效规则一致）
  const flowAt = new Array(series.length).fill(0);
  for (const t of trades) {
    const f =
      t.type === "buy" ? t.amount : t.type === "sell" ? -t.amount : 0;
    if (f === 0) continue;
    let lo = 0;
    let hi = series.length - 1;
    let pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].date >= t.date) {
        pos = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (pos >= 0) flowAt[pos] += f;
  }
  const out: ValuePoint[] = [];
  let cum = 1;
  for (let i = 0; i < series.length; i++) {
    const prev = i > 0 ? series[i - 1].value : 0;
    if (i === 0 || prev <= 0) {
      out.push({ date: series[i].date, value: 0 });
      continue;
    }
    const r = (series[i].value - flowAt[i]) / prev - 1;
    cum *= 1 + r;
    out.push({ date: series[i].date, value: cum - 1 });
  }
  return out;
}

export function benchmarkCumReturn(bench: ClosePoint[]): ValuePoint[] {
  if (bench.length === 0) return [];
  const base = bench[0].close;
  return bench.map((p) => ({ date: p.date, value: p.close / base - 1 }));
}

/** 基准区间年化：(1+区间收益)^(365/天数)-1，与组合 XIRR 可比 */
export function benchmarkPeriodAnnualized(
  bench: ClosePoint[],
  from: string,
  to: string
): number | null {
  const inRange = bench.filter((p) => p.date >= from && p.date <= to);
  if (inRange.length < 2) return null;
  const r = inRange[inRange.length - 1].close / inRange[0].close - 1;
  const days = (dateMs(inRange[inRange.length - 1].date) - dateMs(inRange[0].date)) / 86400000;
  if (days <= 0) return null;
  return Math.pow(1 + r, 365 / days) - 1;
}

// ---------- 资产配置趋势 ----------

export interface AllocPoint {
  date: string; // 月末日期
  cash: number;
  fund: number;
  stock: number;
  housing: number; // 公积金（housing_fund 类型账户余额，单列不并入现金）
}

function sharesHeldOn(trades: InvestmentTxn[], date: string): number {
  let s = 0;
  for (const t of trades) {
    if (t.date > date) break;
    if (t.type === "sell") s -= t.shares;
    else s += t.shares;
  }
  return Math.max(0, s);
}

function navAtOrBefore(navs: NavPoint[], date: string): number {
  let v = 0;
  for (const p of navs) {
    if (p.date <= date) v = p.nav;
    else break;
  }
  return v;
}

export function allocationTrend(
  monthEnds: string[],
  txns: Transaction[],
  trades: InvestmentTxn[],
  assets: Asset[],
  navsByAsset: Map<number, NavPoint[]>,
  accounts: Account[]
): AllocPoint[] {
  const assetById = new Map(assets.map((a) => [a.id, a]));
  // 按账户类型分组：housing_fund 单算，其余并入活钱 cash
  const housingIds = new Set(
    accounts.filter((a) => a.type === "housing_fund").map((a) => a.id)
  );
  const isHousing = (id: number | null) => id != null && housingIds.has(id);
  const cashOpening = accounts
    .filter((a) => a.type !== "housing_fund")
    .reduce((s, a) => s + a.opening_balance, 0);
  const housingOpening = accounts
    .filter((a) => a.type === "housing_fund")
    .reduce((s, a) => s + a.opening_balance, 0);

  return monthEnds.map((date) => {
    let cash = cashOpening;
    let housing = housingOpening;
    for (const t of txns) {
      if (t.date > date) break;
      if (t.type === "income") {
        if (isHousing(t.account_id)) housing += t.amount;
        else cash += t.amount;
      } else if (t.type === "expense") {
        if (isHousing(t.account_id)) housing -= t.amount;
        else cash -= t.amount;
      } else if (t.type === "transfer") {
        // 跨账户类型转账：工资→公积金 等
        const fromH = isHousing(t.account_id);
        const toH = isHousing(t.to_account_id);
        if (fromH && !toH) {
          housing -= t.amount;
          cash += t.amount;
        } else if (!fromH && toH) {
          cash -= t.amount;
          housing += t.amount;
        }
        // 同类转账总量不变
      }
    }
    for (const t of trades) {
      if (t.date > date) break;
      // account_id 为空 = 期初建仓，不动现金
      if (t.account_id == null) continue;
      if (t.type === "buy") {
        if (isHousing(t.account_id)) housing -= t.amount;
        else cash -= t.amount;
      } else if (t.type === "sell") {
        if (isHousing(t.account_id)) housing += t.amount;
        else cash += t.amount;
      }
    }
    let fund = 0;
    let stock = 0;
    for (const [assetId, navs] of navsByAsset) {
      const asset = assetById.get(assetId);
      if (!asset) continue;
      const assetTrades = trades.filter((t) => t.asset_id === assetId);
      const mv = sharesHeldOn(assetTrades, date) * navAtOrBefore(navs, date);
      if (asset.type === "fund") fund += mv;
      else stock += mv;
    }
    return { date, cash, fund, stock, housing };
  });
}

/** 最近 N 个月的月末日期序列（升序） */
export function lastMonthEnds(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
    out.push(s);
  }
  return out;
}
