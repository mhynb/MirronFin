/** 内联 SVG 图标：1.5px 描边、圆角线帽，Phosphor 风格。禁止用 emoji 当图标。 */

interface IconProps {
  size?: number;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export function IconHome({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

export function IconFlow({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M7 4v12" />
      <path d="m3.5 12.5 3.5 3.5 3.5-3.5" />
      <path d="M17 20V8" />
      <path d="m13.5 11.5 3.5-3.5 3.5 3.5" />
    </svg>
  );
}

export function IconPie({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3" />
      <path d="M12 12V3.6A8.4 8.4 0 0 1 20.4 12Z" />
    </svg>
  );
}

export function IconChart({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 3v16a1 1 0 0 0 1 1h17" />
      <path d="m6.5 14.5 4-4.5 3.5 3 4.5-5.5" />
    </svg>
  );
}

export function IconPlus({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 6.5h16" />
      <path d="M9 6.5V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8v1.7" />
      <path d="M6.5 6.5 7.4 20h9.2l.9-13.5" />
      <path d="M10 11v5.5M14 11v5.5" />
    </svg>
  );
}

/** 编辑：铅笔，Phosphor 风格 */
export function IconEdit({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

export function IconChevronRight({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconDownload({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3.5v11" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M4 20.5h16" />
    </svg>
  );
}

export function IconCoin({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M15 9.2c-.6-1-1.7-1.4-3-1.4-1.7 0-3 .8-3 2.2 0 3 6 1.4 6 4.3 0 1.4-1.3 2.2-3 2.2-1.3 0-2.4-.5-3-1.5" />
    </svg>
  );
}

/** AI 理财顾问：四角星光（sparkle），Phosphor 风格 */
export function IconSparkle({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 3l2.2 6.3L20.5 11l-6.3 1.7L12 19l-2.2-6.3L3.5 11l6.3-1.7L12 3z" />
    </svg>
  );
}

/** 退休：旗帜，Phosphor 风格 */
export function IconFlag({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 21V4" />
      <path d="M5 4.5h11.5l-2.2 4 2.2 4H5" />
    </svg>
  );
}

/** 设置：齿轮，Phosphor 风格 */
export function IconGear({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-1.7-1l-.4-2.5h-3.8l-.4 2.5a7.3 7.3 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 1.7 1l.4 2.5h3.8l.4-2.5a7.3 7.3 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
