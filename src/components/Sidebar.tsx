import { NavLink } from "react-router-dom";
import {
  IconChart,
  IconFlag,
  IconFlow,
  IconHome,
  IconPie,
  IconPlus,
} from "./Icons";

const NAV_ITEMS = [
  { to: "/dashboard", label: "首页", Icon: IconHome },
  { to: "/transactions", label: "收支", Icon: IconFlow },
  { to: "/holdings", label: "持仓", Icon: IconPie },
  { to: "/review", label: "复盘", Icon: IconChart },
  { to: "/retirement", label: "退休", Icon: IconFlag },
  { to: "/entry", label: "录入", Icon: IconPlus },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">MirrorFin</div>
        <div className="brand-sub">财务复盘</div>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              isActive ? "nav-item active" : "nav-item"
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">v0.1 · 阶段 1+2</div>
    </aside>
  );
}
