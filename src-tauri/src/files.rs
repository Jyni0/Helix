//! File access from the UI is limited to paths the user picked in a native
//! file dialog (opened here, in the core): a compromised page cannot read or
//! overwrite arbitrary files. Picked paths are remembered (in a file only the
//! core writes) so scripts opened earlier can still be saved after a restart.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{AppError, AppResult};

const MAX_REMEMBERED: usize = 300;

pub struct FileAccess {
    store: Option<PathBuf>,
    allowed: Mutex<VecDeque<String>>,
}

/// One spelling per file (case-insensitive on Windows, `\` = `/`).
fn key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

impl FileAccess {
    pub fn open(store: PathBuf) -> Self {
        let list: Vec<String> = std::fs::read_to_string(&store).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        FileAccess { store: Some(store), allowed: Mutex::new(list.into()) }
    }

    pub fn in_memory() -> Self {
        FileAccess { store: None, allowed: Mutex::new(VecDeque::new()) }
    }

    /// Remembers a path the user chose.
    pub fn allow(&self, path: &Path) {
        let k = key(path);
        let mut list = self.allowed.lock().unwrap();
        list.retain(|p| *p != k);
        list.push_front(k);
        list.truncate(MAX_REMEMBERED);
        if let Some(store) = &self.store {
            if let Ok(json) = serde_json::to_vec(&*list) {
                let _ = std::fs::write(store, json);
            }
        }
    }

    /// Fails unless the user picked `path` in a dialog.
    pub fn check(&self, path: &str) -> AppResult<PathBuf> {
        let p = PathBuf::from(path);
        if path.trim().is_empty() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(AppError::Forbidden(format!("{path} was not chosen in a file dialog")));
        }
        let k = key(&p);
        if self.allowed.lock().unwrap().iter().any(|a| *a == k) {
            Ok(p)
        } else {
            Err(AppError::Forbidden(format!("{path} was not chosen in a file dialog")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_picked_paths_pass() {
        let f = FileAccess::in_memory();
        assert!(f.check("C:/Windows/system.ini").is_err());
        f.allow(Path::new("C:\\Data\\Report.csv"));
        assert!(f.check("C:\\Data\\Report.csv").is_ok());
        assert!(f.check("C:/Data/Report.csv").is_ok());
        assert!(f.check("C:/Data/../Data/Report.csv").is_err());
        assert!(f.check("C:/Data/other.csv").is_err());
        assert!(f.check("").is_err());
    }

    #[test]
    fn remembered_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("files.json");
        FileAccess::open(store.clone()).allow(Path::new("/tmp/a.sql"));
        assert!(FileAccess::open(store).check("/tmp/a.sql").is_ok());
    }
}
