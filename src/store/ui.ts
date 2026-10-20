import { create } from "zustand";
import type { ReactNode } from "react";
import { applyTheme, isTheme, type Theme } from "@/lib/themes";

export type SettingsTab = "appearance" | "editor" | "results" | "safety" | "shortcuts" | "about";
export type ToastKind = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

export interface DialogButton {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
}

export interface DialogRequest {
  title: string;
  message?: ReactNode;
  buttons: DialogButton[];
  /** Button chosen by Escape / clicking outside. */
  cancelId: string;
  /** A text field in the dialog (prompt). */
  input?: { label?: string; value?: string; placeholder?: string; password?: boolean; mono?: boolean };
  resolve(answer: { id: string; value: string }): void;
}

export interface Preferences {
  theme: Theme;
  sidebarHidden: boolean;
  sidebarWidth: number;
  /** Editor share of the SQL editor's height (the rest shows results). */
  editorSplit: number;
  editorFontSize: number;
  tabSize: number;
  wordWrap: boolean;
  autocomplete: boolean;
  /** An empty line also ends a statement (Ctrl+Enter runs the block under the cursor). */
  blankLineDelimiter: boolean;
  formatUppercase: boolean;
  rowLimit: number;
  /** New editors start in auto-commit mode. */
  autoCommit: boolean;
  nullText: string;
  /** Show the SQL of grid edits before saving them. */
  previewChanges: boolean;
  /** Ask before data / structure changes on production connections. */
  confirmProduction: boolean;
  /** Ask before UPDATE / DELETE without WHERE. */
  confirmUnbounded: boolean;
  /** A failing statement stops a script. */
  stopOnError: boolean;
  showSystemObjects: boolean;
  /** What double-clicking a table opens. */
  openTableView: "data" | "properties";
  checkForUpdates: boolean;
}

const PREFS_KEY = "helix.prefs";
export const DEFAULT_PREFS: Preferences = {
  theme: "dark",
  sidebarHidden: false,
  sidebarWidth: 280,
  editorSplit: 0.45,
  editorFontSize: 13,
  tabSize: 2,
  wordWrap: false,
  autocomplete: true,
  blankLineDelimiter: true,
  formatUppercase: true,
  rowLimit: 200,
  autoCommit: true,
  nullText: "[NULL]",
  previewChanges: true,
  confirmProduction: true,
  confirmUnbounded: true,
  stopOnError: true,
  showSystemObjects: false,
  openTableView: "data",
  checkForUpdates: true,
};

function loadPrefs(): Preferences {
  try {
    const p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") } as Preferences;
    if (!isTheme(p.theme)) p.theme = DEFAULT_PREFS.theme;
    return p;
  } catch {
    return DEFAULT_PREFS;
  }
}

const initialPrefs = loadPrefs();
if (typeof document !== "undefined") applyTheme(initialPrefs.theme);

interface UiState {
  prefs: Preferences;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  toasts: Toast[];
  dialog: DialogRequest | null;
  setPref<K extends keyof Preferences>(key: K, value: Preferences[K]): void;
  resetPrefs(): void;
  openSettings(tab?: SettingsTab): void;
  closeSettings(): void;
  toast(message: string, kind?: ToastKind, detail?: string): void;
  dismissToast(id: number): void;
  /** Shows a question; resolves with the chosen button id. */
  ask(req: Omit<DialogRequest, "resolve" | "input">): Promise<string>;
  /** Asks for a line of text; null when cancelled. */
  prompt(req: { title: string; message?: ReactNode; label?: string; value?: string; placeholder?: string; okLabel?: string; password?: boolean; mono?: boolean }): Promise<string | null>;
  closeDialog(id: string, value?: string): void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  prefs: initialPrefs,
  settingsOpen: false,
  settingsTab: "appearance",
  toasts: [],
  dialog: null,

  setPref(key, value) {
    const prefs = { ...get().prefs, [key]: value };
    // Before React re-renders, so everything drawn next uses the new colours.
    if (key === "theme") applyTheme(value as Theme);
    set({ prefs });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  },
  resetPrefs() {
    const prefs = { ...DEFAULT_PREFS, theme: get().prefs.theme };
    set({ prefs });
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  },

  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false }),

  toast(message, kind = "info", detail) {
    const id = ++toastId;
    // The same message again replaces the one showing instead of stacking.
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message || t.detail !== detail).slice(-3), { id, kind, message, detail }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  ask: (req) =>
    new Promise<string>((resolve) => {
      // A dialog already open is answered with its cancel button first.
      const open = get().dialog;
      open?.resolve({ id: open.cancelId, value: "" });
      set({ dialog: { ...req, resolve: (a) => resolve(a.id) } });
    }),
  prompt: (req) =>
    new Promise<string | null>((resolve) => {
      const open = get().dialog;
      open?.resolve({ id: open.cancelId, value: "" });
      set({
        dialog: {
          title: req.title,
          message: req.message,
          buttons: [
            { id: "ok", label: req.okLabel ?? "OK", variant: "primary" },
            { id: "cancel", label: "Cancel" },
          ],
          cancelId: "cancel",
          input: { label: req.label, value: req.value ?? "", placeholder: req.placeholder, password: req.password, mono: req.mono },
          resolve: (a) => resolve(a.id === "ok" ? a.value : null),
        },
      });
    }),
  closeDialog(id, value = "") {
    const d = get().dialog;
    set({ dialog: null });
    d?.resolve({ id, value });
  },
}));

export const toast = (message: string, kind?: ToastKind, detail?: string) => useUi.getState().toast(message, kind, detail);
export const prefs = () => useUi.getState().prefs;
