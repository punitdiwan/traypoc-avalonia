import { useEffect } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";

export default function ProtectedRoute() {
  const { isAuthenticated, setUser } = useAuthStore();

  // Rehydrate the user profile from the server on every app load so that
  // stale fields (allow_manual_time, require_notes, org_name, etc.) in the
  // persisted Zustand store are always up-to-date without requiring re-login.
  useEffect(() => {
    if (!isAuthenticated()) return;
    authApi.me().then((fresh) => setUser(fresh)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return isAuthenticated() ? <Outlet /> : <Navigate to="/login" replace />;
}
