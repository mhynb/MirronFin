import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type {
  Account,
  Asset,
  AssetCategory,
  AssetType,
  Category,
  CategoryType,
  CategoryValue,
  ClosePoint,
  InvestmentTxn,
  InvestTxnType,
  MonthPoint,
  MonthSummary,
  NavPoint,
  Transaction,
  TxnType,
} from "./types";

let dbPromise: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

async function init(): Promise<Database> {
  const dbFile = await invoke<string>("ensure_db_dir");
  const db = await Database.load(`sqlite:${dbFile}`);
  await migrate(db);
  await seed(db);
  return db;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- 建表（数据模型见设计文档 §六） ----------

async function migrate(db: Database): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS accounts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS categories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_id INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS transactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      category_id INTEGER REFERENCES categories(id),
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      to_account_id INTEGER REFERENCES accounts(id),
      note TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS assets(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      last_used INTEGER NOT NULL DEFAULT 0,
      UNIQUE(code, type)
    )`,
    `CREATE TABLE IF NOT EXISTS investment_transactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      shares REAL NOT NULL,
      price REAL NOT NULL,
      account_id INTEGER REFERENCES accounts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS nav_snapshots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      UNIQUE(asset_id, date)
    )`,
    `CREATE TABLE IF NOT EXISTS benchmarks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      UNIQUE(code, date)
    )`,
    `CREATE TABLE IF NOT EXISTS meta(
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_inv_asset ON investment_transactions(asset_id, date)`,
    `CREATE INDEX IF NOT EXISTS idx_nav_asset ON nav_snapshots(asset_id, date)`,
  ];
  for (const sql of stmts) await db.execute(sql);

  // 轻量迁移：accounts 补 opening_balance 列（期初余额，已存在的库需要 ALTER）
  const cols = await db.select<{ name: string }[]>(
    "PRAGMA table_info(accounts)"
  );
  if (!cols.some((c) => c.name === "opening_balance")) {
    await db.execute(
      "ALTER TABLE accounts ADD COLUMN opening_balance REAL NOT NULL DEFAULT 0"
    );
  }

  // 一次性迁移：旧默认账户（现金/银行卡）升级为微信/支付宝/银行卡。
  // 仅在库仍是出厂状态（无任何流水）时执行，已产生的数据绝不动。
  const accs = await db.select<{ id: number; name: string }[]>(
    "SELECT id, name FROM accounts ORDER BY id"
  );
  const txnCount = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM transactions"
  );
  const invCount = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM investment_transactions"
  );
  const isOldDefault =
    accs.length === 2 && accs[0].name === "现金" && accs[1].name === "银行卡";
  if (isOldDefault && txnCount[0].c === 0 && invCount[0].c === 0) {
    await db.execute(
      "UPDATE accounts SET name = '微信', type = 'wechat' WHERE id = $1",
      [accs[0].id]
    );
    await db.execute(
      "INSERT INTO accounts(name, type) VALUES ('支付宝', 'alipay')"
    );
    // 原"银行卡"行保持不变
  }

  // 一次性迁移：确保存在公积金账户（老库没有则补一个，opening_balance=0，余额由用户在设置期初里填）
  const hasFund = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM accounts WHERE type = 'housing_fund'"
  );
  if (hasFund[0].c === 0) {
    await db.execute(
      "INSERT INTO accounts(name, type, opening_balance) VALUES ('公积金', 'housing_fund', 0)"
    );
  }

  // 轻量迁移：assets 补 category 列（投资风格六档），老数据按名称关键词自动猜
  const assetCols = await db.select<{ name: string }[]>(
    "PRAGMA table_info(assets)"
  );
  if (!assetCols.some((c) => c.name === "category")) {
    await db.execute(
      "ALTER TABLE assets ADD COLUMN category TEXT NOT NULL DEFAULT ''"
    );
    const all = await db.select<{ id: number; name: string; type: string }[]>(
      "SELECT id, name, type FROM assets"
    );
    for (const a of all) {
      await db.execute("UPDATE assets SET category = $1 WHERE id = $2", [
        guessAssetCategory(a.name, a.type),
        a.id,
      ]);
    }
  }
  // 轻量迁移：assets 补 category_manual 列（1=用户手动改过，官方校准不再覆盖）
  if (!assetCols.some((c) => c.name === "category_manual")) {
    await db.execute(
      "ALTER TABLE assets ADD COLUMN category_manual INTEGER NOT NULL DEFAULT 0"
    );
  }
}

// ---------- 种子数据 ----------

/** 默认活钱账户：微信/支付宝/银行卡（现金类，净资产中合并统计） */
const DEFAULT_ACCOUNTS: [string, string][] = [
  ["微信", "wechat"],
  ["支付宝", "alipay"],
  ["银行卡", "bank"],
];

const DEFAULT_EXPENSE_CATS = [
  "餐饮",
  "交通",
  "住房",
  "日用",
  "购物",
  "娱乐",
  "医疗",
  "人情",
  "其他支出",
];

const DEFAULT_INCOME_CATS = ["工资", "奖金", "理财收益", "其他收入"];

async function seed(db: Database): Promise<void> {
  const acc = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM accounts"
  );
  if (acc[0].c === 0) {
    for (const [name, type] of DEFAULT_ACCOUNTS) {
      await db.execute("INSERT INTO accounts(name, type) VALUES ($1, $2)", [
        name,
        type,
      ]);
    }
  }
  const cat = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM categories"
  );
  if (cat[0].c === 0) {
    for (const name of DEFAULT_EXPENSE_CATS) {
      await db.execute(
        "INSERT INTO categories(name, type) VALUES ($1, 'expense')",
        [name]
      );
    }
    for (const name of DEFAULT_INCOME_CATS) {
      await db.execute(
        "INSERT INTO categories(name, type) VALUES ($1, 'income')",
        [name]
      );
    }
  }
}

// ---------- 账户 / 分类 ----------

/**
 * 现金账户余额 = 期初余额 + 流水实时推导：
 * 收入 + / 支出 - / 转账出 - / 转账入 + / 申购 - / 赎回 +。
 * 派生而非存储，余额永远不会与流水脱节（写入全是单语句，天然原子）。
 * 期初余额单独存储：开始记账时账户的实际金额，不算收入、不污染收支统计。
 */
export async function listAccounts(): Promise<Account[]> {
  const db = await getDb();
  return db.select<Account[]>(
    `SELECT a.id, a.name, a.type, a.opening_balance,
            a.opening_balance + COALESCE(s1.v, 0) + COALESCE(s2.v, 0) + COALESCE(s3.v, 0) AS balance
     FROM accounts a
     LEFT JOIN (
       SELECT account_id,
              SUM(CASE type WHEN 'income' THEN amount ELSE -amount END) AS v
       FROM transactions GROUP BY account_id
     ) s1 ON s1.account_id = a.id
     LEFT JOIN (
       SELECT to_account_id, SUM(amount) AS v
       FROM transactions WHERE type = 'transfer' GROUP BY to_account_id
     ) s2 ON s2.to_account_id = a.id
     LEFT JOIN (
       SELECT account_id,
              SUM(CASE type WHEN 'buy' THEN -amount WHEN 'sell' THEN amount ELSE 0 END) AS v
       FROM investment_transactions WHERE account_id IS NOT NULL GROUP BY account_id
     ) s3 ON s3.account_id = a.id
     ORDER BY a.id`
  );
}

/** 设置某账户的期初余额（开始记账时的实际金额） */
export async function setOpeningBalance(
  accountId: number,
  amount: number
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE accounts SET opening_balance = $1 WHERE id = $2", [
    round2(amount),
    accountId,
  ]);
}

/** 全部账户期初余额之和（复盘页现金序列的起点） */
export async function totalOpeningBalance(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ v: number | null }[]>(
    "SELECT SUM(opening_balance) AS v FROM accounts"
  );
  return rows[0].v ?? 0;
}

export async function listCategories(
  type?: CategoryType
): Promise<Category[]> {
  const db = await getDb();
  if (type) {
    return db.select<Category[]>(
      "SELECT id, name, type, parent_id FROM categories WHERE type = $1 ORDER BY id",
      [type]
    );
  }
  return db.select<Category[]>(
    "SELECT id, name, type, parent_id FROM categories ORDER BY type, id"
  );
}

// ---------- 日常流水 ----------

export interface NewTxn {
  date: string;
  account_id: number;
  category_id: number | null;
  amount: number;
  type: TxnType;
  to_account_id?: number | null;
  note: string;
}

/** 单条 INSERT 即原子；余额由流水派生，无需冗余更新 */
export async function addTransaction(t: NewTxn): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO transactions(date, account_id, category_id, amount, type, to_account_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      t.date,
      t.account_id,
      t.category_id,
      round2(t.amount),
      t.type,
      t.to_account_id,
      t.note,
    ]
  );
}

export async function deleteTransaction(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM transactions WHERE id = $1", [id]);
}

/** 单条 UPDATE；余额仍由流水派生，无需冗余更新 */
export async function updateTransaction(id: number, t: NewTxn): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE transactions
     SET date=$1, account_id=$2, category_id=$3, amount=$4, type=$5, to_account_id=$6, note=$7
     WHERE id=$8`,
    [
      t.date,
      t.account_id,
      t.category_id,
      round2(t.amount),
      t.type,
      t.to_account_id,
      t.note,
      id,
    ]
  );
}

export interface TxnFilter {
  month?: string; // YYYY-MM
  type?: TxnType | "all";
  /** "unclassified" = 只看 category_id 为空的流水 */
  categoryId?: number | "all" | "unclassified";
}

export async function listTransactions(
  filter: TxnFilter = {}
): Promise<Transaction[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.month) {
    where.push("substr(t.date, 1, 7) = $" + (params.length + 1));
    params.push(filter.month);
  }
  if (filter.type && filter.type !== "all") {
    where.push("t.type = $" + (params.length + 1));
    params.push(filter.type);
  }
  if (filter.categoryId && filter.categoryId !== "all") {
    if (filter.categoryId === "unclassified") {
      where.push("t.category_id IS NULL");
    } else {
      where.push("t.category_id = $" + (params.length + 1));
      params.push(filter.categoryId);
    }
  }
  const sql = `
    SELECT t.*, a.name AS account_name, c.name AS category_name,
           ta.name AS to_account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY t.date DESC, t.id DESC`;
  return db.select<Transaction[]>(sql, params);
}

export async function recentTransactions(limit = 8): Promise<Transaction[]> {
  const db = await getDb();
  return db.select<Transaction[]>(
    `SELECT t.*, a.name AS account_name, c.name AS category_name,
            ta.name AS to_account_name
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts ta ON ta.id = t.to_account_id
     ORDER BY t.date DESC, t.id DESC LIMIT $1`,
    [limit]
  );
}

// ---------- 收支统计 ----------

/** 月收支汇总（转账不算收入也不算支出——设计文档 §3.1） */
export async function monthSummary(month: string): Promise<MonthSummary> {
  const db = await getDb();
  const rows = await db.select<MonthSummary[]>(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
     FROM transactions
     WHERE substr(date, 1, 7) = $1`,
    [month]
  );
  return rows[0];
}

/** 近 N 个月按月收支汇总（只返回有流水的月份）。用于退休页算月均支出/储蓄。 */
export async function recentMonthSums(
  months: number
): Promise<{ month: string; income: number; expense: number }[]> {
  const db = await getDb();
  const d = new Date();
  d.setMonth(d.getMonth() - (months - 1));
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return db.select(
    `SELECT substr(date, 1, 7) AS month,
       COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
     FROM transactions
     WHERE substr(date, 1, 7) >= $1
     GROUP BY substr(date, 1, 7)
     ORDER BY month`,
    [from]
  );
}

/**
 * 支出分类占比。
 * scope='consume' 纯消费（默认）；scope='all' 全口径（含投资/转账）。
 */
export async function categoryBreakdown(
  month: string,
  scope: "consume" | "all" = "consume"
): Promise<CategoryValue[]> {
  const db = await getDb();
  const rows = await db.select<CategoryValue[]>(
    `SELECT t.category_id AS id, COALESCE(c.name, '未分类') AS name,
            SUM(t.amount) AS value, COUNT(*) AS count
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.type = 'expense' AND substr(t.date, 1, 7) = $1
     GROUP BY t.category_id
     ORDER BY value DESC`,
    [month]
  );
  if (scope === "all") {
    const inv = await db.select<{ v: number | null; c: number }[]>(
      `SELECT SUM(amount) AS v, COUNT(*) AS c FROM investment_transactions
       WHERE type = 'buy' AND substr(date, 1, 7) = $1`,
      [month]
    );
    const tr = await db.select<{ v: number | null; c: number }[]>(
      `SELECT SUM(amount) AS v, COUNT(*) AS c FROM transactions
       WHERE type = 'transfer' AND substr(date, 1, 7) = $1`,
      [month]
    );
    const extra = (inv[0].v ?? 0) + (tr[0].v ?? 0);
    if (extra > 0) {
      rows.push({
        id: null,
        name: "投资/转账",
        value: extra,
        count: (inv[0].c ?? 0) + (tr[0].c ?? 0),
      });
    }
  }
  return rows;
}

/** 近 N 个月收支序列（含本月，按时间升序） */
export async function monthlySeries(n: number): Promise<MonthPoint[]> {
  const db = await getDb();
  const rows = await db.select<MonthPoint[]>(
    `SELECT substr(date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
     FROM transactions
     GROUP BY month
     ORDER BY month DESC
     LIMIT $1`,
    [n]
  );
  return rows.reverse();
}

// ---------- 投资：标的 ----------

/** 按名称关键词猜投资风格（六档）。顺序即优先级；主动基金兜底 mixed，可手动改。 */
export function guessAssetCategory(
  name: string,
  type: string
): AssetCategory {
  if (type === "stock") return "stock";
  const n = name;
  if (/债券|纯债|固收|存单|同业/.test(n)) return "bond";
  if (/货币/.test(n)) return "money";
  if (/黄金|上海金|原油|豆粕|商品/.test(n)) return "commodity";
  if (/纳斯达克|标普|QDII|美国|香港|海外|全球|德国|印度|日本/.test(n))
    return "qdii";
  if (/ETF联接|指数|股票|芯片|半导体|白酒|新能源|医疗|军工|银行|证券/.test(n))
    return "stock";
  return "mixed";
}

/** 手动改投资风格（记录 manual 标记，官方校准不再覆盖） */
export async function updateAssetCategory(
  id: number,
  category: AssetCategory
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE assets SET category = $1, category_manual = 1 WHERE id = $2",
    [category, id]
  );
}

/** 行情同步时的官方类型校准（不动手动标记） */
export async function setAssetCategoryAuto(
  id: number,
  category: AssetCategory
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE assets SET category = $1 WHERE id = $2", [
    category,
    id,
  ]);
}

/** 需要官方类型校准的基金（未被手动改过的） */
export async function listAssetsForCategorySync(): Promise<
  { id: number; code: string; name: string }[]
> {
  const db = await getDb();
  return db.select(
    "SELECT id, code, name FROM assets WHERE type = 'fund' AND category_manual = 0"
  );
}

export async function listAssets(): Promise<Asset[]> {
  const db = await getDb();
  return db.select<Asset[]>(
    "SELECT id, code, name, type, category, last_used FROM assets ORDER BY last_used DESC, id DESC"
  );
}

/** 更新标的名称（行情同步时补全缺失名称用） */
export async function updateAssetName(id: number, name: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE assets SET name = $1 WHERE id = $2", [name, id]);
}

export async function getOrCreateAsset(
  code: string,
  name: string,
  type: AssetType
): Promise<number> {
  const db = await getDb();
  const found = await db.select<{ id: number }[]>(
    "SELECT id FROM assets WHERE code = $1 AND type = $2",
    [code, type]
  );
  if (found.length > 0) {
    await db.execute(
      "UPDATE assets SET name = $1, last_used = $2 WHERE id = $3",
      [name, Math.floor(Date.now() / 1000), found[0].id]
    );
    return found[0].id;
  }
  const r = await db.execute(
    "INSERT INTO assets(code, name, type, category, last_used) VALUES ($1, $2, $3, $4, $5)",
    [code, name, type, guessAssetCategory(name, type), Math.floor(Date.now() / 1000)]
  );
  return r.lastInsertId as number;
}

// ---------- 投资：交易 ----------

export interface NewInvestTxn {
  asset_id: number;
  date: string;
  type: InvestTxnType;
  amount: number;
  shares: number;
  price: number;
  account_id: number | null;
}

export async function addInvestmentTxn(t: NewInvestTxn): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO investment_transactions(asset_id, date, type, amount, shares, price, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      t.asset_id,
      t.date,
      t.type,
      round2(t.amount),
      t.shares,
      t.price,
      t.account_id,
    ]
  );
}

export async function deleteInvestmentTxn(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM investment_transactions WHERE id = $1", [id]);
}

export async function listInvestmentTxns(
  assetId?: number
): Promise<InvestmentTxn[]> {
  const db = await getDb();
  const base = `
    SELECT it.*, a.name AS asset_name, a.code AS asset_code, a.type AS asset_type,
           acc.name AS account_name
    FROM investment_transactions it
    JOIN assets a ON a.id = it.asset_id
    LEFT JOIN accounts acc ON acc.id = it.account_id`;
  if (assetId !== undefined) {
    return db.select<InvestmentTxn[]>(
      `${base} WHERE it.asset_id = $1 ORDER BY it.date ASC, it.id ASC`,
      [assetId]
    );
  }
  return db.select<InvestmentTxn[]>(
    `${base} ORDER BY it.date ASC, it.id ASC`
  );
}

// ---------- 行情快照 ----------

export async function upsertNavSnapshots(
  assetId: number,
  rows: NavPoint[]
): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO nav_snapshots(asset_id, date, nav) VALUES ($1, $2, $3)
       ON CONFLICT(asset_id, date) DO UPDATE SET nav = excluded.nav`,
      [assetId, r.date, r.nav]
    );
  }
}

export async function listNavSnapshots(
  assetId: number
): Promise<NavPoint[]> {
  const db = await getDb();
  return db.select<NavPoint[]>(
    "SELECT date, nav FROM nav_snapshots WHERE asset_id = $1 ORDER BY date ASC",
    [assetId]
  );
}

export async function latestNav(
  assetId: number
): Promise<NavPoint | null> {
  const db = await getDb();
  const rows = await db.select<NavPoint[]>(
    "SELECT date, nav FROM nav_snapshots WHERE asset_id = $1 ORDER BY date DESC LIMIT 1",
    [assetId]
  );
  return rows[0] ?? null;
}

export async function upsertBenchmark(
  code: string,
  rows: ClosePoint[]
): Promise<void> {
  const db = await getDb();
  for (const r of rows) {
    await db.execute(
      `INSERT INTO benchmarks(code, date, close) VALUES ($1, $2, $3)
       ON CONFLICT(code, date) DO UPDATE SET close = excluded.close`,
      [code, r.date, r.close]
    );
  }
}

export async function listBenchmark(code: string): Promise<ClosePoint[]> {
  const db = await getDb();
  return db.select<ClosePoint[]>(
    "SELECT date, close FROM benchmarks WHERE code = $1 ORDER BY date ASC",
    [code]
  );
}

// ---------- 键值（备份时间等） ----------

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM meta WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO meta(key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}
