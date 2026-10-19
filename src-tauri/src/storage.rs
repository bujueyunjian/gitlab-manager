use std::{path::Path, sync::Mutex};

use rusqlite::{Connection as Sqlite, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    error::{Error, Result},
    models::{Connection, ItemStatus, Task},
};

pub struct Database(Mutex<Sqlite>);

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Sqlite::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);",
        )?;
        Ok(Self(Mutex::new(db)))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Sqlite>> {
        self.0
            .lock()
            .map_err(|_| Error::State("本地数据库锁已失效，请重启应用".into()))
    }

    fn list<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let db = self.lock()?;
        let mut statement = db.prepare(sql)?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn save(&self, sql: &str, id: &str, value: &impl Serialize) -> Result<()> {
        self.lock()?
            .execute(sql, params![id, serde_json::to_string(value)?])?;
        Ok(())
    }

    pub fn connections(&self) -> Result<Vec<Connection>> {
        self.list("SELECT body FROM connections ORDER BY rowid")
    }

    pub fn connection(&self, id: &str) -> Result<Connection> {
        let body: Option<String> = self
            .lock()?
            .query_row("SELECT body FROM connections WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        match body {
            Some(body) => Ok(serde_json::from_str(&body)?),
            None => Err(Error::State("连接不存在，请重新选择实例".into())),
        }
    }

    pub fn save_connection(&self, value: &Connection) -> Result<()> {
        self.save("INSERT INTO connections VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", &value.id, value)
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM connections WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn tasks(&self) -> Result<Vec<Task>> {
        self.list("SELECT body FROM tasks ORDER BY rowid DESC")
    }

    pub fn task(&self, id: &str) -> Result<Task> {
        let body: String =
            self.lock()?
                .query_row("SELECT body FROM tasks WHERE id=?1", [id], |row| row.get(0))?;
        Ok(serde_json::from_str(&body)?)
    }

    pub fn save_task(&self, task: &Task) -> Result<()> {
        self.save(
            "INSERT INTO tasks VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            &task.id,
            task,
        )
    }

    pub fn recover_interrupted_tasks(&self) -> Result<()> {
        for mut task in self.tasks()? {
            if matches!(task.status.as_str(), "running" | "stopping") {
                task.status = "paused".into();
                for item in &mut task.items {
                    if item.status == ItemStatus::Running {
                        item.status = ItemStatus::Unknown;
                        item.message = "应用关闭时请求尚未确认，请先查询核实".into();
                    }
                }
                self.save_task(&task)?;
            }
        }
        Ok(())
    }
}
