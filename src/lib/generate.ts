import type { ColumnInfo } from "./types";

/** Sample values for grid editing: UUIDs, names, e-mails, dates… */
export interface Generator {
  id: string;
  label: string;
  group: "Identifiers" | "People" | "Date & time" | "Numbers & text";
  make(): string;
}

const FIRST = ["James", "Olivia", "Liam", "Emma", "Noah", "Ava", "Lucas", "Mia", "Ethan", "Sofia", "Mason", "Isabella", "Leo", "Amelia", "Jack", "Chloe", "Daniel", "Grace", "Adam", "Nora"];
const LAST = ["Smith", "Johnson", "Brown", "Garcia", "Miller", "Davis", "Wilson", "Taylor", "Clark", "Lewis", "Walker", "Young", "King", "Wright", "Scott", "Green", "Baker", "Hill", "Adams", "Turner"];
const DOMAINS = ["example.com", "example.org", "mail.test", "company.dev"];
const CITIES = ["London", "Berlin", "Paris", "Madrid", "Warsaw", "Prague", "Vienna", "Lisbon", "Oslo", "Dublin"];
const COUNTRIES = ["United Kingdom", "Germany", "France", "Spain", "Poland", "Czechia", "Austria", "Portugal", "Norway", "Ireland"];
const WORDS = ["alpha", "bravo", "delta", "lorem", "ipsum", "dolor", "amet", "nova", "orbit", "pixel", "quartz", "river", "stone", "ember", "maple"];

const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T,>(xs: readonly T[]) => xs[int(0, xs.length - 1)];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A random moment within the last two years. */
const recent = () => new Date(Date.now() - Math.floor(Math.random() * 730 * 86_400_000));
const date = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const user = () => `${pick(FIRST).toLowerCase()}${pick([".", "_", ""])}${pick(LAST).toLowerCase()}${pick(["", String(int(1, 99))])}`;

export const GENERATORS: Generator[] = [
  { id: "uuid", label: "UUID", group: "Identifiers", make: uuid },
  { id: "int-id", label: "Integer ID", group: "Identifiers", make: () => String(int(1, 999_999)) },
  { id: "hex", label: "Hex token (16)", group: "Identifiers", make: () => [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("") },
  { id: "first", label: "First name", group: "People", make: () => pick(FIRST) },
  { id: "last", label: "Last name", group: "People", make: () => pick(LAST) },
  { id: "full", label: "Full name", group: "People", make: () => `${pick(FIRST)} ${pick(LAST)}` },
  { id: "user", label: "Username", group: "People", make: user },
  { id: "email", label: "E-mail", group: "People", make: () => `${user()}@${pick(DOMAINS)}` },
  { id: "phone", label: "Phone", group: "People", make: () => `+1 ${int(200, 999)}-${int(200, 999)}-${pad(int(0, 9999), 4)}` },
  { id: "city", label: "City", group: "People", make: () => pick(CITIES) },
  { id: "country", label: "Country", group: "People", make: () => pick(COUNTRIES) },
  { id: "now", label: "Now (date + time)", group: "Date & time", make: () => { const d = new Date(); return `${date(d)} ${time(d)}`; } },
  { id: "today", label: "Today", group: "Date & time", make: () => date(new Date()) },
  { id: "date", label: "Random date", group: "Date & time", make: () => date(recent()) },
  { id: "time", label: "Random time", group: "Date & time", make: () => time(recent()) },
  { id: "datetime", label: "Random date + time", group: "Date & time", make: () => { const d = recent(); return `${date(d)} ${time(d)}`; } },
  { id: "iso", label: "ISO timestamp (UTC)", group: "Date & time", make: () => recent().toISOString() },
  { id: "unix", label: "Unix timestamp", group: "Date & time", make: () => String(Math.floor(recent().getTime() / 1000)) },
  { id: "number", label: "Number 1–1000", group: "Numbers & text", make: () => String(int(1, 1000)) },
  { id: "decimal", label: "Decimal (price)", group: "Numbers & text", make: () => (Math.random() * 1000).toFixed(2) },
  { id: "bool", label: "Boolean", group: "Numbers & text", make: () => pick(["true", "false"]) },
  { id: "word", label: "Word", group: "Numbers & text", make: () => pick(WORDS) },
  { id: "sentence", label: "Sentence", group: "Numbers & text", make: () => { const n = int(4, 9); const w = Array.from({ length: n }, () => pick(WORDS)).join(" "); return w[0].toUpperCase() + w.slice(1) + "."; } },
];

export const generatorById = (id: string) => GENERATORS.find((g) => g.id === id);

/** The generator that best fits a column, from its name and type. */
export function suggestGenerator(col: Pick<ColumnInfo, "name" | "typeName" | "kind">): Generator {
  const n = col.name.toLowerCase();
  const t = col.typeName.toLowerCase();
  const by = (id: string) => generatorById(id)!;
  if (col.kind === "uuid" || t.includes("uniqueidentifier") || /(^|_)(uuid|guid)$/.test(n)) return by("uuid");
  if (/e?mail/.test(n)) return by("email");
  if (/(user_?name|login|nick|handle)/.test(n)) return by("user");
  if (/(first_?name|given)/.test(n)) return by("first");
  if (/(last_?name|surname|family)/.test(n)) return by("last");
  if (/(full_?name|^name$|display_?name|author|customer)/.test(n)) return by("full");
  if (/phone|mobile|tel/.test(n)) return by("phone");
  if (/city|town/.test(n)) return by("city");
  if (/country/.test(n)) return by("country");
  if (col.kind === "bool") return by("bool");
  if (col.kind === "date") {
    if (/^time\b|time without|time with/.test(t) && !t.includes("stamp")) return by("time");
    if (t === "date") return by("date");
    return by("now");
  }
  if (col.kind === "number") return /price|amount|total|cost|decimal|numeric|money/.test(n + " " + t) ? by("decimal") : by("number");
  if (/(_at|_on|date|time)$/.test(n)) return by("now");
  if (/(title|description|comment|note|text)/.test(n)) return by("sentence");
  return by("word");
}
