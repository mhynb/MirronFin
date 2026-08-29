import * as echarts from "echarts";

/** Apple 系统色分类色板 */
export const PALETTE = [
  "#007AFF",
  "#5AC8FA",
  "#34C759",
  "#FF9500",
  "#FF2D55",
  "#AF52DE",
  "#FFCC00",
  "#8E8E93",
];

export const RISE = "#E13C39"; // 涨/收入：红
export const FALL = "#18A058"; // 跌/负收益：绿

const FONT =
  '-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';

echarts.registerTheme("mirrorfin", {
  color: PALETTE,
  textStyle: { fontFamily: FONT },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#E5E5EA" } },
    axisTick: { show: false },
    axisLabel: { color: "#6E6E73", fontSize: 12, fontFamily: FONT },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: "#6E6E73", fontSize: 12, fontFamily: FONT },
    splitLine: { lineStyle: { color: "#E5E5EA", type: "dashed" } },
  },
  legend: {
    textStyle: { color: "#6E6E73", fontSize: 12, fontFamily: FONT },
    itemWidth: 12,
    itemHeight: 8,
    icon: "roundRect",
  },
  tooltip: {
    backgroundColor: "#FFFFFF",
    borderWidth: 0,
    textStyle: { color: "#1D1D1F", fontSize: 12, fontFamily: FONT },
    extraCssText:
      "box-shadow: 0 8px 28px rgba(0,0,0,0.12); border-radius: 8px; padding: 10px 12px;",
  },
});
