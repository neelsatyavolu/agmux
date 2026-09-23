//! Local accounting coverage; counts only, never transcript contents.
use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountingCoverage {
    pub unverified_legacy_records: i64,
    pub awaiting_native_binding: i64,
    pub unrevalidated_codex_snapshots: i64,
}

impl AccountingCoverage {
    pub fn is_partial(&self) -> bool {
        self.unverified_legacy_records > 0 || self.awaiting_native_binding > 0 || self.unrevalidated_codex_snapshots > 0
    }
}

pub async fn read(pool: &SqlitePool) -> Result<AccountingCoverage, String> {
    let unverified_legacy_records = sqlx::query_scalar(
        "SELECT count(*) FROM session_legacy_thread_claims l WHERE NOT EXISTS
         (SELECT 1 FROM session_origins o WHERE o.provider=l.provider AND o.owner_id=l.owner_id)",
    ).fetch_one(pool).await.map_err(|e| e.to_string())?;
    let awaiting_native_binding = sqlx::query_scalar(
        "SELECT count(*) FROM session_origins o JOIN threads t ON t.provider=o.provider AND t.id=o.owner_id
         WHERE o.created_in_agmux=1 AND NOT EXISTS
         (SELECT 1 FROM session_origin_bindings b WHERE b.provider=o.provider AND b.owner_id=o.owner_id)",
    ).fetch_one(pool).await.map_err(|e| e.to_string())?;
    let unrevalidated_codex_snapshots = sqlx::query_scalar(
        "SELECT count(*) FROM teams_usage_snapshots WHERE provider='Codex' AND accounting_revision<1
         AND last_event_at>=strftime('%s','now','-90 days')",
    ).fetch_one(pool).await.map_err(|e| e.to_string())?;
    Ok(AccountingCoverage { unverified_legacy_records, awaiting_native_binding, unrevalidated_codex_snapshots })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repair_coverage_exposes_unknown_origins_and_missing_revalidation() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO session_legacy_thread_claims VALUES('Grok','unknown')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO teams_usage_snapshots(provider,session_id,last_event_at,events_json) VALUES('Codex','missing-source',strftime('%s','now'),'[]')")
            .execute(&pool).await.unwrap();
        let coverage = read(&pool).await.unwrap();
        assert_eq!(coverage.unverified_legacy_records, 1);
        assert_eq!(coverage.unrevalidated_codex_snapshots, 1);
        assert!(coverage.is_partial());
        sqlx::query("INSERT INTO session_origins(provider,owner_id,interaction_mode,created_in_agmux) VALUES('Grok','unknown','pty',0)").execute(&pool).await.unwrap();
        sqlx::query("UPDATE teams_usage_snapshots SET accounting_revision=1").execute(&pool).await.unwrap();
        assert!(!read(&pool).await.unwrap().is_partial());
    }
}
