//! ScaleX LAN Manager network layer for the desktop (Tauri) runtime.
//!
//! In the desktop app every plugin network call goes through Rust
//! (`plugin_network_request` -> `generated_builtin_plugins`), with no HTTP
//! fallback to the Next.js API route — that fallback only exists in
//! `next dev`/web mode. A TypeScript-only plugin therefore can't work in the
//! installed app, which is why this file mirrors `network/handlers/*.ts` (the
//! dev-mode implementation) operation for operation. Keep both in sync.
//!
//! ScaleX REST surface used (all from own_manager.py's live send path):
//!   GET  /api/printers
//!   GET  /api/warehouse
//!   PUT  /api/warehouse/ctb-mappings
//!   POST /api/printers/{id}/files            (X-File-Name, X-Start-Print)
//!   GET  /api/uploads/{id}
//!   POST /api/printers/{id}/stored-files/start

use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
pub struct PluginNetworkResponse {
    pub status: u16,
    pub body: Value,
}

const PLUGIN_ID: &str = "scalex-lan-manager";
const DEFAULT_PORT: u16 = 8082;
const DEFAULT_LOCAL_HOSTNAMES: [&str; 3] = ["scalex.local", "scalex-lan-manager.local", "printfarm.local"];
const UPLOAD_POLL_DEADLINE: Duration = Duration::from_secs(30 * 60);
const UPLOAD_POLL_INTERVAL: Duration = Duration::from_secs(2);
const UPLOAD_CHUNK_BYTES: usize = 256 * 1024;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| Client::builder().build().unwrap_or_else(|_| Client::new()))
}

struct UploadProgressEntry {
    sent: Arc<AtomicU64>,
    total: u64,
    done: bool,
    error: Option<String>,
}

static UPLOAD_PROGRESS: OnceLock<Mutex<HashMap<String, UploadProgressEntry>>> = OnceLock::new();

fn upload_progress() -> &'static Mutex<HashMap<String, UploadProgressEntry>> {
    UPLOAD_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Host / port parsing (mirrors scalexClient.ts)
// ---------------------------------------------------------------------------

fn resolve_raw_host(payload: &Value) -> String {
    for key in ["host", "ipAddress", "hostUrl"] {
        if let Some(text) = payload.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// Accepts `host`, `host:port`, or `http(s)://host:port`.
fn parse_host_and_port(raw: &str) -> Option<(String, Option<u16>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let normalized = if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = reqwest::Url::parse(&normalized).ok()?;
    let host = url.host_str()?.trim().to_string();
    if host.is_empty() {
        return None;
    }
    Some((host, url.port()))
}

fn resolve_port(payload_port: Option<&Value>, parsed: Option<u16>) -> u16 {
    if let Some(value) = payload_port {
        let number = match value {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        if let Some(n) = number {
            if n.is_finite() && (1.0..=65535.0).contains(&n) {
                return n as u16;
            }
        }
    }
    parsed.unwrap_or(DEFAULT_PORT)
}

/// `encodeURIComponent` equivalent (unreserved: A-Z a-z 0-9 - _ . ! ~ * ' ( )).
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn base_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}")
}

async fn scalex_send(
    method: Method,
    host: &str,
    port: u16,
    path: &str,
    json_body: Option<Value>,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let mut request = http_client()
        .request(method, format!("{}{}", base_url(host, port), path))
        .header("Accept", "application/json")
        .timeout(timeout);
    if let Some(body) = json_body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_string());
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, text))
}

fn is_success(status: u16) -> bool {
    (200..300).contains(&status)
}

// ---------------------------------------------------------------------------
// Printer helpers (ported from scalexClient.ts / own_manager.py)
// ---------------------------------------------------------------------------

async fn fetch_printers(host: &str, port: u16, timeout_ms: u64) -> Result<Vec<Value>, String> {
    let (status, text) =
        scalex_send(Method::GET, host, port, "/api/printers", None, Duration::from_millis(timeout_ms)).await?;
    if !is_success(status) {
        return Err(format!("HTTP {status}"));
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(printers)) => Ok(printers),
        _ => Err("Unexpected /api/printers payload shape (expected a JSON array)".to_string()),
    }
}

fn number_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn id_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn is_printer_online(printer: &Value) -> bool {
    printer
        .get("status")
        .and_then(|s| s.get("online"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn is_printer_uploading(printer: &Value) -> bool {
    match printer.get("upload") {
        Some(upload) if upload.is_object() => {
            let done = upload.get("done").and_then(Value::as_bool).unwrap_or(false);
            let cancelled = upload.get("cancelled").and_then(Value::as_bool).unwrap_or(false);
            !(done || cancelled)
        }
        _ => false,
    }
}

fn is_printer_busy(printer: &Value) -> bool {
    if is_printer_uploading(printer) {
        return true;
    }
    let status = printer.get("status");
    let current_status = number_of(status.and_then(|s| s.get("currentStatus")));
    let print_status = number_of(status.and_then(|s| s.get("printStatus")));
    let text = status
        .and_then(|s| s.get("printStatusText"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if current_status == 0.0
        || print_status == 8.0
        || print_status == 9.0
        || ["idle", "stopped", "complete", "completed"].contains(&text.as_str())
    {
        return false;
    }
    current_status == 1.0
        || (1.0..=7.0).contains(&print_status)
        || [
            "preparing", "homing", "lifting", "exposing", "printing", "pausing", "paused", "stopping",
        ]
        .contains(&text.as_str())
}

fn printer_display_name(printer: &Value) -> String {
    for key in ["displayName", "name", "model", "machineModel"] {
        if let Some(text) = printer.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    format!("Printer {}", id_string(printer.get("id")))
}

fn printer_label(printer: &Value) -> String {
    let name = printer_display_name(printer);
    if !is_printer_online(printer) {
        return format!("{name} (offline)");
    }
    if is_printer_busy(printer) {
        return format!("{name} (busy)");
    }
    name
}

// ---------------------------------------------------------------------------
// connect / discover / printers
// ---------------------------------------------------------------------------

async fn handle_connect(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let Some((host, parsed_port)) = parse_host_and_port(&raw_host) else {
        return (400, json!({ "error": "Invalid host or IP address" }));
    };
    let port = resolve_port(payload.get("port"), parsed_port);

    match fetch_printers(&host, port, 5000).await {
        Ok(printers) => {
            let online = printers.iter().filter(|p| is_printer_online(p)).count();
            let busy = printers.iter().filter(|p| is_printer_busy(p)).count();
            let count = printers.len();
            (
                200,
                json!({
                    "connected": true,
                    "mode": "scalex",
                    "hostName": "ScaleX LAN Manager",
                    "printerName": format!(
                        "{count} printer{} ({online} online, {busy} busy)",
                        if count == 1 { "" } else { "s" }
                    ),
                    "printerModel": "",
                    "ipAddress": host,
                    "port": port,
                    "statusText": "Online",
                    "state": "",
                    "firmwareVersion": "",
                }),
            )
        }
        Err(message) => (
            200,
            json!({
                "connected": false,
                "mode": "scalex",
                "hostName": "",
                "printerName": "",
                "printerModel": "",
                "ipAddress": host,
                "port": port,
                "statusText": message,
                "state": "",
                "firmwareVersion": "",
            }),
        ),
    }
}

async fn probe_scalex(host: String, port: u16, timeout_ms: u64) -> Option<Value> {
    let printers = fetch_printers(&host, port, timeout_ms).await.ok()?;
    let count = printers.len();
    Some(json!({
        "ipAddress": host,
        "port": port,
        "hostName": "ScaleX LAN Manager",
        "printerName": format!("{count} printer{}", if count == 1 { "" } else { "s" }),
        "printerModel": "",
        "statusText": "Online",
        "state": "",
        "firmwareVersion": "",
    }))
}

async fn handle_discover(payload: &Value) -> (u16, Value) {
    if let Some(mode) = payload.get("mode").and_then(Value::as_str) {
        if !mode.is_empty() && mode != "scalex" {
            return (400, json!({ "error": "Unsupported network mode" }));
        }
    }

    let raw_host = resolve_raw_host(payload);
    let forced = if raw_host.is_empty() { None } else { parse_host_and_port(&raw_host) };
    let port = resolve_port(payload.get("port"), forced.as_ref().and_then(|(_, p)| *p));

    let candidate_hosts: Vec<String> = match &forced {
        Some((host, _)) => vec![host.clone()],
        None => {
            let mut hosts: Vec<String> = Vec::new();
            if let Some(list) = payload.get("localHostnames").and_then(Value::as_array) {
                for item in list {
                    if let Some(name) = item.as_str() {
                        if !hosts.iter().any(|h| h == name) {
                            hosts.push(name.to_string());
                        }
                    }
                }
            }
            for name in DEFAULT_LOCAL_HOSTNAMES {
                if !hosts.iter().any(|h| h == name) {
                    hosts.push(name.to_string());
                }
            }
            hosts
        }
    };

    let probes = candidate_hosts.iter().map(|host| probe_scalex(host.clone(), port, 1500));
    let devices: Vec<Value> = futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect();

    (
        200,
        json!({
            "mode": "scalex",
            "devices": devices,
            "scannedHosts": candidate_hosts.len(),
            "scannedEndpoints": candidate_hosts.len(),
            "scannedLocalHostnames": if forced.is_some() { 0 } else { candidate_hosts.len() },
            "scannedSubnetHosts": 0,
            "scanScope": if forced.is_some() { "forced-host" } else { "local-hostnames" },
        }),
    )
}

/// ScaleX manages a whole farm behind one host:port; DragonFruit's contract
/// only has a per-job "material profile" slot, so farm printers are surfaced
/// there (see the addon README, "the printer picker").
async fn handle_printers_list(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let Some((host, parsed_port)) = parse_host_and_port(&raw_host) else {
        return (400, json!({ "error": "Invalid host or IP address" }));
    };
    let port = resolve_port(payload.get("port"), parsed_port);

    match fetch_printers(&host, port, 6000).await {
        Ok(printers) => {
            let materials: Vec<Value> = printers
                .iter()
                .map(|printer| {
                    json!({
                        "id": id_string(printer.get("id")),
                        "name": printer_label(printer),
                        "locked": !is_printer_online(printer) || is_printer_busy(printer),
                        "meta": printer,
                    })
                })
                .collect();
            (200, json!({ "ipAddress": host, "port": port, "materials": materials }))
        }
        Err(message) => (
            200,
            json!({ "ipAddress": host, "port": port, "materials": [], "error": message }),
        ),
    }
}

fn handle_printers_edit() -> (u16, Value) {
    (
        400,
        json!({ "ok": false, "error": "ScaleX LAN Manager does not support editing printer settings remotely." }),
    )
}

// ---------------------------------------------------------------------------
// Composition (warehouse)
// ---------------------------------------------------------------------------

async fn handle_composition_warehouse(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let Some((host, parsed_port)) = parse_host_and_port(&raw_host) else {
        return (400, json!({ "ok": false, "error": "Invalid host or IP address" }));
    };
    let port = resolve_port(payload.get("port"), parsed_port);

    let result = scalex_send(Method::GET, &host, port, "/api/warehouse", None, Duration::from_secs(10)).await;
    match result {
        Ok((status, text)) if is_success(status) => {
            let components = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("components").cloned())
                .filter(Value::is_array)
                .unwrap_or_else(|| json!([]));
            (200, json!({ "ok": true, "components": components }))
        }
        Ok((status, _)) => (200, json!({ "ok": false, "error": format!("HTTP {status}"), "components": [] })),
        Err(message) => (200, json!({ "ok": false, "error": message, "components": [] })),
    }
}

/// PUT /api/warehouse/ctb-mappings REPLACES ScaleX's composition for this
/// file name — an empty list is therefore a deliberate no-op, never a write.
async fn handle_composition_save(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let Some((host, parsed_port)) = parse_host_and_port(&raw_host) else {
        return (400, json!({ "ok": false, "error": "Invalid host or IP address" }));
    };
    let port = resolve_port(payload.get("port"), parsed_port);
    let file_name = payload.get("fileName").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if file_name.is_empty() {
        return (400, json!({ "ok": false, "error": "Missing fileName" }));
    }

    let quantities: Vec<Value> = payload
        .get("componentQuantities")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let component_id = entry.get("componentId")?;
                    if !component_id.is_string() && !component_id.is_number() {
                        return None;
                    }
                    let quantity = number_of(entry.get("quantity"));
                    if !quantity.is_finite() || quantity <= 0.0 {
                        return None;
                    }
                    Some(json!({ "component_id": component_id, "quantity": entry.get("quantity") }))
                })
                .collect()
        })
        .unwrap_or_default();

    if quantities.is_empty() {
        return (200, json!({ "ok": true, "skipped": true }));
    }

    let body = json!({ "file_name": file_name, "component_quantities": quantities });
    match scalex_send(Method::PUT, &host, port, "/api/warehouse/ctb-mappings", Some(body), Duration::from_secs(15)).await {
        Ok((status, _)) if is_success(status) => (200, json!({ "ok": true })),
        Ok((status, text)) => {
            let snippet: String = text.chars().take(300).collect();
            (200, json!({ "ok": false, "error": format!("HTTP {status}: {snippet}") }))
        }
        Err(message) => (200, json!({ "ok": false, "error": message })),
    }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

fn upload_status_is_terminal(status: &Value) -> bool {
    status.get("done").and_then(Value::as_bool) == Some(true)
        || matches!(
            status.get("state").and_then(Value::as_str),
            Some("completed" | "failed" | "error" | "cancelled")
        )
}

fn upload_status_is_error(status: &Value) -> bool {
    matches!(
        status.get("state").and_then(Value::as_str),
        Some("failed" | "error" | "cancelled")
    )
}

/// Ported from own_manager.py's _progress_from_status(): (percent, message).
fn upload_status_message(status: &Value) -> String {
    let text_of = |key: &str| status.get(key).and_then(Value::as_str).map(str::to_string);
    if status.get("percent").map(Value::is_number).unwrap_or(false) {
        text_of("stage").or_else(|| text_of("state")).unwrap_or_default()
    } else {
        text_of("state").or_else(|| text_of("stage")).unwrap_or_default()
    }
}

async fn fetch_upload_status(host: &str, port: u16, upload_id: &str) -> Result<Value, String> {
    let path = format!("/api/uploads/{}", encode_uri_component(upload_id));
    let (status, text) = scalex_send(Method::GET, host, port, &path, None, Duration::from_secs(10)).await?;
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if is_success(status) && value.is_object() => Ok(value),
        _ => Err(format!("HTTP {status}")),
    }
}

struct UploadJob {
    host: String,
    port: u16,
    printer_id: String,
    file_path: String,
    file_name: String,
    total_bytes: u64,
    start_print_requested: bool,
    sent: Arc<AtomicU64>,
}

/// Returns whether a deferred start was queued. Never sends
/// `X-Start-Print: true` to a printer that isn't `operatorPrepared` — uploads
/// without starting, then registers a deferred start via /stored-files/start
/// (`queueIfNotPrepared: true`), same rule as own_manager.py's
/// send_in_background().
async fn run_upload(job: &UploadJob) -> Result<bool, String> {
    let printer = fetch_printers(&job.host, job.port, 6000)
        .await
        .ok()
        .and_then(|printers| {
            printers
                .into_iter()
                .find(|p| id_string(p.get("id")) == job.printer_id)
        });
    let printer_prepared = printer
        .as_ref()
        .and_then(|p| p.get("operatorPrepared"))
        .and_then(Value::as_bool)
        == Some(true);
    let needs_deferred_start = job.start_print_requested && !printer_prepared;
    let effective_start_print = job.start_print_requested && !needs_deferred_start;

    let file = tokio::fs::File::open(&job.file_path)
        .await
        .map_err(|e| format!("Unable to read file: {e}"))?;
    let sent = job.sent.clone();
    let stream = tokio_util::io::ReaderStream::with_capacity(file, UPLOAD_CHUNK_BYTES).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            sent.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        }
        chunk
    });

    let url = format!(
        "{}/api/printers/{}/files",
        base_url(&job.host, job.port),
        encode_uri_component(&job.printer_id)
    );
    let response = http_client()
        .post(url)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", job.total_bytes.to_string())
        .header("X-File-Name", encode_uri_component(&job.file_name))
        .header("X-Start-Print", if effective_start_print { "true" } else { "false" })
        .timeout(UPLOAD_POLL_DEADLINE)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !is_success(status) {
        return Err(format!("HTTP {status}"));
    }

    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mut last_uploaded_path = body.get("lastUploadedPath").and_then(Value::as_str).map(str::to_string);

    if let Some(scalex_upload_id) = body.get("uploadId").and_then(Value::as_str) {
        let deadline = Instant::now() + UPLOAD_POLL_DEADLINE;
        while Instant::now() < deadline {
            let upload_status = fetch_upload_status(&job.host, job.port, scalex_upload_id).await?;
            if let Some(path) = upload_status.get("lastUploadedPath").and_then(Value::as_str) {
                last_uploaded_path = Some(path.to_string());
            }
            if upload_status_is_terminal(&upload_status) {
                if upload_status_is_error(&upload_status) {
                    let message = upload_status_message(&upload_status);
                    return Err(if message.is_empty() { "Upload failed".to_string() } else { message });
                }
                break;
            }
            tokio::time::sleep(UPLOAD_POLL_INTERVAL).await;
        }
    }

    if needs_deferred_start {
        let Some(stored_path) = last_uploaded_path else {
            return Err("Upload finished, but ScaleX did not report a stored file path to start printing from.".to_string());
        };
        let start_path = format!(
            "/api/printers/{}/stored-files/start",
            encode_uri_component(&job.printer_id)
        );
        let start_body = json!({ "path": stored_path, "queueIfNotPrepared": true });
        let (start_status, _) =
            scalex_send(Method::POST, &job.host, job.port, &start_path, Some(start_body), Duration::from_secs(10)).await?;
        if !is_success(start_status) {
            return Err(format!("Uploaded, but queuing the deferred start failed (HTTP {start_status})."));
        }
    }

    Ok(needs_deferred_start)
}

async fn handle_upload_start(payload: &Value) -> (u16, Value) {
    let text_field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let raw_host = resolve_raw_host(payload);
    let Some((host, parsed_port)) = parse_host_and_port(&raw_host) else {
        return (400, json!({ "ok": false, "error": "Invalid host or IP address" }));
    };
    let upload_id = text_field("uploadId");
    let printer_id = text_field("printerId");
    let file_path = payload.get("filePath").and_then(Value::as_str).unwrap_or("").to_string();
    let file_name = text_field("fileName");
    if upload_id.is_empty() {
        return (400, json!({ "ok": false, "error": "Missing uploadId" }));
    }
    if printer_id.is_empty() {
        return (400, json!({ "ok": false, "error": "Missing printerId" }));
    }
    if file_path.trim().is_empty() {
        return (400, json!({ "ok": false, "error": "Missing filePath" }));
    }
    if file_name.is_empty() {
        return (400, json!({ "ok": false, "error": "Missing fileName" }));
    }
    let port = resolve_port(payload.get("port"), parsed_port);

    let total_bytes = match tokio::fs::metadata(&file_path).await {
        Ok(meta) => meta.len(),
        Err(e) => return (400, json!({ "ok": false, "error": e.to_string() })),
    };

    let sent = Arc::new(AtomicU64::new(0));
    if let Ok(mut map) = upload_progress().lock() {
        map.insert(
            upload_id.clone(),
            UploadProgressEntry { sent: sent.clone(), total: total_bytes, done: false, error: None },
        );
    }

    let job = UploadJob {
        host,
        port,
        printer_id: printer_id.clone(),
        file_path,
        file_name,
        total_bytes,
        start_print_requested: payload.get("startPrint").and_then(Value::as_bool) == Some(true),
        sent: sent.clone(),
    };
    let outcome = run_upload(&job).await;

    let finish = |error: Option<String>| {
        if let Ok(mut map) = upload_progress().lock() {
            if let Some(entry) = map.get_mut(&upload_id) {
                entry.done = true;
                entry.error = error;
                if entry.error.is_none() {
                    entry.sent.store(entry.total, Ordering::Relaxed);
                }
            }
        }
    };

    match outcome {
        Ok(deferred_start) => {
            finish(None);
            (200, json!({ "ok": true, "printerId": printer_id, "deferredStart": deferred_start }))
        }
        Err(message) => {
            finish(Some(message.clone()));
            (200, json!({ "ok": false, "error": message }))
        }
    }
}

fn handle_upload_progress(payload: &Value) -> (u16, Value) {
    let upload_id = payload.get("uploadId").and_then(Value::as_str).unwrap_or("");
    let snapshot = upload_progress().lock().ok().and_then(|map| {
        map.get(upload_id).map(|entry| {
            json!({
                "sentBytes": entry.sent.load(Ordering::Relaxed).min(entry.total),
                "totalBytes": entry.total,
                "done": entry.done,
                "error": entry.error,
            })
        })
    });
    (200, json!({ "upload": snapshot }))
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn dispatch_plugin_network_request(request_json: String) -> Result<PluginNetworkResponse, String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| format!("Invalid request JSON: {e}"))?;

    let plugin_id = request
        .get("pluginId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    // `operation` is a string from the desktop bridge, but the Next.js route
    // also accepts a path array — accept both.
    let operation = match request.get("operation") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("/"),
        _ => String::new(),
    };

    if plugin_id.is_empty() {
        return Ok(PluginNetworkResponse { status: 400, body: json!({ "error": "pluginId is required" }) });
    }
    if operation.is_empty() {
        return Ok(PluginNetworkResponse { status: 400, body: json!({ "error": "operation is required" }) });
    }
    if plugin_id != PLUGIN_ID {
        return Ok(PluginNetworkResponse {
            status: 404,
            body: json!({ "error": format!("Unknown network plugin: {plugin_id}") }),
        });
    }

    let op = operation.trim().trim_start_matches('/');
    let op = op.strip_prefix("scalex/").unwrap_or(op);

    let (status, body) = match op {
        "connect" => handle_connect(&request).await,
        "discover" => handle_discover(&request).await,
        "printers/list" => handle_printers_list(&request).await,
        "printers/edit" => handle_printers_edit(),
        "upload/start" => handle_upload_start(&request).await,
        "upload/progress" => handle_upload_progress(&request),
        "composition/warehouse" => handle_composition_warehouse(&request).await,
        "composition/save" => handle_composition_save(&request).await,
        _ => (404, json!({ "error": format!("Unknown ScaleX LAN Manager operation: {op}") })),
    };

    Ok(PluginNetworkResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_variants() {
        assert_eq!(parse_host_and_port("192.168.0.118"), Some(("192.168.0.118".to_string(), None)));
        assert_eq!(parse_host_and_port("192.168.0.118:8081"), Some(("192.168.0.118".to_string(), Some(8081))));
        assert_eq!(parse_host_and_port("http://scalex.local:9000"), Some(("scalex.local".to_string(), Some(9000))));
        assert_eq!(parse_host_and_port("   "), None);
    }

    #[test]
    fn port_resolution_prefers_payload_then_url_then_default() {
        assert_eq!(resolve_port(Some(&json!(8081)), Some(9000)), 8081);
        assert_eq!(resolve_port(Some(&json!("8083")), None), 8083);
        assert_eq!(resolve_port(Some(&json!(0)), Some(9000)), 9000);
        assert_eq!(resolve_port(None, None), DEFAULT_PORT);
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a b.goo"), "a%20b.goo");
        assert_eq!(encode_uri_component("Куб.ctb"), "%D0%9A%D1%83%D0%B1.ctb");
        assert_eq!(encode_uri_component("ok-_.!~*'()"), "ok-_.!~*'()");
    }

    #[test]
    fn busy_logic_matches_own_manager() {
        let idle = json!({ "status": { "currentStatus": 0, "printStatus": 0, "printStatusText": "idle" } });
        let printing = json!({ "status": { "currentStatus": 1, "printStatus": 3, "printStatusText": "printing" } });
        let uploading = json!({ "status": { "currentStatus": 0 }, "upload": { "done": false } });
        assert!(!is_printer_busy(&idle));
        assert!(is_printer_busy(&printing));
        assert!(is_printer_busy(&uploading));
    }
}
