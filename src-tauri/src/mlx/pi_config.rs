//! Teaches the Pi CLI about agmux's local models.
//!
//! Merged into `~/.pi/agent/models.json` as the `local` provider. Pi has no
//! grok-style managed overlay, so this file is also where users keep their
//! own custom providers — we only ever write `providers.local`, and refuse
//! to touch that key when it already belongs to someone else.

use crate::mlx::types::MlxModel;
use serde_json::{json, Value};

/// `name` on the provider we write. Used as the ownership check so we never
/// overwrite a user's own `local` provider.
pub const SENTINEL_NAME: &str = "agmux-managed — local model provider (safe to delete)";
pub const PROVIDER_ID: &str = "local";
const API_KEY: &str = "agmux-local";

pub fn models_json_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("models.json"))
}

pub fn render_local_provider(models: &[MlxModel], port: u16) -> Value {
    let entries: Vec<Value> = models
        .iter()
        .filter(|m| m.supports_tools)
        .map(|m| {
            // Declared, not the model's native maximum: Pi compacts against
            // this, and the backend only has memory set aside for this much.
            let context = crate::mlx::memory::plan(m).context;
            json!({
                "id": m.id,
                "name": m.display_name,
                "reasoning": false,
                "input": ["text"],
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0
                },
                "contextWindow": context,
                "maxTokens": crate::mlx::memory::agent_max_output(context),
            })
        })
        .collect();
    json!({
        "name": SENTINEL_NAME,
        "baseUrl": format!("http://127.0.0.1:{port}/v1"),
        "api": "openai-completions",
        "apiKey": API_KEY,
        "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false
        },
        "models": entries
    })
}

/// Refresh the `local` provider from what is installed right now.
/// Refuses to overwrite a `providers.local` block agmux did not write.
pub fn write_managed_config() -> Result<(), String> {
    let path = models_json_path().ok_or("no home directory")?;
    let models = crate::mlx::discovery::scan_all();
    let provider = render_local_provider(&models, crate::mlx::MLX_PORT);
    write_managed_config_body(&path, provider)
}

/// Path-parameterized so the merge/refusal paths are testable against a
/// temp dir instead of the real `~/.pi/agent`.
fn write_managed_config_body(path: &std::path::Path, provider: Value) -> Result<(), String> {
    let mut root = match std::fs::read_to_string(path) {
        Ok(existing) if existing.trim().is_empty() => json!({ "providers": {} }),
        Ok(existing) => parse_models_json(&existing).map_err(|e| {
            format!(
                "cannot parse {} ({e}) — refusing to touch it. Add a `{PROVIDER_ID}` \
                 provider pointing at http://127.0.0.1:{}/v1 to use local models in the Pi terminal",
                path.display(),
                crate::mlx::MLX_PORT
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "providers": {} }),
        Err(e) => {
            return Err(format!(
                "cannot read {} ({e}) — refusing to touch it",
                path.display()
            ));
        }
    };

    if !root.is_object() {
        return Err(format!(
            "{} is not a JSON object — refusing to touch it",
            path.display()
        ));
    }

    let providers = root
        .as_object_mut()
        .unwrap()
        .entry("providers")
        .or_insert_with(|| json!({}));
    if !providers.is_object() {
        return Err(format!(
            "{} has a non-object `providers` key — refusing to touch it",
            path.display()
        ));
    }
    if let Some(existing) = providers.get(PROVIDER_ID) {
        if !is_agmux_local_provider(existing) {
            return Err(format!(
                "{} already has a `{PROVIDER_ID}` provider that was not written by agmux — \
                 add the agmux local block manually to use local models in the Pi terminal",
                path.display()
            ));
        }
    }
    providers[PROVIDER_ID] = provider;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    body.push('\n');
    std::fs::write(path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

fn is_agmux_local_provider(v: &Value) -> bool {
    if v.get("name").and_then(|n| n.as_str()) == Some(SENTINEL_NAME) {
        return true;
    }
    let key = v.get("apiKey").and_then(|k| k.as_str());
    let url = v.get("baseUrl").and_then(|u| u.as_str()).unwrap_or("");
    key == Some(API_KEY) && url.contains("127.0.0.1:") && url.contains("/v1")
}

fn parse_models_json(s: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str(s) {
        return Ok(v);
    }
    let stripped = strip_jsonc(s);
    serde_json::from_str(&stripped).map_err(|e| e.to_string())
}

/// Strip `//` and `/* */` comments and trailing commas so Pi's JSONC
/// `models.json` can still be merged. Strings are left intact.
fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = i.saturating_add(2).min(chars.len());
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mlx::types::{MlxModel, MlxModelSource};
    use std::path::PathBuf;

    fn model(id: &str) -> MlxModel {
        MlxModel {
            id: id.to_string(),
            display_name: id.to_string(),
            source: MlxModelSource::XanomManaged,
            path: PathBuf::from("/tmp").join(id),
            size_bytes: 1024,
            quant: None,
            context_window: Some(32_768),
            supports_tools: true,
        }
    }

    fn model_without_tools(id: &str) -> MlxModel {
        MlxModel {
            supports_tools: false,
            ..model(id)
        }
    }

    #[test]
    fn renders_a_provider_pointed_at_the_gateway() {
        let out = render_local_provider(&[model("a/b")], 21434);
        assert_eq!(out["baseUrl"], "http://127.0.0.1:21434/v1");
        assert_eq!(out["api"], "openai-completions");
        assert_eq!(out["apiKey"], API_KEY);
        assert_eq!(out["name"], SENTINEL_NAME);
    }

    #[test]
    fn declares_one_model_per_installed_model() {
        let out = render_local_provider(&[model("a/b"), model("c/d")], 21434);
        let models = out["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "a/b");
        assert_eq!(models[1]["id"], "c/d");
    }

    #[test]
    fn declares_the_agent_context_and_output_budget() {
        let out = render_local_provider(&[model("a/b")], 21434);
        let entry = &out["models"][0];
        // Fixture's native window is 32K; unknown models are never widened.
        assert_eq!(entry["contextWindow"], 32_768);
        assert_eq!(entry["maxTokens"], 8_192);

        let huge = MlxModel { context_window: Some(262_144), ..model("c/d") };
        let out = render_local_provider(&[huge], 21434);
        assert_eq!(
            out["models"][0]["contextWindow"],
            crate::mlx::memory::UNKNOWN_CONTEXT_CAP
        );
    }

    #[test]
    fn omits_models_that_cannot_call_tools() {
        let out = render_local_provider(
            &[model("a/b"), model_without_tools("c/no-tools"), model("d/e")],
            21434,
        );
        let ids: Vec<&str> = out["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["a/b", "d/e"]);
    }

    #[test]
    fn empty_or_unsupported_install_still_renders_the_provider() {
        let empty = render_local_provider(&[], 21434);
        assert!(empty["models"].as_array().unwrap().is_empty());
        let unsupported = render_local_provider(&[model_without_tools("a/b")], 21434);
        assert!(unsupported["models"].as_array().unwrap().is_empty());
    }

    #[test]
    fn writes_into_a_fresh_directory_when_nothing_exists_yet() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("models.json");
        let provider = render_local_provider(&[model("a/b")], 21434);

        write_managed_config_body(&path, provider.clone()).unwrap();

        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["providers"][PROVIDER_ID], provider);
    }

    #[test]
    fn merges_into_an_existing_file_without_dropping_other_providers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("models.json");
        std::fs::write(
            &path,
            r#"{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
"#,
        )
        .unwrap();

        let provider = render_local_provider(&[model("a/b")], 21434);
        write_managed_config_body(&path, provider.clone()).unwrap();

        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["providers"][PROVIDER_ID], provider);
        assert_eq!(
            doc["providers"]["ollama"]["models"][0]["id"],
            "llama3.1:8b"
        );
    }

    #[test]
    fn replaces_an_existing_agmux_local_provider() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("models.json");
        let old = render_local_provider(&[model("old/one")], 21434);
        let mut root = json!({ "providers": {} });
        root["providers"][PROVIDER_ID] = old;
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap()).unwrap();

        let next = render_local_provider(&[model("new/two")], 21434);
        write_managed_config_body(&path, next.clone()).unwrap();

        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["providers"][PROVIDER_ID], next);
        assert_eq!(doc["providers"][PROVIDER_ID]["models"][0]["id"], "new/two");
    }

    #[test]
    fn refuses_to_overwrite_a_foreign_local_provider() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("models.json");
        let foreign = r#"{
  "providers": {
    "local": {
      "name": "my ollama",
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3" }]
    }
  }
}
"#;
        std::fs::write(&path, foreign).unwrap();

        let result = write_managed_config_body(&path, render_local_provider(&[model("a/b")], 21434));

        assert!(result.is_err(), "must refuse a foreign local provider");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), foreign);
    }

    #[test]
    fn parses_jsonc_with_comments_and_trailing_commas() {
        let raw = r#"{
  // user comment
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "models": [{ "id": "llama3" },],
    },
  },
}
"#;
        let doc = parse_models_json(raw).expect("jsonc must parse");
        assert_eq!(doc["providers"]["ollama"]["models"][0]["id"], "llama3");
    }

    #[test]
    fn round_trips_model_ids_with_quotes_and_backslashes() {
        let tricky_id = "weird\"name\\with\\backslashes";
        let out = render_local_provider(&[model("a/b"), model(tricky_id)], 21434);
        let encoded = serde_json::to_string(&out).unwrap();
        let back: Value = serde_json::from_str(&encoded).unwrap();
        let ids: Vec<&str> = back["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"a/b"));
        assert!(ids.contains(&tricky_id));
    }
}
