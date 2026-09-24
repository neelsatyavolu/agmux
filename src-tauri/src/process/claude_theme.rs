//! Match Claude terminals to agmux's light/dark mode.
//!
//! Claude Code's "auto" theme picks light or dark from the terminal: first
//! `COLORFGBG`, then the OSC 11 background query (xterm.js answers it), and
//! again whenever the terminal reports a color scheme change (DEC mode 2031,
//! sent by `ClaudeTerminalView` on a flip). Claude's own default is "dark",
//! so agmux passes "auto" through `--settings` unless the user picked a
//! colorblind-friendly, ANSI-only or custom theme.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Resolved app mode (system included), set by the frontend through
/// `set_window_theme`.
static APP_LIGHT_MODE: AtomicBool = AtomicBool::new(false);

/// Claude themes that only choose between plain dark and light. "auto" keeps
/// that choice in step with agmux.
const PLAIN_THEMES: [&str; 3] = ["dark", "light", "auto"];

pub fn set_app_light_mode(light: bool) {
    APP_LIGHT_MODE.store(light, Ordering::Relaxed);
}

/// `COLORFGBG` ("fg;bg" ANSI indexes) for the app mode. Claude reads a
/// background of 0-6 or 8 as dark and anything else as light.
pub fn colorfgbg() -> &'static str {
    if APP_LIGHT_MODE.load(Ordering::Relaxed) { "0;15" } else { "15;0" }
}

/// Theme to inject with `--settings`, or `None` to keep the user's choice.
/// `config_dir` is the managed account's `CLAUDE_CONFIG_DIR`, if any.
pub fn settings_theme(config_dir: Option<&Path>) -> Option<&'static str> {
    follows_app(configured_theme(config_dir).as_deref()).then_some("auto")
}

fn follows_app(theme: Option<&str>) -> bool {
    theme.is_none_or(|theme| PLAIN_THEMES.contains(&theme))
}

/// The user's theme as Claude resolves it: user settings first, then the
/// legacy global config.
fn configured_theme(config_dir: Option<&Path>) -> Option<String> {
    let config_dir = config_dir.map(Path::to_path_buf).or_else(|| {
        std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
    });
    let (settings, global) = match config_dir {
        Some(dir) => (dir.join("settings.json"), dir.join(".claude.json")),
        None => {
            let home = dirs::home_dir()?;
            (home.join(".claude").join("settings.json"), home.join(".claude.json"))
        }
    };
    read_theme(&settings).or_else(|| read_theme(&global))
}

fn read_theme(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("theme")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_or_unset_themes_follow_the_app() {
        for theme in [None, Some("dark"), Some("light"), Some("auto")] {
            assert!(follows_app(theme), "{theme:?} should follow the app");
        }
    }

    #[test]
    fn deliberate_theme_choices_are_kept() {
        for theme in ["dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi", "custom:solar"] {
            assert!(!follows_app(Some(theme)), "{theme} should be kept");
        }
    }

    #[test]
    fn user_settings_win_over_the_global_config() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".claude.json"), r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(configured_theme(Some(dir.path())).as_deref(), Some("dark"));
        assert_eq!(settings_theme(Some(dir.path())), Some("auto"));

        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"light-ansi"}"#).unwrap();
        assert_eq!(configured_theme(Some(dir.path())).as_deref(), Some("light-ansi"));
        assert_eq!(settings_theme(Some(dir.path())), None);
    }

    #[test]
    fn missing_config_follows_the_app() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(settings_theme(Some(dir.path())), Some("auto"));
    }

    #[test]
    fn colorfgbg_background_matches_the_app_mode() {
        set_app_light_mode(true);
        assert_eq!(colorfgbg(), "0;15");
        set_app_light_mode(false);
        assert_eq!(colorfgbg(), "15;0");
    }
}
