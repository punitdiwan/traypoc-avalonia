import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/lib/auth";
import { authApi } from "@/lib/api";

export default function NavBar() {
  const { user, setUser } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await authApi.logout();
    setUser(null);
    navigate("/login");
  };

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <Link to="/dashboard" className="font-semibold text-brand-600 text-lg">
        TimeTracker
      </Link>
      <div className="flex items-center gap-4 text-sm">
        <span className="text-gray-500">{user?.email}</span>
        <button
          onClick={handleLogout}
          className="text-gray-600 hover:text-gray-900 transition-colors"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
