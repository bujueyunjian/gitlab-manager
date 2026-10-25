//! Exact name queries and duplicate guards use only fictional loopback fixtures.
use super::*;

/// Renaming cannot silently introduce a collision, but an unchanged duplicate name permits an explicit ID edit.
#[test]
fn renaming_checks_other_hooks_without_blocking_existing_duplicate_names() {
    let first = hook(7);
    let mut other = hook(8);
    other.name = Some("Taken".into());
    other.url = "https://hooks.example.com/another".into();
    let mut request = request();
    request.mode = "update".into();
    request.name = Some("Taken".into());
    let item = planner::classify_hook(
        &project(),
        &request,
        &[first.clone(), other.clone()],
        Some(7),
    )
    .unwrap();
    assert_eq!(item.status, ItemStatus::Blocked);
    other.name = first.name.clone();
    request.name = first.name.clone();
    request.ssl = Some(false);
    let item = planner::classify_hook(&project(), &request, &[first, other], Some(7)).unwrap();
    assert_eq!(item.action, Action::Update);
    assert_eq!(item.target_id, Some(7));
}

/// A same-name configuration appearing after a rename preview is detected before PUT.
#[tokio::test]
async fn rename_preflight_rechecks_collisions() {
    let first = hook(7);
    let mut request = request();
    request.mode = "update".into();
    request.name = Some("Taken".into());
    let item = planner::classify_hook(&project(), &request, std::slice::from_ref(&first), Some(7))
        .unwrap();
    let mut other = hook(8);
    other.name = Some("Taken".into());
    other.url = "https://hooks.example.com/another".into();
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!([first, other])),
    ]);
    assert!(runner::preflight(&server.client(), &item).await.is_err());
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method == "GET")
    );
}

/// The same capability boundary protects inspection and mutation planning on legacy instances.
#[test]
fn names_require_gitlab_17_1() {
    for version in ["13.10.5", "17.0.9-ee"] {
        assert!(!crate::gitlab::supports_webhook_names(version).unwrap());
    }
    for version in ["17.1.0", "19.0.0-ee"] {
        assert!(crate::gitlab::supports_webhook_names(version).unwrap());
    }
}

/// Full pagination preserves distinct Hook IDs and addresses even when their names are identical.
#[tokio::test]
async fn name_inspection_returns_all_exact_matches_without_secret_fields() {
    let first = hook(1);
    let mut second = hook(2);
    second.url = "https://hooks.example.com/another".into();
    let mut near = hook(3);
    near.name = Some("Build extra".into());
    let mut raw = json!(second);
    raw["token"] = json!("fictional-hidden-hook-secret");
    raw["signing_token"] = json!("fictional-hidden-signing-secret");
    let server = Server::new(vec![
        Reply {
            status: 200,
            body: json!([first, near]),
            headers: "Link: </api/v4/projects/1/hooks?page=2>; rel=\"next\"\r\n".into(),
        },
        reply(200, json!([raw])),
    ]);
    let query = WebhookQuery {
        field: WebhookMatchField::Name,
        value: " Build ".into(),
    };
    let result = server
        .client()
        .check_webhooks(vec![1], &query)
        .await
        .unwrap();
    let WebhookPresence::Present { count, hooks } = &result[0].result else {
        panic!("Expected named matches")
    };
    assert_eq!(*count, 2);
    assert_eq!(hooks.iter().map(|hook| hook.id).collect::<Vec<_>>(), [1, 2]);
    assert_ne!(hooks[0].url, hooks[1].url);
    let encoded = serde_json::to_string(&result).unwrap();
    assert!(!encoded.contains("fictional-hidden"));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

/// Blank names fail before network access; a failed name lookup never reports absence.
#[tokio::test]
async fn invalid_and_failed_name_queries_remain_errors() {
    let server = Server::new(vec![reply(403, json!({"message":"forbidden"}))]);
    let client = server.client();
    assert!(
        client
            .check_webhooks(
                vec![1],
                &WebhookQuery {
                    field: WebhookMatchField::Name,
                    value: " ".into()
                }
            )
            .await
            .is_err()
    );
    assert!(server.requests.lock().unwrap().is_empty());
    let result = client
        .check_webhooks(
            vec![1],
            &WebhookQuery {
                field: WebhookMatchField::Name,
                value: "Build".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(result[0].result, WebhookPresence::Error { .. }));
}

/// A different address does not authorize a second webhook under the same requested name.
#[test]
fn creation_blocks_same_name_at_another_address_but_existing_url_still_skips() {
    let mut request = request();
    request.creation.as_mut().unwrap().name = Some("Build".into());
    request.mode = "create".into();
    let existing = hook(7);
    assert_eq!(
        planner::classify_hook(&project(), &request, std::slice::from_ref(&existing), None)
            .unwrap()
            .action,
        Action::Skip
    );
    let mut other = existing;
    other.url = "https://hooks.example.com/another".into();
    for mode in ["create", "ensure"] {
        request.mode = mode.into();
        let item = planner::classify_hook(&project(), &request, std::slice::from_ref(&other), None)
            .unwrap();
        assert_eq!(item.status, ItemStatus::Blocked);
        assert!(item.message.contains("同名但地址不同"));
    }
    request.mode = "update".into();
    request.ssl = Some(false);
    request.name = None;
    let item = planner::classify_hook(&project(), &request, std::slice::from_ref(&other), Some(7))
        .unwrap();
    assert_eq!(item.action, Action::Update);
    assert_eq!(item.target_id, Some(7));
    assert_eq!(item.body["url"], other.url);
}

/// A same-name hook added after preview blocks dispatch even when its URL differs.
#[tokio::test]
async fn preflight_prevents_a_new_same_name_hook_from_being_duplicated() {
    let mut request = request();
    request.creation.as_mut().unwrap().name = Some("Build".into());
    let item = planner::classify_hook(&project(), &request, &[], None).unwrap();
    let mut existing = hook(7);
    existing.url = "https://hooks.example.com/another".into();
    let server = Server::new(vec![
        reply(200, json!(project())),
        reply(200, json!([existing])),
    ]);
    let (_directory, service) = service();
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
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.method == "GET"));
}

/// Unrelated names do not prevent creation, and legacy requests without a name remain URL-based.
#[tokio::test]
async fn preflight_allows_distinct_names_and_legacy_payloads() {
    for name in [Some("Other name".to_owned()), None] {
        let mut request = request();
        request.creation.as_mut().unwrap().name = name;
        let item = planner::classify_hook(&project(), &request, &[], None).unwrap();
        let mut existing = hook(7);
        existing.url = "https://hooks.example.com/another".into();
        let server = Server::new(vec![
            reply(200, json!(project())),
            reply(200, json!([existing])),
        ]);
        assert!(runner::preflight(&server.client(), &item).await.is_ok());
    }
}

/// A valid choice remains the target whether the matching list contains one or several hooks.
#[test]
fn selected_hook_stays_bound_when_candidates_shrink() {
    for mode in ["ensure", "update"] {
        let mut request = request();
        request.mode = mode.into();
        request.name = None;
        request.ssl = Some(false);
        request.choices.insert(1, 7);
        for hooks in [vec![hook(7), hook(8)], vec![hook(7)]] {
            let item = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(item.action, Action::Update);
            assert_eq!(item.target_id, Some(7));
            assert_eq!(item.before.as_ref().unwrap()["id"], 7);
        }
    }
}

/// A removed or moved choice cannot authorize the sole remaining URL match without explicit reselection.
#[test]
fn invalid_selected_hook_requires_reselection() {
    let mut moved = hook(7);
    moved.url = "https://hooks.example.com/moved".into();
    for mode in ["ensure", "update"] {
        let mut request = request();
        request.mode = mode.into();
        request.name = None;
        request.ssl = Some(false);
        request.choices.insert(1, 7);
        for hooks in [vec![hook(8)], vec![moved.clone(), hook(8)]] {
            let item = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(item.action, Action::Conflict);
            assert_eq!(item.status, ItemStatus::Blocked);
            assert_eq!(item.target_id, None);
            assert_eq!(item.before, None);
            assert_eq!(item.body, json!({}));
            assert!(item.changes.is_empty());
            assert_eq!(
                item.candidates
                    .iter()
                    .map(|hook| hook.id)
                    .collect::<Vec<_>>(),
                [8]
            );
            assert!(item.message.contains("重新选择"));

            request.choices.insert(1, 8);
            let selected = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(selected.action, Action::Update);
            assert_eq!(selected.target_id, Some(8));
            request.choices.insert(1, 7);
        }
    }
}

/// Losing every URL match blocks a previous choice instead of treating it as a missing new configuration.
#[test]
fn missing_selected_hook_blocks_creation_and_updates() {
    let mut moved = hook(7);
    moved.url = "https://hooks.example.com/moved".into();
    for mode in ["ensure", "update"] {
        let mut request = request();
        request.mode = mode.into();
        request.name = None;
        request.ssl = Some(false);
        request.choices.insert(1, 7);
        for hooks in [vec![], vec![moved.clone()]] {
            let item = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(item.action, Action::Blocked);
            assert_eq!(item.status, ItemStatus::Blocked);
            assert_eq!(item.target_id, None);
            assert_eq!(item.before, None);
            assert_eq!(item.body, json!({}));
            assert!(item.candidates.is_empty());
            assert!(item.changes.is_empty());
            assert!(item.message.contains("关闭弹窗"));
            assert!(item.message.contains("重新查询"));
        }
    }
}

/// A direct Hook ID takes precedence over unrelated generic choices and URL changes.
#[test]
fn explicit_hook_id_overrides_unrelated_choice() {
    let mut moved = hook(7);
    moved.url = "https://hooks.example.com/moved".into();
    for mode in ["ensure", "update"] {
        let mut request = request();
        request.mode = mode.into();
        request.name = None;
        request.ssl = Some(false);
        request.choices.insert(1, 8);
        let item = planner::classify_hook(&project(), &request, &[moved.clone(), hook(8)], Some(7))
            .unwrap();
        assert_eq!(item.action, Action::Update);
        assert_eq!(item.target_id, Some(7));
        assert_eq!(item.body["url"], moved.url);
        let missing = planner::classify_hook(&project(), &request, &[hook(8)], Some(7)).unwrap();
        assert_eq!(
            missing.action,
            if mode == "update" {
                Action::Skip
            } else {
                Action::Blocked
            }
        );
        assert_eq!(missing.target_id, None);
    }
}

/// Create-only keeps its explicit skip-or-create contract, including legacy requests with no name.
#[test]
fn create_only_keeps_skip_or_create_semantics_after_old_choices() {
    for legacy in [false, true] {
        let mut request = request();
        request.mode = "create".into();
        request.choices.insert(1, 7);
        if legacy {
            request.name = None;
            request.creation.as_mut().unwrap().name = None;
        }
        for hooks in [vec![hook(8)], vec![hook(7), hook(8)]] {
            let item = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(item.action, Action::Skip);
        }
        let mut moved = hook(7);
        moved.url = "https://hooks.example.com/moved".into();
        for hooks in [vec![], vec![moved]] {
            let item = planner::classify_hook(&project(), &request, &hooks, None).unwrap();
            assert_eq!(item.action, Action::Create);
            assert_eq!(item.body["url"], request.match_url);
            assert_eq!(item.body.get("name").is_none(), legacy);
        }
    }
}

/// Real read-only rescans keep the selected identity across modern and legacy URL workflows.
#[tokio::test]
async fn choice_rescans_require_reselection_on_modern_and_legacy_servers() {
    for version in ["19.0.0", "13.10.5"] {
        let mut first = hook(7);
        let mut second = hook(8);
        if version == "13.10.5" {
            first.name = None;
            second.name = None;
        }
        let server = Server::new(vec![
            reply(200, json!(project())),
            reply(200, json!([first, second.clone()])),
            reply(200, json!(project())),
            reply(200, json!([second.clone()])),
            reply(200, json!(project())),
            reply(200, json!([second])),
        ]);
        let mut connection = connection(&server.url);
        connection.version = version.into();
        if version == "13.10.5" {
            connection.scopes = None;
        }
        let make_request = |choice| {
            let mut request = request();
            request.name = None;
            request.ssl = Some(false);
            if version == "13.10.5" {
                request.creation.as_mut().unwrap().name = None;
            }
            request.choices.insert(1, choice);
            request
        };
        let client = server.client();
        let selected = planner::hooks(&client, &connection, make_request(7))
            .await
            .unwrap();
        assert_eq!(selected.plan.items[0].target_id, Some(7));
        let lost = planner::hooks(&client, &connection, make_request(7))
            .await
            .unwrap();
        assert_eq!(lost.plan.items[0].action, Action::Conflict);
        assert_eq!(lost.plan.items[0].target_id, None);
        assert_eq!(lost.plan.items[0].candidates[0].id, 8);
        let reselected = planner::hooks(&client, &connection, make_request(8))
            .await
            .unwrap();
        assert_eq!(reselected.plan.items[0].target_id, Some(8));
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests.iter().all(|request| request.method == "GET"));
    }
}
