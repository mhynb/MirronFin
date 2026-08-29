import { useState } from "react";
import { setOpeningBalance } from "../lib/db";
import { fmtMoney } from "../lib/format";
import type { Account } from "../lib/types";

interface Props {
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 按当前实际余额校准：用户填每个账户现在的真实数字，
 * 系统反推 opening_balance 使派生余额对齐。
 *
 * 公式：opening_new = opening_current + (actual - derived_current)
 *   因为 派生余额 = opening + Σ流水 + Σ投资，调 opening delta，余额跟着变 delta。
 *
 * 代价：差异被吸收到期初，历史余额曲线会整体失真。
 * 设计宪法"余额全部派生不存储"不破坏——改的仍是 opening_balance。
 */
export default function ReconcileModal({
  accounts,
  onClose,
  onSaved,
}: Props) {
  // 预填当前派生余额，用户改成实际数字
  const [actuals, setActuals] = useState<Record<number, string>>(() => {
    const d: Record<number, string> = {};
    for (const a of accounts) d[a.id] = String(a.balance);
    return d;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 算出每个账户的差异，用于展示和确认
  const diffs = accounts.map((a) => {
    const actual = parseFloat(actuals[a.id] ?? "");
    const delta = Number.isFinite(actual) ? actual - a.balance : 0;
    return { account: a, actual, delta };
  });
  const totalDiff = diffs.reduce((s, d) => s + d.delta, 0);
  const hasChange = diffs.some((d) => Math.abs(d.delta) >= 0.005);

  async function submit() {
    setError(null);
    // 校验
    for (const d of diffs) {
      if (!Number.isFinite(d.actual)) {
        setError(`「${d.account.name}」的金额无效`);
        return;
      }
      if (d.actual < 0) {
        setError(`「${d.account.name}」的金额不能为负`);
        return;
      }
    }
    const changed = diffs.filter((d) => Math.abs(d.delta) >= 0.005);
    if (changed.length === 0) {
      onClose();
      return;
    }
    const lines = changed
      .map(
        (d) =>
          `${d.account.name}：${d.delta >= 0 ? "+" : ""}¥${fmtMoney(d.delta)}`
      )
      .join("\n");
    const ok = window.confirm(
      `确认按当前余额校准？以下账户的期初余额将被调整：\n\n${lines}\n\n` +
        `注意：差异会吸收到期初余额，历史余额曲线会整体失真。\n` +
        `如果你记得是哪笔流水记错了，更推荐去收支页编辑那笔流水。`
    );
    if (!ok) return;
    setSaving(true);
    try {
      for (const d of changed) {
        const newOpening = d.account.opening_balance + d.delta;
        await setOpeningBalance(d.account.id, newOpening);
      }
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
        <div className="modal-title">按当前余额校准</div>
        <div className="modal-sub">
          填每个账户现在的真实余额，系统会调整期初余额使派生值对齐。
          适合对不上但不记得哪笔记错的场景。
        </div>

        <div
          className="toast toast-error"
          style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}
        >
          ⚠ 差异会吸收到期初，历史余额曲线会失真。记得哪笔流水记错时，优先去收支页编辑那笔流水。
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {accounts.map((a) => {
            const d = diffs.find((x) => x.account.id === a.id)!;
            return (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span style={{ flex: "0 0 80px", fontWeight: 500 }}>
                  {a.name}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  当前 ¥{fmtMoney(a.balance)}
                </span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  style={{ width: 120, textAlign: "right" }}
                  value={actuals[a.id] ?? ""}
                  onChange={(e) =>
                    setActuals((s) => ({ ...s, [a.id]: e.target.value }))
                  }
                />
                <span
                  style={{
                    flex: "0 0 72px",
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      Math.abs(d.delta) < 0.005
                        ? "var(--text-tertiary)"
                        : d.delta > 0
                        ? "var(--rise)"
                        : "var(--fall)",
                  }}
                >
                  {Math.abs(d.delta) < 0.005
                    ? "—"
                    : `${d.delta > 0 ? "+" : ""}¥${fmtMoney(d.delta)}`}
                </span>
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--text-secondary)" }}>
            合计差异：
            <b
              style={{
                color:
                  Math.abs(totalDiff) < 0.005
                    ? "var(--text-primary)"
                    : totalDiff > 0
                    ? "var(--rise)"
                    : "var(--fall)",
              }}
            >
              {totalDiff >= 0 ? "+" : ""}¥{fmtMoney(totalDiff)}
            </b>
          </span>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            合计为 0 时通常是账户间转账记错了
          </span>
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
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || !hasChange}
          >
            {saving ? "保存中…" : "校准"}
          </button>
        </div>
      </div>
    </div>
  );
}
