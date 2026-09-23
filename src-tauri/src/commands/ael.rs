use crate::ael::context_detector::{ContextPolicy, ContextPolicyEngine};
use crate::ael::living_spec;
use crate::ael::llm::{create_provider, LlmConfig};
use crate::ael::optimizer;
use crate::ael::prompt_wrapper;
use crate::db::models::ThreadJournalEntry;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendPromptResult {
    pub final_prompt: String,
    pub context_fetched: bool,
    pub context_score: f32,
    pub context_reason: String,
}

#[tauri::command]
pub async fn optimize_prompt(
    state: State<'_, AppState>,
    thread_id: String,
    raw_prompt: String,
    llm_provider: String,
    llm_model: String,
    openrouter_api_key: String,
) -> Result<optimizer::OptimizedResult, String> {
    let config = LlmConfig {
        provider: llm_provider.clone(),
        openrouter_api_key,
        groq_api_key: String::new(),
        local_server_port: None,
    };

    let provider = create_provider(&config);
    let model = if llm_model.is_empty() {
        match llm_provider.as_str() {
            "groq" => crate::ael::groq::DEFAULT_MODEL.to_string(),
            "openrouter" => crate::ael::openrouter::DEFAULT_MODEL.to_string(),
            _ => llm_model.clone(),
        }
    } else {
        llm_model.clone()
    };

    let result = optimizer::optimize_prompt(provider.as_ref(), &raw_prompt, &model)
        .await
        .map_err(|e| format!("Optimization failed: {}", e))?;

    // Log the optimization attempt
    let pool = state.db.clone();
    let tid = thread_id.clone();
    let original = result.original.clone();
    let optimized = result.optimized.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::db::queries::insert_prompt_log(
            &pool,
            &tid,
            &original,
            Some(&optimized),
            false,
            false,
            None,
            None,
            None,
            &original, // final_prompt_sent is original since user hasn't approved yet
        )
        .await;
    });

    Ok(result)
}

// --- Send Prompt (full pipeline) ---

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    thread_id: String,
    prompt: String,
    use_optimized: bool,
    optimized_prompt: Option<String>,
) -> Result<SendPromptResult, String> {
    let pool = &state.db;

    // 1. Determine the prompt to use
    let active_prompt = if use_optimized {
        optimized_prompt.unwrap_or_else(|| prompt.clone())
    } else {
        prompt.clone()
    };

    // 2. Get the thread to find project_id
    let thread = crate::db::queries::get_thread(pool, &thread_id)
        .await
        .map_err(|e| format!("Failed to get thread: {}", e))?;

    // 3. Get project conventions
    let conventions = crate::db::queries::get_project_conventions(pool, &thread.project_id)
        .await
        .map_err(|e| format!("Failed to get conventions: {}", e))?;

    // 4. Run context detector
    let policy = ContextPolicy::default();
    let context_decision = ContextPolicyEngine::evaluate(&active_prompt, &conventions, &policy);

    // 5. Fetch journal entries for this thread
    let journal_entries =
        crate::db::queries::list_journal_entries(pool, &thread_id, None, Some(50))
            .await
            .map_err(|e| format!("Failed to get journal entries: {}", e))?;

    // 6. Wrap the prompt
    let final_prompt = prompt_wrapper::wrap_prompt(
        &active_prompt,
        context_decision.needs_context,
        &journal_entries,
    );

    // 7. Update living spec
    let spec_content = living_spec::render_living_spec(&journal_entries, &conventions);
    if let Err(e) = living_spec::write_living_spec(&thread.work_dir, &spec_content) {
        tracing::warn!("Failed to write living spec: {}", e);
    }

    // 8. Log to prompt_logs
    let context_mode_str = format!("{:?}", policy.mode);
    let _ = crate::db::queries::insert_prompt_log(
        pool,
        &thread_id,
        &prompt,
        if use_optimized {
            Some(&active_prompt)
        } else {
            None
        },
        use_optimized,
        context_decision.needs_context,
        Some(context_decision.score),
        Some(&context_decision.reason),
        Some(&context_mode_str),
        &final_prompt,
    )
    .await
    .map_err(|e| format!("Failed to log prompt: {}", e))?;

    // 9. Send to PTY
    let input_ticket = state.sessions.lock().await.get(&thread_id).map(|session| session.input_ticket(false));
    crate::teams::policy::refresh_for_execution().await?;
    let sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get(&thread_id) {
        if session.is_alive().await {
            use std::io::Write;
            let mut writer = session.writer.lock().await;
            let ticket = input_ticket.as_ref().ok_or("Terminal session changed before delivery")?;
            session.validate_input_ticket(ticket)?;
            let data = format!("{}\r", final_prompt);
            writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
    }
    drop(sessions);

    // Also log as agent input
    let pool2 = state.db.clone();
    let tid2 = thread_id.clone();
    let fp = final_prompt.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::db::queries::insert_agent_log(&pool2, &tid2, "Input", &fp).await;
    });

    Ok(SendPromptResult {
        final_prompt,
        context_fetched: context_decision.needs_context,
        context_score: context_decision.score,
        context_reason: context_decision.reason,
    })
}

// --- Journal Entries ---

#[tauri::command]
pub async fn get_journal_entries(
    state: State<'_, AppState>,
    thread_id: String,
    kind_filter: Option<String>,
) -> Result<Vec<ThreadJournalEntry>, String> {
    crate::db::queries::list_journal_entries(&state.db, &thread_id, kind_filter.as_deref(), None)
        .await
        .map_err(|e| format!("Failed to get journal entries: {}", e))
}

#[tauri::command]
pub async fn create_journal_entry(
    state: State<'_, AppState>,
    thread_id: String,
    kind: String,
    title: String,
    content: String,
) -> Result<ThreadJournalEntry, String> {
    crate::db::queries::create_journal_entry(&state.db, &thread_id, &kind, &title, &content, "User")
        .await
        .map_err(|e| format!("Failed to create journal entry: {}", e))
}

#[tauri::command]
pub async fn update_journal_entry(
    state: State<'_, AppState>,
    id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    crate::db::queries::update_journal_entry(&state.db, &id, &title, &content)
        .await
        .map_err(|e| format!("Failed to update journal entry: {}", e))
}

#[tauri::command]
pub async fn delete_journal_entry(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::db::queries::delete_journal_entry(&state.db, &id)
        .await
        .map_err(|e| format!("Failed to delete journal entry: {}", e))
}

#[tauri::command]
pub async fn accept_journal_proposal(
    state: State<'_, AppState>,
    thread_id: String,
    kind: String,
    title: String,
    content: String,
) -> Result<ThreadJournalEntry, String> {
    crate::db::queries::create_journal_entry(
        &state.db,
        &thread_id,
        &kind,
        &title,
        &content,
        "AgentParsed",
    )
    .await
    .map_err(|e| format!("Failed to accept journal proposal: {}", e))
}

// --- Prompt Logs ---

#[tauri::command]
pub async fn get_prompt_logs(
    state: State<'_, AppState>,
    thread_id: String,
    limit: Option<i64>,
) -> Result<Vec<crate::db::models::PromptLog>, String> {
    crate::db::queries::get_prompt_logs(&state.db, &thread_id, limit.unwrap_or(50))
        .await
        .map_err(|e| format!("Failed to get prompt logs: {}", e))
}

// --- Project Conventions ---

#[tauri::command]
pub async fn update_project_conventions(
    state: State<'_, AppState>,
    project_id: String,
    conventions: Vec<String>,
) -> Result<(), String> {
    let json = serde_json::to_string(&conventions)
        .map_err(|e| format!("Failed to serialize conventions: {}", e))?;

    sqlx::query("UPDATE projects SET conventions = ? WHERE id = ?")
        .bind(&json)
        .bind(&project_id)
        .execute(&state.db)
        .await
        .map_err(|e| format!("Failed to update conventions: {}", e))?;

    Ok(())
}
