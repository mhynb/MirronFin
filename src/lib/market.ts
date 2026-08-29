import { fetch } from "@tauri-apps/plugin-http";
import {
  latestNav,
  listAssets,
  listAssetsForCategorySync,
  listNavSnapshots,
  setAssetCategoryAuto,
  updateAssetName,
  upsertBenchmark,
  upsertNavSnapshots,
} from "./db";
import { guessAssetCategory } from "./db";
import type {
  Asset,
  AssetCategory,
  ClosePoint,
  NavPoint,
} from "./types";

/**
 * 行情数据源（设计文档 §3.4，均为非官方公开接口）：
 * - 基金历史净值：天天基金 f10/lsjz
 * - 基金当日净值/名称：fundgz.1234567.com.cn
 * - 股票/指数日K：腾讯 web.ifzq.gtimg.cn
 * - 股票名称/现价：qt.gtimg.cn
 * 定位是日复盘（日收盘），不做盘中实时。
 */

export const BENCHMARK_CSI300 = "sh000300";

/** 6 位股票代码 → 腾讯格式（6 开头沪市，其余深市；指数直接用 sh000300 这类） */
export function toTencentCode(code: string): string {
  if (/^(sh|sz)/i.test(code)) return code.toLowerCase();
  return code.startsWith("6") ? `sh${code}` : `sz${code}`;
}

// ---------- 基金 ----------

/** 从 pingzhongdata 文本提取净值走势数组 */
function parseNetWorthTrend(text: string): { x: number; y: number }[] {
  const m = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as { x: number; y: number }[];
  } catch {
    return [];
  }
}

/**
 * 基金历史净值（近 400 个交易日）。
 * 数据源：天天基金 pingzhongdata 的 Data_netWorthTrend。
 * （原 f10/lsjz 接口在 Tauri 环境下被反爬拦截返回空数据，已弃用）
 */
export async function fetchFundHistory(code: string): Promise<NavPoint[]> {
  const res = await fetch(
    `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
    { method: "GET" }
  );
  if (!res.ok) throw new Error(`基金历史净值请求失败 HTTP ${res.status}`);
  const text = await res.text();
  return parseNetWorthTrend(text)
    .filter((p) => Number.isFinite(p.y))
    .slice(-400)
    .map((p) => ({ date: msToLocalDate(p.x), nav: p.y }));
}

export interface FundInfo {
  code: string;
  name: string;
  nav: number;
  date: string;
}

/** 毫秒时间戳 → 本地 YYYY-MM-DD（净值日期按本地时区，不用 UTC） */
function msToLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * 基金名称 + 最新净值。
 * 数据源：天天基金 pingzhongdata（fundgz 当日估值接口已失效，返回 404 页）。
 * 返回 JS 变量声明文本，正则提取 fS_name 与 Data_netWorthTrend 尾点。
 */
export async function fetchFundInfo(code: string): Promise<FundInfo | null> {
  const res = await fetch(
    `https://fund.eastmoney.com/pingzhongdata/${code}.js`,
    { method: "GET" }
  );
  if (!res.ok) return null;
  const text = await res.text();
  const nameM = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  if (!nameM || !nameM[1]) return null;
  const arr = parseNetWorthTrend(text);
  const last = arr[arr.length - 1];
  const nav = last && Number.isFinite(last.y) ? last.y : NaN;
  const date = last ? msToLocalDate(last.x) : "";
  return { code, name: nameM[1], nav, date };
}

// ---------- 股票 / 指数 ----------

export async function fetchStockHistory(
  tcode: string
): Promise<ClosePoint[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tcode},day,,,400,qfq`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`股票行情请求失败 HTTP ${res.status}`);
  const json = await res.json();
  const d = json?.data?.[tcode];
  const rows: unknown[] = d?.qfqday ?? d?.day ?? [];
  return rows
    .map((r) => {
      const arr = r as (string | number)[];
      return { date: String(arr[0]), close: parseFloat(String(arr[2])) };
    })
    .filter((r) => r.date && Number.isFinite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface StockInfo {
  name: string;
  price: number;
}

export async function fetchStockInfo(
  tcode: string
): Promise<StockInfo | null> {
  const res = await fetch(`https://qt.gtimg.cn/q=${tcode}`, { method: "GET" });
  if (!res.ok) return null;
  // 腾讯行情接口返回 GBK 编码，直接 text() 按 UTF-8 解会乱码
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const parts = text.split("~");
  if (parts.length < 4 || !parts[1]) return null;
  const price = parseFloat(parts[3]);
  return { name: parts[1], price: Number.isFinite(price) ? price : NaN };
}

// ---------- 同步落库 ----------

/** 官方"基金类型" → 六档映射规则（顺序即优先级） */
const OFFICIAL_CATEGORY_RULES: [RegExp, AssetCategory][] = [
  [/货币/, "money"],
  [/债券/, "bond"],
  [/商品/, "commodity"],
  [/QDII/i, "qdii"],
  [/FOF/, "mixed"],
  [/股票|指数/, "stock"],
  [/混合/, "mixed"],
];

/** 官方类型字符串 → 六档；未命中时按名称兜底猜 */
export function mapOfficialCategory(
  official: string,
  name: string
): AssetCategory {
  for (const [re, cat] of OFFICIAL_CATEGORY_RULES) {
    if (re.test(official)) return cat;
  }
  return guessAssetCategory(name, "fund");
}

/**
 * 天天基金 f10 基本概况页 → 官方"基金类型"字段 → 六档。
 * 例：013580 → "债券型-混合一级" → bond。
 * 失败返回 null（调用方跳过，不阻塞同步）。
 */
export async function fetchFundCategory(
  code: string,
  name: string
): Promise<AssetCategory | null> {
  try {
    const res = await fetch(
      `https://fundf10.eastmoney.com/jbgk_${code}.html`,
      { method: "GET" }
    );
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/基金类型<\/th>\s*<td[^>]*>([^<]+)</);
    const off = m?.[1]?.trim();
    if (!off) return null;
    return mapOfficialCategory(off, name);
  } catch {
    return null;
  }
}

/** 同步单个标的的净值快照（增量：已入库的也 upsert 覆盖，代价很小） */
export async function syncAssetSnapshots(asset: Asset): Promise<number> {
  if (asset.type === "fund") {
    const rows = await fetchFundHistory(asset.code);
    await upsertNavSnapshots(asset.id, rows);
    return rows.length;
  }
  const rows = await fetchStockHistory(toTencentCode(asset.code));
  await upsertNavSnapshots(
    asset.id,
    rows.map((r) => ({ date: r.date, nav: r.close }))
  );
  return rows.length;
}

export async function syncBenchmark(): Promise<number> {
  const rows = await fetchStockHistory(BENCHMARK_CSI300);
  await upsertBenchmark(BENCHMARK_CSI300, rows);
  return rows.length;
}

export interface SyncResult {
  ok: boolean;
  message: string;
}

/** 并发池：最多 size 个任务同时跑，结果按原顺序返回 */
async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * 启动时增量同步：任一标的数据不是今天的就全量刷一遍快照 + 基准。
 * 并发拉取（每批 6 只），单只失败不阻断其他。名称缺失时顺手补全。
 * onProgress 回调用于 UI 进度展示。网络失败不阻塞使用，返回提示信息。
 */
export async function syncAllMarketData(
  onProgress?: (done: number, total: number) => void
): Promise<SyncResult> {
  try {
    const assets = await listAssets();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(
      today.getMonth() + 1
    ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // 增量检测：并行查所有标的最新净值
    const lasts = await Promise.all(assets.map((a) => latestNav(a.id)));
    const needSync = assets.some(
      (_, i) => !lasts[i] || lasts[i]!.date < todayStr
    );
    // 需要官方类型校准的基金（未被手动改过 category 的）
    let calibratable = new Set<number>();
    try {
      calibratable = new Set(
        (await listAssetsForCategorySync()).map((x) => x.id)
      );
    } catch {
      /* 查询失败就跳过校准 */
    }
    const hasUnnamed = assets.some((a) => a.name === a.code);
    if (!needSync && !hasUnnamed && calibratable.size === 0)
      return { ok: true, message: "行情已是最新" };

    let okCount = 0;
    let done = 0;
    const failed: string[] = [];
    const total = assets.length;

    // 基准和标的并行，互不阻塞
    const benchmarkP = syncBenchmark().catch(() => {
      /* 基准失败不阻塞 */
    });
    await mapPool(assets, 6, async (a) => {
      try {
        await syncAssetSnapshots(a);
        // 名称缺失（等于代码）时顺手补全
        if (a.name === a.code) {
          const info =
            a.type === "fund"
              ? await fetchFundInfo(a.code)
              : await fetchStockInfo(toTencentCode(a.code));
          if (info && info.name) await updateAssetName(a.id, info.name);
        }
        // 官方类型校准：从 f10 基金档案拉"基金类型"，比名称关键词准
        if (a.type === "fund" && calibratable.has(a.id)) {
          const cat = await fetchFundCategory(a.code, a.name);
          if (cat) await setAssetCategoryAuto(a.id, cat);
        }
        okCount++;
      } catch {
        failed.push(a.code);
      } finally {
        done++;
        onProgress?.(done, total);
      }
    });
    await benchmarkP;

    if (failed.length > 0) {
      return {
        ok: false,
        message: `已同步 ${okCount} 只，${failed.length} 只失败：${failed.join("、")}`,
      };
    }
    return { ok: true, message: "行情同步完成" };
  } catch (e) {
    return { ok: false, message: `行情同步失败：${String(e)}` };
  }
}

/** 某标的某日的净值：先查快照，缺了则在线拉历史再找，最后兜底用最近一个净值 */
export async function navOnDate(
  asset: Asset,
  date: string
): Promise<number | null> {
  const local = await listNavSnapshots(asset.id);
  const hit = local.find((p) => p.date === date);
  if (hit) return hit.nav;
  try {
    await syncAssetSnapshots(asset);
    const fresh = await listNavSnapshots(asset.id);
    const exact = fresh.find((p) => p.date === date);
    if (exact) return exact.nav;
    const before = fresh.filter((p) => p.date <= date).pop();
    return before?.nav ?? fresh[fresh.length - 1]?.nav ?? null;
  } catch {
    const before = local.filter((p) => p.date <= date).pop();
    return before?.nav ?? local[local.length - 1]?.nav ?? null;
  }
}
