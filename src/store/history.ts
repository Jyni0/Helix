import { create } from "zustand";
import { uid } from "@/lib/format";

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string | null;
  connectionName: string;
  database: string | null;
  at: number;
  elapsedMs: number;
  /** Rows fetched / affected. */
  rows: number | null;
  error: string | null;
}

const KEY = "helix.history";

/**
 * History lives in local storage: passwords in statements (CREATE USER …
 * PASSWORD '…', IDENTIFIED BY '…', WITH PASSWORD = '…') are masked first.
 */
export function redactSecrets(sql: string): string {
  return sql.replace(/\b(password\s*(?:=\s*)?|identified\s+(?:with\s+\S+\s+)?by\s+(?:password\s+)?|secret\s*=\s*)N?'(?:[^']|'')*'/gi, "$1'••••••'");
}
const MAX = 1000;

function load(): HistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface HistoryState {
  entries: HistoryEntry[];
  add(e: Omit<HistoryEntry, "id" | "at">): void;
  remove(id: string): void;
  clear(): void;
}

export const useHistory = create<HistoryState>((set) => ({
  entries: load(),
  add: (e) => set((s) => ({ entries: [{ ...e, sql: redactSecrets(e.sql), id: uid(), at: Date.now() }, ...s.entries].slice(0, MAX) })),
  remove: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),
  clear: () => set({ entries: [] }),
}));

let timer: ReturnType<typeof setTimeout> | undefined;
useHistory.subscribe((s) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s.entries));
    } catch {
      /* storage full */
    }
  }, 500);
});
