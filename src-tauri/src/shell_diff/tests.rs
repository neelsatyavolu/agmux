use super::*;

#[tokio::test]
async fn actual_change_is_required_and_duplicate_completion_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    tokio::fs::write(&file, b"old\n").await.unwrap();
    let mut tracker = Tracker::default();
    tracker.begin("a", "1", dir.path(), vec![file.clone()], true).await;
    tokio::fs::write(&file, b"new\nextra\n").await.unwrap();
    let changes = tracker.finish("a", "1").await;
    assert_eq!(changes.len(), 1);
    assert_eq!((changes[0].added, changes[0].removed), (2, 1));
    assert!(tracker.finish("a", "1").await.is_empty());
    tracker.begin("a", "2", dir.path(), vec![file], true).await;
    assert!(tracker.finish("a", "2").await.is_empty());
}

#[tokio::test]
async fn overlapping_shell_or_native_edit_is_not_attributed_to_either_owner() {
    for native in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        tokio::fs::write(&file, b"old\n").await.unwrap();
        let mut tracker = Tracker::default();
        tracker.begin("a", "1", dir.path(), vec![file.clone()], true).await;
        tracker.begin("b", "2", dir.path(), vec![file.clone()], !native).await;
        tokio::fs::write(&file, b"new\n").await.unwrap();
        assert!(tracker.finish("a", "1").await.is_empty());
        assert!(tracker.finish("b", "2").await.is_empty());
    }
}

#[tokio::test]
async fn independent_files_can_be_attributed_concurrently() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.txt");
    let b = dir.path().join("b.txt");
    let mut tracker = Tracker::default();
    tracker.begin("a", "1", dir.path(), vec![a.clone()], true).await;
    tracker.begin("b", "2", dir.path(), vec![b.clone()], true).await;
    tokio::fs::write(&a, b"a\n").await.unwrap();
    tokio::fs::write(&b, b"b\n").await.unwrap();
    assert_eq!(tracker.finish("a", "1").await.len(), 1);
    assert_eq!(tracker.finish("b", "2").await.len(), 1);
}

#[tokio::test]
async fn duplicate_start_keeps_original_baseline_and_missing_start_never_counts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    let mut tracker = Tracker::default();
    tracker.begin("a", "1", dir.path(), vec![file.clone()], true).await;
    tokio::fs::write(&file, b"new\n").await.unwrap();
    tracker.begin("a", "1", dir.path(), vec![file], true).await;
    assert_eq!(tracker.finish("a", "1").await[0].added, 1);
    assert!(tracker.finish("a", "missing").await.is_empty());
}

#[tokio::test]
async fn unreadable_binary_and_oversized_baselines_are_not_empty_files() {
    let dir = tempfile::tempdir().unwrap();
    for (name, content) in [("binary", vec![0, 1, 2]), ("large", vec![b'x'; MAX_BYTES + 1])] {
        let file = dir.path().join(name);
        tokio::fs::write(&file, content).await.unwrap();
        let mut tracker = Tracker::default();
        tracker.begin("a", name, dir.path(), vec![file.clone()], true).await;
        tokio::fs::write(&file, b"replacement\n").await.unwrap();
        assert!(tracker.finish("a", name).await.is_empty());
    }
}

#[tokio::test]
async fn unknown_target_writer_invalidates_overlapping_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    let mut tracker = Tracker::default();
    tracker.begin("a", "1", dir.path(), vec![file.clone()], true).await;
    tracker.begin("b", "unknown", dir.path(), vec![], false).await;
    tokio::fs::write(&file, b"new\n").await.unwrap();
    assert!(tracker.finish("a", "1").await.is_empty());
}

#[tokio::test]
async fn expired_writer_still_blocks_new_attribution_until_completion() {
    let dir = tempfile::tempdir().unwrap();
    let root = tokio::fs::canonicalize(dir.path()).await.unwrap();
    let file = root.join("a.txt");
    tokio::fs::write(&file, b"old\n").await.unwrap();
    let mut tracker = Tracker::default();
    tracker.begin_observed("slow", "1", &root, vec![file.clone()], true).await;
    tracker.pending.get_mut(&("slow".into(), "1".into())).unwrap().started = Instant::now() - MAX_AGE;
    let unrelated = tempfile::tempdir().unwrap();
    tracker.begin_observed("other", "other", unrelated.path(), vec![], false).await;
    tracker.finish("other", "other").await;
    tracker.begin_observed("new", "2", &root, vec![file.clone()], true).await;
    // The expired command can still write while the newly observed call runs.
    tokio::fs::write(&file, b"old\nslow writer\n").await.unwrap();
    assert!(tracker.finish("new", "2").await.is_empty());
    assert!(tracker.pending[&("slow".into(), "1".into())].before.is_empty());
    assert!(tracker.finish("slow", "1").await.is_empty());
    tracker.begin_observed("next", "3", &root, vec![file.clone()], true).await;
    tokio::fs::write(&file, b"replacement\n").await.unwrap();
    assert_eq!(tracker.finish("next", "3").await.len(), 1);
}

#[tokio::test]
async fn symlink_and_external_targets_are_never_snapshotted() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let external = outside.path().join("external.txt");
    tokio::fs::write(&external, b"outside\n").await.unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    assert!(safe_targets(dir.path(), vec![external.to_string_lossy().into_owned(), "link/external.txt".into()]).await.is_empty());
    let file_link = dir.path().join("file-link");
    std::os::unix::fs::symlink(&external, &file_link).unwrap();
    assert!(read_text(&file_link).await.is_none());
}

#[tokio::test]
async fn duplicate_persistence_and_session_aliases_do_not_inflate_counts() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(include_str!("../../migrations/040_shell_diff_events.sql")).execute(&pool).await.unwrap();
    let changes = vec![Change { path: PathBuf::from("a.txt"), added: 3, removed: 1 }];
    storage::persist(&pool, "owner", Some("native-1"), "tool-1", &changes).await.unwrap();
    storage::persist(&pool, "owner", Some("native-1"), "tool-1", &changes).await.unwrap();
    storage::persist(&pool, "owner", Some("native-2"), "tool-2", &changes).await.unwrap();
    let rows = serde_json::to_value(storage::list(&pool).await.unwrap()).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.iter().find(|r| r["ownerId"] == "owner").unwrap()["linesAdded"], 6);
    assert_eq!(rows.iter().find(|r| r["ownerId"] == "native-1").unwrap()["linesAdded"], 3);
    assert_eq!(rows.iter().find(|r| r["ownerId"] == "native-2").unwrap()["linesAdded"], 3);
}

#[tokio::test]
async fn python_and_shell_commands_are_measured_from_disk_and_ignored_files_stay_out() {
    let dir = tempfile::tempdir().unwrap();
    let root = tokio::fs::canonicalize(dir.path()).await.unwrap();
    assert!(tokio::process::Command::new("git").arg("init").arg("-q").arg(&root).status().await.unwrap().success());
    tokio::fs::write(root.join(".gitignore"), b"generated.txt\n").await.unwrap();
    tokio::fs::write(root.join("a.txt"), b"old\n").await.unwrap();
    let command = "python3 - <<'PY'\nfrom pathlib import Path\np=Path('a.txt')\ns=p.read_text()\ns=s.replace('old', 'new\\nextra')\np.write_text(s)\nPY\n";
    let input = json!({"cmd": command});
    let paths = safe_targets(&root, targets::shell_targets("exec_command", &input)).await;
    assert_eq!(paths, [root.join("a.txt")]);
    let mut tracker = Tracker::default();
    tracker.begin("a", "python", &root, paths, true).await;
    assert!(tokio::process::Command::new("sh").arg("-c").arg(command).current_dir(&root).status().await.unwrap().success());
    let changes = tracker.finish("a", "python").await;
    assert_eq!((changes[0].added, changes[0].removed), (2, 1));

    let paths = safe_targets(&root, targets::shell_targets("bash", &json!({"command": "printf hello > generated.txt"}))).await;
    assert!(paths.is_empty());
    assert!(targets::shell_targets("bash", &json!({"command": "cat a.txt"})).is_empty());
}

#[test]
fn yielded_command_outputs_are_not_completions() {
    assert!(yielded(&json!({"content": "Script running with cell ID 9"})));
    assert!(yielded(&json!({"output": "{\"session_id\": 42, \"output\": \"working\"}"})));
    assert!(!yielded(&json!({"content": "Process exited with code 0"})));
    assert!(!yielded(&json!({"output": {"session_id": 42, "exit_code": 0}})));
}

#[test]
fn cline_nested_hooks_keep_call_identity_and_exact_command_input() {
    let pre = json!({
        "taskId":"task-1", "workspaceRoots":["/repo"],
        "tool_call":{"id":"call-1","name":"execute_command","input":{"command":"echo hi > a.txt"}},
        "preToolUse":{"toolName":"execute_command","parameters":{"command":"echo hi > a.txt"}}
    });
    let post = json!({
        "taskId":"task-1", "tool_result":{"id":"call-1","name":"execute_command","input":{"command":"echo hi > a.txt"},"output":"done"}
    });
    let pre = normalize_hook_payload("pre-tool-use", &pre).unwrap();
    let post = normalize_hook_payload("post-tool-use", &post).unwrap();
    assert_eq!(pre["tool_use_id"], post["tool_use_id"]);
    assert_eq!(pre["tool_input"]["command"], "echo hi > a.txt");
    assert_eq!(pre["cwd"], "/repo");
    assert_eq!(pre["session_id"], "task-1");
    assert!(normalize_hook_payload("pre-tool-use", &json!({"tool_name":"Bash", "tool_input":{"command":"echo hi"}})).is_none());
}

#[test]
fn cline_legacy_hooks_preserve_unambiguous_matching_and_do_not_guess_workspace() {
    let pre = normalize_hook_payload("pre-tool-use", &json!({
        "workspaceRoots":["/one", "/two"],
        "preToolUse":{"toolName":"execute_command","parameters":{"command":"echo hi > a.txt"}}
    })).unwrap();
    let post = normalize_hook_payload("post-tool-use", &json!({
        "postToolUse":{"toolName":"execute_command","parameters":{"command":"echo hi > a.txt"},"result":"done"}
    })).unwrap();
    assert_eq!(pre["tool_input"], post["tool_input"]);
    assert!(pre["cwd"].is_null());
    assert!(pre["tool_use_id"].is_null());
}

#[tokio::test]
async fn observed_commands_do_not_assume_target_hints_are_exhaustive() {
    let dir = tempfile::tempdir().unwrap();
    let root = tokio::fs::canonicalize(dir.path()).await.unwrap();
    let a = root.join("a.txt");
    let b = root.join("b.txt");
    let mut tracker = Tracker::default();
    tracker.begin_observed("a", "1", &root, vec![a.clone()], true).await;
    tracker.begin_observed("b", "2", &root, vec![b.clone()], true).await;
    tokio::fs::write(&a, b"a\n").await.unwrap();
    tokio::fs::write(&b, b"b\n").await.unwrap();
    assert!(tracker.finish("a", "1").await.is_empty());
    assert!(tracker.finish("b", "2").await.is_empty());
}

#[tokio::test]
async fn heredoc_write_keeps_baseline_through_mixed_wait_wrapper() {
    let dir = tempfile::tempdir().unwrap();
    let root = tokio::fs::canonicalize(dir.path()).await.unwrap();
    let source = json!("text(await tools.exec_command({cmd:\"cat > new.ts <<'EOF'\\nexport const value = 1;\\nEOF\\n\",yield_time_ms:1000}));");
    let paths = exec_target_paths(&root, &source).await;
    assert_eq!(paths, [root.join("new.ts")]);
    let mut tracker = Tracker::default();
    tracker.begin_observed("owner", "write", &root, paths, true).await;
    let commands = targets::exec_commands(source.as_str().unwrap()).unwrap();
    assert!(tokio::process::Command::new("sh").arg("-c").arg(commands[0]["cmd"].as_str().unwrap())
        .current_dir(&root).status().await.unwrap().success());
    let running = json!({"session_id":79058,"exit_code":null,"wall_time_seconds":1.0,"output":"tests running"});
    assert!(tracker.continuations.output("owner", "write", &running).running);
    let related = tracker.continuations.link_wait("owner", "wait", &[(79058,0)]);
    assert_eq!(related, ["write"]);
    tracker.begin_observed_related("owner", "wait", &root, vec![], false, &related).await;
    let output = json!([
        {"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
        {"type":"input_text","text":json!({"exit_code":0,"wall_time_seconds":0.01,"output":"tests passed"}).to_string()},
        {"type":"input_text","text":json!({"exit_code":0,"wall_time_seconds":0.01,"output":"typecheck passed"}).to_string()}
    ]);
    let outcome = tracker.continuations.output("owner", "wait", &output);
    assert_eq!(outcome.completed, ["write"]);
    let changes = tracker.finish("owner", &outcome.completed[0]).await;
    assert_eq!(changes.len(), 1);
    assert_eq!((changes[0].added, changes[0].removed), (1,0));
    assert!(tracker.finish("owner", "wait").await.is_empty());
}

#[tokio::test]
async fn continuation_exemption_does_not_hide_another_writer() {
    let dir = tempfile::tempdir().unwrap();
    let root = tokio::fs::canonicalize(dir.path()).await.unwrap();
    let file = root.join("new.ts");
    let mut tracker = Tracker::default();
    tracker.begin_observed("owner", "write", &root, vec![file.clone()], true).await;
    tracker.begin_observed("other", "edit", &root, vec![file.clone()], true).await;
    tracker.begin_observed_related("owner", "wait", &root, vec![], false, &["write".into()]).await;
    tokio::fs::write(file, b"changed\n").await.unwrap();
    assert!(tracker.finish("owner", "write").await.is_empty());
    assert!(tracker.finish("other", "edit").await.is_empty());
}
