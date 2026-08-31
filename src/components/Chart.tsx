import ReactECharts from "echarts-for-react";
import "../lib/echarts-theme";

/** ECharts 事件回调参数（只声明用到的字段，其余透传） */
export interface ChartEventParams {
  name: string;
  dataIndex: number;
  value: number;
}

interface ChartProps {
  option: Record<string, unknown>;
  height?: number;
  /** 事件名 -> 回调，如 { click: (p) => ... }；用于图表点选联动筛选 */
  onEvents?: Record<string, (params: ChartEventParams) => void>;
}

export default function Chart({ option, height = 280, onEvents }: ChartProps) {
  return (
    <ReactECharts
      option={option}
      theme="mirrorfin"
      style={{ height, width: "100%" }}
      notMerge
      lazyUpdate
      onEvents={onEvents}
    />
  );
}
