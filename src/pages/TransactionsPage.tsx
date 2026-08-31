import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Chart, { type ChartEventParams } from "../components/Chart";
import EditTxnModal from "../components/EditTxnModal";
import { IconEdit, IconTrash } from "../components/Icons";
import {
  categoryBreakdown,
  deleteTransaction,
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
  const [editing, setEditing] = useState<Transaction | null>(null);

  useEffect(() => {
    listCategories().then(setCats);
    listAccounts().then(setAccounts);
  }, []);

  const reload = useCallback(async () => {
    const [t, p, s] = await Promise.all([
      listTransactions({ month, type, categoryId }),
      categoryBreakdown(month, scope),
      monthlySeries(6),
    ]);
    setTxns(t);
    setPieData(p);
    setSeries(s);
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
