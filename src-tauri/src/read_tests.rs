//! Progress and concurrency regressions use loopback HTTP with fictional project metadata.
use super::*;
use std::sync::atomic::AtomicUsize;

/// Configure only the temporary database and memory credentials for a local fixture.
fn connected_service(address: &str) -> (tempfile::TempDir, Service) {
    let (directory, service) = service();
    service.db.save_connection(&connection(address)).unwrap();
    service.credentials.set("fixture", TEST_TOKEN).unwrap();
    (directory, service)
}

/// Delay concurrent responses to measure request overlap and force out-of-order completion.
fn concurrent_server(
    expected: usize,
    respond: fn(&str) -> (u16, Value),
) -> (String, Arc<AtomicUsize>, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let peak = Arc::new(AtomicUsize::new(0));
    let measured = peak.clone();
    let worker = thread::spawn(move || {
        let active = Arc::new(AtomicUsize::new(0));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut workers = Vec::new();
        while workers.len() < expected && std::time::Instant::now() < deadline {
            let (mut socket, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("fixture accept: {error}"),
            };
            let active = active.clone();
            let peak = measured.clone();
            workers.push(thread::spawn(move || {
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 2048];
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let headers = String::from_utf8(bytes).unwrap();
                let request = headers.lines().next().unwrap();
                assert!(request.starts_with("GET "));
                let path = request.split_whitespace().nth(1).unwrap().to_owned();
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(if path.ends_with('9') { 100 } else { 25 }));
                let (status, body) = respond(&path);
                let body = body.to_string();
                active.fetch_sub(1, Ordering::SeqCst);
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                path
            }));
        }
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect()
    });
    (address, peak, worker)
}

/// Input ordering and one completion per input must survive concurrent resolution and errors.
#[tokio::test]
async fn resolution_reports_real_progress_and_preserves_input_order() {
    let (address, peak, worker) = concurrent_server(9, |path| {
        let id: u64 = path.rsplit('-').next().unwrap().parse().unwrap();
        if id == 3 {
            return (403, json!({"message": TEST_TOKEN}));
        }
        let mut project = project();
        project.id = id;
        (200, json!(project))
    });
    let (_directory, service) = connected_service(&address);
    let inputs: Vec<_> = [9, 3, 2, 1, 8, 4, 7, 6, 5]
        .into_iter()
        .map(|id| format!("demo/project-{id}"))
        .collect();
    let mut updates = Vec::new();
    let rows = service
        .resolve_projects("fixture", inputs.clone(), |progress| {
            updates.push(progress);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(worker.join().unwrap().len(), 9);
    assert!((2..=4).contains(&peak.load(Ordering::SeqCst)));
    assert_eq!(
        rows.iter().map(|row| row.input.clone()).collect::<Vec<_>>(),
        inputs
    );
    assert_eq!(
        updates.iter().map(|p| p.completed).collect::<Vec<_>>(),
        (0..=9).collect::<Vec<_>>()
    );
    assert!(updates.iter().all(|p| p.total == 9));
    assert_eq!(updates.last().unwrap().failed, 1);
    assert!(rows[1].error.as_ref().unwrap().contains("403"));
    assert!(!serde_json::to_string(&rows).unwrap().contains(TEST_TOKEN));
}

/// Webhook page reads exclude member endpoints, deduplicate project IDs and count failed projects.
#[tokio::test]
async fn resource_reads_are_bounded_scoped_and_ordered() {
    let (address, peak, worker) = concurrent_server(18, |path| {
        let path = path.split('?').next().unwrap();
        assert!(!path.contains("members"));
        let id: u64 = path.split('/').nth(4).unwrap().parse().unwrap();
        if path.ends_with("/hooks") {
            return if id == 3 {
                (403, json!({"message": "forbidden"}))
            } else {
                (200, json!([]))
            };
        }
        let mut project = project();
        project.id = id;
        (200, json!(project))
    });
    let (_directory, service) = connected_service(&address);
    let mut updates = Vec::new();
    let rows = service
        .resources(
            "fixture",
            vec![9, 3, 2, 1, 8, 4, 7, 6, 5, 2],
            ResourceKind::Hooks,
            |progress| {
                updates.push(progress);
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(worker.join().unwrap().len(), 18);
    assert!((2..=4).contains(&peak.load(Ordering::SeqCst)));
    let encoded = serde_json::to_value(&rows).unwrap();
    assert_eq!(
        encoded
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["projectId"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [9, 3, 2, 1, 8, 4, 7, 6, 5]
    );
    assert!(rows.iter().all(|row| matches!(
        row,
        ProjectResources::Ready {
            members: ReadResult::NotRequested,
            ..
        }
    )));
    assert!(matches!(
        &rows[1],
        ProjectResources::Ready {
            hooks: ReadResult::Error { .. },
            ..
        }
    ));
    assert_eq!(
        updates.iter().map(|p| p.completed).collect::<Vec<_>>(),
        (0..=9).collect::<Vec<_>>()
    );
    assert_eq!(updates.last().unwrap().failed, 1);
    assert!(updates.iter().all(|p| p.total == 9));
}

/// Authorization reads keep direct, inherited and shared permissions without requesting hooks.
#[tokio::test]
async fn member_page_never_reads_hooks() {
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!([])),
        reply(200, json!([])),
        reply(200, json!({"shared_with_groups":[]})),
    ]);
    let (_directory, service) = connected_service(&server.url);
    let mut updates = Vec::new();
    let rows = service
        .resources("fixture", vec![1], ResourceKind::Members, |progress| {
            updates.push(progress);
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        &rows[0],
        ProjectResources::Ready {
            hooks: ReadResult::NotRequested,
            members: ReadResult::Ready { .. },
            ..
        }
    ));
    assert_eq!(updates.last().unwrap().completed, 1);
    assert_eq!(updates.last().unwrap().failed, 0);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests
            .iter()
            .all(|request| !request.path.contains("hooks"))
    );
}

/// Initial progress failure must stop the read instead of silently falling back to a spinner.
#[tokio::test]
async fn failed_progress_delivery_stops_before_http_dispatch() {
    let server = Server::new(vec![]);
    let (_directory, service) = connected_service(&server.url);
    let result = service
        .resolve_projects("fixture", vec!["demo/project".into()], |_| {
            Err(invalid("progress closed"))
        })
        .await;
    assert!(result.is_err());
    assert!(server.requests.lock().unwrap().is_empty());
}

/// Metadata failures remain per-project rows while successful pipelines complete and report all inputs.
#[tokio::test]
async fn project_failure_keeps_partial_results_and_finishes_progress() {
    let (address, peak, worker) = concurrent_server(17, |path| {
        let path = path.split('?').next().unwrap();
        let id: u64 = path.split('/').nth(4).unwrap().parse().unwrap();
        if id == 3 {
            return (403, json!({"message":TEST_TOKEN}));
        }
        if path.ends_with("/hooks") {
            return if id == 4 {
                (403, json!({"message":TEST_TOKEN}))
            } else {
                (200, json!([]))
            };
        }
        let mut project = project();
        project.id = id;
        (200, json!(project))
    });
    let (_directory, service) = connected_service(&address);
    let mut updates = Vec::new();
    let rows = service
        .resources(
            "fixture",
            vec![9, 3, 2, 1, 8, 4, 7, 6, 5, 2],
            ResourceKind::Hooks,
            |progress| {
                updates.push(progress);
                Ok(())
            },
        )
        .await
        .unwrap();
    let requests = worker.join().unwrap();
    assert_eq!(requests.len(), 17);
    assert!(
        !requests
            .iter()
            .any(|path| path.contains("/projects/3/hooks"))
    );
    assert!((2..=4).contains(&peak.load(Ordering::SeqCst)));
    let encoded = serde_json::to_value(&rows).unwrap();
    assert_eq!(
        encoded
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["projectId"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [9, 3, 2, 1, 8, 4, 7, 6, 5]
    );
    assert_eq!(encoded[1]["status"], "error");
    assert!(encoded[1].get("project").is_none());
    assert!(encoded[1]["message"].as_str().unwrap().contains("403"));
    assert_eq!(encoded[5]["status"], "ready");
    assert_eq!(encoded[5]["hooks"]["status"], "error");
    assert_eq!(encoded[0]["hooks"]["status"], "ready");
    assert!(!encoded.to_string().contains(TEST_TOKEN));
    assert_eq!(
        updates
            .iter()
            .map(|progress| progress.completed)
            .collect::<Vec<_>>(),
        (0..=9).collect::<Vec<_>>()
    );
    assert!(updates.iter().all(|progress| progress.total == 9));
    assert_eq!(updates.last().unwrap().failed, 2);
}

/// Member reads retain metadata errors and member endpoint errors separately without losing other projects.
#[tokio::test]
async fn member_batch_retains_project_and_resource_failures() {
    let (address, peak, worker) = concurrent_server(31, |path| {
        let path = path.split('?').next().unwrap();
        assert!(!path.contains("hooks"));
        let id: u64 = path.split('/').nth(4).unwrap().parse().unwrap();
        if id == 3 {
            return (403, json!({"message":TEST_TOKEN}));
        }
        if path.contains("/members") {
            return if id == 4 {
                (403, json!({"message":TEST_TOKEN}))
            } else {
                (200, json!([]))
            };
        }
        let mut project = serde_json::to_value(project()).unwrap();
        project["id"] = json!(id);
        project["shared_with_groups"] = json!([]);
        (200, project)
    });
    let (_directory, service) = connected_service(&address);
    let mut updates = Vec::new();
    let rows = service
        .resources(
            "fixture",
            vec![9, 3, 2, 1, 8, 4, 7, 6, 5],
            ResourceKind::Members,
            |progress| {
                updates.push(progress);
                Ok(())
            },
        )
        .await
        .unwrap();
    let requests = worker.join().unwrap();
    assert_eq!(requests.len(), 31);
    assert!(
        !requests
            .iter()
            .any(|path| path.contains("/projects/3/members"))
    );
    assert!((2..=4).contains(&peak.load(Ordering::SeqCst)));
    let encoded = serde_json::to_value(rows).unwrap();
    assert_eq!(
        encoded
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["projectId"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [9, 3, 2, 1, 8, 4, 7, 6, 5]
    );
    assert_eq!(encoded[1]["status"], "error");
    assert!(encoded[1].get("project").is_none());
    assert_eq!(encoded[5]["status"], "ready");
    assert_eq!(encoded[5]["members"]["status"], "error");
    assert!(encoded[5]["members"].get("data").is_none());
    assert_eq!(encoded[0]["members"]["status"], "ready");
    assert!(!encoded.to_string().contains(TEST_TOKEN));
    assert_eq!(
        updates
            .iter()
            .map(|progress| progress.completed)
            .collect::<Vec<_>>(),
        (0..=9).collect::<Vec<_>>()
    );
    assert_eq!(updates.last().unwrap().failed, 2);
}

/// A missing connection and a closed progress channel still fail the whole invocation explicitly.
#[tokio::test]
async fn resource_connection_and_progress_failures_remain_global() {
    let server = Server::new(vec![reply(200, json!(project())), reply(200, json!([]))]);
    let (_directory, service) = connected_service(&server.url);
    let mut updates = Vec::new();
    assert!(
        service
            .resources("missing", vec![1], ResourceKind::Hooks, |progress| {
                updates.push(progress);
                Ok(())
            })
            .await
            .is_err()
    );
    assert!(updates.is_empty());
    assert!(
        service
            .resources("fixture", vec![1], ResourceKind::Hooks, |_| Err(invalid(
                "progress closed"
            )))
            .await
            .is_err()
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(
        service
            .resources("fixture", vec![1], ResourceKind::Hooks, |progress| {
                updates.push(progress);
                if progress.completed > 0 {
                    Err(invalid("progress closed"))
                } else {
                    Ok(())
                }
            })
            .await
            .is_err()
    );
    assert_eq!(updates.last().unwrap().completed, 1);
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

/// Concurrent lookup retains ambiguous candidates and successful empty matches for explicit selection.
#[tokio::test]
async fn resolution_keeps_ambiguous_and_missing_matches_distinct() {
    let mut other = project();
    other.id = 2;
    let server = Server::new(vec![
        reply(200, json!([project(), other])),
        reply(200, json!([])),
    ]);
    let (_directory, service) = connected_service(&server.url);
    let ambiguous = service
        .resolve_projects("fixture", vec!["Portal".into()], |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(ambiguous[0].candidates.len(), 2);
    let missing = service
        .resolve_projects("fixture", vec!["Unknown".into()], |_| Ok(()))
        .await
        .unwrap();
    assert!(missing[0].candidates.is_empty());
    assert!(missing[0].error.is_none());
}
