use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};

use tauri::Emitter;
use uuid::Uuid;

use crate::{
    credentials::Credentials,
    error::{Error, Result, invalid},
    gitlab::{GitLab, normalize_url},
    models::*,
    planner,
    storage::Database,
};

pub struct ActiveTask {
    pub id: String,
    pub stop: Arc<AtomicBool>,
}

pub struct Service {
    pub db: Database,
    pub credentials: Arc<dyn Credentials>,
    pub prepared: Mutex<Option<PreparedPlan>>,
    pub active: Mutex<Option<ActiveTask>>,
}

pub fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    value
        .lock()
        .map_err(|_| Error::State("应用状态锁已失效，请重启应用".into()))
}

impl Service {
    pub fn new(db: Database, credentials: Arc<dyn Credentials>) -> Self {
        Self {
            db,
            credentials,
            prepared: Mutex::new(None),
            active: Mutex::new(None),
        }
    }

    pub fn client(&self, id: &str) -> Result<(Connection, GitLab)> {
        let connection = self.db.connection(id)?;
        let client = GitLab::new(&connection.base_url, self.credentials.get(id)?)?;
        Ok((connection, client))
    }

    fn ensure_idle(&self) -> Result<()> {
        if lock(&self.active)?.is_some() {
            return Err(invalid("请先停止当前任务，再修改连接或开始另一个任务"));
        }
        Ok(())
    }

    pub async fn save_connection(&self, input: ConnectionInput) -> Result<Connection> {
        self.ensure_idle()?;
        if input.name.trim().is_empty() {
            return Err(invalid("请填写连接名称"));
        }
        let url = normalize_url(&input.base_url)?.to_string();
        let client = GitLab::new(&url, input.token.clone())?;
        let user: User = client.get("user").await?;
        let version: Version = client.get("version").await?;
        let token: TokenInfo = client.get("personal_access_tokens/self").await?;
        if !token.scopes.iter().any(|s| s == "api" || s == "read_api") {
            return Err(invalid("访问令牌需要 api 或 read_api 范围"));
        }
        let previous = input
            .id
            .as_deref()
            .map(|id| self.db.connection(id))
            .transpose()?;
        let id = previous
            .as_ref()
            .map(|c| c.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let previous_token = if previous.is_some() {
            match self.credentials.get(&id) {
                Ok(token) => Some(token),
                Err(Error::Credentials(keyring::Error::NoEntry)) => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        // A token rotation for the same user and instance does not invalidate pending work.
        let revision = previous
            .as_ref()
            .filter(|c| c.base_url == url && c.user.id == user.id)
            .map(|c| c.revision.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let connection = Connection {
            id: id.clone(),
            name: input.name.trim().into(),
            base_url: url,
            revision,
            user,
            scopes: token.scopes,
            expires_at: token.expires_at,
            version: version.version,
            checked_at: now(),
        };
        self.credentials.set(&id, &input.token)?;
        if let Err(original) = self.db.save_connection(&connection) {
            let rollback = match previous_token {
                Some(token) => self.credentials.set(&id, &token),
                None => self.credentials.delete(&id),
            };
            return match rollback {
                Ok(()) => Err(original),
                Err(rollback) => Err(Error::Rollback {
                    original: Box::new(original),
                    rollback: Box::new(rollback),
                }),
            };
        }
        *lock(&self.prepared)? = None;
        Ok(connection)
    }

    pub async fn check_connection(&self, id: &str) -> Result<Connection> {
        let (mut connection, client) = self.client(id)?;
        let user: User = client.get("user").await?;
        if user.id != connection.user.id {
            return Err(invalid("令牌身份发生变化，请重新保存连接"));
        }
        let token: TokenInfo = client.get("personal_access_tokens/self").await?;
        let version: Version = client.get("version").await?;
        connection.user = user;
        connection.scopes = token.scopes;
        connection.expires_at = token.expires_at;
        connection.version = version.version;
        connection.checked_at = now();
        self.db.save_connection(&connection)?;
        Ok(connection)
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        self.ensure_idle()?;
        if self.db.tasks()?.iter().any(|t| {
            t.connection_id == id
                && t.items.iter().any(|i| {
                    matches!(
                        i.status,
                        ItemStatus::Pending | ItemStatus::Unknown | ItemStatus::Running
                    )
                })
        }) {
            return Err(invalid(
                "此连接仍有待执行或结果未知的任务，请先处理这些任务",
            ));
        }
        let old = match self.credentials.get(id) {
            Ok(token) => Some(token),
            Err(Error::Credentials(keyring::Error::NoEntry)) => None,
            Err(e) => return Err(e),
        };
        if old.is_some() {
            self.credentials.delete(id)?;
        }
        if let Err(original) = self.db.delete_connection(id) {
            if let Some(token) = old
                && let Err(rollback) = self.credentials.set(id, &token)
            {
                return Err(Error::Rollback {
                    original: Box::new(original),
                    rollback: Box::new(rollback),
                });
            }
            return Err(original);
        }
        *lock(&self.prepared)? = None;
        Ok(())
    }

    pub async fn resolve_projects(&self, id: &str, inputs: Vec<String>) -> Result<Vec<Resolution>> {
        let (_, client) = self.client(id)?;
        let mut rows = vec![];
        for input in inputs {
            let result = client.resolve(&input).await;
            rows.push(match result {
                Ok(candidates) => Resolution {
                    input,
                    candidates,
                    error: None,
                },
                Err(error) => Resolution {
                    input,
                    candidates: vec![],
                    error: Some(error.to_string()),
                },
            });
        }
        Ok(rows)
    }

    pub async fn resources(
        &self,
        id: &str,
        project_ids: Vec<u64>,
    ) -> Result<Vec<ProjectResources>> {
        let (_, client) = self.client(id)?;
        let mut seen = HashSet::new();
        let mut result = vec![];
        for project_id in project_ids.into_iter().filter(|id| seen.insert(*id)) {
            let project = client.project(project_id).await?;
            let hooks = match client.hooks(project_id).await {
                Ok(data) => ReadResult::Ready { data },
                Err(e) => ReadResult::Error {
                    message: e.to_string(),
                },
            };
            let members = match tokio::try_join!(
                client.members(project_id, false),
                client.members(project_id, true),
                client.shares(project_id)
            ) {
                Ok((direct, all, shares)) => ReadResult::Ready {
                    data: MemberList {
                        direct,
                        all,
                        shares,
                    },
                },
                Err(error) => ReadResult::Error {
                    message: error.to_string(),
                },
            };
            result.push(ProjectResources {
                project,
                hooks,
                members,
            });
        }
        Ok(result)
    }

    pub async fn prepare_hooks(&self, request: HookRequest) -> Result<Plan> {
        let (connection, client) = self.client(&request.connection_id)?;
        let prepared = planner::hooks(&client, &connection, request).await?;
        let plan = prepared.plan.clone();
        *lock(&self.prepared)? = Some(prepared);
        Ok(plan)
    }

    pub async fn prepare_permissions(&self, request: PermissionRequest) -> Result<Plan> {
        let (connection, client) = self.client(&request.connection_id)?;
        let prepared = planner::permissions(&client, &connection, request).await?;
        let plan = prepared.plan.clone();
        *lock(&self.prepared)? = Some(prepared);
        Ok(plan)
    }

    pub fn discard_plan(&self, id: &str) -> Result<()> {
        let mut prepared = lock(&self.prepared)?;
        if prepared.as_ref().is_some_and(|p| p.plan.id == id) {
            *prepared = None;
        }
        Ok(())
    }

    pub fn start_plan(self: &Arc<Self>, id: &str, app: tauri::AppHandle) -> Result<Task> {
        self.ensure_idle()?;
        let mut pending = lock(&self.prepared)?;
        let prepared = pending
            .as_ref()
            .ok_or_else(|| invalid("预览已过期，请重新扫描"))?;
        if prepared.plan.id != id {
            return Err(invalid("预览已变化，请重新扫描"));
        }
        if prepared
            .plan
            .items
            .iter()
            .any(|i| i.action == Action::Conflict)
        {
            return Err(invalid("请先解决重复匹配"));
        }
        if !prepared
            .plan
            .items
            .iter()
            .any(|i| i.status == ItemStatus::Pending)
        {
            return Err(invalid("没有可以执行的变更"));
        }
        let connection = self.db.connection(&prepared.plan.connection_id)?;
        if connection.revision != prepared.plan.connection_revision {
            return Err(invalid("连接身份或实例已变化，请重新预览"));
        }
        let prepared = pending.take().expect("validated pending plan");
        drop(pending);
        let task = Task {
            id: Uuid::new_v4().to_string(),
            connection_id: connection.id,
            connection_revision: connection.revision,
            connection_name: connection.name,
            title: prepared.plan.title,
            status: "paused".into(),
            items: prepared.plan.items,
            created_at: now(),
            updated_at: now(),
        };
        self.launch(task, prepared.secret, app)
    }

    pub fn resume(
        self: &Arc<Self>,
        id: &str,
        item_ids: Option<Vec<String>>,
        secret: Option<String>,
        app: tauri::AppHandle,
    ) -> Result<Task> {
        self.ensure_idle()?;
        let mut task = self.db.task(id)?;
        let connection = self.db.connection(&task.connection_id)?;
        if connection.revision != task.connection_revision {
            return Err(invalid("连接身份或实例已变化，请重新预览"));
        }
        if let Some(ids) = item_ids {
            if ids.is_empty() {
                return Err(invalid("请选择需要重试的失败项"));
            }
            for id in &ids {
                if !task
                    .items
                    .iter()
                    .any(|i| i.id == *id && i.status == ItemStatus::Failed)
                {
                    return Err(invalid("只能重试明确失败的记录；未知结果请先核实"));
                }
            }
            for item in &mut task.items {
                if ids.contains(&item.id) {
                    item.status = ItemStatus::Pending;
                }
            }
        }
        if !task.items.iter().any(|i| i.status == ItemStatus::Pending) {
            return Err(invalid("没有尚未执行的条目"));
        }
        if task
            .items
            .iter()
            .any(|i| i.status == ItemStatus::Pending && i.secret_required)
            && secret.as_ref().is_none_or(|s| s.is_empty())
        {
            return Err(invalid(
                "任务不保存密钥，请重新提供本次需要设置的接收端密钥",
            ));
        }
        self.launch(task, secret, app)
    }

    pub fn stop(&self, id: &str) -> Result<()> {
        let active = lock(&self.active)?;
        let active = active
            .as_ref()
            .ok_or_else(|| invalid("当前没有执行中的任务"))?;
        if active.id != id {
            return Err(invalid("此任务未在执行"));
        }
        active.stop.store(true, Ordering::Release);
        Ok(())
    }

    pub fn confirm_unknown(&self, task_id: &str, item_id: &str, note: &str) -> Result<Task> {
        self.ensure_idle()?;
        if note.trim().is_empty() {
            return Err(invalid("请填写你在 GitLab 或接收端核实的结果"));
        }
        let mut task = self.db.task(task_id)?;
        let item = task
            .items
            .iter_mut()
            .find(|i| i.id == item_id && i.status == ItemStatus::Unknown)
            .ok_or_else(|| invalid("此条目不是未知结果"))?;
        item.status = ItemStatus::Succeeded;
        item.message = format!("用户已核实：{}", note.trim());
        crate::runner::summarize(&mut task);
        self.db.save_task(&task)?;
        Ok(task)
    }

    fn launch(
        self: &Arc<Self>,
        mut task: Task,
        secret: Option<String>,
        app: tauri::AppHandle,
    ) -> Result<Task> {
        let (_, client) = self.client(&task.connection_id)?;
        let mut active = lock(&self.active)?;
        if active.is_some() {
            return Err(invalid("已有任务正在执行"));
        }
        let stop = Arc::new(AtomicBool::new(false));
        task.status = "running".into();
        task.updated_at = now();
        self.db.save_task(&task)?;
        *active = Some(ActiveTask {
            id: task.id.clone(),
            stop: stop.clone(),
        });
        drop(active);
        let initial = task.clone();
        let service = self.clone();
        // Sync IPC commands do not enter Tokio's runtime; use Tauri's application runtime.
        tauri::async_runtime::spawn(async move {
            // Persistence is authoritative; the webview notification only triggers a fresh read.
            let progress = || {
                let _ = app.emit("tasks-updated", ());
            };
            let outcome = crate::runner::execute(
                &service,
                &client,
                &mut task,
                secret.as_deref(),
                &stop,
                &progress,
            )
            .await;
            match lock(&service.active) {
                Ok(mut active) => *active = None,
                Err(error) => {
                    let _ = app.emit("operation-notice", error.to_string());
                }
            }
            if let Err(error) = outcome {
                let _ = app.emit("operation-notice", error.to_string());
            }
            let _ = app.emit("tasks-updated", ());
            let _ = app.emit("resources-updated", ());
        });
        Ok(initial)
    }
}
