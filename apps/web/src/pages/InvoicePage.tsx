import { useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import NavBar from "@/components/NavBar";
import { invoiceApi } from "@/lib/api";
import { useToastStore } from "@/lib/toast";
import { formatHours, formatMoney } from "@/lib/format";

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function InvoicePage() {
  const { userId } = useParams<{ userId: string }>();
  const [params] = useSearchParams();
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const isApproved = params.get("approved") === "1";

  const addToast = useToastStore((s) => s.addToast);
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["invoice", userId, from, to, isApproved],
    queryFn: () => invoiceApi.get(userId!, from, to, isApproved),
    enabled: !!userId && !!from && !!to,
  });

  const handleDownloadPdf = async () => {
    if (!userId || !from || !to) return;
    setDownloading(true);
    try {
      await invoiceApi.downloadPdf(userId, from, to, { approved: isApproved });
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to download PDF", "error");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <NavBar />
      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Toolbar (hidden when printing) */}
        <div className="no-print flex items-center justify-between mb-6">
          <Link
            to={isApproved ? "/timesheets" : "/reports"}
            className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
          >
            {isApproved ? "‹ Back to timesheets" : "‹ Back to reports"}
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.print()}
              disabled={!data}
              className="border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              Print
            </button>
            <button
              onClick={handleDownloadPdf}
              disabled={!data || downloading}
              className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              {downloading ? "Preparing…" : "Download PDF"}
            </button>
          </div>
        </div>

        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
        {error && (
          <p className="text-sm text-red-600">{error instanceof Error ? error.message : "Failed to load invoice"}</p>
        )}
        {(!from || !to) && (
          <p className="text-sm text-red-600">Missing date range. Open this from the Reports page.</p>
        )}

        {data && (
          <div className="bg-white dark:bg-gray-900 print:bg-white rounded-xl border border-gray-200 dark:border-gray-800 print:border-0 p-8">
            {/* PAID banner — shown when accessed from an approved timesheet */}
            {isApproved && (
              <div className="no-print mb-6 flex items-center gap-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3">
                <span className="text-lg">&#10003;</span>
                <div>
                  <p className="text-sm font-semibold text-green-700 dark:text-green-400">Timesheet approved &amp; paid</p>
                  <p className="text-xs text-green-600 dark:text-green-500">This invoice is locked. No further edits can be made.</p>
                </div>
              </div>
            )}

            {/* Header */}
            <div className="flex items-start justify-between border-b border-gray-200 dark:border-gray-800 pb-6 mb-6">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Timesheet Invoice</h1>
                  {isApproved && (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-bold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border border-green-300 dark:border-green-700">
                      &#10003; PAID
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {fmtDate(data.from)} — {fmtDate(data.to)}
                </p>
              </div>
              <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400 font-semibold">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white text-sm">⏱</span>
                TimeTracker
              </div>
            </div>

            {/* Bill-to */}
            <div className="mb-6">
              <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">Employee</p>
              <p className="text-gray-900 dark:text-gray-100 font-medium">{data.full_name || data.email}</p>
              {data.full_name && (
                <p className="text-sm text-gray-500 dark:text-gray-400">{data.email}</p>
              )}
            </div>

            {/* Line items */}
            <table className="w-full text-sm mb-6">
              <thead>
                <tr className="text-left text-xs text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th className="font-medium py-2">Project</th>
                  <th className="font-medium py-2 text-right">Hours</th>
                  <th className="font-medium py-2 text-right">Rate / hr</th>
                  <th className="font-medium py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.line_items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-gray-400">
                      No tracked time in this period.
                    </td>
                  </tr>
                ) : (
                  data.line_items.map((l) => (
                    <tr key={l.project_id ?? "unassigned"} className="border-b border-gray-100 dark:border-gray-800/60">
                      <td className="py-3 text-gray-900 dark:text-gray-100">{l.name}</td>
                      <td className="py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">{formatHours(l.seconds)}</td>
                      <td className="py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">
                        {l.rate_cents > 0 ? `${formatMoney(l.rate_cents, data.currency)}` : "—"}
                      </td>
                      <td className="py-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                        {formatMoney(l.amount_cents, data.currency)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Extra claims */}
            {data.claims.length > 0 && (
              <div className="mb-6">
                <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">Extra Claims</p>
                <table className="w-full text-sm">
                  <tbody>
                    {data.claims.map((c, i) => (
                      <tr key={i} className="border-b border-gray-100 dark:border-gray-800/60">
                        <td className="py-3 text-gray-900 dark:text-gray-100">
                          {c.title}
                          {c.description && (
                            <span className="block text-xs text-gray-400 dark:text-gray-500">{c.description}</span>
                          )}
                        </td>
                        <td className="py-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                          {formatMoney(c.amount_cents, data.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Total */}
            <div className="flex justify-end">
              <div className="w-64">
                <div className="flex justify-between py-2 text-sm text-gray-500 dark:text-gray-400">
                  <span>Total hours</span>
                  <span className="tabular-nums">{formatHours(data.total_seconds)}</span>
                </div>
                {data.claims_cents > 0 && (
                  <>
                    <div className="flex justify-between py-1 text-sm text-gray-500 dark:text-gray-400">
                      <span>Time total</span>
                      <span className="tabular-nums">{formatMoney(data.total_cents, data.currency)}</span>
                    </div>
                    <div className="flex justify-between py-1 text-sm text-gray-500 dark:text-gray-400">
                      <span>Claims total</span>
                      <span className="tabular-nums">{formatMoney(data.claims_cents, data.currency)}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between py-3 border-t border-gray-200 dark:border-gray-800 text-base font-semibold text-gray-900 dark:text-gray-100">
                  <span>Total due</span>
                  <span className="tabular-nums">{formatMoney(data.grand_total_cents, data.currency)}</span>
                </div>
                {data.locked && (
                  <p className="text-right text-xs text-green-600 dark:text-green-400 italic">
                    Time locked at approval
                  </p>
                )}
              </div>
            </div>

            <p className="text-xs text-gray-400 dark:text-gray-600 mt-8">
              Generated {new Date(data.generated_at).toLocaleString()} · amounts in {data.currency}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
