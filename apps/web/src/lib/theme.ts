import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark";

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "light",
      toggle: () => {
        const next = get().theme === "dark" ? "light" : "dark";
        apply(next);
        set({ theme: next });
      },
      setTheme: (theme) => {
        apply(theme);
        set({ theme });
      },
    }),
    {
      name: "theme-store",
      onRehydrateStorage: () => (state) => {
        // Apply persisted theme on load; fall back to OS preference first run.
        if (state) {
          apply(state.theme);
        } else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
          apply("dark");
        }
      },
    }
  )
);
