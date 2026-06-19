import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";

import "./index.css";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import ManagePage from "./pages/ManagePage";
import AdminPage from "./pages/AdminPage";
import DiaryPage from "./pages/DiaryPage";
import ReportsPage from "./pages/ReportsPage";
import InvoicePage from "./pages/InvoicePage";
import EmployeeDashboard from "./pages/EmployeeDashboard";
import ProtectedRoute from "./components/ProtectedRoute";
import ToastContainer from "./components/ToastContainer";
import { useAuthStore } from "./lib/auth";
import { useThemeStore } from "./lib/theme";

// Lazy-loaded so recharts ships in its own chunk, not the main bundle.
const OverviewPage = lazy(() => import("./pages/OverviewPage"));

// /dashboard is the team Overview for employers/god, but a personal summary for
// employees (whose accounts can't read the employer-only overview endpoint).
function DashboardRoute() {
  const role = useAuthStore((s) => s.user?.role);
  if (role === "employee") return <EmployeeDashboard />;
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}>
      <OverviewPage />
    </Suspense>
  );
}

// Employer/god-only section: employees are bounced to their dashboard.
function RequireEmployer() {
  const role = useAuthStore((s) => s.user?.role);
  return role === "employee" ? <Navigate to="/dashboard" replace /> : <Outlet />;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// Apply the persisted theme before first paint.
useThemeStore.getState().setTheme(useThemeStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastContainer />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<DashboardRoute />} />
            {/* Own diary for employees; any org employee for employer/god. */}
            <Route path="/diary/:userId" element={<DiaryPage />} />
            <Route element={<RequireEmployer />}>
              <Route path="/manage" element={<ManagePage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/invoice/:userId" element={<InvoicePage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
