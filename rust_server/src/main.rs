use std::time::{Duration, SystemTime}; // SystemTime is in std::time
use headers::UserAgent; // UserAgent comes directly from the headers crate
use tracing::trace; // Explicitly import the trace macro
use std::str::FromStr; // For Level::from_str and get_env_var parsing
use axum::extract::connect_info::ConnectInfo; // To get peer address


use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{StatusCode, header, HeaderMap},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use axum_extra::typed_header::TypedHeader; // Keep this for the extractor itself
use dashmap::DashMap;
// No longer need futures SinkExt/StreamExt as axum::ws::WebSocket has send/recv
// use futures::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
};
use tokio::{
    fs::File,
    io::AsyncReadExt,
    sync::{broadcast, Mutex},
    time::{self, Instant},
};
// Remove unused ServeDir import if fallback_service remains commented out
// use tower_http::services::ServeDir;
use tower_http::{
    trace::{DefaultMakeSpan, TraceLayer},
};
use tracing::{debug, error, info, warn, Level};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use std::env;
use dotenv::dotenv; // Requires `dotenv` crate in Cargo.toml
use once_cell::sync::Lazy; // Requires `once_cell` crate in Cargo.toml

// --- Configuration ---
fn get_env_var<T: std::str::FromStr>(name: &str, default: T) -> T {
  env::var(name)
      .ok()
      .and_then(|val| val.parse().ok())
      .unwrap_or(default)
}

fn get_env_var_string(name: &str, default: &str) -> String {
  env::var(name).unwrap_or_else(|_| default.to_string())
}

// Lazy static for static directory path, read from env once
static STATIC_DIR_PATH_CONFIG: Lazy<String> = Lazy::new(|| {
    get_env_var_string("STATIC_DIR_PATH", "static")
});


// --- Custom Error Type ---
#[derive(Debug, thiserror::Error)]
enum ParseError {
    #[error("Expected '{{' at index {0}, found '{1}'")]
    ExpectedOpenBrace(usize, char),
    #[error("Missing closing '}}' for key starting at brace {0}")]
    MissingKeyCloseBrace(usize),
    #[error("Expected '{{' for value of key '{key}' at index {index}, found '{found}'")]
    ExpectedValueOpenBrace { key: String, index: usize, found: char },
    #[error("Missing closing '}}' for value block of key '{0}' starting at {1}")]
    MissingValueCloseBrace(String, usize),
    #[error("Input ended prematurely after key '{0}'")]
    UnexpectedEndAfterKey(String),
    #[error("UTF-8 conversion error: {0}")]
    Utf8Error(#[from] std::str::Utf8Error),
}


// --- Data Structures ---
type CharacterDataMap = HashMap<String, Value>;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CharacterInfo {
    data: CharacterDataMap,
    #[serde(with = "system_time_serde")]
    timestamp: SystemTime,
}

mod system_time_serde {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub fn serialize<S>(date: &SystemTime, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let duration = date.duration_since(UNIX_EPOCH)
            .map_err(|_| serde::ser::Error::custom("SystemTime before UNIX EPOCH"))?;
        serializer.serialize_u64(duration.as_secs())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<SystemTime, D::Error>
    where
        D: Deserializer<'de>,
    {
        let secs = u64::deserialize(deserializer)?;
        Ok(UNIX_EPOCH + Duration::from_secs(secs))
    }
}

#[derive(Clone, Debug, Serialize)]
struct DeltaUpdate {
    updates: HashMap<String, CharacterDataMap>,
    deletions: Vec<String>,
}

// --- Shared State ---
struct AppStateInternal {
    character_data: DashMap<String, CharacterInfo>,
    pending_updates: Mutex<HashMap<String, CharacterDataMap>>,
    pending_deletions: Mutex<HashSet<String>>,
    delta_tx: broadcast::Sender<DeltaUpdate>,
}

type SharedState = Arc<AppStateInternal>;

// --- Parser Logic (REVISED for Rust) ---

fn parse_final_value(raw_value_block: &str) -> Value {
    let val = raw_value_block.trim();
    if val.is_empty() {
        return Value::String("".to_string());
    }

    let inner_val = if val.len() >= 2 && val.starts_with('{') && val.ends_with('}') {
        val[1..val.len() - 1].trim()
    } else if val.starts_with('{') {
        warn!("parse_final_value: Block starts with '{{' but doesn't end with '}}': '{}'", &val[..50.min(val.len())]);
        val[1..].trim()
    } else {
        warn!("parse_final_value: Expected braced value, got: '{}'", &val[..50.min(val.len())]);
        val
    };

    let cleaned_num_str = inner_val.replace(',', "");
    if let Ok(i) = cleaned_num_str.parse::<i64>() {
        Value::Number(i.into())
    } else if let Ok(f) = cleaned_num_str.parse::<f64>() {
        Value::Number(serde_json::Number::from_f64(f).unwrap_or_else(|| {
            warn!("Could not represent f64 '{}' accurately as JSON number", f);
            serde_json::Number::from(0)
        }))
    } else {
        Value::String(inner_val.to_string())
    }
}

fn parse_strict_key_value_pairs(text: &str) -> Result<CharacterDataMap, ParseError> {
    debug!("Starting STRICT parse. Input len={}", text.len());
    let text = text.trim();
    if text.is_empty() {
        warn!("STRICT PARSE: Input string is empty after stripping.");
        return Ok(HashMap::new());
    }

    let mut data = HashMap::new();
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    let mut parse_error_occurred = false; // For logging non-fatal issues if parsing continues partially

    while i < n {
        while i < n && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= n { break; }

        if bytes[i] != b'{' {
            error!("STRICT PARSE: Expected '{{' for key start at index {}, found '{}'", i, bytes[i] as char);
             return Err(ParseError::ExpectedOpenBrace(i, bytes[i] as char));
        }
        let key_brace_start = i;
        let mut key_brace_end = i + 1;
        while key_brace_end < n && bytes[key_brace_end] != b'}' {
            key_brace_end += 1;
        }

        if key_brace_end >= n {
            error!("STRICT PARSE: Missing '}}' for key starting at brace {}", key_brace_start);
            return Err(ParseError::MissingKeyCloseBrace(key_brace_start));
        }

        let key_slice = &bytes[key_brace_start + 1..key_brace_end];
        let key_str_trimmed = std::str::from_utf8(key_slice)?.trim();


        if key_str_trimmed.is_empty() {
            error!("STRICT PARSE: Empty key found ending at {}", key_brace_end);
             i = key_brace_end + 1;
            while i < n && bytes[i].is_ascii_whitespace() { i += 1; }
            if i >= n {
                warn!("STRICT PARSE: Reached end after empty key brace.");
                parse_error_occurred = true;
                break;
            }
            if bytes[i] == b'{' {
                let value_block_start = i;
                let mut level = 1;
                let mut j = i + 1;
                let mut skipped_value = false;
                while j < n {
                    match bytes[j] {
                        b'{' => level += 1,
                        b'}' => level -= 1,
                        _ => {}
                    }
                    if level == 0 {
                        i = j + 1;
                        warn!("STRICT PARSE: Skipped potential value block after empty key ({} to {}).", value_block_start, j);
                        skipped_value = true;
                        break;
                    }
                    j += 1;
                }
                if !skipped_value {
                    warn!("STRICT PARSE: Could not reliably skip value (unmatched braces?) after empty key near {}. Stopping parse.", key_brace_end);
                    parse_error_occurred = true;
                     break;
                 }
            } else {
                 error!("STRICT PARSE: Expected '{{' for value after empty key brace near {}, found '{}'. Stopping parse.", key_brace_end, bytes[i] as char);
                 parse_error_occurred = true; // Consider if this should be a hard error. For now, it sets flag and breaks.
                 // If this should be a fatal error for the whole parse:
                 // return Err(ParseError::ExpectedValueOpenBrace { key: "EMPTY_KEY_FOLLOWUP".to_string(), index: i, found: bytes[i] as char });
                break;
            }
             continue;
        }

        let key = key_str_trimmed.to_string();
        debug!("STRICT PARSE: Found key: '{}' (braces {}-{})", key, key_brace_start, key_brace_end);

        i = key_brace_end + 1;

        while i < n && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= n {
             error!("STRICT PARSE: Reached end of string after key '{}' before finding value's opening '{{'. Input likely truncated.", key);
             return Err(ParseError::UnexpectedEndAfterKey(key));
        }

        if bytes[i] != b'{' {
            error!("STRICT PARSE: Expected '{{' for value of key '{}' at index {}, but found '{}'", key, i, bytes[i] as char);
             return Err(ParseError::ExpectedValueOpenBrace{key: key, index: i, found: bytes[i] as char});
        }
        let value_block_start = i;
        debug!("STRICT PARSE: Value for '{}' starts with '{{' at {}. Scanning for matching brace.", key, value_block_start);

        let mut level = 1;
        let mut j = value_block_start + 1;
        let mut found_match = false;
        while j < n {
             match bytes[j] {
                b'{' => level += 1,
                b'}' => {
                    level -= 1;
                    if level == 0 {
                        let value_block_end = j;
                        let raw_value_block_str = std::str::from_utf8(&bytes[value_block_start..=value_block_end])?;

                        debug!(
                            "STRICT PARSE: Found matching '}}' for value at {}. Block: '{}...'",
                            value_block_end,
                            &raw_value_block_str[..50.min(raw_value_block_str.len())]
                        );

                        let final_value = parse_final_value(raw_value_block_str);
                        debug!(
                            "STRICT PARSE: Stored Key='{}', Value='{}...' (Type: {:?})",
                            key,
                            format!("{:?}", final_value).chars().take(50).collect::<String>(),
                             final_value.as_str().map_or_else(|| final_value.as_f64().map_or_else(|| final_value.as_i64().map_or("Other", |_|"i64"), |_|"f64"), |_|"String")
                        );
                        data.insert(key.clone(), final_value);

                        i = value_block_end + 1;
                        found_match = true;
                        break;
                    }
                 }
                _ => {}
            }
            j += 1;
        }

        if !found_match {
            error!("STRICT PARSE: Matching '}}' not found for value block of key '{}' starting at {}. Input likely corrupt or truncated.", key, value_block_start);
             return Err(ParseError::MissingValueCloseBrace(key, value_block_start));
        }
    }

     if parse_error_occurred {
         warn!("STRICT PARSE: Finished parsing prematurely due to non-fatal issue (e.g., empty key skip). Found {} valid key-value pairs.", data.len());
     } else if i >= n {
         info!("STRICT PARSE: Finished successfully. Found {} key-value pairs.", data.len());
     } else {
          warn!("STRICT PARSE: Loop exited unexpectedly at index {} before end ({}) without error flag. State: {} pairs found. Remainder: '{}...'",
             i, n, data.len(), String::from_utf8_lossy(&bytes[i..]).chars().take(50).collect::<String>());
     }

    Ok(data)
}


// --- HTTP Handler ---
async fn handle_http_update(
    State(state): State<SharedState>,
    body: String,
) -> Result<StatusCode, StatusCode> {
    let start_time = Instant::now();
    let log_msg_snippet = body.chars().take(100).collect::<String>();
    info!("Received HTTP POST data (len={}): {}...", body.len(), log_msg_snippet);

    if body.trim().is_empty() {
        warn!("HTTP POST processing failed: Received empty or whitespace-only body.");
        return Err(StatusCode::BAD_REQUEST);
    }

    match parse_strict_key_value_pairs(&body) {
        Ok(mut parsed_data) => {
            if parsed_data.is_empty() && !body.trim().is_empty() {
                 error!("HTTP POST processing failed: Parser returned empty data from non-empty input. Input: '{}...'", log_msg_snippet);
                 return Err(StatusCode::INTERNAL_SERVER_ERROR);
            } else if parsed_data.is_empty() {
                 warn!("HTTP POST: Input parsed to empty data, likely whitespace input.");
                 return Err(StatusCode::BAD_REQUEST);
            }


            let char_name_value = parsed_data.get("CHARACTER_NAME");

            let char_name = match char_name_value {
                 Some(Value::String(s)) if !s.is_empty() => s.clone(),
                 Some(Value::Number(n)) => n.to_string(),
                 _ => {
                    warn!("HTTP POST processing failed: Parsed data missing valid 'CHARACTER_NAME'. Keys: {:?}", parsed_data.keys().collect::<Vec<_>>());
                    return Err(StatusCode::BAD_REQUEST);
                 }
            };

            parsed_data.insert("CONNECTED".to_string(), Value::String("YES".to_string()));
            let now = SystemTime::now();

            let char_info = CharacterInfo {
                data: parsed_data.clone(),
                timestamp: now,
            };

            let action = if state.character_data.contains_key(&char_name) { "Updated" } else { "Added new" };
            state.character_data.insert(char_name.clone(), char_info);

            {
                let mut pending_updates_guard = state.pending_updates.lock().await;
                let mut pending_deletions_guard = state.pending_deletions.lock().await;

                pending_updates_guard.insert(char_name.clone(), parsed_data);
                if pending_deletions_guard.remove(&char_name) {
                    debug!("'{}' was pending deletion, removed from deletion list.", char_name);
                }
                 info!("{} character data for: {}. Added to pending updates. Processing time: {:?}", action, char_name, start_time.elapsed());
            }
            Ok(StatusCode::OK)
        }
        Err(e) => {
            error!("HTTP POST processing failed during parsing: {}. Data: '{}...'", e, log_msg_snippet);
            Err(StatusCode::BAD_REQUEST)
        }
    }
}

// --- WebSocket Handler ---
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    user_agent: Option<TypedHeader<UserAgent>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user_agent_str = user_agent.map_or_else(|| "Unknown".to_string(), |ua| ua.0.to_string());
    debug!("WebSocket connection attempt from User-Agent: {}", user_agent_str);
    debug!("WebSocket Headers: {:?}", headers);
    ws.on_upgrade(move |socket| handle_socket(socket, state, user_agent_str, addr))
}


// --- Individual WebSocket Connection Logic ---
async fn handle_socket(mut socket: WebSocket, state: SharedState, user_agent: String, peer_addr: SocketAddr) {
    info!("WebSocket client connected: {} (User-Agent: {})", peer_addr, user_agent);

    let mut delta_rx = state.delta_tx.subscribe();

     let initial_state: HashMap<String, CharacterDataMap> = state
         .character_data
         .iter()
         .map(|entry| (entry.key().clone(), entry.value().data.clone()))
         .collect();

     if !initial_state.is_empty() {
         match serde_json::to_string(&initial_state) {
             Ok(json_string) => {
                  info!("Attempting send snapshot string (len={}) to target: {}", json_string.len(), peer_addr);
                 if let Err(e) = socket.send(Message::Text(json_string)).await {
                     warn!("Failed to send initial state to {}: {}", peer_addr, e);
                 } else {
                     info!("Successfully sent initial state snapshot string to {}", peer_addr);
                 }
             }
             Err(e) => {
                 error!("Failed to serialize initial state for {}: {}", peer_addr, e);
                 let _ = socket.close().await;
                 return;
             }
         }
     } else {
         debug!("Initial state is empty, sending empty JSON object {{}} to {}", peer_addr);
          if let Err(e) = socket.send(Message::Text("{}".to_string())).await {
              warn!("Failed to send empty initial state to {}: {}", peer_addr, e);
          }
     }

     loop {
         tokio::select! {
             msg_option = socket.recv() => {
                 match msg_option {
                     Some(Ok(msg)) => {
                         match msg {
                             Message::Text(t) => {
                                 debug!("Received text message from {}: {}...", peer_addr, t.chars().take(50).collect::<String>());
                             }
                             Message::Binary(_) => {
                                 warn!("Received unexpected binary message from {}", peer_addr);
                             }
                             Message::Ping(p) => {
                                 trace!("Received Ping from {}, sending Pong", peer_addr);
                                 if socket.send(Message::Pong(p)).await.is_err() {
                                      info!("{} disconnected while sending Pong.", peer_addr);
                                     break;
                                 }
                             }
                              Message::Pong(_) => {
                                 trace!("Received Pong from {}", peer_addr);
                              }
                             Message::Close(c) => {
                                 info!("Received Close frame from {}: {:?}", peer_addr, c);
                                 break;
                             }
                         }
                     }
                     Some(Err(e)) => {
                         warn!("Error receiving message from {}: {}", peer_addr, e);
                         break;
                     }
                     None => {
                         info!("WebSocket client {} disconnected (recv returned None).", peer_addr);
                         break;
                     }
                 }
             },

             delta_result = delta_rx.recv() => {
                 match delta_result {
                     Ok(delta) => {
                         match serde_json::to_string(&delta) {
                             Ok(json_string) => {
                                 trace!("Sending delta update ({} updates, {} deletions, len={}) to {}", delta.updates.len(), delta.deletions.len(), json_string.len(), peer_addr);
                                 if let Err(e) = socket.send(Message::Text(json_string)).await {
                                      warn!("Failed to send delta update to {}: {}. Client likely disconnected.", peer_addr, e);
                                     break;
                                 }
                             }
                             Err(e) => {
                                 error!("Failed to serialize delta update for {}: {}", peer_addr, e);
                             }
                         }
                     },
                     Err(broadcast::error::RecvError::Lagged(n)) => {
                         warn!("WebSocket client {} lagged behind delta updates by {} messages. Consider increasing channel capacity.", peer_addr, n);
                     }
                     Err(broadcast::error::RecvError::Closed) => {
                         error!("Broadcast channel closed unexpectedly. Cannot send further deltas to {}. This is a server error.", peer_addr);
                         break;
                     }
                 }
             }
         }
     }
     info!("WebSocket client {} connection handler finished.", peer_addr);
     let _ = socket.close().await;
}


// --- Background Task: Pruning Old Data ---
async fn prune_loop(state: SharedState, prune_interval: Duration, data_timeout: Duration) {
    info!("Starting prune loop. Interval: {:?}, Timeout: {:?}", prune_interval, data_timeout);
    let mut interval = time::interval(prune_interval);
    interval.tick().await; // Consume the initial immediate tick

    loop {
        interval.tick().await;
        let now = SystemTime::now();
        let mut names_to_prune = Vec::new();

        state.character_data.retain(|name, info| {
            match now.duration_since(info.timestamp) {
                Ok(age) if age > data_timeout => {
                    names_to_prune.push(name.clone());
                    false
                }
                Ok(_) => true,
                Err(_) => {
                    warn!("System clock went backwards? Character '{}' timestamp is in the future.", name);
                    true
                }
            }
        });

        if !names_to_prune.is_empty() {
            let pruned_count = names_to_prune.len();
            {
                let mut pending_deletions_guard = state.pending_deletions.lock().await;
                let mut pending_updates_guard = state.pending_updates.lock().await;
                for name in &names_to_prune {
                    pending_deletions_guard.insert(name.clone());
                    pending_updates_guard.remove(name);
                }
            }
             info!("Pruned {} inactive characters: {:?}. Marked for deletion broadcast.", pruned_count, names_to_prune);
        } else {
             trace!("Prune check completed. No characters timed out.");
        }
    }
}


// --- Background Task: Broadcasting Deltas and Checking Connection Timeouts ---
async fn broadcast_loop(state: SharedState, broadcast_interval: Duration, connection_timeout: Duration) {
     info!("Starting broadcast loop. Interval: {:?}, Connection Timeout: {:?}", broadcast_interval, connection_timeout);
    let mut interval = time::interval(broadcast_interval);
    interval.tick().await; // Consume the initial immediate tick

    loop {
        interval.tick().await;
        let now = SystemTime::now();
        let mut needs_broadcast = false;
        let mut disconnected_names = Vec::new();

        state.character_data.iter().for_each(|entry| {
            let name = entry.key();
            let info = entry.value();
            if info.data.get("CONNECTED").and_then(|v| v.as_str()) == Some("YES") {
                if let Ok(age) = now.duration_since(info.timestamp) {
                    if age > connection_timeout {
                        disconnected_names.push(name.clone());
                    }
                }
            }
        });

        if !disconnected_names.is_empty() {
            // These locks are now correctly scoped for just updating character_data for disconnects
            // The delta preparation logic below will pick these up as updates.
            // Note: pending_updates_guard and pending_deletions_guard are NOT locked here.
            // That happens later in the delta preparation stage.

            for name in &disconnected_names {
                 if let Some(mut char_info_entry) = state.character_data.get_mut(name) {
                      if char_info_entry.data.get("CONNECTED").and_then(|v| v.as_str()) == Some("YES") {
                          info!("Marking '{}' as disconnected due to timeout.", name);
                           char_info_entry.data.insert("CONNECTED".to_string(), Value::String("NO".to_string()));
                           // This modification to char_info_entry.data directly modifies the DashMap.
                           // Now, we need to ensure this change is captured for broadcast.
                           // We add it to pending_updates.
                           { // New scope for lock
                               let mut pending_updates_guard = state.pending_updates.lock().await;
                               let mut pending_deletions_guard = state.pending_deletions.lock().await; // Lock to ensure consistency if a prune happens
                               pending_updates_guard.insert(name.clone(), char_info_entry.data.clone());
                               pending_deletions_guard.remove(name); // If it was marked for deletion, unmark it as it's an update now
                           }
                           needs_broadcast = true;
                      }
                 }
            }
        }


        let delta_to_send: Option<DeltaUpdate>;
        {
            let mut pending_updates_guard = state.pending_updates.lock().await;
            let mut pending_deletions_guard = state.pending_deletions.lock().await;

            if !pending_updates_guard.is_empty() || !pending_deletions_guard.is_empty() {
                needs_broadcast = true;

                let updates = std::mem::take(&mut *pending_updates_guard);
                let deletions = std::mem::take(&mut *pending_deletions_guard)
                                    .into_iter()
                                    .collect();
                delta_to_send = Some(DeltaUpdate { updates, deletions });
            } else {
                delta_to_send = None;
            }
        }

        if needs_broadcast {
            if let Some(delta) = delta_to_send {
                let num_subscribers = state.delta_tx.receiver_count();
                 if num_subscribers > 0 {
                    info!(
                        "Broadcasting delta. Updates: {}, Deletions: {}. Subscribers: {}",
                        delta.updates.len(),
                        delta.deletions.len(),
                        num_subscribers
                    );
                    if let Err(e) = state.delta_tx.send(delta) {
                         error!("Error broadcasting delta update ({} receivers exist): {}", num_subscribers, e);
                    }
                 } else {
                     debug!("No subscribers connected for delta broadcast.");
                 }
            } else if disconnected_names.is_empty() { // Only log if no delta AND no disconnects (which should have made a delta)
                 trace!("Broadcast check: Flag was set, but no new delta prepared.");
            }
        } else {
             trace!("Broadcast check: No changes detected.");
        }
    }
}


// --- Static File Handler ---
async fn handle_root() -> impl IntoResponse {
    // Use the Lazy static configuration value
    let html_file_path = PathBuf::from(&*STATIC_DIR_PATH_CONFIG).join("subscriber_client.html");
    info!("Serving root request with file: {:?}", html_file_path);

    match File::open(&html_file_path).await {
        Ok(mut file) => {
            let mut contents = String::new();
            if let Err(e) = file.read_to_string(&mut contents).await {
                 error!("Failed to read static file {:?}: {}", html_file_path, e);
                 return (StatusCode::INTERNAL_SERVER_ERROR, Html("Error reading client page.".to_string())).into_response();
            }
             let mime_type = mime_guess::from_path(&html_file_path).first_or_text_plain().to_string();
             (StatusCode::OK, [(header::CONTENT_TYPE, mime_type)], Html(contents)).into_response()
        }
        Err(e) => {
             error!("Static file subscriber_client.html not found or readable at {:?}: {}", html_file_path, e);
             (StatusCode::NOT_FOUND, Html("404: Client Page Not Found".to_string())).into_response()
        }
    }
}


// --- Main Application Setup ---
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok(); // Load environment variables from .env file

    // --- Configuration Loading ---
    let http_host = get_env_var_string("HTTP_HOST", "0.0.0.0");
    let http_port = get_env_var("HTTP_PORT", 8080u16);
    let prune_interval_seconds = get_env_var("PRUNE_INTERVAL_SECONDS", 60u64);
    let data_timeout_minutes = get_env_var("DATA_TIMEOUT_MINUTES", 30u64);
    let broadcast_interval_seconds = get_env_var("BROADCAST_INTERVAL_SECONDS", 0.2f64);
    let connection_timeout_seconds = get_env_var("CONNECTION_TIMEOUT_SECONDS", 5u64);

    let log_level_str = get_env_var_string("LOG_LEVEL", "INFO");
    let log_level = Level::from_str(&log_level_str.to_lowercase())
                        .unwrap_or(Level::INFO);

    // STATIC_DIR_PATH is handled by the STATIC_DIR_PATH_CONFIG Lazy static

    // --- Tracing Initialization ---
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive(log_level.into()))
        .init();

    info!("Starting server...");
    info!("Log level set to: {:?}", log_level);
    info!("HTTP Host: {}", http_host);
    info!("HTTP Port: {}", http_port);
    info!("Static Directory: {}", &*STATIC_DIR_PATH_CONFIG); // Log the static dir path

    // --- Durations for background tasks ---
    let prune_interval_duration = Duration::from_secs(prune_interval_seconds);
    let data_timeout_duration = Duration::from_secs(data_timeout_minutes * 60);
    let broadcast_interval_duration = Duration::from_secs_f64(broadcast_interval_seconds);
    let connection_timeout_duration = Duration::from_secs(connection_timeout_seconds);


    let (delta_tx, _) = broadcast::channel::<DeltaUpdate>(100);

    let shared_state = Arc::new(AppStateInternal {
        character_data: DashMap::new(),
        pending_updates: Mutex::new(HashMap::new()),
        pending_deletions: Mutex::new(HashSet::new()),
        delta_tx,
    });

    let prune_state = Arc::clone(&shared_state);
    let prune_handle = tokio::spawn(async move {
        prune_loop(prune_state, prune_interval_duration, data_timeout_duration).await;
    });

    let broadcast_state = Arc::clone(&shared_state);
    let broadcast_handle = tokio::spawn(async move {
        broadcast_loop(broadcast_state, broadcast_interval_duration, connection_timeout_duration).await;
    });

    let app = Router::new()
        .route("/update", post(handle_http_update))
        .route("/", get(handle_root))
        .route("/ws", get(ws_handler))
        .with_state(shared_state)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(|response: &Response, latency: Duration, _span: &tracing::Span| {
                    info!(status = ?response.status(), latency = ?latency, "Processed request");
                }),
        );

    let addr_str = format!("{}:{}", http_host, http_port);
    let addr: SocketAddr = addr_str.parse()?;
    info!("HTTP/WebSocket server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal(prune_handle, broadcast_handle))
        .await?;

    info!("Server shutdown complete.");
    Ok(())
}

// --- Graceful Shutdown Signal Handler ---
async fn shutdown_signal(
    prune_handle: tokio::task::JoinHandle<()>,
    broadcast_handle: tokio::task::JoinHandle<()>,
) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => { info!("Received Ctrl+C signal.")},
        _ = terminate => { info!("Received terminate signal.")},
    }

    info!("Initiating graceful shutdown...");
    info!("Cancelling background tasks...");
    prune_handle.abort();
    broadcast_handle.abort();
    info!("Background tasks cancellation requested.");
}