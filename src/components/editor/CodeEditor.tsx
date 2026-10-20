import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { tags as t } from "@lezer/highlight";
import type { Driver } from "@/lib/types";

const DIALECT = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite, mssql: MSSQL } as const;

/** Colours come from the theme tokens, so every app theme styles the editor. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name), t.className], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.name)], color: "var(--syn-function)" },
  { tag: [t.special(t.name), t.propertyName], color: "var(--syn-ident)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--text-muted)" },
  { tag: t.invalid, color: "var(--diff-del)" },
]);

/** Active-line highlight only while nothing is selected: the line background
 * starts at the line's left padding, the selection after it, so together
 * they showed a grey strip left of the selection. */
const activeLine = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: { docChanged: boolean; selectionSet: boolean; viewportChanged: boolean; view: EditorView }) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const sel = view.state.selection;
      if (sel.ranges.some((r) => !r.empty)) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      let last = -1;
      for (const r of sel.ranges) {
        const line = view.lineBlockAt(r.head);
        if (line.from > last) {
          b.add(line.from, line.from, Decoration.line({ class: "cm-activeLine" }));
          last = line.from;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

function theme(fontSize: number): Extension {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${fontSize}px`, backgroundColor: "transparent", color: "var(--text-main)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
    ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
    },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text-main) 4%, transparent)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-main)" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-dim)", border: "none", paddingLeft: "6px" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 4px", minWidth: "32px" },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--text-dim)", padding: "0 4px" },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
    ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 14%, transparent)" },
    ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #e3b341 30%, transparent)", outline: "1px solid color-mix(in srgb, #e3b341 60%, transparent)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, #e3b341 55%, transparent)" },
    ".cm-placeholder": { color: "var(--text-dim)" },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-surface)",
      color: "var(--text-main)",
      border: "1px solid var(--border)",
      borderRadius: "12px",
      boxShadow: "var(--shadow-popup)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: `${Math.max(11, fontSize - 1)}px`, padding: "4px", maxHeight: "260px" },
    ".cm-tooltip-autocomplete > ul > li": { borderRadius: "8px", padding: "3px 8px !important", color: "var(--text-muted)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--hover-bg)", color: "var(--text-main)" },
    ".cm-completionDetail": { color: "var(--text-dim)", fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "600" },
    ".cm-completionIcon": { opacity: "0.7" },
    ".cm-panels": { backgroundColor: "var(--bg-sidebar)", color: "var(--text-main)", borderColor: "var(--border-soft) !important" },
    ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "var(--font-ui)", fontSize: "12px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
      backgroundColor: "var(--bg-input)",
      color: "var(--text-main)",
      border: "1px solid transparent",
      borderRadius: "8px",
      padding: "2px 8px",
      backgroundImage: "none",
      fontSize: "12px",
    },
    ".cm-panel.cm-search label": { fontSize: "12px", color: "var(--text-muted)" },
    ".cm-panel.cm-search [name=close]": { color: "var(--text-dim)", background: "none" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--bg-input)", border: "none", color: "var(--text-muted)" },
  });
}

export interface EditorHandlers {
  onRunStatement?(): void;
  onRunScript?(): void;
  onExplain?(): void;
  onFormat?(): void;
  onSave?(): void;
}

export interface CodeEditorHandle {
  view(): EditorView | null;
  focus(): void;
  /** Selected text (empty when nothing is selected). */
  selection(): string;
  cursor(): number;
  setValue(text: string): void;
  insert(text: string): void;
  /** Selects a range and scrolls to it. */
  select(from: number, to: number): void;
}

interface Props extends EditorHandlers {
  value: string;
  onChange?(value: string): void;
  driver: Driver;
  /** Tables / columns for completion. */
  schema?: SQLNamespace;
  defaultSchema?: string;
  fontSize?: number;
  tabSize?: number;
  wordWrap?: boolean;
  autocomplete?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  onCursor?(pos: { line: number; col: number; selected: number }): void;
}

/** CodeMirror 6 SQL editor. */
export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef<Props>(props);
  handlers.current = props;
  const comp = useRef({ lang: new Compartment(), theme: new Compartment(), wrap: new Compartment(), tab: new Compartment(), ro: new Compartment(), complete: new Compartment() });

  const langExt = (p: Props) =>
    sql({ dialect: DIALECT[p.driver], schema: p.schema, defaultSchema: p.defaultSchema, upperCaseKeywords: true });

  useEffect(() => {
    const p = handlers.current;
    const run = (fn?: () => void) => () => {
      fn?.();
      return true;
    };
    const editorKeys = Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: run(() => handlers.current.onRunStatement?.()) },
        { key: "Alt-x", run: run(() => handlers.current.onRunScript?.()) },
        { key: "Mod-Shift-e", run: run(() => handlers.current.onExplain?.()) },
        { key: "Mod-Shift-f", run: run(() => handlers.current.onFormat?.()) },
        { key: "Mod-s", run: run(() => handlers.current.onSave?.()) },
        { key: "Mod-/", run: toggleComment },
      ]),
    );
    const state = EditorState.create({
      doc: p.value,
      extensions: [
        editorKeys,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        activeLine,
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        comp.current.lang.of(langExt(p)),
        comp.current.complete.of(autocompletion({ activateOnTyping: p.autocomplete !== false, icons: true })),
        comp.current.theme.of(theme(p.fontSize ?? 13)),
        comp.current.wrap.of(p.wordWrap ? EditorView.lineWrapping : []),
        comp.current.tab.of([EditorState.tabSize.of(p.tabSize ?? 2), indentUnit.of(" ".repeat(p.tabSize ?? 2))]),
        comp.current.ro.of(EditorState.readOnly.of(!!p.readOnly)),
        placeholderExt(p.placeholder ?? ""),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const sel = u.state.selection.main;
            const line = u.state.doc.lineAt(sel.head);
            handlers.current.onCursor?.({ line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) });
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current! });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value changes (file load, format) replace the document.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.lang.reconfigure(langExt(props)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.driver, props.schema, props.defaultSchema]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.theme.reconfigure(theme(props.fontSize ?? 13)) });
  }, [props.fontSize]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.wrap.reconfigure(props.wordWrap ? EditorView.lineWrapping : []) });
  }, [props.wordWrap]);
  useEffect(() => {
    const n = props.tabSize ?? 2;
    viewRef.current?.dispatch({ effects: comp.current.tab.reconfigure([EditorState.tabSize.of(n), indentUnit.of(" ".repeat(n))]) });
  }, [props.tabSize]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.complete.reconfigure(autocompletion({ activateOnTyping: props.autocomplete !== false, icons: true })) });
  }, [props.autocomplete]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.current.ro.reconfigure(EditorState.readOnly.of(!!props.readOnly)) });
  }, [props.readOnly]);

  useImperativeHandle(ref, () => ({
    view: () => viewRef.current,
    focus: () => viewRef.current?.focus(),
    selection: () => {
      const v = viewRef.current;
      if (!v) return "";
      const s = v.state.selection.main;
      return v.state.sliceDoc(s.from, s.to);
    },
    cursor: () => viewRef.current?.state.selection.main.head ?? 0,
    setValue: (text) => {
      const v = viewRef.current;
      v?.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    insert: (text) => {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    select: (from, to) => {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    },
  }));

  return <div ref={host} className="selectable h-full min-h-0 w-full overflow-hidden" data-testid="sql-editor" />;
});
