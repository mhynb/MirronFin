import { useState } from "react";
import { updateTransaction } from "../lib/db";
import { fmtMoney } from "../lib/format";
import type { Account, Category, Transaction, TxnType } from "../lib/types";

const TYPE_TABS: { key: TxnType; label: string }[] = [
  { key: "expense", label: "支出" },
  { key: "income", label: "收入" },
  { key: "transfer", label: "转账" },
];

interface Props {
  txn: Transaction;
  accounts: Account[];
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}

/** 自包含编辑弹窗：预填传入流水，保存调 updateTransaction，校验与 EntryPage 一致 */
export default function EditTxnModal({
  txn,
  accounts,
  categories,
  onClose,
  onSaved,
}: Props) {
  const [type, setType] = useState<TxnType>(txn.type);
  const [amount, setAmount] = useState(String(txn.amount));
  const [date, setDate] = useState(txn.date);
  const [accountId, setAccountId] = useState<number>(txn.account_id);
  const [toAccountId, setToAccountId] = useState<number | "">(
    txn.to_account_id ?? ""
  );
  const [categoryId, setCategoryId] = useState<number | null>(txn.category_id);
  const [note, setNote] = useState(txn.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleCats = categories.filter(
    (c) => c.type === (type === "income" ? "income" : "expense")
  );

  function switchType(t: TxnType) {
    setType(t);
    setCategoryId(null);
    setError(null);
  }

  async function submit() {
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("请输入大于 0 的金额");
      return;
    }
    if (!accountId) {
      setError("请选择账户");
      return;
    }
    if (type === "transfer") {
      if (toAccountId === "" || toAccountId === accountId) {
        setError("转出和转入账户不能相同");
        return;
      }
    } else if (categoryId === null) {
      setError("请选择分类");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateTransaction(txn.id, {
        date,
        account_id: accountId,
        category_id: type === "transfer" ? null : categoryId,
        amount: value,
        type,
        to_account_id: type === "transfer" ? (toAccountId as number) : null,
        note: note.trim(),
      });
      onSaved();
    } catch (e) {
      setError(`保存失败：${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">编辑流水</div>
        <div className="modal-sub">
          {txn.date} · {type === "transfer" ? "转账" : txn.category_name ?? "未分类"} ¥
          {fmtMoney(txn.amount)}
        </div>

        <div style={{ textAlign: "center", marginBottom: 20 }}>
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

        <div style={{ marginBottom: 20 }}>
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

        {error && (
          <div className="toast toast-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
