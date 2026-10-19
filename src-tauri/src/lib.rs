//! Desktop IPC boundary. Network access and credentials never belong to the webview.
mod credentials;
mod error;
mod gitlab;
mod models;
mod planner;
mod runner;
mod service;
mod storage;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use credentials::SystemCredentials;
use error::{Error, Result, invalid};
use models::*;
use service::{Service, lock};

#[tauri::command]
fn list_connections(state: State<'_, Arc<Service>>) -> Result<Vec<Connection>> {
    state.db.connections()
}

#[tauri::command]
async fn save_connection(
    state: State<'_, Arc<Service>>,
    input: ConnectionInput,
) -> Result<Connection> {
    state.save_connection(input).await
}

#[tauri::command]
async fn check_connection(
    state: State<'_, Arc<Service>>,
    connection_id: String,
) -> Result<Connection> {
    state.check_connection(&connection_id).await
}

#[tauri::command]
fn delete_connection(state: State<'_, Arc<Service>>, connection_id: String) -> Result<()> {
    state.delete_connection(&connection_id)
}

#[tauri::command]
async fn list_projects(
    state: State<'_, Arc<Service>>,
    connection_id: String,
    filter: ProjectFilter,
) -> Result<Vec<Project>> {
    let (_, client) = state.client(&connection_id)?;
    client.projects(&filter).await
}

#[tauri::command]
async fn resolve_projects(
    state: State<'_, Arc<Service>>,
    connection_id: String,
    inputs: Vec<String>,
) -> Result<Vec<Resolution>> {
    state.resolve_projects(&connection_id, inputs).await
}

#[tauri::command]
async fn read_resources(
    state: State<'_, Arc<Service>>,
    connection_id: String,
    project_ids: Vec<u64>,
) -> Result<Vec<ProjectResources>> {
    state.resources(&connection_id, project_ids).await
}

#[tauri::command]
async fn search_users(
    state: State<'_, Arc<Service>>,
    connection_id: String,
    search: String,
) -> Result<Vec<User>> {
    if search.trim().is_empty() {
        return Err(invalid("请输入用户名或姓名"));
    }
    let (_, client) = state.client(&connection_id)?;
    client
        .list("users", &[("search", search), ("active", "true".into())])
        .await
}

#[tauri::command]
async fn search_groups(
    state: State<'_, Arc<Service>>,
    connection_id: String,
    search: String,
) -> Result<Vec<Group>> {
    if search.trim().is_empty() {
        return Err(invalid("请输入要授权的群组名称"));
    }
    let (_, client) = state.client(&connection_id)?;
    client.list("groups", &[("search", search)]).await
}

#[tauri::command]
async fn preview_hooks(state: State<'_, Arc<Service>>, request: HookRequest) -> Result<Plan> {
    state.prepare_hooks(request).await
}

#[tauri::command]
async fn preview_permissions(
    state: State<'_, Arc<Service>>,
    request: PermissionRequest,
) -> Result<Plan> {
    state.prepare_permissions(request).await
}

#[tauri::command]
fn discard_plan(state: State<'_, Arc<Service>>, plan_id: String) -> Result<()> {
    state.discard_plan(&plan_id)
}

#[tauri::command]
fn start_plan(
    state: State<'_, Arc<Service>>,
    app: tauri::AppHandle,
    plan_id: String,
) -> Result<Task> {
    state.inner().start_plan(&plan_id, app)
}

#[tauri::command]
fn list_tasks(state: State<'_, Arc<Service>>) -> Result<Vec<Task>> {
    state.db.tasks()
}

#[tauri::command]
fn read_task(state: State<'_, Arc<Service>>, task_id: String) -> Result<Task> {
    state.db.task(&task_id)
}

#[tauri::command]
fn stop_task(state: State<'_, Arc<Service>>, task_id: String) -> Result<()> {
    state.stop(&task_id)
}

#[tauri::command]
fn resume_task(
    state: State<'_, Arc<Service>>,
    app: tauri::AppHandle,
    task_id: String,
    item_ids: Option<Vec<String>>,
    secret: Option<String>,
) -> Result<Task> {
    state.inner().resume(&task_id, item_ids, secret, app)
}

#[tauri::command]
async fn reconcile_task(state: State<'_, Arc<Service>>, task_id: String) -> Result<Task> {
    if lock(&state.active)?.is_some() {
        return Err(invalid("请先等待当前任务结束"));
    }
    let mut task = state.db.task(&task_id)?;
    let (connection, client) = state.client(&task.connection_id)?;
    if connection.revision != task.connection_revision {
        return Err(invalid("连接身份或实例已变化，无法核实原任务"));
    }
    runner::reconcile(&client, &mut task).await?;
    state.db.save_task(&task)?;
    Ok(task)
}

#[tauri::command]
fn confirm_unknown(
    state: State<'_, Arc<Service>>,
    task_id: String,
    item_id: String,
    note: String,
) -> Result<Task> {
    state.confirm_unknown(&task_id, &item_id, &note)
}

#[tauri::command]
async fn export_task(
    state: State<'_, Arc<Service>>,
    app: tauri::AppHandle,
    task_id: String,
) -> Result<bool> {
    let content = serde_json::to_string_pretty(&runner::report(&state.db.task(&task_id)?))?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name("gitlab-task-results.json")
            .blocking_save_file();
        let Some(file) = file else { return Ok(false) };
        let path = file
            .into_path()
            .map_err(|_| invalid("所选导出位置不是本地文件"))?;
        std::fs::write(path, content)?;
        Ok(true)
    })
    .await
    .map_err(|e| Error::State(format!("导出任务执行失败：{e}")))?
}

#[tauri::command]
async fn open_project(
    state: State<'_, Arc<Service>>,
    app: tauri::AppHandle,
    connection_id: String,
    project_id: u64,
) -> Result<()> {
    let (connection, client) = state.client(&connection_id)?;
    let project = client.project(project_id).await?;
    let target =
        url::Url::parse(&project.web_url).map_err(|_| invalid("GitLab 返回的项目地址无效"))?;
    let base = gitlab::normalize_url(&connection.base_url)?;
    if target.origin() != base.origin() || !target.path().starts_with(base.path()) {
        return Err(invalid("项目地址不属于当前实例"));
    }
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| Error::State(format!("无法打开浏览器：{e}")))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The bundle identifier and database filename remain stable across display-name changes.
            let directory = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let directory = directory.join("development");
            std::fs::create_dir_all(&directory)?;
            let db = storage::Database::open(&directory.join("workbench.sqlite"))?;
            db.recover_interrupted_tasks()?;
            app.manage(Arc::new(Service::new(db, Arc::new(SystemCredentials))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let service = window.state::<Arc<Service>>();
                if service.active.lock().is_ok_and(|active| active.is_some()) {
                    api.prevent_close();
                    let _ = window.emit(
                        "operation-notice",
                        "任务仍在执行，请先停止任务，等待当前请求完成后再关闭",
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            save_connection,
            check_connection,
            delete_connection,
            list_projects,
            resolve_projects,
            read_resources,
            search_users,
            search_groups,
            preview_hooks,
            preview_permissions,
            discard_plan,
            start_plan,
            list_tasks,
            read_task,
            stop_task,
            resume_task,
            reconcile_task,
            confirm_unknown,
            export_task,
            open_project
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start GitLab Console");
}
