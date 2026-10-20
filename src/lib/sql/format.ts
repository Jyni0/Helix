import { format } from "sql-formatter";
import type { Driver } from "../types";

const LANGUAGE = { postgres: "postgresql", mysql: "mysql", sqlite: "sqlite", mssql: "transactsql" } as const;

/** Pretty-prints SQL in the connection's dialect; returns the input if it cannot be parsed. */
export function formatSql(sql: string, driver: Driver, opts: { uppercase: boolean; tabWidth: number }): string {
  try {
    return format(sql, {
      language: LANGUAGE[driver],
      keywordCase: opts.uppercase ? "upper" : "preserve",
      tabWidth: opts.tabWidth,
      linesBetweenQueries: 1,
    });
  } catch {
    return sql;
  }
}
