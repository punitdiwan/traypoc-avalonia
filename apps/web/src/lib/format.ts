// Shared formatting helpers.

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Format integer cents as a localized currency string (e.g. 123456 → "₹1,234.56"). */
export function formatMoney(cents: number, currency: string): string {
  let fmt = moneyFormatters.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, { style: "currency", currency });
    } catch {
      // Fall back gracefully for an unknown/invalid currency code.
      fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 });
    }
    moneyFormatters.set(currency, fmt);
  }
  return fmt.format(cents / 100);
}

/** Hours with one decimal up to 10h, whole numbers above (e.g. 3.4h, 42h). */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

/** Duration as an h/m breakdown (e.g. 3h, 3h 20m, 45m). */
export function formatDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Time-of-day from an ISO timestamp (e.g. "9:05 AM"), in the local timezone. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Local-timezone YYYY-MM-DD for a Date (NOT UTC — avoids the toISOString off-by-one). */
export function localDateISO(d = new Date()): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Today's date as a local YYYY-MM-DD string. */
export function todayISO(): string {
  return localDateISO();
}

/** Convert dollars/rupees (major units) entered in a form to integer cents. */
export function toCents(major: string | number): number {
  const n = typeof major === "string" ? parseFloat(major) : major;
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** Max length of a person's full name (mirrors the API's normalizeName). */
export const MAX_NAME_LEN = 30;

/**
 * Normalize a full name to match the server: trim ends, collapse internal
 * whitespace to single spaces, and cap at MAX_NAME_LEN characters.
 */
export function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN);
}

/** A person's display name: their full name if set, otherwise their email. */
export function displayName(u: { full_name?: string | null; email: string }): string {
  return u.full_name && u.full_name.trim() ? u.full_name : u.email;
}
