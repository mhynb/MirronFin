<div align="center">

# MirrorFin

**一款本地优先的个人财务复盘桌面应用 —— 用真实收益率回答"我到底赚没赚"。**

Tauri 2 · React 18 · TypeScript · SQLite · Rust

[![Tauri](https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-dea584?logo=rust)](https://www.rust-lang.org)
[![SQLite](https://img.shields.io/badge/SQLite-local-003b57?logo=sqlite)](https://sqlite.org)

*数据 100% 存在本机 · 不注册 · 不上传 · AI 用你自己的 Key*

</div>

---

## 为什么做这个

记账软件满大街，但它们大多只回答"这个月花了多少"。**真正重要的问题没人帮你算**：

- 我投入的每一笔钱，**时间加权后的真实年化收益**到底是多少？（往账户里加钱会稀释收益，取钱会放大——简单收益率全是假的）
- 我**跑赢沪深 300 了吗**？
- 我的被动收入，离覆盖每月支出（也就是"退休"）还有多远？

MirrorFin 就是为这三个问题做的。

## ✨ 核心特性

### 🧮 真实收益：XIRR 资金加权年化
不用"收益率 = (期末-期初)/期初"这种自欺欺人的算法。每一笔申购、赎回都按**实际现金流时间**折算，给出资金加权 XIRR —— 这才是你真实投资水平的度量。同时与沪深 300 同区间对比，超额一目了然。

### 🏦 余额全派生架构
**账户余额从不存储。** 每个账户的余额 = 期初余额 + Σ流水 + Σ投资交易，实时从明细推导。这从架构上杜绝了"账实不符"——你看到多少钱，就是流水推出来的多少钱。对不上的时候，用「按当前余额校准」一键反推期初。

### 🎨 六档投资风格 + 官方类型校准
持仓自动按 **货币 / 债券固收 / 混合 / 股票指数 / QDII海外 / 商品** 六档分类：
- 同步行情时自动从天天基金官方档案拉取「基金类型」校准（比名称关键词猜测准得多）
- 你手动改过的类型**永不覆盖**
- 首页配置饼图按六档细分，持仓页有投资结构统计

### 🏖️ FIRE 退休进度
被动收入 ≥ 月均支出 = 可退休。退休页提供：
- 进度条 + 25/50/75/100% 里程碑
- 被动收入估算（XIRR × 总资产 ÷ 12）
- 目标本金、资产缺口、"按当前储蓄速度还要几年"
- 亏损时诚实展示负值，不粉饰

### 🤖 AI 复盘顾问（自带 Key，本地直连）
填你自己的 OpenAI 兼容接口（DeepSeek 等），由本地 Rust 进程直接调用：
- **前端确定性体检**：进攻仓占比、防守垫、单标的集中度、活钱覆盖月数、储蓄率——全部本地算好，数值永远可信
- **AI 只做解读**：结构化 JSON 输出（结论/最该做的一件事/体检解读/诊断/风险/建议），提示词强制每条建议引用具体数字，杜绝"注意风险"式空话
- 配置与报告只存本机，不经任何第三方服务器

### 🏠 特殊资产处理
- **公积金**独立为一类资产：算进净资产但不混入可支配现金，每月缴存记一笔"工资账户 → 公积金账户"转账即可
- **期初持仓**：开始记账前已有的基金/股票直接录入，不扣现金、不污染历史

## 🔐 隐私设计

| 设计 | 说明 |
|---|---|
| 数据库 | SQLite 单文件，存于 `~/MirrorFin/`，卸载重装不丢 |
| AI Key | 只保存在本机 `ai_config.json`，由本地 Rust 进程调用接口，不随软件分发 |
| 无账号 / 无云 | 没有注册登录，没有任何网络上报（行情同步只拉公开数据） |
| AI 看不到的 | 逐笔流水、备注等明细不发给 AI，只发聚合指标 |

## 🛠️ 技术栈

- **壳**：Tauri 2（Rust），Windows 桌面 exe
- **前端**：React 18 + TypeScript + Vite + ECharts
- **数据**：SQLite（tauri-plugin-sql），余额派生架构，单语句原子写入
- **AI**：Rust 端 reqwest 流式 SSE，字节缓冲按行解码（中文多字节安全）
- **行情**：天天基金 / 腾讯公开接口，并发池（每批 6 只）+ 单只容错 + 增量检测

## 🚀 本地开发

```bash
git clone https://github.com/mhynb/MirronFin.git
cd MirronFin
npm install
npm run tauri dev
```

### 构建发布版

```bash
npm run build
cargo build --release --features tauri/custom-protocol
```

> ⚠️ **踩坑实录**（都替你踩过了）：
> 1. Release 必须带 `--features tauri/custom-protocol`，否则窗口按 dev 模式连 localhost → 白屏
> 2. `vite.config.ts` 必须 `base: "./"`，Tauri 自定义协议下绝对路径解析不到
> 3. capabilities 里 `sql:default` **不含写权限**，必须显式加 `sql:allow-execute`，否则写入被静默拒绝
> 4. 前端改完必须先 `npm run build` 再 cargo——只跑 cargo 嵌入的是旧 dist

## 📁 目录结构

```
├── src/                    # React 前端
│   ├── pages/              # 首页/收支/持仓/复盘/退休/录入
│   ├── components/         # 图表、AI 报告、校准/编辑弹窗
│   ├── lib/                # db(SQLite) / analytics(XIRR·回撤·体检) / market(行情)
│   └── styles/             # global.css 设计系统
├── src-tauri/
│   ├── src/main.rs         # Rust 后端：SQL 初始化迁移、AI 流式调用、备份
│   ├── advisor_system_prompt.md  # AI 复盘提示词（含_str内联）
│   ├── icons/              # 应用图标
│   └── tauri.conf.json
├── 财务复盘软件-设计决策.md  # 产品与架构设计文档
└── design-system/          # 视觉规范（Apple HIG 极简风格）
```

## ⚠️ 数据源声明

基金净值来自天天基金公开页面，股票行情来自腾讯公开接口，均为**非官方接口**，仅用于个人复盘。应用定位是**日收盘复盘**，不做盘中实时。

## 📄 License

个人开源项目，仅供学习交流。数据源与接口版权归原作者所有，投资决策请自担风险。

---

<div align="center">

**MirrorFin —— 记账只是手段，看清自己才是目的。**

</div>
