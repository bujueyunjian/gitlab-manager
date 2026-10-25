use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};

use reqwest::Method;
use serde_json::{Value, json};

use crate::{
    error::{Result, invalid},
    gitlab::GitLab,
    models::*,
    planner::{hook_snapshot, member_snapshot, share_snapshot},
    service::Service,
};

pub fn summarize(task: &mut Task) {
    task.status = if task.items.iter().any(|i| i.status == ItemStatus::Pending) {
        "paused"
    } else if task.items.iter().any(|i| {
        matches!(
            i.status,
            ItemStatus::Failed | ItemStatus::Unknown | ItemStatus::Blocked
        )
    }) {
        "attention"
    } else {
        "completed"
    }
    .into();
    task.updated_at = now();
}

async fn current(client: &GitLab, item: &PlanItem) -> Result<Option<Value>> {
    let id = item.target_id.ok_or_else(|| invalid("操作缺少目标 ID"))?;
    match item.resource {
        Resource::Hook => match client
            .get::<Hook>(&format!("projects/{}/hooks/{id}", item.project_id))
            .await
        {
            Ok(h) => Ok(Some(hook_snapshot(&h))),
            Err(e) if e.is_not_found() => Ok(None),
            Err(e) => Err(e),
        },
        Resource::Member => match client
            .get::<Member>(&format!("projects/{}/members/{id}", item.project_id))
            .await
        {
            Ok(m) => Ok(Some(member_snapshot(&m))),
            Err(e) if e.is_not_found() => Ok(None),
            Err(e) => Err(e),
        },
        Resource::Share => Ok(client
            .shares(item.project_id)
            .await?
            .iter()
            .find(|s| s.group_id == id)
            .map(share_snapshot)),
    }
}

/// Reread remote state before writing; a rename uses one fresh Hook list for identity and collision checks.
pub async fn preflight(client: &GitLab, item: &PlanItem) -> Result<()> {
    // 1. Recheck the repository before examining the target resource.
    if client.project(item.project_id).await?.archived {
        return Err(invalid("仓库已归档，请重新扫描"));
    }

    // 2. A renamed Hook needs the complete list, which also supplies its current snapshot.
    if item.resource == Resource::Hook
        && item.action == Action::Update
        && let Some(name) = item.body.get("name").and_then(Value::as_str)
        && item
            .before
            .as_ref()
            .and_then(|before| before.get("name"))
            .and_then(Value::as_str)
            != Some(name)
    {
        let hooks = client.hooks(item.project_id).await?;
        let target = hooks.iter().find(|hook| Some(hook.id) == item.target_id);
        if target.map(hook_snapshot) != item.before {
            return Err(invalid("目标已与预览不一致，请重新扫描；未覆盖他人的修改"));
        }
        if hooks
            .iter()
            .any(|hook| Some(hook.id) != item.target_id && hook.name.as_deref() == Some(name))
        {
            return Err(invalid(
                "执行前发现其他同名 Webhook，请重新核对名称；未修改配置",
            ));
        }
        return Ok(());
    }

    // 3. Creation checks absence; other writes compare the fresh resource to the approved snapshot.
    if item.action == Action::Create {
        let exists = if item.resource == Resource::Hook {
            client.hooks(item.project_id).await?.iter().any(|hook| {
                Some(hook.url.as_str()) == item.body.get("url").and_then(Value::as_str)
                    || item
                        .body
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| hook.name.as_deref() == Some(name))
            })
        } else {
            current(client, item).await?.is_some()
        };
        if exists {
            return Err(invalid("执行前发现目标已经存在，请重新扫描；未重复创建"));
        }
    } else if current(client, item).await? != item.before {
        return Err(invalid("目标已与预览不一致，请重新扫描；未覆盖他人的修改"));
    }
    Ok(())
}

async fn write(client: &GitLab, item: &PlanItem, secret: Option<&str>) -> Result<Value> {
    let prefix = format!("projects/{}", item.project_id);
    let id = item.target_id;
    let (method, path) = match (item.resource, item.action) {
        (Resource::Hook, Action::Create) => (Method::POST, format!("{prefix}/hooks")),
        (Resource::Hook, Action::Update) => (
            Method::PUT,
            format!(
                "{prefix}/hooks/{}",
                id.ok_or_else(|| invalid("缺少 Hook ID"))?
            ),
        ),
        (Resource::Hook, Action::Delete) => (
            Method::DELETE,
            format!(
                "{prefix}/hooks/{}",
                id.ok_or_else(|| invalid("缺少 Hook ID"))?
            ),
        ),
        (Resource::Member, Action::Create) => (Method::POST, format!("{prefix}/members")),
        (Resource::Member, Action::Update) => (
            Method::PUT,
            format!(
                "{prefix}/members/{}",
                id.ok_or_else(|| invalid("缺少成员 ID"))?
            ),
        ),
        (Resource::Member, Action::Delete) => (
            Method::DELETE,
            format!(
                "{prefix}/members/{}",
                id.ok_or_else(|| invalid("缺少成员 ID"))?
            ),
        ),
        (Resource::Share, Action::Create) => (Method::POST, format!("{prefix}/share")),
        (Resource::Share, Action::Delete) => (
            Method::DELETE,
            format!(
                "{prefix}/share/{}",
                id.ok_or_else(|| invalid("缺少群组 ID"))?
            ),
        ),
        _ => return Err(invalid("该条目没有可执行的写操作")),
    };
    let mut body = item.body.clone();
    if item.secret_required {
        let secret = secret
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("缺少本次接收端密钥"))?;
        body["token"] = json!(secret);
    }
    let body = if method == Method::DELETE {
        None
    } else {
        Some(&body)
    };
    client.write(method, &path, body).await
}

/// Persist the entire task while dispatching pending items only within this run's approved scope.
pub async fn execute(
    service: &Service,
    client: &GitLab,
    task: &mut Task,
    item_ids: Option<&HashSet<String>>,
    secret: Option<&str>,
    stop: &AtomicBool,
    progress: &(dyn Fn() + Send + Sync),
) -> Result<()> {
    // 1. Dispatch only approved pending items; other entries retain their outcome and attempt count.
    for index in 0..task.items.len() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if task.items[index].status != ItemStatus::Pending
            || item_ids.is_some_and(|ids| !ids.contains(&task.items[index].id))
        {
            continue;
        }
        task.items[index].status = ItemStatus::Running;
        task.items[index].attempts += 1;
        task.items[index].message = "正在检查当前配置".into();
        // Persist before sending. A restart can then distinguish an unconfirmed write from an unsent item.
        service.db.save_task(task)?;
        progress();
        let outcome = preflight(client, &task.items[index]).await;
        if let Err(error) = outcome {
            task.items[index].status = ItemStatus::Failed;
            task.items[index].message = error.to_string();
        } else if stop.load(Ordering::Acquire) {
            task.items[index].status = ItemStatus::Pending;
            task.items[index].message = "尚未发送".into();
        } else {
            match write(client, &task.items[index], secret).await {
                Ok(response) => {
                    let item = &task.items[index];
                    let confirmed: Result<bool> = if item.action == Action::Delete {
                        Ok(true)
                    } else {
                        match item.resource {
                            Resource::Hook => serde_json::from_value::<Hook>(response.clone())
                                .map(|h| matches_body(&hook_snapshot(&h), &item.body))
                                .map_err(Into::into),
                            Resource::Member => serde_json::from_value::<Member>(response.clone())
                                .map(|m| matches_body(&member_snapshot(&m), &item.body))
                                .map_err(Into::into),
                            Resource::Share => current(client, item)
                                .await
                                .map(|v| v.is_some_and(|v| matches_body(&v, &item.body))),
                        }
                    };
                    if !matches!(confirmed, Ok(true)) {
                        // A 2xx may be a queued role promotion or an incomplete payload, not the requested state.
                        task.items[index].status = ItemStatus::Unknown;
                        task.items[index].message = match confirmed {
                            Err(error) => format!("{error}；写入后的状态尚未确认，请查询核实"),
                            _ => "GitLab 响应未能确认预期状态，请查询核实，不要直接重发".into(),
                        };
                        stop.store(true, Ordering::Release);
                    } else {
                        if task.items[index].action == Action::Create
                            && task.items[index].resource == Resource::Hook
                        {
                            task.items[index].target_id =
                                response.get("id").and_then(Value::as_u64);
                        }
                        task.items[index].status = ItemStatus::Succeeded;
                        task.items[index].message = "GitLab 已确认操作成功".into();
                    }
                }
                Err(error) => {
                    let unknown = error.write_is_uncertain();
                    task.items[index].status = if unknown {
                        ItemStatus::Unknown
                    } else {
                        ItemStatus::Failed
                    };
                    task.items[index].message = if unknown {
                        format!("{error}。服务端可能已写入，请先核实，不要直接重发")
                    } else {
                        error.to_string()
                    };
                    if unknown {
                        stop.store(true, Ordering::Release);
                    }
                }
            }
        }
        task.updated_at = now();
        service.db.save_task(task)?;
        progress();
    }
    // 2. Derive the task state from every entry and persist the complete result.
    summarize(task);
    service.db.save_task(task)?;
    Ok(())
}

fn matches_body(current: &Value, body: &Value) -> bool {
    body.as_object()
        .expect("stored mutation body is an object")
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "user_id" | "group_id"))
        .all(|(key, value)| current.get(key) == Some(value))
}

pub async fn reconcile(client: &GitLab, task: &mut Task) -> Result<()> {
    for item in task
        .items
        .iter_mut()
        .filter(|i| i.status == ItemStatus::Unknown)
    {
        // The API never returns a secret's value, so a GET cannot prove that a secret rotation succeeded.
        if item.secret_required {
            item.message = "密钥不回显，无法自动核实认证更新。请在接收端验证后填写核实结果".into();
            continue;
        }
        let observed = if item.resource == Resource::Hook && item.action == Action::Create {
            match client.hooks(item.project_id).await {
                Ok(hooks) => {
                    let matches: Vec<_> = hooks
                        .iter()
                        .filter(|h| Some(h.url.as_str()) == item.body["url"].as_str())
                        .collect();
                    if matches.len() > 1 {
                        item.message = "存在多个匹配 Hook，无法确定本次写入，请人工核实".into();
                        continue;
                    }
                    Ok(matches.first().map(|h| hook_snapshot(h)))
                }
                Err(e) => Err(e),
            }
        } else {
            current(client, item).await
        };
        match observed {
            Err(error) => {
                item.message = format!("核实失败：{error}；结果仍为未知");
            }
            Ok(value) => {
                let complete = if item.action == Action::Delete {
                    value.is_none()
                } else {
                    value.as_ref().is_some_and(|v| matches_body(v, &item.body))
                };
                if complete {
                    item.status = ItemStatus::Succeeded;
                    item.message = "已查询核实变更生效，未重复发送".into();
                } else if value == item.before || value.is_none() {
                    item.status = ItemStatus::Failed;
                    item.message = "已查询核实未达到目标状态，可选择重新预览或手动重试".into();
                } else {
                    item.message = "当前状态与预期及原状态都不同，请人工核实；不会自动重发".into();
                }
            }
        }
    }
    summarize(task);
    Ok(())
}

/// Export outcomes and user-supplied descriptions, excluding request bodies and stored snapshots.
pub fn report(task: &Task) -> Value {
    json!({"title":task.title,"connection":task.connection_name,"createdAt":task.created_at,"status":task.status,
        "items":task.items.iter().map(|i|json!({"project":i.project_path,"subject":i.subject,"resource":i.resource,
            "action":i.action,"status":i.status,"message":i.message,"attempts":i.attempts})).collect::<Vec<_>>()})
}
