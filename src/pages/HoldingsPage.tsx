import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Chart from "../components/Chart";
import { IconTrash } from "../components/Icons";
import {
  computeHolding,
  portfolioFlows,
  xirr,
  type Holding,
} from "../lib/analytics";
import {
  deleteInvestmentTxn,
  latestNav,
  listAssets,
  listInvestmentTxns,
  listNavSnapshots,
  updateAssetCategory,
} from "../lib/db";
import { fmtMoney, fmtPct, todayStr } from "../lib/format";
import { syncAllMarketData } from "../lib/market";
import {
  ASSET_CATEGORY_COLOR,
  ASSET_CATEGORY_LABEL,
  type AssetCategory,
  type NavPoint,
} from "../lib/types";

interface HoldingVM {
  holding: Holding;
  price: number;
  mv: number;
  pnl: number;
  pnlPct: number | null;
  xirr: number | null;
}

const TYPE_LABEL = { buy: "申购", sell: "赎回", dividend: "红利再投" } as const;
const TYPE_BADGE = { buy: "badge-buy", sell: "badge-sell", dividend: "badge-div" } as const;

export default function HoldingsPage() {
  const [vms, setVms] = useState<HoldingVM[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [navs, setNavs] = useState<NavPoint[]>([]);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const load = useCallback(async () => {
    const [assets, trades] = await Promise.all([
      listAssets(),
      listInvestmentTxns(),
    ]);
    const out: HoldingVM[] = [];
    for (const a of assets) {
      const ts = trades.filter((t) => t.asset_id === a.id);
      if (ts.length === 0) continue;
      const h = computeHolding(a, ts);
      const nav = await latestNav(a.id);
      const price = nav?.nav ?? ts[ts.length - 1].price;
      const mv = h.shares * price;
      const pnl = mv - h.cost;
      out.push({
        holding: h,
        price,
        mv,
        pnl,
        pnlPct: h.cost > 0 ? pnl / h.cost : null,
        xirr: xirr(portfolioFlows(ts, todayStr(), mv)),
      });
    }
    out.sort((x, y) => y.mv - x.mv);
    setVms(out);
    setSelected((s) => (s ?? out[0]?.holding.asset.id ?? null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sel = vms.find((v) => v.holding.asset.id === selected) ?? null;

  // 按投资风格分组统计（只算在持仓的，清仓不算）
  const catStats = useMemo(() => {
    const map = new Map<AssetCategory, number>();
    for (const v of vms) {
      if (v.holding.shares === 0) continue;
      const c = v.holding.asset.category;
      map.set(c, (map.get(c) ?? 0) + v.mv);
    }
    const total = [...map.values()].reduce((s, x) => s + x, 0);
    return [...map.entries()]
      .map(([cat, mv]) => ({
        cat,
        mv,
        pct: total > 0 ? mv / total : 0,
      }))
      .sort((a, b) => b.mv - a.mv);
  }, [vms]);

  async function onChangeCategory(id: number, category: AssetCategory) {
    await updateAssetCategory(id, category);
    await load();
  }

  useEffect(() => {
    if (selected !== null) listNavSnapshots(selected).then(setNavs);
  }, [selected, vms]);

  async function onSync() {
    setSyncing(true);
    setSyncMsg("同步中…");
    setSyncProgress({ done: 0, total: 0 });
    const r = await syncAllMarketData((done, total) => {
      setSyncProgress({ done, total });
    });
    setSyncMsg(r.message);
    setSyncing(false);
    setSyncProgress(null);
    await load();
  }

  async function onDeleteTrade(id: number) {
    if (!window.confirm("删除这笔交易记录？持仓和现金会随之重新计算。")) return;
    await deleteInvestmentTxn(id);
    await load();
  }

  if (vms.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">持仓</div>
            <div className="page-sub">基金 / 股票资产</div>
          </div>
        </div>
        <div className="empty">
          <div className="empty-title">还没有投资记录</div>
          <div className="empty-sub">
            去<Link to="/entry">录入</Link>第一笔申购，这里就会长出持仓
          </div>
        </div>
      </div>
    );
  }

  const navChartOption = {
    tooltip: { trigger: "axis" },
    grid: { left: 8, right: 8, top: 16, bottom: 24, containLabel: true },
    xAxis: { type: "category", data: navs.map((p) => p.date) },
    yAxis: { type: "value", scale: true },
    series: [
      {
        type: "line",
        data: navs.map((p) => p.nav),
        showSymbol: false,
        lineStyle: { width: 2, color: "#007AFF" },
        itemStyle: { color: "#007AFF" },
        areaStyle: { color: "rgba(0,122,255,0.08)" },
      },
    ],
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">持仓</div>
          <div className="page-sub">基金 / 股票资产</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {syncMsg && (
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              {syncMsg}
            </span>
          )}
          <button className="btn btn-ghost" onClick={onSync} disabled={syncing}>
            {syncing
              ? syncProgress && syncProgress.total > 0
                ? `同步中 ${syncProgress.done}/${syncProgress.total}`
                : "同步中…"
              : "同步行情"}
          </button>
        </div>
      </div>

      <div className="card section-gap">
        <div className="card-title">投资结构</div>
        {catStats.length === 0 ? (
          <div className="empty-sub">暂无在持仓的标的</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            {catStats.map((s) => (
              <div key={s.cat} style={{ minWidth: 96 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: ASSET_CATEGORY_COLOR[s.cat],
                      flexShrink: 0,
                    }}
                  />
                  {ASSET_CATEGORY_LABEL[s.cat]}
                </div>
                <div className="num" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
                  ¥{fmtMoney(s.mv)}
                </div>
                <div className="num" style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  {fmtPct(s.pct)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mv-layout">
        <div className="card" style={{ padding: 8 }}>
          {vms.map((v) => {
            const a = v.holding.asset;
            const active = selected === a.id;
            return (
              <div
                key={a.id}
                className={`asset-item ${active ? "active" : ""}`}
                onClick={() => setSelected(a.id)}
              >
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    marginTop: 2,
                  }}
                >
                  {a.type === "fund" ? "基金" : "股票"} · {a.code} ·{" "}
                  <span style={{ color: ASSET_CATEGORY_COLOR[a.category] }}>
                    {ASSET_CATEGORY_LABEL[a.category]}
                  </span>
                  {v.holding.shares === 0 && " · 已清仓"}
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginTop: 6,
                    fontSize: 13,
                  }}
                >
                  <span className="num">¥{fmtMoney(v.mv)}</span>
                  {v.holding.shares === 0 ? (
                    <span
                      className={`num ${
                        v.holding.realized > 0
                          ? "text-rise"
                          : v.holding.realized < 0
                          ? "text-fall"
                          : ""
                      }`}
                    >
                      {v.holding.realized >= 0 ? "+¥" : "-¥"}
                      {fmtMoney(Math.abs(v.holding.realized))} 已实现
                    </span>
                  ) : (
                    <span
                      className={`num ${
                        v.pnl > 0 ? "text-rise" : v.pnl < 0 ? "text-fall" : ""
                      }`}
                    >
                      {v.pnl >= 0 ? "+" : ""}
                      {fmtPct(v.pnlPct)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {sel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card">
              <div className="card-title">
                {sel.holding.asset.name}（{sel.holding.asset.code}）
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  margin: "-8px 0 12px",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  投资类型
                </span>
                <select
                  className="select"
                  style={{ width: 130, height: 30, fontSize: 13 }}
                  value={sel.holding.asset.category}
                  onChange={(e) =>
                    onChangeCategory(
                      sel.holding.asset.id,
                      e.target.value as AssetCategory
                    )
                  }
                >
                  {(Object.keys(ASSET_CATEGORY_LABEL) as AssetCategory[]).map(
                    (c) => (
                      <option key={c} value={c}>
                        {ASSET_CATEGORY_LABEL[c]}
                      </option>
                    )
                  )}
                </select>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background:
                      ASSET_CATEGORY_COLOR[sel.holding.asset.category],
                  }}
                />
              </div>
              <div className="stat-row">
                <div>
                  <div className="stat-label">持有份额</div>
                  <div className="stat-mid num">
                    {sel.holding.shares.toLocaleString("zh-CN", {
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>
                <div>
                  <div className="stat-label">持有成本</div>
                  <div className="stat-mid num">¥{fmtMoney(sel.holding.cost)}</div>
                </div>
                <div>
                  <div className="stat-label">最新价</div>
                  <div className="stat-mid num">{sel.price}</div>
                </div>
                <div>
                  <div className="stat-label">当前市值</div>
                  <div className="stat-mid num">¥{fmtMoney(sel.mv)}</div>
                </div>
                <div>
                  <div className="stat-label">持有收益</div>
                  <div
                    className={`stat-mid num ${
                      sel.pnl > 0 ? "text-rise" : sel.pnl < 0 ? "text-fall" : ""
                    }`}
                  >
                    {sel.pnl >= 0 ? "+" : ""}¥{fmtMoney(sel.pnl)}（
                    {fmtPct(sel.pnlPct)}）
                  </div>
                </div>
                <div>
                  <div className="stat-label">XIRR 年化</div>
                  <div
                    className={`stat-mid num ${
                      (sel.xirr ?? 0) > 0
                        ? "text-rise"
                        : (sel.xirr ?? 0) < 0
                        ? "text-fall"
                        : ""
                    }`}
                  >
                    {fmtPct(sel.xirr)}
                  </div>
                </div>
                <div>
                  <div className="stat-label">已实现收益</div>
                  <div
                    className={`stat-mid num ${
                      sel.holding.realized > 0
                        ? "text-rise"
                        : sel.holding.realized < 0
                        ? "text-fall"
                        : ""
                    }`}
                  >
                    {sel.holding.realized >= 0 ? "+" : ""}¥
                    {fmtMoney(sel.holding.realized)}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">净值走势</div>
              {navs.length > 1 ? (
                <Chart option={navChartOption} height={220} />
              ) : (
                <div className="empty">
                  <div className="empty-sub">
                    暂无净值数据，点右上角「同步行情」拉取
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-title">
                交易记录 · {sel.holding.trades.length} 笔
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>类型</th>
                    <th style={{ textAlign: "right" }}>份额</th>
                    <th style={{ textAlign: "right" }}>单价</th>
                    <th style={{ textAlign: "right" }}>金额</th>
                    <th>账户</th>
                    <th style={{ width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {[...sel.holding.trades].reverse().map((t) => (
                    <tr key={t.id}>
                      <td>{t.date}</td>
                      <td>
                        <span className={`badge ${TYPE_BADGE[t.type]}`}>
                          {TYPE_LABEL[t.type]}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>{t.shares}</td>
                      <td style={{ textAlign: "right" }}>{t.price}</td>
                      <td style={{ textAlign: "right" }}>
                        ¥{fmtMoney(t.amount)}
                      </td>
                      <td>{t.account_name ?? "—"}</td>
                      <td>
                        <button
                          className="txn-del"
                          style={{ opacity: 1 }}
                          title="删除"
                          onClick={() => onDeleteTrade(t.id)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
