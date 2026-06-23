import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import { Skeleton } from "@/components/Skeleton";
import { adminApi } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { useToastStore } from "@/lib/toast";
import { MAX_NAME_LEN, normalizeName } from "@/lib/format";
import type { OrgSummary } from "@/types";

const inputClass =
  "border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-gray-400 dark:placeholder:text-gray-500";

// Org management for the god super-admin: list every organization across all
// tenants and create a new org + owner in one step.
export default function AdminPage() {
  const role = useAuthStore((s) => s.user?.role);
  // Only the god super-admin may manage organizations; anyone else is bounced
  // back to their dashboard.
  if (role !== "god") return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-6">
          Organizations
        </h1>
        <CreateOrgForm />
        <OrgList />
      </main>
    </div>
  );
}

function CreateOrgForm() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [orgName, setOrgName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [error, setError] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      adminApi.createOrg(orgName.trim(), normalizeName(ownerName), ownerEmail.trim(), ownerPassword),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "orgs"] });
      setOrgName("");
      setOwnerName("");
      setOwnerEmail("");
      setOwnerPassword("");
      setError("");
      addToast("Organization created");
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Failed to create organization";
      setError(msg);
      addToast(msg, "error");
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgName.trim() || !ownerName.trim() || !ownerEmail.trim() || !ownerPassword) return;
    createMutation.mutate();
  };

  return (
    <form
      onSubmit={handleCreate}
      className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 mb-8"
    >
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">New organization</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="Organization name"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          className={inputClass}
        />
        <input
          type="text"
          placeholder="Owner name"
          maxLength={MAX_NAME_LEN}
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          className={inputClass}
        />
        <input
          type="email"
          placeholder="Owner email"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          className={inputClass}
        />
        <input
          type="password"
          placeholder="Owner password"
          value={ownerPassword}
          onChange={(e) => setOwnerPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      <button
        type="submit"
        disabled={createMutation.isPending}
        className="mt-4 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
      >
        {createMutation.isPending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}

function OrgList() {
  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ["admin", "orgs"],
    queryFn: adminApi.listOrgs,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return <p className="text-gray-400 dark:text-gray-500 text-sm">No organizations yet.</p>;
  }

  return (
    <div className="overflow-x-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
            <th className="px-4 py-3 font-bold">Organization</th>
            <th className="px-4 py-3 font-bold">Owner</th>
            <th className="px-4 py-3 font-bold text-right">Employees</th>
            <th className="px-4 py-3 font-bold text-right">Created</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((o: OrgSummary) => (
            <tr
              key={o.id}
              className="border-b border-gray-50 dark:border-gray-800/50 last:border-0"
            >
              <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{o.name}</td>
              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                <div className="flex flex-col">
                  <span>{o.owner_full_name || "—"}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{o.owner_email}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">
                {o.employee_count}
              </td>
              <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400">
                {new Date(o.created_at).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
