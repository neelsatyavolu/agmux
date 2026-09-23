//! Why local models are or aren't usable on this machine.
//!
//! Replaces the old hardware-UUID allowlist: capability, not identity.

use crate::mlx::types::MlxModel;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MlxCapability {
    /// Can this machine run local models at all? Apple Silicon, nothing more.
    /// The UI entry points gate on this — every other field describes a setup
    /// step the click can route the user to, not a reason to hide the feature.
    pub supported: bool,
    pub available: bool,
    pub reason: Option<String>,
    pub needs_python: bool,
    pub needs_venv: bool,
    pub needs_model: bool,
}

/// Pure decision function so every branch is testable without a real Mac.
///
/// `model_count` must be the number of *usable* models — see `current()`.
pub fn evaluate(
    apple_silicon: bool,
    has_python: bool,
    has_venv: bool,
    model_count: usize,
) -> MlxCapability {
    if !apple_silicon {
        return MlxCapability {
            supported: false,
            available: false,
            reason: Some("Local models need an Apple Silicon Mac.".into()),
            needs_python: false,
            needs_venv: false,
            needs_model: false,
        };
    }
    if !has_python {
        return MlxCapability {
            supported: true,
            available: false,
            reason: Some("Local models need Python 3.10 or newer.".into()),
            needs_python: true,
            needs_venv: true,
            needs_model: model_count == 0,
        };
    }
    if !has_venv {
        return MlxCapability {
            supported: true,
            available: false,
            reason: Some("Local model runtime is not installed yet.".into()),
            needs_python: false,
            needs_venv: true,
            needs_model: model_count == 0,
        };
    }
    if model_count == 0 {
        return MlxCapability {
            supported: true,
            available: false,
            reason: Some("No local models installed yet.".into()),
            needs_python: false,
            needs_venv: false,
            needs_model: true,
        };
    }
    MlxCapability {
        supported: true,
        available: true,
        reason: None,
        needs_python: false,
        needs_venv: false,
        needs_model: false,
    }
}

pub fn current() -> MlxCapability {
    let hw = crate::mlx::catalog::detect_hardware();
    let has_venv = crate::mlx::xanom_venv_python().exists();
    // uv-managed CPython is off PATH. A working venv is enough — that is the
    // interpreter bootstrap already created.
    let has_python = has_venv
        || crate::mlx::bootstrap::detect_python(crate::mlx::bootstrap::which_on_augmented_path)
            .is_some();
    let model_count = usable_model_count(&crate::mlx::discovery::scan_all());
    evaluate(hw.is_apple_silicon, has_python, has_venv, model_count)
}

/// Only tool-capable models count. Counting the rest reports
/// `needs_model: false` to a user whose every picker is empty, so the setup
/// prompt that would fix it never appears. Extracted from `current()` so that
/// rule is testable without a filesystem.
fn usable_model_count(models: &[MlxModel]) -> usize {
    models.iter().filter(|m| m.supports_tools).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_apple_silicon_is_unavailable_with_a_reason() {
        let cap = evaluate(false, true, true, 1);
        assert!(!cap.supported);
        assert!(!cap.available);
        assert!(cap.reason.unwrap().contains("Apple Silicon"));
    }

    #[test]
    fn missing_python_asks_for_python() {
        let cap = evaluate(true, false, false, 1);
        assert!(cap.supported);
        assert!(!cap.available);
        assert!(cap.needs_python);
    }

    #[test]
    fn missing_models_is_not_a_hard_failure_but_flags_setup() {
        let cap = evaluate(true, true, true, 0);
        assert!(cap.supported);
        assert!(!cap.available);
        assert!(cap.needs_model);
        assert!(!cap.needs_python);
    }

    #[test]
    fn models_installed_but_no_venv_still_shows_the_entry_points() {
        // The exact state the shakedown hit: Apple Silicon, python on PATH,
        // models on disk, but `~/.agmux/mlx/venv` never created. The old gate
        // (`available || needsModel`) was false here, so the chat tile and the
        // sidebar "local" tile both vanished with no explanation.
        let cap = evaluate(true, true, false, 3);
        assert!(cap.supported, "the tile must stay visible on Apple Silicon");
        assert!(!cap.available);
        assert!(cap.needs_venv, "the click should route to runtime setup");
        assert!(!cap.needs_model, "models are installed");
    }

    fn model(id: &str, supports_tools: bool) -> MlxModel {
        MlxModel {
            id: id.to_string(),
            display_name: id.to_string(),
            source: crate::mlx::types::MlxModelSource::XanomManaged,
            path: std::path::PathBuf::from("/tmp").join(id),
            size_bytes: 1,
            quant: None,
            context_window: None,
            supports_tools,
        }
    }

    /// Regression: models that can't emit tool calls are hidden from every
    /// picker, so counting them here would leave the user with
    /// `needs_model: false` and nine empty dropdowns.
    #[test]
    fn model_count_ignores_models_that_cannot_call_tools() {
        let installed = [model("org/plain-a", false), model("org/plain-b", false)];
        assert_eq!(usable_model_count(&installed), 0);

        let cap = evaluate(true, true, true, usable_model_count(&installed));
        assert!(cap.needs_model, "an all-unusable install still needs a model");
        assert!(!cap.available);
    }

    #[test]
    fn model_count_keeps_the_tool_capable_ones() {
        let installed = [model("org/capable", true), model("org/plain", false)];
        assert_eq!(usable_model_count(&installed), 1);

        let cap = evaluate(true, true, true, usable_model_count(&installed));
        assert!(!cap.needs_model);
        assert!(cap.available);
    }

    #[test]
    fn everything_present_is_available() {
        let cap = evaluate(true, true, true, 2);
        assert!(cap.supported);
        assert!(cap.available);
        assert!(cap.reason.is_none());
    }
}
