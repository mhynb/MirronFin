import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import Chart from "../components/Chart";
import AdvisorReport, { type AdvisorContent } from "../components/AdvisorReport";
import {
  allocationTrend,
  benchmarkCumReturn,
  benchmarkPeriodAnnualized,
  buildAssetValueSeries,
  computeHolding,
  flowAdjustedCumReturn,
  lastMonthEnds,
  maxDrawdown,
  mergeSeries,
  periodXirr,
  portfolioFlows,
  xirr,
  type ValuePoint,
} from "../lib/analytics";
import {
  listAccounts,
  listAssets,
  listBenchmark,
  listInvestmentTxns,
  listNavSnapshots,
  listTransactions,
} from "../lib/db";
import { fmtMoney, fmtPct, todayStr } from "../lib/format";
import { BENCHMARK_CSI300 } from "../lib/market";
import { IconGear, IconSparkle } from "../components/Icons";
import {
  type Account,
  type Asset,
  type AssetCategory,
  ASSET_CATEGORY_LABEL,
  type CheckItem,
  type CheckStatus,
  type InvestmentTxn,
  type NavPoint,
  type Transaction,
} from "../lib/types";

interface Range {
  from: string;
  to: string;
}

const PRESETS: { key: string; label: string; months: number | null }[] = [
  { key: "all", label: "全部", months: null },
  { key: "1m", label: "近1月", months: 1 },
  { key: "3m", label: "近3月", months: 3 },
  { key: "6m", label: "近6月", months: 6 },
  { key: "1y", label: "近1年", months: 12 },
];

/**
 * AI 复盘的分析视角（技能包）。
 * 名称必须与 advisor_system_prompt.md 里的视角名逐字一致——
 * prompt 靠这个名字去匹配对应的分析清单。
 */
const AI_SKILLS: { name: string; hint: string }[] = [
  { name: "全面复盘", hint: "投资、消费、退休三条线各抓最要紧的一点" },
  { name: "消费诊断", hint: "钱花在哪、哪一笔最该管，会点名具体分类" },
  { name: "投资组合体检", hint: "攻守配比、集中度、跑赢还是跑输大盘" },
  { name: "退休进度", hint: "按当前节奏还要多少年，提速杠杆在哪" },
  { name: "本月复盘", hint: "本月 vs 上月，差多少、因为什么" },
];

function shiftMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export default function ReviewPage() {
  const [trades, setTrades] = useState<InvestmentTxn[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [navsByAsset, setNavsByAsset] = useState<Map<number, NavPoint[]>>(
    new Map()
  );
  const [bench, setBench] = useState<{ date: string; close: number }[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preset, setPreset] = useState("all");
  const [range, setRange] = useState<Range | null>(null);

  const load = useCallback(async () => {
    const [assetsAll, tradesAll, txnsAll, benchAll, accountsAll] =
      await Promise.all([
        listAssets(),
        listInvestmentTxns(),
        listTransactions({}),
        listBenchmark(BENCHMARK_CSI300),
        listAccounts(),
      ]);
    const used = assetsAll.filter((a) =>
      tradesAll.some((t) => t.asset_id === a.id)
    );
    const navs = new Map<number, NavPoint[]>();
    for (const a of used) {
      navs.set(a.id, await listNavSnapshots(a.id));
    }
    setAssets(used);
    setTrades(tradesAll);
    setTxns(txnsAll);
    setNavsByAsset(navs);
    setBench(benchAll);
    setAccounts(accountsAll);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 组合每日市值序列（全区间）
  const series = useMemo<ValuePoint[]>(() => {
    const perAsset = assets.map((a) =>
      buildAssetValueSeries(
        trades.filter((t) => t.asset_id === a.id),
        navsByAsset.get(a.id) ?? []
      )
    );
    return mergeSeries(perAsset);
  }, [assets, trades, navsByAsset]);

  const firstDate = series[0]?.date ?? null;
  const lastDate = series[series.length - 1]?.date ?? todayStr();
  const effRange: Range | null = series.length
    ? range ?? { from: firstDate!, to: lastDate }
    : null;

  const ranged = useMemo(() => {
    if (!effRange) return { s: [] as ValuePoint[], b: [] as typeof bench };
    return {
      s: series.filter(
        (p) => p.date >= effRange.from && p.date <= effRange.to
      ),
      b: bench.filter((p) => p.date >= effRange.from && p.date <= effRange.to),
    };
  }, [series, bench, effRange]);

  // 汇总指标
  const totalMV = series[series.length - 1]?.value ?? 0;
  const costSum = useMemo(
    () =>
      assets.reduce(
        (sum, a) =>
          sum +
          computeHolding(
            a,
            trades.filter((t) => t.asset_id === a.id)
          ).cost,
        0
      ),
    [assets, trades]
  );
  const netInvested = useMemo(
    () =>
      trades.reduce(
        (s, t) => s + (t.type === "buy" ? t.amount : t.type === "sell" ? -t.amount : 0),
        0
      ),
    [trades]
  );
  const totalPnl = totalMV - netInvested;
  const portfolioXirr = useMemo(
    () => (series.length ? xirr(portfolioFlows(trades, lastDate, totalMV)) : null),
    [series, trades, lastDate, totalMV]
  );
  const dd = useMemo(() => maxDrawdown(ranged.s), [ranged.s]);
  const periodPf = useMemo(
    () =>
      effRange
        ? periodXirr(series, trades, effRange.from, effRange.to)
        : null,
    [series, trades, effRange]
  );
  const periodBench = useMemo(
    () =>
      effRange
        ? benchmarkPeriodAnnualized(bench, effRange.from, effRange.to)
        : null,
    [bench, effRange]
  );

  // 全量区间指标——专门喂给 AI（决策：AI 始终看全量，不随页面区间选择器变化）。
  // 页面 stat-grid/图表仍用上面的 range 依赖版本（periodPf/dd 等）。
  const fullPeriodPf = useMemo(
    () => (firstDate ? periodXirr(series, trades, firstDate, lastDate) : null),
    [series, trades, firstDate, lastDate]
  );
  const fullPeriodBench = useMemo(
    () =>
      firstDate ? benchmarkPeriodAnnualized(bench, firstDate, lastDate) : null,
    [bench, firstDate, lastDate]
  );
  const fullDd = useMemo(() => maxDrawdown(series), [series]);

  const pfCurve = useMemo(() => {
    const full = flowAdjustedCumReturn(series, trades);
    const inRange = full.filter(
      (p) => effRange && p.date >= effRange.from && p.date <= effRange.to
    );
    const base = inRange[0]?.value ?? 0;
    return inRange.map((p) => [p.date, +((p.value - base) * 100).toFixed(2)]);
  }, [series, trades, effRange]);

  const benchCurve = useMemo(() => {
    const full = benchmarkCumReturn(ranged.b);
    return full.map((p) => [p.date, +(p.value * 100).toFixed(2)]);
  }, [ranged.b]);

  const compareOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: unknown) => `${Number(v).toFixed(2)}%`,
    },
    legend: { bottom: 0 },
    grid: { left: 8, right: 8, top: 20, bottom: 44, containLabel: true },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        name: "我的组合",
        type: "line",
        data: pfCurve,
        showSymbol: false,
        lineStyle: { width: 2, color: "#007AFF" },
        itemStyle: { color: "#007AFF" },
      },
      {
        name: "沪深300",
        type: "line",
        data: benchCurve,
        showSymbol: false,
        lineStyle: { width: 1.5, color: "#8E8E93" },
        itemStyle: { color: "#8E8E93" },
      },
    ],
  };

  const alloc = useMemo(
    () =>
      txns.length || trades.length || accounts.length
        ? allocationTrend(
            lastMonthEnds(12),
            txns,
            trades,
            assets,
            navsByAsset,
            accounts
          )
        : [],
    [txns, trades, assets, navsByAsset, accounts]
  );

  const allocOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: unknown) => "¥" + fmtMoney(Number(v)),
    },
    legend: { bottom: 0 },
    grid: { left: 8, right: 8, top: 20, bottom: 44, containLabel: true },
    xAxis: {
      type: "category",
      data: alloc.map((p) => p.date.slice(0, 7)),
    },
    yAxis: { type: "value" },
    series: [
      {
        name: "现金",
        type: "line",
        stack: "total",
        areaStyle: { opacity: 0.3 },
        showSymbol: false,
        lineStyle: { width: 1.5 },
        itemStyle: { color: "#8E8E93" },
        data: alloc.map((p) => +p.cash.toFixed(2)),
      },
      {
        name: "基金",
        type: "line",
        stack: "total",
        areaStyle: { opacity: 0.3 },
        showSymbol: false,
        lineStyle: { width: 1.5 },
        itemStyle: { color: "#007AFF" },
        data: alloc.map((p) => +p.fund.toFixed(2)),
      },
      {
        name: "股票",
        type: "line",
        stack: "total",
        areaStyle: { opacity: 0.3 },
        showSymbol: false,
        lineStyle: { width: 1.5 },
        itemStyle: { color: "#FF9500" },
        data: alloc.map((p) => +p.stock.toFixed(2)),
      },
      {
        name: "公积金",
        type: "line",
        stack: "total",
        areaStyle: { opacity: 0.3 },
        showSymbol: false,
        lineStyle: { width: 1.5 },
        itemStyle: { color: "#34C759" },
        data: alloc.map((p) => +p.housing.toFixed(2)),
      },
    ],
  };

  // ---------- AI 复盘：体检事实与配置结构（前端确定性计算，AI 只负责解读） ----------

  const advisorFacts = useMemo(() => {
    // 六档投资组合占比 + 已实现收益
    const catMV: Partial<Record<AssetCategory, number>> = {};
    let realized = 0;
    for (const a of assets) {
      const h = computeHolding(a, trades.filter((t) => t.asset_id === a.id));
      realized += h.realized;
      const navs = navsByAsset.get(a.id) ?? [];
      const lastNav = navs.length ? navs[navs.length - 1].nav : 0;
      const mv = h.shares * lastNav;
      catMV[a.category] = (catMV[a.category] ?? 0) + mv;
    }
    const investMV = (Object.values(catMV) as number[]).reduce(
      (s, x) => s + x,
      0
    );
    const pctOf = (mv: number) => (investMV > 0 ? mv / investMV : 0);

    const offense = pctOf((catMV.stock ?? 0) + (catMV.qdii ?? 0));
    const defense = pctOf((catMV.bond ?? 0) + (catMV.money ?? 0));
    const commodity = pctOf(catMV.commodity ?? 0);
    const holdingList = assets.map((a) => {
      const h = computeHolding(a, trades.filter((t) => t.asset_id === a.id));
      const navs = navsByAsset.get(a.id) ?? [];
      const lastNav = navs.length ? navs[navs.length - 1].nav : 0;
      return { name: a.name, mv: h.shares * lastNav };
    });
    const top1 = [...holdingList].sort((x, y) => y.mv - x.mv)[0] ?? null;
    const top1Pct = investMV > 0 && top1 ? top1.mv / investMV : 0;

    // 近 12 个月收支（从全量流水聚合）
    const monthMap = new Map<string, { income: number; expense: number }>();
    for (const t of txns) {
      const k = t.date.slice(0, 7);
      const e = monthMap.get(k) ?? { income: 0, expense: 0 };
      if (t.type === "income") e.income += t.amount;
      else if (t.type === "expense") e.expense += t.amount;
      monthMap.set(k, e);
    }
    const months = [...monthMap.entries()]
      .sort((x, y) => (x[0] < y[0] ? 1 : -1))
      .slice(0, 12);
    const n = Math.max(months.length, 1);
    const avgIncome = months.reduce((s, [, v]) => s + v.income, 0) / n;
    const avgExpense = months.reduce((s, [, v]) => s + v.expense, 0) / n;
    const avgSaving = avgIncome - avgExpense;
    const savingRate = avgIncome > 0 ? avgSaving / avgIncome : null;

    // 活钱（非公积金账户余额）
    const cashBalance = accounts
      .filter((a) => a.type !== "housing_fund")
      .reduce((s, a) => s + a.balance, 0);
    const cashMonths = avgExpense > 0 ? cashBalance / avgExpense : null;

    // 退休进度
    const totalAssets = totalMV + cashBalance;
    const monthlyPassive =
      portfolioXirr != null ? (portfolioXirr * totalAssets) / 12 : null;
    const targetCapital =
      portfolioXirr != null && portfolioXirr > 0 && avgExpense > 0
        ? (avgExpense * 12) / portfolioXirr
        : null;
    const gap = targetCapital != null ? targetCapital - totalAssets : null;
    const yearsToGo =
      gap != null && gap > 0 && avgSaving > 0 ? gap / avgSaving / 12 : null;

    const mk = (
      label: string,
      status: CheckStatus,
      value: string,
      range: string,
      detail: string
    ): CheckItem => ({ 项目: label, 状态: status, 当前值: value, 参考区间: range, 说明: detail });

    const checks: CheckItem[] = [
      mk(
        "进攻仓占比（股票指数+QDII）",
        offense < 0.2 ? "偏低" : offense > 0.6 ? "偏高" : "达标",
        fmtPct(offense),
        "20%-60%",
        "进攻仓决定组合弹性，过高波动大、过低难跑赢通胀"
      ),
      mk(
        "防守垫占比（债券固收+货币）",
        defense < 0.2 ? "偏低" : defense > 0.7 ? "偏高" : "达标",
        fmtPct(defense),
        "20%-70%",
        "防守垫用于回撤时稳心态、留弹药"
      ),
      mk(
        "商品占比（黄金等）",
        commodity > 0.2 ? "偏高" : "达标",
        fmtPct(commodity),
        "0%-20%",
        "商品是对冲配置，不宜过重"
      ),
      mk(
        "单标的集中度",
        top1Pct > 0.4 ? "偏高" : "达标",
        fmtPct(top1Pct),
        "≤40%",
        top1 ? `最大持仓为「${top1.name}」` : "暂无持仓"
      ),
      mk(
        "活钱覆盖月数",
        cashMonths == null ? "偏低" : cashMonths < 3 ? "偏低" : cashMonths > 12 ? "偏高" : "达标",
        cashMonths == null ? "—" : `${cashMonths.toFixed(1)} 个月`,
        "3-12 个月",
        "按月均支出计算，覆盖突发用款避免低位割肉"
      ),
    ];
    if (savingRate != null) {
      checks.push(
        mk(
          "储蓄率",
          savingRate < 0.2 ? "偏低" : "达标",
          fmtPct(savingRate),
          "≥20%（刚工作可放宽）",
          "储蓄率是退休进度提升最快的变量"
        )
      );
    }

    return {
      catMV,
      investMV,
      offense,
      defense,
      commodity,
      top1,
      top1Pct,
      avgIncome,
      avgExpense,
      avgSaving,
      savingRate,
      cashBalance,
      cashMonths,
      monthlyPassive,
      targetCapital,
      gap,
      yearsToGo,
      realized,
      checks,
    };
  }, [assets, trades, navsByAsset, txns, accounts, portfolioXirr, totalMV]);

  // ---------- 消费侧洞察（AI 摘要专用，纯前端从全量流水算） ----------
  // 此前 AI 只看得到「月均支出」一个总数，关于消费的建议必然是空话。
  // 这里补齐分类结构、环比、节奏，AI 才说得出生动具体的洞察
  // （如「人情 2 笔吃掉 67%，餐饮 57 笔只占 7%」）。
  const spendInsights = useMemo(() => {
    const now = new Date();
    const mk = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const curMonth = mk(now);
    const monthsBack = (n: number) => mk(new Date(now.getFullYear(), now.getMonth() - n, 1));
    const mkey = (d: string) => d.slice(0, 7);

    const expTxns = txns.filter((t) => t.type === "expense");

    // 近 3 个月（含当月）支出分类，按金额降序取前 8
    const since3 = monthsBack(2);
    const catMap = new Map<string, { amt: number; count: number }>();
    let spend3 = 0;
    for (const t of expTxns) {
      if (mkey(t.date) < since3) continue;
      const key = t.category_name ?? "未分类";
      const cur = catMap.get(key) ?? { amt: 0, count: 0 };
      cur.amt += t.amount;
      cur.count += 1;
      catMap.set(key, cur);
      spend3 += t.amount;
    }
    const topCats = [...catMap.entries()]
      .map(([分类, v]) => ({
        分类,
        金额: +v.amt.toFixed(2),
        占比百分比: spend3 > 0 ? +((v.amt / spend3) * 100).toFixed(1) : 0,
        笔数: v.count,
        月均: +(v.amt / 3).toFixed(2),
        单笔均值: +(v.amt / v.count).toFixed(2),
      }))
      .sort((a, b) => b.金额 - a.金额)
      .slice(0, 8);

    // 近 6 个月收支序列（含储蓄率）
    // 关键：跳过「收入=0 且 支出=0」的未记账月份——混进来会把月均收入严重拉低，
    // AI 会误以为用户那几个月真的零收入
    const monthly: {
      月份: string;
      收入: number;
      支出: number;
      净储蓄: number;
      储蓄率百分比: number | null;
      是否完整月: boolean;
    }[] = [];
    for (let i = 5; i >= 0; i--) {
      const m = monthsBack(i);
      const inc = txns
        .filter((t) => t.type === "income" && mkey(t.date) === m)
        .reduce((s, t) => s + t.amount, 0);
      const exp = txns
        .filter((t) => t.type === "expense" && mkey(t.date) === m)
        .reduce((s, t) => s + t.amount, 0);
      if (inc === 0 && exp === 0) continue; // 未记账的月份不进序列
      const net = inc - exp;
      monthly.push({
        月份: m,
        收入: +inc.toFixed(2),
        支出: +exp.toFixed(2),
        净储蓄: +net.toFixed(2),
        储蓄率百分比: inc > 0 ? +((net / inc) * 100).toFixed(1) : null,
        是否完整月: i > 0, // i=0 即当月，仍在进行中
      });
    }

    // 当月支出节奏
    const curTxns = expTxns.filter((t) => mkey(t.date) === curMonth);
    const curTotal = curTxns.reduce((s, t) => s + t.amount, 0);
    const activeDays = new Set(curTxns.map((t) => t.date)).size;
    const elapsed = now.getDate();
    const byDay = new Map<string, number>();
    for (const t of curTxns) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.amount);
    let peak = 0;
    let peakDate: string | null = null;
    for (const [d, v] of byDay)
      if (v > peak) {
        peak = v;
        peakDate = d;
      }

    // 支出环比（当月 vs 上月）
    // 保护：当月仍在进行中时，已过不足 5 天就不给环比——
    // 9 月 4 天 vs 8 月整月会算出 -98.8%，技术上没错但严重误导
    const cur = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    const comparable = !!cur && !!prev && (cur.是否完整月 || elapsed >= 5);
    const momPct =
      comparable && prev!.支出 > 0
        ? +(((cur!.支出 - prev!.支出) / prev!.支出) * 100).toFixed(1)
        : null;

    // 储蓄率趋势：后半段均值 vs 前半段均值
    const valid = monthly.filter((m) => m.储蓄率百分比 !== null);
    let trend = "数据不足";
    if (valid.length >= 4) {
      const half = Math.floor(valid.length / 2);
      const avg = (arr: typeof valid) =>
        arr.reduce((s, m) => s + (m.储蓄率百分比 ?? 0), 0) / arr.length;
      const diff = avg(valid.slice(-half)) - avg(valid.slice(0, half));
      trend = diff > 3 ? "改善" : diff < -3 ? "恶化" : "稳定";
    }

    // 近 3 月最大单笔（不含备注，保护隐私）
    let maxOne: { 分类: string; 金额: number; 日期: string } | null = null;
    for (const t of expTxns) {
      if (mkey(t.date) < since3) continue;
      if (!maxOne || t.amount > maxOne.金额) {
        maxOne = {
          分类: t.category_name ?? "未分类",
          金额: +t.amount.toFixed(2),
          日期: t.date,
        };
      }
    }

    return {
      topCats,
      monthly,
      curMonth,
      curTotal: +curTotal.toFixed(2),
      activeDays,
      elapsed,
      peak: +peak.toFixed(2),
      peakDate,
      momPct,
      trend,
      maxOne,
      spend3: +spend3.toFixed(2),
    };
  }, [txns]);

  // ---------- AI 理财顾问 ----------
  const [aiReady, setAiReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [cfg, setCfg] = useState({
    base_url: "https://api.deepseek.com/v1",
    api_key: "",
    model: "deepseek-chat",
  });
  const [report, setReport] = useState<{
    structured: boolean;
    content: AdvisorContent | string;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [skill, setSkill] = useState(AI_SKILLS[0].name);
  /** 报告是用哪个视角生成的（生成瞬间锁定，避免中途改视角造成「报告与标签不符」） */
  const [reportSkill, setReportSkill] = useState(AI_SKILLS[0].name);

  // 构造发给 AI 的结构化摘要（只发指标+配置+持仓概览，不含逐笔流水）
  const buildSummary = useCallback((): string => {
    // 「持有天数」口径修复：单看 < 90 天会全判噪音，让 AI 无话可说。
    // 把"首次买入日距今"改成「[90天观察期]内观察 vs 已过观察期」——
    // 前者 AI 转去看配置意图/集中度，后者 AI 就能正常用 XIRR 评价。
    // 同时把「观察期摘要」放在顶层，让 AI 看到全局而不是一个个标各自算。
    const NEW_HOLD_DAYS = 90;
    const nowMs = Date.now();
    const holdings = assets
      .map((a) => {
        const h = computeHolding(a, trades.filter((t) => t.asset_id === a.id));
        const navs = navsByAsset.get(a.id) ?? [];
        const lastNav = navs.length ? navs[navs.length - 1].nav : 0;
        const mv = h.shares * lastNav;
        const pnl = mv - h.cost + h.realized;
        const pct = totalMV > 0 ? (mv / totalMV) * 100 : 0;
        const firstBuy = h.trades.find((t) => t.type === "buy")?.date ?? null;
        const holdDays = firstBuy
          ? Math.max(
              1,
              Math.round((nowMs - new Date(firstBuy).getTime()) / 86400000)
            )
          : null;
        return {
          名称: a.name,
          类型: a.type === "fund" ? "基金" : "股票",
          风格: ASSET_CATEGORY_LABEL[a.category] ?? a.category,
          占比百分比: +pct.toFixed(1),
          市值: +mv.toFixed(2),
          成本: +h.cost.toFixed(2),
          大致盈亏: +pnl.toFixed(2),
          收益率百分比: h.cost > 0 ? +((pnl / h.cost) * 100).toFixed(2) : null,
          持有天数: holdDays,
          是否新仓: holdDays != null && holdDays < NEW_HOLD_DAYS,
          首次买入日: firstBuy,
        };
      })
      .filter((h) => h.市值 > 0);
    const holdDaysList = holdings
      .map((h) => h.持有天数)
      .filter((d): d is number => d !== null);
    const maxHoldDays = holdDaysList.length ? Math.max(...holdDaysList) : 0;
    const minHoldDays = holdDaysList.length ? Math.min(...holdDaysList) : 0;
    const allNew = holdings.length > 0 && holdDaysList.every((d) => d < NEW_HOLD_DAYS);

    const buyTrades = trades.filter((t) => t.type === "buy");
    const sellTrades = trades.filter((t) => t.type === "sell");
    const buyMonths = new Set(buyTrades.map((t) => t.date.slice(0, 7)));
    const lastOpDate = trades.length
      ? trades.reduce((m, t) => (t.date > m ? t.date : m), trades[0].date)
      : null;
    const last = alloc.length ? alloc[alloc.length - 1] : null;
    const f = advisorFacts;
    const catPct = (mv: number) =>
      f.investMV > 0 ? +((mv / f.investMV) * 100).toFixed(1) : 0;
    const summary = {
      指标: {
        XIRR年化收益率百分比:
          portfolioXirr == null ? null : +(portfolioXirr * 100).toFixed(2),
        当前市值: +totalMV.toFixed(2),
        累计收益: +totalPnl.toFixed(2),
        最大回撤百分比: fullDd ? +(fullDd.pct * 100).toFixed(2) : null,
        区间年化组合百分比:
          fullPeriodPf == null ? null : +(fullPeriodPf * 100).toFixed(2),
        区间年化沪深300百分比:
          fullPeriodBench == null ? null : +(fullPeriodBench * 100).toFixed(2),
        超额组合减沪深300百分比:
          fullPeriodPf != null && fullPeriodBench != null
            ? +((fullPeriodPf - fullPeriodBench) * 100).toFixed(2)
            : null,
      },
      资产配置结构: {
        活钱: +f.cashBalance.toFixed(2),
        公积金: +accounts
          .filter((a) => a.type === "housing_fund")
          .reduce((s, a) => s + a.balance, 0)
          .toFixed(2),
        投资组合市值: +f.investMV.toFixed(2),
        六档占投资组合百分比: {
          货币: catPct(f.catMV.money ?? 0),
          债券固收: catPct(f.catMV.bond ?? 0),
          混合: catPct(f.catMV.mixed ?? 0),
          股票指数: catPct(f.catMV.stock ?? 0),
          QDII海外: catPct(f.catMV.qdii ?? 0),
          商品: catPct(f.catMV.commodity ?? 0),
        },
      },
      体检: f.checks,
      储蓄与退休: {
        月均收入: +f.avgIncome.toFixed(2),
        月均支出: +f.avgExpense.toFixed(2),
        月均净储蓄: +f.avgSaving.toFixed(2),
        储蓄率百分比: f.savingRate == null ? null : +(f.savingRate * 100).toFixed(1),
        月被动收入估算:
          f.monthlyPassive == null ? null : +f.monthlyPassive.toFixed(2),
        退休目标本金: f.targetCapital == null ? null : +f.targetCapital.toFixed(2),
        退休资产缺口: f.gap == null ? null : +f.gap.toFixed(2),
        按当前储蓄预计年数:
          f.yearsToGo == null ? null : +f.yearsToGo.toFixed(1),
      },
      消费与支出: {
        近3月支出合计: spendInsights.spend3,
        近3月支出分类: spendInsights.topCats,
        当月: {
          月份: spendInsights.curMonth,
          支出合计: spendInsights.curTotal,
          已过天数: spendInsights.elapsed,
          有支出天数: spendInsights.activeDays,
          日均支出:
            spendInsights.elapsed > 0
              ? +(spendInsights.curTotal / spendInsights.elapsed).toFixed(2)
              : 0,
          单日峰值金额: spendInsights.peak,
          单日峰值日期: spendInsights.peakDate,
        },
        近6月月度收支: spendInsights.monthly,
        当月支出环比百分比: spendInsights.momPct,
        储蓄率趋势: spendInsights.trend,
        近3月最大单笔支出: spendInsights.maxOne,
      },
      资产配置最近月末: last
        ? {
            现金: +last.cash.toFixed(2),
            基金: +last.fund.toFixed(2),
            股票: +last.stock.toFixed(2),
            公积金: +last.housing.toFixed(2),
          }
        : null,
      配置近12月变化: alloc.map((p) => ({
        月份: p.date.slice(0, 7),
        现金: +p.cash.toFixed(2),
        基金: +p.fund.toFixed(2),
        股票: +p.stock.toFixed(2),
      })),
      持仓概览: holdings,
      持仓观察期: holdings.length
        ? {
            最长持有天数: maxHoldDays,
            最短持有天数: minHoldDays,
            是否全部处于新仓期: allNew,
            新仓数: holdings.filter((h) => h.是否新仓).length,
            总持仓数: holdings.length,
            说明: allNew
              ? "全部持仓都还在 90 天观察期内，收益率波动基本是噪音；评价侧重配置意图、集中度、交易节奏，收益数据作为参考。"
              : "部分持仓已过观察期，可正常用收益率评价选品能力。",
          }
        : null,
      交易行为: {
        买入次数: buyTrades.length,
        卖出次数: sellTrades.length,
        最近操作日: lastOpDate,
        定期买入迹象: buyMonths.size >= 3,
        已实现收益: +f.realized.toFixed(2),
        浮动盈亏: +(totalPnl - f.realized).toFixed(2),
      },
    };
    return JSON.stringify(summary, null, 2);
  }, [assets, trades, navsByAsset, totalMV, portfolioXirr, totalPnl, fullDd, fullPeriodPf, fullPeriodBench, alloc, accounts, advisorFacts, spendInsights]);

  const runAnalysis = useCallback(async () => {
    if (aiLoading) return;
    setAiError(null);
    setReport(null);
    setReportSkill(skill);
    setAiLoading(true);
    try {
      const summary = buildSummary();
      const userMsg =
        `本次分析视角：${skill}\n\n` +
        "以下是这位 MirrorFin 用户的复盘数据摘要，请作为理财顾问分析并输出 JSON：\n\n" +
        summary;
      const env = await invoke<{
        structured: boolean;
        content: AdvisorContent | string;
      }>("ask_ai", { payload: userMsg });
      setReport(env);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      if (msg === "__CONFIG_ERROR__") {
        setAiError("尚未配置 API Key，请先在设置中填写。");
        setShowSettings(true);
      } else {
        setAiError(msg);
      }
    } finally {
      setAiLoading(false);
    }
  }, [aiLoading, buildSummary, skill]);

  const openAi = () => {
    if (aiReady) runAnalysis();
    else setShowSettings(true);
  };

  const saveSettings = async () => {
    try {
      await invoke("save_ai_config", {
        baseUrl: cfg.base_url,
        apiKey: cfg.api_key,
        model: cfg.model,
      });
      setAiReady(true);
      setShowSettings(false);
      runAnalysis();
    } catch (e) {
      setAiError(typeof e === "string" ? e : "保存失败：" + String(e));
    }
  };

  // 进入页面时检测是否已配置，并回填已保存的配置 + 回显上次的复盘报告
  useEffect(() => {
    if (!loaded) return;
    invoke<boolean>("ai_configured")
      .then(setAiReady)
      .catch(() => setAiReady(false));
    invoke<{ base_url: string; api_key: string; model: string }>("load_ai_config")
      .then((saved) => {
        if (saved.api_key || saved.base_url || saved.model) {
          setCfg(saved);
        }
      })
      .catch(() => {});
    // 回显最近一次持久化的报告（不必重新调用 AI）
    invoke<{ structured: boolean; content: AdvisorContent | string } | null>(
      "load_ai_report"
    )
      .then((saved) => {
        if (saved) setReport(saved);
      })
      .catch(() => {});
  }, [loaded]);

  if (loaded && trades.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">复盘</div>
            <div className="page-sub">真实收益 · 跑赢大盘了吗</div>
          </div>
        </div>
        <div className="empty">
          <div className="empty-title">还没有投资数据</div>
          <div className="empty-sub">
            先去<Link to="/entry">录入</Link>投资交易，再到<Link to="/holdings">持仓</Link>
            页同步行情，这里就能算了
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">复盘</div>
          <div className="page-sub">真实收益 · 跑赢大盘了吗</div>
        </div>
      </div>

      <div className="card hero-card section-gap">
        <div className="hero-label">XIRR 年化（资金加权）</div>
        <div
          className={`hero-value num ${
            (portfolioXirr ?? 0) > 0
              ? "text-rise"
              : (portfolioXirr ?? 0) < 0
              ? "text-fall"
              : ""
          }`}
        >
          {portfolioXirr == null ? (
            "—"
          ) : (
            <>
              {fmtPct(portfolioXirr).replace("%", "")}
              <span className="hero-dec">%</span>
            </>
          )}
        </div>
        <div className="hero-sub">
          真实收益率，考虑每笔资金进出时间 · 净投入 ¥{fmtMoney(netInvested)}
        </div>
        <div className="hero-metrics">
          <div className="hero-metric">
            <div className="hero-metric-label">当前市值</div>
            <div className="hero-metric-value num">¥{fmtMoney(totalMV)}</div>
          </div>
          <div className="hero-metric">
            <div className="hero-metric-label">累计收益</div>
            <div
              className={`hero-metric-value num ${
                totalPnl > 0 ? "text-rise" : totalPnl < 0 ? "text-fall" : ""
              }`}
            >
              {totalPnl >= 0 ? "+" : ""}¥{fmtMoney(totalPnl)}
            </div>
            <div className="hero-metric-sub">
              持有成本 ¥{fmtMoney(costSum)}
            </div>
          </div>
          <div className="hero-metric">
            <div className="hero-metric-label">最大回撤</div>
            <div className="hero-metric-value num text-fall">
              {dd ? `-${fmtPct(dd.pct)}` : "—"}
            </div>
            <div className="hero-metric-sub">
              {dd ? `${dd.peakDate} → ${dd.troughDate}` : "数据不足"}
            </div>
          </div>
        </div>
      </div>

      <div className="card section-gap">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div className="card-title" style={{ marginBottom: 0 }}>
            收益曲线 vs 沪深300
          </div>
          <div className="range-bar">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={`chip ${preset === p.key ? "active" : ""}`}
                onClick={() => {
                  setPreset(p.key);
                  if (p.months === null) setRange(null);
                  else
                    setRange({
                      from:
                        firstDate && shiftMonths(p.months) < firstDate
                          ? firstDate
                          : shiftMonths(p.months),
                      to: todayStr(),
                    });
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {series.length > 1 ? (
          <Chart option={compareOption} height={300} />
        ) : (
          <div className="empty">
            <div className="empty-sub">
              {series.length === 1
                ? "今天刚建仓，收益曲线从明天开始积累"
                : "净值数据不足，去持仓页点「同步行情」"}
            </div>
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 24,
            marginTop: 12,
            fontSize: 13,
            color: "var(--text-secondary)",
            flexWrap: "wrap",
          }}
        >
          <span>
            区间年化（组合）：
            <b
              className={
                (periodPf ?? 0) > 0
                  ? "text-rise"
                  : (periodPf ?? 0) < 0
                  ? "text-fall"
                  : ""
              }
            >
              {fmtPct(periodPf)}
            </b>
          </span>
          <span>
            区间年化（沪深300）：
            <b
              className={
                (periodBench ?? 0) > 0
                  ? "text-rise"
                  : (periodBench ?? 0) < 0
                  ? "text-fall"
                  : ""
              }
            >
              {fmtPct(periodBench)}
            </b>
          </span>
          <span>
            超额：
            <b
              className={
                periodPf !== null && periodBench !== null
                  ? periodPf - periodBench > 0
                    ? "text-rise"
                    : "text-fall"
                  : ""
              }
            >
              {periodPf !== null && periodBench !== null
                ? fmtPct(periodPf - periodBench)
                : "—"}
            </b>
          </span>
        </div>
      </div>

      <div className="card section-gap">
        <div className="card-title">资产配置变化（近 12 个月月末）</div>
        {alloc.length > 0 ? (
          <Chart option={allocOption} height={260} />
        ) : (
          <div className="empty">
            <div className="empty-sub">数据不足</div>
          </div>
        )}
      </div>

      <div className="card">
        <div
          className="card-title"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <span>AI 理财顾问</span>
          <div className="ai-header-actions">
            <button className="btn btn-primary" onClick={openAi} disabled={aiLoading}>
              <IconSparkle />
              {aiLoading ? "分析中…" : "AI 复盘"}
            </button>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setShowSettings(true)}
              title="AI 设置"
            >
              <IconGear />
            </button>
          </div>
        </div>

        {/* 分析视角（技能包）：名字必须与 prompt 里的视角名逐字一致，
            prompt 靠它匹配对应的分析清单，不是装饰 */}
        <div className="skill-picker">
          <span className="skill-picker-label">分析视角</span>
          <div className="skill-chips">
            {AI_SKILLS.map((s) => (
              <button
                key={s.name}
                className={"skill-chip" + (skill === s.name ? " active" : "")}
                title={s.hint}
                disabled={aiLoading}
                onClick={() => setSkill(s.name)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>

        {aiError ? (
          <div>
            <div className="toast toast-error">{aiError}</div>
            <button
              className="btn btn-ghost"
              onClick={aiReady ? runAnalysis : () => setShowSettings(true)}
            >
              {aiReady ? "重试" : "去设置"}
            </button>
          </div>
        ) : aiLoading ? (
          <div>
            <div className="advisor-skeleton">
              <span></span>
              <span></span>
              <span></span>
            </div>
            {/* 推理模型（如 deepseek-v4-pro）会先思考 1-2 分钟再出正文，
                不提示的话用户会以为卡死了 */}
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "var(--text-tertiary)",
                textAlign: "center",
              }}
            >
              分析中，推理模型可能需要 1-2 分钟，请勿关闭页面…
            </div>
          </div>
        ) : report ? (
          report.structured ? (
            <AdvisorReport
              content={report.content as AdvisorContent}
              checks={advisorFacts.checks}
              skill={reportSkill}
              metrics={{
                xirr: portfolioXirr,
                excess:
                  fullPeriodPf !== null && fullPeriodBench !== null
                    ? fullPeriodPf - fullPeriodBench
                    : null,
                drawdown: fullDd ? fullDd.pct : null,
              }}
            />
          ) : (
            <div className="advisor-raw">{String(report.content)}</div>
          )
        ) : (
          <div className="empty">
            <div className="empty-sub">
              点击右上角「AI 复盘」，让顾问基于当前数据给出分析与建议。
            </div>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="modal-mask" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">AI 理财顾问设置</div>
            <div className="modal-sub">
              填写你自己的 OpenAI 兼容接口。配置仅保存在本机（
              MirrorFin/ai_config.json），分析时由本地程序调用，不会上传。
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">API Base URL</label>
              <input
                className="input"
                style={{ width: "100%" }}
                value={cfg.base_url}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">API Key</label>
              <input
                className="input"
                type="password"
                style={{ width: "100%" }}
                value={cfg.api_key}
                placeholder="sk-..."
                onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">模型名称</label>
              <input
                className="input"
                style={{ width: "100%" }}
                value={cfg.model}
                placeholder="deepseek-chat"
                onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShowSettings(false)}
              >
                取消
              </button>
              <button className="btn btn-primary" onClick={saveSettings}>
                保存并分析
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
