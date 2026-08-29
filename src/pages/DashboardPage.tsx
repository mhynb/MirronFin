import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Chart from "../components/Chart";
import ReconcileModal from "../components/ReconcileModal";
import { IconChevronRight, IconPlus } from "../components/Icons";
import {
  buildAssetValueSeries,
  computeHolding,
  flowAdjustedCumReturn,
  mergeSeries,
  monthRealized,
  type ValuePoint,
} from "../lib/analytics";
import {
  addInvestmentTxn,
  getMeta,
  getOrCreateAsset,
  latestNav,
  listAccounts,
  listAssets,
  listInvestmentTxns,
  listNavSnapshots,
  monthSummary,
  recentTransactions,
  setMeta,
  setOpeningBalance,
} from "../lib/db";
import { currentMonth, fmtMoney, monthLabel, shortDate, todayStr } from "../lib/format";
import {
  fetchFundInfo,
  fetchStockInfo,
  syncAllMarketData,
  toTencentCode,
} from "../lib/market";
import {
  ASSET_CATEGORY_COLOR,
  ASSET_CATEGORY_LABEL,
  type Account,
  type AssetCategory,
  type MonthSummary,
  type Transaction,
} from "../lib/types";

/** 期初持仓编辑行（投资类初始资产） */
interface HoldingDraft {
  key: number;
  type: "fund" | "stock";
  code: string;
  name: string;
  shares: string;
  price: string;
}

interface InvestState {
  fundMV: number;
  stockMV: number;
  catMV: Partial<Record<AssetCategory, number>>;
  curve: [string, number][];
}

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inv, setInv] = useState<InvestState>({
    fundMV: 0,
    stockMV: 0,
    catMV: {},
    curve: [],
  });
  const [summary, setSummary] = useState<MonthSummary>({
    income: 0,
    expense: 0,
  });
  const [invRealized, setInvRealized] = useState(0);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [showBackup, setShowBackup] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");
  const [showOpening, setShowOpening] = useState(false);
  const [showReconcile, setShowReconcile] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingOpening, setSavingOpening] = useState(false);
  const [holdings, setHoldings] = useState<HoldingDraft[]>([]);
  const [holdingDate, setHoldingDate] = useState(todayStr());
  const holdingKey = useRef(0);
  const month = currentMonth();

  const loadInvestments = useCallback(async () => {
    const [assetsAll, tradesAll] = await Promise.all([
      listAssets(),
      listInvestmentTxns(),
    ]);
    const used = assetsAll.filter((a) =>
      tradesAll.some((t) => t.asset_id === a.id)
    );
    let fundMV = 0;
    let stockMV = 0;
    const catMV: Partial<Record<AssetCategory, number>> = {};
    const perAsset: ValuePoint[][] = [];
    for (const a of used) {
      const ts = tradesAll.filter((t) => t.asset_id === a.id);
      const h = computeHolding(a, ts);
      const nav = await latestNav(a.id);
      const price = nav?.nav ?? ts[ts.length - 1].price;
      const mv = h.shares * price;
      if (a.type === "fund") fundMV += mv;
      else stockMV += mv;
      catMV[a.category] = (catMV[a.category] ?? 0) + mv;
      const navs = await listNavSnapshots(a.id);
      perAsset.push(buildAssetValueSeries(ts, navs));
    }
    const merged = mergeSeries(perAsset);
    const curveFull = flowAdjustedCumReturn(merged, tradesAll);
    setInv({
      fundMV,
      stockMV,
      catMV,
      curve: curveFull.map(
        (p) => [p.date, +(p.value * 100).toFixed(2)] as [string, number]
      ),
    });
    setInvRealized(monthRealized(tradesAll, month));
  }, []);

  useEffect(() => {
    (async () => {
      const accs = await listAccounts();
      setAccounts(accs);
      setSummary(await monthSummary(month));
      setRecent(await recentTransactions(8));
      await loadInvestments();
    })();
  }, [month, loadInvestments]);

  const cash = accounts
    .filter((a) => a.type !== "housing_fund")
    .reduce((s, a) => s + a.balance, 0);
  const housingBalance = accounts
    .filter((a) => a.type === "housing_fund")
    .reduce((s, a) => s + a.balance, 0);
  // 首次使用引导：期初全为 0 且没有任何流水时，提示先设置当前资产
  const needInitGuide =
    accounts.length > 0 &&
    accounts.every((a) => a.opening_balance === 0) &&
    recent.length === 0;

  function openOpeningModal() {
    const d: Record<number, string> = {};
    for (const a of accounts) {
      d[a.id] = a.opening_balance === 0 ? "" : String(a.opening_balance);
    }
    setDrafts(d);
    setHoldings([]);
    setHoldingDate(todayStr());
    setShowOpening(true);
  }

  function updateHolding(key: number, patch: Partial<HoldingDraft>) {
    setHoldings((hs) =>
      hs.map((h) => (h.key === key ? { ...h, ...patch } : h))
    );
  }

  /** 代码失焦后自动带出名称和最新净值/现价（成本价可再手动改） */
  async function lookupHolding(h: HoldingDraft) {
    const code = h.code.trim();
    if (!code) return;
    try {
      if (h.type === "fund") {
        const info = await fetchFundInfo(code);
        if (info) {
          updateHolding(h.key, {
            name: info.name,
            price: h.price || (Number.isFinite(info.nav) ? String(info.nav) : ""),
          });
        } else {
          alert(`未识别基金代码 ${code}，可检查代码后重试，或手动填写名称和成本价`);
        }
      } else {
        const info = await fetchStockInfo(toTencentCode(code));
        if (info) {
          updateHolding(h.key, {
            name: info.name,
            price: h.price || (Number.isFinite(info.price) ? String(info.price) : ""),
          });
        } else {
          alert(`未识别股票代码 ${code}，可检查代码后重试，或手动填写名称和成本价`);
        }
      }
    } catch (e) {
      alert(`查询 ${code} 失败：${String(e)}。可手动填写名称和成本价`);
    }
  }

  async function saveOpening() {
    setSavingOpening(true);
    try {
      // 1) 现金类账户期初
      for (const a of accounts) {
        const raw = (drafts[a.id] ?? "").trim();
        const v = raw === "" ? 0 : Number(raw);
        if (!Number.isFinite(v) || v < 0) {
          throw new Error(`「${a.name}」的金额无效`);
        }
        if (v !== a.opening_balance) await setOpeningBalance(a.id, v);
      }
      // 2) 投资持仓期初：记为 account_id=null 的申购（不扣现金）
      for (const h of holdings) {
        const code = h.code.trim();
        if (!code) continue; // 空行跳过
        const shares = Number(h.shares);
        const price = Number(h.price);
        if (!Number.isFinite(shares) || shares <= 0) {
          throw new Error(`持仓 ${code} 的份额无效`);
        }
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`持仓 ${code} 的成本单价无效`);
        }
        const name = h.name.trim() || code;
        const assetId = await getOrCreateAsset(code, name, h.type);
        await addInvestmentTxn({
          asset_id: assetId,
          date: holdingDate,
          type: "buy",
          amount: Math.round(shares * price * 100) / 100,
          shares,
          price,
          account_id: null,
        });
      }
      setShowOpening(false);
      setAccounts(await listAccounts());
      await loadInvestments();
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setSavingOpening(false);
    }
  }

  // 启动时增量同步行情；有新数据则刷新投资部分
  useEffect(() => {
    (async () => {
      const r = await syncAllMarketData();
      if (r.ok && r.message === "行情同步完成") await loadInvestments();
    })();
  }, [loadInvestments]);

  // 超 7 天未备份 → 轻提醒（设计文档 §四）
  useEffect(() => {
    getMeta("last_backup_at").then((v) => {
      if (!v) {
        setShowBackup(true);
        return;
      }
      const days = (Date.now() - new Date(v).getTime()) / 86400000;
      if (days > 7) setShowBackup(true);
    });
  }, []);

  async function doBackup() {
    try {
      const dir = await open({ directory: true, title: "选择备份目录" });
      if (!dir) return;
      const dest = `${dir}/mirrorfin-backup-${todayStr()}.db`;
      await invoke<string>("export_backup", { destPath: dest });
      await setMeta("last_backup_at", new Date().toISOString());
      setShowBackup(false);
      setBackupMsg(`已备份到 ${dest}`);
    } catch (e) {
      setBackupMsg(`备份失败：${String(e)}`);
    }
  }

  const netWorth = cash + inv.fundMV + inv.stockMV + housingBalance;
  const balance = summary.income - summary.expense;

  const allocOption = {
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
        data: [
          { name: "现金", value: +cash.toFixed(2), itemStyle: { color: "#8E8E93" } },
          { name: "公积金", value: +housingBalance.toFixed(2), itemStyle: { color: "#34C759" } },
          ...(Object.keys(ASSET_CATEGORY_LABEL) as AssetCategory[]).map(
            (c) => ({
              name: ASSET_CATEGORY_LABEL[c],
              value: +(inv.catMV[c] ?? 0).toFixed(2),
              itemStyle: { color: ASSET_CATEGORY_COLOR[c] },
            })
          ),
        ].filter((d) => d.value > 0.005),
      },
    ],
  };

  const curveOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: unknown) => `${Number(v).toFixed(2)}%`,
    },
    grid: { left: 8, right: 8, top: 16, bottom: 24, containLabel: true },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" }, scale: true },
    series: [
      {
        type: "line",
        data: inv.curve,
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
          <div className="page-title">首页</div>
          <div className="page-sub">{monthLabel(month)}</div>
        </div>
        <Link to="/entry" className="btn btn-primary">
          <IconPlus size={16} />
          记一笔
        </Link>
      </div>

      {needInitGuide && (
        <div className="banner">
          <span style={{ flex: 1 }}>
            欢迎使用 MirrorFin。开始前先设置一下当前的资产——微信/支付宝/
            银行卡里的余额，以及已持有的基金股票，之后记的每一笔都会在这个基础上增减。
          </span>
          <button className="btn btn-primary" onClick={openOpeningModal}>
            设置初始资产
          </button>
        </div>
      )}

      {showBackup && (
        <div className="banner">
          <span style={{ flex: 1 }}>
            数据只存在这台电脑上，超过 7 天没备份了。导一份到 U
            盘或网盘吧，加密打包后续版本支持。
          </span>
          <button className="btn btn-primary" onClick={doBackup}>
            立即备份
          </button>
          <button className="btn btn-ghost" onClick={() => setShowBackup(false)}>
            稍后
          </button>
        </div>
      )}
      {backupMsg && (
        <div className="toast toast-success" style={{ marginBottom: 16 }}>
          {backupMsg}
        </div>
      )}

      <div className="stat-grid section-gap">
        <div className="card">
          <div className="stat-label">净资产</div>
          <div className="stat-value num">¥{fmtMoney(netWorth)}</div>
          <div className="stat-hint">
            现金 ¥{fmtMoney(cash)} · 基金 ¥{fmtMoney(inv.fundMV)} · 股票 ¥
            {fmtMoney(inv.stockMV)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">本月收入</div>
          <div className="stat-value num text-rise">
            +¥{fmtMoney(summary.income)}
          </div>
          <div className="stat-hint">{monthLabel(month)}</div>
        </div>
        <div className="card">
          <div className="stat-label">本月支出</div>
          <div className="stat-value num">¥{fmtMoney(summary.expense)}</div>
          <div className="stat-hint">纯消费口径，投资不算支出</div>
        </div>
        <div className="card">
          <div className="stat-label">本月结余</div>
          <div
            className={`stat-value num ${
              balance > 0 ? "text-rise" : balance < 0 ? "text-fall" : ""
            }`}
          >
            {balance >= 0 ? "+" : ""}¥{fmtMoney(balance)}
          </div>
          <div className="stat-hint">收入 − 支出</div>
        </div>
        <div className="card">
          <div className="stat-label">本月投资已实现</div>
          <div
            className={`stat-value num ${
              invRealized > 0
                ? "text-rise"
                : invRealized < 0
                ? "text-fall"
                : ""
            }`}
          >
            {invRealized >= 0 ? "+" : "-"}¥{fmtMoney(Math.abs(invRealized))}
          </div>
          <div className="stat-hint">清仓盈亏，不计入现金结余</div>
        </div>
      </div>

      <div className="card section-gap">
        <div
          className="card-title"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          我的账户
          <div style={{ display: "flex", gap: 12 }}>
            <button className="mini-link" onClick={() => setShowReconcile(true)}>
              按当前余额校准
            </button>
            <button className="mini-link" onClick={openOpeningModal}>
              设置期初
            </button>
          </div>
        </div>
        {accounts.map((a) => (
          <div key={a.id} className="account-row">
            <span className="account-name">{a.name}</span>
            <span className="account-opening">
              期初 ¥{fmtMoney(a.opening_balance)}
            </span>
            <span className="account-balance num">
              ¥{fmtMoney(a.balance)}
            </span>
          </div>
        ))}
      </div>

      <div className="grid-2 section-gap">
        <div className="card">
          <div className="card-title">资产配置</div>
          {netWorth > 0 ? (
            <Chart option={allocOption} height={240} />
          ) : (
            <div className="empty">
              <div className="empty-sub">录入数据后展示现金 / 基金 / 股票占比</div>
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
            }}
          >
            投资收益曲线
            <Link to="/review" className="mini-link">
              去复盘 <IconChevronRight size={12} />
            </Link>
          </div>
          {inv.curve.length > 1 ? (
            <Chart option={curveOption} height={240} />
          ) : (
            <div className="empty">
              <div className="empty-sub">
                录入投资交易并同步行情后，这里会画出收益曲线
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div
          className="card-title"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          最近流水
          <Link to="/transactions" className="mini-link">
            全部 <IconChevronRight size={12} />
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="empty">
            <div className="empty-title">还没有流水</div>
            <div className="empty-sub">点右上角「记一笔」开始吧</div>
          </div>
        ) : (
          <ul className="txn-list">
            {recent.map((t) => (
              <li key={t.id} className="txn-row">
                <span className="txn-date">{shortDate(t.date)}</span>
                <span className="txn-cat">
                  {t.type === "transfer" ? "转账" : t.category_name ?? "未分类"}
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
                  {t.type === "income" ? "+" : t.type === "expense" ? "-" : ""}
                  ¥{fmtMoney(t.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {showReconcile && (
        <ReconcileModal
          accounts={accounts}
          onClose={() => setShowReconcile(false)}
          onSaved={async () => {
            setShowReconcile(false);
            setAccounts(await listAccounts());
            await loadInvestments();
          }}
        />
      )}
      {showOpening && (
        <div className="modal-mask" onClick={() => setShowOpening(false)}>
          <div
            className="modal"
            style={{ width: 540 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">设置初始资产</div>
            <div className="modal-sub">
              填你开始记账那一刻的实际情况：现金类填账户余额，
              投资类填当前持仓。这些都不算收入，不影响本月收支统计。
            </div>

            <div className="section-divider">账户余额（含公积金）</div>
            {accounts.map((a) => (
              <div key={a.id} className="field" style={{ marginBottom: 12 }}>
                <label className="field-label">{a.name}</label>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={drafts[a.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [a.id]: e.target.value }))
                  }
                />
              </div>
            ))}

            <div className="section-divider">
              投资持仓（基金 / 股票）
              <button
                className="mini-link"
                onClick={() =>
                  setHoldings((hs) => [
                    ...hs,
                    {
                      key: ++holdingKey.current,
                      type: "fund",
                      code: "",
                      name: "",
                      shares: "",
                      price: "",
                    },
                  ])
                }
              >
                + 添加持仓
              </button>
            </div>
            {holdings.length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--text-tertiary)",
                  marginBottom: 8,
                }}
              >
                开始记账前已持有的基金/股票在这里录入，没有可跳过。
              </div>
            ) : (
              <>
                {holdings.map((h) => (
                  <div key={h.key}>
                    <div className="holding-row">
                      <select
                        className="select"
                        value={h.type}
                        onChange={(e) =>
                          updateHolding(h.key, {
                            type: e.target.value as "fund" | "stock",
                            name: "",
                          })
                        }
                      >
                        <option value="fund">基金</option>
                        <option value="stock">股票</option>
                      </select>
                      <input
                        className="input"
                        placeholder="代码"
                        value={h.code}
                        onChange={(e) =>
                          updateHolding(h.key, { code: e.target.value })
                        }
                        onBlur={() => lookupHolding(h)}
                      />
                      <input
                        className="input"
                        type="number"
                        min="0"
                        placeholder="持有份额"
                        value={h.shares}
                        onChange={(e) =>
                          updateHolding(h.key, { shares: e.target.value })
                        }
                      />
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step="0.0001"
                        placeholder="成本单价"
                        value={h.price}
                        onChange={(e) =>
                          updateHolding(h.key, { price: e.target.value })
                        }
                      />
                      <button
                        className="holding-del"
                        title="删除此行"
                        onClick={() =>
                          setHoldings((hs) => hs.filter((x) => x.key !== h.key))
                        }
                      >
                        ×
                      </button>
                    </div>
                    {h.name && <div className="holding-name">{h.name}</div>}
                  </div>
                ))}
                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">
                    建仓日期（填大概的真实买入日期，收益曲线会从该日期画起；不扣减现金）
                  </label>
                  <input
                    className="input"
                    type="date"
                    value={holdingDate}
                    onChange={(e) => setHoldingDate(e.target.value)}
                  />
                </div>
              </>
            )}

            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShowOpening(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={savingOpening}
                onClick={saveOpening}
              >
                {savingOpening ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
