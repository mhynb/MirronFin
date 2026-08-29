# MirrorFin 设计系统 · MASTER

> **本文件是视觉宪法**，依据《财务复盘软件-设计决策.md》§5.1「Apple 风极简」人工校准。
> 页面级覆盖规则放在 `design-system/mirrorfin/pages/[page].md`，存在则优先于本文件。
> ⚠️ 数据库工具自动生成的暗色 OLED 方案已被否决，勿回退。

**Product:** MirrorFin 财务复盘（Windows 桌面 / Tauri）
**Style:** Apple Human Interface 极简 · 浅色优先 · 信息密度克制

---

## 1. 色彩

| 角色 | Hex | CSS 变量 | 说明 |
|---|---|---|---|
| 主文字 | `#1D1D1F` | `--text-primary` | Apple 标志性近黑 |
| 次文字 | `#6E6E73` | `--text-secondary` | 说明、辅助信息 |
| 三级文字 | `#AEAEB2` | `--text-tertiary` | 占位、弱化 |
| 页面背景 | `#F5F5F7` | `--bg-page` | Apple 灰 |
| 卡片/表面 | `#FFFFFF` | `--bg-surface` | 纯白卡片浮在灰底上 |
| 品牌主色 | `#007AFF` | `--accent` | Apple 蓝，用于主按钮、选中态、链接 |
| 涨/收入/正收益 | `#E13C39` | `--rise` | **中国股市约定：红涨** |
| 跌/负收益 | `#18A058` | `--fall` | **绿跌** |
| 边框/分隔线 | `#E5E5EA` | `--border` | 极浅，靠留白分组而非线条 |
| 危险操作 | `#FF3B30` | `--danger` | 删除等 |
| 导航侧栏底 | `rgba(245,245,247,0.8)` | `--bg-sidebar` | 毛玻璃感 |

**铁律：涨红跌绿（中国约定），与美国相反。金额色彩语义：收入=红，负收益=绿，日常支出金额用主文字色（支出不是"跌"，不染色）。**

图表分类色板（Apple 系统色）：`#007AFF #5AC8FA #34C759 #FF9500 #FF2D55 #AF52DE #FFCC00 #8E8E93`

## 2. 字体

```css
font-family: -apple-system, "SF Pro Display", "SF Pro Text", "PingFang SC",
             "Microsoft YaHei", "Segoe UI", sans-serif;
```
- 不加载任何网络字体，纯系统字体栈（SF Pro 在 macOS、苹方在 iOS、雅黑在 Windows 各自生效）
- 数字：`font-variant-numeric: tabular-nums;`（报表对齐的灵魂）
- 大金额数字：34px / 600；页面标题：28px / 700；卡片标题：13px / 500 次文字；正文：14px / 400

## 3. 形状与空间

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 8px | 输入框、小按钮 |
| `--radius-md` | 12px | 卡片 |
| `--radius-lg` | 16px | 弹层、大容器 |
| `--shadow-card` | `0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.04)` | 卡片，轻到几乎看不见 |
| `--shadow-pop` | `0 8px 28px rgba(0,0,0,0.12)` | 浮层 |
| 间距节奏 | 4 / 8 / 12 / 16 / 24 / 32 | 严格 4 的倍数 |

- 桌面窗口内容最大宽度 1080px，左右留白 ≥32px
- 分组靠留白（24-32px），不靠分割线；必须用线时用 `--border` 1px

## 4. 组件基调

- **按钮**：主按钮 = `--accent` 实底白字、radius 8、高 36px；次按钮 = 白底 `--border` 边框；hover 只变透明度/底色（0.15s ease），**禁止位移/缩放**
- **输入框**：白底、1px `--border`、radius 8、高 36px；focus = 边框变 `--accent` + 3px `#007AFF26` 外环
- **卡片**：白底、radius 12、`--shadow-card`、padding 20px；非可点卡片无 hover 态
- **分段控件（如 支出/收入/转账）**：`#E9E9EB` 底、白色滑块带微阴影——Apple 标志性控件
- **导航**：左侧栏 220px，macOS 风；选中项 = `#007AFF1A` 圆角底 + `--accent` 图标文字
- **图标**：内联 SVG，1.5px 描边、圆角线帽，Phosphor 风格；**禁止 emoji 当图标**

## 5. 动效

- 微交互 150–250ms，`cubic-bezier(0.25, 0.1, 0.25, 1)`（ease-out 家族）
- 页面切换/数字变化允许轻量 fade/slide；禁止弹性 overshoot、禁止 >400ms 动画
- `prefers-reduced-motion` 时全部动画降级为瞬时

## 6. 图表（ECharts Apple 主题）

- 坐标轴线 `#E5E5EA`，刻度标签 `#6E6E73` 12px，网格只留横向虚线
- tooltip：白底、`--shadow-pop`、radius 8、无边框
- 折线 2px 宽、平滑、面积渐变透明度 0.12→0；对比基准线（沪深300）用 `#8E8E93` 细线
- 涨红跌绿同上；图例文字 12px 次文字色

## 7. 反模式（禁止）

- ❌ 暗色主题（宪法未定，二期再议）
- ❌ 高饱和渐变背景、毛玻璃滥用、重投影
- ❌ emoji 充当功能图标
- ❌ 信息密度堆叠——留白是 Apple 风的本体
- ❌ 美国式绿涨红跌

## 8. 交付前检查

- [ ] 金额数字 tabular-nums 且千分位
- [ ] 可点元素 cursor:pointer + hover 反馈 ≤250ms
- [ ] 文字对比度 ≥4.5:1（`#6E6E73` 白底为 4.6:1，达标；更浅的 `#AEAEB2` 仅用于非关键信息）
- [ ] 窗口缩到 960×640 不横向滚动
