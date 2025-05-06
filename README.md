# MSDP Data Relay & Web Viewer

This project provides a system to relay data from MUD (Multi-User Dungeon) clients like ZMud and Tintin++ to a backend server, which then broadcasts this data to a real-time web-based character viewer.

## Overview

Players often use MUD clients with scripting capabilities to enhance their gameplay. This system allows these clients to send character status, combat information, and other relevant game data to a central server. The server processes this data and makes it available via a WebSocket connection to a web interface, allowing users (or perhaps party members, GMs, etc.) to view character information in a rich, graphical format in their web browser.

The core data transmission format from the MUD client to the server is a simple string of concatenated key-value pairs: `{key}{value}{key}{value}...`.

Two backend server implementations are provided:
1.  **Python Server**: Built with `aiohttp` for asynchronous handling.
2.  **Rust Server**: Built with `axum` for performance and type safety.

You only need to run **one** of these server implementations.

## Features

*   **Data Collection**: Scripts provided for ZMud and Tintin++ to send data.
*   **Flexible Data Format**: Simple `{key}{value}` string format for easy integration.
*   **Dual Server Implementations**:
    *   Python server for ease of development and common Python ecosystems.
    *   Rust server for high performance and robustness.
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
+--------------+ HTTP POST ({key}{value}...) +-----------------+ WebSocket (JSON) +----------------+
| MUD Client | ------------------------------------> | Backend Server | -------------------------> | Web Viewer |
| (ZMud/Tintin)| | (Python or Rust)| | (Browser) |
+--------------+ +-----------------+ +----------------+
1.  **MUD Client**: The player's MUD client (ZMud or Tintin++) runs a script that collects game data.
2.  **Data Transmission**: The script periodically sends this data as a `{key}{value}` string via an HTTP POST request to the chosen backend server.
3.  **Backend Server**:
    *   Receives the data string on its `/update` endpoint.
    *   Parses the string into a structured format (key-value map).
    *   Stores the character data and timestamps it.
    *   Manages data for multiple characters.
    *   Handles pruning of old data and client connection status.
    *   Broadcasts updates (full state on new connection, deltas thereafter) as JSON over a WebSocket connection from its `/ws` endpoint.
    *   Serves the web viewer HTML page from its root (`/`) endpoint.
4.  **Web Viewer**:
    *   A static HTML page (`subscriber_client.html`) with JavaScript.
    *   Connects to the server's WebSocket endpoint.
    *   Receives JSON data and dynamically renders character cards.

## Components

### 1. MUD Clients

You'll need to install the appropriate script in your MUD client.

#### a. ZMud Client

*   **File**: `zmud_client.txt`
*   **Setup**:
    1.  Open ZMud.
    2.  Copy the **entire content** of `zmud_client.txt`.
    3.  Paste it directly into the ZMud command input line and press Enter. This will import all the necessary aliases, variables, and triggers into a ZMud class named "server".
    4.  Ensure the "server" class is enabled.
*   **Functionality**:
    *   Defines an alias `buildData` to construct the `{key}{value}` payload using various ZMud variables (e.g., `@curHP`, `@maxHP`, `@lag`, `@style`, `@align`, spell affects).
    *   Automatically sends data on prompt updates if data has changed.
    *   Includes a sophisticated spell/affect duration tracking system that decrements timers and includes them in the payload under the `AFFECTS` key.
    *   Sends data to `http://localhost:8080/update`.

#### b. Tintin++ Client

*   **File**: `tintin_client.txt`
*   **Setup**:
    1.  Copy the content of `tintin_client.txt`.
    2.  Add this script to your existing Tintin++ script file (e.g., your main `.tin` file) or create a new one and load it.
*   **Functionality**:
    *   Uses a `#ticker` to periodically send the content of the `$msdp_info` variable.
    *   You need to ensure your Tintin++ setup populates the `$msdp_info` variable with the desired `{key}{value}` data. This often involves configuring MSDP or other triggers in Tintin++.
    *   The default update interval is `0.5` seconds, configurable via the `#VAR update_interval` line.
    *   Sends data to `http://localhost:8080/update` using `curl`. Ensure `curl` is installed and accessible in your system's PATH.

#### c. MUSHClient
*   **Not Implemented Yet**: But it should be very similar to TinTin++


### 2. Backend Servers (Choose ONE)

Both servers listen on `localhost:8080` by default (Python) or `0.0.0.0:8080` (Rust, making it accessible on your local network).

#### a. Python Server

*   **Location**: `python_server/`
*   **Main File**: `server.py`
*   **Requirements**:
    *   Python 3.7+
    *   `aiohttp`
    *   `orjson`
    *   Install dependencies:
        ```bash
        pip install aiohttp orjson
        ```
*   **Running**:
    Navigate to the `python_server` directory and run:
    ```bash
    python server.py
    ```
    The server will start on `http://localhost:8080`.

#### b. Rust Server

*   **Location**: `rust_server/`
*   **Main File**: `src/main.rs`
*   **Requirements**:
    *   Rust toolchain (latest stable recommended). Install from [rustup.rs](https://rustup.rs/).
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
        Alternatively, after building, run the executable directly:
        ```bash
        ./target/release/rust_data_server
        ```
    The server will start on `http://0.0.0.0:8080` (accessible via `http://localhost:8080` or your machine's local IP address).

### 3. Web Viewer

*   **File**: `python_server/static/subscriber_client.html` (The Rust server also expects this file in a `static` subdirectory relative to its execution path, or it will look for `rust_server/static/subscriber_client.html` if run from the `rust_server` directory).
*   **Access**: Once a backend server is running, open your web browser and go to:
    `http://localhost:8080/`
*   **Features**:
    *   Connects to `ws://localhost:8080/ws`.
    *   Displays character data in dynamically updating cards.
    *   Theme toggle (light/dark).
    *   Character list panel that can be collapsed.
    *   Individual cards can be expanded to show all raw data received for that character.
    *   Indicators for connection status, blindness, lack of sanctuary, etc.
    *   Responsive layout.

## Data Flow & Format

### MUD Client to Server (HTTP POST)

MUD clients send data as a plain text string in the body of an HTTP POST request to the `/update` endpoint. The format is a series of key-value pairs, each enclosed in curly braces:

`{key1}{value1}{key2}{value2}{key3}{value3}...`

**Example:**
`{CHARACTER_NAME}{MyChar}{HEALTH}{100}{HEALTH_MAX}{120}{MANA}{50}{MANA_MAX}{75}`

*   Keys and values are strings.
*   Values can be strings, numbers. The server attempts to parse numbers.
*   The `CHARACTER_NAME` key is crucial for the server to identify and track data for different characters.

### Server to Web Viewer (WebSocket)

The server sends JSON data to connected web viewers via WebSockets (`/ws` endpoint).

1.  **Initial Snapshot**: Upon connection, the web viewer receives a JSON object where keys are character names and values are objects containing their full data:
    ```json
    {
      "MyChar1": { "HEALTH": 100, "MANA": 50, "CLASS": "Warrior", ... },
      "MyChar2": { "HEALTH": 80, "MANA": 90, "CLASS": "Mage", ... }
    }
    ```

2.  **Delta Updates**: Subsequently, the server sends delta updates containing only changed data or deleted characters:
    ```json
    {
      "updates": {
        "MyChar1": { "HEALTH": 95, "MANA": 48, ... } // Only changed fields or full new data
      },
      "deletions": ["MyChar3"] // List of character names that timed out or were deleted
    }
    ```
    The `updates` object can contain full data for new characters or partial/full data for existing characters.

## Configuration

### Server Address

*   MUD client scripts are configured to send data to `http://localhost:8080/update`.
*   The web viewer connects to `ws://localhost:8080/ws`.
*   If you change the server's host or port, you'll need to update these in:
    *   `zmud_client.txt` (HTTP URL)
    *   `tintin_client.txt` (HTTP URL)
    *   `python_server/static/subscriber_client.html` (JavaScript constants `SERVER_HOST`, `SERVER_PORT`)
    *   The server configuration itself (e.g., constants in `server.py` or `main.rs`).

### Client-Side Update Intervals

*   **Tintin**: The `#VAR update_interval {0.5}` in `tintin_client.txt` controls how often data is sent (in seconds).
*   **ZMud**: Data is sent on prompt updates if changed, and spell affects are decremented by an alarm (defaulting to roughly every 3 seconds).

### Web Viewer (CSS Variables)

The `subscriber_client.html` file uses CSS variables for theming and layout. Some key ones at the top of the `<style>` section can be tweaked:

*   `--max-cards`: Maximum number of character cards to display.
*   `--blood-max`: Default max blood for vampire classes if not otherwise specified.
*   `--update-interval-ms`: JavaScript UI update check frequency (not WebSocket rate).
*   Color variables for light and dark themes.

## Development

*   Ensure the chosen server's dependencies are installed.
*   The servers will typically auto-reload on code changes if run with development tools (e.g., `cargo watch -x run` for Rust, or some Python auto-reloaders).
*   Browser developer tools are invaluable for debugging the web viewer and WebSocket communications.
