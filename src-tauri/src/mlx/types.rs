use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum MlxBootstrapState {
    Idle,
    CheckingPython,
    /// Python wasn't found AND we know how to auto-install it (uv or brew is
    /// available). The frontend offers a one-click install button.
    PythonMissing { suggestion: String, can_auto_install: bool, installer: Option<String> },
    /// `uv python install` or `brew install python@3.12` running.
    InstallingPython { tool: String, line: Option<String> },
    /// Python is missing AND neither uv nor brew is on PATH — user has to
    /// install one of them first.
    InstallToolMissing { hint: String },
    CreatingVenv,
    InstallingMlxLm { line: Option<String> },
    InstallFailed { error: String },
    Ready { python_path: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MlxModelSource {
    LmStudio,
    HuggingFace,
    XanomManaged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MlxModel {
    pub id: String,
    pub display_name: String,
    pub source: MlxModelSource,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub context_window: Option<u32>,
    /// Whether this model's chat template can emit structured OpenAI-style
    /// `tool_calls`. Both harnesses that drive local models (OpenCode chat and
    /// the Pi CLI) do every file edit through tool calls, so a model without
    /// this is unusable for coding and is never offered in a picker.
    /// Detected from the on-disk chat template — see `discovery::detect_tool_support`.
    pub supports_tools: bool,
}
