use std::collections::HashSet;

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    error::{Result, invalid},
    gitlab::GitLab,
    models::*,
};

fn new_item(project: &Project, resource: Resource) -> PlanItem {
    PlanItem {
        id: Uuid::new_v4().to_string(),
        project_id: project.id,
        project_path: project.path_with_namespace.clone(),
        resource,
        target_id: None,
        subject: None,
        action: Action::Blocked,
        status: ItemStatus::Blocked,
        message: String::new(),
        before: None,
        body: json!({}),
        changes: vec![],
        candidates: vec![],
        secret_required: false,
        attempts: 0,
    }
}

fn failed_project(id: u64, resource: Resource, message: String) -> PlanItem {
    PlanItem {
        id: Uuid::new_v4().to_string(),
        project_id: id,
        project_path: format!("项目 #{id}"),
        resource,
        target_id: None,
        subject: None,
        action: Action::Blocked,
        status: ItemStatus::Blocked,
        message,
        before: None,
        body: json!({}),
        changes: vec![],
        candidates: vec![],
        secret_required: false,
        attempts: 0,
    }
}

/// Reject known scope or project restrictions; GitLab authorizes writes when legacy scopes are unknown.
fn project_write_error(connection: &Connection, project: &Project) -> Option<String> {
    // 1. Enforce known token restrictions without claiming unknown scopes permit writes.
    if connection
        .scopes
        .as_ref()
        .is_some_and(|scopes| !scopes.iter().any(|s| s == "api"))
    {
        return Some("访问令牌只有读取权限，写入需要 api 范围".into());
    }
    // 2. Keep archive and project management permission checks for every server version.
    if project.archived {
        return Some("仓库已归档，不能修改配置".into());
    }
    if connection.user.is_admin == Some(true) {
        return None;
    }
    let level = project.permissions.as_ref().and_then(|p| {
        [p.project_access.as_ref(), p.group_access.as_ref()]
            .into_iter()
            .flatten()
            .map(|a| a.access_level)
            .max()
    });
    match level {
        Some(level) if level >= 40 => None,
        Some(_) => Some("需要 Maintainer 或 Owner 权限".into()),
        None => Some("GitLab 未返回可确认的管理权限".into()),
    }
}

fn prepare_item(item: &mut PlanItem, action: Action, message: &str) {
    item.action = action;
    item.status = if action == Action::Skip {
        ItemStatus::Skipped
    } else {
        ItemStatus::Pending
    };
    item.message = message.into();
}

fn plan(connection: &Connection, title: &str, items: Vec<PlanItem>) -> Plan {
    Plan {
        id: Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        connection_revision: connection.revision.clone(),
        title: title.into(),
        items,
        created_at: now(),
    }
}

pub fn hook_snapshot(hook: &Hook) -> Value {
    json!({"id":hook.id,"name":hook.name,"url":hook.url,
        "push_events":hook.push_events,"merge_requests_events":hook.merge_requests_events,
        "pipeline_events":hook.pipeline_events,"issues_events":hook.issues_events,
        "tag_push_events":hook.tag_push_events,"enable_ssl_verification":hook.enable_ssl_verification})
}

pub fn member_snapshot(member: &Member) -> Value {
    json!({"id":member.id,"access_level":member.access_level,"expires_at":member.expires_at})
}

pub fn share_snapshot(share: &Share) -> Value {
    json!({"id":share.group_id,"group_access":share.group_access_level,"expires_at":share.expires_at})
}

fn field_label(key: &str) -> &str {
    match key {
        "name" => "名称",
        "url" => "目标地址",
        "push_events" => "Push 事件",
        "merge_requests_events" => "合并请求事件",
        "pipeline_events" => "流水线事件",
        "issues_events" => "议题事件",
        "tag_push_events" => "标签事件",
        "enable_ssl_verification" => "TLS 证书校验",
        "access_level" | "group_access" => "角色",
        "expires_at" => "到期时间",
        _ => key,
    }
}

fn display_value(key: &str, value: &Value) -> String {
    if matches!(key, "access_level" | "group_access") {
        return match value.as_u64() {
            Some(10) => "Guest",
            Some(20) => "Reporter",
            Some(30) => "Developer",
            Some(40) => "Maintainer",
            Some(50) => "Owner",
            _ => "其他角色",
        }
        .into();
    }
    match value {
        Value::Null => "未设置".into(),
        Value::Bool(v) => if *v { "开启" } else { "关闭" }.into(),
        Value::String(v) => v.clone(),
        _ => value.to_string(),
    }
}

pub fn differences(before: Option<&Value>, body: &Value) -> Vec<Change> {
    body.as_object()
        .expect("planner constructs object payloads")
        .iter()
        .filter(|(key, value)| {
            !matches!(key.as_str(), "id" | "user_id" | "group_id")
                && before.and_then(|b| b.get(*key)) != Some(*value)
        })
        .map(|(key, value)| Change {
            field: field_label(key).into(),
            before: before
                .and_then(|b| b.get(key))
                .map(|v| display_value(key, v)),
            after: Some(display_value(key, value)),
        })
        .collect()
}

fn validate_webhook_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| invalid("Webhook 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "Webhook 地址必须为 HTTP / HTTPS，不能包含账号密码或片段",
        ));
    }
    Ok(())
}

/// Validate requested changes against the server's supported webhook fields.
fn validate_hook_request(request: &HookRequest, names_supported: bool) -> Result<()> {
    // 1. Validate the operation and explicitly selected targets.
    if !matches!(
        request.mode.as_str(),
        "ensure" | "create" | "update" | "delete"
    ) {
        return Err(invalid("Webhook 操作方式无效"));
    }
    if request.project_ids.is_empty() && request.targets.is_empty() {
        return Err(invalid("请选择仓库或 Webhook"));
    }
    if request.mode == "delete" && request.targets.is_empty() {
        return Err(invalid("删除必须明确选中具体 Webhook"));
    }
    if request.mode != "delete" {
        // 2. Validate changes before performing any project requests.
        validate_webhook_url(&request.match_url)?;
        if let Some(url) = &request.url {
            validate_webhook_url(url)?;
        }
        if !names_supported
            && (request.name.is_some()
                || request
                    .creation
                    .as_ref()
                    .is_some_and(|creation| creation.name.is_some()))
        {
            return Err(invalid(
                "当前 GitLab 版本不支持 Webhook 名称，请仅设置地址、事件和认证",
            ));
        }
        if request.name.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(invalid("已选择修改名称，请填写名称"));
        }
        if request.secret.as_ref().is_some_and(|s| s.trim().is_empty()) {
            return Err(invalid("已选择更新密钥，请填写新密钥；空白不会清空原密钥"));
        }
        if request.mode != "update" {
            let creation = request
                .creation
                .as_ref()
                .ok_or_else(|| invalid("缺少新增配置"))?;
            if names_supported
                && creation
                    .name
                    .as_ref()
                    .is_none_or(|name| name.trim().is_empty())
            {
                return Err(invalid("新增配置需要明确的名称"));
            }
        }
    }
    Ok(())
}

/// Classify only after a complete successful read. A failed read is never a missing Hook.
pub fn classify_hook(
    project: &Project,
    request: &HookRequest,
    hooks: &[Hook],
    hook_id: Option<u64>,
) -> Result<PlanItem> {
    let mut item = new_item(project, Resource::Hook);
    let matches: Vec<_> = hooks
        .iter()
        .filter(|h| match hook_id {
            Some(id) => h.id == id,
            None => h.url == request.match_url,
        })
        .collect();
    if request.mode == "create" && !matches.is_empty() {
        prepare_item(&mut item, Action::Skip, "已存在相同地址，未重复创建");
        return Ok(item);
    }
    let selected = request.choices.get(&project.id);
    if matches.len() > 1 && !matches.iter().any(|h| Some(&h.id) == selected) {
        item.action = Action::Conflict;
        item.message = "同一地址存在多个 Hook，请选择具体条目".into();
        item.candidates = matches
            .iter()
            .map(|h| HookChoice {
                id: h.id,
                name: h.name.clone(),
            })
            .collect();
        return Ok(item);
    }
    let existing = if matches.len() > 1 {
        matches.into_iter().find(|h| Some(&h.id) == selected)
    } else {
        matches.first().copied()
    };
    if request.mode == "delete" {
        match existing {
            Some(h) => {
                item.target_id = Some(h.id);
                item.before = Some(hook_snapshot(h));
                prepare_item(&mut item, Action::Delete, "删除指定 Webhook");
                item.changes.push(Change {
                    field: "Webhook".into(),
                    before: Some(h.url.clone()),
                    after: None,
                });
            }
            None => prepare_item(&mut item, Action::Skip, "指定 Webhook 已不存在"),
        }
        return Ok(item);
    }
    if existing.is_none() && request.mode == "update" {
        prepare_item(&mut item, Action::Skip, "目标不存在，仅修改模式不会新增");
        return Ok(item);
    }
    if existing.is_none() && hook_id.is_some() {
        item.message = "指定 Hook 已不存在，请重新选择".into();
        return Ok(item);
    }
    let target_url = request.url.as_deref().unwrap_or(
        existing
            .map(|h| h.url.as_str())
            .unwrap_or(&request.match_url),
    );
    if let Some(h) = existing {
        if h.url != target_url
            && request.secret.is_none()
            && (h.token_present != Some(false) || h.signing_token_present == Some(true))
        {
            item.message = "更换地址可能重置原认证，请重新提供接收端密钥后预览".into();
            return Ok(item);
        }
        if h.signing_token_present == Some(true) && request.secret.is_some() {
            item.message =
                "此 Hook 使用签名令牌；请在 GitLab 管理签名认证，避免替换为普通密钥".into();
            return Ok(item);
        }
        item.target_id = Some(h.id);
        item.before = Some(hook_snapshot(h));
    }
    let mut body = Map::new();
    // GitLab requires URL on PUT, even when it is unchanged. Other fields are sent only when selected.
    body.insert("url".into(), json!(target_url));
    if existing.is_none() {
        // Creation needs complete settings, independently of which existing fields the user patches.
        let creation = request
            .creation
            .as_ref()
            .ok_or_else(|| invalid("缺少新增配置"))?;
        if let Some(name) = &creation.name {
            body.insert("name".into(), json!(name.trim()));
        }
        body.extend(
            serde_json::to_value(&creation.events)?
                .as_object()
                .expect("events object")
                .clone(),
        );
        body.insert("enable_ssl_verification".into(), json!(creation.ssl));
    } else {
        if let Some(name) = &request.name {
            body.insert("name".into(), json!(name.trim()));
        }
        if let Some(events) = &request.events {
            body.extend(
                serde_json::to_value(events)?
                    .as_object()
                    .expect("events object")
                    .clone(),
            );
        }
        if let Some(ssl) = request.ssl {
            body.insert("enable_ssl_verification".into(), json!(ssl));
        }
    }
    item.body = Value::Object(body);
    item.changes = differences(item.before.as_ref(), &item.body);
    item.secret_required = request.secret.is_some();
    if item.secret_required {
        item.changes.push(Change {
            field: "认证密钥".into(),
            before: Some("不回显".into()),
            after: Some("使用本次提供的新密钥".into()),
        });
    }
    if existing.is_some() && item.changes.is_empty() {
        prepare_item(&mut item, Action::Skip, "所选字段一致，无需修改");
    } else {
        prepare_item(
            &mut item,
            if existing.is_some() {
                Action::Update
            } else {
                Action::Create
            },
            if existing.is_some() {
                "更新选定字段"
            } else {
                "新增缺失配置"
            },
        );
    }
    Ok(item)
}

/// Validate version-supported fields and project permissions before preparing webhook changes.
pub async fn hooks(
    client: &GitLab,
    connection: &Connection,
    request: HookRequest,
) -> Result<PreparedPlan> {
    // 1. Reject unsupported fields before scanning projects.
    let version = semver::Version::parse(&connection.version)
        .map_err(|_| invalid("GitLab 版本号格式无效，请重新检查连接"))?;
    validate_hook_request(&request, (version.major, version.minor) >= (17, 1))?;

    // 2. Read complete project configuration and classify the requested changes.
    let mut ids = request.project_ids.clone();
    ids.extend(request.targets.iter().map(|t| t.project_id));
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(*id));
    let mut items = vec![];
    for id in ids {
        let project = match client.project(id).await {
            Ok(p) => p,
            Err(e) => {
                items.push(failed_project(id, Resource::Hook, e.to_string()));
                continue;
            }
        };
        if let Some(error) = project_write_error(connection, &project) {
            let mut item = new_item(&project, Resource::Hook);
            item.message = error;
            items.push(item);
            continue;
        }
        let hooks = match client.hooks(id).await {
            Ok(h) => h,
            Err(e) => {
                let mut item = new_item(&project, Resource::Hook);
                item.message = format!("查询失败：{e}");
                items.push(item);
                continue;
            }
        };
        let targets: Vec<_> = request
            .targets
            .iter()
            .filter(|t| t.project_id == id)
            .collect();
        if targets.is_empty() {
            items.push(classify_hook(&project, &request, &hooks, None)?)
        } else {
            for target in targets {
                items.push(classify_hook(
                    &project,
                    &request,
                    &hooks,
                    Some(target.hook_id),
                )?)
            }
        }
    }
    // 3. Return a reviewable plan without writing to GitLab.
    let title = match request.mode.as_str() {
        "ensure" => "Webhook · 补齐并更新",
        "create" => "Webhook · 批量新增",
        "update" => "Webhook · 批量修改",
        _ => "Webhook · 批量删除",
    };
    Ok(PreparedPlan {
        plan: plan(connection, title, items),
        secret: request.secret,
    })
}

pub async fn permissions(
    client: &GitLab,
    connection: &Connection,
    request: PermissionRequest,
) -> Result<PreparedPlan> {
    if !matches!(request.mode.as_str(), "grant" | "update" | "revoke")
        || !matches!(request.subject_type.as_str(), "user" | "group")
    {
        return Err(invalid("授权操作方式无效"));
    }
    if request.project_ids.is_empty() && request.targets.is_empty() {
        return Err(invalid("请选择目标仓库"));
    }
    if request.targets.is_empty() && request.subject_ids.is_empty() {
        return Err(invalid("请选择授权对象"));
    }
    if request.mode != "revoke" && request.access_level.is_none() && !request.update_expiry {
        return Err(invalid("请选择要设置的角色或到期时间"));
    }
    if request
        .access_level
        .is_some_and(|level| !matches!(level, 10 | 20 | 30 | 40))
    {
        return Err(invalid("请选择 GitLab 支持的项目成员角色"));
    }
    if request.update_expiry
        && let Some(date) = &request.expires_at
    {
        let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| invalid("到期日期无效"))?;
        if date < chrono::Utc::now().date_naive() {
            return Err(invalid("到期日期不能早于今天"));
        }
    }
    let resource = if request.subject_type == "group" {
        Resource::Share
    } else {
        Resource::Member
    };
    let mut project_ids = request.project_ids.clone();
    project_ids.extend(request.targets.iter().map(|t| t.project_id));
    let mut seen = HashSet::new();
    project_ids.retain(|id| seen.insert(*id));
    let mut items = vec![];
    for project_id in project_ids {
        let project = match client.project(project_id).await {
            Ok(p) => p,
            Err(e) => {
                items.push(failed_project(project_id, resource, e.to_string()));
                continue;
            }
        };
        if let Some(error) = project_write_error(connection, &project) {
            let mut item = new_item(&project, resource);
            item.message = error;
            items.push(item);
            continue;
        }
        let mut subjects = request.subject_ids.clone();
        let targets: Vec<_> = request
            .targets
            .iter()
            .filter(|t| t.project_id == project_id)
            .collect();
        if !targets.is_empty() {
            subjects = targets.iter().map(|t| t.user_id).collect()
        }
        let mut unique = HashSet::new();
        subjects.retain(|id| unique.insert(*id));
        for subject_id in subjects {
            let mut item = new_item(&project, resource);
            item.target_id = Some(subject_id);
            let lookup = if resource == Resource::Member {
                match client
                    .get::<Member>(&format!("projects/{project_id}/members/{subject_id}"))
                    .await
                {
                    Ok(member) => {
                        item.subject = Some(member.name.clone());
                        Ok(Some(member_snapshot(&member)))
                    }
                    Err(e) if e.is_not_found() => Ok(None),
                    Err(e) => Err(e),
                }
            } else {
                client.shares(project_id).await.map(|shares| {
                    shares
                        .into_iter()
                        .find(|s| s.group_id == subject_id)
                        .map(|share| {
                            item.subject = Some(share.group_name.clone());
                            share_snapshot(&share)
                        })
                })
            };
            let before = match lookup {
                Ok(value) => value,
                Err(e) => {
                    item.message = format!("查询授权失败：{e}");
                    items.push(item);
                    continue;
                }
            };
            if item.subject.is_none() {
                let subject_name = if resource == Resource::Member {
                    client
                        .get::<User>(&format!("users/{subject_id}"))
                        .await
                        .map(|u| u.name)
                } else {
                    client
                        .get::<Group>(&format!("groups/{subject_id}"))
                        .await
                        .map(|g| g.name)
                };
                match subject_name {
                    Ok(name) => item.subject = Some(name),
                    Err(e) => {
                        item.message = format!("授权对象不可用：{e}");
                        items.push(item);
                        continue;
                    }
                }
            }
            item.before = before;
            if request.mode == "revoke" {
                let exists = item.before.is_some();
                prepare_item(
                    &mut item,
                    if exists { Action::Delete } else { Action::Skip },
                    if exists {
                        "撤销此直接授权；继承权限和其他来源保留"
                    } else {
                        "没有直接授权；继承权限不会被撤销"
                    },
                );
                items.push(item);
                continue;
            }
            if request.mode == "update" && item.before.is_none() {
                prepare_item(&mut item, Action::Skip, "没有直接授权，未新增成员");
                items.push(item);
                continue;
            }
            let role_key = if resource == Resource::Member {
                "access_level"
            } else {
                "group_access"
            };
            let mut body = Map::new();
            if let Some(level) = request.access_level {
                body.insert(role_key.into(), json!(level));
            }
            if request.update_expiry {
                body.insert("expires_at".into(), json!(request.expires_at));
            }
            if let Some(before) = &item.before {
                if resource == Resource::Member && request.access_level.is_none() {
                    // GitLab requires access_level even when only the expiry changes.
                    body.insert("access_level".into(), before["access_level"].clone());
                }
            } else {
                if request.access_level.is_none() {
                    item.message = "新增授权必须明确设置角色".into();
                    items.push(item);
                    continue;
                }
                body.insert(
                    if resource == Resource::Member {
                        "user_id"
                    } else {
                        "group_id"
                    }
                    .into(),
                    json!(subject_id),
                );
            }
            item.body = Value::Object(body);
            item.changes = differences(item.before.as_ref(), &item.body);
            if item.before.is_some() && item.changes.is_empty() {
                prepare_item(&mut item, Action::Skip, "角色与期限一致，无需修改")
            } else if item.before.is_some() && resource == Resource::Share {
                item.message = "GitLab 没有直接修改此群组共享的接口；请明确撤销后重新授权".into()
            } else {
                let existing = item.before.is_some();
                prepare_item(
                    &mut item,
                    if existing {
                        Action::Update
                    } else {
                        Action::Create
                    },
                    if existing {
                        "更新选定的授权字段"
                    } else {
                        "新增直接授权"
                    },
                )
            }
            items.push(item);
        }
    }
    let title = match request.mode.as_str() {
        "grant" => "权限 · 批量授权",
        "update" => "权限 · 批量修改",
        _ => "权限 · 批量撤销",
    };
    Ok(PreparedPlan {
        plan: plan(connection, title, items),
        secret: None,
    })
}
