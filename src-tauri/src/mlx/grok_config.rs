//! Teaches the grok CLI about agmux's local models.
//!
//! Written to `~/.grok/managed_config.toml` — a real, lower-priority merge
//! layer in grok's config stack (`/etc/grok/managed_config.toml` <
//! `$GROK_HOME/managed_config.toml` < `$GROK_HOME/config.toml`). Using this
//! layer instead of overriding GROK_HOME means the user's own `config.toml`
//! always wins, and grok keeps writing sessions to `~/.grok/sessions/` where
//! agmux's discovery, resume, usage-scan and Teams telemetry already look.

use crate::mlx::types::MlxModel;

/// First line of every file agmux writes here. Any file lacking it belongs to
/// someone else (an MDM admin, most likely) and must not be overwritten.
pub const AGMUX_SENTINEL: &str = "# agmux-managed — local model provider (safe to delete)";

/// `m.id` and `m.display_name` come straight from directory names on disk
/// (see `discovery.rs`), which on macOS may legally contain `"` or `\`.
/// Interpolated raw, either character corrupts the *entire* TOML document —
/// grok would then silently drop every local model rather than erroring on
/// just the offending one. Escape backslash first so we don't double-escape
/// the backslash introduced by escaping the quote.
fn toml_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn render_managed_config(models: &[MlxModel], port: u16) -> String {
    let mut out = String::new();
    out.push_str(AGMUX_SENTINEL);
    out.push_str("\n\n[model_providers.agmux-local]\n");
    out.push_str(&format!("base_url = \"http://127.0.0.1:{port}/v1\"\n"));
    out.push_str("api_backend = \"chat_completions\"\n");
    // mlx_lm.server ignores credentials; grok still wants a non-empty value.
    out.push_str("api_key = \"agmux-local\"\n");
    // grok drives every edit through structured tool calls, so a model whose
    // template can't emit them is left out of its model switcher entirely.
    for m in models.iter().filter(|m| m.supports_tools) {
        let id = toml_escape(&m.id);
        let name = toml_escape(&m.display_name);
        out.push_str(&format!("\n[model.\"local/{id}\"]\n"));
        out.push_str("model_provider = \"agmux-local\"\n");
        out.push_str(&format!("model = \"local/{id}\"\n"));
        out.push_str(&format!("name = \"{name}\"\n"));
        if let Some(ctx) = m.context_window {
            out.push_str(&format!("context_window = {ctx}\n"));
        }
    }
    out
}

pub fn managed_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".grok").join("managed_config.toml"))
}

/// Refresh the managed layer from what is installed right now.
/// Refuses to touch a file agmux did not write.
pub fn write_managed_config() -> Result<(), String> {
    let path = managed_config_path().ok_or("no home directory")?;
    let models = crate::mlx::discovery::scan_all();
    let body = render_managed_config(&models, crate::mlx::MLX_PORT);
    write_managed_config_body(&path, &body)
}

/// Path-parameterized so the refusal path is testable against a temp dir
/// instead of the real `~/.grok`.
fn write_managed_config_body(path: &std::path::Path, body: &str) -> Result<(), String> {
    // Only a confirmed absence of the file clears us to write. Anything else
    // — non-UTF-8 content (e.g. an MDM-deployed file with a Latin-1 comment),
    // permission errors, etc. — must NOT fall through to a write, or the
    // sentinel guard fails open and clobbers the exact file it exists to
    // protect.
    match std::fs::read_to_string(path) {
        Ok(existing) => {
            if !existing.starts_with(AGMUX_SENTINEL) {
                return Err(format!(
                    "{} already exists and was not written by agmux — add the \
                     [model_providers.agmux-local] block manually to use local \
                     models in the grok terminal",
                    path.display()
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "cannot verify whether {} was written by agmux ({e}) — refusing to touch it",
                path.display()
            ));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, body).map_err(|e| format!("write {}: {e}", path.display()))
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
        MlxModel { supports_tools: false, ..model(id) }
    }

    #[test]
    fn renders_a_provider_pointed_at_the_gateway() {
        let out = render_managed_config(&[model("a/b")], 21434);
        assert!(out.contains("[model_providers.agmux-local]"));
        assert!(out.contains("base_url = \"http://127.0.0.1:21434/v1\""));
    }

    #[test]
    fn carries_the_sentinel_so_we_never_clobber_a_foreign_file() {
        let out = render_managed_config(&[model("a/b")], 21434);
        assert!(out.starts_with(AGMUX_SENTINEL));
    }

    #[test]
    fn declares_one_model_block_per_installed_model() {
        let out = render_managed_config(&[model("a/b"), model("c/d")], 21434);
        assert!(out.contains("[model.\"local/a/b\"]"));
        assert!(out.contains("[model.\"local/c/d\"]"));
        assert!(out.contains("model_provider = \"agmux-local\""));
    }

    /// grok's `/model` switcher lists whatever this file declares. A model
    /// that can't emit tool calls would look selectable and then fail at the
    /// first edit, so it never gets a block.
    #[test]
    fn omits_models_that_cannot_call_tools() {
        let out = render_managed_config(
            &[model("a/b"), model_without_tools("c/no-tools"), model("d/e")],
            21434,
        );
        assert!(out.contains("[model.\"local/a/b\"]"));
        assert!(out.contains("[model.\"local/d/e\"]"));
        assert!(
            !out.contains("c/no-tools"),
            "unsupported model must not appear anywhere in the file: {out}"
        );
    }

    #[test]
    fn an_all_unsupported_install_renders_the_provider_with_no_models() {
        let out = render_managed_config(&[model_without_tools("a/b")], 21434);
        assert!(out.contains("[model_providers.agmux-local]"));
        assert!(!out.contains("[model."));
    }

    #[test]
    fn empty_model_list_still_renders_the_provider_only() {
        let out = render_managed_config(&[], 21434);
        assert!(out.contains("[model_providers.agmux-local]"));
        assert!(!out.contains("[model."));
    }

    /// Substring `contains` checks can't catch a document a TOML parser
    /// rejects outright. Round-trip through a real parser, including a
    /// model id with the two characters macOS allows in a directory name
    /// but that TOML requires escaped: `"` and `\`.
    #[test]
    fn round_trips_through_a_real_toml_parser_with_quotes_and_backslashes() {
        let tricky_id = "weird\"name\\with\\backslashes";
        let out = render_managed_config(&[model("a/b"), model(tricky_id)], 21434);

        let doc: toml::Value = toml::from_str(&out).expect("rendered config must be valid TOML");

        assert_eq!(
            doc["model_providers"]["agmux-local"]["base_url"].as_str(),
            Some("http://127.0.0.1:21434/v1")
        );
        assert_eq!(
            doc["model"]["local/a/b"]["model_provider"].as_str(),
            Some("agmux-local")
        );

        let tricky_key = format!("local/{tricky_id}");
        assert_eq!(
            doc["model"][tricky_key.as_str()]["model_provider"].as_str(),
            Some("agmux-local")
        );
        assert_eq!(
            doc["model"][tricky_key.as_str()]["name"].as_str(),
            Some(tricky_id)
        );
    }

    #[test]
    fn refuses_to_touch_a_sentinel_less_file_and_leaves_it_unchanged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("managed_config.toml");
        let foreign_contents = "# written by our MDM, not agmux\n[some_other_table]\nkey = \"value\"\n";
        std::fs::write(&path, foreign_contents).expect("seed foreign file");

        let result = write_managed_config_body(&path, "irrelevant new body");

        assert!(result.is_err(), "must refuse a file lacking the sentinel");
        let after = std::fs::read_to_string(&path).expect("file must still exist");
        assert_eq!(after, foreign_contents, "foreign file must be left byte-for-byte unchanged");
    }

    #[test]
    fn writes_into_a_fresh_directory_when_nothing_exists_yet() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("managed_config.toml");
        let body = render_managed_config(&[model("a/b")], 21434);

        let result = write_managed_config_body(&path, &body);

        assert!(result.is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
    }
}
