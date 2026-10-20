import { create } from "zustand";

export interface ExportRequest {
  connectionId: string;
  database: string;
  /** Query whose full result is exported. */
  sql: string;
  /** Suggested file / INSERT table name. */
  name: string;
}

export interface ImportRequest {
  connectionId: string;
  database: string;
  schema: string | null;
  table: string;
}

interface DialogsState {
  exportReq: ExportRequest | null;
  importReq: ImportRequest | null;
  openExport(r: ExportRequest): void;
  openImport(r: ImportRequest): void;
  close(): void;
}

export const useDialogs = create<DialogsState>((set) => ({
  exportReq: null,
  importReq: null,
  openExport: (exportReq) => set({ exportReq, importReq: null }),
  openImport: (importReq) => set({ importReq, exportReq: null }),
  close: () => set({ exportReq: null, importReq: null }),
}));
