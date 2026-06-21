// Shared UI primitives. Keep these dependency-free and presentational so every
// page renders cards, buttons, headers, and empty states consistently.
import type { ButtonHTMLAttributes, ReactNode } from "react";

// ── Button ────────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

const VARIANT_CLS: Record<Variant, string> = {
  primary:
    "bg-brand-600 hover:bg-brand-700 text-white border border-transparent",
  secondary:
    "border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800",
  danger:
    "border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20",
  ghost:
    "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100",
};

const SIZE_CLS: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLS[variant]} ${SIZE_CLS[size]} ${className}`}
      {...rest}
    />
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

// ── PageHeader ─────────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        {subtitle && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────────

export function EmptyState({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-gray-400 dark:text-gray-500 text-sm ${className}`}>{children}</p>
  );
}

// ── SectionLabel — the recurring uppercase tracking-wide subheading ────────────

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
      {children}
    </h2>
  );
}
