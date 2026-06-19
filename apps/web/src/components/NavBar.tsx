import { useState, useRef, useEffect } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/lib/auth";
import { useThemeStore } from "@/lib/theme";
import { authApi } from "@/lib/api";
import NameEditor from "@/components/NameEditor";
import { useToastStore } from "@/lib/toast";

export default function NavBar() {
  const { user, setUser } = useAuthStore();
  const { theme, toggle } = useThemeStore();
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    await authApi.logout();
    setUser(null);
    navigate("/login");
  };

  const handleSaveName = async (name: string) => {
    if (!user || name === user.full_name) return;
    setSavingName(true);
    try {
      await authApi.updateMe(name);
      setUser({ ...user, full_name: name });
      addToast("Name updated");
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setSavingName(false);
    }
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors ${
      isActive
        ? "text-brand-600 dark:text-brand-400"
        : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
    }`;

  const initials = user?.full_name
    ? user.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : user?.email[0].toUpperCase() || "?";

  return (
    <nav className="no-print bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between relative z-40">
      <div className="flex items-center gap-6">
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold text-brand-600 dark:text-brand-400 text-lg">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white text-sm">⏱</span>
          {user?.org_name || "TimeTracker"}
        </Link>
        <div className="hidden sm:flex items-center gap-4">
          {user?.role === "employee" ? (
            <>
              <NavLink to="/dashboard" className={linkClass} end>
                Dashboard
              </NavLink>
              <NavLink to={`/diary/${user.id}`} className={linkClass}>
                Work Diary
              </NavLink>
            </>
          ) : (
            <>
              <NavLink to="/dashboard" className={linkClass} end>
                Overview
              </NavLink>
              <NavLink to="/reports" className={linkClass}>
                Reports
              </NavLink>
              <NavLink to="/manage" className={linkClass}>
                Manage
              </NavLink>
              {user?.role === "god" && (
                <NavLink to="/admin" className={linkClass}>
                  Organizations
                </NavLink>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={toggle}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition-colors text-base"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>

        {user && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center justify-center h-8 w-8 rounded-full bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 font-semibold text-xs border border-brand-200 dark:border-brand-800 hover:ring-2 hover:ring-brand-500/20 transition-all"
            >
              {initials}
            </button>

            {menuOpen && (
              <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-bold mb-1">Profile</p>
                  <div className="flex flex-col">
                    <NameEditor
                      value={user.full_name}
                      fallback={user.email}
                      pending={savingName}
                      onSave={handleSaveName}
                      className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate"
                      inputClassName="w-full mt-1"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{user.email}</p>
                  </div>
                </div>

                <div className="p-1">
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  >
                    Logout
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
