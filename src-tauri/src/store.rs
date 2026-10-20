//! Saved connections: a JSON file in the app data folder (no secrets in it).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::ConnectionConfig;

#[derive(Serialize, Deserialize, Default)]
struct Data {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
}

pub struct Store {
    path: Option<PathBuf>,
    data: Mutex<Data>,
}

impl Store {
    /// Reads `path` (a missing or unreadable file starts empty; an unreadable
    /// one is kept aside as `.bak` instead of being overwritten).
    pub fn open(path: PathBuf) -> Self {
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("connections file is damaged ({e}); keeping a copy");
                let _ = std::fs::copy(&path, path.with_extension("json.bak"));
                Data::default()
            }),
            Err(_) => Data::default(),
        };
        Store { path: Some(path), data: Mutex::new(data) }
    }

    /// A store that never touches the disk (tests).
    pub fn in_memory() -> Self {
        Store { path: None, data: Mutex::new(Data::default()) }
    }

    fn save(&self, data: &Data) -> AppResult<()> {
        let Some(path) = &self.path else { return Ok(()) };
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.data.lock().unwrap().connections.clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.data.lock().unwrap().connections.iter().find(|c| c.id == id).cloned().ok_or_else(|| AppError::NotFound(format!("connection {id}")))
    }

    /// Inserts (no / unknown id) or replaces a connection; returns it as stored.
    pub fn upsert(&self, mut cfg: ConnectionConfig) -> AppResult<ConnectionConfig> {
        if cfg.name.trim().is_empty() {
            return Err(AppError::invalid("Give the connection a name"));
        }
        let mut data = self.data.lock().unwrap();
        match data.connections.iter_mut().find(|c| !cfg.id.is_empty() && c.id == cfg.id) {
            Some(existing) => {
                cfg.created_at = existing.created_at;
                cfg.last_used_at = existing.last_used_at;
                *existing = cfg.clone();
            }
            None => {
                if cfg.id.is_empty() {
                    cfg.id = uuid::Uuid::new_v4().to_string();
                }
                cfg.created_at = chrono::Utc::now().timestamp_millis();
                data.connections.push(cfg.clone());
            }
        }
        self.save(&data)?;
        Ok(cfg)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut data = self.data.lock().unwrap();
        data.connections.retain(|c| c.id != id);
        self.save(&data)
    }

    /// Records a successful connect.
    pub fn touch(&self, id: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(c) = data.connections.iter_mut().find(|c| c.id == id) {
            c.last_used_at = Some(chrono::Utc::now().timestamp_millis());
            let _ = self.save(&data);
        }
    }

    /// New order of the connections (ids first, others keep their order after).
    pub fn reorder(&self, ids: &[String]) -> AppResult<()> {
        let mut data = self.data.lock().unwrap();
        data.connections.sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
        self.save(&data)
    }
}
