import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Chart, { type ChartEventParams } from "../components/Chart";
import EditTxnModal from "../components/EditTxnModal";
import { IconEdit, IconTrash } from "../components/Icons";
import {
  categoryBreakdown,
  deleteTransaction,
  expensePace,
  listAccounts,
  listCategories,
  listTransactions,
  monthlySeries,
} from "../lib/db";
import { FALL, PALETTE, RISE } from "../lib/echarts-theme";
import { currentMonth, dayLabel, fmtMoney, monthLabel } from "../lib/format";
import type {
  Account,
  Category,
  CategoryValue,
  ExpensePace,
  MonthPoint,
  Transaction,
  TxnType,
} from "../lib/types";

interface DayGroup {
  date: string;
  items: Transaction[];
}

/** txns 已按 date DESC 排序，顺序聚合即可 */
function groupByDate(txns: Transaction[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const t of txns) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }
  return groups;
}

/** 当日收支小计（转账不算收入也不算支出） */
function daySum(items: Transaction[]): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const t of items) {
    if (t.type === "income") income += t.amount;
    else if (t.type === "expense") expense += t.amount;
  }
  return { income, expense };
}

export default function TransactionsPage() {
  const [month, setMonth] = useState(currentMonth());
  const [type, setType] = useState<TxnType | "all">("all");
  const [categoryId, setCategoryId] = useState<number | "all" | "unclassified">(
    "all"
  );
  const [scope, setScope] = useState<"consume" | "all">("consume");
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pieData, setPieData] = useState<CategoryValue[]>([]);
  const [series, setSeries] = useState<MonthPoint[]>([]);
  const [pace, setPace] = useState<ExpensePace>({
    total: 0,
    activeDays: 0,
    peakDay: 0,
  });
  const [editing, setEditing] = useState<Transaction | null>(null);

  useEffect(() => {
    listCategories().then(setCats);
    listAccounts().then(setAccounts);
  }, []);

  const reload = useCallback(async () => {
    const [t, p, s, pc] = await Promise.all([
      listTransactions({ month, type, categoryId }),
      categoryBreakdown(month, scope),
      monthlySeries(6),
      expensePace(month),
    ]);
    setTxns(t);
    setPieData(p);
    setSeries(s);
    setPace(pc);
  }, [month, type, categoryId, scope]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onDelete(t: Transaction) {
    const label =
      t.type === "transfer"
        ? `转账 ¥${fmtMoney(t.amount)}`
        : `${t.category_name ?? "未分类"} ¥${fmtMoney(t.amount)}`;
    if (!window.confirm(`删除这条流水？\n${t.date} ${label}`)) return;
    await deleteTransaction(t.id);
    await reload();
  }

  /** 本月支出总额（饼图中心显示 + 汇总榜占比的分母） */
  const totalExpense = pieData.reduce((s, r) => s + r.value, 0);

  /** 汇总榜点选：点已选中项即取消；筛选时锁定 type=支出（榜统计的就是支出） */
  function pickCategory(r: CategoryValue) {
    // "投资/转账"是跨表聚合项，无法按单一 category_id 筛选
    if (r.id === null && r.name !== "未分类") return;
    const next: number | "all" | "unclassified" =
      r.id === null
        ? categoryId === "unclassified"
          ? "all"
          : "unclassified"
        : categoryId === r.id
        ? "all"
        : r.id;
    setCategoryId(next);
    if (next !== "all") setType("expense");
  }

  /** 当前筛选中的分类名（明细标题上的可点 chip） */
  const selectedCatName =
    categoryId === "all"
      ? null
      : categoryId === "unclassified"
      ? "未分类"
      : (cats.find((c) => c.id === categoryId)?.name ?? null);

  const groups = useMemo(() => groupByDate(txns), [txns]);

  /**
   * 支出节奏。分母是关键：当前月按「已过天数」，历史月按「整月天数」——
   * 否则 9 月 2 号去看日均会被除以 30，数字低得毫无意义。
   */
  const paceStats = useMemo(() => {
    const daysIn = (m: string) => {
      const [y, mo] = m.split("-").map(Number);
      return new Date(y, mo, 0).getDate();
    };
    const isCurrent = month === currentMonth();
    const daysInMonth = daysIn(month);
    const elapsed = isCurrent ? new Date().getDate() : daysInMonth;

    const daily = elapsed > 0 ? pace.total / elapsed : 0;
    const activeDaily = pace.activeDays > 0 ? pace.total / pace.activeDays : 0;

    // 月初样本太少时不做对比：9 月 2 号的「环比 -90%」技术上没错，
    // 但会让人误以为省钱了——宁可不给数字，也不给误导性的数字。
    const enoughSample = elapsed >= 5;

    // series 升序；取「早于当前月」的最后一项作上月（当前月无数据时也能取到）
    const prev = series.filter((s) => s.month < month).pop() ?? null;
    const prevDaily = prev ? prev.expense / daysIn(prev.month) : null;

    // 近 6 月基线：Σ支出 / Σ天数（当前月按已过天数，否则低估）
    let sumAmt = 0;
    let sumDays = 0;
    for (const s of series) {
      sumAmt += s.expense;
      sumDays +=
        s.month === currentMonth() ? new Date().getDate() : daysIn(s.month);
    }
    const baseline = sumDays > 0 ? sumAmt / sumDays : 0;

    const trend = series.map((s) => {
      const d =
        s.month === currentMonth() ? new Date().getDate() : daysIn(s.month);
      return { month: s.month, daily: d > 0 ? s.expense / d : 0 };
    });

    const diff = (base: number | null) =>
      enoughSample && base && base > 0 ? ((daily - base) / base) * 100 : null;

    return {
      isCurrent,
      enoughSample,
      spanMonths: series.length,
      daysInMonth,
      elapsed,
      daily,
      activeDaily,
      prevDaily,
      baseline,
      trend,
      vsPrev: diff(prevDaily),
      vsBase: diff(baseline),
      peak: pace.peakDay,
    };
  }, [pace, series, month]);

  // 日均支出 hero 大数字：整数/小数拆开，小数降级（与首页 hero 同一语言）
  const [dailyInt, dailyDec] = fmtMoney(paceStats.daily).split(".");

  const pieOption = {
    title: {
      text: "¥" + fmtMoney(totalExpense),
      subtext: totalExpense > 0 ? `本月支出 · ${pieData.length} 类` : "本月支出",
      left: "50%",
      top: "38%",
      textAlign: "center" as const,
      textStyle: { fontSize: 18, fontWeight: 600, color: "#1D1D1F" },
      subtextStyle: { fontSize: 11, color: "#6E6E73" },
    },
    tooltip: {
      trigger: "item",
      valueFormatter: (v: unknown) => "¥" + fmtMoney(Number(v)),
    },
    // 不显示 legend：下方快筛格已有「色点+分类名+金额+占比」，重复且占高度
    series: [
      {
        type: "pie",
        radius: ["56%", "78%"],
        center: ["50%", "48%"],
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        emphasis: { scaleSize: 4 },
        data: pieData,
      },
    ],
  };

  /** 点饼图扇区 = 点汇总榜对应那一行 */
  const pieEvents = {
    click: (p: ChartEventParams) => {
      const hit = pieData.find((r) => r.name === p.name);
      if (hit) pickCategory(hit);
    },
  };

  const barOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: unknown) => "¥" + fmtMoney(Number(v)),
    },
    legend: { bottom: 0 },
    grid: { left: 8, right: 8, top: 20, bottom: 44, containLabel: true },
    xAxis: {
      type: "category",
      data: series.map((p) => `${Number(p.month.slice(5))}月`),
    },
    yAxis: { type: "value" },
    series: [
      {
        name: "收入",
        type: "bar",
        data: series.map((p) => p.income),
        itemStyle: { color: RISE, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 18,
      },
      {
        name: "支出",
        type: "bar",
        data: series.map((p) => p.expense),
        itemStyle: { color: FALL, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 18,
      },
    ],
  };

  /** 近 6 月日均走势：迷你趋势线，不显示坐标轴 */
  const sparkOption = {
    grid: { left: 4, right: 4, top: 8, bottom: 6 },
    tooltip: {
      trigger: "axis",
      formatter: (ps: { dataIndex: number }[]) => {
        const t = paceStats.trend[ps[0].dataIndex];
        return t ? `${Number(t.month.slice(5))}月 · ¥${fmtMoney(t.daily)}/天` : "";
      },
    },
    xAxis: {
      type: "category",
      show: false,
      boundaryGap: false,
      data: paceStats.trend.map((t) => t.month),
    },
    yAxis: { type: "value", show: false },
    series: [
      {
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 4,
        data: paceStats.trend.map((t) => t.daily),
        lineStyle: { width: 2, color: FALL },
        itemStyle: { color: FALL },
        areaStyle: { color: "rgba(24,160,88,0.12)" },
      },
    ],
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">收支</div>
          <div className="page-sub">流水记录与消费结构</div>
        </div>
      </div>

      <div className="card section-gap">
        <div className="filter-bar">
          <div className="field">
            <span className="field-label">月份</span>
            <input
              type="month"
              className="input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
          <div className="field">
            <span className="field-label">类型</span>
            <select
              className="select"
              value={type}
              onChange={(e) => setType(e.target.value as TxnType | "all")}
            >
              <option value="all">全部</option>
              <option value="expense">支出</option>
              <option value="income">收入</option>
              <option value="transfer">转账</option>
            </select>
          </div>
          <div className="field">
            <span className="field-label">分类</span>
            <select
              className="select"
              value={categoryId}
              onChange={(e) => {
                const v = e.target.value;
                // 注意：不能对 "unclassified" 取 Number()，否则变 NaN 传进 SQL
                setCategoryId(
                  v === "all"
                    ? "all"
                    : v === "unclassified"
                    ? "unclassified"
                    : Number(v)
                );
              }}
            >
              <option value="all">全部</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="unclassified">未分类</option>
            </select>
          </div>
          <div className="field" style={{ marginLeft: "auto" }}>
            <span className="field-label">支出口径</span>
            <div className="segmented">
              <button
                className={scope === "consume" ? "active" : ""}
                onClick={() => setScope("consume")}
              >
                纯消费
              </button>
              <button
                className={scope === "all" ? "active" : ""}
                onClick={() => setScope("all")}
              >
                全口径
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 支出节奏：横跨整页的指标带。不塞进半宽卡片 → 空间宽裕，也不破坏下方两图等高 */}
      {pace.total > 0 && (
        <div className="card section-gap">
          <div className="card-title txn-head">
            <span>支出节奏</span>
            <span className="cat-strip-hint">
              {paceStats.isCurrent
                ? `按已过 ${paceStats.elapsed}/${paceStats.daysInMonth} 天计`
                : `按全月 ${paceStats.daysInMonth} 天计`}
              {" · "}纯消费口径
            </span>
          </div>
          <div className="pace-strip">
            <div className="pace-cell lead">
              <span className="pace-label">日均支出</span>
              <span className="pace-value num">
                <i>¥</i>
                {dailyInt}
                <span className="hero-dec">.{dailyDec}</span>
                <em>/天</em>
              </span>
              <span className="pace-sub">
                已花 ¥{fmtMoney(pace.total)}
                {paceStats.isCurrent && paceStats.elapsed <= 3
                  ? " · 月初样本少"
                  : ""}
              </span>
            </div>

            <div className="pace-cell">
              <span className="pace-label">环比上月</span>
              <span
                className="pace-value num"
                style={{
                  color:
                    paceStats.vsPrev === null
                      ? undefined
                      : paceStats.vsPrev >= 0
                      ? "var(--rise)"
                      : "var(--fall)",
                }}
              >
                {paceStats.vsPrev === null
                  ? "—"
                  : `${paceStats.vsPrev >= 0 ? "+" : ""}${paceStats.vsPrev.toFixed(0)}%`}
              </span>
              <span className="pace-sub">
                {paceStats.prevDaily === null
                  ? "暂无上月数据"
                  : !paceStats.enoughSample
                  ? "满 5 天后可对比"
                  : `上月 ¥${fmtMoney(paceStats.prevDaily)}/天`}
              </span>
            </div>

            <div className="pace-cell">
              <span className="pace-label">
                近 {paceStats.spanMonths} 月日均
              </span>
              <span className="pace-value num">
                <i>¥</i>
                {fmtMoney(paceStats.baseline)}
              </span>
              <span
                className="pace-sub"
                style={{
                  color:
                    paceStats.vsBase === null
                      ? undefined
                      : paceStats.vsBase >= 0
                      ? "var(--rise)"
                      : "var(--fall)",
                }}
              >
                {paceStats.vsBase === null
                  ? "长期基线"
                  : `${paceStats.vsBase >= 0 ? "高于" : "低于"}基线 ${Math.abs(
                      paceStats.vsBase
                    ).toFixed(0)}%`}
              </span>
            </div>

            <div className="pace-cell" title={`单日峰值 ¥${fmtMoney(paceStats.peak)}`}>
              <span className="pace-label">花钱日日均</span>
              <span className="pace-value num">
                <i>¥</i>
                {fmtMoney(paceStats.activeDaily)}
              </span>
              <span className="pace-sub">
                {pace.activeDays}/{paceStats.elapsed} 天有支出
              </span>
            </div>

            <div className="pace-cell pace-trend">
              <span className="pace-label">日均趋势</span>
              <Chart option={sparkOption} height={44} />
            </div>
          </div>
        </div>
      )}

      {/* 两个卡片都只放一张图 → 天然等高，不再出现「左边比右边长一截」 */}
      <div className="grid-2 section-gap">
        <div className="card">
          <div className="card-title">
            {monthLabel(month)} 支出结构
            {scope === "all" ? "（含投资/转账）" : "（纯消费）"}
          </div>
          {pieData.length === 0 ? (
            <div className="empty">
              <div className="empty-sub">本月暂无支出记录</div>
            </div>
          ) : (
            <Chart option={pieOption} height={260} onEvents={pieEvents} />
          )}
        </div>
        <div className="card">
          <div className="card-title">近 6 个月收支对比</div>
          <Chart option={barOption} height={260} />
        </div>
      </div>

      <div className="card">
        <div className="card-title txn-head">
          <span>流水明细 · {txns.length} 条</span>
          {pieData.length > 0 && (
            <span className="cat-strip-hint">
              {selectedCatName
                ? `已筛选「${selectedCatName}」，再点一次取消`
                : "点击分类，只看它的明细"}
            </span>
          )}
        </div>

        {pieData.length > 0 && (
          <div className="cat-strip">
            <div className="cat-pills">
              {pieData.map((r, i) => {
                const pct =
                  totalExpense > 0 ? (r.value / totalExpense) * 100 : 0;
                const active =
                  r.id === null
                    ? categoryId === "unclassified" && r.name === "未分类"
                    : categoryId === r.id;
                const clickable = r.id !== null || r.name === "未分类";
                const color = PALETTE[i % PALETTE.length];
                return (
                  <button
                    key={r.name}
                    className={"cat-pill" + (active ? " active" : "")}
                    disabled={!clickable}
                    title={
                      clickable
                        ? active
                          ? "点击取消筛选"
                          : `只看「${r.name}」的明细（${r.count} 笔）`
                        : "投资/转账为聚合项，无法按单一分类筛选"
                    }
                    onClick={() => pickCategory(r)}
                  >
                    <span className="cat-pill-top">
                      <span
                        className="cat-dot"
                        style={{ background: color }}
                      />
                      <span className="cat-pill-name">{r.name}</span>
                      <span className="cat-pill-amt">¥{fmtMoney(r.value)}</span>
                    </span>
                    <span className="cat-pill-bot">
                      <span className="cat-pill-bar">
                        <i style={{ width: pct + "%", background: color }} />
                      </span>
                      <span className="cat-pill-meta">
                        {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% ·{" "}
                        {r.count} 笔
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {txns.length === 0 ? (
          <div className="empty">
            <div className="empty-title">当前筛选下没有流水</div>
            <div className="empty-sub">
              换个筛选条件，或者去<Link to="/entry">录入</Link>一笔
            </div>
          </div>
        ) : (
          <div className="txn-groups">
            {groups.map((g) => {
              const { income, expense } = daySum(g.items);
              return (
                <div className="txn-group" key={g.date}>
                  <div className="txn-group-head">
                    <span className="txn-group-date">{dayLabel(g.date)}</span>
                    <span className="txn-group-sum">
                      {income > 0 && (
                        <span className="inc">收入 ¥{fmtMoney(income)}</span>
                      )}
                      {income > 0 && expense > 0 && " · "}
                      {expense > 0 && (
                        <span className="exp">支出 ¥{fmtMoney(expense)}</span>
                      )}
                      {income === 0 && expense === 0 && <span>仅转账</span>}
                    </span>
                  </div>
                  <ul className="txn-list">
                    {g.items.map((t) => (
                      <li key={t.id} className="txn-row">
                        <span className="txn-cat">
                          {t.type === "transfer"
                            ? "转账"
                            : t.category_name ?? "未分类"}
                        </span>
                        <span className="txn-note">{t.note}</span>
                        <span className="txn-account">
                          {t.type === "transfer"
                            ? `${t.account_name} → ${t.to_account_name}`
                            : t.account_name}
                        </span>
                        <span
                          className="txn-amount num"
                          style={{
                            color:
                              t.type === "income"
                                ? "var(--rise)"
                                : t.type === "transfer"
                                ? "var(--text-secondary)"
                                : "var(--text-primary)",
                          }}
                        >
                          {t.type === "income"
                            ? "+"
                            : t.type === "expense"
                            ? "-"
                            : ""}
                          ¥{fmtMoney(t.amount)}
                        </span>
                        <button
                          className="txn-edit"
                          title="编辑"
                          onClick={() => setEditing(t)}
                        >
                          <IconEdit size={15} />
                        </button>
                        <button
                          className="txn-del"
                          title="删除"
                          onClick={() => onDelete(t)}
                        >
                          <IconTrash size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && (
        <EditTxnModal
          txn={editing}
          accounts={accounts}
          categories={cats}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
