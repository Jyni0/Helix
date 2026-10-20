import type { Driver } from "../types";

/** One statement of a script: its text and where it sits in the document. */
export interface Statement {
  text: string;
  from: number;
  to: number;
}

const ROUTINE = /^\s*(create|alter)\s+(or\s+replace\s+|or\s+alter\s+)?(definer\s*=\s*\S+\s+)?(temp(orary)?\s+)?(trigger|procedure|function|event|package)\b/i;

/** Text without comments is empty: nothing to run. */
function isBlank(text: string, driver: Driver): boolean {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  if (driver === "mysql") t = t.replace(/#[^\n]*/g, "");
  return t.trim() === "";
}

/**
 * Splits a script into statements. Understands quotes, comments, PostgreSQL
 * dollar quoting, MySQL `DELIMITER`, SQL Server `GO` lines and BEGIN … END
 * bodies of triggers / routines. `blankLines`: an empty line also ends a
 * statement (DBeaver's "smart" mode), except inside routine bodies.
 */
export function splitStatements(sql: string, driver: Driver, blankLines = true): Statement[] {
  const out: Statement[] = [];
  let delimiter = ";";
  let start = 0;
  let i = 0;
  let depth = 0; // BEGIN … END nesting inside a routine
  let words: string[] = []; // leading words of the current statement
  let routine = false;
  const n = sql.length;

  const push = (end: number, next: number) => {
    const raw = sql.slice(start, end);
    if (!isBlank(raw, driver)) {
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      out.push({ text, from: start + lead, to: start + lead + text.length });
    }
    start = next;
    depth = 0;
    words = [];
    routine = false;
  };

  const atLineStart = (k: number) => {
    let j = k - 1;
    while (j >= 0 && (sql[j] === " " || sql[j] === "\t")) j--;
    return j < 0 || sql[j] === "\n";
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Comments
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && driver === "mysql") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Quotes
    if (c === "'" || c === '"' || c === "`" || (c === "[" && driver === "mssql")) {
      const close = c === "[" ? "]" : c;
      i++;
      while (i < n) {
        if (driver === "mysql" && sql[i] === "\\" && c !== "`") {
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$" && driver === "postgres") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
        continue;
      }
    }
    // MySQL DELIMITER command (a line of its own)
    if (driver === "mysql" && (c === "D" || c === "d") && atLineStart(i)) {
      const m = /^delimiter[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(sql.slice(i, i + 80));
      if (m) {
        push(i, i + m[0].length);
        delimiter = m[1];
        i += m[0].length;
        continue;
      }
    }
    // SQL Server batch separator: GO on its own line
    if (driver === "mssql" && (c === "G" || c === "g") && atLineStart(i)) {
      const m = /^go[ \t]*(\d+)?[ \t]*(\r?\n|$)/i.exec(sql.slice(i, i + 16));
      if (m) {
        push(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    // Words: track the statement's leading words and BEGIN / END blocks.
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      // A custom DELIMITER may follow a word directly ("END$$").
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]) && !(delimiter !== ";" && sql.startsWith(delimiter, j))) j++;
      const w = sql.slice(i, j).toUpperCase();
      if (words.length < 8) {
        words.push(w);
        if (words.length <= 6) routine = ROUTINE.test(words.join(" "));
      }
      if (routine) {
        const after = /^\s*([A-Za-z]+)/.exec(sql.slice(j, j + 20))?.[1]?.toUpperCase();
        if (w === "BEGIN" && !(after && ["TRANSACTION", "TRAN", "WORK"].includes(after))) depth++;
        else if (w === "CASE") depth++;
        else if (w === "END" && !(after && ["IF", "LOOP", "WHILE", "REPEAT"].includes(after))) depth = Math.max(0, depth - 1);
      }
      i = j;
      continue;
    }
    // Delimiter
    if (sql.startsWith(delimiter, i) && depth === 0 && !(routine && driver === "mssql")) {
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }
    // Blank line
    if (blankLines && c === "\n" && !routine) {
      const m = /^\n[ \t\r]*\n/.exec(sql.slice(i, i + 64));
      if (m && !isBlank(sql.slice(start, i), driver)) {
        push(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  push(n, n);
  return out;
}

/** The statement the cursor is in (or right after / on the line of). */
export function statementAt(statements: Statement[], pos: number, doc: string): Statement | null {
  if (!statements.length) return null;
  const inside = statements.find((s) => pos >= s.from && pos <= s.to);
  if (inside) return inside;
  // Between statements: the one ending on the cursor's line, else the next one, else the last.
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const before = [...statements].reverse().find((s) => s.to <= pos);
  if (before && before.to >= lineStart) return before;
  const after = statements.find((s) => s.from >= pos);
  const lineEnd = doc.indexOf("\n", pos);
  if (after && (lineEnd < 0 || after.from <= lineEnd)) return after;
  return before ?? after ?? null;
}
