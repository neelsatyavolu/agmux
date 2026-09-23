//! agmux's OpenAI-compatible gateway for local models, on 127.0.0.1:21434.
//!
//! Both harnesses (OpenCode for chat, Pi for the terminal) point here. The
//! gateway reads the `model` field off each request and routes to that
//! model's backend, loading and evicting as needed. This exists because Pi
//! switches models mid-session from a separate process — no pre-flight call
//! from agmux can know what the next request will ask for.

use crate::mlx::pool::ModelPool;
use crate::mlx::MLX_PORT;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

/// Both harnesses address models as `local/<id>`; backends know only `<id>`.
pub fn strip_local_prefix(model: &str) -> &str {
    model.strip_prefix("local/").unwrap_or(model)
}

/// mlx_lm.server only reuses the loaded weights when the request's `model`
/// exactly matches the `--model` it was spawned with.
pub fn rewrite_model_field(body: &mut serde_json::Value, model_arg: &str) {
    if let Some(obj) = body.as_object_mut() {
        obj.insert(
            "model".to_string(),
            serde_json::Value::String(model_arg.to_string()),
        );
    }
}

/// Shared client for all backend calls. Built once: per-request construction
/// would discard keep-alive between turns, and `Client::new()` panics rather
/// than returning an error if the TLS backend fails to init — `.build()`
/// lets us fail with an `.expect()` message instead of an opaque panic.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Connecting to 127.0.0.1 should be near-instant; a slow connect
            // means the backend process is wedged or gone.
            .connect_timeout(Duration::from_secs(5))
            // A per-read timeout, NOT `.timeout(...)` (a total-request
            // deadline that would sever long SSE streams mid-turn). This
            // fires only when the backend goes silent mid-response — e.g. a
            // wedged mlx_lm.server that accepted the TCP connection but never
            // writes again — which would otherwise strand this handler in
            // `send().await` holding the `Lease` forever, keeping the model
            // permanently un-evictable (the exact failure `Lease::drop`'s
            // interlock exists to prevent). Generous because a large
            // prompt's first token can legitimately take a while.
            .read_timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build reqwest client for local model gateway")
    })
}

/// Wraps a byte stream together with a value (`_lease`) that must stay alive
/// for as long as the stream is alive. The held value is a struct FIELD, not
/// an `.inspect()` closure capture: deleting it is a compile error, not a
/// silent regression that only shows up as an un-evictable model in
/// production. Generic over `T` so it's testable without `Lease`, whose
/// fields are private to `pool.rs`.
struct LeasedStream<T> {
    inner: Pin<Box<dyn futures_util::Stream<Item = reqwest::Result<axum::body::Bytes>> + Send>>,
    _lease: T,
}

impl<T> LeasedStream<T> {
    fn new(
        inner: impl futures_util::Stream<Item = reqwest::Result<axum::body::Bytes>> + Send + 'static,
        lease: T,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            _lease: lease,
        }
    }
}

impl<T: Unpin> futures_util::Stream for LeasedStream<T> {
    type Item = reqwest::Result<axum::body::Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // `Pin<Box<dyn Stream + Send>>` is unconditionally `Unpin`, and `T:
        // Unpin` is required above, so the whole struct is `Unpin` and
        // `get_mut()` is sound without pin-project or `unsafe`.
        self.get_mut().inner.as_mut().poll_next(cx)
    }
}

pub struct Gateway;

impl Gateway {
    pub async fn start(pool: Arc<ModelPool>) -> Result<(), String> {
        let app = Router::new()
            .route("/v1/models", get(list_models))
            .route("/v1/chat/completions", post(chat_completions))
            .layer(axum::middleware::from_fn(guard_local_only))
            .with_state(pool);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], MLX_PORT));
        let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
            format!("local model gateway could not bind 127.0.0.1:{MLX_PORT}: {e}")
        })?;
        tracing::info!(target: "xanom::mlx::gateway", port = MLX_PORT, "local model gateway listening");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(target: "xanom::mlx::gateway", error = %e, "gateway stopped");
            }
        });
        Ok(())
    }
}

async fn list_models() -> Json<serde_json::Value> {
    // `scan_usable`: this is an offering surface — any OpenAI-compatible client
    // probing /v1/models treats what it returns as pickable.
    let data: Vec<serde_json::Value> = crate::mlx::discovery::scan_usable()
        .into_iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "object": "model",
                "owned_by": "agmux-local",
            })
        })
        .collect();
    Json(serde_json::json!({ "object": "list", "data": data }))
}

/// Reject anything that isn't a same-machine, non-browser client. The gateway
/// binds 127.0.0.1, but that alone does not stop a web page from POSTing to it
/// (a "simple" cross-origin request needs no preflight) or from reaching it via
/// DNS rebinding. Real clients (grok, OpenCode) send no `Origin` and address the
/// loopback authority directly, so:
///   - any request carrying an `Origin` header is refused (browser cross-origin);
///   - the `Host` must be our loopback authority (defeats DNS rebinding, where a
///     rebound hostname reaches 127.0.0.1 but Host is the attacker's domain).
async fn guard_local_only(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let headers = req.headers();
    if headers.contains_key(axum::http::header::ORIGIN) {
        return error_response(
            StatusCode::FORBIDDEN,
            "cross-origin requests are not allowed".into(),
        );
    }
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| h == format!("127.0.0.1:{MLX_PORT}") || h == format!("localhost:{MLX_PORT}"))
        .unwrap_or(false);
    if !host_ok {
        return error_response(StatusCode::FORBIDDEN, "invalid host header".into());
    }
    next.run(req).await
}

fn error_response(status: StatusCode, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": { "message": message, "type": "agmux_local" } })),
    )
        .into_response()
}

async fn chat_completions(
    State(pool): State<Arc<ModelPool>>,
    body: axum::body::Bytes,
) -> Response {
    let mut json_body: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error_response(StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")),
    };
    let requested = json_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or_default()
        .to_string();
    // Strip the `local/` prefix BEFORE checking emptiness — `{"model":
    // "local/"}` must 400 here with a clear message, not reach the pool as
    // an empty model id and surface a confusing pool-side error instead.
    let model = strip_local_prefix(&requested).to_string();
    if model.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "request has no `model` field".into());
    }

    if let Err(error) = crate::teams::policy::refresh_for_execution().await {
        return error_response(StatusCode::FORBIDDEN, error);
    }
    // Pi terminal and OpenCode chat share this endpoint. Their execution
    // entry points enforce mode; the gateway cannot infer a caller's surface.
    // It knows the exact model but has no enforced reasoning effort contract.
    let policy_model = format!("local/{model}");
    if let Err(error) = crate::teams::policy::enforce_inference("MLX", Some(&policy_model), None) {
        return error_response(StatusCode::FORBIDDEN, error);
    }

    let lease = match pool.acquire(&model).await {
        Ok(l) => l,
        Err(e) => return error_response(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    rewrite_model_field(&mut json_body, &lease.model_arg);

    let upstream = match http_client()
        .post(format!("{}/v1/chat/completions", lease.base_url))
        .json(&json_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("local model backend error: {e}"),
            )
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    // Stream straight through. Collecting the body here would buffer SSE and
    // make a working model look like a hang.
    //
    // The lease is moved into `LeasedStream` as a struct field, not attached
    // as a response extension and not captured by an `.inspect()` closure:
    // extensions drop when the response head is sent (releasing the
    // in-flight count while the body is still streaming, making the model
    // evictable mid-turn), and a closure capture reads as dead code that a
    // future edit could delete without a compile error. Owning it as a field
    // ties its lifetime to the stream itself — it drops only when the stream
    // does, after the last byte, and removing it doesn't compile.
    let stream = LeasedStream::new(upstream.bytes_stream(), lease);
    let body = Body::from_stream(stream);
    match Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .body(body)
    {
        Ok(r) => r,
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn strips_the_provider_prefix_both_harnesses_send() {
        assert_eq!(strip_local_prefix("local/mlx-community/Qwen3-8B-4bit"), "mlx-community/Qwen3-8B-4bit");
        assert_eq!(strip_local_prefix("mlx-community/Qwen3-8B-4bit"), "mlx-community/Qwen3-8B-4bit");
    }

    #[test]
    fn rewrites_model_to_the_arg_the_backend_was_spawned_with() {
        let mut body = json!({ "model": "local/foo", "messages": [] });
        rewrite_model_field(&mut body, "/Users/x/models/foo");
        assert_eq!(body["model"], json!("/Users/x/models/foo"));
        assert_eq!(body["messages"], json!([]));
    }

    #[test]
    fn rewrite_is_a_noop_on_a_non_object_body() {
        let mut body = json!(["not", "an", "object"]);
        rewrite_model_field(&mut body, "anything");
        assert_eq!(body, json!(["not", "an", "object"]));
    }

    /// Sets a flag on drop. Stands in for `Lease` in `LeasedStream` tests:
    /// `Lease`'s fields are private to `pool.rs` and cannot be constructed
    /// here, which is exactly why `LeasedStream` is generic over `T` rather
    /// than hardcoding `Lease`.
    struct DropProbe(Arc<AtomicBool>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn held_value_outlives_every_item_the_stream_yields() {
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = DropProbe(dropped.clone());
        let inner = futures_util::stream::iter(vec![
            Ok::<_, reqwest::Error>(axum::body::Bytes::from_static(b"a")),
            Ok::<_, reqwest::Error>(axum::body::Bytes::from_static(b"b")),
            Ok::<_, reqwest::Error>(axum::body::Bytes::from_static(b"c")),
        ]);
        let mut leased = LeasedStream::new(inner, probe);

        let mut yielded = 0;
        while leased.next().await.is_some() {
            yielded += 1;
            assert!(
                !dropped.load(Ordering::SeqCst),
                "held value dropped while the stream still had items to yield"
            );
        }
        assert_eq!(yielded, 3);
        // Exhausted (poll returned None) but the wrapper itself is still
        // alive — the held value must not have dropped yet.
        assert!(
            !dropped.load(Ordering::SeqCst),
            "held value dropped before the wrapper was dropped"
        );

        drop(leased);
        assert!(
            dropped.load(Ordering::SeqCst),
            "held value must drop once the wrapper drops"
        );
    }

    #[tokio::test]
    async fn held_value_outlives_a_stream_that_yields_nothing() {
        // Regression guard for the exact failure mode of the closure-capture
        // version: drop must be driven by ownership of the field, not by a
        // closure ever running. An inner stream with zero items never runs
        // any per-item closure, so this case would have passed silently
        // under the old `.inspect(move |_| { let _hold = &lease; })` shape
        // even if the closure were deleted entirely.
        let dropped = Arc::new(AtomicBool::new(false));
        let probe = DropProbe(dropped.clone());
        let inner = futures_util::stream::iter(Vec::<reqwest::Result<axum::body::Bytes>>::new());
        let mut leased = LeasedStream::new(inner, probe);

        assert!(leased.next().await.is_none());
        assert!(
            !dropped.load(Ordering::SeqCst),
            "held value dropped before the wrapper was dropped"
        );

        drop(leased);
        assert!(
            dropped.load(Ordering::SeqCst),
            "held value must drop once the wrapper drops, even with zero items yielded"
        );
    }
}
