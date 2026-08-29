import ReactECharts from "echarts-for-react";
import "../lib/echarts-theme";

interface ChartProps {
  option: Record<string, unknown>;
  height?: number;
}

export default function Chart({ option, height = 280 }: ChartProps) {
  return (
    <ReactECharts
      option={option}
      theme="mirrorfin"
      style={{ height, width: "100%" }}
      notMerge
      lazyUpdate
    />
  );
}
