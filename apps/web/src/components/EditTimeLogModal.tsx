import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui";
import { timeLogsApi } from "@/lib/api";
import { useToastStore } from "@/lib/toast";
import type { DiarySlot, Project } from "@/types";

// datetime-local works in local time with no timezone; convert to/from ISO.
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fieldCls =
  "w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 [color-scheme:light] dark:[color-scheme:dark]";

export default function EditTimeLogModal({
  slot,
  projects,
  onClose,
  onSaved,
}: {
  slot: DiarySlot;
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useToastStore((s) => s.addToast);
  const backdropRef = useRef<HTMLDivElement>(null);

  const [projectId, setProjectId] = useState<string>(slot.project_id ?? "");
  const [start, setStart] = useState(isoToLocalInput(slot.started_at));
  const [end, setEnd] = useState(isoToLocalInput(slot.ended_at));
  const [notes, setNotes] = useState(slot.notes ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const save = useMutation({
    mutationFn: () => {
      const startIso = new Date(start).toISOString();
      const endIso = new Date(end).toISOString();
      if (new Date(endIso) <= new Date(startIso)) {
        throw new Error("End time must be after start time");
      }
      return timeLogsApi.update(slot.id, {
        project_id: projectId || null,
        started_at: startIso,
        ended_at: endIso,
        notes: notes.trim() || null,
      });
    },
    onSuccess: () => {
      addToast("Entry updated");
      onSaved();
      onClose();
    },
    onError: (e) => addToast(e instanceof Error ? e.message : "Update failed", "error"),
  });

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit time entry</h2>
          <button
            onClick={onClose}
            className="h-8 w-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={fieldCls}>
              <option value="">Unassigned</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Start</label>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={fieldCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">End</label>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={fieldCls} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional working notes…"
              className={`${fieldCls} resize-none`}
            />
          </div>

          {slot.screenshot_url && slot.window_title !== "Manual entry" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This entry has a screenshot — changing its time won’t move the screenshot.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
