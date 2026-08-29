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

  // 构造发给 AI 的结构化摘要（只发指标+配置+持仓概览，不含逐笔流水）
  const buildSummary = useCallback((): string => {
    const holdings = assets
      .map((a) => {
        const h = computeHolding(a, trades.filter((t) => t.asset_id === a.id));
        const navs = navsByAsset.get(a.id) ?? [];
        const lastNav = navs.length ? navs[navs.length - 1].nav : 0;
        const mv = h.shares * lastNav;
        const pnl = mv - h.cost + h.realized;
        const pct = totalMV > 0 ? (mv / totalMV) * 100 : 0;
        return {
          名称: a.name,
          类型: a.type === "fund" ? "基金" : "股票",
          占比百分比: +pct.toFixed(1),
          市值: +mv.toFixed(2),
          大致盈亏: +pnl.toFixed(2),
        };
      })
      .filter((h) => h.市值 > 0);

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
  }, [assets, trades, navsByAsset, totalMV, portfolioXirr, totalPnl, fullDd, fullPeriodPf, fullPeriodBench, alloc, accounts, advisorFacts]);

  const runAnalysis = useCallback(async () => {
    if (aiLoading) return;
    setAiError(null);
    setReport(null);
    setAiLoading(true);
    try {
      const summary = buildSummary();
      const userMsg =
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
  }, [aiLoading, buildSummary]);

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

      <div className="stat-grid section-gap">
        <div className="card">
          <div className="stat-label">XIRR 年化（资金加权）</div>
          <div
            className={`stat-value num ${
              (portfolioXirr ?? 0) > 0
                ? "text-rise"
                : (portfolioXirr ?? 0) < 0
                ? "text-fall"
                : ""
            }`}
          >
            {fmtPct(portfolioXirr)}
          </div>
          <div className="stat-hint">考虑每笔资金进出时间</div>
        </div>
        <div className="card">
          <div className="stat-label">当前市值</div>
          <div className="stat-value num">¥{fmtMoney(totalMV)}</div>
          <div className="stat-hint">净投入 ¥{fmtMoney(netInvested)}</div>
        </div>
        <div className="card">
          <div className="stat-label">累计收益</div>
          <div
            className={`stat-value num ${
              totalPnl > 0 ? "text-rise" : totalPnl < 0 ? "text-fall" : ""
            }`}
          >
            {totalPnl >= 0 ? "+" : ""}¥{fmtMoney(totalPnl)}
          </div>
          <div className="stat-hint">
            持有成本 ¥{fmtMoney(costSum)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">最大回撤</div>
          <div className="stat-value num text-fall">
            {dd ? `-${fmtPct(dd.pct)}` : "—"}
          </div>
          <div className="stat-hint">
            {dd ? `${dd.peakDate} → ${dd.troughDate}` : "数据不足"}
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
          <div className="advisor-skeleton">
            <span></span>
            <span></span>
            <span></span>
          </div>
        ) : report ? (
          report.structured ? (
            <AdvisorReport
              content={report.content as AdvisorContent}
              checks={advisorFacts.checks}
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
