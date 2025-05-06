# -*- coding: utf-8 -*-
# --- Imports and Setup (REVISED) ---
import asyncio
import aiohttp
from aiohttp import web, WSMsgType # WSMsgType for aiohttp WebSockets
import json # Standard json, orjson might need more care with aiohttp send_json
import orjson # Using orjson for faster JSON operations for data processing
import time
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
import os 
from dotenv import load_dotenv 

load_dotenv() 

# --- Configuration ---
SERVER_HOST = os.getenv("SERVER_HOST", "localhost")
SERVER_PORT = int(os.getenv("SERVER_PORT", 8080))
PRUNE_INTERVAL_SECONDS = int(os.getenv("PRUNE_INTERVAL_SECONDS", 60))
DATA_TIMEOUT_MINUTES = int(os.getenv("DATA_TIMEOUT_MINUTES", 30))
BROADCAST_INTERVAL_SECONDS = float(os.getenv("BROADCAST_INTERVAL_SECONDS", 0.2))
CONNECTION_TIMEOUT_SECONDS = float(os.getenv("CONNECTION_TIMEOUT_SECONDS", 5.0)) 

# Convert LOG_LEVEL string from .env to logging level constant
log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_LEVEL = getattr(logging, log_level_str, logging.INFO)

# --- Paths and Globals ---
SCRIPT_DIR = Path(__file__).parent
STATIC_DIR = SCRIPT_DIR / "static"

character_data = {}
subscribers = set()
STATE_LOCK = asyncio.Lock()
pending_updates = {}
pending_deletions = set()

# --- Logging Setup ---
logging.basicConfig(level=LOG_LEVEL, format='%(asctime)s %(levelname)-8s %(name)-10s: %(message)s')
app_logger = logging.getLogger("App")
parser_logger = logging.getLogger("Parser")
http_logger = logging.getLogger("HTTP_WS")
parser_logger.setLevel(LOG_LEVEL)
app_logger.setLevel(LOG_LEVEL)
http_logger.setLevel(LOG_LEVEL)


# --- Parser Logic (Keep as is - assuming it's correct from previous steps) ---
def parse_final_value(raw_value_block):
    val = raw_value_block.strip()
    processed_val_str = val
    if not val: return ""
    if len(val) >= 2 and val.startswith('{') and val.endswith('}'):
        inner_val = val[1:-1].strip()
        processed_val_str = inner_val
    elif val.startswith('{'):
         parser_logger.warning(f"parse_final_value: Received block starting '{{' but not ending '}}': '{val[:50]}...'. Parsing inner content as fallback.")
         processed_val_str = val[1:].strip()
    cleaned_num_str = processed_val_str.replace(',', '')
    try: return int(cleaned_num_str)
    except ValueError:
        try: return float(cleaned_num_str)
        except ValueError: return processed_val_str

def parse_strict_key_value_pairs(text):
    global parser_logger
    if 'parser_logger' not in globals():
        parser_logger = logging.getLogger("Parser_Standalone")
        parser_logger.warning("Using standalone parser logger.")
    parser_logger.debug(f"Starting STRICT parse. Input len={len(text)}. Snippet='{text[:80]}...'")
    text = text.strip()
    if not text:
        parser_logger.error("STRICT PARSE: Input string is empty after stripping.")
        return {}
    data = {}
    n = len(text)
    i = 0
    parse_error_occurred = False
    while i < n:
        while i < n and text[i].isspace(): i += 1
        if i >= n: break
        if text[i] != '{':
            parser_logger.error(f"STRICT PARSE: Expected '{{' for key start at index {i}, found '{text[i]}'. Near: '...{text[max(0,i-10):min(n,i+10)]}...'")
            parse_error_occurred = True; break
        key_brace_start = i
        key_brace_end = text.find('}', key_brace_start + 1)
        if key_brace_end == -1:
            parser_logger.error(f"STRICT PARSE: Missing '}}' for key starting at brace {key_brace_start}. Remainder: '{text[i:]}'")
            parse_error_occurred = True; break
        key = text[key_brace_start + 1 : key_brace_end].strip()
        # parser_logger.debug(f"STRICT PARSE: Found key: '{key}' (braces {key_brace_start}-{key_brace_end})") # Reduced verbosity
        if not key:
            parser_logger.error(f"STRICT PARSE: Empty key found ending at {key_brace_end}.")
            i = key_brace_end + 1
            while i < n and text[i].isspace(): i += 1
            if i >= n: parse_error_occurred = True; break
            if text[i] == '{':
                value_block_start_skip = i; level_skip = 1; j_skip = i + 1; skipped = False
                while j_skip < n:
                    char_skip = text[j_skip]
                    if char_skip == '{': level_skip += 1
                    elif char_skip == '}': level_skip -= 1
                    if level_skip == 0:
                        i = j_skip + 1
                        parser_logger.warning(f"STRICT PARSE: Skipped potential value block after empty key ({value_block_start_skip} to {j_skip}).")
                        skipped = True; break
                    j_skip += 1
                if not skipped: parse_error_occurred = True; break
            else: parse_error_occurred = True; break
            continue
        i = key_brace_end + 1
        while i < n and text[i].isspace(): i += 1
        if i >= n:
             parser_logger.error(f"STRICT PARSE: Reached end after key '{key}' before value's '{{'.")
             parse_error_occurred = True; break
        if text[i] != '{':
            parser_logger.error(f"STRICT PARSE: Expected '{{' for value of key '{key}' at index {i}, found '{text[i]}'. Near: '...{text[max(0,i-10):min(n,i+10)]}...'")
            parse_error_occurred = True; break
        value_block_start = i
        level = 1; j = value_block_start + 1; found_match = False
        while j < n:
            char = text[j]
            if char == '{': level += 1
            elif char == '}': level -= 1
            if level == 0:
                value_block_end = j
                raw_value_block = text[value_block_start : value_block_end + 1]
                final_value = parse_final_value(raw_value_block)
                data[key] = final_value
                # parser_logger.debug(f"STRICT PARSE: Stored Key='{key}', Value='{str(final_value)[:50]}...' (Type: {type(final_value)})") # Reduced verbosity
                i = value_block_end + 1; found_match = True; break
            j += 1
        if not found_match:
            parser_logger.error(f"STRICT PARSE: Matching '}}' not found for value of key '{key}' starting at {value_block_start}.")
            parse_error_occurred = True
            if key in data: del data[key]
            break
    if parse_error_occurred: parser_logger.warning(f"STRICT PARSE: Finished prematurely. Found {len(data)} pairs.")
    elif i >= n: parser_logger.info(f"STRICT PARSE: Finished successfully. Found {len(data)} pairs.")
    else: parser_logger.warning(f"STRICT PARSE: Loop exited unexpectedly at {i} before end ({n}). {len(data)} pairs. Remainder: '{text[i:min(i+50, n)]}...'")
    return data

# --- Shared Data Processing Logic (Keep as is) ---
async def process_data_string(message_string):
    log_msg_snippet = message_string[:200] + ('...' if len(message_string) > 200 else '')
    loop = asyncio.get_running_loop()
    try:
        parsed_data = await loop.run_in_executor(None, parse_strict_key_value_pairs, message_string)
    except Exception as parse_exc:
        app_logger.error(f"Parser failed unexpectedly in executor: {parse_exc}. Msg: '{log_msg_snippet}'", exc_info=True)
        raise ValueError(f"Parsing failed unexpectedly in executor: {parse_exc}") from parse_exc

    if not parsed_data:
        if message_string.strip():
            app_logger.warning(f"Parser returned empty data despite non-empty input. Msg: '{log_msg_snippet}'")
            raise ValueError("Parsing resulted in empty data from non-empty input")
        else:
             app_logger.info(f"Parser correctly returned empty data for empty input.")
             raise ValueError("Parsing resulted in empty data (input was empty/whitespace)")
    char_name = parsed_data.get("CHARACTER_NAME")
    if not char_name:
        keys_found = list(parsed_data.keys())
        app_logger.warning(f"Parsed data missing 'CHARACTER_NAME'. Keys: {keys_found[:20]}. Ignoring.")
        raise ValueError("Parsed data missing CHARACTER_NAME")
    if not isinstance(char_name, str): char_name = str(char_name)
    parsed_data["CONNECTED"] = "YES"
    now = time.time()
    async with STATE_LOCK:
        action = "Updated" if char_name in character_data else "Added new"
        character_data[char_name] = {"data": parsed_data, "timestamp": now}
        pending_updates[char_name] = parsed_data
        if char_name in pending_deletions:
            pending_deletions.discard(char_name)
        app_logger.info(f"{action} character data for: {char_name}. Added to pending updates.")

# --- HTTP Server Logic (Keep as is for /update and /) ---
async def handle_http_update(request):
    raw_data = "<empty>"
    try:
        if request.method != "POST":
            http_logger.warning(f"Received non-POST request ({request.method}) on update endpoint.")
            return web.Response(status=405, text="Method Not Allowed")
        if not request.can_read_body:
             http_logger.warning("Received POST request with no body.")
             return web.Response(status=400, text="Bad Request: Missing request body")
        raw_data = await request.text()
        http_logger.info(f"Received HTTP POST data from {request.remote} (len={len(raw_data)}): {raw_data[:100]}...")
        await process_data_string(raw_data)
        http_logger.debug(f"Successfully processed HTTP data from {request.remote}")
        return web.Response(status=200, text="OK")
    except ValueError as e:
         http_logger.error(f"HTTP POST processing failed for {request.remote}: {e}. Data: '{raw_data[:100]}...'")
         return web.Response(status=400, text=f"Bad Request: {e}")
    except Exception as e:
         http_logger.error(f"Unexpected error handling HTTP request from {request.remote}: {e}", exc_info=True)
         return web.Response(status=500, text="Internal Server Error")

async def handle_root(request):
    html_file_path = STATIC_DIR / "subscriber_client.html"
    if not html_file_path.is_file():
        http_logger.error(f"Static file subscriber_client.html not found at: {html_file_path}")
        return web.Response(status=404, text="404: Client Page Not Found")
    http_logger.debug(f"Serving root request with file: {html_file_path}")
    return web.FileResponse(html_file_path)


# --- WebSocket Logic (REVISED for aiohttp and AttributeError fix) ---
async def send_full_update_aiohttp(ws_response: web.WebSocketResponse):
    """Sends the full current state to a single aiohttp WebSocket client."""
    # FIX: Access stored address
    target_addr = getattr(ws_response, '_app_client_remote_addr', "UnknownClient_SFU")
    log_prefix = f"SEND_FULL_SNAPSHOT [INITIAL_AIOHTTP] to {target_addr}:"

    data_to_send = {}
    async with STATE_LOCK:
        data_to_send = {name: info["data"] for name, info in character_data.items()}

    message_bytes = b'{}'
    if data_to_send:
        try:
            message_bytes = orjson.dumps(data_to_send)
        except Exception as e:
            app_logger.error(f"{log_prefix} ORJSON serialization failed for initial snapshot: {e}", exc_info=True)
            return
    try:
        message_str = message_bytes.decode('utf-8')
        await ws_response.send_str(message_str)
        app_logger.info(f"{log_prefix} --> Successfully sent initial state snapshot (len={len(message_str)}).")
    except ConnectionResetError:
        app_logger.warning(f"{log_prefix} Connection reset before initial state could be sent.")
    except RuntimeError as e:
        app_logger.warning(f"{log_prefix} Runtime error (often connection closing) sending initial state: {e}")
    except Exception as e:
        app_logger.error(f"{log_prefix} Error sending initial state: {e}", exc_info=True)

async def send_delta_update_aiohttp():
    """Broadcasts delta updates to all subscribed aiohttp WebSocket clients."""
    log_prefix = "SEND_DELTA_UPDATE [BROADCAST_AIOHTTP]:"
    updates_to_send = {}
    deletions_to_send = []

    async with STATE_LOCK:
        if not pending_updates and not pending_deletions:
            return
        updates_to_send = pending_updates.copy()
        deletions_to_send = list(pending_deletions)
        pending_updates.clear()
        pending_deletions.clear()

    delta_message = {"updates": updates_to_send, "deletions": deletions_to_send}
    # app_logger.info(f"{log_prefix} Prepared delta. Updates: {len(updates_to_send)}, Deletions: {len(deletions_to_send)}") # Can be verbose

    message_bytes = b''
    try:
        message_bytes = orjson.dumps(delta_message)
    except Exception as e:
        app_logger.error(f"{log_prefix} ORJSON serialization failed for delta: {e}", exc_info=True)
        return

    message_str = ''
    try:
        message_str = message_bytes.decode('utf-8')
    except UnicodeDecodeError as e:
         app_logger.error(f"{log_prefix} Failed to decode orjson delta bytes to UTF-8: {e}", exc_info=True)
         return

    current_subscribers = set()
    async with STATE_LOCK:
        current_subscribers = subscribers.copy()

    if not current_subscribers:
        # app_logger.debug(f"{log_prefix} No subscribers connected for delta broadcast.") # Can be verbose
        return

    app_logger.info(f"{log_prefix} Broadcasting delta (len={len(message_str)}) to {len(current_subscribers)} subscribers.")
    tasks = [sub.send_str(message_str) for sub in current_subscribers]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    failed_subs_to_remove = set()
    success_count = 0
    subscriber_list_for_results = list(current_subscribers)

    for i, result in enumerate(results):
        if i < len(subscriber_list_for_results):
            current_sub = subscriber_list_for_results[i]
            # FIX: Access stored address
            sub_addr = getattr(current_sub, '_app_client_remote_addr', f"UnknownSub{i}")
            if isinstance(result, (ConnectionResetError, RuntimeError)):
                app_logger.warning(f"{log_prefix} WS delta send failed to {sub_addr}: {type(result).__name__}. Marking for removal.")
                failed_subs_to_remove.add(current_sub)
            elif isinstance(result, Exception):
                app_logger.error(f"{log_prefix} WS delta send failed to {sub_addr} with unexpected error: {result}", exc_info=result)
                failed_subs_to_remove.add(current_sub)
            else:
                success_count += 1
        else:
            app_logger.error(f"{log_prefix} Result index {i} out of bounds for subscriber list.")

    # app_logger.debug(f"{log_prefix} --> Delta broadcast results: {success_count} success, {len(failed_subs_to_remove)} failures.") # Can be verbose

    if failed_subs_to_remove:
        app_logger.info(f"{log_prefix} Removing {len(failed_subs_to_remove)} disconnected WS subscribers after delta broadcast.")
        async with STATE_LOCK:
            initial_count = len(subscribers)
            subscribers.difference_update(failed_subs_to_remove)
            removed_count = initial_count - len(subscribers)
            app_logger.info(f"{log_prefix} Removed {removed_count}. Subscribers remaining: {len(subscribers)}")


async def register_aiohttp(ws_response: web.WebSocketResponse):
    """Registers an aiohttp WebSocket client."""
    # FIX: Access stored address
    addr = getattr(ws_response, '_app_client_remote_addr', "UnknownClient_REG")
    app_logger.info(f"REGISTER_AIOHTTP: WS Subscriber connecting: {addr}")
    async with STATE_LOCK:
        subscribers.add(ws_response)
        app_logger.info(f"REGISTER_AIOHTTP: Added {addr} to subscribers. Total: {len(subscribers)}")

    app_logger.info(f"REGISTER_AIOHTTP: Attempting initial state snapshot send to {addr}...")
    try:
        await send_full_update_aiohttp(ws_response) # ws_response already has the _app_client_remote_addr
        app_logger.info(f"REGISTER_AIOHTTP: Initial state snapshot send attempt completed for {addr}.")
    except Exception as e:
        app_logger.error(f"REGISTER_AIOHTTP: Exception during initial send_full_update_aiohttp for {addr}: {e}", exc_info=True)

async def unregister_aiohttp(ws_response: web.WebSocketResponse):
    """Unregisters an aiohttp WebSocket client."""
    removed = False
    # FIX: Access stored address
    addr = getattr(ws_response, '_app_client_remote_addr', "UnknownClient_UNREG")
    async with STATE_LOCK:
        if ws_response in subscribers:
            subscribers.discard(ws_response)
            removed = True
    if removed:
        app_logger.info(f"UNREGISTER_AIOHTTP: WS Subscriber disconnected/unregistered: {addr}. Total: {len(subscribers)}")

async def websocket_handler(request: web.Request):
    """aiohttp WebSocket handler."""
    # Get remote address from the original request object
    initial_client_addr = request.remote
    app_logger.info(f"WebSocket connection establishing from: {initial_client_addr}")

    ws = web.WebSocketResponse()
    await ws.prepare(request) # Perform WebSocket handshake

    # FIX: Store the remote address on the WebSocketResponse object itself
    # as it doesn't naturally carry the original request object around post-prepare.
    ws._app_client_remote_addr = initial_client_addr
    # Now 'ws' can be passed around, and helpers can access ws._app_client_remote_addr

    # The client address used for logging within this handler can now consistently be ws._app_client_remote_addr
    client_addr_for_logs = ws._app_client_remote_addr
    app_logger.info(f"WebSocket connection established and prepared for: {client_addr_for_logs}")


    await register_aiohttp(ws)

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                app_logger.debug(f"WS Received from {client_addr_for_logs}: {msg.data}")
                if msg.data == 'close':
                    await ws.close()
            elif msg.type == WSMsgType.ERROR:
                app_logger.error(f'WS connection for {client_addr_for_logs} closed with exception {ws.exception()}')
            elif msg.type == WSMsgType.CLOSED:
                app_logger.info(f"WS connection for {client_addr_for_logs} gracefully closed by client.")
                break
    except ConnectionResetError:
        app_logger.warning(f"WebSocket connection from {client_addr_for_logs} reset abruptly.")
    except asyncio.CancelledError:
        app_logger.info(f"WebSocket handler for {client_addr_for_logs} cancelled during shutdown.")
        if not ws.closed: await ws.close(code=aiohttp.WSCloseCode.GOING_AWAY, message=b'Server shutdown')
        raise
    except Exception as e:
        app_logger.error(f"Unexpected error in WebSocket handler for {client_addr_for_logs}: {e}", exc_info=True)
    finally:
        app_logger.info(f"WebSocket connection closing for {client_addr_for_logs}.")
        await unregister_aiohttp(ws)
        if not ws.closed:
            app_logger.debug(f"Ensuring WebSocket for {client_addr_for_logs} is closed in finally block.")
            await ws.close()
        app_logger.info(f"WebSocket connection for {client_addr_for_logs} definitely closed and unregistered.")
    return ws

# --- Background Tasks (Pruning and Broadcasting - REVISED broadcast) ---
async def prune_old_data(): # Logic remains largely the same
    while True:
        await asyncio.sleep(PRUNE_INTERVAL_SECONDS)
        now = time.time()
        timeout_seconds = DATA_TIMEOUT_MINUTES * 60
        names_to_prune = []
        async with STATE_LOCK:
            for name, info in character_data.items():
                if now - info.get("timestamp", 0) > timeout_seconds:
                    names_to_prune.append(name)
        if names_to_prune:
            async with STATE_LOCK:
                pruned_count = 0; actual_pruned_names = []
                for name in names_to_prune:
                    if name in character_data and now - character_data[name].get("timestamp", 0) > timeout_seconds:
                        del character_data[name]
                        pending_deletions.add(name)
                        if name in pending_updates: del pending_updates[name]
                        pruned_count += 1; actual_pruned_names.append(name)
            if pruned_count > 0:
                app_logger.info(f"Pruned {pruned_count} inactive characters: {', '.join(actual_pruned_names)}. Marked for deletion.")

async def broadcast_loop(): # Uses new send_delta_update_aiohttp
    app_logger.info(f"Starting broadcast loop. Interval: {BROADCAST_INTERVAL_SECONDS}s, Connection Timeout: {CONNECTION_TIMEOUT_SECONDS}s")
    while True:
        await asyncio.sleep(BROADCAST_INTERVAL_SECONDS)
        now = time.time()
        needs_broadcast = False
        to_mark_disconnected = []
        items_to_check = []
        async with STATE_LOCK:
            for name, char_info in character_data.items():
                 items_to_check.append((
                     name,
                     char_info.get("timestamp", 0),
                     char_info.get("data", {}).get("CONNECTED", "NO")
                 ))
        for name, timestamp, connected_status in items_to_check:
             if connected_status == "YES" and now - timestamp > CONNECTION_TIMEOUT_SECONDS:
                 # app_logger.debug(f"Marking '{name}' as potentially disconnected (timeout)") # Can be verbose
                 to_mark_disconnected.append(name)
        if to_mark_disconnected:
            async with STATE_LOCK:
                for name in to_mark_disconnected:
                    if name in character_data and character_data[name].get("data", {}).get("CONNECTED") == "YES":
                        app_logger.info(f"Confirmed marking '{name}' as disconnected in state.")
                        character_data[name]["data"]["CONNECTED"] = "NO"
                        pending_updates[name] = character_data[name]["data"].copy()
                        if name in pending_deletions: pending_deletions.discard(name)
                        needs_broadcast = True
        async with STATE_LOCK:
             if pending_updates or pending_deletions:
                 needs_broadcast = True
        if needs_broadcast:
            await send_delta_update_aiohttp()

# --- Graceful Shutdown Logic (REVISED) ---
async def shutdown(prune_task, broadcast_task, http_runner):
    app_logger.info("Initiating graceful shutdown...")
    if http_runner:
        await http_runner.cleanup()
        app_logger.info("HTTP/WebSocket server (aiohttp) stopped accepting new connections and cleaned up.")
    active_ws_clients = []
    async with STATE_LOCK:
        active_ws_clients = list(subscribers)
    if active_ws_clients:
        app_logger.info(f"Closing {len(active_ws_clients)} active WebSocket connections...")
        close_tasks = [
            client.close(code=aiohttp.WSCloseCode.GOING_AWAY, message=b'Server shutting down')
            for client in active_ws_clients if not client.closed
        ]
        if close_tasks:
            await asyncio.gather(*close_tasks, return_exceptions=True)
        app_logger.info("Active WebSocket connections closed.")
    tasks_to_cancel = []
    if prune_task: tasks_to_cancel.append(prune_task)
    if broadcast_task: tasks_to_cancel.append(broadcast_task)
    all_tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    app_tasks = [t for t in all_tasks if t not in tasks_to_cancel and not t.done()]
    tasks_to_cancel.extend(app_tasks)
    if tasks_to_cancel:
        app_logger.info(f"Cancelling {len(tasks_to_cancel)} background tasks...")
        for task in tasks_to_cancel: task.cancel()
        results = await asyncio.gather(*tasks_to_cancel, return_exceptions=True)
        for i, res in enumerate(results):
            try:
                task_name_short = tasks_to_cancel[i].get_name() if hasattr(tasks_to_cancel[i], 'get_name') else str(tasks_to_cancel[i])[:80]
            except Exception: # Handle cases where task might already be invalid
                task_name_short = f"Task_{i}"

            if isinstance(res, asyncio.CancelledError):
                app_logger.info(f"Task {task_name_short}... cancelled.")
            elif isinstance(res, Exception):
                app_logger.error(f"Error during task {task_name_short}... shutdown: {res}", exc_info=False)
    app_logger.info("Shutdown complete.")

# --- Main Application Setup and Run (REVISED) ---
if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    prune_task_main = None
    broadcast_task_main = None
    http_runner_main = None

    try:
        static_html_file = STATIC_DIR / "subscriber_client.html"
        if not STATIC_DIR.is_dir():
            try:
                STATIC_DIR.mkdir(parents=True, exist_ok=True)
                app_logger.info(f"Created missing static directory: {STATIC_DIR}")
            except OSError as e:
                 app_logger.error(f"Static directory not found or creatable: {STATIC_DIR}. Error: {e}. Exiting.")
                 exit(1)
        if not static_html_file.is_file():
            app_logger.warning(f"Static file not found: {static_html_file}. Web client at '/' unavailable.")

        prune_task_main = loop.create_task(prune_old_data())
        broadcast_task_main = loop.create_task(broadcast_loop())

        app = web.Application(logger=http_logger)
        app.router.add_post('/update', handle_http_update)
        app.router.add_get('/', handle_root)
        app.router.add_get('/ws', websocket_handler)

        http_runner_main = web.AppRunner(app)
        loop.run_until_complete(http_runner_main.setup())
        site = web.TCPSite(http_runner_main, SERVER_HOST, SERVER_PORT)
        loop.run_until_complete(site.start())

        app_logger.info(f"Started HTTP & WebSocket server on http://{SERVER_HOST}:{SERVER_PORT}")
        app_logger.info(f"WebSocket clients connect to ws://{SERVER_HOST}:{SERVER_PORT}/ws")
        app_logger.info("Server running. Press Ctrl+C to stop.")
        loop.run_forever()

    except KeyboardInterrupt:
        app_logger.info("KeyboardInterrupt received.")
    except Exception as e:
        app_logger.error(f"An error occurred during startup/runtime: {e}", exc_info=True)
    finally:
        if loop.is_running():
             app_logger.info("Stopping event loop and shutting down...")
             loop.run_until_complete(shutdown(prune_task_main, broadcast_task_main, http_runner_main))
             loop.close()
             app_logger.info("Event loop closed.")
        elif not loop.is_closed():
             loop.close()
             app_logger.info("Event loop closed following early exit.")
        else:
             app_logger.info("Event loop already closed.")