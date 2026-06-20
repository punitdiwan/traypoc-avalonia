import { useEffect, useRef, useState } from "react";
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
  const [showChangePw, setShowChangePw] = useState(false);
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
  <>
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
                    {user.org_name && (
                      <p className="text-xs text-brand-600 dark:text-brand-400 truncate mt-1 font-medium">
                        🏢 {user.org_name}
                      </p>
                    )}
                  </div>
                </div>

                <div className="p-1">
                  <button
                    onClick={() => { setMenuOpen(false); setShowChangePw(true); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    Change password
                  </button>
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

    {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
  </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const addToast = useToastStore((s) => s.addToast);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { addToast("New passwords do not match", "error"); return; }
    if (next.length < 8) { addToast("New password must be at least 8 characters", "error"); return; }
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      addToast("Password changed successfully");
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to change password", "error");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Change password</h2>
          <button onClick={onClose} className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Current password</label>
            <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">New password</label>
            <input type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Confirm new password</label>
            <input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
            <button type="submit" disabled={saving} className="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
              {saving ? "Saving…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
