use crate::db::models::ThreadTurn;
use crate::db::queries;
use crate::state::AppState;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, State};
use tokio::sync::watch;

/// Hard cap matches queries max (never trust unbounded client limit).
const LIST_LIMIT_MAX: i64 = 200;
const LIST_LIMIT_DEFAULT: i64 = 200;

type ListKey = (String, i64);
type ListFlightTx = watch::Sender<Option<Result<Vec<ThreadTurn>, String>>>;

fn list_flights() -> &'static Mutex<HashMap<ListKey, ListFlightTx>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<ListKey, ListFlightTx>>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Native Codex IDs are not rows in `threads`; their timeline lives in JSONL.
async fn native_turns(pool: &sqlx::SqlitePool, thread_id: &str) -> Result<Vec<ThreadTurn>, String> {
    if uuid::Uuid::parse_str(thread_id).is_err() { return Ok(vec![]); }
    if let Some(thread) = sqlx::query_as::<_, crate::db::models::Thread>("SELECT * FROM threads WHERE id = ?")
        .bind(thread_id).fetch_optional(pool).await.map_err(|e| e.to_string())? {
        return super::history_timeline::read_turns(pool, &thread).await;
    }
    let id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        let turns = super::codex_timeline::read_turns(&id)?;
        if turns.is_empty() { Ok(super::history_timeline::read_native_claude(&id)) } else { Ok(turns) }
    }).await.map_err(|e| e.to_string())?
}

async fn load_turns(pool: &sqlx::SqlitePool, thread_id: &str, limit: i64) -> Result<Vec<ThreadTurn>, String> {
    let mut rows = queries::list_thread_turns(pool, thread_id, limit).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        rows = native_turns(pool, thread_id).await?;
        rows.truncate(limit as usize);
    }
    Ok(rows)
}

/// Wait on an in-flight shared result until published or the channel closes.
async fn await_flight(
    mut rx: watch::Receiver<Option<Result<Vec<ThreadTurn>, String>>>,
) -> Option<Result<Vec<ThreadTurn>, String>> {
    loop {
        if let Some(res) = rx.borrow_and_update().clone() {
            return Some(res);
        }
        if rx.changed().await.is_err() {
            return None;
        }
    }
}

enum FlightRole {
    Leader(ListFlightTx),
    Follower(watch::Receiver<Option<Result<Vec<ThreadTurn>, String>>>),
}

/// Single-flight: concurrent identical `(thread_id, limit)` callers share one
/// SQLite query + one serde round-trip. Prevents a frontend request storm
/// (e.g. badge refresh on every tool-use upsert) from occupying the pool.
#[tauri::command]
pub async fn list_thread_turns(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
    limit: Option<i64>,
) -> Result<Vec<ThreadTurn>, String> {
    let lim = limit.unwrap_or(LIST_LIMIT_DEFAULT).clamp(1, LIST_LIMIT_MAX);
    let key: ListKey = (thread_id.clone(), lim);

    let role = {
        let mut map = list_flights().lock().map_err(|e| e.to_string())?;
        if let Some(tx) = map.get(&key) {
            FlightRole::Follower(tx.subscribe())
        } else {
            let (tx, _) = watch::channel(None);
            map.insert(key.clone(), tx.clone());
            FlightRole::Leader(tx)
        }
    };

    match role {
        FlightRole::Follower(rx) => {
            if let Some(res) = await_flight(rx).await {
                return res;
            }
            // Leader vanished without a result — fetch once without joining a flight.
            return load_turns(&state.db, &thread_id, lim).await;
        }
        FlightRole::Leader(tx) => {
            let result = load_turns(&state.db, &thread_id, lim).await.map(|mut turns| {
                crate::thread_turns::history::upgrade_summaries(&app, &mut turns);
                turns
            });
            let _ = tx.send(Some(result.clone()));
            if let Ok(mut map) = list_flights().lock() {
                if map
                    .get(&key)
                    .map(|existing| existing.same_channel(&tx))
                    .unwrap_or(false)
                {
                    map.remove(&key);
                }
            }
            result
        }
    }
}

/// Badge count only — no row materialization / JSON of prompt+facts.
#[tauri::command]
pub async fn count_thread_turns(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<i64, String> {
    let count = queries::count_thread_turns(&state.db, &thread_id)
        .await.map_err(|e| e.to_string())?;
    if count > 0 { return Ok(count); }
    Ok(native_turns(&state.db, &thread_id).await?.len() as i64)
}

#[tauri::command]
pub async fn get_thread_turn(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> Result<ThreadTurn, String> {
    queries::get_thread_turn(&state.db, &thread_id, &turn_id)
        .await
        .map_err(|e| e.to_string())
}

/// Persist PTY buffer line for session-timeline jump after remount.
#[tauri::command]
pub async fn set_thread_turn_pty_offset(
    state: State<'_, AppState>,
    app: AppHandle,
    thread_id: String,
    turn_id: String,
    line: u64,
) -> Result<(), String> {
    crate::thread_turns::set_pty_offset(&state.db, Some(&app), &thread_id, &turn_id, line)
        .await
        .map_err(|e| e.to_string())
}

