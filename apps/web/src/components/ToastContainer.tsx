import { useToastStore } from "@/lib/toast";

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center justify-between gap-3 min-w-64 max-w-sm px-4 py-3 rounded-xl border shadow-lg animate-in fade-in slide-in-from-right-4 duration-300 ${
            toast.type === "success"
              ? "bg-white dark:bg-gray-900 border-green-200 dark:border-green-900 text-green-800 dark:text-green-300"
              : toast.type === "error"
                ? "bg-white dark:bg-gray-900 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300"
                : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 text-gray-800 dark:text-gray-300"
          }`}
        >
          <span className="text-sm font-medium">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
