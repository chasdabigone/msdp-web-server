const SERVER_HOST = "localhost";
const SERVER_PORT = 8080;

let SHOW_LAG_INDICATOR, SHOW_NO_SANC_INDICATOR, SHOW_BLINDNESS_INDICATOR;
const DEFAULT_INFO_BAR_ITEMS = ["STYLE", "EQUIP_HITS", "FLYING", "VIS", "ALIGNMENT", "FAVOR"];

let MAX_CARDS, BLOOD_MAX, MAX_OPPONENT_NAME_LENGTH, RECONNECT_DELAY_MS;
let VAMPIRE_CLASSES, SANCTUARY_AFFECTS;

const LS_SELECTION_KEY = 'characterViewerSelection';
const LS_COLLAPSE_KEY = 'characterViewerListCollapsed';
const LS_THEME_KEY = 'characterViewerTheme';
const LS_INFO_BAR_KEY = 'characterViewerInfoBarItems';

let allCharacterData = {};
let orderedSelectedNames = [];
let webSocket = null;
let cardElements = [];
let reconnectTimer = null;
let activeInfoBarItems = [];
let knownKeysForModal = new Set();

let characterListElement, cardGridElement, cardTemplate, globalConnectionStatusIndicator,
    listPanelElement, listPanelHeader, collapseToggle,
    settingsToggleButton,
    settingsModal, infoBarKeysListElement, themeToggleModalButton;

function initializeCssAndJsConfigs() {
    const rootStyle = getComputedStyle(document.documentElement);
    MAX_CARDS = parseInt(rootStyle.getPropertyValue('--max-cards').trim() || '8');
    BLOOD_MAX = parseInt(rootStyle.getPropertyValue('--blood-max').trim() || '60');
    MAX_OPPONENT_NAME_LENGTH = parseInt(rootStyle.getPropertyValue('--max-opponent-name-length').trim() || '16');
    RECONNECT_DELAY_MS = parseInt(rootStyle.getPropertyValue('--reconnect-delay-ms').trim() || '5000');
    SHOW_LAG_INDICATOR = (rootStyle.getPropertyValue('--show-lag-indicator').trim().toLowerCase() === 'true');
    SHOW_NO_SANC_INDICATOR = (rootStyle.getPropertyValue('--show-no-sanc-indicator').trim().toLowerCase() === 'true');
    SHOW_BLINDNESS_INDICATOR = (rootStyle.getPropertyValue('--show-blindness-indicator').trim().toLowerCase() === 'true');
    VAMPIRE_CLASSES = new Set(["Vampire", "Dread Vampire", "Dread vampire"]);
    SANCTUARY_AFFECTS = new Set([
        "sanctuary", "greater sanctuary", "infernal sanctity",
        "holy sanctity", "nadur dion", "prophetic aura",
    ]);
}

function openSettingsModal() {
    if (!settingsModal || !settingsToggleButton) return;
    const modalContent = settingsModal.querySelector('.modal-content');
    if (!modalContent) return;

    knownKeysForModal.clear();
    populateSettingsModal();
    
    settingsModal.style.display = 'block';

    const buttonRect = settingsToggleButton.getBoundingClientRect();
    
    const newTop = buttonRect.top;
    const newRightOffset = window.innerWidth - buttonRect.right;

    modalContent.style.top = `${newTop}px`;
    modalContent.style.right = `${newRightOffset}px`;
    
    modalContent.style.left = 'auto';
    modalContent.style.bottom = 'auto';
}

function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.style.display = 'none';
}

function populateSettingsModal() {
    if (!infoBarKeysListElement || !settingsModal) return;

    const newDiscoveredKeys = new Set();
    Object.values(allCharacterData).forEach(charData => Object.keys(charData).forEach(key => newDiscoveredKeys.add(key)));
    DEFAULT_INFO_BAR_ITEMS.forEach(key => newDiscoveredKeys.add(key));
    activeInfoBarItems.forEach(key => newDiscoveredKeys.add(key));

    let needsRebuild = false;
    if (newDiscoveredKeys.size !== knownKeysForModal.size) {
        needsRebuild = true;
    } else {
        for (const key of newDiscoveredKeys) {
            if (!knownKeysForModal.has(key)) {
                needsRebuild = true;
                break;
            }
        }
    }

    if (settingsModal.style.display !== 'block') {
        needsRebuild = true;
    }


    if (needsRebuild) {
        infoBarKeysListElement.innerHTML = '';
        knownKeysForModal.clear();
        const sortedKeys = Array.from(newDiscoveredKeys).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        sortedKeys.forEach(key => {
            knownKeysForModal.add(key);
            const li = document.createElement('li');
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = key;
            checkbox.checked = activeInfoBarItems.includes(key);
            checkbox.addEventListener('change', saveInfoBarSettings);
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${key}`));
            li.appendChild(label);
            infoBarKeysListElement.appendChild(li);
        });
    } else {
        infoBarKeysListElement.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
            checkbox.checked = activeInfoBarItems.includes(checkbox.value);
        });
    }
}

function saveInfoBarSettings() {
    if (!infoBarKeysListElement) return;
    const newlySelectedKeys = Array.from(infoBarKeysListElement.querySelectorAll('input[type="checkbox"]:checked'))
                              .map(cb => cb.value);
    if (JSON.stringify(newlySelectedKeys) !== JSON.stringify(activeInfoBarItems)) {
        activeInfoBarItems = newlySelectedKeys;
        try {
            localStorage.setItem(LS_INFO_BAR_KEY, JSON.stringify(activeInfoBarItems));
        } catch (e) { console.error("Failed to save Info Bar settings:", e); }
        requestAnimationFrame(updateActiveCards);
    }
}

function loadInfoBarSettings() {
    let loadedItems = null;
    try {
        const savedItems = localStorage.getItem(LS_INFO_BAR_KEY);
        if (savedItems) {
            const parsedItems = JSON.parse(savedItems);
            if (Array.isArray(parsedItems) && parsedItems.every(item => typeof item === 'string')) {
                loadedItems = parsedItems;
            } else { localStorage.removeItem(LS_INFO_BAR_KEY); }
        }
    } catch (e) { console.error("Failed to load Info Bar settings:", e); }
    activeInfoBarItems = loadedItems ? loadedItems : [...DEFAULT_INFO_BAR_ITEMS];
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    const wsUri = `ws://${SERVER_HOST}:${SERVER_PORT}/ws`;
    updateGlobalConnectionStatus('connecting');
    if (webSocket && webSocket.readyState !== WebSocket.CLOSED) webSocket.close();
    webSocket = new WebSocket(wsUri);
    webSocket.onopen = () => { updateGlobalConnectionStatus('connected'); clearTimeout(reconnectTimer); };
    webSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            let dataChanged = false;
            if (data?.updates || data?.deletions) {
                Object.entries(data.updates || {}).forEach(([name, charData]) => { allCharacterData[name] = charData; dataChanged = true; });
                (data.deletions || []).forEach(name => { if (allCharacterData[name]) { delete allCharacterData[name]; dataChanged = true; }});
            } else if (typeof data === 'object' && data !== null) { allCharacterData = data; dataChanged = true;
            } else console.warn("Unexpected data format:", data);

            if (dataChanged) {
                requestAnimationFrame(() => {
                    updateCharacterList();
                    updateActiveCards();
                    if (settingsModal?.style.display === 'block') {
                        populateSettingsModal();
                    }
                });
            }
        } catch (error) { console.error("WS message error:", error, event.data); }
    };
    webSocket.onerror = (error) => console.error("WebSocket Error:", error);
    webSocket.onclose = (event) => {
        updateGlobalConnectionStatus('disconnected');
        webSocket = null;
        requestAnimationFrame(() => { updateActiveCards(); updateCharacterListConnectionIndicators(false); });
        clearTimeout(reconnectTimer);
        if (!event.wasClean || event.code === 1006) {
            console.log(`Attempting reconnect in ${RECONNECT_DELAY_MS / 1000} seconds...`);
            reconnectTimer = setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
        } else { console.log("Clean disconnect. Not attempting auto-reconnect."); }
    };
}

function updateGlobalConnectionStatus(statusClass) {
    if (!globalConnectionStatusIndicator) return;
    globalConnectionStatusIndicator.classList.remove('connected', 'disconnected', 'connecting');
    globalConnectionStatusIndicator.classList.add(statusClass);
    let titleText = 'Connection Status';
    if (statusClass === 'connected') titleText = 'Connected';
    else if (statusClass === 'disconnected') titleText = 'Disconnected - Attempting Reconnect';
    else if (statusClass === 'connecting') titleText = 'Connecting...';
    globalConnectionStatusIndicator.title = titleText;
    if (statusClass === 'disconnected' || statusClass === 'connecting') {
         updateCharacterListConnectionIndicators(false);
    }
}

function updateCharacterListConnectionIndicators(useCharacterData) {
    if (!characterListElement) return;
    Array.from(characterListElement.children).forEach(li => {
        const charName = li.dataset.charname;
        const indicator = li.querySelector('.list-char-indicator');
        if (!indicator || !charName) return;
        let isConnected = false;
        let title = 'Disconnected';
        if (useCharacterData && globalConnectionStatusIndicator.classList.contains('connected')) {
            isConnected = allCharacterData[charName]?.CONNECTED === "YES";
            title = isConnected ? 'Connected' : 'Disconnected (Character)';
        } else { title = globalConnectionStatusIndicator.classList.contains('connecting') ? 'Connecting...' : 'Disconnected (Main)'; }
        indicator.classList.toggle('connected', isConnected);
        indicator.classList.toggle('disconnected', !isConnected);
        indicator.title = title;
    });
}

function updateCharacterList() {
    if (!characterListElement) return;
    const currentServerNames = Object.keys(allCharacterData).sort();
    const serverNamesSet = new Set(currentServerNames);
    const originalSelectionLength = orderedSelectedNames.length;
    orderedSelectedNames = orderedSelectedNames.filter(name => serverNamesSet.has(name));
    if (orderedSelectedNames.length !== originalSelectionLength) { saveSelectionToLocalStorage(); }
    const currentListItemsMap = new Map(Array.from(characterListElement.children).map(li => [li.dataset.charname, li]));
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
            nameSpan.className = 'list-char-name-in-list'; nameSpan.textContent = name;
            const indicatorSpan = document.createElement('span');
            indicatorSpan.className = 'list-char-indicator disconnected';
            li.append(nameSpan, indicatorSpan);
            li.classList.toggle('selected', isSelected);
            fragmentForNewItems.appendChild(li);
        }
    });
    currentListItemsMap.forEach(staleLi => staleLi.remove());
    if (fragmentForNewItems.hasChildNodes()) {
        characterListElement.appendChild(fragmentForNewItems);
        Array.from(characterListElement.children)
             .sort((a, b) => (a.dataset.charname || '').localeCompare(b.dataset.charname || ''))
             .forEach(item => characterListElement.appendChild(item));
    }
    updateCharacterListConnectionIndicators(true);
}

function handleCharacterSelect(event) {
    const li = event.target.closest('li');
    if (!li || !characterListElement.contains(li)) return;
    const charName = li.dataset.charname;
    if (!charName) return;
    if (!allCharacterData[charName] && orderedSelectedNames.includes(charName)) {
        orderedSelectedNames = orderedSelectedNames.filter(name => name !== charName);
        li.classList.remove('selected');
    } else if (allCharacterData[charName]) {
        const index = orderedSelectedNames.indexOf(charName);
        if (index > -1) {
            orderedSelectedNames.splice(index, 1); li.classList.remove('selected');
        } else {
            if (orderedSelectedNames.length >= MAX_CARDS) {
                const oldestName = orderedSelectedNames.shift();
                const oldestLi = characterListElement.querySelector(`li[data-charname="${oldestName}"]`);
                if (oldestLi) oldestLi.classList.remove('selected');
            }
            orderedSelectedNames.push(charName); li.classList.add('selected');
        }
    }
    saveSelectionToLocalStorage();
    requestAnimationFrame(updateCardAssignments);
}

function saveSelectionToLocalStorage() {
    try { localStorage.setItem(LS_SELECTION_KEY, JSON.stringify(orderedSelectedNames)); }
    catch (e) { console.error("Failed to save selection:", e); }
}

function updateCardAssignments() {
     cardElements.forEach((card, index) => {
          const charName = orderedSelectedNames[index];
          if (charName && allCharacterData[charName]) {
              if (card.dataset.charname !== charName || card.classList.contains('hidden')) {
                 card.classList.remove('hidden');
                 updateCardData(card, charName, allCharacterData[charName]);
              }
          } else if (charName && !allCharacterData[charName]) {
                if (card.dataset.charname) clearCard(card);
                orderedSelectedNames = orderedSelectedNames.filter(name => name !== charName);
                const listItem = characterListElement.querySelector(`li[data-charname="${charName}"]`);
                if (listItem) listItem.classList.remove('selected');
                saveSelectionToLocalStorage();
          } else if (!charName && card.dataset.charname) { clearCard(card); }
     });
     for (let i = orderedSelectedNames.length; i < cardElements.length; i++) {
         if (cardElements[i].dataset.charname) clearCard(cardElements[i]);
     }
}

function updateActiveCards() {
    cardElements.forEach(card => {
         const charName = card.dataset.charname;
         if (charName) { updateCardData(card, charName, allCharacterData[charName] || null); }
    });
}

function createCardElement() {
    if (!cardTemplate) return null;
    const cardClone = cardTemplate.content.firstElementChild.cloneNode(true);
    const expandButton = cardClone.querySelector('.expand-button');
    if (expandButton) expandButton.addEventListener('click', (e) => { toggleExpand(cardClone); e.stopPropagation(); });
    cardClone._elements = {
        nameText: cardClone.querySelector('.char-name-text'),
        lagBarFg: cardClone.querySelector('.char-lag .lag-bar-fg'),
        charLagElement: cardClone.querySelector('.char-lag'),
        class: cardClone.querySelector('.char-class'),
        hpBar: cardClone.querySelector('.hp-bar'),
        hpBarFg: cardClone.querySelector('.hp-bar .bar-fg'),
        hpBarText: cardClone.querySelector('.hp-bar .bar-text'),
        hpBarLabel: cardClone.querySelector('.hp-bar .bar-label'),
        resourceBar: cardClone.querySelector('.resource-bar'),
        resourceBarFg: cardClone.querySelector('.resource-bar .bar-fg'),
        resourceBarText: cardClone.querySelector('.resource-bar .bar-text'),
        resourceBarLabel: cardClone.querySelector('.resource-bar .bar-label'),
        opponentLine: cardClone.querySelector('.opponent-line'),
        opponentNameLabel: cardClone.querySelector('.opponent-line .opponent-name-label'),
        opponentHpValue: cardClone.querySelector('.opponent-line .opponent-hp-value'),
        favorStyleLine: cardClone.querySelector('.favor-style-line'),
        stylePart: cardClone.querySelector('.style-part'),
        eqHitsPart: cardClone.querySelector('.eq-hits-part'),
        flyPart: cardClone.querySelector('.fly-part'),
        flyCheckbox: cardClone.querySelector('.fly-part input[type="checkbox"]'),
        visPart: cardClone.querySelector('.vis-part'),
        alignmentPart: cardClone.querySelector('.alignment-part'),
        favorPart: cardClone.querySelector('.favor-part'),
        customInfoItemsContainer: cardClone.querySelector('.custom-info-items-container'),
        affectsText: cardClone.querySelector('.affects-text'),
        affectsSection: cardClone.querySelector('.affects-section'),
        expandedText: cardClone.querySelector('.expanded-text'),
        expandedSection: cardClone.querySelector('.expanded-section'),
        blindnessIndicator: cardClone.querySelector('.blindness-indicator'),
        noSancIndicator: cardClone.querySelector('.no-sanc-indicator'),
        cardConnectionIndicator: cardClone.querySelector('.card-connection-indicator'),
        expandButton: expandButton,
        cardContent: cardClone.querySelector('.card-content'),
    };
    return cardClone;
}

function clearCard(cardElement) {
     if (!cardElement?._elements) return;
     const els = cardElement._elements;
     cardElement.dataset.charname = ""; cardElement.dataset.isExpanded = "false";
     cardElement.classList.add('hidden'); cardElement.classList.remove('card-offline');
     if (els.cardConnectionIndicator) {
        els.cardConnectionIndicator.classList.remove('connected', 'connecting');
        els.cardConnectionIndicator.classList.add('disconnected');
        els.cardConnectionIndicator.title = 'Connection Status';
     }
     if (els.expandButton) { els.expandButton.textContent = "+"; els.expandButton.disabled = true; }
     if (els.blindnessIndicator) els.blindnessIndicator.style.display = 'none';
     if (els.noSancIndicator) els.noSancIndicator.style.display = 'none';
     if (els.nameText) els.nameText.textContent = "Character Name";
     if (els.charLagElement) {
        if (SHOW_LAG_INDICATOR) {
            els.charLagElement.style.display = 'inline-block';
            if (els.lagBarFg) els.lagBarFg.style.width = '0%';
            els.charLagElement.title = "Lag Status";
            els.charLagElement.classList.remove('lag-ok', 'lag-high', 'lag-critical');
        } else els.charLagElement.style.display = 'none';
     }
     if (els.class) els.class.textContent = "Class";
     if (els.hpBar) updateBar(els.hpBarFg, els.hpBarText, 0, 1, 'HP', els.hpBar, els.hpBarLabel);
     if (els.resourceBar) updateBar(els.resourceBarFg, els.resourceBarText, 0, 1, 'Mana', els.resourceBar, els.resourceBarLabel);
     if (els.opponentLine) els.opponentLine.style.display = 'none';
     if (els.opponentNameLabel) els.opponentNameLabel.textContent = "Opponent:";
     if (els.opponentHpValue) els.opponentHpValue.textContent = "N/A";
     if(els.favorStyleLine) els.favorStyleLine.style.display = 'none';
     if(els.stylePart) { els.stylePart.textContent = "Style: N/A"; els.stylePart.style.display = 'none'; }
     if(els.eqHitsPart) { els.eqHitsPart.textContent = "EQ Hits: N/A"; els.eqHitsPart.style.display = 'none'; }
     if(els.flyPart) { els.flyPart.style.display = 'none'; if (els.flyCheckbox) els.flyCheckbox.checked = false; }
     if(els.visPart) { els.visPart.textContent = "Vis: N/A"; els.visPart.style.display = 'none'; }
     if(els.alignmentPart) { els.alignmentPart.textContent = "Align: N/A"; els.alignmentPart.style.display = 'none'; }
     if(els.favorPart) { els.favorPart.textContent = "Favor: N/A"; els.favorPart.style.display = 'none'; }
     if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = '';
     if (els.affectsSection) els.affectsSection.style.display = 'none';
     if (els.affectsText) els.affectsText.textContent = "";
     if (els.expandedSection) els.expandedSection.style.display = 'none';
     if (els.expandedText) els.expandedText.textContent = "";
}

function updateCardData(cardElement, charName, data) {
  const els = cardElement._elements;
  if (!els) return;
  const isGloballyConnected = globalConnectionStatusIndicator.classList.contains('connected');
  const isExpanded = cardElement.dataset.isExpanded === 'true';

  if (isGloballyConnected && !data) {
      clearCard(cardElement);
      if (orderedSelectedNames.includes(charName)) {
          orderedSelectedNames = orderedSelectedNames.filter(name => name !== charName);
          const listItem = characterListElement.querySelector(`li[data-charname="${charName}"]`);
          if (listItem) listItem.classList.remove('selected');
          saveSelectionToLocalStorage();
      }
      return;
  }
  cardElement.dataset.charname = charName;

  if (!isGloballyConnected) {
      cardElement.classList.add('card-offline');
      if(els.cardConnectionIndicator) {
        els.cardConnectionIndicator.classList.remove('connected', 'connecting');
        els.cardConnectionIndicator.classList.add('disconnected');
        els.cardConnectionIndicator.title = globalConnectionStatusIndicator.classList.contains('connecting') ? 'Connecting...' : 'Disconnected (Main)';
      }
      if(els.expandButton) { els.expandButton.disabled = true; els.expandButton.textContent = "+"; }
      if(els.nameText) els.nameText.textContent = `${data?.CHARACTER_NAME || charName} (Offline)`;
      if (els.charLagElement) {
        if (SHOW_LAG_INDICATOR) {
            els.charLagElement.style.display = 'inline-block';
            if(els.lagBarFg) els.lagBarFg.style.width = '0%';
            els.charLagElement.title = "Lag: Offline";
            els.charLagElement.classList.remove('lag-ok', 'lag-high', 'lag-critical');
        } else els.charLagElement.style.display = 'none';
      }
      if(els.class) els.class.textContent = data?.CLASS || "N/A";
      if(els.hpBar) updateBar(els.hpBarFg, els.hpBarText, parseInt(data?.HEALTH || 0), Math.max(1, parseInt(data?.HEALTH_MAX || 1)), 'HP', els.hpBar, els.hpBarLabel);
      if(els.resourceBar) {
        if (data && VAMPIRE_CLASSES.has(data.CLASS || "")) {
            updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.BLOOD || 0), BLOOD_MAX, 'Blood', els.resourceBar, els.resourceBarLabel);
        } else {
            updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data?.MANA || 0), Math.max(1, parseInt(data?.MANA_MAX || 1)), 'Mana', els.resourceBar, els.resourceBarLabel);
        }
      }
      if(els.opponentLine) els.opponentLine.style.display = 'none';
      if(els.favorStyleLine) els.favorStyleLine.style.display = 'none';
      if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = '';
      if(els.affectsSection) els.affectsSection.style.display = 'none';
      if(els.blindnessIndicator) els.blindnessIndicator.style.display = 'none';
      if(els.noSancIndicator) els.noSancIndicator.style.display = 'none';
      if(els.expandedSection) { els.expandedSection.style.display = 'none'; if(els.expandedText) els.expandedText.textContent = '';}
      if (isExpanded) cardElement.dataset.isExpanded = "false";
      return;
  }
  cardElement.classList.remove('card-offline');
  if(els.expandButton) els.expandButton.disabled = false;
  const isCharConnected = (data.CONNECTED === "YES");
  if(els.cardConnectionIndicator) {
    els.cardConnectionIndicator.classList.remove('disconnected', 'connecting');
    els.cardConnectionIndicator.classList.toggle('connected', isCharConnected);
    els.cardConnectionIndicator.classList.toggle('disconnected', !isCharConnected);
    els.cardConnectionIndicator.title = isCharConnected ? 'Connected' : 'Disconnected (Character)';
  }
  if(els.nameText) els.nameText.textContent = data.CHARACTER_NAME || charName;
  if (els.charLagElement && els.lagBarFg) {
    if (SHOW_LAG_INDICATOR) {
        els.charLagElement.style.display = 'inline-block';
        els.charLagElement.classList.remove('lag-ok', 'lag-high', 'lag-critical');
        const lagValue = data.WAIT_TIME ?? "";
        let lagPercentage = 0, lagTitle = "Lag: Unknown";
        if (lagValue === "!!!!!") { lagPercentage = 100; lagTitle = "Lag: Critical (!!!!!)"; els.charLagElement.classList.add('lag-critical');}
        else {
            const pipeCount = (String(lagValue).match(/\|/g) || []).length;
            if (pipeCount === 0) { lagPercentage = 0; lagTitle = "Lag: OK (0)"; }
            else if (pipeCount <= 3) { lagPercentage = pipeCount * 20; lagTitle = `Lag: OK (${pipeCount})`; els.charLagElement.classList.add('lag-ok');}
            else { lagPercentage = (pipeCount === 4 ? 80 : 100) ; lagTitle = `Lag: High (${pipeCount})`; els.charLagElement.classList.add('lag-high');}
        }
        els.lagBarFg.style.width = `${lagPercentage}%`; els.charLagElement.title = lagTitle;
    } else els.charLagElement.style.display = 'none';
  }
  const charClass = data.CLASS || "N/A";
  if(els.class) els.class.textContent = charClass;
  if(els.hpBar) updateBar(els.hpBarFg, els.hpBarText, parseInt(data.HEALTH || 0), Math.max(1, parseInt(data.HEALTH_MAX || 1)), 'HP', els.hpBar, els.hpBarLabel);
  if(els.resourceBar) {
    if (VAMPIRE_CLASSES.has(charClass)) {
         updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.BLOOD || 0), BLOOD_MAX, 'Blood', els.resourceBar, els.resourceBarLabel);
    } else {
         updateBar(els.resourceBarFg, els.resourceBarText, parseInt(data.MANA || 0), Math.max(1, parseInt(data.MANA_MAX || 1)), 'Mana', els.resourceBar, els.resourceBarLabel);
    }
  }
  const oppNameRaw = data.OPPONENT_NAME;
  const oppNameIsValid = typeof oppNameRaw === 'string' && oppNameRaw !== "";
  const isVisuallyBlind = (oppNameRaw === 'You cannot see your opponent.');
  if (els.opponentLine && els.opponentNameLabel && els.opponentHpValue) {
      if (oppNameIsValid) {
           els.opponentLine.style.display = 'flex';
           let displayName = oppNameRaw;
           if (displayName.length > MAX_OPPONENT_NAME_LENGTH) displayName = displayName.substring(0, MAX_OPPONENT_NAME_LENGTH) + "...";
           els.opponentNameLabel.textContent = `${displayName}:`;
           els.opponentNameLabel.title = (oppNameRaw.length > MAX_OPPONENT_NAME_LENGTH) ? oppNameRaw : displayName;
           const oppHp = data.OPPONENT_HEALTH;
           els.opponentHpValue.textContent = (oppHp != null && oppHp !== "N/A") ? `${oppHp}%` : "N/A";
      } else {
           els.opponentLine.style.display = 'none';
           els.opponentNameLabel.textContent = "Opponent:"; els.opponentHpValue.textContent = "N/A";
      }
  }
  let favorStyleLineVisible = false;
  if (els.customInfoItemsContainer) els.customInfoItemsContainer.innerHTML = '';
  if (els.stylePart) els.stylePart.style.display = 'none';
  if (els.eqHitsPart) els.eqHitsPart.style.display = 'none';
  if (els.flyPart) els.flyPart.style.display = 'none';
  if (els.visPart) els.visPart.style.display = 'none';
  if (els.alignmentPart) els.alignmentPart.style.display = 'none';
  if (els.favorPart) els.favorPart.style.display = 'none';

  activeInfoBarItems.forEach(itemKey => {
    let value, isValid = false, handledAsPredefined = false;
    const upperKey = itemKey.toUpperCase();
    switch (upperKey) {
        case "STYLE":
            value = data.STYLE ?? data.COMBAT_STYLE; isValid = (value != null && value !== "");
            if (isValid && els.stylePart) { els.stylePart.textContent = `Style: ${value}`; els.stylePart.style.display = 'inline'; favorStyleLineVisible = true; }
            handledAsPredefined = true; break;
        case "EQUIP_HITS":
            value = data.EQUIP_HITS; isValid = (value != null && value !== "");
            if (isValid && els.eqHitsPart) { els.eqHitsPart.textContent = `EQ Hits: ${value}`; els.eqHitsPart.style.display = 'inline'; favorStyleLineVisible = true; }
            handledAsPredefined = true; break;
        case "FLYING":
            isValid = data.hasOwnProperty('FLYING');
            if (isValid && els.flyPart) {
                els.flyPart.style.display = 'inline-flex';
                if (els.flyCheckbox) els.flyCheckbox.checked = (data.FLYING === 'Y');
                favorStyleLineVisible = true;
            } else if (els.flyCheckbox) els.flyCheckbox.checked = false;
            handledAsPredefined = true; break;
        case "VIS":
            isValid = data.hasOwnProperty('VIS');
            if (isValid && els.visPart) { value = data.VIS; els.visPart.textContent = `Vis: ${(value == null) ? "(None)" : value}`; els.visPart.style.display = 'inline'; favorStyleLineVisible = true; }
            handledAsPredefined = true; break;
        case "ALIGNMENT":
            value = data.ALIGNMENT; isValid = (value != null && value !== "");
            if (isValid && els.alignmentPart) { els.alignmentPart.textContent = `Align: ${value}`; els.alignmentPart.style.display = 'inline'; favorStyleLineVisible = true; }
            handledAsPredefined = true; break;
        case "FAVOR":
            value = data.FAVOR; isValid = (value != null && value !== "N/A");
            if (isValid && els.favorPart) { els.favorPart.textContent = `Favor: ${value}`; els.favorPart.style.display = 'inline'; favorStyleLineVisible = true; }
            handledAsPredefined = true; break;
    }
    if (!handledAsPredefined && data.hasOwnProperty(itemKey) && els.customInfoItemsContainer) {
        value = data[itemKey]; isValid = (value != null);
        if (isValid) {
            const customSpan = document.createElement('span');
            customSpan.className = 'info-bar-custom-item';
            const strongLabel = document.createElement('strong');
            strongLabel.textContent = `${itemKey.replace(/_/g, ' ').replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase())}: `;
            customSpan.appendChild(strongLabel);
            customSpan.appendChild(document.createTextNode(String(value)));
            els.customInfoItemsContainer.appendChild(customSpan);
            favorStyleLineVisible = true;
        }
    }
  });
  if (els.favorStyleLine) els.favorStyleLine.style.display = favorStyleLineVisible ? 'flex' : 'none';
  const { affectsStr, hasSanctuary } = parseAffects(data.AFFECTS);
  if (els.affectsSection && els.affectsText) {
      if (affectsStr) { els.affectsText.textContent = affectsStr; els.affectsSection.style.display = 'block';
      } else { els.affectsSection.style.display = 'none'; els.affectsText.textContent = ''; }
  }
  if(els.blindnessIndicator) els.blindnessIndicator.style.display = (SHOW_BLINDNESS_INDICATOR && isVisuallyBlind) ? 'inline-block' : 'none';
  if(els.noSancIndicator) els.noSancIndicator.style.display = (SHOW_NO_SANC_INDICATOR && !hasSanctuary && affectsStr) ? 'inline-block' : 'none';
  if(els.expandButton) els.expandButton.textContent = isExpanded ? "-" : "+";
  if (els.expandedSection && els.expandedText) {
      if (isExpanded) { els.expandedText.textContent = formatFullData(data); els.expandedSection.style.display = 'block';
      } else { els.expandedSection.style.display = 'none'; }
  }
}

function updateBar(barFgElement, textElement, current, max, type, barElement = null, labelElement = null) {
     current = parseInt(current) || 0; max = parseInt(max) || 1; if (max <= 0) max = 1;
     const percentage = Math.min(100, Math.max(0, (current / max) * 100));
     if (barFgElement) barFgElement.style.width = `${percentage}%`;
     if (textElement) textElement.textContent = `${current} / ${max > 999999 ? 'lots' : max}`;
     if (labelElement) labelElement.textContent = `${type}:`;
     if (barElement) {
         barElement.classList.remove('mana-bar', 'blood-bar');
         if (type === 'Mana') barElement.classList.add('mana-bar');
         else if (type === 'Blood') barElement.classList.add('blood-bar');
     }
}

function parseAffects(affectsData) {
    let parsedAffects = [], affectsStr = "", hasSanctuary = false, couldParse = false;
    if (typeof affectsData === 'object' && affectsData !== null) {
        Object.entries(affectsData).forEach(([key, value]) => parsedAffects.push({ name: key, value: String(value) }));
        if (parsedAffects.length > 0) couldParse = true;
    } else if (typeof affectsData === 'string') {
        if (affectsData.startsWith('{') && affectsData.includes('}{')) {
            const pairs = affectsData.match(/\{([^}]+?)\}\{([^}]*?)\}/g) || [];
            pairs.forEach(pair => { const match = pair.match(/\{([^}]+?)\}\{([^}]*?)\}/); if (match?.[1]) parsedAffects.push({ name: match[1].trim(), value: match[2].trim() }); });
            if (parsedAffects.length > 0) couldParse = true;
        }
        if (!couldParse && affectsData.trim()) affectsStr = affectsData;
    }
    if (couldParse) {
        parsedAffects.sort((a, b) => {
            const order = Array.from(SANCTUARY_AFFECTS);
            const indexA = order.indexOf(a.name.toLowerCase());
            const indexB = order.indexOf(b.name.toLowerCase());
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            if (indexA !== -1) return -1; if (indexB !== -1) return 1;
            return a.name.localeCompare(b.name);
        });
        affectsStr = parsedAffects.map(item => `${item.name}${(item.value && item.value !== "0") ? (': ' + item.value) : ''}`).join('\n');
    }
    const checkStrLower = (affectsStr || "").toLowerCase();
    hasSanctuary = Array.from(SANCTUARY_AFFECTS).some(sanc => checkStrLower.includes(sanc));
    if (!hasSanctuary && couldParse) {
        const affectNamesLower = new Set(parsedAffects.map(a => a.name.toLowerCase()));
        hasSanctuary = Array.from(SANCTUARY_AFFECTS).some(sanc => affectNamesLower.has(sanc));
    }
    return { affectsStr: affectsStr || "", hasSanctuary };
}

function formatFullData(data) {
     try {
         if (!data) return "No data available.";
         const basePreferredOrder = [
            'CHARACTER_NAME', 'CLASS', 'RACE', 'LEVEL', 'ALIGNMENT',
            'HEALTH', 'HEALTH_MAX', 'MANA', 'MANA_MAX', 'BLOOD',
            'OPPONENT_NAME', 'OPPONENT_HEALTH',
            'AFFECTS', 'WAIT_TIME',
            'ROOM_NAME', 'ROOM_EXITS', 'ROOM_VNUM',
            'CONNECTED', 'LAST_UPDATE'
         ];
         const preferredOrder = [...basePreferredOrder];
         activeInfoBarItems.forEach(itemKey => {
            const upperItemKey = itemKey.toUpperCase();
            if (!preferredOrder.some(pKey => pKey.toUpperCase() === upperItemKey)) {
                 const bloodIndex = preferredOrder.indexOf('BLOOD');
                 if (bloodIndex !== -1) preferredOrder.splice(bloodIndex + 1, 0, itemKey);
                 else preferredOrder.splice(5, 0, itemKey);
            }
         });
         const displayItems = []; const handledKeys = new Set();
         const altKeysMap = { 'LAG': 'WAIT_TIME', 'COMBAT_STYLE': 'STYLE' };
         const processValue = (key, value) => {
            if (key === 'ROOM_EXITS') {
                if (typeof value === 'string') return (value.match(/[a-z]+/g) || []).join(', ') || "(None)";
                if (typeof value === 'object' && value !== null) return Object.keys(value).filter(dir => value[dir] != null).join(', ') || "(None)";
            }
            if (key === 'AFFECTS' && typeof value === 'object' && value !== null) return parseAffects(value).affectsStr || "(None)";
            if (value === null || value === undefined) return "(Not Set)";
            if (value === "") return "(Empty)";
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
         };
         preferredOrder.forEach(prefKey => {
            let dataKey = prefKey;
            if (!data.hasOwnProperty(prefKey) && altKeysMap[prefKey.toUpperCase()] && data.hasOwnProperty(altKeysMap[prefKey.toUpperCase()])) {
                dataKey = altKeysMap[prefKey.toUpperCase()];
            }
            if (data.hasOwnProperty(dataKey) && !handledKeys.has(dataKey)) {
                displayItems.push({ key: prefKey, value: processValue(dataKey, data[dataKey]) });
                handledKeys.add(dataKey); if (prefKey !== dataKey) handledKeys.add(prefKey);
            }
         });
         Object.keys(data).sort().forEach(key => {
            if (!handledKeys.has(key)) {
                displayItems.push({ key: key, value: processValue(key, data[key]) });
                handledKeys.add(key);
            }
         });
         return displayItems.length > 0 ? displayItems.map(item => `${item.key}: ${item.value}`).join('\n').trim() : "No data fields available.";
     } catch (error) {
         console.error("Error formatting full data:", error, data);
         try { return JSON.stringify(data, null, 2) || "Error displaying data."; }
         catch { return "Error displaying data (failed to stringify)." }
     }
}

function toggleExpand(cardElement) {
    if (!cardElement?._elements?.expandButton || cardElement._elements.expandButton.disabled) return;
    const isExpanded = cardElement.dataset.isExpanded === 'true';
    cardElement.dataset.isExpanded = (!isExpanded).toString();
    const charName = cardElement.dataset.charname;
    const data = charName ? (allCharacterData[charName] || null) : null;
    if (globalConnectionStatusIndicator.classList.contains('connected') && data) {
         updateCardData(cardElement, charName, data);
    } else {
        const els = cardElement._elements;
        if(els.expandButton) els.expandButton.textContent = !isExpanded ? "-" : "+";
        if(els.expandedSection) els.expandedSection.style.display = !isExpanded ? 'block' : 'none';
        if (!isExpanded && els.expandedText) els.expandedText.textContent = formatFullData(data);
    }
    if (!isExpanded && cardElement._elements.cardContent) {
         setTimeout(() => cardElement._elements.cardContent.scrollTo(0,0), 0);
     }
}

function applyTheme(theme) {
    document.body.classList.toggle('dark-mode', theme === 'dark');
    if (themeToggleModalButton) {
      if (theme === 'dark') {
        themeToggleModalButton.textContent = 'Toggle Light Mode';
        themeToggleModalButton.title = 'Switch to Light Theme';
      } else {
        themeToggleModalButton.textContent = 'Toggle Dark Mode';
        themeToggleModalButton.title = 'Switch to Dark Theme';
      }
    }
}

function toggleTheme() {
    const newTheme = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
    applyTheme(newTheme);
    try { localStorage.setItem(LS_THEME_KEY, newTheme); }
    catch (e) { console.error("Failed to save theme:", e); }
}

document.addEventListener('DOMContentLoaded', () => {
    characterListElement = document.getElementById('character-list');
    cardGridElement = document.getElementById('card-grid');
    cardTemplate = document.getElementById('card-template');
    globalConnectionStatusIndicator = document.getElementById('connection-status-indicator');
    listPanelElement = document.querySelector('.list-panel');
    listPanelHeader = document.getElementById('list-panel-header');
    collapseToggle = document.getElementById('collapse-toggle');
    settingsToggleButton = document.getElementById('settings-toggle');
    settingsModal = document.getElementById('settings-modal');
    infoBarKeysListElement = document.getElementById('info-bar-keys-list');
    themeToggleModalButton = document.getElementById('theme-toggle-modal-button');

    initializeCssAndJsConfigs();
    loadInfoBarSettings();

    let preferredTheme = 'light';
    try {
        const savedTheme = localStorage.getItem(LS_THEME_KEY);
        if (savedTheme) preferredTheme = savedTheme;
        else if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) preferredTheme = 'dark';
    } catch (e) { console.error("Failed to load theme from LS:", e); }
    applyTheme(preferredTheme);
    if (themeToggleModalButton) themeToggleModalButton.addEventListener('click', toggleTheme);

    if (listPanelElement && collapseToggle && listPanelHeader) {
        try {
            const isCollapsed = localStorage.getItem(LS_COLLAPSE_KEY) === 'true';
            listPanelElement.classList.toggle('collapsed', isCollapsed);
            if(collapseToggle) {
              collapseToggle.textContent = isCollapsed ? '▶' : '▼';
              collapseToggle.title = isCollapsed ? 'Expand List' : 'Collapse List';
            }
        } catch (e) { console.error("Failed to load collapse state:", e); }
        listPanelHeader.addEventListener('click', (event) => {
            if (event.target === globalConnectionStatusIndicator ||
                event.target === collapseToggle ||
                globalConnectionStatusIndicator?.contains(event.target) ||
                collapseToggle?.contains(event.target)
                ) return;
            const isCollapsed = listPanelElement.classList.toggle('collapsed');
            if(collapseToggle) {
              collapseToggle.textContent = isCollapsed ? '▶' : '▼';
              collapseToggle.title = isCollapsed ? 'Expand List' : 'Collapse List';
            }
            try { localStorage.setItem(LS_COLLAPSE_KEY, isCollapsed.toString()); }
            catch (e) { console.error("Failed to save collapse state:", e); }
        });
    }

    if (settingsToggleButton) {
        settingsToggleButton.addEventListener('click', () => {
            if (settingsModal && settingsModal.style.display === 'block') {
                closeSettingsModal();
            } else {
                openSettingsModal();
            }
        });
    }

    window.addEventListener('click', (event) => {
        if (settingsModal && event.target === settingsModal) {
             closeSettingsModal();
        }
    });
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && settingsModal?.style.display === 'block') {
            closeSettingsModal();
        }
    });

    try {
        const savedSelection = JSON.parse(localStorage.getItem(LS_SELECTION_KEY) || "[]");
        if (Array.isArray(savedSelection)) {
            orderedSelectedNames = savedSelection.filter(s => typeof s === 'string').slice(0, MAX_CARDS);
        }
    } catch (e) { console.error("Failed to load selection:", e); }

    if(cardGridElement && cardTemplate){
        for (let i = 0; i < MAX_CARDS; i++) {
            const newCard = createCardElement();
            if (newCard) { cardElements.push(newCard); cardGridElement.appendChild(newCard); clearCard(newCard); }
        }
    }
    updateCardAssignments();
    if (characterListElement) characterListElement.addEventListener('click', handleCharacterSelect);
    connectWebSocket();
});