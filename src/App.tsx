import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import DashboardPage from "./pages/DashboardPage";
import TransactionsPage from "./pages/TransactionsPage";
import HoldingsPage from "./pages/HoldingsPage";
import ReviewPage from "./pages/ReviewPage";
import RetirementPage from "./pages/RetirementPage";
import EntryPage from "./pages/EntryPage";

export default function App() {
  return (
    <HashRouter>
      <div className="app">
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/holdings" element={<HoldingsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/retirement" element={<RetirementPage />} />
            <Route path="/entry" element={<EntryPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
