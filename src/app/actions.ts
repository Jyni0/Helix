/** Handlers of the mounted editors, so menus and shortcuts can reach the active one. */
export interface EditorActions {
  runStatement(): void;
  runScript(): void;
  explain(analyze?: boolean): void;
  format(): void;
  cancel(): void;
  save(as?: boolean): void;
  focus(): void;
  insert(text: string): void;
}

const editors = new Map<string, EditorActions>();

export function registerEditor(tabId: string, actions: EditorActions): () => void {
  editors.set(tabId, actions);
  return () => {
    if (editors.get(tabId) === actions) editors.delete(tabId);
  };
}

export function editorActions(tabId: string | null | undefined): EditorActions | undefined {
  return tabId ? editors.get(tabId) : undefined;
}
