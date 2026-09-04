/**
 * AI 理财顾问的结构化复盘报告渲染。
 *
 * 数据来源：后端 ask_ai 解析 LLM 输出得到的 JSON（见 advisor_system_prompt.md）。
 * 关键数字（XIRR/超额/回撤）不由 AI 回显，而由前端用已算好的指标注入，
 * 保证和复盘页面上方指标卡完全一致、不被 AI 取整或改写。
 *
 * 「资产配置体检」由前端确定性计算传入（checks），AI 输出的「体检解读」
 * 按 项目名 对齐附注在每项下——数值永远可信，AI 只负责解读。
 *
 * 状态色（teal/琥珀/珊瑚）独立于涨跌红绿，见 global.css 的 --status-* 变量。
 */

import type { CheckItem } from "../lib/types";

export interface DiagnosisItem {
  标题: string;
  状态: string; // 好 / 一般 / 差
  说明: string;
  依据?: string; // 可选：AI 引用的原始数据出处，便于用户核对
}

export interface RiskItem {
  标题: string;
  严重度: string; // 高 / 中 / 低
  说明: string;
  依据?: string;
}

export interface AdviceItem {
  优先级: string; // 高 / 中 / 低
  行动: string;
  理由: string;
  依据?: string;
}

export interface OneThing {
  行动?: string;
  理由?: string;
}

export interface CheckReview {
  项目: string;
  解读: string;
}

export interface AdvisorContent {
  结论?: { 一句话?: string; 评级?: string }; // 评级：健康 / 一般 / 需关注
  最该做的一件事?: OneThing;
  体检解读?: CheckReview[];
  诊断?: DiagnosisItem[];
  风险?: RiskItem[];
  建议?: AdviceItem[];
}

export interface AdvisorMetrics {
  xirr: number | null; // 比率（0.042 = 4.2%）
  excess: number | null; // 组合区间年化 - 沪深300 区间年化（比率）
  drawdown: number | null; // 最大回撤（正比率，0.085 = 8.5%）
}

function ratingClass(r: string): string {
  if (r === "健康") return "badge-good";
  if (r === "需关注") return "badge-bad";
  return "badge-warn"; // 一般 或未知
}

/** 体检状态 → badge 色（用状态色三档，不与涨跌红绿混淆） */
function checkStatusClass(s: string): string {
  if (s === "达标") return "badge-good";
  if (s === "偏高") return "badge-bad";
  return "badge-warn"; // 偏低 或未知
}

function statusDotClass(s: string): string {
  if (s === "好") return "dot-good";
  if (s === "差") return "dot-bad";
  return "dot-warn";
}

function severityClass(s: string): string {
  if (s === "高") return "badge-bad";
  if (s === "低") return "badge-good";
  return "badge-warn";
}

function priorityClass(p: string): string {
  if (p === "高") return "badge-bad";
  if (p === "低") return "badge-good";
  return "badge-warn";
}

/** 比率 → 带符号百分比字符串（0.042 → "+4.20%"，-0.018 → "-1.80%"） */
function signedPct(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return "—";
  return (r > 0 ? "+" : "") + (r * 100).toFixed(2) + "%";
}

/** 涨跌色 class：正=红(涨)、负=绿(跌)、零/空=无色 */
function numColor(r: number | null): string {
  if (r === null || r === 0) return "";
  return r > 0 ? "text-rise" : "text-fall";
}

export default function AdvisorReport({
  content,
  metrics,
  checks = [],
  skill,
}: {
  content: AdvisorContent;
  metrics: AdvisorMetrics;
  checks?: CheckItem[];
  skill?: string;
}) {
  const verdict = content.结论;
  const oneThing = content.最该做的一件事;
  const checkReviews = new Map(
    (content.体检解读 ?? []).map((r) => [r.项目, r.解读])
  );
  const diag = content.诊断 ?? [];
  const risks = content.风险 ?? [];
  const advice = content.建议 ?? [];

  return (
    <div>
      {skill && <div className="advisor-skill-tag">分析视角 · {skill}</div>}

      {verdict && (verdict.一句话 || verdict.评级) && (
        <div className="advisor-hero">
          <div className="advisor-hero-top">
            {verdict.一句话 && (
              <div className="advisor-verdict">{verdict.一句话}</div>
            )}
            {verdict.评级 && (
              <span className={`badge advisor-rating ${ratingClass(verdict.评级)}`}>
                {verdict.评级}
              </span>
            )}
          </div>
          <div className="advisor-num-grid">
            <div className="advisor-num-tile">
              <div className="advisor-num-label">XIRR 年化</div>
              <div className={`advisor-num-value ${numColor(metrics.xirr)}`}>
                {signedPct(metrics.xirr)}
              </div>
            </div>
            <div className="advisor-num-tile">
              <div className="advisor-num-label">超额 vs 沪深300</div>
              <div className={`advisor-num-value ${numColor(metrics.excess)}`}>
                {signedPct(metrics.excess)}
              </div>
            </div>
            <div className="advisor-num-tile">
              <div className="advisor-num-label">最大回撤</div>
              <div className="advisor-num-value text-fall">
                {metrics.drawdown === null || !Number.isFinite(metrics.drawdown)
                  ? "—"
                  : `-${(metrics.drawdown * 100).toFixed(2)}%`}
              </div>
            </div>
          </div>
        </div>
      )}

      {oneThing && (oneThing.行动 || oneThing.理由) && (
        <div className="advisor-onething">
          <div className="advisor-onething-label">最该做的一件事</div>
          {oneThing.行动 && (
            <div className="advisor-onething-action">{oneThing.行动}</div>
          )}
          {oneThing.理由 && (
            <div className="advisor-onething-why">{oneThing.理由}</div>
          )}
        </div>
      )}

      {checks.length > 0 && (
        <div className="advisor-section">
          <div className="advisor-label">资产配置体检</div>
          {checks.map((c) => (
            <div className="advisor-item" key={c.项目}>
              <div className="advisor-item-head">
                <span className={`badge ${checkStatusClass(c.状态)}`}>
                  {c.状态}
                </span>
                <span className="advisor-item-title">{c.项目}</span>
                <span className="advisor-check-num num">
                  {c.当前值}
                  <span className="advisor-check-range"> / {c.参考区间}</span>
                </span>
              </div>
              {checkReviews.get(c.项目) && (
                <div className="advisor-item-desc">
                  {checkReviews.get(c.项目)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {diag.length > 0 && (
        <div className="advisor-section">
          <div className="advisor-label">现状诊断</div>
          {diag.map((d, i) => (
            <div className="advisor-item" key={i}>
              <div className="advisor-item-head">
                <span className={`advisor-dot ${statusDotClass(d.状态)}`} />
                <span className="advisor-item-title">{d.标题}</span>
              </div>
              {d.说明 && <div className="advisor-item-desc">{d.说明}</div>}
              {d.依据 && (
                <div className="advisor-item-basis">依据 · {d.依据}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {risks.length > 0 && (
        <div className="advisor-section">
          <div className="advisor-label">风险提示</div>
          {risks.map((r, i) => (
            <div className="advisor-item" key={i}>
              <div className="advisor-item-head">
                {r.严重度 && (
                  <span className={`badge ${severityClass(r.严重度)}`}>
                    {r.严重度}
                  </span>
                )}
                <span className="advisor-item-title">{r.标题}</span>
              </div>
              {r.说明 && <div className="advisor-item-desc">{r.说明}</div>}
              {r.依据 && (
                <div className="advisor-item-basis">依据 · {r.依据}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {advice.length > 0 && (
        <div className="advisor-section">
          <div className="advisor-label">行动建议</div>
          {advice.map((a, i) => (
            <div className="advisor-item" key={i}>
              <div className="advisor-item-head">
                {a.优先级 && (
                  <span className={`badge ${priorityClass(a.优先级)}`}>
                    {a.优先级}
                  </span>
                )}
                <span className="advisor-item-title">{a.行动}</span>
              </div>
              {a.理由 && <div className="advisor-item-desc">{a.理由}</div>}
              {a.依据 && (
                <div className="advisor-item-basis">依据 · {a.依据}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="advisor-disclaimer">
        以上仅供参考，投资有风险，决策需结合自身情况。
      </div>
    </div>
  );
}
