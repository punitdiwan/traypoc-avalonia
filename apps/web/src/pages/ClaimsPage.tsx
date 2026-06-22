import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import { Button, Card, EmptyState, PageHeader, SectionLabel } from "@/components/ui";
import { claimsApi, uploadClaimDocuments } from "@/lib/api";
import { useAuthStore } from "@/lib/auth";
import { useToastStore } from "@/lib/toast";
import { displayName, toCents } from "@/lib/format";
import type { Claim, ClaimStatus } from "@/types";

const ACCEPT = ".pdf,.png,.jpg,.jpeg";
const ALLOWED_EXT = ["pdf", "png", "jpg", "jpeg"];

/** Amount in major units, 2 decimals (no currency symbol — org currency isn't
 * exposed to employees; the invoice renders the symbol). */
function fmtAmount(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const STATUS_BADGE: Record<ClaimStatus, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  approved: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export default function ClaimsPage() {
  const user = useAuthStore((s) => s.user);
  const isEmployee = user?.role === "employee";

  const { data: claims, isLoading } = useQuery({
    queryKey: ["claims"],
    queryFn: () => claimsApi.list(),
  });

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-3xl mx-auto px-6 py-8">
        <PageHeader
          title="Extra Claims"
          subtitle={
            isEmployee
              ? "Request reimbursement for extra expenses. Approved claims are added to your next invoice."
              : "Review reimbursement claims raised by your team."
          }
        />

        {isEmployee && <ClaimForm />}

        <SectionLabel>{isEmployee ? "My claims" : "Team claims"}</SectionLabel>
        {isLoading ? (
          <EmptyState>Loading…</EmptyState>
        ) : !claims || claims.length === 0 ? (
          <EmptyState>No claims yet.</EmptyState>
        ) : (
          <div className="space-y-3">
            {claims.map((c) => (
              <ClaimCard key={c.id} claim={c} isEmployee={isEmployee} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ClaimForm() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setTitle("");
    setDescription("");
    setAmount("");
    setFiles([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      addToast("Title is required", "error");
      return;
    }
    const cents = toCents(amount);
    if (cents <= 0) {
      addToast("Enter an amount greater than 0", "error");
      return;
    }
    for (const f of files) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXT.includes(ext)) {
        addToast(`Unsupported file type: ${f.name} (PDF, PNG, JPG only)`, "error");
        return;
      }
    }
    setSubmitting(true);
    try {
      const documents = await uploadClaimDocuments(files);
      await claimsApi.create({
        title: title.trim(),
        description: description.trim() || undefined,
        amount_cents: cents,
        documents,
      });
      addToast("Claim submitted for approval");
      reset();
      qc.invalidateQueries({ queryKey: ["claims"] });
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to submit claim", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <Card className="mb-8">
      <SectionLabel>Raise a claim</SectionLabel>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputCls}
            placeholder="e.g. Client travel — taxi"
            maxLength={120}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description <span className="text-gray-400">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls}
            rows={2}
            placeholder="Add any details for your employer"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={inputCls}
            placeholder="0.00"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Supporting documents <span className="text-gray-400">(PDF, PNG, JPG)</span>
          </label>
          <input
            type="file"
            accept={ACCEPT}
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-brand-50 file:text-brand-700 dark:file:bg-brand-900/30 dark:file:text-brand-400 hover:file:bg-brand-100"
          />
          {files.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {files.length} file{files.length > 1 ? "s" : ""} selected
            </p>
          )}
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Submitting…" : "Submit claim"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ClaimCard({ claim, isEmployee }: { claim: Claim; isEmployee: boolean }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const review = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      if (action === "approve") {
        await claimsApi.approve(claim.id);
      } else {
        const note = window.prompt("Reason for rejecting this claim?") ?? "";
        if (!note.trim()) throw new Error("A reason is required to reject");
        await claimsApi.reject(claim.id, note.trim());
      }
    },
    onSuccess: () => {
      addToast("Claim updated");
      qc.invalidateQueries({ queryKey: ["claims"] });
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Action failed", "error"),
  });

  const remove = useMutation({
    mutationFn: () => claimsApi.remove(claim.id),
    onSuccess: () => {
      addToast("Claim deleted");
      qc.invalidateQueries({ queryKey: ["claims"] });
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Delete failed", "error"),
  });

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 dark:text-gray-100">{claim.title}</span>
            <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${STATUS_BADGE[claim.status]}`}>
              {claim.status}
            </span>
          </div>
          {!isEmployee && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {displayName({ full_name: claim.user_full_name, email: claim.user_email })}
            </p>
          )}
          {claim.description && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{claim.description}</p>
          )}
          {claim.documents.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {claim.documents.map((d, i) => (
                <a
                  key={i}
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline inline-flex items-center gap-1 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1"
                >
                  📎 {d.name}
                </a>
              ))}
            </div>
          )}
          {claim.employer_note && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 italic">
              Employer note: {claim.employer_note}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {fmtAmount(claim.amount_cents)}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {new Date(claim.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Actions */}
      {!isEmployee && claim.status === "pending" && (
        <div className="flex justify-end gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <Button size="sm" variant="danger" disabled={review.isPending} onClick={() => review.mutate("reject")}>
            Reject
          </Button>
          <Button size="sm" disabled={review.isPending} onClick={() => review.mutate("approve")}>
            Approve
          </Button>
        </div>
      )}
      {isEmployee && claim.status === "pending" && (
        <div className="flex justify-end mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}
