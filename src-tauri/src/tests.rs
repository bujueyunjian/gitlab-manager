//! Real HTTP and SQLite boundaries, with fictional data and no system credential access.
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    credentials::Credentials,
    error::{Result, invalid},
    gitlab::GitLab,
    models::*,
    planner, runner,
    service::Service,
    storage::Database,
};

const TEST_TOKEN: &str = "fictional-access-token";

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, String>>);
impl Credentials for MemoryCredentials {
    fn get(&self, id: &str) -> Result<String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("missing test credential"))
    }
    fn set(&self, id: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

struct Reply {
    status: u16,
    body: Value,
    headers: String,
}
fn reply(status: u16, body: Value) -> Reply {
    Reply {
        status,
        body,
        headers: String::new(),
    }
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: String,
    body: Value,
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            let mut replies = VecDeque::from(replies);
            while !stopping.load(Ordering::Acquire) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                // macOS may inherit the listener's nonblocking flag on accepted sockets.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let header_end = loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0, "request ended before headers");
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0, "request ended before body");
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let mut first = headers.lines().next().unwrap().split_whitespace();
                captured.lock().unwrap().push(Request {
                    method: first.next().unwrap().into(),
                    path: first.next().unwrap().into(),
                    body: if length == 0 {
                        Value::Null
                    } else {
                        serde_json::from_slice(&bytes[header_end..]).unwrap()
                    },
                    headers,
                });
                let response = replies.pop_front().expect("unexpected extra HTTP request");
                let body = if response.status == 204 {
                    String::new()
                } else {
                    response.body.to_string()
                };
                write!(stream, "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", response.status, body.len(), response.headers, body).unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn client(&self) -> GitLab {
        GitLab::new(&self.url, TEST_TOKEN.into()).unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn project() -> Project {
    serde_json::from_value(
        json!({"id":1,"name":"Portal","path":"portal","path_with_namespace":"demo/portal",
        "web_url":"https://gitlab.example.com/demo/portal","archived":false,"visibility":"private",
        "permissions":{"project_access":{"access_level":40}}}),
    )
    .unwrap()
}
fn hook(id: u64) -> Hook {
    serde_json::from_value(json!({"id":id,"name":"Build","url":"https://hooks.example.com/gitlab",
        "push_events":true,"merge_requests_events":false,"pipeline_events":false,"issues_events":false,
        "tag_push_events":false,"enable_ssl_verification":true,"token_present":false,"signing_token_present":false})).unwrap()
}
fn connection(url: &str) -> Connection {
    Connection {
        id: "fixture".into(),
        name: "Test GitLab".into(),
        base_url: url.into(),
        revision: "revision".into(),
        user: User {
            id: 10,
            name: "Demo User".into(),
            username: "demo-user".into(),
            is_admin: Some(false),
        },
        scopes: vec!["api".into()],
        expires_at: None,
        version: "19.0.0".into(),
        checked_at: now(),
    }
}
fn request() -> HookRequest {
    serde_json::from_value(json!({"connectionId":"fixture","projectIds":[1],"targets":[],"mode":"ensure",
        "matchUrl":"https://hooks.example.com/gitlab","name":"Delivery","choices":{},
        "creation":{"name":"Delivery","ssl":true,"events":{"push_events":true,"merge_requests_events":false,
        "pipeline_events":false,"issues_events":false,"tag_push_events":false}}})).unwrap()
}
fn task(items: Vec<PlanItem>) -> Task {
    Task {
        id: "test-task".into(),
        connection_id: "fixture".into(),
        connection_revision: "revision".into(),
        connection_name: "Test GitLab".into(),
        title: "Batch hooks".into(),
        status: "running".into(),
        items,
        created_at: now(),
        updated_at: now(),
    }
}
fn service() -> (tempfile::TempDir, Service) {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::new(
        Database::open(&dir.path().join("test.sqlite")).unwrap(),
        Arc::new(MemoryCredentials::default()),
    );
    (dir, service)
}

#[test]
fn missing_existing_and_duplicate_hooks_have_distinct_plans() {
    let mut request = request();
    let existing = hook(7);
    let added = planner::classify_hook(&project(), &request, &[], None).unwrap();
    assert_eq!(added.action, Action::Create);
    assert_eq!(added.body["enable_ssl_verification"], true);
    let updated =
        planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
            .unwrap();
    assert_eq!(updated.action, Action::Update);
    assert!(
        updated.body.get("push_events").is_none(),
        "unselected fields must stay untouched"
    );
    let duplicate = [existing, hook(8)];
    let conflict = planner::classify_hook(&project(), &request, &duplicate, None).unwrap();
    assert_eq!(conflict.action, Action::Conflict);
    request.choices.insert(1, 8);
    assert_eq!(
        planner::classify_hook(&project(), &request, &duplicate, None)
            .unwrap()
            .target_id,
        Some(8)
    );
    request.name = Some("Build".into());
    assert_eq!(
        planner::classify_hook(&project(), &request, &[hook(7)], None)
            .unwrap()
            .action,
        Action::Skip
    );
}

#[test]
fn secrets_never_enter_serializable_plans_and_url_changes_require_authentication() {
    let mut request = request();
    let mut existing = hook(7);
    existing.token_present = None;
    request.url = Some("https://hooks.example.com/new".into());
    assert_eq!(
        planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
            .unwrap()
            .status,
        ItemStatus::Blocked
    );
    request.secret = Some("fictional-hook-secret".into());
    let item = planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
        .unwrap();
    assert!(item.secret_required);
    assert!(
        !serde_json::to_string(&item)
            .unwrap()
            .contains("fictional-hook-secret")
    );
    existing.signing_token_present = Some(true);
    assert_eq!(
        planner::classify_hook(&project(), &request, &[existing], None)
            .unwrap()
            .status,
        ItemStatus::Blocked
    );
}

#[tokio::test]
async fn scan_reads_all_pages_and_does_not_create_after_a_failed_page() {
    for second_status in [200, 403] {
        let server = Server::new(vec![
            reply(200, json!(project())),
            Reply {
                status: 200,
                body: json!([]),
                headers: "Link: </api/v4/projects/1/hooks?page=2>; rel=\"next\"\r\n".into(),
            },
            reply(
                second_status,
                if second_status == 200 {
                    json!([hook(7)])
                } else {
                    json!({"message":"forbidden"})
                },
            ),
        ]);
        let plan = planner::hooks(&server.client(), &connection(&server.url), request())
            .await
            .unwrap();
        assert_eq!(
            plan.plan.items[0].action,
            if second_status == 200 {
                Action::Update
            } else {
                Action::Blocked
            }
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests.iter().all(|r| r.method == "GET"));
        assert!(requests[2].path.ends_with("?page=2"));
    }
}

#[tokio::test]
async fn pagination_never_forwards_credentials_outside_the_instance() {
    let server = Server::new(vec![Reply {
        status: 200,
        body: json!([]),
        headers: "Link: <https://other.example.com/api/v4/projects>; rel=\"next\"\r\n".into(),
    }]);
    let error = server.client().hooks(1).await.unwrap_err();
    assert!(error.to_string().contains("范围之外"));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn errors_redact_access_and_hook_secrets() {
    let server = Server::new(vec![reply(
        400,
        json!({"message":format!("{TEST_TOKEN} fictional-hook-secret")}),
    )]);
    let error = server
        .client()
        .write(
            reqwest::Method::POST,
            "projects/1/hooks",
            Some(&json!({"token":"fictional-hook-secret"})),
        )
        .await
        .unwrap_err();
    let public = serde_json::to_string(&error).unwrap();
    assert!(!public.contains(TEST_TOKEN));
    assert!(!public.contains("fictional-hook-secret"));
    assert!(
        server.requests.lock().unwrap()[0]
            .headers
            .to_lowercase()
            .contains("private-token: fictional-access-token")
    );
}

#[tokio::test]
async fn batch_writes_existing_and_missing_hooks_without_changing_unselected_fields() {
    let request = request();
    let existing = hook(7);
    let updated =
        planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
            .unwrap();
    let created = planner::classify_hook(&project(), &request, &[], None).unwrap();
    let mut expected = existing.clone();
    expected.name = Some("Delivery".into());
    let mut created_response = expected.clone();
    created_response.id = 8;
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!(existing)),
        reply(200, json!(expected)),
        reply(200, json!(project())),
        reply(200, json!([])),
        reply(201, json!(created_response)),
    ]);
    let (_dir, service) = service();
    let mut task = task(vec![updated, created]);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.status, "completed");
    assert!(task.items.iter().all(|i| i.status == ItemStatus::Succeeded));
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[2].method, "PUT");
    assert_eq!(
        requests[2].body,
        json!({"name":"Delivery","url":"https://hooks.example.com/gitlab"})
    );
    assert_eq!(requests[5].method, "POST");
    assert_eq!(requests[5].body["push_events"], true);
    assert_eq!(service.db.task(&task.id).unwrap().status, "completed");
}

#[tokio::test]
async fn uncertain_write_stops_dispatch_and_is_reconciled_without_resending() {
    let existing = hook(7);
    let item = planner::classify_hook(
        &project(),
        &request(),
        std::slice::from_ref(&existing),
        None,
    )
    .unwrap();
    let mut expected = existing.clone();
    expected.name = Some("Delivery".into());
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!(existing)),
        reply(503, json!({"message":"upstream interrupted"})),
        reply(200, json!(expected)),
    ]);
    let (_dir, service) = service();
    let mut second = item.clone();
    second.id = "second".into();
    let mut task = task(vec![item, second]);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.items[0].status, ItemStatus::Unknown);
    assert_eq!(task.items[1].status, ItemStatus::Pending);
    runner::reconcile(&server.client(), &mut task)
        .await
        .unwrap();
    assert_eq!(task.items[0].status, ItemStatus::Succeeded);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == "PUT")
            .count(),
        1
    );
}

#[tokio::test]
async fn stale_snapshot_prevents_overwriting_another_users_change() {
    let existing = hook(7);
    let item = planner::classify_hook(
        &project(),
        &request(),
        std::slice::from_ref(&existing),
        None,
    )
    .unwrap();
    let mut changed = existing;
    changed.pipeline_events = true;
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!(changed)),
    ]);
    let (_dir, service) = service();
    let mut task = task(vec![item]);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.items[0].status, ItemStatus::Failed);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.method == "GET")
    );
}

#[tokio::test]
async fn accepted_requests_are_not_reported_as_completed() {
    let server = Server::new(vec![reply(202, json!({"message":"queued"}))]);
    let error = server
        .client()
        .write(reqwest::Method::DELETE, "projects/1/hooks/7", None)
        .await
        .unwrap_err();
    assert!(error.write_is_uncertain());
}

#[test]
fn restart_preserves_unknown_and_unsent_items_and_export_excludes_payloads() {
    let (_dir, service) = service();
    let mut sent = planner::classify_hook(&project(), &request(), &[], None).unwrap();
    let mut pending = sent.clone();
    pending.id = "unsent".into();
    sent.status = ItemStatus::Running;
    let task = task(vec![sent, pending]);
    service.db.save_task(&task).unwrap();
    service.db.recover_interrupted_tasks().unwrap();
    let recovered = service.db.task(&task.id).unwrap();
    assert_eq!(recovered.items[0].status, ItemStatus::Unknown);
    assert_eq!(recovered.items[1].status, ItemStatus::Pending);
    let report = runner::report(&recovered).to_string();
    assert!(!report.contains("hooks.example.com"));
    assert!(!report.contains("enable_ssl_verification"));
}

#[tokio::test]
async fn expiry_only_edit_preserves_role_and_confirms_the_member_response() {
    let before = json!({"id":20,"name":"Demo Developer","username":"demo-dev","access_level":30,"expires_at":"2099-12-31"});
    let mut after = before.clone();
    after["expires_at"] = Value::Null;
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, before.clone()),
        reply(200, json!(project())),
        reply(200, before),
        reply(200, after),
    ]);
    let request: PermissionRequest =
        serde_json::from_value(json!({"connectionId":"fixture","projectIds":[1],
        "subjectIds":[20],"targets":[],"subjectType":"user","mode":"update","updateExpiry":true}))
        .unwrap();
    let prepared = planner::permissions(&server.client(), &connection(&server.url), request)
        .await
        .unwrap();
    assert_eq!(
        prepared.plan.items[0].body,
        json!({"access_level":30,"expires_at":null})
    );
    let (_dir, service) = service();
    let mut task = task(prepared.plan.items);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.status, "completed");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[4].path, "/api/v4/projects/1/members/20");
    assert_eq!(requests[4].method, "PUT");
}

#[tokio::test]
async fn removing_a_non_direct_member_never_revokes_inherited_access() {
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(404, json!({"message":"not a direct member"})),
        reply(
            200,
            json!({"id":20,"name":"Demo Developer","username":"demo-dev"}),
        ),
    ]);
    let request: PermissionRequest =
        serde_json::from_value(json!({"connectionId":"fixture","projectIds":[1],
        "subjectIds":[20],"targets":[],"subjectType":"user","mode":"revoke","updateExpiry":false}))
        .unwrap();
    let prepared = planner::permissions(&server.client(), &connection(&server.url), request)
        .await
        .unwrap();
    assert_eq!(prepared.plan.items[0].action, Action::Skip);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.method == "GET")
    );
}

#[tokio::test]
async fn saving_a_connection_keeps_credentials_outside_the_database() {
    let user = json!({"id":10,"name":"Demo User","username":"demo-user"});
    let version = json!({"version":"19.0.0"});
    let token = json!({"scopes":["api"],"expires_at":"2099-12-31"});
    let server = Server::new(vec![
        reply(200, user.clone()),
        reply(200, version.clone()),
        reply(200, token.clone()),
        reply(200, user),
        reply(200, token),
        reply(200, version),
    ]);
    let (_dir, service) = service();
    let connection = service
        .save_connection(ConnectionInput {
            id: None,
            name: "Test GitLab".into(),
            base_url: format!("{}/gitlab", server.url),
            token: TEST_TOKEN.into(),
        })
        .await
        .unwrap();
    assert_eq!(connection.base_url, format!("{}/gitlab/", server.url));
    let checked = service.check_connection(&connection.id).await.unwrap();
    assert_eq!(checked.base_url, connection.base_url);
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.path.as_str())
            .collect::<Vec<_>>(),
        [
            "/gitlab/api/v4/user",
            "/gitlab/api/v4/version",
            "/gitlab/api/v4/personal_access_tokens/self",
            "/gitlab/api/v4/user",
            "/gitlab/api/v4/personal_access_tokens/self",
            "/gitlab/api/v4/version",
        ]
    );
    assert_eq!(service.credentials.get(&connection.id).unwrap(), TEST_TOKEN);
    assert!(
        !serde_json::to_string(&service.db.connections().unwrap())
            .unwrap()
            .contains(TEST_TOKEN)
    );
}

#[tokio::test]
async fn stopping_before_dispatch_leaves_work_available_for_resume() {
    let server = Server::new(vec![]);
    let (_dir, service) = service();
    let item = planner::classify_hook(&project(), &request(), &[], None).unwrap();
    let mut task = task(vec![item]);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        &AtomicBool::new(true),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.status, "paused");
    assert_eq!(task.items[0].status, ItemStatus::Pending);
    assert!(server.requests.lock().unwrap().is_empty());
}
