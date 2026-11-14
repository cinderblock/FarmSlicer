//! FarmSlicer for AI agents: a Model Context Protocol server at
//! `POST /api/mcp` (Streamable HTTP, stateless: one JSON-RPC message or a
//! batch in, `application/json` out, no SSE stream, no session id).
//!
//! It takes an API key only (`Authorization: Bearer fsk_…` or `X-Api-Key`),
//! never a session cookie, so no web page can drive it through someone's
//! browser. Every tool is one or more requests through FarmSlicer's own
//! protected routes (`tower::ServiceExt::oneshot` on the router `install`
//! keeps), with the caller's key: a tool does exactly what the key may do
//! over REST, with the same checks (permissions, visibility, integration
//! scopes, remote access). Outputs are trimmed for an agent's context.
//!
//! Claude Code: `claude mcp add --transport http farmslicer
//! https://<farm>/api/mcp --header "Authorization: Bearer fsk_…"`.
//! Plan: `plans/slicer-upload-and-mcp.md`.

use std::sync::{Arc, OnceLock};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde_json::{Map, Value, json};
use tower::ServiceExt;

use crate::auth::KeyScope;
use crate::server::AppState;

/// MCP revisions we speak, newest first.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

/// The largest REST answer a tool reads.
const MAX_ANSWER: usize = 16 * 1024 * 1024;

const INSTRUCTIONS: &str = "FarmSlicer runs a 3D print farm: printers, sliced jobs (each with \
one or more plates), a print queue that sends plates to printers as they free up, prints (a \
plate on a printer), and projects (parts to make, with quantities). The tools act as the API \
key's owner, with that account's permissions. To print something already sliced, find the job \
(list_jobs) and queue its plates (queue_plates); the queue and each printer's send mode decide \
where and when it prints. To add a sliced file (.gcode.3mf or .gcode), POST it as multipart \
field `file` to /api/uploads with the same key (Authorization: Bearer).";

/// The protected routes, for tools to call. Set once by `server::router`.
static ROUTER: OnceLock<Router> = OnceLock::new();

pub fn install(router: Router) {
    let _ = ROUTER.set(router);
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/mcp", post(handle).get(no_stream).delete(no_stream))
        .route("/api/mcp/tools", axum::routing::get(page_tools))
        .route("/api/mcp/call", post(page_call))
}

// -- The web app's own tools (WebMCP) ---------------------------------------------------------------
//
// The signed-in page registers the same tools with the browser
// (`document.modelContext`, web/src/webmcp.ts) and runs them here with its
// session. Not JSON-RPC: one list, one call. A cross-site page can't use
// them: the call takes only `application/json` (a cross-origin fetch of
// that needs a CORS preflight nobody answers) and refuses a browser's
// `Sec-Fetch-Site: cross-site`/`same-site`.

/// `GET /api/mcp/tools`: the tools the signed-in account can use.
async fn page_tools(Extension(KeyScope(scope)): Extension<KeyScope>, headers: HeaderMap) -> Json<Value> {
    let ctx = Ctx { headers: forwarded(&headers, true), scope };
    Json(json!({"tools": ctx.visible_tools()}))
}

/// `POST /api/mcp/call` `{name, arguments}`: a tools/call result.
async fn page_call(Extension(KeyScope(scope)): Extension<KeyScope>, headers: HeaderMap, body: Bytes) -> Response {
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()).unwrap_or("none");
    if matches!(site, "cross-site" | "same-site") {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "tools run from FarmSlicer's own pages only"}))).into_response();
    }
    if !is_json(&headers) {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(json!({"error": "send application/json"}))).into_response();
    }
    let params: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))).into_response(),
    };
    let ctx = Ctx { headers: forwarded(&headers, true), scope };
    match ctx.call(&params).await {
        Ok(result) => Json(result).into_response(),
        Err((_, msg)) => (StatusCode::BAD_REQUEST, Json(json!({"error": msg}))).into_response(),
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
}

/// No server-to-client stream and no sessions to end: the spec's answer
/// is 405.
async fn no_stream() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")], "").into_response()
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn http_error(code: StatusCode, message: &str) -> Response {
    (code, Json(rpc_error(Value::Null, -32600, message))).into_response()
}

/// `POST /api/mcp`.
async fn handle(
    State(_state): State<Arc<AppState>>,
    Extension(KeyScope(scope)): Extension<KeyScope>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if crate::auth::api_key_from_headers(&headers).is_none() && !crate::auth::auth_disabled() {
        return http_error(
            StatusCode::UNAUTHORIZED,
            "the MCP endpoint takes an API key (Authorization: Bearer fsk_...), not a browser session",
        );
    }
    if !is_json(&headers) {
        return http_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "send application/json");
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(rpc_error(Value::Null, -32700, format!("parse error: {e}")))).into_response(),
    };
    let ctx = Ctx { headers: forwarded(&headers, false), scope };
    match message {
        Value::Array(batch) if !batch.is_empty() => {
            let mut answers = Vec::new();
            for m in batch {
                if let Some(a) = ctx.message(m).await {
                    answers.push(a);
                }
            }
            if answers.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(answers)).into_response()
            }
        }
        m => match ctx.message(m).await {
            Some(a) => Json(a).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

/// What the tools' requests carry: the key (or, for the web app's own
/// calls, the session cookie) and whatever the proxy said about where the
/// request came from, not the MCP framing.
fn forwarded(headers: &HeaderMap, session: bool) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        let skip = (name.as_str() == "cookie" && !session)
            || matches!(
            name.as_str(),
            "content-type" | "content-length" | "transfer-encoding" | "host" | "connection"
                | "accept" | "accept-encoding" | "origin" | "referer"
        ) || name.as_str().starts_with("mcp-");
        if !skip {
            out.append(name, value.clone());
        }
    }
    out
}

struct Ctx {
    headers: HeaderMap,
    scope: Option<crate::integration::Scope>,
}

/// A tool's failure: the message the agent sees.
type ToolResult = Result<Value, String>;

impl Ctx {
    /// One JSON-RPC message: a request gets an answer, a notification or a
    /// response from the client gets none.
    async fn message(&self, m: Value) -> Option<Value> {
        let Some(obj) = m.as_object() else {
            return Some(rpc_error(Value::Null, -32600, "not a JSON-RPC message"));
        };
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            // A response to something we never ask, or junk.
            return obj.get("id").is_none().then(|| rpc_error(Value::Null, -32600, "no method"));
        };
        let id = obj.get("id").cloned()?; // a notification
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => Ok(initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": self.visible_tools()})),
            "tools/call" => self.call(&params).await,
            "resources/list" => Ok(json!({"resources": []})),
            "prompts/list" => Ok(json!({"prompts": []})),
            other => Err((-32601, format!("method not found: {other}"))),
        };
        Some(match result {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, msg)) => rpc_error(id, code, msg),
        })
    }

    /// The tools this key can use: an integration key sees only those its
    /// routes allow.
    fn visible_tools(&self) -> Vec<Value> {
        TOOLS
            .iter()
            .filter(|t| self.reaches(t))
            .map(|t| {
                json!({
                    "name": t.name,
                    "title": t.title,
                    "description": t.description,
                    "inputSchema": (t.schema)(),
                    "annotations": {
                        "title": t.title,
                        "readOnlyHint": t.read_only,
                        "destructiveHint": t.destructive,
                        "idempotentHint": t.read_only,
                        "openWorldHint": false,
                    },
                })
            })
            .collect()
    }

    fn reaches(&self, tool: &Tool) -> bool {
        match &self.scope {
            None => true,
            Some(s) => tool.routes.iter().all(|(m, p)| crate::integration::allows(s, m, p).is_ok()),
        }
    }

    async fn call(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "no tool name".to_string()))?;
        let tool = TOOLS.iter().find(|t| t.name == name).ok_or((-32602, format!("unknown tool: {name}")))?;
        let args = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(o)) => o.clone(),
            Some(_) => return Err((-32602, "arguments must be an object".to_string())),
        };
        let out = if self.reaches(tool) {
            run(self, tool.name, &Args(args)).await
        } else {
            Err("this integration key can't use that tool".to_string())
        };
        Ok(match out {
            Ok(v) => {
                let text = serde_json::to_string_pretty(&v).unwrap_or_default();
                let mut r = json!({"content": [{"type": "text", "text": text}], "isError": false});
                r["structuredContent"] = if v.is_object() { v } else { json!({"items": v}) };
                r
            }
            Err(msg) => json!({"content": [{"type": "text", "text": msg}], "isError": true}),
        })
    }

    /// A request to FarmSlicer's own API with the caller's key. Errors are
    /// the API's message, with its status.
    async fn api(&self, method: Method, path: &str, body: Option<Value>) -> ToolResult {
        let router = ROUTER.get().ok_or("the API isn't ready")?.clone();
        let mut req = Request::builder().method(method).uri(path);
        for (name, value) in &self.headers {
            req = req.header(name, value);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .map_err(|e| e.to_string())?;
        let Ok(res) = router.oneshot(req).await; // the router never fails
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), MAX_ANSWER).await.map_err(|e| e.to_string())?;
        let value: Value = if bytes.is_empty() {
            json!({"ok": true})
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        if status.is_success() {
            Ok(value)
        } else {
            let msg = value["error"].as_str().map(str::to_string).unwrap_or_else(|| match &value {
                Value::String(s) if !s.is_empty() => s.clone(),
                _ => status.canonical_reason().unwrap_or("error").to_string(),
            });
            Err(format!("{msg} (HTTP {})", status.as_u16()))
        }
    }
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {"name": "farmslicer", "title": "FarmSlicer", "version": env!("CARGO_PKG_VERSION")},
        "instructions": INSTRUCTIONS,
    })
}

// -- Tools ------------------------------------------------------------------------------------------

struct Tool {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    read_only: bool,
    destructive: bool,
    /// The REST routes it calls (sample paths), to know whether an
    /// integration key reaches it.
    routes: &'static [(Method, &'static str)],
}

fn object(props: Value, required: &[&str]) -> Value {
    json!({"type": "object", "properties": props, "required": required, "additionalProperties": false})
}

fn no_args() -> Value {
    object(json!({}), &[])
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "whoami",
        title: "Who am I",
        description: "The account this key acts as: username, role, and groups.",
        schema: no_args,
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/me")],
    },
    Tool {
        name: "list_printers",
        title: "List printers",
        description: "Every printer with its live status: state (IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED, \
            CANCELLED), progress, time left, the job on it, errors, and how it takes the queue (send mode).",
        schema: no_args,
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/printers"), (Method::GET, "/api/printers/status")],
    },
    Tool {
        name: "list_jobs",
        title: "List jobs",
        description: "Sliced jobs the account can see, newest first: id, name, status (queued, slicing, done, \
            failed, ...), plates, print time, and filament.",
        schema: || {
            object(
                json!({
                    "mine": {"type": "boolean", "description": "Only this account's own jobs."},
                    "group_id": {"type": "string", "description": "Only jobs charged to this group or its subgroups."},
                    "status": {"type": "string", "description": "Only jobs with this status, e.g. done."},
                    "search": {"type": "string", "description": "Only jobs whose name contains this (any case)."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 25},
                }),
                &[],
            )
        },
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/jobs")],
    },
    Tool {
        name: "get_job",
        title: "Get a job",
        description: "One job in detail: its plates (print time, filaments, G-code check verdict, objects), \
            its parts (the keys add_project_item takes), warnings, and what it was sliced with.",
        schema: || object(json!({"job_id": {"type": "string"}}), &["job_id"]),
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/jobs/x"), (Method::GET, "/api/jobs/x/parts")],
    },
    Tool {
        name: "list_queue",
        title: "List the print queue",
        description: "Print queue entries in queue order (a plate of a job to print, with its priority and pins), \
            and per printer what it would print next.",
        schema: || {
            object(
                json!({
                    "status": {"type": "string", "enum": ["queued", "sent", "done", "all"], "default": "queued"},
                    "printer_id": {"type": "string", "description": "Only entries that could go to this printer."},
                    "pool_id": {"type": "string", "description": "Only this pool's printers."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100},
                }),
                &[],
            )
        },
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/queue")],
    },
    Tool {
        name: "queue_plates",
        title: "Queue plates",
        description: "Put plates of a sliced job in the print queue. No plates named: every plate. The queue and \
            the printers' send modes decide where and when they print; pin a printer or pool to narrow it.",
        schema: || {
            object(
                json!({
                    "job_id": {"type": "string"},
                    "plates": {"type": "array", "items": {"type": "integer", "minimum": 1}, "description": "1-based plate numbers."},
                    "count": {"type": "integer", "minimum": 1, "default": 1, "description": "Times to print each plate."},
                    "priority": {"type": "integer", "minimum": -100, "maximum": 100, "default": 0},
                    "printer_id": {"type": "string", "description": "Only this printer may take it."},
                    "pool_id": {"type": "string", "description": "Only this pool's printers may take it."},
                    "note": {"type": "string"},
                }),
                &["job_id"],
            )
        },
        read_only: false,
        destructive: false,
        routes: &[(Method::POST, "/api/queue")],
    },
    Tool {
        name: "cancel_queue_entry",
        title: "Cancel a queue entry",
        description: "Take a queued entry out of the print queue (it won't print).",
        schema: || object(json!({"entry_id": {"type": "string"}}), &["entry_id"]),
        read_only: false,
        destructive: true,
        routes: &[(Method::DELETE, "/api/queue/x")],
    },
    Tool {
        name: "list_prints",
        title: "List prints",
        description: "Prints (a plate sent to a printer), newest first: status, printer, job, and outcome.",
        schema: || {
            object(
                json!({
                    "active": {"type": "boolean", "description": "Only prints under way."},
                    "pending": {"type": "boolean", "description": "Only prints waiting for approval."},
                    "unchecked": {"type": "boolean", "description": "Only finished prints with no outcome recorded."},
                    "printer_id": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 25},
                }),
                &[],
            )
        },
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/prints")],
    },
    Tool {
        name: "control_print",
        title: "Pause, resume, or stop a print",
        description: "Pause, resume, or stop a print under way, or change its speed. Stopping can't be undone.",
        schema: || {
            object(
                json!({
                    "print_id": {"type": "string"},
                    "action": {"type": "string", "enum": ["pause", "resume", "stop", "speed"]},
                    "level": {"type": "integer", "minimum": 1, "maximum": 4, "description": "speed on Bambu printers: 1 silent, 2 standard, 3 sport, 4 ludicrous."},
                    "percent": {"type": "integer", "minimum": 10, "maximum": 500, "description": "speed on printers that take a factor."},
                }),
                &["print_id", "action"],
            )
        },
        read_only: false,
        destructive: true,
        routes: &[(Method::POST, "/api/prints/x/control")],
    },
    Tool {
        name: "list_projects",
        title: "List projects",
        description: "Projects (parts to make, with quantities and progress) the account can see.",
        schema: || {
            object(
                json!({
                    "status": {"type": "string", "description": "Comma-separated statuses; active = not shipped or cancelled."},
                    "group_id": {"type": "string"},
                    "search": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                }),
                &[],
            )
        },
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/projects")],
    },
    Tool {
        name: "get_project",
        title: "Get a project",
        description: "One project: its items (part, quantity, recipe job, how many printed, queued, under way) \
            and linked jobs.",
        schema: || object(json!({"project_id": {"type": "string"}}), &["project_id"]),
        read_only: true,
        destructive: false,
        routes: &[(Method::GET, "/api/projects/x")],
    },
    Tool {
        name: "create_project",
        title: "Create a project",
        description: "Start a project: a named set of parts to make. Add parts with add_project_item.",
        schema: || {
            object(
                json!({
                    "name": {"type": "string"},
                    "group_id": {"type": "string", "description": "The group it's for (charged to)."},
                    "due_at": {"type": "string", "description": "When it's due (ISO 8601)."},
                    "external_ref": {"type": "string", "description": "An order number or the like."},
                }),
                &["name"],
            )
        },
        read_only: false,
        destructive: false,
        routes: &[(Method::POST, "/api/projects")],
    },
    Tool {
        name: "add_project_item",
        title: "Add a part to a project",
        description: "Add a part to a project: how many to make and, optionally, its recipe (a sliced job, and \
            which of its parts), so its prints count toward it.",
        schema: || {
            object(
                json!({
                    "project_id": {"type": "string"},
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "job_id": {"type": "string", "description": "The recipe: a job that prints this part."},
                    "part": {"type": "string", "description": "Which of the job's parts: a key from get_job's parts. Omitted: the job's only part."},
                    "notes": {"type": "string"},
                }),
                &["project_id"],
            )
        },
        read_only: false,
        destructive: false,
        routes: &[(Method::POST, "/api/projects/x/items")],
    },
];

/// A tool's arguments.
struct Args(Map<String, Value>);

impl Args {
    fn str(&self, k: &str) -> Option<&str> {
        self.0.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
    }

    fn need(&self, k: &str) -> Result<&str, String> {
        self.str(k).ok_or_else(|| format!("{k} is required"))
    }

    /// An id for a URL path: no slashes or query.
    fn id(&self, k: &str) -> Result<String, String> {
        let v = self.need(k)?;
        if v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            Ok(v.to_string())
        } else {
            Err(format!("{k}: not an id"))
        }
    }

    fn int(&self, k: &str) -> Option<i64> {
        self.0.get(k).and_then(Value::as_i64)
    }

    fn flag(&self, k: &str) -> bool {
        self.0.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    /// The given keys that are present, renamed (`from`, `to`), as a JSON body.
    fn body(&self, keys: &[(&str, &str)]) -> Value {
        let mut out = Map::new();
        for (from, to) in keys {
            if let Some(v) = self.0.get(*from).filter(|v| !v.is_null()) {
                out.insert(to.to_string(), v.clone());
            }
        }
        Value::Object(out)
    }
}

fn query(path: &str, pairs: &[(&str, Option<String>)]) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    let mut any = false;
    for (k, v) in pairs {
        if let Some(v) = v {
            q.append_pair(k, v);
            any = true;
        }
    }
    if any { format!("{path}?{}", q.finish()) } else { path.to_string() }
}

async fn run(ctx: &Ctx, name: &str, a: &Args) -> ToolResult {
    let flag = |k: &str| a.flag(k).then(|| "1".to_string());
    match name {
        "whoami" => ctx.api(Method::GET, "/api/me", None).await,
        "list_printers" => {
            let printers = ctx.api(Method::GET, "/api/printers", None).await?;
            let statuses = ctx.api(Method::GET, "/api/printers/status", None).await?;
            Ok(printers_view(&printers, &statuses))
        }
        "list_jobs" => {
            let path = query("/api/jobs", &[("mine", flag("mine")), ("group", a.str("group_id").map(str::to_string))]);
            let jobs = ctx.api(Method::GET, &path, None).await?;
            let limit = a.int("limit").unwrap_or(25).clamp(1, 200) as usize;
            let search = a.str("search").map(str::to_lowercase);
            let list: Vec<Value> = jobs
                .as_array()
                .into_iter()
                .flatten()
                .filter(|j| a.str("status").is_none_or(|s| j["status"] == s))
                .filter(|j| {
                    search.as_deref().is_none_or(|s| j["model_name"].as_str().unwrap_or("").to_lowercase().contains(s))
                })
                .take(limit)
                .map(job_summary)
                .collect();
            Ok(Value::Array(list))
        }
        "get_job" => {
            let id = a.id("job_id")?;
            let job = ctx.api(Method::GET, &format!("/api/jobs/{id}"), None).await?;
            let mut out = job_detail(&job);
            let parts = ctx.api(Method::GET, &format!("/api/jobs/{id}/parts"), None).await?;
            out["parts"] = parts
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| Value::Object(pick(p, &["key", "name", "copies", "item"])))
                .collect();
            Ok(out)
        }
        "list_queue" => {
            let path = query(
                "/api/queue",
                &[
                    ("status", a.str("status").map(str::to_string)),
                    ("printer", a.str("printer_id").map(str::to_string)),
                    ("pool", a.str("pool_id").map(str::to_string)),
                    ("limit", Some(a.int("limit").unwrap_or(100).clamp(1, 500).to_string())),
                ],
            );
            ctx.api(Method::GET, &path, None).await
        }
        "queue_plates" => {
            a.need("job_id")?;
            let body = a.body(&[
                ("job_id", "job_id"),
                ("plates", "plates"),
                ("count", "count"),
                ("priority", "priority"),
                ("printer_id", "printer_id"),
                ("pool_id", "pool_id"),
                ("note", "note"),
            ]);
            ctx.api(Method::POST, "/api/queue", Some(body)).await
        }
        "cancel_queue_entry" => {
            ctx.api(Method::DELETE, &format!("/api/queue/{}", a.id("entry_id")?), None).await
        }
        "list_prints" => {
            let path = query(
                "/api/prints",
                &[
                    ("active", flag("active")),
                    ("pending", flag("pending")),
                    ("unchecked", flag("unchecked")),
                    ("printer", a.str("printer_id").map(str::to_string)),
                    ("limit", Some(a.int("limit").unwrap_or(25).clamp(1, 200).to_string())),
                ],
            );
            ctx.api(Method::GET, &path, None).await
        }
        "control_print" => {
            let path = format!("/api/prints/{}/control", a.id("print_id")?);
            a.need("action")?;
            ctx.api(Method::POST, &path, Some(a.body(&[("action", "action"), ("level", "level"), ("percent", "percent")])))
                .await
        }
        "list_projects" => {
            let path = query(
                "/api/projects",
                &[
                    ("status", a.str("status").map(str::to_string)),
                    ("group", a.str("group_id").map(str::to_string)),
                    ("q", a.str("search").map(str::to_string)),
                    ("limit", Some(a.int("limit").unwrap_or(50).clamp(1, 200).to_string())),
                ],
            );
            ctx.api(Method::GET, &path, None).await
        }
        "get_project" => ctx.api(Method::GET, &format!("/api/projects/{}", a.id("project_id")?), None).await,
        "create_project" => {
            a.need("name")?;
            let body =
                a.body(&[("name", "name"), ("group_id", "group_id"), ("due_at", "due_at"), ("external_ref", "external_ref")]);
            ctx.api(Method::POST, "/api/projects", Some(body)).await
        }
        "add_project_item" => {
            let path = format!("/api/projects/{}/items", a.id("project_id")?);
            let mut body = a.body(&[
                ("name", "name"),
                ("quantity", "quantity"),
                ("job_id", "job_id"),
                ("notes", "notes"),
            ]);
            // The REST API names a part by model index or object name.
            if let Some(key) = a.str("part") {
                match key.strip_prefix("model:").map(str::parse::<i64>) {
                    Some(Ok(m)) => body["model"] = json!(m),
                    Some(Err(_)) => return Err("part: not a key from get_job's parts".into()),
                    None => body["part"] = json!(key.strip_prefix("object:").unwrap_or(key)),
                }
            }
            ctx.api(Method::POST, &path, Some(body)).await
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

// -- Output shapes ----------------------------------------------------------------------------------

fn pick(v: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|k| v.get(*k).filter(|x| !x.is_null()).map(|x| (k.to_string(), x.clone()))).collect()
}

/// A JSON column the API returns as text.
fn parsed(v: &Value, key: &str) -> Option<Value> {
    v.get(key).and_then(Value::as_str).and_then(|s| serde_json::from_str(s).ok())
}

const JOB_FIELDS: &[&str] = &[
    "id",
    "model_name",
    "status",
    "progress",
    "error",
    "source",
    "created_at",
    "print_time_sec",
    "filament_used_g",
    "estimated_cost",
    "username",
    "group_id",
    "group_name",
    "printer_name",
];

fn job_summary(job: &Value) -> Value {
    let mut out = pick(job, JOB_FIELDS);
    if let Some(plates) = parsed(job, "package_json").and_then(|p| p["plates"].as_array().cloned()) {
        out.insert("plates".into(), plates.iter().map(|p| p["index"].clone()).collect());
    }
    Value::Object(out)
}

fn job_detail(job: &Value) -> Value {
    let mut out = pick(job, JOB_FIELDS);
    for k in ["progress_message", "updated_at"] {
        if let Some(v) = job.get(k).filter(|v| !v.is_null()) {
            out.insert(k.into(), v.clone());
        }
    }
    if let Some(w) = parsed(job, "warnings").or_else(|| job.get("warnings").filter(|w| !w.is_null()).cloned()) {
        out.insert("warnings".into(), w);
    }
    if let Some(inputs) = parsed(job, "inputs_json") {
        out.insert("sliced_with".into(), inputs);
    }
    if let Some(o) = parsed(job, "overrides_json").filter(|o| o.as_object().is_some_and(|m| !m.is_empty())) {
        out.insert("overrides".into(), o);
    }
    if let Some(pkg) = parsed(job, "package_json") {
        let plates: Vec<Value> = pkg["plates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                let mut plate = pick(p, &["index", "printer_model", "nozzle_diameters", "print_time_sec", "weight_g", "bed_type", "objects"]);
                let filaments: Vec<Value> = p["filaments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|f| Value::Object(pick(f, &["id", "material", "color", "used_g"])))
                    .collect();
                plate.insert("filaments".into(), Value::Array(filaments));
                if let Some(check) = p.get("check").filter(|c| !c.is_null()) {
                    let findings = check["findings"].as_array().map(Vec::len).unwrap_or(0);
                    plate.insert("check".into(), json!({"verdict": check["verdict"], "findings": findings}));
                }
                Value::Object(plate)
            })
            .collect();
        out.insert("plates".into(), Value::Array(plates));
    }
    let id = job["id"].as_str().unwrap_or("");
    out.insert("page".into(), json!(format!("/jobs/{id}")));
    Value::Object(out)
}

fn printers_view(printers: &Value, statuses: &Value) -> Value {
    let list: Vec<Value> = printers
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let mut out =
                pick(p, &["id", "name", "machine_profile", "nozzle_diameter", "protocol", "area", "plate_type", "configured"]);
            if let Some(mode) = p["dispatch"].get("send_mode").filter(|m| !m.is_null()) {
                out.insert("send_mode".into(), mode.clone());
            }
            let status = statuses.as_array().into_iter().flatten().find(|s| s["printer_id"] == p["id"]);
            if let Some(s) = status {
                out.insert(
                    "status".into(),
                    Value::Object(pick(
                        s,
                        &[
                            "online",
                            "connection_error",
                            "state",
                            "percent",
                            "remaining_minutes",
                            "layer",
                            "total_layers",
                            "job_name",
                            "message",
                            "print_error_message",
                            "door_open",
                        ],
                    )),
                );
            }
            Value::Object(out)
        })
        .collect();
    Value::Array(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_the_protocol_version() {
        assert_eq!(initialize(&json!({"protocolVersion": "2025-06-18"}))["protocolVersion"], "2025-06-18");
        assert_eq!(initialize(&json!({"protocolVersion": "1999-01-01"}))["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn tools_are_well_formed() {
        let mut names = std::collections::HashSet::new();
        for t in TOOLS {
            assert!(names.insert(t.name), "{} twice", t.name);
            let schema = (t.schema)();
            assert_eq!(schema["type"], "object", "{}", t.name);
            for r in schema["required"].as_array().unwrap() {
                assert!(schema["properties"].get(r.as_str().unwrap()).is_some(), "{}: {r}", t.name);
            }
            assert!(!t.routes.is_empty());
        }
    }

    #[test]
    fn job_detail_drops_the_config() {
        let job = json!({
            "id": "j1", "model_name": "Bracket", "status": "done", "config_json": "{\"huge\":1}",
            "package_json": "{\"plates\":[{\"index\":1,\"print_time_sec\":60,\"filaments\":[{\"id\":1,\"material\":\"PLA\",\"color\":\"#fff\",\"used_g\":2.5,\"used_m\":1}],\"gcode_md5\":\"x\",\"check\":{\"verdict\":null,\"findings\":[]}}]}",
        });
        let d = job_detail(&job);
        assert!(d.get("config_json").is_none());
        assert_eq!(d["plates"][0]["filaments"][0]["material"], "PLA");
        assert_eq!(d["plates"][0]["check"]["findings"], 0);
        assert_eq!(job_summary(&job)["plates"], json!([1]));
    }

    #[test]
    fn ids_stay_in_their_path_segment() {
        let a = Args(json!({"job_id": "../me", "ok": "ab-12_C"}).as_object().unwrap().clone());
        assert!(a.id("job_id").is_err());
        assert_eq!(a.id("ok").unwrap(), "ab-12_C");
    }
}
