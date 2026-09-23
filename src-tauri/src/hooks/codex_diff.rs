//! Synchronous Codex tool hooks capture file contents before shell execution.
use std::path::{Path, PathBuf};
use std::time::Duration;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const SCRIPT: &str = include_str!("codex_diff_hook.py");
const MATCHER: &str = "^(Bash|apply_patch)$";
static TRUST_RESULT: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

fn quote(value: &str) -> String { format!("'{}'", value.replace('\'', "'\\''")) }

fn hook_command(script: &Path) -> String {
    format!("if [ \"${{AGMUX_SHELL_DIFF_HOOK:-}}\" = 1 ]; then python3 {}; fi", quote(&script.to_string_lossy()))
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    Ok(dirs::home_dir().ok_or("Cannot locate Codex home")?.join(".codex"))
}

fn merge_hooks(config: &mut Value, command: &str) -> Result<(), String> {
    let root = config.as_object_mut().ok_or("Codex hooks.json must be an object")?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({})).as_object_mut().ok_or("Codex hooks must be an object")?;
    for event in ["PreToolUse", "PostToolUse"] {
        let groups = hooks.entry(event).or_insert_with(|| json!([])).as_array_mut().ok_or("Codex hook event must be an array")?;
        // Existing user/plugin hooks are independent. Never replace them or
        // grant blanket trust; ensure_trusted handles only our exact definition.
        if groups.iter().any(|group| group["hooks"].as_array().is_some_and(|handlers|
            handlers.iter().any(|handler| handler["command"] == command))) { continue; }
        groups.push(json!({"matcher":MATCHER, "hooks":[{
            "type":"command", "command":command, "timeout":10
        }]}));
    }
    Ok(())
}

fn ensure_script() -> Result<PathBuf, String> {
    let script = crate::paths::agmux_home().join("hooks/codex-diff-hook.py");
    if let Some(parent) = script.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
    }
    Ok(script)
}

fn install_at(path: &Path, script: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).ok();
    if metadata.as_ref().is_some_and(|m| m.file_type().is_symlink() || m.permissions().readonly()) {
        return Err("Codex hooks config is linked or read-only; leaving it unchanged".into());
    }
    let old = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let mut config = match &old {
        Some(text) => serde_json::from_str(text).map_err(|e| format!("Invalid Codex hooks.json: {e}"))?,
        None => json!({}),
    };
    let before = config.clone();
    merge_hooks(&mut config, &hook_command(script))?;
    if config == before { return Ok(()); }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    // Do not overwrite a concurrent config edit made while assembling ours.
    if std::fs::read_to_string(path).ok() != old { return Err("Codex hooks changed during update; retry on next start".into()); }
    let tmp = path.with_file_name(format!(".agmux-hooks-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, &serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Some(metadata) = metadata { std::fs::set_permissions(&tmp,metadata.permissions()).map_err(|e| e.to_string())?; }
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Installs hooks before launching agent processes. One shared config-only
/// child per app run; never creates a Codex thread or enables a global bypass.
/// Agent processes must set AGMUX_SHELL_DIFF_HOOK=1 to activate the installed hook.
pub async fn ensure_trusted() -> Result<(), String> {
    TRUST_RESULT.get_or_try_init(|| async {
        let script = ensure_script()?;
        // Trust keys contain the source path. Preserve symlink spelling used by
        // the real agent's CODEX_HOME rather than moving trust to its target.
        let home = std::path::absolute(codex_home()?).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        trust_with_child(&home, &hook_command(&script), Some(&script)).await
    }).await.map(|_| ())
}

// Return leaf edits only: never replace hooks.state or turn enabled=false back on.
fn trust_edits(list: &Value, path: &Path, command: &str) -> Result<Vec<Value>, String> {
    let entries = list["data"].as_array().ok_or("Invalid Codex hooks/list response")?;
    let path = path.to_str().ok_or("Codex hooks path is not UTF-8")?;
    let mut edits = Vec::new();
    for event in ["preToolUse", "postToolUse"] {
        let mut found = Vec::new();
        for entry in entries {
            if entry["errors"].as_array().is_none_or(|errors| !errors.is_empty()) {
                return Err("Codex hook discovery reported errors".into());
            }
            for hook in entry["hooks"].as_array().ok_or("Invalid Codex hook metadata")? {
                if hook["sourcePath"] == path && hook["source"] == "user"
                    && hook["isManaged"] == false && hook["pluginId"].is_null()
                    && hook["handlerType"] == "command" && hook["command"] == command
                    && hook["eventName"] == event && hook["matcher"] == MATCHER
                    && hook["timeoutSec"] == 10 && hook["async"] == false
                    && hook["statusMessage"].is_null() && hook["additionalContextLimit"].is_null() {
                    found.push(hook);
                }
            }
        }
        if found.len() != 1 { return Err(format!("Expected one exact agmux {event} hook, found {}",found.len())); }
        let hook = found[0];
        let key = hook["key"].as_str().ok_or("Missing Codex hook key")?;
        let hash = hook["currentHash"].as_str().ok_or("Missing Codex hook hash")?;
        if !hash.strip_prefix("sha256:").is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())) {
            return Err("Invalid Codex hook hash".into());
        }
        match (hook["enabled"].as_bool(), hook["trustStatus"].as_str()) {
            (Some(false), _) | (Some(true), Some("trusted")) => continue,
            (Some(true), Some("untrusted" | "modified")) => {},
            _ => return Err("Invalid Codex hook trust state".into()),
        }
        edits.push(json!({"keyPath":format!("hooks.state.{}.trusted_hash",json!(key)),
            "value":hash,"mergeStrategy":"upsert"}));
    }
    Ok(edits)
}

fn config_version(read: &Value, path: &Path) -> Result<String, String> {
    read["layers"].as_array().and_then(|layers| layers.iter().find(|layer|
        layer["name"]["type"] == "user" && layer["name"]["file"].as_str() == path.to_str()))
        .and_then(|layer| layer["version"].as_str()).map(str::to_owned)
        .ok_or_else(|| "Codex did not return the target user config version".into())
}

fn rpc_result(response: Value) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        return Err(format!("Codex config RPC failed: {error}"));
    }
    response.get("result").cloned().ok_or_else(|| "Codex config RPC omitted result".into())
}

struct TrustClient {
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    id: u64,
}

impl TrustClient {
    async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.id += 1;
        self.send(json!({"id":self.id,"method":method,"params":params})).await?;
        loop {
            let mut line = Vec::new();
            (&mut self.stdout).take(4 * 1024 * 1024).read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            if line.last() != Some(&b'\n') { return Err("Codex config RPC closed or exceeded frame limit".into()); }
            let response: Value = serde_json::from_slice(&line).map_err(|e| e.to_string())?;
            if response["id"] == self.id && response.get("method").is_none() { return Ok(response); }
            // No session/approval requests are expected from this config-only client.
            if response.get("id").is_some() { return Err("Unexpected Codex config RPC response/request".into()); }
        }
    }

    async fn trust(&mut self, home: &Path, command: &str, install: Option<&Path>) -> Result<(), String> {
        rpc_result(self.call("initialize",json!({"clientInfo":{"name":"agmux-hook-trust","version":"1"},
            "capabilities":{"experimentalApi":true}})).await?)?;
        self.send(json!({"method":"initialized","params":{}})).await?;
        if let Some(script) = install {
            // Probe capability before changing config on older CLIs.
            rpc_result(self.call("hooks/list",json!({"cwds":[home]})).await?)?;
            install_at(&home.join("hooks.json"),script)?;
        }
        let hooks_path = home.join("hooks.json");
        let config_path = home.join("config.toml");
        for attempt in 0..2 {
            let list = rpc_result(self.call("hooks/list",json!({"cwds":[home]})).await?)?;
            let edits = trust_edits(&list,&hooks_path,command)?;
            if edits.is_empty() { return Ok(()); }
            let read = rpc_result(self.call("config/read",json!({"cwd":home,"includeLayers":true})).await?)?;
            let version = config_version(&read,&config_path)?;
            let response = self.call("config/batchWrite",json!({"filePath":config_path,
                "expectedVersion":version,"edits":edits})).await?;
            if attempt == 0 && response["error"]["data"]["config_write_error_code"] == "configVersionConflict" { continue; }
            rpc_result(response)?;
            let verified = rpc_result(self.call("hooks/list",json!({"cwds":[home]})).await?)?;
            if !trust_edits(&verified,&hooks_path,command)?.is_empty() {
                return Err("Codex did not retain trust for agmux hooks".into());
            }
            return Ok(());
        }
        Err("Codex hook trust update conflicted".into())
    }
}

async fn trust_with_child(home: &Path, command: &str, install: Option<&Path>) -> Result<(), String> {
    let mut child = tokio::process::Command::new("codex")
        .arg("app-server").current_dir(home).env("CODEX_HOME",home)
        .env("PATH",crate::process::provider::build_augmented_path())
        .env_remove("AGMUX_SHELL_DIFF_HOOK")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true)
        .spawn().map_err(|e| format!("Cannot start Codex hook trust client: {e}"))?;
    let mut client = TrustClient {
        stdin:child.stdin.take().ok_or("Missing Codex config stdin")?,
        stdout:BufReader::new(child.stdout.take().ok_or("Missing Codex config stdout")?),id:0,
    };
    let result = tokio::time::timeout(Duration::from_secs(20),client.trust(home,command,install)).await
        .map_err(|_| "Codex hook trust timed out".to_string()).and_then(|r| r);
    drop(client); // Close stdin before waiting; owns only this temporary process.
    if tokio::time::timeout(Duration::from_secs(2),child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2),child.wait()).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listed_hook(event: &str) -> Value {
        json!({"key":format!("/fixture/hooks.json:{event}:0:0"),"sourcePath":"/fixture/hooks.json",
            "source":"user","isManaged":false,"handlerType":"command","command":"our-command",
            "eventName":event,"matcher":"^(Bash|apply_patch)$","timeoutSec":10,"async":false,
            "statusMessage":null,"additionalContextLimit":null,"pluginId":null,
            "enabled":true,"trustStatus":"untrusted","currentHash":format!("sha256:{}","a".repeat(64))})
    }
    fn listing(pre: Value, post: Value) -> Value {
        json!({"data":[{"cwd":"/fixture","errors":[],"hooks":[pre,post]}]})
    }
    #[test]
    fn trust_targets_only_exact_owned_definitions_and_preserves_disabled() {
        let pre = listed_hook("preToolUse");
        let mut post = listed_hook("postToolUse");
        post["enabled"] = json!(false);
        let mut input = listing(pre.clone(),post);
        let mut other = pre;
        other["command"] = json!("superset-notify");
        input["data"][0]["hooks"].as_array_mut().unwrap().push(other);
        let edits = trust_edits(&input,Path::new("/fixture/hooks.json"),"our-command").unwrap();
        assert_eq!(edits.len(),1);
        assert_eq!(edits[0]["keyPath"],"hooks.state.\"/fixture/hooks.json:preToolUse:0:0\".trusted_hash");
        assert!(edits[0]["value"].is_string());
        for (field,value) in [("sourcePath",json!("/other/hooks.json")),("command",json!("other")),
            ("matcher",json!(".*")),("timeoutSec",json!(30)),("async",json!(true)),
            ("isManaged",json!(true)),("handlerType",json!("mcpTool")),("statusMessage",json!("changed"))] {
            let mut changed = listed_hook("preToolUse");
            changed[field] = value;
            assert!(trust_edits(&listing(changed,listed_hook("postToolUse")),Path::new("/fixture/hooks.json"),"our-command").is_err(),"{field}");
        }
    }
    #[test]
    fn trust_rejects_missing_duplicate_or_invalid_hash_and_skips_trusted() {
        let pre = listed_hook("preToolUse");
        let mut post = listed_hook("postToolUse");
        post["currentHash"] = json!("not-a-hash");
        assert!(trust_edits(&listing(pre.clone(),post),Path::new("/fixture/hooks.json"),"our-command").is_err());
        let mut input = listing(pre.clone(),listed_hook("postToolUse"));
        input["data"][0]["hooks"].as_array_mut().unwrap().push(pre);
        assert!(trust_edits(&input,Path::new("/fixture/hooks.json"),"our-command").is_err());
        input["data"][0]["hooks"].as_array_mut().unwrap().pop();
        for h in input["data"][0]["hooks"].as_array_mut().unwrap() { h["trustStatus"] = json!("trusted"); }
        assert!(trust_edits(&input,Path::new("/fixture/hooks.json"),"our-command").unwrap().is_empty());
    }
    #[test]
    fn config_version_uses_only_the_target_user_layer_and_rpc_errors_fail() {
        let read = json!({"layers":[
            {"name":{"type":"system","file":"/fixture/config.toml"},"version":"wrong"},
            {"name":{"type":"user","file":"/other/config.toml"},"version":"other"},
            {"name":{"type":"user","file":"/fixture/config.toml"},"version":"expected"}
        ]});
        assert_eq!(config_version(&read,Path::new("/fixture/config.toml")).unwrap(),"expected");
        assert!(config_version(&read,Path::new("/missing/config.toml")).is_err());
        assert!(rpc_result(json!({"error":{"data":{"config_write_error_code":"configVersionConflict"}}})).is_err());
        assert!(rpc_result(json!({})).is_err());
    }
    #[test]
    fn registration_command_requires_runtime_gate_and_quotes_script_path() {
        assert_eq!(hook_command(Path::new("/app's hooks/worker.py")),
            "if [ \"${AGMUX_SHELL_DIFF_HOOK:-}\" = 1 ]; then python3 '/app'\\''s hooks/worker.py'; fi");
    }
    #[tokio::test]
    #[ignore = "Explicit opt-in: installed Codex config-only client, isolated temporary CODEX_HOME"]
    async fn installed_codex_trust_fixture_preserves_unrelated_and_disabled_state() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let hooks = home.join("hooks.json");
        let script = home.join("never-run.py");
        std::fs::write(&hooks,r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"superset-fixture"}]}]}}"#).unwrap();
        install_at(&hooks,&script).unwrap();
        let before = std::fs::read(&hooks).unwrap();
        let disabled_key = format!("{}:post_tool_use:0:0",hooks.display());
        let config = format!("# preserve comment\ncli_auth_credentials_store=\"ephemeral\"\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[hooks.state.superset]\nenabled=false\ntrusted_hash=\"untouched\"\n[hooks.state.{}]\nenabled=false\n",json!(disabled_key));
        std::fs::write(home.join("config.toml"),config).unwrap();
        trust_with_child(&home,&hook_command(&script),None).await.unwrap();
        let saved = std::fs::read_to_string(home.join("config.toml")).unwrap();
        let parsed: toml::Value = toml::from_str(&saved).unwrap();
        assert!(saved.contains("# preserve comment"));
        assert_eq!(parsed["hooks"]["state"]["superset"]["trusted_hash"].as_str(),Some("untouched"));
        assert_eq!(parsed["hooks"]["state"][&disabled_key]["enabled"].as_bool(),Some(false));
        assert!(parsed["hooks"]["state"][&disabled_key].get("trusted_hash").is_none());
        assert_eq!(std::fs::read(&hooks).unwrap(),before);
        assert_eq!(parsed["hooks"]["state"].as_table().unwrap().len(),3);
    }
    #[tokio::test]
    #[ignore = "Explicit opt-in: installed Codex config-only client in an isolated profile"]
    async fn installed_codex_probes_then_registers_and_trusts_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(home.join("config.toml"),"cli_auth_credentials_store=\"ephemeral\"\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n").unwrap();
        let script = home.join("capture.py");
        trust_with_child(&home,&hook_command(&script),Some(&script)).await.unwrap();
        let hooks: Value = serde_json::from_str(&std::fs::read_to_string(home.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(hooks["hooks"]["PreToolUse"].as_array().unwrap().len(),1);
        let config: toml::Value = toml::from_str(&std::fs::read_to_string(home.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["hooks"]["state"].as_table().unwrap().len(),2);
    }
    #[test]
    fn installs_only_own_sync_hooks_and_preserves_existing_hooks_and_trust() {
        let user = json!({"matcher":"Bash","hooks":[{"type":"command","command":"my-policy","state":{"enabled":false}}]});
        let mut config = json!({"description":"user hooks","hooks":{"PreToolUse":[user.clone()],"Stop":[{"hooks":[]}]}});
        merge_hooks(&mut config,"python3 '/app/hook.py'").unwrap();
        assert_eq!(config["hooks"]["PreToolUse"][0],user);
        assert_eq!(config["hooks"]["PreToolUse"].as_array().unwrap().len(),2);
        assert_eq!(config["hooks"]["PostToolUse"][0]["hooks"][0]["timeout"],10);
        assert!(config["hooks"]["PostToolUse"][0]["hooks"][0].get("async").is_none());
        let previous = config.clone();
        merge_hooks(&mut config,"python3 '/app/hook.py'").unwrap();
        assert_eq!(previous,config);
    }
    #[test]
    fn invalid_existing_config_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hooks.json");
        std::fs::write(&file,"not json").unwrap();
        assert!(install_at(&file,Path::new("/hook.py")).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(),"not json");
    }
}
