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

/** Convert dollars/rupees (major units) entered in a form to integer cents. */
export function toCents(major: string | number): number {
  const n = typeof major === "string" ? parseFloat(major) : major;
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
