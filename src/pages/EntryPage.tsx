import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  addInvestmentTxn,
  addTransaction,
  getOrCreateAsset,
  listAccounts,
  listAssets,
  listCategories,
} from "../lib/db";
import { todayStr } from "../lib/format";
import {
  fetchFundInfo,
  fetchStockInfo,
  navOnDate,
  toTencentCode,
} from "../lib/market";
import type {
  Account,
  Asset,
  AssetType,
  Category,
  InvestTxnType,
  TxnType,
} from "../lib/types";

const TYPE_TABS: { key: TxnType; label: string }[] = [
  { key: "expense", label: "支出" },
  { key: "income", label: "收入" },
  { key: "transfer", label: "转账" },
];

const INV_TABS: { key: InvestTxnType; label: string }[] = [
  { key: "buy", label: "申购" },
  { key: "sell", label: "赎回" },
  { key: "dividend", label: "红利再投" },
];

export default function EntryPage() {
  const [mode, setMode] = useState<"cash" | "invest">("cash");
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    listAccounts().then((accs) => {
      setAccounts(accs);
      if (accs.length > 0) setAccountId(accs[0].id);
    });
  }, []);

  // ---------- 日常收支表单 ----------

  const [type, setType] = useState<TxnType>("expense");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayStr());
  const [accountId, setAccountId] = useState<number | "">("");
  const [toAccountId, setToAccountId] = useState<number | "">("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [status, setStatus] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listCategories().then(setCategories);
  }, []);

  const visibleCats = categories.filter(
    (c) => c.type === (type === "income" ? "income" : "expense")
  );

  function switchType(t: TxnType) {
    setType(t);
    setCategoryId(null);
    setStatus(null);
  }

  async function submitCash() {
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: "error", text: "请输入大于 0 的金额" });
      return;
    }
    if (accountId === "") {
      setStatus({ kind: "error", text: "请选择账户" });
      return;
    }
    if (type === "transfer") {
      if (toAccountId === "" || toAccountId === accountId) {
        setStatus({ kind: "error", text: "转出和转入账户不能相同" });
        return;
      }
    } else if (categoryId === null) {
      setStatus({ kind: "error", text: "请选择分类" });
      return;
    }
    setSaving(true);
    try {
      await addTransaction({
        date,
        account_id: accountId,
        category_id: type === "transfer" ? null : categoryId,
        amount: value,
        type,
        to_account_id: type === "transfer" ? (toAccountId as number) : null,
        note: note.trim(),
      });
      setStatus({ kind: "success", text: "已记下这一笔" });
      setAmount("");
      setNote("");
    } catch (e) {
      setStatus({ kind: "error", text: `保存失败：${String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  // ---------- 投资交易表单 ----------

  const [invType, setInvType] = useState<InvestTxnType>("buy");
  const [assetType, setAssetType] = useState<AssetType>("fund");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [invDate, setInvDate] = useState(todayStr());
  const [price, setPrice] = useState("");
  const [shares, setShares] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [invAccountId, setInvAccountId] = useState<number | "">("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [looking, setLooking] = useState(false);
  const [invStatus, setInvStatus] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [invSaving, setInvSaving] = useState(false);

  useEffect(() => {
    listAssets().then(setAssets);
  }, []);

  useEffect(() => {
    if (accounts.length > 0 && invAccountId === "")
      setInvAccountId(accounts[0].id);
  }, [accounts, invAccountId]);

  // 金额自动 = 单价 × 份额（红利再投始终按净值折算，其余可手改）
  useEffect(() => {
    if (amountTouched && invType !== "dividend") return;
    const p = parseFloat(price);
    const s = parseFloat(shares);
    if (Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0) {
      setInvAmount((p * s).toFixed(2));
    }
  }, [price, shares, amountTouched, invType]);

  // 净值预填：已有标的 + 日期 → 当日净值（用户没手改过价格时）
  useEffect(() => {
    if (priceTouched) return;
    const c = code.trim();
    if (!c || !invDate) return;
    const local = assets.find((a) => a.code === c && a.type === assetType);
    if (!local) return;
    navOnDate(local, invDate).then((nav) => {
      if (nav) setPrice(String(nav));
    });
  }, [code, assetType, invDate, assets, priceTouched]);

  function fillAsset(a: Asset) {
    setAssetType(a.type);
    setCode(a.code);
    setName(a.name);
    setPriceTouched(false);
    setInvStatus(null);
  }

  async function resolveAsset() {
    const c = code.trim();
    if (!c) return;
    const local = assets.find((a) => a.code === c && a.type === assetType);
    if (local) {
      setName(local.name);
      return;
    }
    setLooking(true);
    try {
      if (assetType === "fund") {
        const info = await fetchFundInfo(c);
        if (info) {
          setName(info.name);
          if (!priceTouched) setPrice(String(info.nav));
        } else {
          setInvStatus({ kind: "error", text: "没查到这个基金代码" });
        }
      } else {
        const info = await fetchStockInfo(toTencentCode(c));
        if (info && Number.isFinite(info.price)) {
          setName(info.name);
          if (!priceTouched) setPrice(String(info.price));
        } else {
          setInvStatus({ kind: "error", text: "没查到这个股票代码" });
        }
      }
    } catch {
      setInvStatus({ kind: "error", text: "联网查询失败，可手动填名称和价格" });
    } finally {
      setLooking(false);
    }
  }

  async function submitInvest() {
    const c = code.trim();
    const n = name.trim();
    const p = parseFloat(price);
    const s = parseFloat(shares);
    if (!c || !n) {
      setInvStatus({ kind: "error", text: "请输入代码并确认标的名称" });
      return;
    }
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) {
      setInvStatus({ kind: "error", text: "单价和份额都要大于 0" });
      return;
    }
    if (invType !== "dividend" && invAccountId === "") {
      setInvStatus({ kind: "error", text: "请选择资金账户" });
      return;
    }
    let amt = parseFloat(invAmount);
    if (!Number.isFinite(amt) || amt <= 0 || invType === "dividend") amt = p * s;
    setInvSaving(true);
    try {
      const assetId = await getOrCreateAsset(c, n, assetType);
      await addInvestmentTxn({
        asset_id: assetId,
        date: invDate,
        type: invType,
        amount: amt,
        shares: s,
        price: p,
        account_id: invType === "dividend" ? null : (invAccountId as number),
      });
      setAssets(await listAssets());
      setInvStatus({ kind: "success", text: "已记下这笔投资" });
      setShares("");
      setInvAmount("");
      setAmountTouched(false);
      setPrice("");
      setPriceTouched(false);
    } catch (e) {
      setInvStatus({ kind: "error", text: `保存失败：${String(e)}` });
    } finally {
      setInvSaving(false);
    }
  }

  const frequent = assets.slice(0, 6);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">录入</div>
          <div className="page-sub">记一笔，让数据替你复盘</div>
        </div>
      </div>

      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div className="segmented">
          <button
            className={mode === "cash" ? "active" : ""}
            onClick={() => setMode("cash")}
          >
            记收支
          </button>
          <button
            className={mode === "invest" ? "active" : ""}
            onClick={() => setMode("invest")}
          >
            记投资
          </button>
        </div>
      </div>

      {mode === "cash" ? (
        <div className="card entry-card section-gap">
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div className="segmented">
              {TYPE_TABS.map((t) => (
                <button
                  key={t.key}
                  className={type === t.key ? "active" : ""}
                  onClick={() => switchType(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 24 }}>
            <input
              className="amount-input"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-grid">
            <div className="field">
              <span className="field-label">日期</span>
              <input
                type="date"
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            {type === "transfer" ? (
              <>
                <div className="field">
                  <span className="field-label">转出账户</span>
                  <select
                    className="select"
                    value={accountId}
                    onChange={(e) => setAccountId(Number(e.target.value))}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field span-2">
                  <span className="field-label">转入账户</span>
                  <select
                    className="select"
                    value={toAccountId}
                    onChange={(e) => setToAccountId(Number(e.target.value))}
                  >
                    <option value="">请选择</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <div className="field">
                <span className="field-label">账户</span>
                <select
                  className="select"
                  value={accountId}
                  onChange={(e) => setAccountId(Number(e.target.value))}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {type !== "transfer" && (
              <div className="field span-2">
                <span className="field-label">分类</span>
                <div className="chips">
                  {visibleCats.map((c) => (
                    <button
                      key={c.id}
                      className={`chip ${categoryId === c.id ? "active" : ""}`}
                      onClick={() => setCategoryId(c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="field span-2">
              <span className="field-label">备注（可选）</span>
              <input
                className="input"
                placeholder="一句话说明这笔钱"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginTop: 24 }}>
            {status && (
              <div
                className={`toast ${
                  status.kind === "success" ? "toast-success" : "toast-error"
                }`}
              >
                {status.text}
                {status.kind === "success" && (
                  <Link to="/transactions" style={{ color: "inherit" }}>
                    查看流水
                  </Link>
                )}
              </div>
            )}
            <button
              className="btn btn-primary btn-lg"
              style={{ width: "100%" }}
              onClick={submitCash}
              disabled={saving}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      ) : (
        <div className="card entry-card section-gap">
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div className="segmented">
              {INV_TABS.map((t) => (
                <button
                  key={t.key}
                  className={invType === t.key ? "active" : ""}
                  onClick={() => {
                    setInvType(t.key);
                    setInvStatus(null);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {frequent.length > 0 && (
            <div className="field" style={{ marginBottom: 16 }}>
              <span className="field-label">常用标的</span>
              <div className="chips">
                {frequent.map((a) => (
                  <button
                    key={a.id}
                    className={`chip ${code === a.code ? "active" : ""}`}
                    onClick={() => fillAsset(a)}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-grid">
            <div className="field">
              <span className="field-label">类型</span>
              <div className="segmented" style={{ width: "100%" }}>
                <button
                  style={{ flex: 1 }}
                  className={assetType === "fund" ? "active" : ""}
                  onClick={() => setAssetType("fund")}
                >
                  基金
                </button>
                <button
                  style={{ flex: 1 }}
                  className={assetType === "stock" ? "active" : ""}
                  onClick={() => setAssetType("stock")}
                >
                  股票
                </button>
              </div>
            </div>
            <div className="field">
              <span className="field-label">代码</span>
              <input
                className="input"
                placeholder={assetType === "fund" ? "如 110022" : "如 600519"}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPriceTouched(false);
                }}
                onBlur={resolveAsset}
                list="known-assets"
              />
              <datalist id="known-assets">
                {assets
                  .filter((a) => a.type === assetType)
                  .map((a) => (
                    <option key={a.id} value={a.code}>
                      {a.name}
                    </option>
                  ))}
              </datalist>
            </div>
            <div className="field">
              <span className="field-label">名称</span>
              <input
                className="input"
                placeholder={looking ? "查询中…" : "填代码后自动带出"}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <span className="field-label">日期</span>
              <input
                type="date"
                className="input"
                value={invDate}
                onChange={(e) => setInvDate(e.target.value)}
              />
            </div>
            <div className="field">
              <span className="field-label">
                {assetType === "fund" ? "净值" : "成交单价"}
              </span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                placeholder="0.000"
                value={price}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setPriceTouched(true);
                }}
              />
            </div>
            <div className="field">
              <span className="field-label">
                份额{assetType === "stock" ? "（股数）" : ""}
              </span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
              />
            </div>
            <div className="field">
              <span className="field-label">金额</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                placeholder="自动 = 单价 × 份额"
                value={invAmount}
                onChange={(e) => {
                  setInvAmount(e.target.value);
                  setAmountTouched(true);
                }}
                readOnly={invType === "dividend"}
              />
            </div>
            {invType !== "dividend" ? (
              <div className="field">
                <span className="field-label">资金账户</span>
                <select
                  className="select"
                  value={invAccountId}
                  onChange={(e) => setInvAccountId(Number(e.target.value))}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <span className="field-label">说明</span>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    paddingTop: 8,
                  }}
                >
                  金额 = 份额 × 当日净值，仅作记录，不动现金
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 24 }}>
            {invStatus && (
              <div
                className={`toast ${
                  invStatus.kind === "success" ? "toast-success" : "toast-error"
                }`}
              >
                {invStatus.text}
                {invStatus.kind === "success" && (
                  <Link to="/holdings" style={{ color: "inherit" }}>
                    查看持仓
                  </Link>
                )}
              </div>
            )}
            <button
              className="btn btn-primary btn-lg"
              style={{ width: "100%" }}
              onClick={submitInvest}
              disabled={invSaving}
            >
              {invSaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
