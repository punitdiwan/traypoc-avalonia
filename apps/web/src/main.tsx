import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "./index.css";
import LoginPage from "./pages/LoginPage";
import ManagePage from "./pages/ManagePage";
import DiaryPage from "./pages/DiaryPage";
import ReportsPage from "./pages/ReportsPage";
import InvoicePage from "./pages/InvoicePage";
import ProtectedRoute from "./components/ProtectedRoute";
import { useThemeStore } from "./lib/theme";

// Lazy-loaded so recharts ships in its own chunk, not the main bundle.
const OverviewPage = lazy(() => import("./pages/OverviewPage"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// Apply the persisted theme before first paint.
useThemeStore.getState().setTheme(useThemeStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route
              path="/dashboard"
              element={
                <Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}>
                  <OverviewPage />
                </Suspense>
              }
            />
            <Route path="/manage" element={<ManagePage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/invoice/:userId" element={<InvoicePage />} />
            <Route path="/diary/:userId" element={<DiaryPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
