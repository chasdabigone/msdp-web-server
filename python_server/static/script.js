// --- Configuration ---
const SERVER_HOST = "localhost"; // Make sure this is correct
const SERVER_PORT = 8080;

// --- UI Element Visibility Configuration ---
const SHOW_LAG_INDICATOR = true;        // true to show lag bar/status, false to hide
const SHOW_NO_SANC_INDICATOR = true;  // true to show 'No Sanctuary' warning, false to hide
const SHOW_BLINDNESS_INDICATOR = true; // true to show 'Cannot See Opponent' warning, false to hide

// Define which items appear in the Info Bar (Favor/Style line).
// Order in this array affects the order of custom items.
// Predefined items (STYLE, EQHITS, etc.) will use their specific HTML elements if present.
// Other items (e.g., "LAST_COMMAND", "ROOM_VNUM") will be dynamically created.
// Values should match keys in your character data object.
const INFO_BAR_ITEMS = ["STYLE", "EQHITS", "FLYING", "VIS", "ALIGNMENT", "FAVOR"];
// --- End of UI Element Visibility Configuration ---


// Get CSS variables - ensure :root is parsed before this script runs
let MAX_CARDS, VAMPIRE_CLASSES, BLOOD_MAX, MAX_OPPONENT_NAME_LENGTH, RECONNECT_DELAY_MS, SANCTUARY_AFFECTS;

const LS_SELECTION_KEY = 'characterViewerSelection';
const LS_COLLAPSE_KEY = 'characterViewerListCollapsed';
const LS_THEME_KEY = 'characterViewerTheme';

// --- State Variables ---
let allCharacterData = {};
let orderedSelectedNames = [];
let webSocket = null;
let cardElements = [];
let reconnectTimer = null;

// --- DOM References ---
let characterListElement, cardGridElement, cardTemplate, connectionStatusIndicator, listPanelElement, listPanelHeader, collapseToggle, themeToggleButton;


// --- Helper to get CSS Variables ---
function initializeCssVariables() {
    const rootStyle = getComputedStyle(document.documentElement);
    MAX_CARDS = parseInt(rootStyle.getPropertyValue('--max-cards') || '8');
    VAMPIRE_CLASSES = new Set(["Vampire", "Dread Vampire","Dread vampire"]);
    BLOOD_MAX = parseInt(rootStyle.getPropertyValue('--blood-max') || '60');
    MAX_OPPONENT_NAME_LENGTH = parseInt(rootStyle.getPropertyValue('--max-opponent-name-length') || '16');
    RECONNECT_DELAY_MS = parseInt(rootStyle.getPropertyValue('--reconnect-delay-ms') || '5000');
    SANCTUARY_AFFECTS = new Set([
        "sanctuary", "greater sanctuary", "infernal sanctity",
        "holy sanctity", "nadur dion", "prophetic aura",
    ]);
}


// --- WebSocket Functions ---
function connectWebSocket() {
    clearTimeout(reconnectTimer);
    const wsUri = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;
    console.log(`Attempting to connect to WebSocket: ${wsUri}`);
    updateConnectionStatus('connecting');

    if (webSocket && webSocket.readyState !== WebSocket.CLOSED) {
        console.log("Closing existing WebSocket connection.");
        webSocket.close();
    }

    webSocket = new WebSocket(wsUri);

    webSocket.onopen = () => {
        console.log("WebSocket Connected");
        updateConnectionStatus('connected');
        clearTimeout(reconnectTimer);
    };

    webSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (typeof data === 'object' && data !== null &&
                data.hasOwnProperty('updates') && data.hasOwnProperty('deletions'))
            {
                if (typeof data.updates === 'object' && data.updates !== null) {
                    for (const charName in data.updates) {
                        if (data.updates.hasOwnProperty(charName)) {
                            allCharacterData[charName] = data.updates[charName];
                        }
                    }
                }

                if (Array.isArray(data.deletions)) {
                    data.deletions.forEach(charNameToDelete => {
                        if (allCharacterData.hasOwnProperty(charNameToDelete)) {
                            delete allCharacterData[charNameToDelete];
                            console.log(`Delta Deleted: ${charNameToDelete}`);
                        }
                    });
                }

                requestAnimationFrame(() => {
                    updateCharacterList();
                    updateActiveCards();
                });

            }
            else if (typeof data === 'object' && data !== null) {
                console.log("Received initial state snapshot");
                allCharacterData = data;

                requestAnimationFrame(() => {
                    updateCharacterList();
                    updateActiveCards();
                });
            } else {
                console.warn("Received unexpected data format:", data);
            }
        } catch (error) {
            console.error("Failed to parse or process WebSocket message:", error, event.data);
        }
    };

    webSocket.onerror = (error) => {
        console.error("WebSocket Error:", error);
    };

    webSocket.onclose = (event) => {
        console.warn(`WebSocket Disconnected: Code=${event.code}, Reason='${event.reason}'`);
        updateConnectionStatus('disconnected');
        webSocket = null;

        requestAnimationFrame(() => {
            updateActiveCards();
            updateCharacterListConnectionIndicators(false);
        });

        clearTimeout(reconnectTimer);
        if (!event.wasClean || event.code === 1006) {
           console.log(`Attempting reconnect in ${RECONNECT_DELAY_MS / 1000} seconds...`);
           reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
        } else {
            console.log("Clean disconnect. Not attempting auto-reconnect.");
        }
    };
}

function updateConnectionStatus(statusClass) {
    if (!connectionStatusIndicator) return;
    connectionStatusIndicator.className = statusClass;
    let titleText = 'Connection Status';
    if (statusClass === 'connected') titleText = 'Connected';
    else if (statusClass === 'disconnected') titleText = 'Disconnected - Attempting to Reconnect';
    else if (statusClass === 'connecting') titleText = 'Connecting...';
    connectionStatusIndicator.title = titleText;

     if (statusClass === 'disconnected' || statusClass === 'connecting') {
         updateCharacterListConnectionIndicators(false);
     }
}

function updateCharacterListConnectionIndicators(useCharacterData) {
    if (!characterListElement) return;
    Array.from(characterListElement.children).forEach(li => {
        const indicator = li.querySelector('.list-char-indicator');
        const charName = li.dataset.charname;
        if (!indicator || !charName) return;

        let isConnected = false;
        let title = 'Disconnected';

        if (useCharacterData && connectionStatusIndicator.classList.contains('connected')) {
            const data = allCharacterData[charName];
            isConnected = data?.CONNECTED === "YES";
            title = isConnected ? 'Connected' : 'Disconnected (Character)';
        } else {
            isConnected = false;
            title = connectionStatusIndicator.classList.contains('connecting') ? 'Connecting...' : 'Disconnected (Main)';
        }

        indicator.className = `list-char-indicator ${isConnected ? 'connected' : 'disconnected'}`;
        indicator.title = title;
    });
}

function updateCharacterList() {
    if (!characterListElement) return;

    const currentServerNames = Object.keys(allCharacterData).sort();
    const serverNamesSet = new Set(currentServerNames);

    const originalSelectionLength = orderedSelectedNames.length;
    orderedSelectedNames = orderedSelectedNames.filter(name => serverNamesSet.has(name));
    if (orderedSelectedNames.length !== originalSelectionLength) {
        saveSelectionToLocalStorage();
    }

    const currentListItemsMap = new Map();
    Array.from(characterListElement.children).forEach(li => {
        if (li.dataset.charname) {
            currentListItemsMap.set(li.dataset.charname, li);
        }
    });

    const fragmentForNewItems = document.createDocumentFragment();

    currentServerNames.forEach((name) => {
        const isSelected = orderedSelectedNames.includes(name);
        let li = currentListItemsMap.get(name);

        if (li) {
            li.classList.toggle('selected', isSelected);
            currentListItemsMap.delete(name);
        } else {
            li = document.createElement('li');
            li.dataset.charname = name;
            const nameSpan = document.createElement('span');
            nameSpan.className = 'list-char-name';
            nameSpan.textContent = name;
            const indicatorSpan = document.createElement('span');
            indicatorSpan.className = 'list-char-indicator';
            li.appendChild(nameSpan);
            li.appendChild(indicatorSpan);
            li.classList.toggle('selected', isSelected);
            fragmentForNewItems.appendChild(li);
        }
    });

    currentListItemsMap.forEach((staleLi, name) => {
        staleLi.remove();
    });

    if (fragmentForNewItems.hasChildNodes()) {
        characterListElement.appendChild(fragmentForNewItems);
         const itemsArray = Array.from(characterListElement.children);
         itemsArray.sort((a, b) => (a.dataset.charname || '').localeCompare(b.dataset.charname || ''));
         itemsArray.forEach(item => characterListElement.appendChild(item));
    }
    updateCharacterListConnectionIndicators(true);
}


function handleCharacterSelect(event) {
    const li = event.target.closest('li');
    if (!li || !characterListElement.contains(li)) return;

    const charName = li.dataset.charname;
    if (!charName || !allCharacterData[charName]) {
        console.warn(`Attempted to select ${charName}, but it's not in allCharacterData. Deselecting if necessary.`);
        const index = orderedSelectedNames.indexOf(charName);
        if (index > -1) {
            orderedSelectedNames.splice(index, 1);
            li.classList.remove('selected');
            saveSelectionToLocalStorage();
            requestAnimationFrame(updateCardAssignments);
        }
        return;
    }

    const index = orderedSelectedNames.indexOf(charName);
    if (index > -1) {
        orderedSelectedNames.splice(index, 1);
        li.classList.remove('selected');
    } else {
        if (orderedSelectedNames.length >= MAX_CARDS) {
            const oldestName = orderedSelectedNames.shift();
            const oldestLi = characterListElement.querySelector(`li[data-charname="${oldestName}"]`);
            if (oldestLi) {
                oldestLi.classList.remove('selected');
            }
        }
        orderedSelectedNames.push(charName);
        li.classList.add('selected');
    }

    saveSelectionToLocalStorage();
    requestAnimationFrame(updateCardAssignments);
}

function saveSelectionToLocalStorage() {
    try {
        localStorage.setItem(LS_SELECTION_KEY, JSON.stringify(orderedSelectedNames));
    } catch (e) {
        console.error("Failed to save selection to localStorage:", e);
    }
}

function updateCardAssignments() {
     cardElements.forEach((card, index) => {
          const charName = orderedSelectedNames[index];
          const currentCardChar = card.dataset.charname;

          if (charName) {
              if (!allCharacterData[charName]) {
                  console.warn(`Selected char ${charName} for card ${index} is not in allCharacterData. Clearing card and removing from selection.`);
                  if (currentCardChar) clearCard(card);
                  const problematicIndex = orderedSelectedNames.indexOf(charName);
                  if (problematicIndex > -1) orderedSelectedNames.splice(problematicIndex,1);
                  const listItem = characterListElement.querySelector(`li[data-charname="${charName}"]`);
                  if (listItem) listItem.classList.remove('selected');
                  saveSelectionToLocalStorage();
                  return;
              }
              if (currentCardChar !== charName || card.classList.contains('hidden')) {
                 card.classList.remove('hidden');
                 updateCardData(card, charName, allCharacterData[charName]);
              }
          } else {
              if (currentCardChar) {
                 clearCard(card);
              }
          }
     });
     for (let i = orderedSelectedNames.length; i < cardElements.length; i++) {
         if (cardElements[i].dataset.charname) {
            clearCard(cardElements[i]);
         }
     }
}

function updateActiveCards() {
    cardElements.forEach(card => {
         const charName = card.dataset.charname;
         if (charName) {
              const data = allCharacterData[charName] || null;
              updateCardData(card, charName, data);
         }
    });
}


function createCardElement() {
    if (!cardTemplate) {
        console.error("Card template not found!");
        return null;
    }
    const cardClone = cardTemplate.content.firstElementChild.cloneNode(true);
    const expandButton = cardClone.querySelector('.expand-button');
    expandButton.addEventListener('click', (e) => {
         toggleExpand(cardClone);
         e.stopPropagation();
    });

    cardClone._elements = {
        nameText: cardClone.querySelector('.char-name-text'),
        lag: cardClone.querySelector('.char-lag'),
        lagBarFg: cardClone.querySelector('.lag-bar-fg'),
        class: cardClone.querySelector('.char-class'),
        hpBarFg: cardClone.querySelector('.hp-bar .bar-fg'),
        hpBarText: cardClone.querySelector('.hp-bar .bar-text'),
        resourceBar: cardClone.querySelector('.resource-bar'),
        resourceLabel: cardClone.querySelector('.resource-bar .bar-label'),
        resourceBarFg: cardClone.querySelector('.resource-bar .bar-fg'),
        resourceBarText: cardClone.querySelector('.resource-bar .bar-text'),
        opponentLine: cardClone.querySelector('.opponent-line'),
        opponentLabel: cardClone.querySelector('.opponent-line .info-line-label'),
        opponentValue: cardClone.querySelector('.opponent-line .info-line-value'),
        favorStyleLine: cardClone.querySelector('.favor-style-line'),
        stylePart: cardClone.querySelector('.favor-style-line .style-part'),
        eqHitsPart: cardClone.querySelector('.favor-style-line .eq-hits-part'),
        flyPart: cardClone.querySelector('.fly-part'),
        flyCheckbox: cardClone.querySelector('.fly-part input[type="checkbox"]'),
        visPart: cardClone.querySelector('.vis-part'),
        alignmentPart: cardClone.querySelector('.favor-style-line .alignment-part'),
        favorPart: cardClone.querySelector('.favor-style-line .favor-part'),
        customInfoItemsContainer: cardClone.querySelector('.custom-info-items-container'), // ADDED
        affectsSection: cardClone.querySelector('.affects-section'),
        affectsText: cardClone.querySelector('.affects-text'),
        expandedSection: cardClone.querySelector('.expanded-section'),
        expandedText: cardClone.querySelector('.expanded-text'),
        blindnessIndicator: cardClone.querySelector('.blindness-indicator'),
        noSancIndicator: cardClone.querySelector('.no-sanc-indicator'),
        connectionIndicator: cardClone.querySelector('.card-connection-indicator'),
        expandButton: expandButton,
        cardContent: cardClone.querySelector('.card-content'),
    };
    return cardClone;
}

function clearCard(cardElement) {
     if (!cardElement || !cardElement._elements) return;

     cardElement.dataset.charname = "";
     cardElement.dataset.isExpanded = "false";
     cardElement.classList.add('hidden');
     cardElement.classList.remove('card-offline');
     const els = cardElement._elements;

     els.nameText.textContent = "Character Name";

     if (els.lag) {
        if (SHOW_LAG_INDICATOR) {
            els.lag.style.display = 'flex';
            if (els.lagBarFg) els.lagBarFg.style.width = '0%';
            els.lag.classList.remove('lag-ok', 'lag-high', 'lag-critical');
            els.lag.title = "Lag Status";
        } else {
            els.lag.style.display = 'none';
        }
     }

     els.class.textContent = "Class";
     updateBar(els.hpBarFg, els.hpBarText, 0, 1, 'HP');
     updateBar(els.resourceBarFg, els.resourceBarText, 0, 1, 'Mana', els.resourceBar, els.resourceLabel);

     els.opponentLine.style.display = 'none';
     els.opponentLabel.textContent = "Opponent HP:";
     els.opponentLabel.title = '';
     els.opponentValue.textContent = "N/A";

     els.favorStyleLine.style.display = 'none'; // Hide the whole line
     // Reset predefined parts (they will be shown by updateCardData if configured and valid)
     if(els.stylePart) { els.stylePart.textContent = "Style: N/A"; els.stylePart.style.display = 'none'; }
     if(els.eqHitsPart) { els.eqHitsPart.textContent = "EQHits: N/A"; els.eqHitsPart.style.display = 'none'; }
     if(els.flyPart) { els.flyPart.style.display = 'none'; if (els.flyCheckbox) els.flyCheckbox.checked = false; }
     if(els.visPart) { els.visPart.textContent = "Vis: N/A"; els.visPart.style.display = 'none'; }
     if(els.alignmentPart) { els.alignmentPart.textContent = "Align: N/A"; els.alignmentPart.style.display = 'none'; }
     if(els.favorPart) { els.favorPart.textContent = "Favor: N/A"; els.favorPart.style.display = 'none'; }
     if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = ''; // Clear dynamic items

     els.affectsSection.style.display = 'none'; els.affectsText.textContent = "";
     els.expandedSection.style.display = 'none'; els.expandedText.textContent = "";
     els.blindnessIndicator.style.display = 'none';
     els.noSancIndicator.style.display = 'none';
     els.expandButton.textContent = "+";
     els.expandButton.disabled = true;
     els.connectionIndicator.className = 'card-connection-indicator disconnected';
     els.connectionIndicator.title = 'Connection Status';
}

function updateCardData(cardElement, charName, data) {
  const els = cardElement._elements;
  if (!els) return;

  const isMainConnected = connectionStatusIndicator.classList.contains('connected');
  const isExpanded = cardElement.dataset.isExpanded === 'true';

  if (isMainConnected && !data) {
      clearCard(cardElement);
      return;
  }

  if (!isMainConnected) {
      cardElement.classList.add('card-offline');
      els.nameText.textContent = `${data?.CHARACTER_NAME || charName} (Offline)`;

      if (els.lag) {
        if (SHOW_LAG_INDICATOR) {
            els.lag.style.display = 'flex';
            if(els.lagBarFg) els.lagBarFg.style.width = '0%';
            els.lag.classList.remove('lag-ok', 'lag-high', 'lag-critical');
            els.lag.title = "Lag: Offline";
        } else {
            els.lag.style.display = 'none';
        }
      }
      els.class.textContent = data ? (data.CLASS || "N/A") : "N/A";
      const hp = data ? parseInt(data.HEALTH || 0) : 0;
      const hpMax = data ? Math.max(1, parseInt(data.HEALTH_MAX || 1)) : 1;
      updateBar(els.hpBarFg, els.hpBarText, hp, hpMax, 'HP');
      if (data && VAMPIRE_CLASSES.has(data.CLASS || "")) {
          updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.BLOOD || 0), BLOOD_MAX, 'Blood', els.resourceBar, els.resourceLabel);
      } else {
          updateBar(els.resourceBarFg, els.resourceBarText, data ? parseInt(data.MANA || 0) : 0, data ? Math.max(1, parseInt(data.MANA_MAX || 1)) : 1, 'Mana', els.resourceBar, els.resourceLabel);
      }
      els.opponentLine.style.display = 'none';
      els.favorStyleLine.style.display = 'none'; // Hide the whole line
      if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = ''; // Clear dynamic items
      els.affectsSection.style.display = 'none'; els.affectsText.textContent = '';
      els.blindnessIndicator.style.display = 'none';
      els.noSancIndicator.style.display = 'none';
      els.expandButton.disabled = true;
      els.expandButton.textContent = "+";
      els.expandedSection.style.display = 'none'; els.expandedText.textContent = '';
      if (isExpanded) cardElement.dataset.isExpanded = "false";
      els.connectionIndicator.className = 'card-connection-indicator disconnected';
      els.connectionIndicator.title = connectionStatusIndicator.classList.contains('connecting') ? 'Connecting...' : 'Disconnected (Main)';
      return;
  }

  cardElement.classList.remove('card-offline');
  els.expandButton.disabled = false;
  cardElement.dataset.charname = charName;

  const isCharConnected = (data.CONNECTED === "YES");
  els.connectionIndicator.className = `card-connection-indicator ${isCharConnected ? 'connected' : 'disconnected'}`;
  els.connectionIndicator.title = isCharConnected ? 'Connected' : 'Disconnected (Character)';

  els.nameText.textContent = data.CHARACTER_NAME || charName;

  if (els.lag) {
    if (SHOW_LAG_INDICATOR) {
        els.lag.style.display = 'flex';
        const lagValue = data.WAIT_TIME ?? "";
        let lagPercentage = 0, lagClass = "", lagTitle = "Lag: Unknown";
        if (lagValue === "!!!!!") { lagPercentage = 100; lagClass = "lag-critical"; lagTitle = "Lag: Critical (!!!!!)"; }
        else {
            const pipeCount = (String(lagValue).match(/\|/g) || []).length;
            if (pipeCount === 0) { lagPercentage = 0; lagTitle = "Lag: OK (0)"; }
            else if (pipeCount <= 3) { lagClass = "lag-ok"; lagPercentage = pipeCount * 20; lagTitle = `Lag: OK (${pipeCount})`;}
            else if (pipeCount === 4) { lagPercentage = 80; lagClass = "lag-high"; lagTitle = "Lag: High (4)";}
            else { lagPercentage = 100; lagClass = "lag-high"; lagTitle = `Lag: High (${pipeCount}+)`;}
        }
        if (els.lagBarFg) els.lagBarFg.style.width = `${lagPercentage}%`;
        els.lag.className = 'char-lag'; if (lagClass) els.lag.classList.add(lagClass);
        els.lag.title = lagTitle;
    } else {
        els.lag.style.display = 'none';
    }
  }

  const charClass = data.CLASS || "N/A";
  els.class.textContent = charClass;
  updateBar(els.hpBarFg, els.hpBarText, parseInt(data.HEALTH || 0), Math.max(1, parseInt(data.HEALTH_MAX || 1)), 'HP');
  if (VAMPIRE_CLASSES.has(charClass)) {
       updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.BLOOD || 0), BLOOD_MAX, 'Blood', els.resourceBar, els.resourceLabel);
  } else {
       updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.MANA || 0), Math.max(1, parseInt(data.MANA_MAX || 1)), 'Mana', els.resourceBar, els.resourceLabel);
  }

  const oppNameRaw = data.OPPONENT_NAME;
  const oppNameIsValid = typeof oppNameRaw === 'string' && oppNameRaw !== "";
  const isVisuallyBlind = (oppNameRaw === 'You cannot see your opponent.');
  if (oppNameIsValid) {
       els.opponentLine.style.display = 'flex';
       let displayName = oppNameRaw;
       if (displayName.length > MAX_OPPONENT_NAME_LENGTH) displayName = displayName.substring(0, MAX_OPPONENT_NAME_LENGTH) + "...";
       els.opponentLabel.textContent = displayName;
       els.opponentLabel.title = (oppNameRaw.length > MAX_OPPONENT_NAME_LENGTH) ? oppNameRaw : displayName;
       const oppHp = data.OPPONENT_HEALTH;
       els.opponentValue.textContent = (oppHp !== undefined && oppHp !== null && oppHp !== "N/A") ? `${oppHp}%` : "N/A";
  } else {
       els.opponentLine.style.display = 'none';
       els.opponentLabel.textContent = "Opponent HP:"; els.opponentLabel.title = ''; els.opponentValue.textContent = "N/A";
  }

  // --- Info Bar (Favor/Style Line) ---
  let favorStyleLineVisible = false;
  if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = ''; // Clear previous dynamic items

  // Ensure predefined parts are initially hidden, they will be shown if configured and data is valid
  if (els.stylePart) els.stylePart.style.display = 'none';
  if (els.eqHitsPart) els.eqHitsPart.style.display = 'none';
  if (els.flyPart) els.flyPart.style.display = 'none';
  if (els.visPart) els.visPart.style.display = 'none';
  if (els.alignmentPart) els.alignmentPart.style.display = 'none';
  if (els.favorPart) els.favorPart.style.display = 'none';


  INFO_BAR_ITEMS.forEach(itemKey => {
    let value;
    let isValid = false;
    let handledAsPredefined = false;

    // Handle predefined items first
    switch (itemKey.toUpperCase()) {
        case "STYLE":
            value = data.STYLE ?? data.COMBAT_STYLE;
            isValid = (value !== undefined && value !== null && value !== "");
            if (isValid && els.stylePart) {
                els.stylePart.textContent = `Style: ${String(value)}`;
                els.stylePart.style.display = 'inline';
                favorStyleLineVisible = true;
            }
            handledAsPredefined = true;
            break;
        case "EQHITS":
            value = data.EQUIP_HITS;
            isValid = (value !== undefined && value !== null && value !== "");
            if (isValid && els.eqHitsPart) {
                els.eqHitsPart.textContent = `EQHits: ${String(value)}`;
                els.eqHitsPart.style.display = 'inline';
                favorStyleLineVisible = true;
            }
            handledAsPredefined = true;
            break;
        case "FLYING":
            isValid = data.hasOwnProperty('FLYING'); // Check for key presence
            if (isValid && els.flyPart) {
                els.flyPart.style.display = 'inline';
                if (els.flyCheckbox) els.flyCheckbox.checked = (data.FLYING === 'Y');
                favorStyleLineVisible = true;
            } else if (els.flyCheckbox) { // Ensure checkbox is off if not configured or no data
                 els.flyCheckbox.checked = false;
            }
            handledAsPredefined = true;
            break;
        case "VIS":
            isValid = data.hasOwnProperty('VIS'); // Check for key presence
            if (isValid && els.visPart) {
                value = data.VIS;
                els.visPart.textContent = `Vis: ${(value === null || value === undefined) ? "(None)" : String(value)}`;
                els.visPart.style.display = 'inline';
                favorStyleLineVisible = true;
            }
            handledAsPredefined = true;
            break;
        case "ALIGNMENT":
            value = data.ALIGNMENT;
            isValid = (value !== undefined && value !== null && value !== "");
            if (isValid && els.alignmentPart) {
                els.alignmentPart.textContent = `Align: ${String(value)}`;
                els.alignmentPart.style.display = 'inline';
                favorStyleLineVisible = true;
            }
            handledAsPredefined = true;
            break;
        case "FAVOR":
            value = data.FAVOR;
            isValid = (value !== undefined && value !== null && value !== "N/A");
            if (isValid && els.favorPart) {
                els.favorPart.textContent = `Favor: ${String(value)}`;
                els.favorPart.style.display = 'inline';
                favorStyleLineVisible = true;
            }
            handledAsPredefined = true;
            break;
    }

    // If not handled as a predefined item, try to add it to the custom container
    if (!handledAsPredefined && data.hasOwnProperty(itemKey) && els.customInfoItemsContainer) {
        value = data[itemKey];
        // Define "valid" for custom items: not null or undefined. Empty strings are ok.
        isValid = (value !== null && value !== undefined);
        if (isValid) {
            const customSpan = document.createElement('span');
            customSpan.className = 'info-bar-custom-item'; // Add a class for potential styling

            // Create a friendlier display label from the itemKey
            const displayLabel = itemKey
                .replace(/_/g, ' ') // Replace underscores with spaces
                .replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()); // Capitalize each word

            customSpan.textContent = `${displayLabel}: ${String(value)}`;
            els.customInfoItemsContainer.appendChild(customSpan);
            favorStyleLineVisible = true;
        }
    }
  });
  if (els.favorStyleLine) els.favorStyleLine.style.display = favorStyleLineVisible ? 'flex' : 'none';
  // --- End of Info Bar ---


  const { affectsStr, hasSanctuary } = parseAffects(data.AFFECTS);
  if (affectsStr) {
      els.affectsText.textContent = affectsStr;
      els.affectsSection.style.display = 'block';
  } else {
      els.affectsSection.style.display = 'none';
      els.affectsText.textContent = '';
  }
  els.blindnessIndicator.style.display = (SHOW_BLINDNESS_INDICATOR && isVisuallyBlind) ? 'block' : 'none';
  els.noSancIndicator.style.display = (SHOW_NO_SANC_INDICATOR && !hasSanctuary && affectsStr) ? 'block' : 'none';

  els.expandButton.textContent = isExpanded ? "-" : "+";
  if (isExpanded) {
       els.expandedText.textContent = formatFullData(data);
       els.expandedSection.style.display = 'block';
  } else {
       els.expandedSection.style.display = 'none';
  }
}


function updateBar(barFgElement, textElement, current, max, type, barElement = null, labelElement = null) {
     current = parseInt(current) || 0;
     max = parseInt(max) || 1;
     if (max <= 0) max = 1;
     const percentage = Math.min(100, Math.max(0, (current / max) * 100));

     if (barFgElement) barFgElement.style.width = `${percentage}%`;
     if (textElement) textElement.textContent = `${current} / ${max > 999999 ? 'lots' : max}`;
     if (labelElement) labelElement.textContent = `${type}:`;
     if (barElement) {
         barElement.classList.remove('hp-bar', 'mana-bar', 'blood-bar', 'resource-bar');
         if (type === 'HP') barElement.classList.add('hp-bar');
         else {
            barElement.classList.add('resource-bar');
            if (type === 'Mana') barElement.classList.add('mana-bar');
            else if (type === 'Blood') barElement.classList.add('blood-bar');
         }
     }
}

function parseAffects(affectsData) {
    let parsedAffects = [];
    let affectsStr = "";
    let hasSanctuary = false;
    let couldParse = false;

    if (typeof affectsData === 'object' && affectsData !== null) {
        Object.entries(affectsData).forEach(([key, value]) => {
            parsedAffects.push({ name: key, value: String(value) });
        });
         if (parsedAffects.length > 0) couldParse = true;
    }
    else if (typeof affectsData === 'string') {
         if (affectsData.startsWith('{') && affectsData.includes('}{')) {
             const pairs = affectsData.match(/\{([^}]+?)\}\{([^}]*?)\}/g) || [];
             pairs.forEach(pair => {
                  const match = pair.match(/\{([^}]+?)\}\{([^}]*?)\}/);
                  if (match && match[1]) {
                       parsedAffects.push({ name: match[1].trim(), value: match[2].trim() });
                  }
             });
              if (parsedAffects.length > 0) couldParse = true;
         }
         if (!couldParse && affectsData.trim()) {
            affectsStr = affectsData;
         }
    }

    if (couldParse) {
        const compareAffects = (a, b) => {
            const order = ['sanctuary', 'greater sanctuary', 'infernal sanctity', 'holy sanctity', 'nadur dion', 'prophetic aura'];
            const indexA = order.indexOf(a.name.toLowerCase());
            const indexB = order.indexOf(b.name.toLowerCase());
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
            return a.name.localeCompare(b.name);
        };
        parsedAffects.sort(compareAffects);
        affectsStr = parsedAffects.map(item => `${item.name}${(item.value && item.value !== "0") ? (': ' + item.value) : ''}`).join('\n');
    }

    const checkString = (affectsStr || "").toLowerCase();
    hasSanctuary = Array.from(SANCTUARY_AFFECTS).some(sanc => checkString.includes(sanc));
    if (!hasSanctuary && couldParse) {
         const affectNamesLower = new Set(parsedAffects.map(a => a.name.toLowerCase()));
         hasSanctuary = Array.from(SANCTUARY_AFFECTS).some(sanc => affectNamesLower.has(sanc));
    }

    return { affectsStr: affectsStr || "", hasSanctuary };
}

function formatFullData(data) {
     try {
         if (!data) return "No data available.";
         const preferredOrder = [
            'CHARACTER_NAME', 'CLASS', 'RACE', 'LEVEL', 'ALIGNMENT',
            'HEALTH', 'HEALTH_MAX', 'MANA', 'MANA_MAX', 'BLOOD',
            'STYLE', 'COMBAT_STYLE', 'FAVOR',
            'OPPONENT_NAME', 'OPPONENT_HEALTH',
            'EQUIP_HITS', 'FLYING', 'VIS',
            'AFFECTS', 'WAIT_TIME', 'LAG', // LAG is an alternative for WAIT_TIME here
            'ROOM_NAME', 'ROOM_EXITS', 'ROOM_VNUM',
            'CONNECTED', 'LAST_UPDATE'
         ];
         // Add items from INFO_BAR_ITEMS to preferredOrder if not already there,
         // to ensure they are shown in the expanded view if they exist in data.
         INFO_BAR_ITEMS.forEach(item => {
            if (!preferredOrder.includes(item.toUpperCase()) && !preferredOrder.includes(item)) { // Check both cases
                // Try to find a sensible place to insert or just append
                if (item.toUpperCase() === 'LAST_COMMAND') { // Example specific placement
                    const affectsIndex = preferredOrder.indexOf('AFFECTS');
                    if (affectsIndex > -1) preferredOrder.splice(affectsIndex + 1, 0, item);
                    else preferredOrder.push(item);
                } else {
                    preferredOrder.push(item);
                }
            }
         });


         const displayItems = [];
         const handledKeys = new Set();
         const altKeys = { 'LAG': 'WAIT_TIME', 'COMBAT_STYLE': 'STYLE' }; // Map alternative keys to preferred keys

         const parseExitsString = (exitsValue) => {
             const rawString = String(exitsValue).replace(/^.*?:\s*/, "").trim();
             if (!rawString) return "(None)";
             const matches = rawString.match(/[a-z]+/g);
             return (matches && matches.length > 0) ? matches.join(', ') : "(None)";
         };

         preferredOrder.forEach(preferredKey => {
             let dataKeyToUse = null;
             let valueToDisplay;

             if (data.hasOwnProperty(preferredKey)) {
                 dataKeyToUse = preferredKey;
                 valueToDisplay = data[dataKeyToUse];
             } else if (altKeys[preferredKey] && data.hasOwnProperty(altKeys[preferredKey])) { // Check alternative key
                 dataKeyToUse = altKeys[preferredKey];
                 valueToDisplay = data[dataKeyToUse];
             }


             if (dataKeyToUse && !handledKeys.has(dataKeyToUse) && !handledKeys.has(preferredKey)) {
                 let isHandled = false;

                 if (dataKeyToUse === 'ROOM_EXITS') {
                     if (typeof valueToDisplay === 'string') { valueToDisplay = parseExitsString(valueToDisplay); isHandled = true; }
                     else if (typeof valueToDisplay === 'object' && valueToDisplay !== null) {
                         valueToDisplay = Object.entries(valueToDisplay).filter(([, vnum]) => vnum !== null && vnum !== undefined).map(([dir]) => dir).join(', ') || "(None)";
                         isHandled = true;
                     }
                 }
                 if (!isHandled && dataKeyToUse === 'AFFECTS' && typeof valueToDisplay === 'object' && valueToDisplay !== null) {
                     const { affectsStr } = parseAffects(valueToDisplay); valueToDisplay = affectsStr || "(None)"; isHandled = true;
                 }
                 if (!isHandled) {
                    if (valueToDisplay === null || valueToDisplay === undefined) valueToDisplay = "(Not Set)";
                    else if (valueToDisplay === "") valueToDisplay = "(Empty)";
                    else if (typeof valueToDisplay === 'object') valueToDisplay = JSON.stringify(valueToDisplay);
                 }
                 displayItems.push({ key: preferredKey, value: String(valueToDisplay) }); // Use preferredKey for display
                 handledKeys.add(dataKeyToUse);
                 handledKeys.add(preferredKey); // Mark preferredKey as handled too
             }
         });

         Object.keys(data).filter(key => !handledKeys.has(key)).sort().forEach(key => {
                 let value = data[key]; let isHandled = false;
                 if (key === 'ROOM_EXITS') { // Redundant if already handled, but safe
                     if (typeof value === 'string') { value = parseExitsString(value); isHandled = true; }
                     else if (typeof value === 'object' && value !== null) {
                         value = Object.entries(value).filter(([, vnum]) => vnum !== null && vnum !== undefined).map(([dir]) => dir).join(', ') || "(None)";
                         isHandled = true;
                     }
                 }
                 if (!isHandled && key === 'AFFECTS' && typeof value === 'object' && value !== null) {
                     const { affectsStr } = parseAffects(value); value = affectsStr || "(None)"; isHandled = true;
                 }
                 if (!isHandled) {
                     if (value === null || value === undefined) value = "(Not Set)";
                     else if (value === "") value = "(Empty)";
                     else if (typeof value === 'object') value = JSON.stringify(value);
                 }
                 displayItems.push({ key: key, value: String(value) });
             });

         if (displayItems.length === 0) return "No data fields available.";
         return displayItems.map(item => `${item.key}: ${item.value}`).join('\n').trim();

     } catch (error) {
         console.error("Error formatting full data:", error, data);
         try { return JSON.stringify(data, null, 2) || "Error displaying data."; }
         catch (stringifyError) { return "Error displaying data (failed to stringify)." }
     }
}


function toggleExpand(cardElement) {
    if (!cardElement || !cardElement._elements || cardElement._elements.expandButton.disabled) return;

    const isExpanded = cardElement.dataset.isExpanded === 'true';
    cardElement.dataset.isExpanded = (!isExpanded).toString();

    const charName = cardElement.dataset.charname;
    const data = charName ? (allCharacterData[charName] || null) : null;
    const isMainConnected = connectionStatusIndicator.classList.contains('connected');

    if(isMainConnected && data) {
         updateCardData(cardElement, charName, data);
    } else {
        const els = cardElement._elements;
        els.expandButton.textContent = !isExpanded ? "-" : "+";
        els.expandedSection.style.display = !isExpanded ? 'block' : 'none';
        if (!isExpanded) {
            els.expandedText.textContent = formatFullData(data);
        }
    }
     if (!isExpanded) {
         setTimeout(() => {
              const contentArea = cardElement._elements.cardContent;
              if (contentArea) contentArea.scrollTop = 0;
         }, 0);
     }
}

function applyTheme(theme) {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
        if(themeToggleButton) themeToggleButton.title = 'Switch to Light Theme';
    } else {
        document.body.classList.remove('dark-mode');
        if(themeToggleButton) themeToggleButton.title = 'Switch to Dark Theme';
    }
}

function toggleTheme() {
    const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
    applyTheme(newTheme);
    try { localStorage.setItem(LS_THEME_KEY, newTheme); }
    catch (e) { console.error("Failed to save theme to localStorage:", e); }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Loaded. Initializing...");

    characterListElement = document.getElementById('character-list');
    cardGridElement = document.getElementById('card-grid');
    cardTemplate = document.getElementById('card-template');
    connectionStatusIndicator = document.getElementById('connection-status-indicator');
    listPanelElement = document.querySelector('.list-panel');
    listPanelHeader = document.getElementById('list-panel-header');
    collapseToggle = document.getElementById('collapse-toggle');
    themeToggleButton = document.getElementById('theme-toggle');

    initializeCssVariables();

    if (themeToggleButton) {
         let preferredTheme = 'light';
         try {
            const savedTheme = localStorage.getItem(LS_THEME_KEY);
            if (savedTheme) preferredTheme = savedTheme;
            else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) preferredTheme = 'dark';
         } catch (e) { console.error("Failed to load theme from localStorage:", e); }
         applyTheme(preferredTheme);
         themeToggleButton.addEventListener('click', toggleTheme);
     }

    if (listPanelElement && collapseToggle && listPanelHeader) {
        try {
            if (localStorage.getItem(LS_COLLAPSE_KEY) === 'true') {
                listPanelElement.classList.add('collapsed');
                collapseToggle.textContent = '▶'; collapseToggle.title = 'Expand List';
            } else { collapseToggle.textContent = '▼'; collapseToggle.title = 'Collapse List'; }
        } catch (e) { console.error("Failed to load collapse state:", e); }

        listPanelHeader.addEventListener('click', (event) => {
            if (event.target === connectionStatusIndicator || connectionStatusIndicator.contains(event.target)) return;
            const isCollapsed = listPanelElement.classList.toggle('collapsed');
            collapseToggle.textContent = isCollapsed ? '▶' : '▼';
            collapseToggle.title = isCollapsed ? 'Expand List' : 'Collapse List';
            try { localStorage.setItem(LS_COLLAPSE_KEY, isCollapsed.toString()); }
            catch (e) { console.error("Failed to save collapse state:", e); }
        });
    }

    try {
        const savedSelection = localStorage.getItem(LS_SELECTION_KEY);
         if (savedSelection) {
             const parsedSelection = JSON.parse(savedSelection);
             if (Array.isArray(parsedSelection)) {
                 orderedSelectedNames = parsedSelection.filter(item => typeof item === 'string').slice(0, MAX_CARDS);
             } else localStorage.removeItem(LS_SELECTION_KEY);
         }
    } catch (e) { console.error("Failed to load selection:", e); localStorage.removeItem(LS_SELECTION_KEY); }

    for (let i = 0; i < MAX_CARDS; i++) {
        const newCard = createCardElement();
        if (newCard) { cardElements.push(newCard); cardGridElement.appendChild(newCard); clearCard(newCard); }
    }

    updateCardAssignments();

    if (characterListElement) characterListElement.addEventListener('click', handleCharacterSelect);
    else console.error("Character list element not found!");

    connectWebSocket();
});