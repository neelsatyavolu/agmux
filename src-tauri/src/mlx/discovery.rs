use crate::mlx::types::{MlxModel, MlxModelSource};
use std::path::Path;

/// Returns true if `dir` contains an MLX-format model:
/// - `config.json` with a `model_type` field
/// - at least one `*.safetensors` file
/// - NOT a directory whose only weights are `*.gguf`
pub fn is_mlx_model_dir(dir: &Path) -> bool {
    let cfg = dir.join("config.json");
    if !cfg.exists() { return false; }
    let cfg_text = match std::fs::read_to_string(&cfg) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let cfg_json: serde_json::Value = match serde_json::from_str(&cfg_text) {
        Ok(j) => j,
        Err(_) => return false,
    };
    if cfg_json.get("model_type").is_none() { return false; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut has_safetensors = false;
    let mut has_only_gguf = true;
    for ent in entries.flatten() {
        let name = ent.file_name();
        let s = name.to_string_lossy();
        if s.ends_with(".safetensors") { has_safetensors = true; has_only_gguf = false; }
        else if s.ends_with(".gguf") { /* keep has_only_gguf */ }
        else if s != "config.json" && s != "model.safetensors.index.json" { has_only_gguf = false; }
    }
    has_safetensors && !has_only_gguf
}

pub fn quant_from_path(path: &Path) -> Option<String> {
    let s = path.to_string_lossy().to_lowercase();
    for q in &["4bit", "8bit", "bf16", "fp16"] {
        if s.contains(q) { return Some((*q).to_string()); }
    }
    None
}

pub fn quant_from_config(cfg: &serde_json::Value) -> Option<String> {
    let q = cfg.get("quantization")?;
    if let Some(bits) = q.get("bits").and_then(|v| v.as_u64()) {
        return Some(format!("{}bit", bits));
    }
    None
}

pub fn context_window_from_config(cfg: &serde_json::Value) -> Option<u32> {
    cfg.get("max_position_embeddings").and_then(|v| v.as_u64()).map(|n| n as u32)
}

/// The one marker that reliably separates a tool-calling chat template from a
/// plain chat one. It covers `tool_call`, `tool_calls` and `<tool_call>` in a
/// single substring test; verified templates carry it 6–21 times. The bare word
/// "tools" is NOT usable here — plenty of chat-only templates mention it in
/// prose without ever emitting a call.
const TOOL_CALL_MARKER: &str = "tool_call";

/// Pull the `chat_template` string value out of a tokenizer config without
/// building a whole `serde_json::Value` — these files can carry a large
/// `added_tokens_decoder` map, and `scan_all()` runs often. Returns the raw
/// (still JSON-escaped) body of the value, which is enough for a substring
/// test. Returns `None` when the key is absent or its value is not a plain
/// string (the deprecated list-of-templates form), so the caller stays
/// conservative.
fn chat_template_value(text: &str) -> Option<&str> {
    let key = "\"chat_template\"";
    let after_key = &text[text.find(key)? + key.len()..];
    let after_colon = after_key.trim_start().strip_prefix(':')?.trim_start();
    let body = after_colon.strip_prefix('"')?;
    let mut escaped = false;
    for (i, c) in body.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return Some(&body[..i]);
        }
    }
    None
}

/// Whether the model in `dir` ships a chat template that emits tool calls.
///
/// Reads at most two files: `chat_template.jinja` (the modern location), else
/// the `chat_template` field of `tokenizer_config.json`. When neither exists,
/// or the template can't be read, the answer is `false` — offering a model
/// that will fail at the first file edit is worse than not offering it.
pub fn detect_tool_support(dir: &Path) -> bool {
    if let Ok(template) = std::fs::read_to_string(dir.join("chat_template.jinja")) {
        return template.contains(TOOL_CALL_MARKER);
    }
    match std::fs::read_to_string(dir.join("tokenizer_config.json")) {
        Ok(cfg) => chat_template_value(&cfg)
            .map(|t| t.contains(TOOL_CALL_MARKER))
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for ent in entries.flatten() {
            if let Ok(meta) = ent.metadata() {
                if meta.is_file() { total += meta.len(); }
            }
        }
    }
    total
}

fn build_mlx_model(dir: &Path, source: MlxModelSource, id: String) -> Option<MlxModel> {
    if !is_mlx_model_dir(dir) { return None; }
    let cfg_text = std::fs::read_to_string(dir.join("config.json")).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&cfg_text).ok()?;
    let display_name = id.split('/').last().unwrap_or(&id).to_string();
    Some(MlxModel {
        id: id.clone(),
        display_name,
        source,
        path: dir.to_path_buf(),
        size_bytes: dir_size_bytes(dir),
        quant: quant_from_path(dir).or_else(|| quant_from_config(&cfg)),
        context_window: context_window_from_config(&cfg),
        supports_tools: detect_tool_support(dir),
    })
}

/// Walk `<root>/<org>/<repo>/...` for LM Studio + agmux-managed style trees.
fn scan_org_repo_tree(root: &Path, source: MlxModelSource) -> Vec<MlxModel> {
    let mut out = Vec::new();
    let orgs = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for org in orgs.flatten() {
        if !org.path().is_dir() { continue; }
        let org_name = org.file_name().to_string_lossy().to_string();
        if let Ok(repos) = std::fs::read_dir(org.path()) {
            for repo in repos.flatten() {
                if !repo.path().is_dir() { continue; }
                let repo_name = repo.file_name().to_string_lossy().to_string();
                let id = format!("{}/{}", org_name, repo_name);
                if let Some(m) = build_mlx_model(&repo.path(), source.clone(), id) {
                    out.push(m);
                }
            }
        }
    }
    out
}

/// HuggingFace cache layout: `<hub>/models--<org>--<repo>/snapshots/<sha>/`
fn scan_hf_cache(root: &Path) -> Vec<MlxModel> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for ent in entries.flatten() {
        let name = ent.file_name();
        let s = name.to_string_lossy();
        if !s.starts_with("models--") { continue; }
        let parts: Vec<&str> = s.trim_start_matches("models--").split("--").collect();
        if parts.len() < 2 { continue; }
        let id = format!("{}/{}", parts[0], parts[1..].join("--"));
        let snapshots = ent.path().join("snapshots");
        if let Ok(snaps) = std::fs::read_dir(&snapshots) {
            for snap in snaps.flatten() {
                if let Some(m) = build_mlx_model(&snap.path(), MlxModelSource::HuggingFace, id.clone()) {
                    out.push(m);
                    break; // first valid snapshot wins
                }
            }
        }
    }
    out
}

pub fn scan_all() -> Vec<MlxModel> {
    let home = match dirs::home_dir() { Some(h) => h, None => return Vec::new() };
    let mut all: Vec<MlxModel> = Vec::new();
    let lm_studio_paths = [
        home.join(".cache/lm-studio/models"),
        home.join(".lmstudio/models"),
    ];
    for p in &lm_studio_paths {
        if p.exists() {
            all.extend(scan_org_repo_tree(p, MlxModelSource::LmStudio));
        }
    }
    let hf_root = home.join(".cache/huggingface/hub");
    if hf_root.exists() { all.extend(scan_hf_cache(&hf_root)); }
    let xanom_root = crate::mlx::xanom_models_dir();
    if xanom_root.exists() {
        all.extend(scan_org_repo_tree(&xanom_root, MlxModelSource::XanomManaged));
    }
    // Deduplicate by id, preferring LM Studio > HF > agmux (first wins after sort).
    all.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| {
        let rank = |s: &MlxModelSource| match s {
            MlxModelSource::LmStudio => 0,
            MlxModelSource::HuggingFace => 1,
            MlxModelSource::XanomManaged => 2,
        };
        rank(&a.source).cmp(&rank(&b.source))
    }));
    all.dedup_by(|a, b| a.id == b.id);
    all
}

/// Everything on disk we can actually code with. Every surface that OFFERS a
/// model to run must use this rather than `scan_all()` — a model whose template
/// can't emit tool calls looks fine right up until the first file edit.
pub fn scan_usable() -> Vec<MlxModel> {
    scan_all().into_iter().filter(|m| m.supports_tools).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mlx-discovery/lm-studio")
    }

    #[test]
    fn detects_mlx_model_dir() {
        let p = fixtures_dir().join("mlx-community/qwen-test");
        assert!(is_mlx_model_dir(&p));
    }

    #[test]
    fn rejects_gguf_only_dir() {
        let p = fixtures_dir().join("llama-gguf");
        assert!(!is_mlx_model_dir(&p));
    }

    #[test]
    fn quant_parsed_from_path_name() {
        let p = PathBuf::from("/x/Qwen2.5-7B-Instruct-4bit");
        assert_eq!(quant_from_path(&p), Some("4bit".to_string()));
    }

    #[test]
    fn context_window_parsed_from_config() {
        let cfg: serde_json::Value = serde_json::from_str(r#"{"max_position_embeddings": 32768}"#).unwrap();
        assert_eq!(context_window_from_config(&cfg), Some(32768));
    }

    /// Minimal but *valid* MLX model dir, so `build_mlx_model` accepts it.
    fn write_model_dir(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"model_type":"qwen2"}"#).unwrap();
        std::fs::write(dir.join("model.safetensors"), b"weights").unwrap();
    }

    /// Shape of a real tool-calling template: the marker appears in the
    /// emit path, not just as prose about "tools".
    const TOOL_TEMPLATE: &str = r#"{% for message in messages %}{% if message.tool_calls %}<tool_call>{"name": "{{ tool_call.function.name }}"}</tool_call>{% endif %}{% endfor %}"#;

    /// A chat-only template that still talks about tools — the exact false
    /// positive that made "tools" unusable as the marker.
    const PLAIN_TEMPLATE: &str =
        "{% for message in messages %}You are a helpful assistant with tools.{{ message.content }}{% endfor %}";

    #[test]
    fn tool_calling_jinja_template_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("chat_template.jinja"), TOOL_TEMPLATE).unwrap();
        assert!(detect_tool_support(dir.path()));
    }

    #[test]
    fn jinja_template_without_the_marker_is_not_tool_capable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("chat_template.jinja"), PLAIN_TEMPLATE).unwrap();
        assert!(!detect_tool_support(dir.path()));
    }

    #[test]
    fn falls_back_to_the_chat_template_inside_tokenizer_config() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = serde_json::json!({
            "add_bos_token": false,
            "chat_template": TOOL_TEMPLATE,
            "added_tokens_decoder": { "151657": { "content": "<tool_call>" } },
        });
        std::fs::write(dir.path().join("tokenizer_config.json"), cfg.to_string()).unwrap();
        assert!(detect_tool_support(dir.path()));

        let plain = serde_json::json!({ "chat_template": PLAIN_TEMPLATE });
        std::fs::write(dir.path().join("tokenizer_config.json"), plain.to_string()).unwrap();
        assert!(!detect_tool_support(dir.path()));
    }

    /// The escaped-quote handling matters: a template value ends at the first
    /// *unescaped* `"`, and templates are full of `{{ x["y"] }}`.
    #[test]
    fn reads_past_escaped_quotes_inside_the_template_value() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = serde_json::json!({
            "chat_template": "{{ message[\"role\"] }} then <tool_call>",
            "eos_token": "<|im_end|>",
        });
        std::fs::write(dir.path().join("tokenizer_config.json"), cfg.to_string()).unwrap();
        assert!(detect_tool_support(dir.path()));
    }

    /// A `<tool_call>` special token registered in `added_tokens_decoder` must
    /// not count on its own — only the template body is consulted.
    #[test]
    fn a_tool_call_special_token_alone_does_not_make_a_model_capable() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = serde_json::json!({
            "added_tokens_decoder": { "151657": { "content": "<tool_call>" } },
            "chat_template": PLAIN_TEMPLATE,
        });
        std::fs::write(dir.path().join("tokenizer_config.json"), cfg.to_string()).unwrap();
        assert!(!detect_tool_support(dir.path()));
    }

    #[test]
    fn no_template_files_at_all_is_treated_as_not_tool_capable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"model_type":"qwen2"}"#).unwrap();
        assert!(!detect_tool_support(dir.path()));
    }

    #[test]
    fn tokenizer_config_without_a_chat_template_key_is_not_tool_capable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("tokenizer_config.json"),
            r#"{"eos_token": "<|im_end|>"}"#,
        )
        .unwrap();
        assert!(!detect_tool_support(dir.path()));
    }

    #[test]
    fn discovered_models_carry_their_tool_support_flag() {
        let root = tempfile::tempdir().unwrap();
        let capable = root.path().join("org/capable");
        write_model_dir(&capable);
        std::fs::write(capable.join("chat_template.jinja"), TOOL_TEMPLATE).unwrap();
        let plain = root.path().join("org/plain");
        write_model_dir(&plain);
        std::fs::write(plain.join("chat_template.jinja"), PLAIN_TEMPLATE).unwrap();

        let mut found = scan_org_repo_tree(root.path(), MlxModelSource::LmStudio);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        let flags: Vec<(String, bool)> =
            found.iter().map(|m| (m.id.clone(), m.supports_tools)).collect();
        assert_eq!(
            flags,
            vec![
                ("org/capable".to_string(), true),
                ("org/plain".to_string(), false),
            ]
        );
    }

    #[test]
    fn scan_org_repo_tree_finds_qwen_and_skips_gguf() {
        let root = fixtures_dir();
        let mut found = scan_org_repo_tree(&root, MlxModelSource::LmStudio);
        found.sort_by(|a, b| a.id.cmp(&b.id));
        let ids: Vec<_> = found.iter().map(|m| m.id.clone()).collect();
        assert!(ids.contains(&"mlx-community/qwen-test".to_string()), "got {:?}", ids);
        assert!(!ids.iter().any(|s| s.contains("Llama-7B")), "should skip GGUF");
    }
}
