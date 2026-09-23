//! GitHub Issues via the `gh` CLI (auth is whatever `gh auth` already has).

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::process::provider::build_augmented_path;

/// Validate a path: must be non-empty, absolute, and free of `..` traversal.
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("path must be an absolute path".to_string());
    }
    if path.contains("..") {
        return Err("path must not contain '..'".to_string());
    }
    Ok(())
}

/// `owner/repo` or empty. Reject shell metacharacters and path traversal.
fn validate_repo_slug(repo: &str) -> Result<(), String> {
    let t = repo.trim();
    if t.is_empty() {
        return Ok(());
    }
    // owner/repo — allow dots, hyphens, underscores (not `..` segments).
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.')
        || !t.contains('/')
        || t.starts_with('/')
        || t.ends_with('/')
        || t.matches('/').count() != 1
    {
        return Err(format!("invalid repo slug: {t} (expected owner/repo)"));
    }
    let (owner, name) = t.split_once('/').unwrap();
    if owner.is_empty()
        || name.is_empty()
        || owner == "."
        || owner == ".."
        || name == "."
        || name == ".."
        || owner.contains("..")
        || name.contains("..")
    {
        return Err(format!("invalid repo slug: {t} (expected owner/repo)"));
    }
    Ok(())
}

fn normalize_state(state: Option<&str>) -> &'static str {
    match state.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("closed") => "closed",
        Some("all") => "all",
        _ => "open",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubLabel {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub body: Option<String>,
    pub labels: Vec<GithubLabel>,
    pub assignees: Vec<GithubUser>,
    pub author: Option<GithubUser>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Filled when listing via an explicit `--repo` (tracked remote).
    pub repository: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAuthStatus {
    pub ok: bool,
    pub logged_in: bool,
    pub login: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoInfo {
    pub name_with_owner: String,
    pub url: Option<String>,
}

async fn run_gh(cwd: Option<&str>, args: &[&str]) -> Result<(bool, String, String), String> {
    let augmented_path = build_augmented_path();
    let mut cmd = Command::new("gh");
    cmd.args(args).env("PATH", &augmented_path);
    // Non-interactive: never open a browser / pager.
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
    cmd.env("PAGER", "cat");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run gh: {e}. Is the GitHub CLI installed?"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

fn map_gh_error(stderr: &str, fallback: &str) -> String {
    let t = stderr.trim();
    if t.is_empty() {
        return fallback.to_string();
    }
    if t.contains("not logged into") || t.contains("authentication") || t.contains("auth login") {
        return format!("{t}\nRun `gh auth login` in a terminal, then refresh.");
    }
    t.to_string()
}

/// Wire-format from `gh issue list --json` (API field names).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhIssueRaw {
    number: u64,
    title: String,
    state: String,
    url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabelRaw>,
    #[serde(default)]
    assignees: Vec<GhUserRaw>,
    #[serde(default)]
    author: Option<GhUserRaw>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhLabelRaw {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhUserRaw {
    login: String,
}

fn map_issue(raw: GhIssueRaw, repository: Option<String>) -> GithubIssue {
    GithubIssue {
        number: raw.number,
        title: raw.title,
        state: raw.state,
        url: raw.url,
        body: raw.body,
        labels: raw
            .labels
            .into_iter()
            .map(|l| GithubLabel {
                name: l.name,
                color: l.color,
            })
            .collect(),
        assignees: raw
            .assignees
            .into_iter()
            .map(|u| GithubUser { login: u.login })
            .collect(),
        author: raw.author.map(|u| GithubUser { login: u.login }),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        repository,
    }
}

/// Check whether `gh` is available and authenticated.
#[tauri::command]
pub async fn github_auth_status() -> Result<GithubAuthStatus, String> {
    let (ok, _stdout, stderr) = run_gh(None, &["auth", "status"]).await?;
    if !ok {
        let msg = map_gh_error(&stderr, "Not logged in to GitHub CLI");
        return Ok(GithubAuthStatus {
            ok: false,
            logged_in: false,
            login: None,
            message: msg,
        });
    }
    // Prefer structured login via `gh api user`.
    let (api_ok, api_out, _) = run_gh(None, &["api", "user", "--jq", ".login"]).await?;
    let login = if api_ok {
        let l = api_out.trim().to_string();
        if l.is_empty() {
            None
        } else {
            Some(l)
        }
    } else {
        None
    };
    Ok(GithubAuthStatus {
        ok: true,
        logged_in: true,
        login: login.clone(),
        message: login
            .map(|l| format!("Logged in as {l}"))
            .unwrap_or_else(|| "Logged in".to_string()),
    })
}

/// Resolve `owner/repo` for a local checkout via `gh repo view`.
#[tauri::command]
pub async fn resolve_github_repo(repo_path: String) -> Result<GithubRepoInfo, String> {
    validate_path(&repo_path)?;
    let (ok, stdout, stderr) = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "nameWithOwner,url"],
    )
    .await?;
    if !ok {
        return Err(map_gh_error(
            &stderr,
            "Could not resolve GitHub repo for this folder",
        ));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        name_with_owner: String,
        url: Option<String>,
    }
    let raw: Raw = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh repo view: {e}"))?;
    Ok(GithubRepoInfo {
        name_with_owner: raw.name_with_owner,
        url: raw.url,
    })
}

/// Open issue count for a repo (excludes PRs) via GraphQL `totalCount`.
///
/// Prefer an explicit `owner/repo` slug; if only `repo_path` is given, resolve
/// the remote first. Used for Issues tab badges.
#[tauri::command]
pub async fn count_github_open_issues(
    repo_path: Option<String>,
    repo: Option<String>,
) -> Result<u32, String> {
    if let Some(ref p) = repo_path {
        validate_path(p)?;
    }
    let mut slug = repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(ref s) = slug {
        validate_repo_slug(s)?;
    }
    if slug.is_none() {
        let path = repo_path
            .as_deref()
            .ok_or_else(|| "repo_path or repo is required".to_string())?;
        let info = resolve_github_repo(path.to_string()).await?;
        slug = Some(info.name_with_owner);
    }
    let slug = slug.unwrap();
    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| format!("invalid repo slug: {slug}"))?;

    // GraphQL totalCount is exact and excludes PRs (unlike open_issues_count).
    let query = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount}}}";
    let (ok, stdout, stderr) = run_gh(
        repo_path.as_deref(),
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "--jq",
            ".data.repository.issues.totalCount",
        ],
    )
    .await?;
    if !ok {
        return Err(map_gh_error(&stderr, "Failed to count open issues"));
    }
    let n = stdout.trim().parse::<u32>().map_err(|_| {
        format!(
            "Could not parse open issue count for {slug}: {}",
            stdout.trim()
        )
    })?;
    Ok(n)
}

/// List issues for a local repo path and/or an explicit `owner/repo` slug.
///
/// Prefer `repo_path` so `gh` uses that checkout's remotes; pass `repo` when
/// tracking an extra remote without a local clone.
#[tauri::command]
pub async fn list_github_issues(
    repo_path: Option<String>,
    repo: Option<String>,
    state: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<GithubIssue>, String> {
    if let Some(ref p) = repo_path {
        validate_path(p)?;
    }
    let repo_slug = repo.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(r) = repo_slug {
        validate_repo_slug(r)?;
    }
    if repo_path.is_none() && repo_slug.is_none() {
        return Err("repo_path or repo is required".to_string());
    }

    let state_s = normalize_state(state.as_deref());
    let lim = limit.unwrap_or(50).clamp(1, 100).to_string();
    let fields = "number,title,state,url,labels,assignees,author,createdAt,updatedAt";

    let mut args: Vec<String> = vec![
        "issue".into(),
        "list".into(),
        "--state".into(),
        state_s.into(),
        "--limit".into(),
        lim,
        "--json".into(),
        fields.into(),
    ];
    if let Some(r) = repo_slug {
        args.push("--repo".into());
        args.push(r.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let cwd = repo_path.as_deref();
    let (ok, stdout, stderr) = run_gh(cwd, &arg_refs).await?;
    if !ok {
        return Err(map_gh_error(&stderr, "gh issue list failed"));
    }

    let raw: Vec<GhIssueRaw> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh issue list: {e}"))?;
    let repository = repo_slug.map(|s| s.to_string());
    Ok(raw
        .into_iter()
        .map(|r| map_issue(r, repository.clone()))
        .collect())
}

/// Fetch a single issue (includes body) for dispatch context.
#[tauri::command]
pub async fn get_github_issue(
    number: u64,
    repo_path: Option<String>,
    repo: Option<String>,
) -> Result<GithubIssue, String> {
    if number == 0 {
        return Err("issue number must be > 0".to_string());
    }
    if let Some(ref p) = repo_path {
        validate_path(p)?;
    }
    let repo_slug = repo.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(r) = repo_slug {
        validate_repo_slug(r)?;
    }
    if repo_path.is_none() && repo_slug.is_none() {
        return Err("repo_path or repo is required".to_string());
    }

    let fields = "number,title,state,url,body,labels,assignees,author,createdAt,updatedAt";
    let num = number.to_string();
    let mut args: Vec<String> = vec![
        "issue".into(),
        "view".into(),
        num,
        "--json".into(),
        fields.into(),
    ];
    if let Some(r) = repo_slug {
        args.push("--repo".into());
        args.push(r.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (ok, stdout, stderr) = run_gh(repo_path.as_deref(), &arg_refs).await?;
    if !ok {
        return Err(map_gh_error(&stderr, "gh issue view failed"));
    }
    let raw: GhIssueRaw = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse gh issue view: {e}"))?;
    Ok(map_issue(raw, repo_slug.map(|s| s.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_repo_slug_accepts_owner_repo() {
        assert!(validate_repo_slug("neel-xanom/agmux").is_ok());
        assert!(validate_repo_slug("a/b").is_ok());
        assert!(validate_repo_slug("org.name/repo-name_1").is_ok());
    }

    #[test]
    fn validate_repo_slug_rejects_junk() {
        assert!(validate_repo_slug("noslash").is_err());
        assert!(validate_repo_slug("a/b/c").is_err());
        assert!(validate_repo_slug("a/b;rm").is_err());
        assert!(validate_repo_slug("../x").is_err());
    }

    #[test]
    fn normalize_state_defaults_open() {
        assert_eq!(normalize_state(None), "open");
        assert_eq!(normalize_state(Some("CLOSED")), "closed");
        assert_eq!(normalize_state(Some("all")), "all");
        assert_eq!(normalize_state(Some("wat")), "open");
    }
}
