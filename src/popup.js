// Vaal Trade Assistant - Popup Script
import { get_status, set_status } from "./modules/storage_utils.js";

let setting_ids = ["trade-type", "trade-league", "similar-percent", "price-min", "price-max"];

// Translations cache
let currentLanguage = "en";
let translations = {};

// ==================== TRANSLATIONS ====================

async function loadTranslations(lang) {
    try {
        const response = await fetch(`../_locales/${lang}/messages.json`);
        if (response.ok) {
            translations = await response.json();
            currentLanguage = lang;
            return true;
        }
    } catch (e) {
        console.error("Failed to load translations for", lang, e);
    }
    return false;
}

function t(key, replacements = {}) {
    const msg = translations[key]?.message || key;
    let result = msg;
    for (const [k, v] of Object.entries(replacements)) {
        result = result.replace(`{${k}}`, v);
    }
    return result;
}

function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        if (translations[key]) {
            el.textContent = translations[key].message;
        }
    });
    
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (translations[key]) {
            el.placeholder = translations[key].message;
        }
    });
}

async function changeLanguage(lang) {
    const loaded = await loadTranslations(lang);
    if (loaded) {
        await chrome.storage.local.set({ "ui-language": lang });
        applyTranslations();
    }
}

// ==================== TABS ====================

function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active from all
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            // Activate clicked tab
            tab.classList.add('active');
            const tabId = tab.getAttribute('data-tab');
            document.getElementById(`tab-${tabId}`).classList.add('active');
            
            // Load data for specific tabs
            if (tabId === 'history') loadHistory();
            if (tabId === 'stats') loadStats();
        });
    });
}

// ==================== HISTORY ====================

const MAX_HISTORY_ITEMS = 20;

async function loadHistory() {
    const data = await chrome.storage.local.get(['search-history']);
    const history = data['search-history'] || [];
    const container = document.getElementById('history-list');
    
    if (history.length === 0) {
        container.innerHTML = `<div class="empty-state" data-i18n="empty_history">${t('empty_history')}</div>`;
        return;
    }
    
    container.innerHTML = history.map((item, idx) => `
        <div class="history-item" data-index="${idx}">
            <span class="history-item-type ${item.type}">${item.type}</span>
            <span class="history-item-name" title="${item.name}">${item.name}</span>
            <span class="history-item-time">${formatTimeAgo(item.timestamp)}</span>
        </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.history-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.getAttribute('data-index'));
            repeatSearch(history[idx]);
        });
    });
}

async function addToHistory(item) {
    const data = await chrome.storage.local.get(['search-history']);
    let history = data['search-history'] || [];
    
    // Add new item at the beginning
    history.unshift({
        name: item.name,
        type: item.type,
        query: item.query,
        league: item.league,
        timestamp: Date.now()
    });
    
    // Keep only last MAX_HISTORY_ITEMS
    history = history.slice(0, MAX_HISTORY_ITEMS);
    
    await chrome.storage.local.set({ 'search-history': history });
    
    // Update stats
    await incrementSearchCount(item.name);
}

async function clearHistory() {
    await chrome.storage.local.set({ 'search-history': [] });
    loadHistory();
}

function repeatSearch(item) {
    // If we have the trade URL saved, open it directly
    if (item.tradeUrl) {
        window.open(item.tradeUrl, '_blank');
    } else {
        // Fallback: Send message to background to repeat search (for old history items)
        chrome.runtime.sendMessage({
            action: 'repeatSearch',
            query: item.query,
            league: item.league,
            name: item.name
        });
    }
}

function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

// ==================== STATISTICS ====================

async function loadStats() {
    const data = await chrome.storage.local.get(['stats', 'search-cache']);
    const stats = data['stats'] || { searches: 0, items: 0, timeSaved: 0, itemCounts: {} };
    const cache = data['search-cache'] || {};
    
    // Update stat cards
    document.getElementById('stat-searches').textContent = stats.searches || 0;
    document.getElementById('stat-items').textContent = stats.items || 0;
    document.getElementById('stat-time').textContent = formatTimeSaved(stats.timeSaved || 0);
    
    // Cache count
    const cacheCount = Object.keys(cache).length;
    document.getElementById('cache-count').textContent = `${cacheCount} ${t('items_cached')}`;
    
    // Most searched items
    const mostSearched = Object.entries(stats.itemCounts || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    
    const listContainer = document.getElementById('most-searched-list');
    if (mostSearched.length === 0) {
        listContainer.innerHTML = `<div class="empty-state" data-i18n="empty_stats">${t('empty_stats')}</div>`;
    } else {
        listContainer.innerHTML = mostSearched.map(([name, count]) => `
            <div class="history-item">
                <span class="history-item-name">${name}</span>
                <span class="history-item-time">${count}x</span>
            </div>
        `).join('');
    }
}

async function incrementSearchCount(itemName) {
    const data = await chrome.storage.local.get(['stats']);
    const stats = data['stats'] || { searches: 0, items: 0, timeSaved: 0, itemCounts: {} };
    
    stats.searches = (stats.searches || 0) + 1;
    stats.items = (stats.items || 0) + 1;
    stats.timeSaved = (stats.timeSaved || 0) + 15; // Estimate 15 seconds saved per search
    
    // Track item counts
    if (!stats.itemCounts) stats.itemCounts = {};
    stats.itemCounts[itemName] = (stats.itemCounts[itemName] || 0) + 1;
    
    await chrome.storage.local.set({ 'stats': stats });
}

async function resetStats() {
    await chrome.storage.local.set({ 
        'stats': { searches: 0, items: 0, timeSaved: 0, itemCounts: {} }
    });
    loadStats();
}

function formatTimeSaved(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

// ==================== CACHE ====================

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCachedResult(queryHash) {
    const data = await chrome.storage.local.get(['search-cache']);
    const cache = data['search-cache'] || {};
    
    const cached = cache[queryHash];
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        return cached.result;
    }
    
    return null;
}

async function setCachedResult(queryHash, result) {
    const data = await chrome.storage.local.get(['search-cache']);
    const cache = data['search-cache'] || {};
    
    // Clean old entries
    const now = Date.now();
    for (const key of Object.keys(cache)) {
        if (now - cache[key].timestamp > CACHE_DURATION) {
            delete cache[key];
        }
    }
    
    cache[queryHash] = {
        result: result,
        timestamp: now
    };
    
    await chrome.storage.local.set({ 'search-cache': cache });
}

async function clearCache() {
    await chrome.storage.local.set({ 'search-cache': {} });
    loadStats();
}

// ==================== NOTIFICATIONS ====================

async function loadNotificationSettings() {
    const data = await chrome.storage.local.get(['enable-price-alert', 'enable-sound', 'price-threshold']);
    
    document.getElementById('enable-price-alert').checked = data['enable-price-alert'] || false;
    document.getElementById('enable-sound').checked = data['enable-sound'] || false;
    
    const threshold = data['price-threshold'] || 30;
    document.getElementById('price-threshold').value = threshold;
    document.getElementById('price-threshold-value').textContent = threshold;
}

async function saveNotificationSettings() {
    await chrome.storage.local.set({
        'enable-price-alert': document.getElementById('enable-price-alert').checked,
        'enable-sound': document.getElementById('enable-sound').checked,
        'price-threshold': parseInt(document.getElementById('price-threshold').value)
    });
}

// ==================== CORE FUNCTIONS ====================

function refresh_page() {
    chrome.tabs.query({ active: true, currentWindow: true, url: "*://*.poe.ninja/*" }, function (tabs) {
        if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { url: tabs[0].url });
    });
}

async function checkConnectionStatus() {
    const dot = document.getElementById("connection-dot");
    const text = document.getElementById("connection-text");
    
    dot.className = "connection-dot checking";
    text.textContent = t("status_checking");
    
    try {
        const storage = await chrome.storage.local.get(["poe2-sessid"]);
        const sessid = storage["poe2-sessid"];
        
        if (!sessid) {
            dot.className = "connection-dot disconnected";
            text.textContent = t("status_no_sessid");
            return false;
        }
        
        const response = await fetch("https://www.pathofexile.com/api/trade2/search/poe2/Standard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: { status: { option: "online" }, type: "Sapphire Ring" },
                sort: { price: "asc" }
            })
        });
        
        if (response.ok) {
            dot.className = "connection-dot connected";
            text.textContent = t("status_connected");
            return true;
        } else if (response.status === 401 || response.status === 403) {
            dot.className = "connection-dot disconnected";
            text.textContent = t("status_expired");
            return false;
        } else {
            dot.className = "connection-dot connected";
            text.textContent = t("status_rate_limited");
            return true;
        }
    } catch (error) {
        console.error("Connection check error:", error);
        dot.className = "connection-dot disconnected";
        text.textContent = t("status_cannot_reach");
        return false;
    }
}

async function on_change_event() {
    let priceChanged = false;
    
    for (var id of setting_ids) {
        const element = document.getElementById(id);
        if (!element) continue;
        
        const currentValue = element.value;
        const storedValue = await get_status(id);
        
        if (storedValue !== currentValue) {
            await set_status(id, currentValue);
            if (id === "trade-type" || id === "trade-league") {
                refresh_page();
            }
            if (id === "price-min" || id === "price-max") {
                priceChanged = true;
            }
        }
    }
    
    if (priceChanged) {
        const priceStatus = document.getElementById("price-status");
        const priceMin = document.getElementById("price-min").value;
        const priceMax = document.getElementById("price-max").value;
        
        if (priceMin || priceMax) {
            const minText = priceMin ? `${priceMin}` : "0";
            const maxText = priceMax ? `${priceMax}` : "∞";
            priceStatus.textContent = t("status_filter_saved", { min: minText, max: maxText });
            priceStatus.className = "status-msg status-success";
        } else {
            priceStatus.textContent = t("status_filter_cleared");
            priceStatus.className = "status-msg status-success";
        }
        
        setTimeout(() => { priceStatus.textContent = ""; }, 3000);
    }
    
    update_select_elements();
}

async function update_select_elements() {
    const statuses = await chrome.storage.local.get(setting_ids);
    
    document.getElementById("trade-type").value = statuses["trade-type"] || "available";
    document.getElementById("trade-league").value = statuses["trade-league"] || "auto";
    
    const similarPercent = statuses["similar-percent"] || "80";
    document.getElementById("similar-percent").value = similarPercent;
    document.getElementById("similar-percent-value").textContent = similarPercent;
    
    const priceMinEl = document.getElementById("price-min");
    const priceMaxEl = document.getElementById("price-max");
    
    if (document.activeElement !== priceMinEl) {
        priceMinEl.value = statuses["price-min"] || "";
    }
    if (document.activeElement !== priceMaxEl) {
        priceMaxEl.value = statuses["price-max"] || "";
    }
    
    await update_sessid_display();
}

async function update_sessid_display() {
    const sessidData = await chrome.storage.local.get(["poe2-sessid"]);
    const sessidInput = document.getElementById("poe2-sessid");
    const sessidStatus = document.getElementById("sessid-status");
    
    if (sessidData["poe2-sessid"]) {
        const sessid = sessidData["poe2-sessid"];
        sessidInput.value = sessid.substring(0, 8) + "..." + sessid.substring(sessid.length - 4);
        sessidInput.dataset.fullValue = sessid;
        sessidStatus.textContent = t("status_sessid_configured");
        sessidStatus.className = "status-msg status-success";
    } else {
        sessidInput.value = "";
        sessidInput.dataset.fullValue = "";
        sessidStatus.textContent = t("status_sessid_not_configured");
        sessidStatus.className = "status-msg status-error";
    }
}

async function get_poesessid_from_cookies() {
    const sessidStatus = document.getElementById("sessid-status");
    sessidStatus.textContent = t("status_fetching");
    sessidStatus.className = "status-msg";
    
    try {
        const cookie = await chrome.cookies.get({
            url: "https://www.pathofexile.com",
            name: "POESESSID"
        });
        
        if (cookie && cookie.value) {
            document.getElementById("poe2-sessid").value = cookie.value;
            document.getElementById("poe2-sessid").dataset.fullValue = cookie.value;
            sessidStatus.textContent = t("status_cookie_found");
            sessidStatus.className = "status-msg status-success";
        } else {
            sessidStatus.textContent = t("status_cookie_not_found");
            sessidStatus.className = "status-msg";
            
            chrome.tabs.create({ url: "https://www.pathofexile.com/trade2/search/poe2" }, async (tab) => {
                setTimeout(async () => {
                    const retryStatus = document.getElementById("sessid-status");
                    if (retryStatus) {
                        retryStatus.textContent = t("status_please_login");
                        retryStatus.className = "status-msg";
                    }
                }, 2000);
            });
        }
    } catch (error) {
        console.error("Error getting POESESSID:", error);
        sessidStatus.textContent = "Error: " + error.message;
        sessidStatus.className = "status-msg status-error";
    }
}

async function save_poesessid() {
    const sessidInput = document.getElementById("poe2-sessid");
    const sessidStatus = document.getElementById("sessid-status");
    
    const sessid = sessidInput.dataset.fullValue || sessidInput.value.trim();
    
    if (!sessid || sessid.includes("...")) {
        sessidStatus.textContent = t("status_enter_valid_sessid");
        sessidStatus.className = "status-msg status-error";
        return;
    }
    
    try {
        await chrome.storage.local.set({ "poe2-sessid": sessid });
        sessidStatus.textContent = t("status_sessid_saved");
        sessidStatus.className = "status-msg status-success";
        await update_sessid_display();
        refresh_page();
    } catch (error) {
        console.error("Error saving POESESSID:", error);
        sessidStatus.textContent = "Error saving: " + error.message;
        sessidStatus.className = "status-msg status-error";
    }
}

// ==================== INITIALIZATION ====================

async function init() {
    // Load language
    const langStorage = await chrome.storage.local.get(["ui-language"]);
    const savedLang = langStorage["ui-language"] || "en";
    await loadTranslations(savedLang);
    document.getElementById("ui-language").value = savedLang;
    applyTranslations();
    
    // Initialize tabs
    initTabs();
    
    // Load notification settings
    await loadNotificationSettings();
    
    document.getElementById("version").innerText = "v" + chrome.runtime.getManifest().version;
    await update_select_elements();
    checkConnectionStatus();
    
    // Event listeners
    document.getElementById("ui-language").addEventListener("change", async function() {
        await changeLanguage(this.value);
    });
    
    document.getElementById("btn-check-connection").addEventListener("click", checkConnectionStatus);
    document.getElementById("btn-get-sessid").addEventListener("click", get_poesessid_from_cookies);
    
    document.getElementById("btn-save-sessid").addEventListener("click", async function() {
        await save_poesessid();
        setTimeout(checkConnectionStatus, 500);
    });
    
    document.getElementById("poe2-sessid").addEventListener("focus", function() {
        if (this.value.includes("...")) {
            this.value = "";
            this.dataset.fullValue = "";
        }
    });
    
    // Sliders
    document.getElementById("similar-percent").addEventListener("input", function() {
        document.getElementById("similar-percent-value").textContent = this.value;
    });
    document.getElementById("similar-percent").addEventListener("change", on_change_event);
    
    document.getElementById("price-threshold").addEventListener("input", function() {
        document.getElementById("price-threshold-value").textContent = this.value;
    });
    document.getElementById("price-threshold").addEventListener("change", saveNotificationSettings);
    
    // Price filters
    document.getElementById("price-min").addEventListener("change", on_change_event);
    document.getElementById("price-max").addEventListener("change", on_change_event);
    document.getElementById("price-min").addEventListener("input", on_change_event);
    document.getElementById("price-max").addEventListener("input", on_change_event);
    
    document.getElementById("btn-apply-filters").addEventListener("click", async function() {
        await on_change_event();
        const priceStatus = document.getElementById("price-status");
        priceStatus.textContent = t("status_applying_filters");
        priceStatus.className = "status-msg";
        refresh_page();
    });
    
    // Notification toggles
    document.getElementById("enable-price-alert").addEventListener("change", saveNotificationSettings);
    document.getElementById("enable-sound").addEventListener("change", saveNotificationSettings);
    
    // History & Stats buttons
    document.getElementById("btn-clear-history").addEventListener("click", async () => {
        if (confirm(t("confirm_clear_history"))) {
            await clearHistory();
        }
    });
    
    document.getElementById("btn-clear-cache").addEventListener("click", async () => {
        await clearCache();
    });
    
    document.getElementById("btn-reset-stats").addEventListener("click", async () => {
        if (confirm(t("confirm_reset_stats"))) {
            await resetStats();
        }
    });
    
    // Dropdowns
    document.getElementById("trade-type").addEventListener("change", on_change_event);
    document.getElementById("trade-league").addEventListener("change", on_change_event);
}

// Export functions for background script
window.vaalTrade = {
    addToHistory,
    getCachedResult,
    setCachedResult,
    incrementSearchCount
};

await init();