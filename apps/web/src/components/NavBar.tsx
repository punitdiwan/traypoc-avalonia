import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/lib/auth";
import { useThemeStore } from "@/lib/theme";
import { authApi } from "@/lib/api";

export default function NavBar() {
  const { user, setUser } = useAuthStore();
  const { theme, toggle } = useThemeStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await authApi.logout();
    setUser(null);
    navigate("/login");
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors ${
      isActive
        ? "text-brand-600 dark:text-brand-400"
        : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
    }`;

  return (
    <nav className="no-print bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold text-brand-600 dark:text-brand-400 text-lg">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white text-sm">⏱</span>
          {user?.org_name || "TimeTracker"}
        </Link>
        <div className="hidden sm:flex items-center gap-4">
          <NavLink to="/dashboard" className={linkClass} end>
            Overview
          </NavLink>
          <NavLink to="/reports" className={linkClass}>
            Reports
          </NavLink>
          <NavLink to="/manage" className={linkClass}>
            Manage
          </NavLink>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <button
          onClick={toggle}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors text-base"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
        <span className="text-gray-500 dark:text-gray-400 hidden sm:inline">{user?.email}</span>
        <button
          onClick={handleLogout}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
