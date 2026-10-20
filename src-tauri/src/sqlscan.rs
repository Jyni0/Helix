//! A small lexical scanner over SQL text: finds the leading keyword and the
//! keywords at parenthesis depth 0 (outside strings, comments and quoted
//! identifiers). Enough to classify a statement and to put a row limit on a
//! query without parsing it.

use crate::models::Driver;

/// A word (identifier / keyword) at nesting depth 0, uppercased, with its byte offset.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

/// Words outside strings / comments / quoted identifiers, with their depth.
fn scan(sql: &str, driver: Driver) -> Vec<(Word, i32)> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let mut depth = 0i32;
    while i < b.len() {
        let c = b[i];
        match c {
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'#' if driver == Driver::Mysql => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b'\'' => i = skip_quoted(b, i, b'\'', driver == Driver::Mysql),
            b'"' => i = skip_quoted(b, i, b'"', driver == Driver::Mysql),
            b'`' => i = skip_quoted(b, i, b'`', false),
            b'[' if driver == Driver::Mssql => {
                i += 1;
                while i < b.len() {
                    if b[i] == b']' {
                        if b.get(i + 1) == Some(&b']') {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'$' if driver == Driver::Postgres => {
                // Dollar quoting: $tag$ … $tag$
                let mut j = i + 1;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                if j < b.len() && b[j] == b'$' && !(j > i + 1 && b[i + 1].is_ascii_digit()) {
                    let tag = &sql[i..=j];
                    match sql[j + 1..].find(tag) {
                        Some(p) => i = j + 1 + p + tag.len(),
                        None => i = b.len(),
                    }
                } else {
                    i += 1;
                }
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                    i += 1;
                }
                out.push((Word { text: sql[start..i].to_ascii_uppercase(), start, end: i }, depth));
            }
            _ => i += 1,
        }
    }
    out
}

/// Index just past a quoted run starting at `i` (doubled quotes escape; MySQL
/// also takes backslash escapes inside strings).
fn skip_quoted(b: &[u8], mut i: usize, q: u8, backslash: bool) -> usize {
    i += 1;
    while i < b.len() {
        if backslash && b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == q {
            if b.get(i + 1) == Some(&q) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    b.len()
}

/// Uppercased keywords at depth 0.
pub fn top_level_words(sql: &str, driver: Driver) -> Vec<Word> {
    scan(sql, driver).into_iter().filter(|(_, d)| *d == 0).map(|(w, _)| w).collect()
}

/// The statement's leading keyword, uppercased ("" for none).
pub fn first_keyword(sql: &str, driver: Driver) -> String {
    scan(sql, driver).into_iter().next().map(|(w, _)| w.text).unwrap_or_default()
}

/// Trims whitespace and trailing semicolons.
pub fn trim_statement(sql: &str) -> &str {
    sql.trim().trim_end_matches(|c: char| c == ';' || c.is_whitespace())
}

/// Statements that can return a result set.
pub fn returns_rows(sql: &str, driver: Driver) -> bool {
    matches!(
        first_keyword(sql, driver).as_str(),
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "EXEC" | "EXECUTE" | "CALL" | "FETCH"
    )
}

/// What a statement does to the session's transaction.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TxEffect {
    Begin,
    End,
}

pub fn tx_effect(sql: &str, driver: Driver) -> Option<TxEffect> {
    let words = top_level_words(sql, driver);
    let first = words.first().map(|w| w.text.as_str()).unwrap_or("");
    let second = words.get(1).map(|w| w.text.as_str()).unwrap_or("");
    match first {
        "BEGIN" if driver != Driver::Mssql || second == "TRAN" || second == "TRANSACTION" => Some(TxEffect::Begin),
        "BEGIN" if second.is_empty() || second == "WORK" || second == "DEFERRED" || second == "IMMEDIATE" || second == "EXCLUSIVE" => Some(TxEffect::Begin),
        "START" if second == "TRANSACTION" => Some(TxEffect::Begin),
        "COMMIT" | "END" | "ROLLBACK" | "ABORT" => {
            // ROLLBACK TO SAVEPOINT keeps the transaction open.
            // (SQL Server's END closes a block, not a transaction.)
            let to_savepoint = first == "ROLLBACK" && (second == "TO" || words.iter().any(|w| w.text == "SAVEPOINT"));
            if to_savepoint || (first == "END" && driver == Driver::Mssql) {
                None
            } else {
                Some(TxEffect::End)
            }
        }
        _ => None,
    }
}

/// Rewrites a query so the server returns at most `limit` rows, or None when
/// the statement is not one that can safely be limited (the caller then
/// streams and stops reading). Callers fall back to the original text if the
/// rewritten one fails.
pub fn limit_query(sql: &str, driver: Driver, limit: usize) -> Option<String> {
    let body = trim_statement(sql);
    let words = top_level_words(body, driver);
    let first = words.first()?.text.as_str();
    if !matches!(first, "SELECT" | "WITH" | "VALUES" | "TABLE") {
        return None;
    }
    let has = |kw: &str| words.iter().any(|w| w.text == kw);
    // SELECT … INTO creates a table (PG / SQL Server) or writes variables / files (MySQL).
    if has("INTO") {
        return None;
    }
    match driver {
        Driver::Sqlite => None,
        Driver::Postgres | Driver::Mysql => {
            if first == "TABLE" && driver == Driver::Mysql {
                return None;
            }
            Some(format!("SELECT * FROM (\n{body}\n) helix_q LIMIT {limit}"))
        }
        Driver::Mssql => {
            if has("FOR") || has("OPTION") || has("COMPUTE") {
                return None;
            }
            // TOP right after SELECT [ALL|DISTINCT]: the query limits itself.
            let top = words.iter().position(|w| w.text == "TOP").is_some_and(|p| {
                p > 0 && (words[p - 1].text == "SELECT" || ((words[p - 1].text == "DISTINCT" || words[p - 1].text == "ALL") && p > 1 && words[p - 2].text == "SELECT"))
            });
            let order = words.windows(2).any(|w| w[0].text == "ORDER" && w[1].text == "BY");
            if top || has("OFFSET") {
                return None;
            }
            if order {
                // A derived table may not have ORDER BY: page the query itself.
                Some(format!("{body}\nOFFSET 0 ROWS FETCH NEXT {limit} ROWS ONLY"))
            } else if first == "SELECT" {
                Some(format!("SELECT TOP ({limit}) * FROM (\n{body}\n) helix_q"))
            } else {
                None
            }
        }
    }
}

/// Quotes an identifier for the driver.
pub fn quote_ident(driver: Driver, name: &str) -> String {
    match driver {
        Driver::Mysql => format!("`{}`", name.replace('`', "``")),
        Driver::Mssql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// A string literal for the driver.
pub fn quote_lit(driver: Driver, value: &str) -> String {
    match driver {
        Driver::Mysql => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
        Driver::Mssql => format!("N'{}'", value.replace('\'', "''")),
        _ => format!("'{}'", value.replace('\'', "''")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_keyword_skips_comments() {
        assert_eq!(first_keyword("-- hi\n/* x */ select 1", Driver::Postgres), "SELECT");
        assert_eq!(first_keyword("# c\nshow tables", Driver::Mysql), "SHOW");
        assert_eq!(first_keyword("   ", Driver::Postgres), "");
    }

    #[test]
    fn words_ignore_strings_and_nesting() {
        let w = top_level_words("select 'order by' as x, (select 1 order by 1) from t", Driver::Postgres);
        assert!(!w.iter().any(|w| w.text == "ORDER"));
        let w = top_level_words("select $$ into $$, \"into\" from t", Driver::Postgres);
        assert!(!w.iter().any(|w| w.text == "INTO"));
        let w = top_level_words("select [order] from t", Driver::Mssql);
        assert!(!w.iter().any(|w| w.text == "ORDER"));
    }

    #[test]
    fn limits_per_dialect() {
        assert_eq!(limit_query("select * from t;", Driver::Postgres, 10).unwrap(), "SELECT * FROM (\nselect * from t\n) helix_q LIMIT 10");
        assert!(limit_query("select * into x from t", Driver::Postgres, 10).is_none());
        assert!(limit_query("update t set a=1", Driver::Postgres, 10).is_none());
        assert!(limit_query("select 1", Driver::Sqlite, 10).is_none());
        assert_eq!(limit_query("select a from t order by a", Driver::Mssql, 5).unwrap(), "select a from t order by a\nOFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY");
        assert_eq!(limit_query("select a from t", Driver::Mssql, 5).unwrap(), "SELECT TOP (5) * FROM (\nselect a from t\n) helix_q");
        assert!(limit_query("select top 3 a from t order by a", Driver::Mssql, 5).is_none());
        assert!(limit_query("select distinct top 3 a from t", Driver::Mssql, 5).is_none());
        assert!(limit_query("select a from t for xml auto", Driver::Mssql, 5).is_none());
    }

    #[test]
    fn transaction_effects() {
        assert_eq!(tx_effect("BEGIN", Driver::Postgres), Some(TxEffect::Begin));
        assert_eq!(tx_effect("start transaction", Driver::Mysql), Some(TxEffect::Begin));
        assert_eq!(tx_effect("begin tran", Driver::Mssql), Some(TxEffect::Begin));
        assert_eq!(tx_effect("begin try select 1 end try", Driver::Mssql), None);
        assert_eq!(tx_effect("commit", Driver::Sqlite), Some(TxEffect::End));
        assert_eq!(tx_effect("rollback to savepoint a", Driver::Postgres), None);
        assert_eq!(tx_effect("select 1", Driver::Postgres), None);
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_ident(Driver::Postgres, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(Driver::Mssql, "a]b"), "[a]]b]");
        assert_eq!(quote_ident(Driver::Mysql, "a`b"), "`a``b`");
        assert_eq!(quote_lit(Driver::Mysql, "it's \\"), "'it''s \\\\'");
        assert_eq!(quote_lit(Driver::Mssql, "o'k"), "N'o''k'");
    }
}
