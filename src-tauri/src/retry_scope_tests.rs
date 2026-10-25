//! Exact retry scopes preserve unselected outcomes and whole-task persistence.
use super::*;

/// Build failures, an unsent item and an unknown result with distinct remote Hook IDs.
fn mixed_task() -> Task {
    let mut request = request();
    request.mode = "update".into();
    request.name = None;
    request.ssl = Some(false);
    let items = [
        ("retry-a", ItemStatus::Failed, 2),
        ("failed-b", ItemStatus::Failed, 3),
        ("pending-c", ItemStatus::Pending, 0),
        ("unknown-d", ItemStatus::Unknown, 1),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, status, attempts))| {
        let target_id = 7 + index as u64;
        let mut item =
            planner::classify_hook(&project(), &request, &[hook(target_id)], Some(target_id))
                .unwrap();
        item.id = id.into();
        item.status = status;
        item.message = format!("Stored result for {id}");
        item.attempts = attempts;
        item
    })
    .collect();
    let mut task = task(items);
    task.status = "paused".into();
    task
}

/// A successful Hook update confirms the requested TLS field without exposing a secret.
fn updated_hook(id: u64) -> Hook {
    let mut updated = hook(id);
    updated.enable_ssl_verification = false;
    updated
}

/// Retrying A leaves B/C/D byte-for-byte intact; a later continuation dispatches C alone.
#[tokio::test]
async fn selected_retry_does_not_dispatch_other_pending_items() {
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!(hook(7))),
        reply(200, json!(updated_hook(7))),
        reply(200, json!(project())),
        reply(200, json!(hook(9))),
        reply(200, json!(updated_hook(9))),
    ]);
    let (_directory, service) = service();
    service
        .db
        .save_connection(&connection(&server.url))
        .unwrap();
    let original = mixed_task();
    service.db.save_task(&original).unwrap();
    let (mut retried, scope) = service
        .prepare_resume(&original.id, Some(vec!["retry-a".into()]), None)
        .unwrap();
    assert_eq!(scope.as_ref().unwrap().len(), 1);
    runner::execute(
        &service,
        &server.client(),
        &mut retried,
        scope.as_ref(),
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(retried.items[0].status, ItemStatus::Succeeded);
    assert_eq!(retried.items[0].attempts, 3);
    assert_eq!(retried.status, "paused");
    assert_eq!(
        serde_json::to_value(&retried.items[1..]).unwrap(),
        serde_json::to_value(&original.items[1..]).unwrap()
    );
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| (request.method.clone(), request.path.clone()))
            .collect::<Vec<_>>(),
        vec![
            ("GET".into(), "/api/v4/projects/1".into()),
            ("GET".into(), "/api/v4/projects/1/hooks/7".into()),
            ("PUT".into(), "/api/v4/projects/1/hooks/7".into()),
        ]
    );

    // A restart retains all outcomes, and an explicit continuation handles only original pending C.
    service.db.recover_interrupted_tasks().unwrap();
    let saved = service.db.task(&retried.id).unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap(), json!(retried));
    let (mut continued, scope) = service.prepare_resume(&retried.id, None, None).unwrap();
    assert!(scope.is_none());
    runner::execute(
        &service,
        &server.client(),
        &mut continued,
        scope.as_ref(),
        None,
        &AtomicBool::new(false),
        &|| {},
    )
    .await
    .unwrap();
    assert_eq!(continued.items[2].status, ItemStatus::Succeeded);
    assert_eq!(continued.items[2].attempts, 1);
    assert_eq!(continued.status, "attention");
    for index in [0, 1, 3] {
        assert_eq!(json!(continued.items[index]), json!(retried.items[index]));
    }
    let saved = service.db.task(&continued.id).unwrap();
    assert_eq!(json!(saved), json!(continued));
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert!(requests.iter().all(|request| {
        !request.path.ends_with("/hooks/8") && !request.path.ends_with("/hooks/10")
    }));
    let writes: Vec<_> = requests
        .iter()
        .filter(|request| request.method == "PUT")
        .map(|request| request.path.as_str())
        .collect();
    assert_eq!(
        writes,
        ["/api/v4/projects/1/hooks/7", "/api/v4/projects/1/hooks/9"]
    );
    let exported = runner::report(&continued);
    assert_eq!(exported["items"][0]["attempts"], 3);
    assert_eq!(exported["items"][1]["message"], original.items[1].message);
    assert_eq!(exported["items"][3]["status"], "unknown");
}

/// A pending item outside a retry cannot demand a secret, while a selected secret update still does.
#[test]
fn secret_validation_uses_only_the_resumed_scope() {
    let (_directory, service) = service();
    service
        .db
        .save_connection(&connection("https://gitlab.example.com"))
        .unwrap();
    for selected_needs_secret in [false, true] {
        let mut original = mixed_task();
        original.items[0].secret_required = selected_needs_secret;
        original.items[2].secret_required = true;
        service.db.save_task(&original).unwrap();
        let retry = || Some(vec!["retry-a".into()]);
        assert_eq!(
            service.prepare_resume(&original.id, retry(), None).is_err(),
            selected_needs_secret
        );
        assert_eq!(
            service
                .prepare_resume(&original.id, retry(), Some(""))
                .is_err(),
            selected_needs_secret
        );
        let (prepared, scope) = service
            .prepare_resume(&original.id, retry(), Some("fictional-hook-secret"))
            .unwrap();
        assert_eq!(prepared.items[0].status, ItemStatus::Pending);
        assert!(scope.unwrap().contains("retry-a"));
        assert!(service.prepare_resume(&original.id, None, None).is_err());
        assert!(
            service
                .prepare_resume(&original.id, None, Some("fictional-hook-secret"))
                .is_ok()
        );
        assert_eq!(
            json!(service.db.task(&original.id).unwrap()),
            json!(original)
        );
    }
}

/// Invalid, empty, unsent and unknown selections fail before any persisted state can change.
#[test]
fn retries_accept_only_explicit_failed_items() {
    let (_directory, service) = service();
    service
        .db
        .save_connection(&connection("https://gitlab.example.com"))
        .unwrap();
    let original = mixed_task();
    service.db.save_task(&original).unwrap();
    for ids in [
        vec![],
        vec!["unknown-d".into()],
        vec!["pending-c".into()],
        vec!["retry-a".into(), "not-a-task-item".into()],
    ] {
        assert!(
            service
                .prepare_resume(&original.id, Some(ids), None)
                .is_err()
        );
        assert_eq!(
            json!(service.db.task(&original.id).unwrap()),
            json!(original)
        );
    }
}

/// Stopping dispatch preserves unsent entries, and restart recovery marks only running writes unknown.
#[tokio::test]
async fn stopped_retry_and_restart_preserve_unselected_items() {
    let server = Server::new(vec![]);
    let (_directory, service) = service();
    service
        .db
        .save_connection(&connection(&server.url))
        .unwrap();
    let original = mixed_task();
    service.db.save_task(&original).unwrap();
    let (mut stopped, scope) = service
        .prepare_resume(&original.id, Some(vec!["retry-a".into()]), None)
        .unwrap();
    let prepared_items = json!(stopped.items);
    runner::execute(
        &service,
        &server.client(),
        &mut stopped,
        scope.as_ref(),
        None,
        &AtomicBool::new(true),
        &|| {},
    )
    .await
    .unwrap();
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(json!(stopped.items), prepared_items);
    assert_eq!(stopped.status, "paused");
    let mut interrupted = stopped;
    interrupted.status = "running".into();
    interrupted.items[0].status = ItemStatus::Running;
    interrupted.items[0].attempts += 1;
    service.db.save_task(&interrupted).unwrap();
    service.db.recover_interrupted_tasks().unwrap();
    let recovered = service.db.task(&original.id).unwrap();
    assert_eq!(recovered.items[0].status, ItemStatus::Unknown);
    assert_eq!(recovered.items[0].attempts, 3);
    assert_eq!(json!(recovered.items[1..]), json!(original.items[1..]));
    assert!(
        service
            .prepare_resume(&original.id, Some(vec!["retry-a".into()]), None)
            .is_err()
    );
}
