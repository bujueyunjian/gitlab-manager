//! Real HTTP and SQLite boundaries, with fictional data and no system credential access.
#[path = "hook_query_tests.rs"]
mod hook_queries;
#[path = "read_tests.rs"]
mod reads;
#[path = "retry_scope_tests.rs"]
mod retry_scope;
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
/// Build an exact URL inspection query from fictional test input.
fn hook_query(value: impl Into<String>) -> WebhookQuery {
    WebhookQuery {
        field: WebhookMatchField::Url,
        value: value.into(),
    }
}

fn hook(id: u64) -> Hook {
    serde_json::from_value(json!({"id":id,"name":"Build","url":"https://hooks.example.com/gitlab",
        "push_events":true,"merge_requests_events":false,"pipeline_events":false,"issues_events":false,
        "tag_push_events":false,"enable_ssl_verification":true,"token_present":false,"signing_token_present":false})).unwrap()
}
/// Build a connection with verified write scope for planner and runner fixtures.
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
        scopes: Some(vec!["api".into()]),
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

/// Creation, updates and unchanged fields stay distinct while invalid explicit choices require reselection.
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
        Action::Conflict
    );
    request.choices.insert(1, 7);
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

/// An exact match found on a later page counts duplicates and ignores URL substrings.
#[tokio::test]
async fn webhook_check_reads_all_pages_and_matches_exact_urls() {
    let mut other = hook(1);
    other.url.push('/');
    let server = Server::new(vec![
        Reply {
            status: 200,
            body: json!([other]),
            headers: "Link: </api/v4/projects/9/hooks?page=2>; rel=\"next\"\r\n".into(),
        },
        reply(200, json!([hook(2), hook(3)])),
    ]);
    let checks = server
        .client()
        .check_webhooks(
            vec![9, 9],
            &hook_query(" https://hooks.example.com/gitlab "),
        )
        .await
        .unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0].project_id, 9);
    assert!(matches!(
        checks[0].result,
        WebhookPresence::Present { count: 2, .. }
    ));
    let json = serde_json::to_value(&checks[0]).unwrap();
    assert_eq!(json["status"], "present");
    assert_eq!(json["projectId"], 9);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.method == "GET"));
}

/// Only a successful full list can prove absence; API and decoding failures remain explicit.
#[tokio::test]
async fn webhook_check_does_not_turn_failed_reads_into_missing_hooks() {
    for (status, body, missing) in [
        (200, json!([]), true),
        (200, json!([{"id": 1}]), false),
        (
            403,
            json!({"message":"fictional-sensitive-upstream-value"}),
            false,
        ),
    ] {
        let server = Server::new(vec![reply(status, body)]);
        let checks = server
            .client()
            .check_webhooks(vec![1], &hook_query("https://hooks.example.com/gitlab"))
            .await
            .unwrap();
        assert_eq!(
            matches!(checks[0].result, WebhookPresence::Missing),
            missing
        );
        if !missing {
            assert!(matches!(checks[0].result, WebhookPresence::Error { .. }));
            assert!(
                !serde_json::to_string(&checks)
                    .unwrap()
                    .contains("fictional-sensitive-upstream-value")
            );
        }
    }
    let server = Server::new(vec![
        Reply {
            status: 200,
            body: json!([hook(1)]),
            headers: "Link: </api/v4/projects/1/hooks?page=2>; rel=\"next\"\r\n".into(),
        },
        reply(500, json!({"message":"unavailable"})),
    ]);
    let checks = server
        .client()
        .check_webhooks(vec![1], &hook_query("https://hooks.example.com/gitlab"))
        .await
        .unwrap();
    assert!(matches!(checks[0].result, WebhookPresence::Error { .. }));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

/// Reject unusable receiver URLs and empty scopes before making any GitLab request.
#[tokio::test]
async fn webhook_check_validates_its_boundary() {
    let server = Server::new(vec![]);
    for url in [
        "",
        "not-a-url",
        "ftp://hooks.example.com/hook",
        "https://hooks.example.com/hook#fragment",
    ] {
        assert!(
            server
                .client()
                .check_webhooks(vec![1], &hook_query(url))
                .await
                .is_err()
        );
    }
    let mut credential_url = url::Url::parse("https://hooks.example.com/hook").unwrap();
    credential_url.set_username("fictional").unwrap();
    credential_url.set_password(Some("fictional")).unwrap();
    assert!(
        server
            .client()
            .check_webhooks(vec![1], &hook_query(credential_url.as_str()))
            .await
            .is_err()
    );
    credential_url.set_username("").unwrap();
    assert!(
        server
            .client()
            .check_webhooks(vec![1], &hook_query(credential_url.as_str()))
            .await
            .is_err()
    );
    assert!(
        server
            .client()
            .check_webhooks(vec![], &hook_query("https://hooks.example.com/gitlab"))
            .await
            .is_err()
    );
    assert!(server.requests.lock().unwrap().is_empty());
}

/// Parallel inspection is bounded, keeps input order, and isolates each project's permission failure.
#[tokio::test]
async fn webhook_check_limits_concurrency_and_preserves_per_project_results() {
    use std::sync::atomic::AtomicUsize;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let captured_peak = peak.clone();
    let worker = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut workers = Vec::new();
        while workers.len() < 9 && std::time::Instant::now() < deadline {
            let (mut socket, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("fixture accept: {error}"),
            };
            let active = active.clone();
            let peak = captured_peak.clone();
            workers.push(thread::spawn(move || {
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 1024];
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let read = socket.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let header = String::from_utf8(bytes).unwrap();
                let path = header.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let id: u64 = path.split('/').nth(4).unwrap().parse().unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(40));
                let (status, body) = if id == 3 { (403, json!({"message":"forbidden"})) }
                    else if id == 2 { (200, json!([hook(1)])) } else { (200, json!([])) };
                let body = body.to_string();
                active.fetch_sub(1, Ordering::SeqCst);
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }));
        }
        let accepted = workers.len();
        for worker in workers {
            worker.join().unwrap();
        }
        accepted
    });
    let ids = vec![9, 3, 2, 1, 8, 4, 7, 6, 5, 2];
    let client = GitLab::new(&address, TEST_TOKEN.into()).unwrap();
    let checks = tokio::time::timeout(
        Duration::from_secs(5),
        client.check_webhooks(ids, &hook_query("https://hooks.example.com/gitlab")),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(worker.join().unwrap(), 9);
    assert!(peak.load(Ordering::SeqCst) > 1);
    assert!(peak.load(Ordering::SeqCst) <= 4);
    assert_eq!(
        checks.iter().map(|row| row.project_id).collect::<Vec<_>>(),
        [9, 3, 2, 1, 8, 4, 7, 6, 5]
    );
    assert!(matches!(checks[1].result, WebhookPresence::Error { .. }));
    assert!(matches!(
        checks[2].result,
        WebhookPresence::Present { count: 1, .. }
    ));
    assert!(matches!(checks[0].result, WebhookPresence::Missing));
}

/// A hook created after inspection and preview blocks the later create instead of duplicating it.
#[tokio::test]
async fn missing_webhook_creation_still_rechecks_before_writing() {
    let server = Server::new(vec![
        reply(200, json!([])),
        reply(200, json!(project())),
        reply(200, json!([])),
        reply(200, json!(project())),
        reply(200, json!([hook(7)])),
    ]);
    let checks = server
        .client()
        .check_webhooks(vec![1], &hook_query("https://hooks.example.com/gitlab"))
        .await
        .unwrap();
    assert!(matches!(checks[0].result, WebhookPresence::Missing));
    let mut request = request();
    request.mode = "create".into();
    let prepared = planner::hooks(&server.client(), &connection(&server.url), request)
        .await
        .unwrap();
    let (_dir, service) = service();
    let mut task = task(prepared.plan.items);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.items[0].status, ItemStatus::Failed);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(requests.iter().all(|request| request.method == "GET"));
}

/// Exact role filtering uses the displayed effective role and reads past nonmatching pages.
#[tokio::test]
async fn project_role_filter_matches_exact_effective_roles_across_pages() {
    let maintainer = project();
    let mut owner = maintainer.clone();
    owner.id = 2;
    owner.permissions = Some(Permissions {
        project_access: None,
        group_access: Some(Access { access_level: 50 }),
    });
    let mut developer = maintainer.clone();
    developer.id = 3;
    developer.permissions = Some(Permissions {
        project_access: Some(Access { access_level: 30 }),
        group_access: None,
    });
    let mut inherited_developer = developer.clone();
    inherited_developer.id = 4;
    inherited_developer.permissions = Some(Permissions {
        project_access: Some(Access { access_level: 20 }),
        group_access: Some(Access { access_level: 30 }),
    });
    let mut inherited_owner = developer.clone();
    inherited_owner.id = 5;
    inherited_owner.permissions.as_mut().unwrap().group_access = Some(Access { access_level: 50 });
    let mut unknown = developer.clone();
    unknown.id = 6;
    unknown.permissions = None;
    let server = Server::new(vec![
        Reply {
            status: 200,
            body: json!([maintainer, owner]),
            headers: "Link: </api/v4/projects?membership=true&min_access_level=30&search=Portal&archived=false&page=2>; rel=\"next\"\r\n".into(),
        },
        reply(200, json!([developer, inherited_developer, inherited_owner, unknown])),
    ]);
    let projects = server
        .client()
        .projects(&ProjectFilter {
            search: " Portal ".into(),
            archived: Some(false),
            access_level: Some(30),
        })
        .await
        .unwrap();
    assert_eq!(
        projects
            .iter()
            .map(|project| project.id)
            .collect::<Vec<_>>(),
        [3, 4]
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first_url = url::Url::parse(&format!("{}{}", server.url, requests[0].path)).unwrap();
    let query: HashMap<_, _> = first_url.query_pairs().collect();
    assert_eq!(query.get("min_access_level").unwrap(), "30");
    assert_eq!(query.get("search").unwrap(), "Portal");
    assert_eq!(query.get("archived").unwrap(), "false");
    assert_eq!(query.get("membership").unwrap(), "true");
    assert!(requests[1].path.ends_with("page=2"));
}

/// Every selectable role matches exactly; clearing the role filter retains unknown permissions too.
#[tokio::test]
async fn project_role_filter_supports_each_role_and_all_roles() {
    for selected in [None, Some(10), Some(20), Some(30), Some(40), Some(50)] {
        let mut candidates: Vec<_> = [10, 20, 30, 40, 50]
            .into_iter()
            .filter(|level| selected.is_none_or(|minimum| *level >= minimum))
            .map(|level| {
                let mut candidate = project();
                candidate.id = u64::from(level);
                candidate.permissions = Some(Permissions {
                    project_access: Some(Access {
                        access_level: level,
                    }),
                    group_access: None,
                });
                candidate
            })
            .collect();
        let mut unknown = project();
        unknown.id = 99;
        unknown.permissions = None;
        candidates.push(unknown);
        let mut empty_permissions = project();
        empty_permissions.id = 100;
        empty_permissions.permissions = Some(Permissions {
            project_access: None,
            group_access: None,
        });
        candidates.push(empty_permissions);
        let server = Server::new(vec![reply(200, json!(candidates))]);
        let filter: ProjectFilter = serde_json::from_value(json!({
            "search":"", "archived":null, "accessLevel":selected,
        }))
        .unwrap();
        let projects = server.client().projects(&filter).await.unwrap();
        let expected = selected
            .map(|level| vec![u64::from(level)])
            .unwrap_or_else(|| vec![10, 20, 30, 40, 50, 99, 100]);
        assert_eq!(
            projects
                .iter()
                .map(|project| project.id)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            server.requests.lock().unwrap()[0]
                .path
                .contains("min_access_level="),
            selected.is_some()
        );
    }
}

/// An unreadable later page must fail the exact-role query instead of exposing a partial result.
#[tokio::test]
async fn project_role_filter_propagates_later_page_failures() {
    for status in [403, 200] {
        let server = Server::new(vec![
            Reply {
                status: 200,
                body: json!([project()]),
                headers: "Link: </api/v4/projects?min_access_level=40&page=2>; rel=\"next\"\r\n"
                    .into(),
            },
            reply(
                status,
                if status == 403 {
                    json!({"message":"Forbidden"})
                } else {
                    json!([{"id":2}])
                },
            ),
        ]);
        let error = server
            .client()
            .projects(&ProjectFilter {
                search: String::new(),
                archived: None,
                access_level: Some(40),
            })
            .await
            .unwrap_err();
        if status == 403 {
            assert!(matches!(
                error,
                crate::error::Error::Api { status: 403, .. }
            ));
        } else {
            assert!(matches!(error, crate::error::Error::Json(_)));
        }
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
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

/// Generate fictional reflection forms that must not appear in public errors or persisted output.
fn encoded_secret_forms(value: &str) -> Vec<String> {
    let json = serde_json::to_string(value).unwrap();
    vec![
        value.to_owned(),
        json[1..json.len() - 1].to_owned(),
        value
            .chars()
            .map(|character| format!("\\u{:04x}", u32::from(character)))
            .collect(),
        url::form_urlencoded::byte_serialize(value.as_bytes()).collect(),
        value
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;"),
    ]
}

/// HTTP failures never persist reflected PATs, hook secrets or unrelated upstream private details.
#[tokio::test]
async fn http_errors_exclude_encoded_secrets_from_tasks_and_exports() {
    let access_token = "fictional-access-\"quoted\"&value";
    let secret = "fictional-hook-\"quoted\"&value";
    let access_forms = encoded_secret_forms(access_token);
    let secret_forms = encoded_secret_forms(secret);
    for status in [400, 500] {
        for (reflected_access, reflected_secret) in access_forms.iter().zip(&secret_forms) {
            let existing = hook(7);
            let mut request = request();
            request.secret = Some(secret.into());
            let item =
                planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
                    .unwrap();
            let server = Server::new(vec![
                reply(200, json!(project())),
                reply(200, json!([existing])),
                reply(
                    status,
                    json!({
                        "message": format!("upstream-private-detail {reflected_access} {reflected_secret}"),
                    }),
                ),
            ]);
            let client = GitLab::new(&server.url, access_token.into()).unwrap();
            let (directory, service) = service();
            let mut task = task(vec![item]);
            runner::execute(
                &service,
                &client,
                &mut task,
                None,
                Some(secret),
                &AtomicBool::new(false),
                &|| {},
            )
            .await
            .unwrap();
            let stored = service.db.task(&task.id).unwrap();
            let exported = runner::report(&stored);
            assert_eq!(
                stored.items[0].status,
                if status == 500 {
                    ItemStatus::Unknown
                } else {
                    ItemStatus::Failed
                }
            );
            assert!(stored.items[0].message.contains(&format!("HTTP {status}")));
            for output in [
                stored.items[0].message.as_str(),
                exported["items"][0]["message"].as_str().unwrap(),
            ] {
                assert!(
                    !output.contains("upstream-private-detail"),
                    "upstream content reached a stored outcome"
                );
                for forbidden in access_forms.iter().chain(&secret_forms) {
                    assert!(
                        !output.contains(forbidden),
                        "encoded credentials reached a stored outcome"
                    );
                }
            }
            // Inspect the test database and its WAL without touching the real application database.
            for entry in std::fs::read_dir(directory.path()).unwrap() {
                let path = entry.unwrap().path();
                if path.is_file() {
                    let bytes = std::fs::read(path).unwrap();
                    for forbidden in access_forms
                        .iter()
                        .chain(&secret_forms)
                        .chain(std::iter::once(&"upstream-private-detail".to_owned()))
                    {
                        assert!(
                            !bytes
                                .windows(forbidden.len())
                                .any(|window| window == forbidden.as_bytes()),
                            "upstream content reached SQLite storage"
                        );
                    }
                }
            }
        }
    }
}

/// Safe error messages preserve status, operation and write-result uncertainty for every caller.
#[tokio::test]
async fn http_error_metadata_is_preserved_without_response_content() {
    for (method, status) in [
        (reqwest::Method::GET, 401),
        (reqwest::Method::POST, 403),
        (reqwest::Method::PUT, 404),
        (reqwest::Method::DELETE, 409),
        (reqwest::Method::GET, 302),
        (reqwest::Method::PUT, 422),
        (reqwest::Method::POST, 429),
        (reqwest::Method::POST, 503),
        (reqwest::Method::PUT, 418),
    ] {
        let server = Server::new(vec![Reply {
            status,
            body: json!({"message": format!("response-private-detail {TEST_TOKEN}")}),
            headers: if status == 302 {
                "Location: https://other.example.com/response-private-detail\r\n".into()
            } else {
                String::new()
            },
        }]);
        let client = server.client();
        let error = if method == reqwest::Method::GET {
            client.get::<Value>("user").await.unwrap_err()
        } else {
            client
                .write(method.clone(), "projects/1/hooks", None)
                .await
                .unwrap_err()
        };
        let public = serde_json::to_value(&error).unwrap();
        assert_eq!(public["status"], status);
        assert!(
            public["message"]
                .as_str()
                .unwrap()
                .contains(method.as_str())
        );
        assert!(!public.to_string().contains("response-private-detail"));
        assert!(!public.to_string().contains(TEST_TOKEN));
        assert!(!format!("{error:?}").contains("response-private-detail"));
        assert_eq!(error.is_not_found(), status == 404);
        assert_eq!(error.write_is_uncertain(), status >= 500);
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

/// An incomplete failure body cannot replace the already received HTTP status with a body-read error.
#[tokio::test]
async fn http_failure_does_not_consume_the_response_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 1024];
        while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            let read = socket.read(&mut buffer).unwrap();
            assert!(read > 0);
            bytes.extend_from_slice(&buffer[..read]);
        }
        socket
            .write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9999\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
    });
    let error = GitLab::new(&address, TEST_TOKEN.into())
        .unwrap()
        .get::<Value>("user")
        .await
        .unwrap_err();
    worker.join().unwrap();
    assert!(matches!(
        error,
        crate::error::Error::Api { status: 403, .. }
    ));
    assert!(!error.write_is_uncertain());
}

/// Plain reflected credentials are excluded while authentication remains present on the HTTP request.
#[tokio::test]
async fn http_errors_exclude_plain_access_and_hook_secrets() {
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

/// A normal run updates and creates approved hooks while preserving all unselected fields.
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
        reply(200, json!([existing])),
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

/// An uncertain write stops later items and can be confirmed through reads without another write.
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
        reply(200, json!([existing])),
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

/// A valid reread with a changed field blocks the write instead of overwriting another user's edit.
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
        reply(200, json!([changed])),
    ]);
    let (_dir, service) = service();
    let mut task = task(vec![item]);
    runner::execute(
        &service,
        &server.client(),
        &mut task,
        None,
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(task.items[0].status, ItemStatus::Failed);
    assert!(task.items[0].message.contains("已与预览不一致"));
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

/// An expiry-only run preserves the existing role and verifies the returned member state.
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

/// A GitLab 13.10 connection must not depend on the newer token self-information route.
#[tokio::test]
async fn legacy_connection_does_not_request_token_self_information() {
    let user = json!({"id":10,"name":"Demo User","username":"demo-user"});
    let server = Server::new(vec![
        reply(200, user.clone()),
        reply(200, json!({"version":"13.10.5"})),
        reply(200, json!([])),
        reply(200, user),
        reply(200, json!({"version":"13.10.5"})),
        reply(200, json!([])),
    ]);
    let (_dir, service) = service();
    let saved = service
        .save_connection(ConnectionInput {
            id: None,
            name: "Legacy GitLab".into(),
            base_url: format!("{}/gitlab", server.url),
            token: TEST_TOKEN.into(),
        })
        .await
        .unwrap();
    let checked = service.check_connection(&saved.id).await.unwrap();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    for batch in requests.chunks(3) {
        assert_eq!(batch[0].path, "/gitlab/api/v4/user");
        assert_eq!(batch[1].path, "/gitlab/api/v4/version");
        assert_eq!(
            batch[2].path,
            "/gitlab/api/v4/projects?membership=true&per_page=1"
        );
        assert!(batch.iter().all(|request| request.method == "GET"));
    }
    assert!(saved.scopes.is_none());
    assert!(checked.scopes.is_none());
    assert!(checked.expires_at.is_none());
    let stored = service.db.connection(&saved.id).unwrap();
    assert!(serde_json::to_value(stored).unwrap()["scopes"].is_null());
    assert_eq!(service.credentials.get(&saved.id).unwrap(), TEST_TOKEN);
}

/// The 15.5 boundary determines endpoint selection, including CE/EE version suffixes.
#[tokio::test]
async fn token_info_uses_the_reported_version_boundary() {
    for (version, modern) in [("15.4.9-ee", false), ("15.5.0-ee", true), ("19.0.0", true)] {
        let body = if modern {
            json!({"scopes":["read_api"],"expires_at":null})
        } else {
            json!([])
        };
        let server = Server::new(vec![reply(200, body)]);
        let token = server.client().token_info(version).await.unwrap();
        assert_eq!(token.is_some(), modern);
        if let Some(token) = token {
            assert_eq!(token.scopes, ["read_api"]);
        }
        assert_eq!(
            server.requests.lock().unwrap()[0].path,
            if modern {
                "/api/v4/personal_access_tokens/self"
            } else {
                "/api/v4/projects?membership=true&per_page=1"
            }
        );
    }
}

/// Unauthenticated, forbidden, malformed and unsupported-scope responses never create a connection.
#[tokio::test]
async fn failed_connection_validation_does_not_store_metadata() {
    let user = json!({"id":10,"name":"Demo User","username":"demo-user"});
    let cases = vec![
        vec![reply(401, json!({"message":"Unauthorized"}))],
        vec![
            reply(200, user.clone()),
            reply(403, json!({"message":"Forbidden"})),
        ],
        vec![
            reply(200, user.clone()),
            reply(200, json!({"version":"13.10.5"})),
            reply(403, json!({"message":"Forbidden"})),
        ],
        vec![
            reply(200, user.clone()),
            reply(200, json!({"version":"invalid"})),
        ],
        vec![
            reply(200, user.clone()),
            reply(200, json!({"version":"19.0.0"})),
            reply(200, json!({"scopes":["read_user"]})),
        ],
        vec![
            reply(200, user.clone()),
            reply(200, json!({"version":"19.0.0"})),
            reply(200, json!({"unexpected":true})),
        ],
    ];
    for responses in cases {
        let expected_requests = responses.len();
        let server = Server::new(responses);
        let (_dir, service) = service();
        let result = service
            .save_connection(ConnectionInput {
                id: None,
                name: "Invalid connection".into(),
                base_url: server.url.clone(),
                token: TEST_TOKEN.into(),
            })
            .await;
        assert!(result.is_err());
        assert!(service.db.connections().unwrap().is_empty());
        assert_eq!(server.requests.lock().unwrap().len(), expected_requests);
    }
}

/// A modern server error must not silently switch to the legacy validation path.
#[tokio::test]
async fn modern_token_errors_remain_errors() {
    for status in [401, 403, 404, 500] {
        let server = Server::new(vec![reply(
            status,
            json!({"message":"Token lookup failed"}),
        )]);
        let error = server.client().token_info("15.5.0").await.err().unwrap();
        assert!(
            matches!(error, crate::error::Error::Api { status: actual, .. } if actual == status)
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

/// Refreshing an upgraded server replaces unknown scopes; failed refreshes preserve saved metadata.
#[tokio::test]
async fn checking_an_upgraded_server_refreshes_scopes_without_hiding_later_errors() {
    let user = json!({"id":10,"name":"Demo User","username":"demo-user"});
    let server = Server::new(vec![
        reply(200, user.clone()),
        reply(200, json!({"version":"13.10.5"})),
        reply(200, json!([])),
        reply(200, user.clone()),
        reply(200, json!({"version":"15.5.0"})),
        reply(
            200,
            json!({"scopes":["read_api"],"expires_at":"2099-12-31"}),
        ),
        reply(200, user),
        reply(200, json!({"version":"15.5.0"})),
        reply(404, json!({"error":"404 Not Found"})),
    ]);
    let (_dir, service) = service();
    let saved = service
        .save_connection(ConnectionInput {
            id: None,
            name: "Upgraded GitLab".into(),
            base_url: server.url.clone(),
            token: TEST_TOKEN.into(),
        })
        .await
        .unwrap();
    let checked = service.check_connection(&saved.id).await.unwrap();
    assert_eq!(checked.scopes, Some(vec!["read_api".into()]));
    assert_eq!(checked.expires_at.as_deref(), Some("2099-12-31"));
    assert_eq!(checked.revision, saved.revision);
    assert!(service.check_connection(&saved.id).await.is_err());
    assert_eq!(
        serde_json::to_value(service.db.connection(&saved.id).unwrap()).unwrap(),
        serde_json::to_value(checked).unwrap()
    );
}

/// Saved connections from earlier app versions retain their known scopes without migration.
#[test]
fn stored_scope_arrays_remain_readable() {
    let serialized = serde_json::to_value(connection("https://gitlab.example.com")).unwrap();
    assert_eq!(serialized["scopes"], json!(["api"]));
    let restored: Connection = serde_json::from_value(serialized).unwrap();
    assert_eq!(restored.scopes, Some(vec!["api".into()]));
}

/// Legacy hooks omit unsupported names and only succeed when GitLab confirms the write.
#[tokio::test]
async fn legacy_hook_writes_omit_names_and_preserve_permission_failures() {
    for status in [201, 403] {
        let mut returned_hook = json!(hook(8));
        for field in ["name", "token_present", "signing_token_present"] {
            returned_hook.as_object_mut().unwrap().remove(field);
        }
        let server = Server::new(vec![
            reply(200, json!(project())),
            reply(200, json!([])),
            reply(200, json!(project())),
            reply(200, json!([])),
            reply(
                status,
                if status == 201 {
                    returned_hook
                } else {
                    json!({"message":"403 Forbidden"})
                },
            ),
        ]);
        let mut legacy = connection(&server.url);
        legacy.version = "13.10.5".into();
        legacy.scopes = None;
        let mut request = request();
        request.name = None;
        request.creation.as_mut().unwrap().name = None;
        let prepared = planner::hooks(&server.client(), &legacy, request)
            .await
            .unwrap();
        assert_eq!(prepared.plan.items[0].action, Action::Create);
        assert!(prepared.plan.items[0].body.get("name").is_none());
        let (_dir, service) = service();
        let mut task = task(prepared.plan.items);
        runner::execute(
            &service,
            &server.client(),
            &mut task,
            None,
            None,
            &AtomicBool::new(false),
            &|| {},
        )
        .await
        .unwrap();
        assert_eq!(
            task.items[0].status,
            if status == 201 {
                ItemStatus::Succeeded
            } else {
                ItemStatus::Failed
            }
        );
        if status == 403 {
            assert!(task.items[0].message.contains("403"));
        }
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        assert_eq!(requests[4].method, "POST");
        assert!(requests[4].body.get("name").is_none());
    }
}

/// Unknown legacy scopes do not bypass project restrictions or verified read-only scopes.
#[tokio::test]
async fn legacy_plans_keep_scope_and_project_permission_checks() {
    for (scopes, access_level, archived) in [
        (None, 30, false),
        (None, 40, true),
        (Some(vec!["read_api".into()]), 40, false),
    ] {
        let mut project = project();
        project.archived = archived;
        project
            .permissions
            .as_mut()
            .unwrap()
            .project_access
            .as_mut()
            .unwrap()
            .access_level = access_level;
        let server = Server::new(vec![reply(200, json!(project))]);
        let mut legacy = connection(&server.url);
        legacy.version = "13.10.5".into();
        legacy.scopes = scopes;
        let mut request = request();
        request.name = None;
        request.creation.as_mut().unwrap().name = None;
        let prepared = planner::hooks(&server.client(), &legacy, request)
            .await
            .unwrap();
        assert_eq!(prepared.plan.items[0].status, ItemStatus::Blocked);
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

/// A caller cannot send webhook names before 17.1, even if it bypasses the UI controls.
#[tokio::test]
async fn webhook_name_support_is_checked_at_the_backend_boundary() {
    for (version, supported) in [
        ("13.10.5", false),
        ("17.0.8-ee", false),
        ("17.1.0-ee", true),
    ] {
        let responses = if supported {
            vec![reply(200, json!(project())), reply(200, json!([]))]
        } else {
            vec![]
        };
        let server = Server::new(responses);
        let mut connection = connection(&server.url);
        connection.version = version.into();
        let result = planner::hooks(&server.client(), &connection, request()).await;
        assert_eq!(result.is_ok(), supported);
        if let Ok(prepared) = result {
            assert_eq!(prepared.plan.items[0].body["name"], "Delivery");
        } else {
            assert!(server.requests.lock().unwrap().is_empty());
        }
    }
}

/// Modern save and refresh retain token scopes while credentials stay outside serialized metadata.
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
        reply(200, version),
        reply(200, token),
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
            "/gitlab/api/v4/version",
            "/gitlab/api/v4/personal_access_tokens/self",
        ]
    );
    assert_eq!(service.credentials.get(&connection.id).unwrap(), TEST_TOKEN);
    assert!(
        !serde_json::to_string(&service.db.connections().unwrap())
            .unwrap()
            .contains(TEST_TOKEN)
    );
}

/// A stop received before dispatch retains unsent work and never sends an HTTP request.
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
