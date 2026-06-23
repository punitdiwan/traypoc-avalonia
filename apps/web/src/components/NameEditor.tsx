import { useState } from "react";
import { MAX_NAME_LEN, normalizeName } from "@/lib/format";

/** Inline name display that turns into an editable input on click. */
interface Props {
  value: string | null | undefined;
  fallback: string;
  pending?: boolean;
  onSave: (name: string) => void;
  className?: string;
  inputClassName?: string;
}

export default function NameEditor({
  value,
  fallback,
  pending = false,
  onSave,
  className = "",
  inputClassName = "",
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        className={`hover:text-brand-600 dark:hover:text-brand-400 transition-colors text-left ${className}`}
        title="Click to edit"
      >
        {value && value.trim() ? value : fallback}
      </button>
    );
  }

  const commit = () => {
    const name = normalizeName(draft);
    if (name && name !== value) {
      onSave(name);
    }
    setEditing(false);
  };

  return (
    <input
      type="text"
      autoFocus
      maxLength={MAX_NAME_LEN}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      disabled={pending}
      placeholder="Full name"
      className={`border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50 ${inputClassName}`}
    />
  );
}
