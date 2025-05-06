# -*- coding: utf-8 -*-
# --- Imports and Setup (Keep as is) ---
import asyncio
import websockets
import aiohttp
from aiohttp import web
import json
import orjson # Using orjson for faster JSON operations
import time
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

# --- Configuration (Keep as is) ---
WS_HOST = "localhost"
WS_PORT = 8765
HTTP_HOST = "localhost"
HTTP_PORT = 8080
PRUNE_INTERVAL_SECONDS = 60
DATA_TIMEOUT_MINUTES = 30
BROADCAST_INTERVAL_SECONDS = 0.2
CONNECTION_TIMEOUT_SECONDS = 3.0
LOG_LEVEL = logging.DEBUG

# --- Paths and Globals (Keep as is) ---
SCRIPT_DIR = Path(__file__).parent
STATIC_DIR = SCRIPT_DIR / "static"
character_data = {}
subscribers = set()
STATE_LOCK = asyncio.Lock()
pending_updates = {}
pending_deletions = set()

# --- Logging Setup (Keep as is) ---
logging.basicConfig(level=LOG_LEVEL, format='%(asctime)s %(levelname)-8s %(name)-10s: %(message)s')
app_logger = logging.getLogger("App")
parser_logger = logging.getLogger("Parser")
http_logger = logging.getLogger("HTTP")
parser_logger.setLevel(LOG_LEVEL)
app_logger.setLevel(LOG_LEVEL)
http_logger.setLevel(LOG_LEVEL)


# --- Parser Logic (REVISED) ---

def parse_final_value(raw_value_block):
    """Takes the identified value block (like '{value_content}'), prepares it for storage."""
    val = raw_value_block.strip()
    processed_val_str = val # Default

    if not val:
        return ""

    # If the block passed is like "{inner content}", strip outer braces
    if len(val) >= 2 and val.startswith('{') and val.endswith('}'):
        inner_val = val[1:-1].strip()
        processed_val_str = inner_val
        # parser_logger.debug(f"parse_final_value: Stripped outer braces. Inner: '{inner_val[:50]}...'")
    elif val.startswith('{'):
         parser_logger.warning(f"parse_final_value: Received block starting '{{' but not ending '}}': '{val[:50]}...'. Parsing inner content as fallback.")
         processed_val_str = val[1:].strip()
    # else: Value might not be braced if it's simple? Let's stick to the braced assumption for now.

    # Attempt numeric conversion after cleaning commas
    cleaned_num_str = processed_val_str.replace(',', '')
    try:
        # Try int first
        return int(cleaned_num_str)
    except ValueError:
        try:
            # Then try float
            return float(cleaned_num_str)
        except ValueError:
            # If not numeric, return the processed string value
            return processed_val_str


def parse_strict_key_value_pairs(text):
    """
    Parses a string assuming a strict format: {KEY1}{VALUE1}{KEY2}{VALUE2}...
    NO outer enclosing braces are expected.
    Values are ALWAYS enclosed in braces and may contain nested braces.
    Keys are ALWAYS enclosed in braces. Keys and Values appear strictly alternating.
    Uses a single forward pass. Returns a dictionary of parsed data.
    """
    global parser_logger
    if 'parser_logger' not in globals():
        parser_logger = logging.getLogger("Parser_Standalone")
        parser_logger.warning("Using standalone parser logger.")

    parser_logger.debug(f"Starting STRICT parse (NO outer braces expected). Input len={len(text)}. Snippet='{text[:80]}...'")
    text = text.strip() # Remove leading/trailing whitespace, but NOT outer braces
    if not text:
        parser_logger.error("STRICT PARSE: Input string is empty after stripping.")
        return {} # Return empty dict for empty input

    data = {}
    n = len(text)
    # Start i at the beginning of the string (index 0)
    i = 0
    parse_error_occurred = False

    while i < n: # Loop as long as we haven't consumed the whole string
        # --- Skip Whitespace before Key's opening '{' ---
        # (Shouldn't happen with strict format, but good practice)
        while i < n and text[i].isspace():
            i += 1
        if i >= n: break # Reached end after whitespace

        # --- 1. Expect and Parse Key ---
        # We MUST be pointing at the key's opening brace '{'
        if text[i] != '{':
            parser_logger.error(f"STRICT PARSE: Expected '{{' for key start at index {i}, found '{text[i]}'. Malformed input. Near: '...{text[max(0,i-10):min(n,i+10)]}...'")
            parse_error_occurred = True
            break

        key_brace_start = i
        key_brace_end = text.find('}', key_brace_start + 1) # Find the key's closing brace

        if key_brace_end == -1:
            parser_logger.error(f"STRICT PARSE: Missing '}}' for key starting at brace {key_brace_start}. Remainder: '{text[i:]}'")
            parse_error_occurred = True
            break

        # Key content is between the braces
        key = text[key_brace_start + 1 : key_brace_end].strip()
        parser_logger.debug(f"STRICT PARSE: Found key: '{key}' (braces {key_brace_start}-{key_brace_end})")

        if not key:
            parser_logger.error(f"STRICT PARSE: Empty key found ending at {key_brace_end}. Malformed input.")
            # Attempt to skip the following value block (essential for recovery)
            i = key_brace_end + 1 # Move past empty key's '}'
            while i < n and text[i].isspace(): i += 1 # Skip space
            if i >= n: # Reached end after empty key
                 parser_logger.warning("STRICT PARSE: Reached end after empty key brace.")
                 parse_error_occurred = True # Treat as error if no value follows
                 break
            if text[i] == '{':
                value_block_start = i
                level = 1
                j = i + 1
                skipped_value = False
                while j < n: # Scan to end of string
                    char = text[j]
                    if char == '{': level += 1
                    elif char == '}': level -= 1
                    if level == 0:
                        i = j + 1 # Move past skipped value block
                        parser_logger.warning(f"STRICT PARSE: Skipped potential value block after empty key ({value_block_start} to {j}).")
                        skipped_value = True
                        break
                    j += 1
                if not skipped_value:
                    parser_logger.warning(f"STRICT PARSE: Could not reliably skip value (unmatched braces?) after empty key near {key_brace_end}. Stopping parse.")
                    parse_error_occurred = True
                    break
            else: # Found something other than '{' after empty key brace
                 parser_logger.error(f"STRICT PARSE: Expected '{{' for value after empty key brace near {key_brace_end}, found '{text[i]}'. Stopping parse.")
                 parse_error_occurred = True
                 break
            continue # Try parsing the next key after successful skip

        # --- Advance index past the key's closing brace '}' ---
        i = key_brace_end + 1

        # --- 2. Skip Whitespace before Value's opening '{' ---
        while i < n and text[i].isspace():
            i += 1
        if i >= n: # Check if we hit the end after key and whitespace
             parser_logger.error(f"STRICT PARSE: Reached end of string after key '{key}' before finding value's opening '{{'. Input likely truncated.")
             parse_error_occurred = True
             break

        # --- 3. Expect and Parse Value ---
        # We MUST be pointing at the value's opening brace '{'
        if text[i] != '{':
            parser_logger.error(f"STRICT PARSE: Expected '{{' for value of key '{key}' at index {i}, but found '{text[i]}'. Malformed input. Near: '...{text[max(0,i-10):min(n,i+10)]}...'")
            parse_error_occurred = True
            break

        value_block_start = i # Index of the value's opening '{'
        parser_logger.debug(f"STRICT PARSE: Value for '{key}' starts with '{{' at {value_block_start}. Scanning for matching brace.")

        level = 1
        j = value_block_start + 1
        found_match = False
        while j < n: # Scan up to the end of the string
            char = text[j]
            if char == '{':
                level += 1
            elif char == '}':
                level -= 1
                if level == 0:
                    value_block_end = j # Index of the value's closing '}'
                    raw_value_block = text[value_block_start : value_block_end + 1]
                    parser_logger.debug(f"STRICT PARSE: Found matching '}}' for value at {value_block_end}. Block: '{raw_value_block[:50]}...'.")

                    final_value = parse_final_value(raw_value_block)
                    data[key] = final_value
                    parser_logger.debug(f"STRICT PARSE: Stored Key='{key}', Value='{str(final_value)[:50]}...' (Type: {type(final_value)})")

                    # --- Advance index past the value's closing brace '}' ---
                    i = value_block_end + 1
                    found_match = True
                    break # Found matching brace for this value, break inner loop
            j += 1

        if not found_match:
            # If the inner loop finished without finding the match (level != 0)
            parser_logger.error(f"STRICT PARSE: Matching '}}' not found for value block of key '{key}' starting at {value_block_start}. Input likely corrupt or truncated.")
            parse_error_occurred = True
            if key in data: # Remove the key if value parsing failed
                del data[key]
                parser_logger.debug(f"STRICT PARSE: Removed key '{key}' from result due to subsequent value parsing failure.")
            break # Stop parsing outer loop

    # --- Final Logging ---
    if parse_error_occurred:
         parser_logger.warning(f"STRICT PARSE: Finished parsing prematurely due to error. Found {len(data)} valid key-value pairs before error.")
    elif i >= n: # Should reach here if parsing completed successfully
         parser_logger.info(f"STRICT PARSE: Finished successfully. Found {len(data)} key-value pairs.")
    else: # This case indicates an unexpected exit from the while loop
         parser_logger.warning(f"STRICT PARSE: Loop exited unexpectedly at index {i} before end ({n}) without error flag. State: {len(data)} pairs found. Remainder: '{text[i:min(i+50, n)]}...'")

    return data


# --- Shared Data Processing Logic (Keep as is) ---
async def process_data_string(message_string):
    """
    Parses input using the strict parser, updates main state and pending delta state.
    Adds 'CONNECTED' field.
    """
    log_msg_snippet = message_string[:200] + ('...' if len(message_string) > 200 else '')

    loop = asyncio.get_running_loop()
    try:
        # Using None runs in default thread pool executor
        parsed_data = await loop.run_in_executor(None, parse_strict_key_value_pairs, message_string)
    except ValueError as parse_exc:
        app_logger.error(f"Parser failed (ValueError): {parse_exc}. Msg: '{log_msg_snippet}'")
        raise ValueError(f"Parsing failed: {parse_exc}") from parse_exc
    except Exception as parse_exc:
        app_logger.error(f"Parser failed unexpectedly in executor: {parse_exc}. Msg: '{log_msg_snippet}'", exc_info=True)
        raise ValueError(f"Parsing failed unexpectedly in executor: {parse_exc}") from parse_exc

    if not parsed_data:
        # Check if the original string was actually non-empty before raising error
        if message_string.strip():
            app_logger.warning(f"Parser returned empty data despite non-empty input. Msg: '{log_msg_snippet}'")
            raise ValueError("Parsing resulted in empty data from non-empty input")
        else:
             app_logger.info(f"Parser correctly returned empty data for empty input.")
             # Decide if empty input is an error or should be ignored silently
             # For now, let's treat it as a bad request if sent via HTTP
             raise ValueError("Parsing resulted in empty data (input was empty/whitespace)")


    # Ensure CHARACTER_NAME exists
    char_name = parsed_data.get("CHARACTER_NAME")
    if not char_name:
        # Provide more context in the error log
        keys_found = list(parsed_data.keys())
        num_keys = len(keys_found)
        app_logger.warning(f"Parsed data missing 'CHARACTER_NAME' key. Found {num_keys} keys: {keys_found[:20]}{'...' if num_keys > 20 else ''}. Ignoring.")
        raise ValueError("Parsed data missing CHARACTER_NAME")
    if not isinstance(char_name, str):
        char_name = str(char_name) # Ensure it's a string

    parsed_data["CONNECTED"] = "YES"
    now = time.time()

    async with STATE_LOCK:
        action = "Updated" if char_name in character_data else "Added new"
        character_data[char_name] = {"data": parsed_data, "timestamp": now}
        pending_updates[char_name] = parsed_data
        if char_name in pending_deletions:
            pending_deletions.discard(char_name)
            app_logger.debug(f"'{char_name}' was pending deletion, removed from deletion list.")
        app_logger.info(f"{action} character data for: {char_name}. Added to pending updates.")

# --- HTTP Server Logic (Keep as is, error handling in process_data_string is key) ---
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

        # Removed check for empty raw_data here, process_data_string handles it
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


# --- WebSocket Server Logic (Keep as is) ---
async def send_full_update(websocket=None):
    log_prefix = f"SEND_FULL_SNAPSHOT [INITIAL]:"
    target_addr = websocket.remote_address if websocket else "InvalidCall"
    if not websocket:
         app_logger.error(f"{log_prefix} Invalid call: Called without specific websocket target.")
         return
    app_logger.debug(f"{log_prefix} Called for target: {target_addr}")
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
    else:
         app_logger.debug(f"{log_prefix} State is empty, sending empty JSON object {{}}.")
    message_str = '{}'
    try:
        message_str = message_bytes.decode('utf-8')
    except UnicodeDecodeError as e:
         app_logger.error(f"{log_prefix} Failed to decode orjson bytes to UTF-8: {e}", exc_info=True)
         return
    app_logger.info(f"{log_prefix} Attempting send snapshot string (len={len(message_str)}) to target: {websocket.remote_address}")
    try:
        await websocket.send(message_str)
        app_logger.info(f"{log_prefix} --> Successfully sent initial state snapshot string to {websocket.remote_address}")
    except websockets.ConnectionClosed:
        app_logger.warning(f"{log_prefix} Connection {websocket.remote_address} closed before initial state string could be sent.")
    except Exception as e:
        app_logger.error(f"{log_prefix} Error sending initial state string to {websocket.remote_address}: {e}", exc_info=True)

async def send_delta_update():
    log_prefix = "SEND_DELTA_UPDATE [BROADCAST]:"
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
    app_logger.info(f"{log_prefix} Prepared delta message. Updates: {len(updates_to_send)}, Deletions: {len(deletions_to_send)}")
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
    subs_to_send_to = set()
    async with STATE_LOCK:
        subs_to_send_to = subscribers.copy()
    if subs_to_send_to:
         app_logger.info(f"{log_prefix} Broadcasting delta update string (len={len(message_str)}) to {len(subs_to_send_to)} subscribers.")
         tasks = [sub.send(message_str) for sub in subs_to_send_to]
         results = await asyncio.gather(*tasks, return_exceptions=True)
         failed_subs = set()
         success_count = 0
         sub_list_for_results = list(subs_to_send_to)
         for i, result in enumerate(results):
              if i < len(sub_list_for_results):
                  current_sub = sub_list_for_results[i]
                  if isinstance(result, Exception):
                       failed_subs.add(current_sub)
                       app_logger.warning(f"{log_prefix} WS delta send failed to {current_sub.remote_address}: {result}. Marking for removal.")
                  else: success_count += 1
              else: app_logger.error(f"{log_prefix} Result index {i} out of bounds for subscriber list.")
         app_logger.debug(f"{log_prefix} --> Delta broadcast results: {success_count} success, {len(failed_subs)} failures.")
         if failed_subs:
             app_logger.info(f"{log_prefix} Removing {len(failed_subs)} disconnected WS subscribers after delta broadcast.")
             async with STATE_LOCK:
                 initial_count = len(subscribers)
                 subscribers.difference_update(failed_subs)
                 removed_count = initial_count - len(subscribers)
                 app_logger.info(f"{log_prefix} Removed {removed_count}. Subscribers remaining: {len(subscribers)}")
    else:
         app_logger.debug(f"{log_prefix} No subscribers connected for delta broadcast.")

async def register(websocket):
    addr = websocket.remote_address
    app_logger.info(f"REGISTER: WS Subscriber connecting: {addr}")
    async with STATE_LOCK:
        subscribers.add(websocket)
        app_logger.info(f"REGISTER: Added {addr} to subscribers. Total: {len(subscribers)}")
    app_logger.info(f"REGISTER: Attempting initial state snapshot send to {addr}...")
    try:
        await send_full_update(websocket)
        app_logger.info(f"REGISTER: Initial state snapshot send attempt completed for {addr}.")
    except Exception as e:
        app_logger.error(f"REGISTER: Exception during initial send_full_update for {addr}: {e}", exc_info=True)

async def unregister(websocket):
    removed = False
    addr = websocket.remote_address
    # app_logger.debug(f"UNREGISTER: Attempting to remove {addr}")
    async with STATE_LOCK:
        if websocket in subscribers:
            subscribers.discard(websocket)
            removed = True
    if removed:
        app_logger.info(f"UNREGISTER: WS Subscriber disconnected/unregistered: {addr}. Total: {len(subscribers)}")
    # else: app_logger.debug(f"UNREGISTER: Attempted to unregister {addr}, but it was not found.")

async def ws_connection_handler(websocket, path):
    await register(websocket)
    try:
        await websocket.wait_closed()
    finally:
        await unregister(websocket)

async def prune_old_data():
    while True:
        await asyncio.sleep(PRUNE_INTERVAL_SECONDS)
        now = time.time()
        timeout_seconds = DATA_TIMEOUT_MINUTES * 60
        names_to_prune = []

        # --- Lock 1: Identify ---
        async with STATE_LOCK:
            for name, info in character_data.items():
                if now - info.get("timestamp", 0) > timeout_seconds:
                    names_to_prune.append(name)

        # --- Lock 2: Delete (if any found) ---
        if names_to_prune:
            async with STATE_LOCK:
                pruned_count = 0
                actual_pruned_names = [] # Log names actually pruned in this run
                for name in names_to_prune:
                    # Re-check if it still exists before deleting
                    if name in character_data:
                        # Optional: Check timestamp again to avoid race condition if updated recently?
                        # Might be overkill, depends on desired strictness.
                        if now - character_data[name].get("timestamp", 0) > timeout_seconds:
                            del character_data[name]
                            pending_deletions.add(name)
                            if name in pending_updates:
                                del pending_updates[name]
                            pruned_count += 1
                            actual_pruned_names.append(name)

            if pruned_count > 0:
                app_logger.info(f"Pruned {pruned_count} inactive characters: {', '.join(actual_pruned_names)}. Marked for deletion.")

async def broadcast_loop():
    app_logger.info(f"Starting broadcast loop. Interval: {BROADCAST_INTERVAL_SECONDS}s, Connection Timeout: {CONNECTION_TIMEOUT_SECONDS}s")
    while True:
        await asyncio.sleep(BROADCAST_INTERVAL_SECONDS)
        now = time.time()
        needs_broadcast = False
        to_mark_disconnected = []

        # --- Minimize first lock acquisition ---
        async with STATE_LOCK:
            # Quickly grab data needed for timeout check
            items_to_check = []
            for name, char_info in character_data.items():
                 # Only need timestamp and connection status if present
                 timestamp = char_info.get("timestamp", 0)
                 connected_status = char_info.get("data", {}).get("CONNECTED", "NO")
                 items_to_check.append((name, timestamp, connected_status))

        # --- Process timestamps *outside* the main lock ---
        for name, timestamp, connected_status in items_to_check:
             if connected_status == "YES" and now - timestamp > CONNECTION_TIMEOUT_SECONDS:
                 app_logger.debug(f"Marking '{name}' as potentially disconnected (timeout)")
                 to_mark_disconnected.append(name)

        # --- Re-acquire lock only if modifications are needed ---
        if to_mark_disconnected:
            async with STATE_LOCK:
                for name in to_mark_disconnected:
                    # Re-check if still exists and connected before modifying
                    if name in character_data and character_data[name].get("data", {}).get("CONNECTED") == "YES":
                        app_logger.info(f"Confirmed marking '{name}' as disconnected in state.") # Log confirmation
                        character_data[name]["data"]["CONNECTED"] = "NO"
                        # Ensure it gets broadcasted
                        pending_updates[name] = character_data[name]["data"].copy() # Copy data for update
                        if name in pending_deletions:
                             pending_deletions.discard(name) # Ensure it's not deleted if we just updated status
                        needs_broadcast = True # Mark for broadcast

            # Check if other pending changes exist outside the disconnect logic
            async with STATE_LOCK:
                 if pending_updates or pending_deletions:
                     needs_broadcast = True

        if needs_broadcast:
            await send_delta_update()

# --- Graceful Shutdown Logic (Keep as is) ---
async def shutdown(prune_task, broadcast_task, http_runner, ws_server):
    app_logger.info("Initiating graceful shutdown...")
    if ws_server:
        ws_server.close()
        await ws_server.wait_closed()
        app_logger.info("WebSocket server stopped.")
    if http_runner:
        await http_runner.cleanup()
        app_logger.info("HTTP server stopped.")
    tasks_to_cancel = []
    if prune_task: tasks_to_cancel.append(prune_task)
    if broadcast_task: tasks_to_cancel.append(broadcast_task)
    if tasks_to_cancel:
        app_logger.info("Cancelling background tasks...")
        for task in tasks_to_cancel: task.cancel()
        results = await asyncio.gather(*tasks_to_cancel, return_exceptions=True)
        task_names = ["Prune", "Broadcast"][:len(tasks_to_cancel)]
        for i, res in enumerate(results):
            task_name = task_names[i]
            if isinstance(res, asyncio.CancelledError): app_logger.info(f"{task_name} task cancelled.")
            elif isinstance(res, Exception): app_logger.error(f"Error during {task_name} task shutdown: {res}", exc_info=res)
            else: app_logger.info(f"{task_name} task finished during shutdown.")
    app_logger.info("Shutdown complete.")

# --- Main Application Setup and Run (Keep as is) ---
if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    prune_task = None
    broadcast_task = None
    http_runner_main = None
    ws_server_main = None
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

        prune_task = loop.create_task(prune_old_data())
        broadcast_task = loop.create_task(broadcast_loop())

        http_app_main = web.Application(logger=http_logger)
        http_app_main.router.add_post('/update', handle_http_update)
        http_app_main.router.add_get('/', handle_root)

        http_runner_main = web.AppRunner(http_app_main)
        loop.run_until_complete(http_runner_main.setup())
        http_site_main = web.TCPSite(http_runner_main, HTTP_HOST, HTTP_PORT)

        ws_server_main_future = websockets.serve(ws_connection_handler, WS_HOST, WS_PORT)
        ws_server_main = loop.run_until_complete(ws_server_main_future)

        loop.run_until_complete(http_site_main.start())
        app_logger.info(f"Started HTTP server on http://{HTTP_HOST}:{HTTP_PORT}")
        app_logger.info(f"Started WebSocket server on ws://{WS_HOST}:{WS_PORT}")
        app_logger.info("Servers running. Press Ctrl+C to stop.")
        loop.run_forever()

    except KeyboardInterrupt:
        app_logger.info("KeyboardInterrupt received.")
    except Exception as e:
        app_logger.error(f"An error occurred during startup/runtime: {e}", exc_info=True)
    finally:
        if loop.is_running():
             app_logger.info("Stopping event loop and shutting down...")
             loop.run_until_complete(shutdown(prune_task, broadcast_task, http_runner_main, ws_server_main))
             loop.close()
             app_logger.info("Event loop closed.")
        elif not loop.is_closed():
             loop.close()
             app_logger.info("Event loop closed following early exit.")
        else:
             app_logger.info("Event loop already closed.")