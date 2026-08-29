import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { computeHolding, portfolioFlows, xirr } from "../lib/analytics";
import {
  latestNav,
  listAccounts,
  listAssets,
  listInvestmentTxns,
  recentMonthSums,
} from "../lib/db";
import { fmtMoney, fmtPct, todayStr } from "../lib/format";
import type { Account, Asset, InvestmentTxn, NavPoint } from "../lib/types";

/** 里程碑阶段 */
const MILESTONES = [
  { pct: 25, label: "起步", desc: "被动收入覆盖 1/4 支出" },
  { pct: 50, label: "半程", desc: "被动收入覆盖一半支出" },
  { pct: 75, label: "冲刺", desc: "被动收入覆盖 3/4 支出" },
  { pct: 100, label: "财务自由", desc: "被动收入完全覆盖支出" },
];

function milestoneStage(progress: number) {
  let reached = -1;
  for (let i = 0; i < MILESTONES.length; i++) {
    if (progress >= MILESTONES[i].pct) reached = i;
  }
  const nextIdx = reached < MILESTONES.length - 1 ? reached + 1 : -1;
  return { reached, next: nextIdx >= 0 ? MILESTONES[nextIdx] : null };
}

/** 把"还要几个月"格式化成"X 年 Y 个月" */
function fmtMonths(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "—";
  const years = Math.floor(m / 12);
  const months = Math.round(m % 12);
  if (years === 0) return `${months} 个月`;
  if (months === 0) return `${years} 年`;
  return `${years} 年 ${months} 个月`;
}

export default function RetirementPage() {
  const [loaded, setLoaded] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [trades, setTrades] = useState<InvestmentTxn[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [navMap, setNavMap] = useState<Map<number, NavPoint>>(new Map());
  const [monthSums, setMonthSums] = useState<
    { month: string; income: number; expense: number }[]
  >([]);

  useEffect(() => {
    (async () => {
      const [accs, tradesAll, assetsAll, sums] = await Promise.all([
        listAccounts(),
        listInvestmentTxns(),
        listAssets(),
        recentMonthSums(12),
      ]);
      const nm = new Map<number, NavPoint>();
      await Promise.all(
        assetsAll.map(async (a) => {
          const nav = await latestNav(a.id);
          if (nav) nm.set(a.id, nav);
        })
      );
      setAccounts(accs);
      setTrades(tradesAll);
      setAssets(assetsAll);
      setNavMap(nm);
      setMonthSums(sums);
      setLoaded(true);
    })();
  }, []);

  // 投资市值：fund / stock
  let fundMV = 0;
  let stockMV = 0;
  for (const a of assets) {
    const h = computeHolding(a, trades.filter((t) => t.asset_id === a.id));
    const price = navMap.get(a.id)?.nav ?? 0;
    const mv = h.shares * price;
    if (a.type === "fund") fundMV += mv;
    else stockMV += mv;
  }
  const totalMV = fundMV + stockMV;

  // 活钱 + 公积金（accounts.balance 已派生）
  const cashAndHousing = accounts.reduce((s, a) => s + a.balance, 0);
  const totalAssets = cashAndHousing + totalMV;

  // XIRR（投资组合收益率）
  const portfolioXirr = trades.length
    ? xirr(portfolioFlows(trades, todayStr(), totalMV))
    : null;

  // 月均支出 / 月均储蓄（近12月有流水的月份）
  const monthsWithData = monthSums.length;
  const avgExpense =
    monthsWithData > 0
      ? monthSums.reduce((s, m) => s + m.expense, 0) / monthsWithData
      : 0;
  const avgSaving =
    monthsWithData > 0
      ? monthSums.reduce((s, m) => s + m.income - m.expense, 0) / monthsWithData
      : 0;

  // 被动收入 = XIRR × 总资产 / 12（亏损时为负，诚实展示）
  const monthlyPassive =
    portfolioXirr != null ? (portfolioXirr * totalAssets) / 12 : 0;

  // 退休进度 = 被动收入 / 月均支出（封顶 100% 用于进度条；亏损时 clamp 到 0）
  const progressRaw =
    avgExpense > 0 ? (monthlyPassive / avgExpense) * 100 : 0;
  const progressCapped = Math.min(Math.max(progressRaw, 0), 100);

  // 目标本金 = 月均支出 × 12 / XIRR
  const targetCapital =
    portfolioXirr != null && portfolioXirr > 0 && avgExpense > 0
      ? (avgExpense * 12) / portfolioXirr
      : null;
  const capitalGap =
    targetCapital != null ? targetCapital - totalAssets : null;

  // 还差多久 = 缺口 / 月均储蓄（线性估算，未考虑复利）
  const monthsToGo =
    capitalGap != null && capitalGap > 0 && avgSaving > 0
      ? capitalGap / avgSaving
      : null;

  const { reached, next } = milestoneStage(progressCapped);

  if (!loaded) return <div className="page" />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">退休</div>
          <div className="page-sub">被动收入能覆盖支出时，你就自由了</div>
        </div>
      </div>

      {portfolioXirr == null ? (
        <div className="card">
          <div className="empty">
            <div className="empty-title">还没法算退休进度</div>
            <div className="empty-sub">
              需要先有投资交易记录才能算出你的投资收益率（XIRR）。
              去<Link to="/entry">录入</Link>投资交易，再到
              <Link to="/holdings">持仓</Link>页同步行情。
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 进度条主卡 */}
          <div className="card section-gap">
            <div className="retire-progress-head">
              <div>
                <div className="retire-progress-label">退休进度</div>
                <div className="retire-progress-pct num">
                  {fmtPct(progressCapped / 100)}
                </div>
              </div>
              <div className="retire-progress-status">
                {monthlyPassive < 0
                  ? "当前投资亏损，被动收入为负"
                  : progressCapped >= 100
                  ? "🎉 已达成！被动收入可覆盖支出"
                  : next
                  ? `下一阶段：${next.label}（${next.pct}%）`
                  : ""}
              </div>
            </div>
            <div className="retire-progress-bar">
              <div
                className="retire-progress-fill"
                style={{ width: `${progressCapped}%` }}
              />
              {MILESTONES.map((m) => (
                <div
                  key={m.pct}
                  className={`retire-milestone-mark ${
                    progressCapped >= m.pct ? "reached" : ""
                  }`}
                  style={{ left: `${m.pct}%` }}
                  title={`${m.label} ${m.pct}%`}
                />
              ))}
            </div>
            <div className="retire-progress-legend">
              {MILESTONES.map((m, i) => (
                <span key={m.pct} className={reached >= i ? "reached" : ""}>
                  {m.label} {m.pct}%
                </span>
              ))}
            </div>
          </div>

          {/* 核心数字 */}
          <div className="stat-grid section-gap">
            <div className="card">
              <div className="stat-label">月被动收入（估算）</div>
              <div
                className={`stat-value num ${
                  monthlyPassive >= 0 ? "text-rise" : "text-fall"
                }`}
              >
                ¥{fmtMoney(monthlyPassive)}
              </div>
              <div className="stat-hint">
                XIRR {fmtPct(portfolioXirr)} × 总资产 ÷ 12
                {monthlyPassive < 0 && " · 投资亏损中"}
              </div>
            </div>
            <div className="card">
              <div className="stat-label">月均支出</div>
              <div className="stat-value num">¥{fmtMoney(avgExpense)}</div>
              <div className="stat-hint">近 {monthsWithData} 个月平均</div>
            </div>
            <div className="card">
              <div className="stat-label">退休目标本金</div>
              <div className="stat-value num">
                {targetCapital != null ? `¥${fmtMoney(targetCapital)}` : "—"}
              </div>
              <div className="stat-hint">
                月支出×12÷XIRR{fmtPct(portfolioXirr)}
              </div>
            </div>
            <div className="card">
              <div className="stat-label">当前总资产</div>
              <div className="stat-value num">¥{fmtMoney(totalAssets)}</div>
              <div className="stat-hint">
                活钱+公积金 ¥{fmtMoney(cashAndHousing)} · 投资 ¥
                {fmtMoney(totalMV)}
              </div>
            </div>
          </div>

          {/* 还差多久 */}
          <div className="card section-gap">
            <div className="card-title">还差多久</div>
            {capitalGap != null && capitalGap > 0 ? (
              <>
                <div className="retire-eta-row">
                  <span>资产缺口</span>
                  <b className="num">¥{fmtMoney(capitalGap)}</b>
                </div>
                <div className="retire-eta-row">
                  <span>月均净储蓄</span>
                  <b className="num">¥{fmtMoney(avgSaving)}</b>
                </div>
                <div className="retire-eta-row retire-eta-big">
                  <span>按当前储蓄速度</span>
                  <b className="num">
                    {monthsToGo != null ? fmtMonths(monthsToGo) : "—"}
                  </b>
                </div>
                <div
                  className="empty-sub"
                  style={{ marginTop: 12, textAlign: "left" }}
                >
                  线性估算，未考虑复利与市场波动。提高储蓄率或收益率可缩短时间。
                </div>
              </>
            ) : capitalGap != null && capitalGap <= 0 ? (
              <div className="empty">
                <div className="empty-title">资产已达标 🎉</div>
                <div className="empty-sub">
                  当前总资产已达到退休目标本金，按 XIRR {fmtPct(portfolioXirr)}
                  计算的被动收入可覆盖月均支出。
                </div>
              </div>
            ) : (
              <div className="empty-sub">数据不足，无法估算</div>
            )}
          </div>

          {/* 里程碑 */}
          <div className="card">
            <div className="card-title">里程碑</div>
            <div className="retire-milestones">
              {MILESTONES.map((m, i) => (
                <div
                  key={m.pct}
                  className={`retire-milestone-card ${
                    reached >= i ? "reached" : ""
                  }`}
                >
                  <div className="retire-milestone-pct num">{m.pct}%</div>
                  <div className="retire-milestone-label">{m.label}</div>
                  <div className="retire-milestone-desc">{m.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
