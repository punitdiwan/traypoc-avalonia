import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { MAX_NAME_LEN, normalizeName } from "@/lib/format";

export default function SignupPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [fullName, setFullName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { user } = await authApi.register(orgName, normalizeName(fullName), email, password);
      setUser(user);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">⏱</span>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create organization</h1>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">You'll be the organization owner</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Your name
            </label>
            <input
              type="text"
              required
              maxLength={MAX_NAME_LEN}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ram Kumar Prasad"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Organization name
            </label>
            <input
              type="text"
              required
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create organization"}
          </button>
        </form>

        <p className="text-sm text-gray-500 dark:text-gray-400 mt-6 text-center">
          Already have an account?{" "}
          <Link to="/login" className="text-brand-600 dark:text-brand-400 font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
