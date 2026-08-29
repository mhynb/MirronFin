export type TxnType = "income" | "expense" | "transfer";
export type CategoryType = "income" | "expense";

export interface Account {
  id: number;
  name: string;
  type: string; // wechat / alipay / bank / housing_fund
  balance: number;
  /** 期初余额：开始记账那一刻账户里的实际金额（不算收入，可校准） */
  opening_balance: number;
}

export interface Category {
  id: number;
  name: string;
  type: CategoryType;
  parent_id: number | null;
}

export interface Transaction {
  id: number;
  date: string; // YYYY-MM-DD
  account_id: number;
  category_id: number | null;
  amount: number; // 恒为正数，方向由 type 决定
  type: TxnType;
  to_account_id: number | null; // 转账目标账户
  note: string;
  // join 出来的展示字段
  account_name?: string;
  category_name?: string;
  to_account_name?: string;
}

export interface MonthSummary {
  income: number;
  expense: number;
}

export interface CategoryValue {
  name: string;
  value: number;
}

export interface MonthPoint {
  month: string; // YYYY-MM
  income: number;
  expense: number;
}

// ---------- 投资 ----------

export type AssetType = "fund" | "stock";

/** 投资风格六档（复盘用）：货币 / 债券固收 / 混合 / 股票指数 / QDII海外 / 商品 */
export type AssetCategory =
  | "money"
  | "bond"
  | "mixed"
  | "stock"
  | "qdii"
  | "commodity";

export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  money: "货币",
  bond: "债券固收",
  mixed: "混合",
  stock: "股票指数",
  qdii: "QDII海外",
  commodity: "商品",
};

/** 六档类型色（与现金#8E8E93/公积金#34C759 区分） */
export const ASSET_CATEGORY_COLOR: Record<AssetCategory, string> = {
  money: "#26A69A",
  bond: "#42A5F5",
  mixed: "#8D6E63",
  stock: "#FF7043",
  qdii: "#AB47BC",
  commodity: "#FFD54F",
};

/** 配置体检项（前端确定性计算，AI 只做解读） */
export type CheckStatus = "达标" | "偏高" | "偏低";
export interface CheckItem {
  项目: string;
  状态: CheckStatus;
  当前值: string;
  参考区间: string;
  说明: string;
}

export interface Asset {
  id: number;
  code: string;
  name: string;
  type: AssetType;
  category: AssetCategory; // 投资风格（名称自动猜，可手动改）
  last_used: number; // unix 秒，常用标的排序用
}

/** buy=申购 sell=赎回 dividend=红利再投 */
export type InvestTxnType = "buy" | "sell" | "dividend";

export interface InvestmentTxn {
  id: number;
  asset_id: number;
  date: string;
  type: InvestTxnType;
  amount: number; // 金额：申购=投入 / 赎回=收回 / 红利再投=按净值折算的分红额
  shares: number; // 份额（红利再投=分到的份额）
  price: number; // 成交单价 / 基金净值
  account_id: number | null; // 现金账户；红利再投为 null
  // join 展示字段
  asset_name?: string;
  asset_code?: string;
  asset_type?: AssetType;
  account_name?: string;
}

export interface NavPoint {
  date: string;
  nav: number;
}

export interface ClosePoint {
  date: string;
  close: number;
}
