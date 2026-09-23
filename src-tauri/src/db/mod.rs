pub mod models;
pub mod queries;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;
use std::time::{Duration, Instant};

/// Free pages above this (and majority of the file) trigger a one-shot VACUUM
/// before the production pool opens. Hang dumps showed ~1.1M free pages
/// (~4.6 GB) after agent_logs prune with auto_vacuum off — freelist thrash
/// under concurrent reads.
const FREELIST_VACUUM_MIN_PAGES: i64 = 50_000;

pub async fn init_db(db_path: &str) -> anyhow::Result<SqlitePool> {
    // Create parent directory if it doesn't exist
    if let Some(parent) = std::path::Path::new(db_path).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}?mode=rwc", db_path))?
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    // Boot with a single connection: migrate + optional freelist reclaim must
    // not race the multi-connection production pool (VACUUM needs exclusive).
    let boot = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options.clone())
        .await?;

    let migration = async {
        let migrator = sqlx::migrate!("./migrations");
        let has_schema: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").fetch_one(&boot).await?;
        let has_migrations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = '_sqlx_migrations'").fetch_one(&boot).await?;
        let applied: Vec<i64> = if has_migrations > 0 {
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = 1").fetch_all(&boot).await?
        } else { Vec::new() };
        if has_schema > 0 && migrator.iter().any(|m| !applied.contains(&m.version)) {
            let folder = std::path::Path::new(db_path).parent().unwrap().join("backups");
            std::fs::create_dir_all(&folder)?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
            }
            let backup = folder.join(format!("pre-migration-{}-{}.db", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs(), uuid::Uuid::new_v4()));
            sqlx::query("VACUUM INTO ?").bind(backup.to_string_lossy().as_ref()).execute(&boot).await?;
        }
        migrator.run(&boot).await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    if let Err(error) = migration { boot.close().await; return Err(error); }

    if let Err(e) = maybe_vacuum_freelist(&boot).await {
        tracing::warn!("freelist VACUUM skipped: {e}");
    }

    boot.close().await;

    // SQLite + WAL serializes writes regardless of pool size; the pool only
    // bounds concurrent reader threads. 8 is the sweet spot for this app:
    // enough headroom that the Sidebar's parallel per-project scanners
    // (Claude + Droid + Grok) don't queue for 28+ seconds the way they
    // did at max_connections(5), while still keeping the sqlx worker
    // thread count low enough to avoid the CPU thrash we saw at 20
    // (each sqlx connection backs a dedicated blocking thread doing
    // disk I/O against the same WAL file).
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    Ok(pool)
}

/// Reclaim free pages when they dominate the file (post-prune bloat).
async fn maybe_vacuum_freelist(pool: &SqlitePool) -> anyhow::Result<()> {
    let freelist: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    if freelist < FREELIST_VACUUM_MIN_PAGES {
        return Ok(());
    }
    // Require freelist to be a large share of the file so we don't VACUUM
    // healthy DBs that merely have a modest free list after normal churn.
    if page_count > 0 && freelist * 2 < page_count {
        tracing::debug!(
            freelist,
            page_count,
            "freelist present but not majority — skip VACUUM"
        );
        return Ok(());
    }

    tracing::info!(
        freelist,
        page_count,
        "Reclaiming SQLite freelist with VACUUM (one-shot; can take a minute on multi‑GB files)"
    );
    let start = Instant::now();
    sqlx::query("VACUUM").execute(pool).await?;
    let freelist_after: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await
        .unwrap_or(-1);
    tracing::info!(
        elapsed_ms = start.elapsed().as_millis() as u64,
        freelist_after,
        "VACUUM complete"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::FREELIST_VACUUM_MIN_PAGES;

    #[test]
    fn freelist_threshold_is_conservative() {
        // Avoid vacuuming tiny DBs on every dev restart.
        assert!(FREELIST_VACUUM_MIN_PAGES >= 10_000);
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    #[tokio::test]
    async fn pending_migrations_backup_existing_records_only_once() {
        use sqlx::Connection;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agmux.db");
        let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true);
        let mut seed = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE sentinel(value TEXT)").execute(&mut seed).await.unwrap();
        sqlx::query("INSERT INTO sentinel VALUES ('keep me')").execute(&mut seed).await.unwrap();
        seed.close().await.unwrap();
        let db = init_db(path.to_str().unwrap()).await.unwrap();
        db.close().await;
        let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups")).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(backups.len(), 1);
        let mut saved = sqlx::SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backups[0]).read_only(true)).await.unwrap();
        let value: String = sqlx::query_scalar("SELECT value FROM sentinel").fetch_one(&mut saved).await.unwrap();
        assert_eq!(value, "keep me");
        let migrations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = '_sqlx_migrations'").fetch_one(&mut saved).await.unwrap();
        assert_eq!(migrations, 0);
        saved.close().await.unwrap();
        init_db(path.to_str().unwrap()).await.unwrap().close().await;
        assert_eq!(std::fs::read_dir(dir.path().join("backups")).unwrap().count(), 1);
    }
}
