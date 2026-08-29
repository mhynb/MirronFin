import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Chart from "../components/Chart";
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
import { FALL, RISE } from "../lib/echarts-theme";
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
  const [categoryId, setCategoryId] = useState<number | "all">("all");
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

  const groups = useMemo(() => groupByDate(txns), [txns]);

  const pieOption = {
    tooltip: {
      trigger: "item",
      valueFormatter: (v: unknown) => "¥" + fmtMoney(Number(v)),
    },
    legend: { bottom: 0 },
    series: [
      {
        type: "pie",
        radius: ["46%", "70%"],
        center: ["50%", "44%"],
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        emphasis: { scaleSize: 4 },
        data: pieData,
      },
    ],
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
              onChange={(e) =>
                setCategoryId(
                  e.target.value === "all" ? "all" : Number(e.target.value)
                )
              }
            >
              <option value="all">全部</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
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
            <Chart option={pieOption} height={260} />
          )}
        </div>
        <div className="card">
          <div className="card-title">近 6 个月收支对比</div>
          <Chart option={barOption} height={260} />
        </div>
      </div>

      <div className="card">
        <div className="card-title">流水明细 · {txns.length} 条</div>
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
