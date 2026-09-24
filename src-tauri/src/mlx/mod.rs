//! Local models (Apple MLX) — discovery, install, and an agmux-owned
//! OpenAI-compatible gateway on 127.0.0.1:21434.
//!
//! `gateway` serves `/v1` and hands each request to `pool`, which spawns one
//! `mlx_lm.server` `backend` per model and evicts under a RAM budget tracked
//! by `residency`. Consumers speak plain OpenAI HTTP: the OpenCode `local`
//! provider (chat) and the Pi CLI via `pi_config`. `discovery` finds
//! installed models, `catalog`/`downloader` install new ones, and
//! `bootstrap`/`capability` manage the Python venv and feature gating.
//!
//! See `docs/superpowers/specs/2026-08-08-local-model-opencode-mlx-design.md`.

pub mod backend;
pub mod bootstrap;
pub mod capability;
pub mod catalog;
pub mod discovery;
pub mod downloader;
pub mod gateway;
pub mod grok_config;
pub mod memory;
pub mod pi_config;
pub mod pool;
pub mod residency;
pub mod server;
pub mod types;

pub const MLX_PORT: u16 = 21434;

pub fn xanom_mlx_dir() -> std::path::PathBuf {
    crate::paths::agmux_home()
        .join("mlx")
}

pub fn xanom_venv_path() -> std::path::PathBuf {
    xanom_mlx_dir().join("venv")
}

pub fn xanom_venv_python() -> std::path::PathBuf {
    xanom_venv_path().join("bin").join("python")
}

pub fn xanom_models_dir() -> std::path::PathBuf {
    xanom_mlx_dir().join("models")
}
