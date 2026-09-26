/**
 * AI 理财顾问的 agent 循环与工具层（2026-09-23 agent 化改造）。
 *
 * 架构：编排全部在 TS（数据层本来就在 TS，Rust 只当 HTTP 中转）。
 *   runAgentLoop(messages) → 调 ask_ai_agent（Rust 非流式中继）
 *     → 模型要查数：dispatchTool 本地执行（直查 SQLite），结果喂回
 *     → 模型不再查：返回终答文本
 *
 * DeepSeek 思考模式硬要求（官方文档，违反会 400）：
 *   带 tools 的多轮请求里，assistant 消息的 reasoning_content 必须原样回传；
 *   跨「用户轮」时只保留 content（reasoning_content 与工具子轮全部丢弃，
 *   上下文更小、也规避了回传规则）。
 *
 * 持久化：报告+追问 → ai_last_report.json（save_ai_report/load_ai_report）；
 * 跨报告记忆（结论+建议清单）→ ai_history.json（save_ai_history/load_ai_history）。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  categoryBreakdown,
  latestNav,
  listAccounts,
  listAssets,
  listInvestmentTxns,
  listTransactions,
  monthlySeries,
} from "./db";
import { computeHolding, portfolioFlows, xirr } from "./analytics";
import { todayStr } from "./format";
import { ASSET_CATEGORY_LABEL } from "./types";

// ---------- 消息与 API 类型 ----------

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** 仅工具链内回传（DeepSeek 思考模式要求）；跨用户轮不要带 */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ApiChoice {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string;
}

interface ApiResponse {
  choices?: ApiChoice[];
  error?: { message?: string };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ReportEnvelope {
  structured: boolean;
  content: unknown; // AdvisorContent（structured=true）或原始文本
  skill?: string;
  date?: string;
  chat?: ChatTurn[];
}

export interface HistoryEntry {
  date: string;
  skill: string;
  结论?: string;
  最该做的一件事?: string;
  建议?: { 优先级?: string; 行动?: string }[];
}

// ---------- 工具定义（发给模型的 JSON Schema） ----------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_monthly_cashflow",
      description: "近 N 个月逐月收支：收入/支出/净储蓄。用于核对趋势、找异常月份。",
      parameters: {
        type: "object",
        properties: {
          months: { type: "number", description: "月数，默认 6，最多 24" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_category_spending",
      description:
        "指定月份的支出分类明细：每个分类的金额/笔数/占比。用于深挖某月某个分类。",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM，默认当月" },
          limit: { type: "number", description: "返回前 N 个分类，默认 8" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transactions",
      description:
        "按月份/分类/类型筛选逐笔流水（日期/类型/分类/金额/账户，无备注）。用于定位具体异常收支。",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM，缺省为全部月份" },
          category: { type: "string", description: "分类名（模糊匹配），可选" },
          type: {
            type: "string",
            enum: ["income", "expense", "transfer"],
            description: "缺省为全部类型",
          },
          limit: { type: "number", description: "最多返回条数，默认 20，最大 50" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_holding_detail",
      description:
        "按名称查单个基金/股票：份额/成本/市值/盈亏/XIRR + 逐笔交易。用于分析买卖点与持有节奏。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "标的名称（可部分匹配）" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_accounts_overview",
      description: "各账户实时余额（微信/支付宝/银行卡/公积金等）。用于回答“钱都在哪”。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_portfolio_overview",
      description:
        "投资组合汇总：总市值/净投入/盈亏/XIRR + 各持仓市值占比。用于快速重核组合现状。",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** 工具名 → 状态条展示文案 */
const TOOL_STATUS: Record<string, string> = {
  get_monthly_cashflow: "逐月收支",
  get_category_spending: "分类支出明细",
  get_transactions: "逐笔流水",
  get_holding_detail: "标的交易明细",
  get_accounts_overview: "账户余额",
  get_portfolio_overview: "组合汇总",
};

// ---------- 工具执行（直查本地 SQLite） ----------

const r2 = (n: number) => +n.toFixed(2);

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  wechat: "微信",
  alipay: "支付宝",
  bank: "银行卡",
  housing_fund: "公积金",
};

const TXN_TYPE_LABEL: Record<string, string> = {
  income: "收入",
  expense: "支出",
  transfer: "转账",
};

const TRADE_TYPE_LABEL: Record<string, string> = {
  buy: "申购",
  sell: "赎回",
  dividend: "红利再投",
};

type ToolArgs = Record<string, unknown>;

async function dispatchTool(name: string, args: ToolArgs): Promise<string> {
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;

  switch (name) {
    case "get_monthly_cashflow": {
      const n = Math.min(Math.max(1, num(args.months, 6)), 24);
      const rows = await monthlySeries(n);
      return JSON.stringify(
        rows.map((p) => ({
          月份: p.month,
          收入: r2(p.income),
          支出: r2(p.expense),
          净储蓄: r2(p.income - p.expense),
        }))
      );
    }

    case "get_category_spending": {
      const month =
        typeof args.month === "string" && /^\d{4}-\d{2}$/.test(args.month)
          ? args.month
          : todayStr().slice(0, 7);
      const limit = Math.min(Math.max(1, num(args.limit, 8)), 30);
      const rows = await categoryBreakdown(month);
      const total = rows.reduce((s, x) => s + x.value, 0);
      return JSON.stringify({
        月份: month,
        支出合计: r2(total),
        分类: rows.slice(0, limit).map((x) => ({
          分类: x.name,
          金额: r2(x.value),
          笔数: x.count,
          占比百分比: total > 0 ? +((x.value / total) * 100).toFixed(1) : 0,
        })),
      });
    }

    case "get_transactions": {
      const type =
        typeof args.type === "string" &&
        ["income", "expense", "transfer"].includes(args.type)
          ? (args.type as "income" | "expense" | "transfer")
          : "all";
      const month =
        typeof args.month === "string" && /^\d{4}-\d{2}$/.test(args.month)
          ? args.month
          : undefined;
      const limit = Math.min(Math.max(1, num(args.limit, 20)), 50);
      const cat =
        typeof args.category === "string" ? args.category.trim() : "";
      let rows = await listTransactions(month ? { month, type } : { type });
      if (cat) {
        rows = rows.filter((t) => (t.category_name ?? "").includes(cat));
      }
      rows = [...rows].sort((a, b) => b.date.localeCompare(a.date));
      const total = rows.length;
      return JSON.stringify({
        命中条数: total,
        返回条数: Math.min(total, limit),
        流水: rows.slice(0, limit).map((t) => ({
          日期: t.date,
          类型: TXN_TYPE_LABEL[t.type] ?? t.type,
          分类: t.category_name ?? "未分类",
          金额: r2(t.amount),
          账户: t.account_name ?? "—",
        })),
      });
    }

    case "get_holding_detail": {
      const q = typeof args.name === "string" ? args.name.trim() : "";
      if (!q) return JSON.stringify({ error: "缺少 name 参数" });
      const [assets, trades] = await Promise.all([
        listAssets(),
        listInvestmentTxns(),
      ]);
      const lower = q.toLowerCase();
      const exact = assets.find((a) => a.name === q);
      const fuzzy = assets.filter((a) =>
        a.name.toLowerCase().includes(lower)
      );
      const asset = exact ?? fuzzy[0];
      if (!asset) {
        return JSON.stringify({
          error: `未找到名称包含「${q}」的标的`,
          可选标的: assets.map((a) => a.name).slice(0, 20),
        });
      }
      const ts = trades.filter((t) => t.asset_id === asset.id);
      if (ts.length === 0) {
        return JSON.stringify({ error: `「${asset.name}」没有任何交易记录` });
      }
      const h = computeHolding(asset, ts);
      const nav = await latestNav(asset.id);
      const price = nav?.nav ?? ts[ts.length - 1].price;
      const mv = h.shares * price;
      const x = xirr(portfolioFlows(ts, todayStr(), mv));
      return JSON.stringify({
        名称: asset.name,
        代码: asset.code,
        类型: asset.type === "fund" ? "基金" : "股票",
        风格: ASSET_CATEGORY_LABEL[asset.category] ?? asset.category,
        持有份额: +h.shares.toFixed(2),
        持有成本: r2(h.cost),
        最新价: price,
        当前市值: r2(mv),
        浮动盈亏: r2(mv - h.cost),
        已实现收益: r2(h.realized),
        XIRR年化百分比: x == null ? null : +(x * 100).toFixed(2),
        交易记录: [...ts]
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 30)
          .map((t) => ({
            日期: t.date,
            类型: TRADE_TYPE_LABEL[t.type] ?? t.type,
            份额: t.shares,
            单价: t.price,
            金额: r2(t.amount),
            账户: t.account_name ?? "—",
          })),
      });
    }

    case "get_accounts_overview": {
      const accounts = await listAccounts();
      return JSON.stringify(
        accounts.map((a) => ({
          名称: a.name,
          类型: ACCOUNT_TYPE_LABEL[a.type] ?? a.type,
          余额: r2(a.balance),
        }))
      );
    }

    case "get_portfolio_overview": {
      const [assets, trades] = await Promise.all([
        listAssets(),
        listInvestmentTxns(),
      ]);
      const used = assets.filter((a) =>
        trades.some((t) => t.asset_id === a.id)
      );
      const holdings = [];
      let totalMV = 0;
      for (const a of used) {
        const ts = trades.filter((t) => t.asset_id === a.id);
        const h = computeHolding(a, ts);
        const nav = await latestNav(a.id);
        const price = nav?.nav ?? ts[ts.length - 1].price;
        const mv = h.shares * price;
        totalMV += mv;
        holdings.push({
          名称: a.name,
          市值: r2(mv),
          盈亏: r2(mv - h.cost + h.realized),
          是否清仓: h.shares === 0,
        });
      }
      const netInvested = trades.reduce(
        (s, t) =>
          s +
          (t.type === "buy" ? t.amount : t.type === "sell" ? -t.amount : 0),
        0
      );
      const x = xirr(portfolioFlows(trades, todayStr(), totalMV));
      return JSON.stringify({
        总市值: r2(totalMV),
        净投入: r2(netInvested),
        累计盈亏: r2(totalMV - netInvested),
        XIRR年化百分比: x == null ? null : +(x * 100).toFixed(2),
        持仓: holdings
          .sort((a, b) => b.市值 - a.市值)
          .map((h) => ({
            ...h,
            占比百分比: totalMV > 0 ? +((h.市值 / totalMV) * 100).toFixed(1) : 0,
          })),
      });
    }

    default:
      return JSON.stringify({ error: `未知工具: ${name}` });
  }
}

// ---------- agent 循环 ----------

/** 单个用户轮里允许的最大工具调用轮数（防失控） */
const MAX_TOOL_TURNS = 8;

export interface AgentTurnResult {
  /** 终答文本（报告模式是 JSON 字符串，追问模式是自然语言） */
  reply: string;
  /** 本轮实际发生的工具调用（供状态条/调试） */
  toolTrace: string[];
}

/**
 * 跑一轮 agent 循环：发消息 → 模型要查数就本地执行并喂回 → 直到模型给出终答。
 * messages 传入完整历史（含 system）；工具子轮不会污染返回值——
 * 跨用户轮的持久化上下文由调用方自己维护（只留 user/assistant content）。
 */
export async function runAgentLoop(
  messages: AgentMessage[],
  onStatus?: (status: string) => void
): Promise<AgentTurnResult> {
  const history: AgentMessage[] = [...messages];
  const toolTrace: string[] = [];

  for (let turn = 0; ; turn++) {
    onStatus?.(turn === 0 ? "正在思考…" : "汇总查到的数据，继续分析…");
    const resp = await invoke<ApiResponse>("ask_ai_agent", {
      messages: JSON.stringify(history),
      tools: JSON.stringify(TOOLS),
    });
    if (resp.error?.message) throw new Error(resp.error.message);
    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error("模型返回格式异常（无 choices）");

    const calls = msg.tool_calls ?? [];
    const content = msg.content ?? "";

    // 空内容护栏（2026-09-04 事故的教训，agent 模式同样适用）：
    // 推理模型思考烧光额度时 finish_reason=length、正文与工具调用都没有。
    if (!content.trim() && calls.length === 0) {
      const fr = choice?.finish_reason ?? "未知";
      const hint =
        fr === "length"
          ? "输出额度被思考阶段耗尽（推理模型特性），正文没写出来。"
          : fr === "content_filter"
          ? "内容被服务商安全策略拦截。"
          : "模型没有生成任何内容。";
      throw new Error(
        `模型未返回内容（结束原因：${fr}）。${hint}请在设置里换一个模型重试。`
      );
    }

    if (calls.length === 0) {
      return { reply: content, toolTrace };
    }
    if (turn >= MAX_TOOL_TURNS) {
      throw new Error(
        `工具调用超过 ${MAX_TOOL_TURNS} 轮仍未给出结论，已中止。请重试。`
      );
    }

    // DeepSeek 思考模式硬要求：工具链内的 assistant 消息必须回传 reasoning_content
    history.push({
      role: "assistant",
      content,
      tool_calls: calls,
      reasoning_content: msg.reasoning_content,
    });

    for (const call of calls) {
      const label = TOOL_STATUS[call.function.name] ?? call.function.name;
      toolTrace.push(label);
      onStatus?.(`正在查看：${label}…`);
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as ToolArgs;
        result = await dispatchTool(call.function.name, args);
      } catch (e) {
        result = JSON.stringify({ error: String(e) });
      }
      history.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
}

// ---------- JSON 提取（Rust extract_json 的 TS 移植） ----------

/**
 * 从 LLM 输出里提取 JSON 对象。
 * 兼容三种情况：裸 JSON、```json 代码块包裹、JSON 前后带散文。失败返回 null。
 */
export function extractJson(text: string): Record<string, unknown> | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t
      .replace(/^```(?:json)?/, "")
      .replace(/```\s*$/, "")
      .trim();
  }
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      /* fallthrough */
    }
    return null;
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(t.slice(start, end + 1));
  return null;
}

// ---------- 持久化封装 ----------

export async function saveReport(env: ReportEnvelope): Promise<void> {
  await invoke("save_ai_report", { envelope: env });
}

export async function loadReport(): Promise<ReportEnvelope | null> {
  const v = await invoke<ReportEnvelope | null>("load_ai_report");
  return v ?? null;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const v = await invoke<HistoryEntry[]>("load_ai_history");
  return Array.isArray(v) ? v : [];
}

/** 追加一条复盘记忆（结论+建议清单），只保留最近 12 条 */
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  const list = await loadHistory();
  list.push(entry);
  await invoke("save_ai_history", { payload: list.slice(-12) });
}

/**
 * 把最近一次复盘记忆拼进 user 消息（注入到摘要之前）。
 * 没有历史时返回空串。
 */
export function buildMemoryBlock(history: HistoryEntry[]): string {
  const last = history[history.length - 1];
  if (!last) return "";
  const advice = (last.建议 ?? [])
    .map((a, i) => `${i + 1}. ${a.行动 ?? ""}（优先级${a.优先级 ?? "中"}）`)
    .filter((s) => s.trim().length > 3)
    .join("\n");
  const oneThing = last.最该做的一件事
    ? `最该做的一件事：${last.最该做的一件事}\n`
    : "";
  return (
    `【上次复盘 · ${last.date} · ${last.skill}】\n` +
    `结论：${last.结论 ?? "（无记录）"}\n` +
    oneThing +
    (advice ? `当时的建议：\n${advice}\n` : "") +
    "请先用本次数据评估这些建议的执行情况（做到/没做到/部分做到），把评估融入诊断或建议，再产出新报告。\n\n"
  );
}
