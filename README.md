# MSDP Data Relay & Web Viewer

This project provides a system to relay data from MUD (Multi-User Dungeon) clients like ZMud and Tintin++ to a backend server, which then broadcasts this data to a real-time web-based character viewer.

![Web Client Screenshot](images/servershot.JPG)

## Overview

Players often use MUD clients with scripting capabilities to enhance their gameplay. This system allows these clients to send character status, combat information, and other relevant game data to a central server. The server processes this data and makes it available via a WebSocket connection to a web interface, allowing users (or perhaps party members, GMs, etc.) to view character information in a rich, graphical format in their web browser.

The core data transmission format from the MUD client to the server is a simple string of concatenated key-value pairs: `{key}{value}{key}{value}...`.

Two backend server implementations are provided:
1.  **Python Server**: Built with `aiohttp` for asynchronous handling. Recommended for personal or light use.
2.  **Rust Server**: Built with `axum` for performance and type safety. Recommended when performance matters (many users).

You only need to run **one** of these server implementations. Both servers are configurable via environment variables.

## Features

*   **Data Collection**: Scripts provided for ZMud and Tintin++ to send data.
*   **Flexible Data Format**: Simple `{key}{value}` string format for easy integration.
*   **Dual Server Implementations**:
    *   Python server for ease of development and common Python ecosystems.
    *   Rust server for high performance and robustness.
*   **Configurable Servers**: Key server parameters (host, port, timeouts, logging) can be set using environment variables or a `.env` file.
*   **Real-time Web Viewer**:
    *   Displays character cards with stats (HP, Mana/Blood), class, lag, opponent info, affects, and more.
    *   Supports multiple character cards (configurable up to 16 by default).
    *   Dynamic updates via WebSockets.
    *   Collapsible character list panel.
    *   Expandable cards to show full raw data.
    *   Light and Dark theme support.
    *   Responsive design for desktop and mobile.
    *   Connection status indicators.
*   **Data Management**: Servers handle data pruning for inactive characters and connection timeouts.

## Architecture
```
+--------------+ HTTP POST ({key}{value}...)+-----------------+  WebSocket (JSON)    +----------------+
| MUD Client   | -------------------------> | Backend Server  | ----------------->   | Web Viewer     |
| (ZMud/Tintin)|                            | (Python or Rust)|                      | (Browser)      |
+--------------+                            +-----------------+                      +----------------+
```

1.  **MUD Client**: The player's MUD client (ZMud or Tintin++) runs a script
    that collects game data.
2.  **Data Transmission**: The script periodically sends this data as a
    `{key}{value}` string via an HTTP POST request to the chosen backend
    server's `/update` endpoint.
3.  **Backend Server**:
    *   Receives the data string on its `/update` endpoint.
    *   Parses the string into a structured format (key-value map).
    *   Stores the character data and timestamps it.
    *   Manages data for multiple characters.
    *   Handles pruning of old data and client connection status based on
        configurable timeouts.
    *   Broadcasts updates (full state on new connection, deltas thereafter)
        as JSON over a WebSocket connection from its `/ws` endpoint.
    *   Serves the web viewer HTML page from its root (`/`) endpoint.
4.  **Web Viewer**:
    *   A static HTML page (`subscriber_client.html`) with JavaScript.
    *   Connects to the server's WebSocket endpoint.
    *   Receives JSON data and dynamically renders character cards.

    ## Server Configuration (Environment Variables)

Both Python and Rust servers can be configured using environment variables. You
can set these variables directly in your shell or by creating a `.env` file in
the respective server's root directory (`python_server/.env` or
`rust_server/.env`). The servers will automatically load variables from this
file if it exists.

**Example `.env` file:**
```dotenv
# Common for both servers (use appropriate variable name)
# For Python: SERVER_HOST=0.0.0.0
# For Rust:   HTTP_HOST=0.0.0.0
HTTP_PORT=8081
LOG_LEVEL=DEBUG

# Server-specific or common behavior control
PRUNE_INTERVAL_SECONDS=120
DATA_TIMEOUT_MINUTES=60
BROADCAST_INTERVAL_SECONDS=0.1
CONNECTION_TIMEOUT_SECONDS=10

# Rust specific
STATIC_DIR_PATH=./custom_static_path

## Components

### 1. MUD Clients

You'll need to install the appropriate script in your MUD client.

**Important:** The client scripts default to sending data to
`http://localhost:8080/update`. If you configure your server to use a
different host or port, you **must** update the URL in the client script.

#### a. ZMud Client

*   **File**: `zmud_client.txt`
*   **Setup**:
    1.  Open ZMud.
    2.  Copy the **entire content** of `zmud_client.txt`.
    3.  Paste it directly into the ZMud command input line and press Enter. This
        will import all the necessary aliases, variables, and triggers into a
        ZMud class named "server".
    4.  Ensure the "server" class is enabled.
    5.  **Modify URL if needed:** The script sends data to
        `http://localhost:8080/update`. If your server runs elsewhere, edit the
        URL in the `#ALIAS sendData` line.
*   **Functionality**:
    *   Defines an alias `buildData` to construct the `{key}{value}` payload.
    *   Automatically sends data on prompt updates if data has changed.
    *   Includes a spell/affect duration tracking system.

#### b. Tintin++ Client

*   **File**: `tintin_client.txt`
*   **Setup**:
    1.  Copy the content of `tintin_client.txt`.
    2.  Add this script to your existing Tintin++ script file or create a new one.
    3.  **Modify URL if needed:** The script sends data to
        `http://localhost:8080/update` using `curl`. If your server runs
        elsewhere, edit this URL.
    4.  Ensure `curl` is installed and accessible in your system's PATH.
*   **Functionality**:
    *   Uses a `#ticker` to periodically send the content of the `$msdp_info`
        variable.
    *   Ensure your Tintin++ setup populates `$msdp_info`.
    *   Default update interval is `0.5` seconds (configurable via
        `#VAR update_interval`).

#### a. MUSH Client
    * Not yet implemented. Similar to TinTin++

### 2. Backend Servers (Choose ONE)

#### a. Python Server

*   **Location**: `python_server/`
*   **Main File**: `server.py`
*   **Requirements**:
    *   Python 3.7+
    *   `aiohttp`
    *   `orjson`
    *   `python-dotenv` (for `.env` file support)
    *   Install dependencies:
        ```bash
        cd python_server
        pip install -r requirements.txt
        ```
*   **Running**:
    Navigate to the `python_server` directory.
    ```bash
    python server.py
    ```
    The server will start, respecting environment variables (e.g., from
    `python_server/.env` or set in the shell). By default (if `SERVER_HOST` is
    `localhost`), it listens on `http://localhost:SERVER_PORT`.

#### b. Rust Server

*   **Location**: `rust_server/`
*   **Main File**: `src/main.rs`
*   **Requirements**:
    *   Rust toolchain (latest stable recommended). Install from
        [rustup.rs](https://rustup.rs/).
*   **Building & Running**:
    Navigate to the `rust_server` directory.
    1.  **Build**:
        ```bash
        cargo build --release
        ```
    2.  **Run**:
        ```bash
        cargo run --release
        ```
        Alternatively, after building, run the executable directly from the
        `rust_server` directory:
        ```bash
        ./target/release/rust_data_server # (or rust_msdp_server if that's the package name)
        ```
    The server will start, respecting environment variables (e.g., from
    `rust_server/.env` or set in the shell). By default (if `HTTP_HOST` is
    `0.0.0.0`), it listens on `http://0.0.0.0:HTTP_PORT` (accessible via
    `http://localhost:HTTP_PORT` or your machine's local IP address).

### 3. Web Viewer

*   **File Location**:
    *   For Python server: `python_server/static/subscriber_client.html`
    *   For Rust server: Expected in `static/subscriber_client.html` relative
        to where the Rust server is run (or the path specified by
        `STATIC_DIR_PATH`). By default, this is
        `rust_server/static/subscriber_client.html` if run from the
        `rust_server` directory.
*   **Access**:
    Once a backend server is running, open your web browser and go to
    `http://<configured_server_host>:<configured_server_port>/`.
    For example, if using defaults: `http://localhost:8080/`.
*   **Configuration**:
    *   The web viewer connects to `ws://<SERVER_HOST>:<SERVER_PORT>/ws`.
    *   If you change the server's host or port from the defaults
        (`localhost:8080`), you **must** update the `SERVER_HOST` and
        `SERVER_PORT` JavaScript constants at the top of the `<script>`
        section in `subscriber_client.html`.
*   **Features**:
    *   Dynamic character cards, theme toggle, collapsible list, expandable
        cards, status indicators, responsive layout.

## Data Flow & Format

### MUD Client to Server (HTTP POST)

MUD clients send data as plain text to `/update`. Format:
`{key1}{value1}{key2}{value2}...`
**Example:** `{CHARACTER_NAME}{MyChar}{HEALTH}{100}{HEALTH_MAX}{120}`
`CHARACTER_NAME` is crucial.

### Server to Web Viewer (WebSocket)

Server sends JSON to `/ws`.

1.  **Initial Snapshot**:
    ```json
    {
      "MyChar1": { "HEALTH": 100, "CLASS": "Warrior", ... },
      "MyChar2": { "HEALTH": 80, "CLASS": "Mage", ... }
    }
    ```

2.  **Delta Updates**:
    ```json
    {
      "updates": {
        "MyChar1": { "HEALTH": 95, ... }
      },
      "deletions": ["MyChar3"]
    }
    ```

    ## General Configuration Notes

*   **Server Address Consistency**: Ensure the MUD client scripts, the web
    viewer's JavaScript constants, and the server's actual listening address
    (configured via environment variables) all match.
*   **Firewall**: If accessing the server from other machines on your network
    (when host is `0.0.0.0`), ensure your firewall allows connections to the
    configured port.

