import { LocalDataLoader, OnlineDataLoader } from "./modules/dataloader.js";
import { get_status, set_status } from "./modules/storage_utils.js";

const API_URLS_FILTER = {
    urls: [
        "https://poe.ninja/poe2/api/builds/*/character?*",
        "https://poe.ninja/poe2/api/profile/characters/*",
        "https://poe.ninja/poe2/api/profile/characters/*/model/*",
        "https://poe.ninja/poe2/api/events/character/*/*"
    ]
};

/**
 * Clear old PoE1 data from storage to force reload of PoE2 data
 */
async function clearOldStorage() {
    const keysToRemove = [
        "local_query_data", "local_gems_query_data", "local_stats_data",
        "local_gems_data", "local_tw_gems_data",
        "online_stats_data", "online_gems_data", "online_tw_gems_data",
        "redirect-to", "lang", "mods-file-mode", "debug",
        "stats-data-sha", "gems-data-sha", "tw-gems-data-sha", "last-fetch-time"
    ];
    
    await chrome.storage.local.remove(keysToRemove);
    console.log("[Vaal Trade] Cleared old storage keys");
}

/**
 * init key value if needed
 * @returns {None}
 */
async function init_status() {
    // Clear old PoE1 data on first run
    const version = await get_status("extension-version");
    if (version !== "1.0.0") {
        await clearOldStorage();
        await set_status("extension-version", "1.0.0");
    }
    
    for (const slot of ["trade-type"]) {
        const val = await get_status(slot);
        if (val === undefined || val === null) {
            if (slot === "trade-type") await set_status(slot, "available");
        }
    }
};

/**
 * 使用 fecth 方法取得該網頁的資料
 * @param {string} target_url 目標網頁，在此應為 poe.ninja 網頁網址
 * @returns {string} @param target_url 轉換為 JSON 的結果
 */
async function fetch_url(target_url) {
    let res;

    await fetch(target_url).then(
        function (response) {
            if (response.status === 200)
                return response.json();
            else
                throw new Error("Request failed: " + response.status);
        }
    ).then(function (data) {
        res = data;
        console.log(res);
    }).catch(function (error) {
        console.error(error);
    });

    return res;
};

/**
 * 利用取得的角色資訊，內含本專案所需之裝備資料
 * @param {any} details 詳見 google extension webRequest api
 * @return {None}
 */
async function fetch_character_data(details) {
    if (details.tabId === -1) return;

    const api_url = details.url;
    console.log(`[Vaal Trade] Intercepted API URL: ${api_url}`);
    
    let equipment_data = await fetch_url(api_url);

    // Normalize data structure - PoE2 profile endpoint returns {hasData, charModel}
    if (equipment_data && equipment_data.charModel) {
        console.log(`[Vaal Trade] Extracting charModel from response`);
        equipment_data = equipment_data.charModel;
    }

    console.log(`[Vaal Trade] Equipment data keys:`, equipment_data ? Object.keys(equipment_data) : 'null');

    const local_loader = new LocalDataLoader();
    await local_loader.update_data();

    // PoE2 data only
    let query_data, gems_query_data, stats_data;
    
    try {
        query_data = await local_loader.get_data("local_poe2_query_data");
        gems_query_data = await local_loader.get_data("local_poe2_gems_query_data");
        stats_data = await local_loader.get_data("local_poe2_stats_data");
    } catch (e) {
        console.error("Failed to load PoE2 data:", e);
        return;
    }

    chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        function: inject_script,
        args: [
            stats_data,
            {}, // gems_data placeholder
            {}, // tw_gems_data placeholder
            query_data,
            gems_query_data,
            equipment_data,
            "poe2"
        ],
    });
}

// Message listener for PoE2 trade API calls and EventSource data from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle EventSource data from injected script
    if (request.type === 'POE_NINJA_CHARACTER_DATA') {
        console.log(`[Vaal Trade] Received character data from content script`);
        const details = {
            tabId: sender.tab.id,
            url: `https://poe.ninja/${request.gameVersion}/api/events/character/`
        };
        fetch_character_data_direct(details, request.data);
        return;
    }
    
    // Handle repeat search from history
    if (request.action === "repeatSearch") {
        const { query, league, name } = request;
        if (query && league) {
            const tradeUrl = `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`;
            // Open trade page with the same search
            chrome.tabs.create({ 
                url: tradeUrl,
                active: true
            });
        }
        return;
    }
    
    // Add to search history
    if (request.action === "addToHistory") {
        (async () => {
            const data = await chrome.storage.local.get(['search-history']);
            let history = data['search-history'] || [];
            
            history.unshift({
                name: request.name,
                type: request.itemType || 'item',
                query: request.query,
                league: request.league,
                tradeUrl: request.tradeUrl,
                timestamp: Date.now()
            });
            
            // Keep only last 20
            history = history.slice(0, 20);
            
            await chrome.storage.local.set({ 'search-history': history });
            
            // Update stats
            const statsData = await chrome.storage.local.get(['stats']);
            const stats = statsData['stats'] || { searches: 0, items: 0, timeSaved: 0, itemCounts: {} };
            stats.searches = (stats.searches || 0) + 1;
            stats.items = (stats.items || 0) + 1;
            stats.timeSaved = (stats.timeSaved || 0) + 15;
            if (!stats.itemCounts) stats.itemCounts = {};
            stats.itemCounts[request.name] = (stats.itemCounts[request.name] || 0) + 1;
            await chrome.storage.local.set({ 'stats': stats });
            
            sendResponse({ success: true });
        })();
        return true;
    }
    
    // Open tab in background without focusing
    if (request.action === "openTabInBackground") {
        chrome.tabs.create({ 
            url: request.url, 
            active: false  // Don't focus the new tab
        });
        return;
    }
    
    if (request.action === "poe2TradeSearch") {
        console.log("[Service Worker] Received PoE2 trade search request:", request);
        
        // Handle the async operation
        (async () => {
            try {
                const storage = await chrome.storage.local.get(["poe2-sessid"]);
                const poeSessId = storage["poe2-sessid"];
                
                if (!poeSessId) {
                    sendResponse({ 
                        success: false, 
                        error: "POESESSID not configured. Please configure it in the extension popup." 
                    });
                    return;
                }
                
                const league = request.league || "Standard";
                const apiUrl = `https://www.pathofexile.com/api/trade2/search/poe2/${encodeURIComponent(league)}`;
                
                // Sanitize and validate the query before sending
                let query = request.query;
                
                // Ensure query has required structure
                if (!query || !query.query) {
                    sendResponse({ 
                        success: false, 
                        error: "Invalid query structure" 
                    });
                    return;
                }
                
                // Clean up empty or invalid fields
                if (query.query.stats) {
                    // Remove stats groups with empty filters
                    query.query.stats = query.query.stats.filter(statGroup => 
                        statGroup.filters && statGroup.filters.length > 0
                    );
                    // If no valid stats groups left, remove stats entirely
                    if (query.query.stats.length === 0) {
                        delete query.query.stats;
                    }
                }
                
                // Ensure name and type are strings if present
                if (query.query.name && typeof query.query.name !== 'string') {
                    query.query.name = String(query.query.name);
                }
                if (query.query.type && typeof query.query.type !== 'string') {
                    query.query.type = String(query.query.type);
                }
                
                // Remove empty strings
                if (query.query.name === '') delete query.query.name;
                if (query.query.type === '') delete query.query.type;
                
                // Must have at least name or type
                if (!query.query.name && !query.query.type) {
                    sendResponse({ 
                        success: false, 
                        error: "Query must have item name or type" 
                    });
                    return;
                }
                
                console.log("[Service Worker] Calling PoE2 trade API:", apiUrl);
                console.log("[Service Worker] Query:", JSON.stringify(query, null, 2));
                console.log("[Service Worker] POESESSID:", poeSessId ? poeSessId.substring(0, 8) + "..." : "NOT SET");
                
                // Note: Service workers can't send cookies directly via headers
                // The API should work without auth for basic searches
                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify(query)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("[Service Worker] API Error:", response.status, errorText);
                    console.error("[Service Worker] Failed Query:", JSON.stringify(query, null, 2));
                    sendResponse({ 
                        success: false, 
                        error: `API error ${response.status}: ${errorText}` 
                    });
                    return;
                }
                
                const data = await response.json();
                console.log("[Service Worker] API Response:", data);
                
                if (data.id) {
                    sendResponse({ 
                        success: true, 
                        searchId: data.id,
                        total: data.total || 0
                    });
                } else {
                    sendResponse({ 
                        success: false, 
                        error: "No search ID returned from API" 
                    });
                }
                
            } catch (error) {
                console.error("[Service Worker] Error:", error);
                sendResponse({ 
                    success: false, 
                    error: error.message 
                });
            }
        })();
        
        // Return true to indicate we'll send a response asynchronously
        return true;
    }
});

/**
 * 要 inject 進目前 tab 的 script，功能：加入按鈕，轉換物品 mod 到 stats id
 * @param {Object} stats_data 整理過的詞墜表，提升查找效率與準確率
 * @param {Object} gems_data 整理過的寶石詞墜表，提升查找效率與準確率
 * @param {Object} tw_gems_data 整理過的台服寶石詞墜表，提升查找效率與準確率
 * @param {Object} query_data poe trade 的 query 格式，詳見 POE 官網及 query_example.json 示範
 * @param {Object} gems_query_data poe trade 的 query 格式，詳見 POE 官網及 query_example.json 示範
 * @param {Object} equipment_data 抓取到的角色裝備資料，內容來源為 poe.ninja，但格式是 POE 官方定義的
 * @param {string} game_version "poe1" or "poe2"
 * @return {None}
 */
async function inject_script(stats_data, gems_data, tw_gems_data, query_data, gems_query_data, equipment_data, game_version) {
    function dbg_log(msg) { if (is_debugging) console.log(msg); }
    function dbg_warn(msg) { if (is_debugging) console.warn(msg); }

    const is_debugging = false; // Set to true for debugging
    const redirect_to = "com"; // Always use .com for PoE2
    const storage = await chrome.storage.local.get(["trade-type", "similar-percent", "price-min", "price-max"]);
    const trade_type = storage["trade-type"] || "available";
    const similar_percent = parseInt(storage["similar-percent"]) || 80;
    const price_min = storage["price-min"] ? parseFloat(storage["price-min"]) : null;
    const price_max = storage["price-max"] ? parseFloat(storage["price-max"]) : null;
    const now_lang = "en";
    const now_lang_for_lang_matching = "en";

    dbg_log("[Vaal Trade] Starting...")
    dbg_log(`[Status] Game Version: ${game_version}`);
    dbg_log(`[Status] Similar Percent: ${similar_percent}%`);
    dbg_log(`[Status] Price Range: ${price_min || 'none'} - ${price_max || 'none'} Divine`);
    dbg_log("[Status] stats_data = ");
    dbg_log(stats_data);
    dbg_log("[Status] gems_data = ");
    dbg_log(gems_data);
    dbg_log("[Status] tw_gems_data = ");
    dbg_log(tw_gems_data);
    dbg_log("[Status] query_data = ");
    dbg_log(query_data);
    dbg_log("[Status] gems_query_data = ");
    dbg_log(gems_query_data);
    
    // Inject CSS for trade buttons hover effects
    if (!document.getElementById('poe-trade-buttons-style')) {
        const style = document.createElement('style');
        style.id = 'poe-trade-buttons-style';
        style.textContent = `
            .trade-similar-btn:hover { filter: brightness(1.2); transform: scale(1.05); }
            .trade-exact-btn:hover { filter: brightness(1.2); transform: scale(1.05); }
            .trade-base-btn:hover { filter: brightness(1.2); transform: scale(1.05); }
            .trade-similar-btn, .trade-exact-btn, .trade-base-btn { transition: filter 0.15s, transform 0.15s; }
            .trade-buttons-container { pointer-events: auto; }
            .trade-popup-buttons button:hover { filter: brightness(1.15); }
        `;
        document.head.appendChild(style);
    }
    
    // Inject Toastify CSS for notifications
    if (!document.getElementById('toastify-css')) {
        const toastifyCSS = document.createElement('link');
        toastifyCSS.id = 'toastify-css';
        toastifyCSS.rel = 'stylesheet';
        toastifyCSS.href = chrome.runtime.getURL('src/modules/toastify.min.css');
        document.head.appendChild(toastifyCSS);
    }
    
    // Inject Toastify JS for notifications
    if (!window.Toastify) {
        const toastifyScript = document.createElement('script');
        toastifyScript.src = chrome.runtime.getURL('src/modules/toastify.min.js');
        document.head.appendChild(toastifyScript);
    }
    
    // Toast helper function
    function showToast(message, type = 'error') {
        // Wait for Toastify to load if not available yet
        const tryShowToast = () => {
            if (window.Toastify) {
                window.Toastify({
                    text: message,
                    duration: 5000,
                    gravity: "top",
                    position: "right",
                    stopOnFocus: true,
                    style: {
                        background: type === 'error' ? "linear-gradient(to right, #ff5f6d, #ffc371)" : 
                                   type === 'success' ? "linear-gradient(to right, #00b09b, #96c93d)" :
                                   "linear-gradient(to right, #667eea, #764ba2)",
                        borderRadius: "8px",
                        fontSize: "14px",
                        padding: "12px 20px"
                    }
                }).showToast();
            } else {
                // Fallback to console if Toastify isn't loaded
                console.error("[Vaal Trade]", message);
            }
        };
        
        // Try immediately, or wait a bit if Toastify is loading
        if (window.Toastify) {
            tryShowToast();
        } else {
            setTimeout(tryShowToast, 100);
        }
    }

    // Trade URL based on game version
    // PoE1: /trade/search, PoE2: /trade2/search/poe2
    const POE_TRADE_URL = game_version === "poe2" 
        ? `https://www.pathofexile.${redirect_to}/trade2/search/poe2`
        : `https://www.pathofexile.${redirect_to}/trade/search`;
    
    dbg_log(`[Status] Trade URL: ${POE_TRADE_URL}`);
    
    const BALANCE_ICON = `<g id="SVGRepo_bgCarrier" stroke-width="0"></g>
    <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
    <g id="SVGRepo_iconCarrier">
        <path fill-rule="evenodd" clip-rule="evenodd"
            d="M16 3.93a.75.75 0 0 1 1.177-.617l4.432 3.069a.75.75 0 0 1 0 1.233l-4.432 3.069A.75.75 0 0 1 16 10.067V8H4a1 1 0 0 1 0-2h12V3.93zm-9.177 9.383A.75.75 0 0 1 8 13.93V16h12a1 1 0 1 1 0 2H8v2.067a.75.75 0 0 1-1.177.617l-4.432-3.069a.75.75 0 0 1 0-1.233l4.432-3.069z"
            fill="#ffffff"></path>
    </g>`;

    let lang_matching = {};

    /**
     * Extract numeric value(s) from a mod string
     * Example: "+3 to Level of all Spell Skills" -> 3
     * Example: "40% increased maximum Energy Shield" -> 40
     * Example: "Adds 10 to 20 Fire Damage" -> 10 (first value)
     * @param {string} mod_string The mod string to extract value from
     * @returns {number|null} The extracted numeric value or null if not found
     */
    function extract_mod_value(mod_string) {
        // Normalize first
        const normalized = normalize_mod_string(mod_string);
        
        // Match patterns like: +3, -5, 40%, 10.5
        // First try to match the first number in the string
        const matches = normalized.match(/[+-]?\d+\.?\d*/g);
        
        if (matches && matches.length > 0) {
            const value = parseFloat(matches[0]);
            if (!isNaN(value)) {
                return value;
            }
        }
        return null;
    }

    /**
     * Normalize mod string by removing poe.ninja specific tags
     * Example: "+17% to [Resistances|Chaos Resistance]" -> "+17% to Chaos Resistance"
     * Example: "[Critical|Critical Hit Chance]" -> "Critical Hit Chance"
     */
    function normalize_mod_string(mod_string) {
        // Remove tags like [Category|Display Text] -> Display Text
        let normalized = mod_string.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2');
        // Also handle simple tags [Text] -> Text
        normalized = normalized.replace(/\[([^\]|]+)\]/g, '$1');
        // Clean up any double spaces
        normalized = normalized.replace(/\s+/g, ' ').trim();
        return normalized;
    }

    /**
     * 從 STATS_DATA_PATH 尋找 mod_string 對應的 stats id。
     * @param {string} mod_string 要查詢的詞墜（預先處理過），格式是預先處理過的詞墜，用來直接比對查詢 stats id
     * @return {object} 查詢到的 stats res。如果沒有查詢到的話，則為 null
     */
    /**
     * Try to find the local version of a mod for equipment
     * Some mods like "increased Armour" have local variants that apply to the item itself
     */
    function find_local_mod_id(mod_string, original_stats_data) {
        // Normalize the mod string first
        mod_string = normalize_mod_string(mod_string);
        
        // Get the last two words (same logic as find_mod_id)
        let words = mod_string.trim().split(" ");
        if (words.length < 2) return null;
        
        let lastWord = words[words.length - 1].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "").toLowerCase();
        let secondLastWord = words[words.length - 2].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "").toLowerCase();
        
        // Try "word + local" key (e.g., "armourlocal", "speedlocal")
        const localKey = lastWord + "local";
        const matchers = original_stats_data[localKey];
        
        if (!matchers) return null;
        
        for (const matcher of matchers) {
            const match_string = matcher["matcher"];
            const match_regex = RegExp(match_string, "g");
            
            if (match_regex.test(mod_string)) {
                return matcher["res"];
            }
        }
        
        return null;
    }

    function find_mod_id(mod_string) {
        // Normalize the mod string first (remove poe.ninja tags)
        mod_string = normalize_mod_string(mod_string);
        
        let last_two_char = mod_string.trim().split(" ");
        // replace regex 和 ./scripts/transform_apt_stats.py sort_matcher_structure() 的 k.sub() 一致
        if (last_two_char.length >= 2) last_two_char = last_two_char[last_two_char.length - 2].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "") + last_two_char[last_two_char.length - 1].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "");
        else last_two_char = last_two_char[last_two_char.length - 1].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "");

        const matchers = stats_data[last_two_char.toLowerCase()];

        if (!matchers) return null;

        for (const matcher of matchers) {
            const match_string = matcher["matcher"];
            const match_regex = RegExp(match_string, "g");

            if (match_regex.test(mod_string)) {
                if (!matcher["res"][now_lang_for_lang_matching]) {
                    return matcher["res"];
                }

                const lang_mod_string = mod_string.replace(match_regex, RegExp(matcher["res"][now_lang_for_lang_matching])).replaceAll("/", "").replaceAll("\\n", "\n");

                // 珠寶換行的詞綴在 tippy 中是用空格分開，ex: "Added Small Passive Skills grant: 12% increased Trap Damage Added Small Passive Skills grant: 12% increased Mine Damage"
                if (mod_string.indexOf("\n") !== -1) lang_matching[mod_string.replace("\n", " ")] = lang_mod_string;
                lang_matching[mod_string] = lang_mod_string;

                return matcher["res"];
            }
        }

        return null;
    };

    /**
     * 生成該物品在 poe trade 的 query json string
     * @param {string} item_type Literal["items", "flasks", "jewels"]
     * @param {int} item_index 要從 equipment_data[item_type] 中的哪一個 idx 抓該物品的資料
     * @param {string} searchMode "similar" (user-configured % values, flexible) or "exact" (100% values, strict)
     * @returns {string} 生成的 query json string
     */
    function gen_item_target_query_str(item_type, item_index, searchMode = "similar") {
        // Validate input
        if (!equipment_data[item_type] || !equipment_data[item_type][item_index]) {
            dbg_warn(`[DEBUG] Invalid item_type or item_index: ${item_type}[${item_index}]`);
            return null;
        }
        
        const equipment = equipment_data[item_type][item_index];
        
        // Debug: log item structure
        dbg_log(`[DEBUG] Processing ${item_type}[${item_index}] with mode: ${searchMode}`);
        dbg_log(`[DEBUG] Equipment keys: ${Object.keys(equipment)}`);
        
        // PoE2 data structure: items have mods directly, not in itemData
        const itemData = equipment.itemData || equipment;
        
        if (!itemData || typeof itemData !== 'object') {
            dbg_warn(`[DEBUG] Invalid itemData for ${item_type}[${item_index}]`);
            return null;
        }
        
        dbg_log(`[DEBUG] ItemData keys: ${Object.keys(itemData)}`);
        
        // For PoE2, use a simplified query format
        if (game_version === "poe2") {
            let itemName = itemData.name || "";
            let itemType = itemData.typeLine || itemData.baseType || "";
            let baseType = itemData.baseType || "";
            const frameType = itemData.frameType; // 0=normal, 1=magic, 2=rare, 3=unique
            const identified = itemData.identified;
            
            // Normalize names - remove any special formatting tags
            itemName = normalize_mod_string(itemName);
            itemType = normalize_mod_string(itemType);
            baseType = normalize_mod_string(baseType);
            
            dbg_log(`[DEBUG] Item: name="${itemName}", type="${itemType}", baseType="${baseType}", frameType=${frameType}, identified=${identified}`);
            console.log("[DEBUG] Full itemData:", JSON.stringify(itemData, null, 2));
            
            // Detect unique items - frameType 3
            const isUnique = frameType === 3;
            
            // Sanitize strings for API - remove any problematic characters
            const sanitizeForApi = (str) => {
                if (!str) return "";
                return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
            };
            
            itemName = sanitizeForApi(itemName);
            itemType = sanitizeForApi(itemType);
            baseType = sanitizeForApi(baseType);
            
            // Build a PoE2 trade query
            // Based on actual API format from pathofexile.com/trade2
            const poe2Query = {
                query: {
                    status: { option: trade_type || "online" },
                    stats: [{ type: "and", filters: [] }]
                },
                sort: { price: "asc" }
            };
            
            // Add price filters if configured (Divine Orbs)
            if (price_min !== null || price_max !== null) {
                poe2Query.query.filters = poe2Query.query.filters || {};
                poe2Query.query.filters.trade_filters = {
                    disabled: false,
                    filters: {
                        price: {
                            option: "divine"
                        }
                    }
                };
                
                if (price_min !== null && price_min > 0) {
                    poe2Query.query.filters.trade_filters.filters.price.min = price_min;
                }
                if (price_max !== null && price_max > 0) {
                    poe2Query.query.filters.trade_filters.filters.price.max = price_max;
                }
                
                dbg_log(`[DEBUG] Added price filter: ${price_min || 'none'} - ${price_max || 'none'} Divine`);
                dbg_log(`[DEBUG] Trade filters: ${JSON.stringify(poe2Query.query.filters.trade_filters)}`);
            }
            
            // For unique items, search by exact name
            if (isUnique && itemName) {
                // Unique items use name and type
                poe2Query.query.name = itemName;
                if (baseType || itemType) {
                    poe2Query.query.type = baseType || itemType;
                }
            } else if (baseType || itemType) {
                // For rare/magic items, search by base type only
                poe2Query.query.type = baseType || itemType;
            } else {
                dbg_log(`[DEBUG] No search term found, skipping item`);
                return null;
            }
            
            // Process mods for PoE2 - add stat filters
            // For unique items in "exact" mode, also add stat filters
            // For "similar" mode on uniques, searching by name is usually enough
            const shouldAddStatFilters = !isUnique || searchMode === "exact";
            
            dbg_log(`[DEBUG STATS] isUnique=${isUnique}, searchMode=${searchMode}, shouldAddStatFilters=${shouldAddStatFilters}`);
            
            if (shouldAddStatFilters) {
                const mod_type_names = ["enchantMods", "implicitMods", "fracturedMods", "explicitMods", "craftedMods"];
                
                // Log all mods available on the item
                dbg_log(`[DEBUG STATS] Item mods available:`);
                for (const type_name of mod_type_names) {
                    const mods = itemData[type_name];
                    if (mods && mods.length > 0) {
                        dbg_log(`[DEBUG STATS]   ${type_name}: ${JSON.stringify(mods)}`);
                    }
                }
                
                for (const type_name of mod_type_names) {
                    const item_mods = itemData[type_name];
                    if (!item_mods || item_mods.length === 0) continue;
                    
                    dbg_log(`[DEBUG] Processing ${type_name}: ${item_mods.length} mods`);
                    
                    // Determine if this item is equipment (armour/weapon) - local mods apply
                    const isEquipment = itemData.category?.includes("armour") || 
                                       itemData.category?.includes("weapon") ||
                                       itemData.inventoryId === "Helm" ||
                                       itemData.inventoryId === "BodyArmour" ||
                                       itemData.inventoryId === "Gloves" ||
                                       itemData.inventoryId === "Boots" ||
                                       itemData.inventoryId === "Weapon" ||
                                       itemData.inventoryId === "Weapon2" ||
                                       itemData.inventoryId === "Offhand" ||
                                       itemData.inventoryId === "Offhand2" ||
                                       (itemData.armour !== undefined) ||
                                       (itemData.evasion !== undefined) ||
                                       (itemData.energyShield !== undefined);
                    
                    for (const mod of item_mods) {
                        try {
                            // For equipment, try local version first for certain mods
                            let res = null;
                            let usedLocalVersion = false;
                            
                            // List of mods that have local/global variants
                            const localModPatterns = [
                                /increased armour/i,
                                /increased evasion/i,
                                /increased energy shield/i,
                                /to armour/i,
                                /to evasion/i,
                                /to energy shield/i,
                                /increased physical damage/i,
                                /increased attack speed/i,
                                /increased critical/i,
                                /adds.*damage/i
                            ];
                            
                            const shouldTryLocal = isEquipment && localModPatterns.some(pattern => pattern.test(mod));
                            
                            if (shouldTryLocal) {
                                // Try to find the local version using our helper function
                                res = find_local_mod_id(mod, stats_data);
                                if (res) {
                                    usedLocalVersion = true;
                                    dbg_log(`[DEBUG] Found local version for: ${mod}`);
                                }
                            }
                            
                            // Fall back to original mod string
                            if (!res) {
                                res = find_mod_id(mod);
                            }
                            
                            if (!res) {
                                dbg_warn(`[PoE2 MOD NOT FOUND] type=${type_name}, mod='${mod}'`);
                                continue;
                            }
                            
                            // Get the mod ID for this mod type
                            const mod_ids = res[type_name];
                            
                            if (!mod_ids || mod_ids.length === 0) {
                                dbg_warn(`[PoE2 MOD ID NOT FOUND] type=${type_name}, mod='${mod}'`);
                                continue;
                            }
                            
                            // Extract the mod ID (format might be "explicit.stat_123" or "explicit.stat_123|value")
                            const mod_id_full = mod_ids[0];
                            const mod_id_parts = mod_id_full.split("|");
                            let mod_id = mod_id_parts[0];
                            
                            // Validate mod_id format - must be like "explicit.stat_XXXXX"
                            if (!mod_id || !mod_id.includes('.stat_')) {
                                dbg_warn(`[PoE2 MOD INVALID ID] type=${type_name}, mod_id='${mod_id}', mod='${mod}'`);
                                continue;
                            }
                            
                            // Clean up any whitespace
                            mod_id = mod_id.trim();
                            
                            // Add to filters with min value if available
                            if (mod_id) {
                                const modValue = extract_mod_value(mod);
                                const filter = { id: mod_id };
                                
                                // Calculate value multiplier based on search mode
                                // "similar" = user-configured percent (default 80%), "exact" = 100% (strict)
                                const valueMultiplier = searchMode === "exact" ? 1.0 : (similar_percent / 100);
                                
                                console.log(`[DEBUG MULTIPLIER] searchMode=${searchMode}, valueMultiplier=${valueMultiplier} (${similar_percent}%), modValue=${modValue}`);
                                
                                // Add min value for the stat
                                if (modValue !== null && modValue > 0) {
                                    const minVal = Math.floor(modValue * valueMultiplier);
                                    console.log(`[DEBUG CALC] ${modValue} * ${valueMultiplier} = ${modValue * valueMultiplier} -> floor = ${minVal}`);
                                    // Only add filter if min value is at least 1
                                    if (minVal >= 1) {
                                        filter.value = { min: minVal };
                                        dbg_log(`[PoE2 MOD SUCCESS] id=${mod_id}, value=${modValue}, min=${filter.value.min}, mode=${searchMode}, mod='${mod}'`);
                                        poe2Query.query.stats[0].filters.push(filter);
                                    } else {
                                        dbg_log(`[PoE2 MOD SKIPPED] min value too low: ${minVal}, mod='${mod}'`);
                                    }
                                } else if (modValue !== null && modValue < 0) {
                                    // For negative values (like reduced), use the actual value as max
                                    const maxVal = Math.ceil(modValue * valueMultiplier);
                                    filter.value = { max: maxVal };
                                    dbg_log(`[PoE2 MOD SUCCESS] id=${mod_id}, value=${modValue}, max=${filter.value.max}, mode=${searchMode}, mod='${mod}'`);
                                    poe2Query.query.stats[0].filters.push(filter);
                                } else {
                                    // Skip mods without numeric values for now - they can cause API issues
                                    dbg_log(`[PoE2 MOD SKIPPED] no numeric value, mod='${mod}'`);
                                }
                            }
                        } catch (e) {
                            dbg_warn(`[PoE2 MOD ERROR] ${e.message}, mod='${mod}'`);
                        }
                    }
                }
                
                // Both modes use "and" type - all filters must match
                // The difference is in the min values: similar uses user-configured %, exact uses 100%
                const filterCount = poe2Query.query.stats[0].filters.length;
                dbg_log(`[DEBUG] ${searchMode} mode (${searchMode === 'exact' ? '100' : similar_percent}%) - requiring ALL ${filterCount} mods to match (type: and)`);
            }
            
            // Get filter count for logging
            const filterCount = poe2Query.query.stats?.[0]?.filters?.length || 0;
            dbg_log(`[DEBUG] PoE2 query with ${filterCount} stat filters: ${JSON.stringify(poe2Query)}`);
            
            // Validate query before returning - must have either name or type
            if (!poe2Query.query.name && !poe2Query.query.type) {
                dbg_warn(`[DEBUG] Invalid query - no name or type found`);
                return null;
            }
            
            // Clean up empty stats array if no filters
            if (!poe2Query.query.stats?.[0]?.filters?.length) {
                delete poe2Query.query.stats;
            }
            
            // For EXACT mode, add additional filters for complete match
            if (searchMode === "exact") {
                // Initialize filters object if not exists
                if (!poe2Query.query.filters) {
                    poe2Query.query.filters = {};
                }
                
                // Helper function to initialize filter groups
                const initFilterGroup = (groupName) => {
                    if (!poe2Query.query.filters[groupName]) {
                        poe2Query.query.filters[groupName] = { filters: {} };
                    }
                    return poe2Query.query.filters[groupName].filters;
                };
                
                // ============== TYPE FILTERS ==============
                const typeFilters = initFilterGroup('type_filters');
                
                // Item Level - only keep minimum
                const itemLevel = itemData.ilvl || itemData.itemLevel;
                if (itemLevel) {
                    typeFilters.ilvl = { min: itemLevel };
                    dbg_log(`[EXACT] Item Level: min ${itemLevel}`);
                }
                
                // Quality
                const quality = itemData.quality;
                if (quality !== undefined && quality !== null && quality > 0) {
                    typeFilters.quality = { min: quality };
                    dbg_log(`[EXACT] Quality: min ${quality}`);
                }
                
                // Rarity (based on frameType)
                const frameType = itemData.frameType;
                if (frameType !== undefined) {
                    const rarityMap = { 0: 'normal', 1: 'magic', 2: 'rare', 3: 'unique' };
                    if (rarityMap[frameType]) {
                        typeFilters.rarity = { option: rarityMap[frameType] };
                        dbg_log(`[EXACT] Rarity: ${rarityMap[frameType]}`);
                    }
                }
                
                // ============== EQUIPMENT FILTERS ==============
                const equipFilters = initFilterGroup('equipment_filters');
                
                // Armour value
                if (itemData.armour !== undefined && itemData.armour > 0) {
                    equipFilters.ar = { min: itemData.armour };
                    dbg_log(`[EXACT] Armour: min ${itemData.armour}`);
                }
                
                // Evasion value
                if (itemData.evasion !== undefined && itemData.evasion > 0) {
                    equipFilters.ev = { min: itemData.evasion };
                    dbg_log(`[EXACT] Evasion: min ${itemData.evasion}`);
                }
                
                // Energy Shield value
                if (itemData.energyShield !== undefined && itemData.energyShield > 0) {
                    equipFilters.es = { min: itemData.energyShield };
                    dbg_log(`[EXACT] Energy Shield: min ${itemData.energyShield}`);
                }
                
                // Spirit value
                if (itemData.spirit !== undefined && itemData.spirit > 0) {
                    equipFilters.spirit = { min: itemData.spirit };
                    dbg_log(`[EXACT] Spirit: min ${itemData.spirit}`);
                }
                
                // Block value
                if (itemData.block !== undefined && itemData.block > 0) {
                    equipFilters.block = { min: itemData.block };
                    dbg_log(`[EXACT] Block: min ${itemData.block}`);
                }
                
                // Extract weapon stats from properties if available
                if (itemData.properties && Array.isArray(itemData.properties)) {
                    for (const prop of itemData.properties) {
                        const propName = prop.name?.toLowerCase() || '';
                        const propValue = prop.values?.[0]?.[0];
                        
                        // Physical DPS
                        if (propName.includes('physical damage') && propValue) {
                            const dmgMatch = propValue.match(/(\d+)-(\d+)/);
                            if (dmgMatch) {
                                const avgDmg = (parseInt(dmgMatch[1]) + parseInt(dmgMatch[2])) / 2;
                                dbg_log(`[EXACT] Physical Damage: ${propValue} (avg: ${avgDmg})`);
                            }
                        }
                        
                        // Attacks per second
                        if (propName.includes('attacks per second') && propValue) {
                            const aps = parseFloat(propValue);
                            if (aps > 0) {
                                equipFilters.aps = { min: Math.floor(aps * 100) / 100 };
                                dbg_log(`[EXACT] APS: min ${aps}`);
                            }
                        }
                        
                        // Critical Strike Chance
                        if (propName.includes('critical') && propValue) {
                            const critMatch = propValue.match(/([\d.]+)%/);
                            if (critMatch) {
                                const crit = parseFloat(critMatch[1]);
                                equipFilters.crit = { min: crit };
                                dbg_log(`[EXACT] Critical Chance: min ${crit}%`);
                            }
                        }
                    }
                }
                
                // Augmentable Sockets - REMOVED to prevent no results on strict searches
                // const sockets = itemData.sockets;
                // if (sockets && Array.isArray(sockets) && sockets.length > 0) {
                //     const socketCount = sockets.length;
                //     equipFilters.rune_sockets = { min: socketCount, max: socketCount };
                //     dbg_log(`[EXACT] Augmentable Sockets: ${socketCount}`);
                // }
                
                // ============== MISC FILTERS ==============
                const miscFilters = initFilterGroup('misc_filters');
                
                // Corrupted status - REMOVED to avoid filtering out items
                // const isCorrupted = itemData.corrupted === true;
                // miscFilters.corrupted = { option: isCorrupted ? "true" : "false" };
                // dbg_log(`[EXACT] Corrupted: ${isCorrupted}`);
                
                // Twice Corrupted (double corrupted)
                if (itemData.doubleCorrupted === true) {
                    miscFilters.twice_corrupted = { option: "true" };
                    dbg_log(`[EXACT] Twice Corrupted: true`);
                }
                
                // Identified status
                if (itemData.identified !== undefined) {
                    miscFilters.identified = { option: itemData.identified ? "true" : "false" };
                    dbg_log(`[EXACT] Identified: ${itemData.identified}`);
                }
                
                // Fractured item
                if (itemData.fractured === true) {
                    miscFilters.fractured_item = { option: "true" };
                    dbg_log(`[EXACT] Fractured: true`);
                }
                
                // Sanctified
                if (itemData.sanctified === true) {
                    miscFilters.sanctified = { option: "true" };
                    dbg_log(`[EXACT] Sanctified: true`);
                }
                
                // Desecrated - REMOVED to avoid filtering out items
                // if (itemData.desecrated === true) {
                //     miscFilters.desecrated = { option: "true" };
                //     dbg_log(`[EXACT] Desecrated: true`);
                // }
                
                // Mirrored
                if (itemData.duplicated === true || itemData.mirrored === true) {
                    miscFilters.mirrored = { option: "true" };
                    dbg_log(`[EXACT] Mirrored: true`);
                }
                
                // REQUIREMENT FILTERS - REMOVED to prevent strict filtering
                // Extract requirements from item
                // if (itemData.requirements && Array.isArray(itemData.requirements)) {
                //     const reqFilters = initFilterGroup('req_filters');
                //     
                //     for (const req of itemData.requirements) {
                //         const reqName = req.name?.toLowerCase() || '';
                //         const reqValue = parseInt(req.values?.[0]?.[0]) || 0;
                //         
                //         if (reqName.includes('level') && reqValue > 0) {
                //             reqFilters.lvl = { max: reqValue };
                //             dbg_log(`[EXACT] Required Level: max ${reqValue}`);
                //         }
                //         if (reqName.includes('str') && reqValue > 0) {
                //             reqFilters.str = { max: reqValue };
                //             dbg_log(`[EXACT] Required Str: max ${reqValue}`);
                //         }
                //         if (reqName.includes('dex') && reqValue > 0) {
                //             reqFilters.dex = { max: reqValue };
                //             dbg_log(`[EXACT] Required Dex: max ${reqValue}`);
                //         }
                //         if (reqName.includes('int') && reqValue > 0) {
                //             reqFilters.int = { max: reqValue };
                //             dbg_log(`[EXACT] Required Int: max ${reqValue}`);
                //         }
                //     }
                // }
                
                // Clean up empty filter groups
                for (const groupName of ['type_filters', 'equipment_filters', 'misc_filters', 'req_filters']) {
                    if (poe2Query.query.filters[groupName] && 
                        Object.keys(poe2Query.query.filters[groupName].filters).length === 0) {
                        delete poe2Query.query.filters[groupName];
                    }
                }
                
                // Log socketed items (runes) for reference
                const socketedItems = itemData.socketedItems;
                if (socketedItems && Array.isArray(socketedItems) && socketedItems.length > 0) {
                    dbg_log(`[EXACT] Found ${socketedItems.length} socketed items (runes):`);
                    for (const socketedItem of socketedItems) {
                        const runeName = socketedItem.typeLine || socketedItem.baseType || socketedItem.name;
                        if (runeName) {
                            dbg_log(`[EXACT]   - ${runeName}`);
                        }
                    }
                }
                
                dbg_log(`[EXACT] Final filters: ${JSON.stringify(poe2Query.query.filters)}`);
            }
            
            // Return the query as JSON string with POE2_QUERY: prefix
            return "POE2_QUERY:" + JSON.stringify(poe2Query);
        }
        
        // Original PoE1 logic below
        const target_query = JSON.parse(JSON.stringify(query_data));
        
        // Set search type
        target_query.query.status.option = trade_type;
        
        const mod_type_names = ["enchantMods", "implicitMods", "fracturedMods", "explicitMods", "craftedMods"];

        for (const type_name of mod_type_names) {
            const item_mods = itemData[type_name];
            const item_inventoryId = itemData["inventoryId"] || itemData["id"] || "unknown";
            // const item_typeLine = itemData["typeLine"];

            if (!item_mods || item_mods.length === 0) continue;

            for (const mod of item_mods) {
                try {
                    var res = find_mod_id(mod);
                } catch (e) {
                    dbg_warn(e);
                    dbg_add_msg_to_page_top(e);
                }

                if (!res) {
                    dbg_warn("[MOD NOT FOUND] mod_type=" + type_name + ", mod_string='" + mod + "'");
                    dbg_add_msg_to_page_top("[MOD NOT FOUND] mod_type=" + type_name + ", item_inventoryId=" + item_inventoryId + ", origin mod='" + mod + "'");
                    continue;
                }
                const mod_ids = res[type_name];
                const value = res["value"];

                if (!mod_ids) {
                    dbg_warn(item_inventoryId);
                    dbg_warn(item_mods);
                    dbg_warn("[MOD NOT FOUND] mod_type=" + type_name + ", mod_string='" + mod + "'");

                    dbg_add_msg_to_page_top("[MOD NOT FOUND] mod_type=" + type_name + ", item_inventoryId=" + item_inventoryId + ", origin mod='" + mod + "'");
                    continue;
                }

                // duplicate mods
                if (mod_ids.length > 1) {
                    const filters = [];
                    for (const mod_id of mod_ids) {
                        if (!value) filters.push({ "id": mod_id });
                        else filters.push({ "id": mod_id, "value": { "min": value } });
                    }

                    target_query.query.stats.push({
                        "type": "count",
                        "filters": filters,
                        "value": {
                            "min": 1
                        }
                    });
                    // console.info("\n[DUPLICATE] id=" + mod_ids + ", option=" + mod_option + ", mod_string='" + fixed_mod + "', duplicate_list:" + JSON.stringify(duplicate_stats_data[fixed_mod]));
                }
                // no duplicate mods
                else {
                    if (value && value === 100) target_query.query.stats[0].filters.push({ "id": mod_ids[0], "value": { "min": value } });
                    else if (value) target_query.query.stats[0].filters.push({ "id": mod_ids[0], "option": value });
                    else target_query.query.stats[0].filters.push({ "id": mod_ids[0] });
                }
                dbg_log("[SUCCESS] id=" + mod_ids[0] + ", value=" + value + ", mod_string='" + mod + "'");
            }
        }

        // Log final query for debugging
        const queryStr = JSON.stringify(target_query);
        dbg_log(`[DEBUG] Final query for ${item_type}[${item_index}]: ${queryStr.substring(0, 500)}...`);
        console.log("[DEBUG] Full query:", target_query);
        
        return queryStr;
    };

    /**
     * Generate a base search query (item type + ilvl, max magic rarity)
     * Useful for finding base items for crafting
     * @param {string} item_type Literal["items", "flasks", "jewels"]
     * @param {int} item_index Index in equipment_data[item_type]
     * @returns {string} Query JSON string for base search (with POE2_QUERY: prefix)
     */
    function gen_base_only_query_str(item_type, item_index) {
        if (!equipment_data[item_type] || !equipment_data[item_type][item_index]) {
            return null;
        }
        
        const equipment = equipment_data[item_type][item_index];
        const itemData = equipment.itemData || equipment;
        
        if (!itemData) return null;
        
        // Get base type info
        let baseType = itemData.baseType || itemData.typeLine || "";
        
        if (!baseType) return null;
        
        // Sanitize
        baseType = baseType.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        
        // Get item level
        const ilvl = itemData.ilvl || itemData.itemLevel;
        
        // Build query - base type + ilvl + normal rarity only
        const baseQuery = {
            query: {
                status: { option: trade_type || "online" },
                type: baseType,
                filters: {
                    type_filters: {
                        disabled: false,
                        filters: {
                            rarity: { option: "normal" }  // Normal only
                        }
                    }
                }
            },
            sort: { price: "asc" }
        };
        
        // Add Item Level filter (minimum)
        if (ilvl && ilvl > 0) {
            baseQuery.query.filters.misc_filters = {
                disabled: false,
                filters: {
                    ilvl: { min: ilvl }
                }
            };
        }
        
        // Add price filters if configured
        if (price_min !== null || price_max !== null) {
            baseQuery.query.filters.trade_filters = {
                disabled: false,
                filters: {
                    price: { option: "divine" }
                }
            };
            if (price_min !== null && price_min > 0) {
                baseQuery.query.filters.trade_filters.filters.price.min = price_min;
            }
            if (price_max !== null && price_max > 0) {
                baseQuery.query.filters.trade_filters.filters.price.max = price_max;
            }
        }
        
        // Return with POE2_QUERY: prefix for the handler to recognize
        return "POE2_QUERY:" + JSON.stringify(baseQuery);
    }

    /**
     * 生成該寶石在 poe trade 的 query json string
     * @param {string} name 寶石名稱
     * @param {int} level 該寶石的等級
     * @param {int} quality 該寶石的品質
     * @param {string} server_type com: www.pathofexile.com, tw: www.pathofexile.tw
     * @returns {string} 生成的 query json string
     */
    function gen_skills_target_query_str(name, level, quality, server_type) {
        const target_query = JSON.parse(JSON.stringify(gems_query_data));
        const gems_info = server_type === "com" ? gems_data[name] : tw_gems_data[name];

        // Set search type
        target_query.query.status.option = trade_type;

        if (!gems_info) return;

        // alter version gems
        if (gems_info["disc"]) {
            target_query.query.type.option = gems_info["type"];
            target_query.query.type.discriminator = gems_info["disc"];
        }
        // normal gems
        else {
            target_query.query.type = gems_info["type"];
        }

        target_query.query.filters.misc_filters.filters.gem_level.min = level;
        target_query.query.filters.misc_filters.filters.quality.min = quality;

        return JSON.stringify(target_query);
    }

    /**
     * 生成重導向按鈕
     * @param {string} target_query 按下按鈕後會前往的網址
     * @param {string} btn_position Literal["top", "bottom"] 按鈕放在上方或下方
     * @param {string} buttonLabel Label for the button (default: "Trade")
     * @returns {HTMLButtonElement} 重導向至 target_url 的按鈕
     */
    function gen_btn_trade_element(target_query, btn_position, buttonLabel = "Trade") {
        // Check for null/undefined query
        if (!target_query) {
            dbg_log(`[DEBUG] gen_btn_trade_element: null query, returning null`);
            return null;
        }
        
        const new_node = document.createElement("button");
        const text_node = document.createTextNode(buttonLabel);
        const balance_icon_node = document.createElementNS("http://www.w3.org/2000/svg", "svg");

        balance_icon_node.setAttribute("viewBox", "0 0 24 24");
        balance_icon_node.setAttribute("fill", "currentColor");
        balance_icon_node.setAttribute("width", "1em");
        balance_icon_node.setAttribute("height", "1em");
        balance_icon_node.innerHTML = BALANCE_ICON;

        new_node.setAttribute("class", "button absolute opacity-0 group-hover:opacity-100");
        new_node.setAttribute("title", "Redirect to trade website");
        new_node.setAttribute("role", "button");
        new_node.setAttribute("data-variant", "plain");
        new_node.setAttribute("data-size", "xsmall");

        if (btn_position === "top") new_node.setAttribute("style", "position: absolute; top: 0px; right: var(--s1); background-color: hsla(var(--emerald-800),var(--opacity-100)); transform: translateY(-66%); border-radius: var(--rounded-sm); z-index: 100;");
        else if (btn_position === "bottom") new_node.setAttribute("style", "position: absolute; bottom: -15px; left: var(--s1); background-color: hsla(var(--emerald-800),var(--opacity-100)); transform: translateY(-66%); border-radius: var(--rounded-sm); z-index: 100;");
        else if (btn_position === "skills") new_node.setAttribute("style", "opacity: 1; position: relative; background-color: hsla(var(--emerald-800),var(--opacity-100));");

        new_node.appendChild(balance_icon_node);
        new_node.appendChild(text_node);

        // Check if this is a PoE2 API query (prefixed with POE2_QUERY:)
        if (target_query.startsWith("POE2_QUERY:")) {
            const queryJson = target_query.substring(11); // Remove "POE2_QUERY:" prefix
            dbg_log(`[DEBUG] PoE2 API query: ${queryJson}`);
            
            // Store the query data on the button
            new_node.dataset.poe2Query = queryJson;
            new_node.dataset.tradeUrl = POE_TRADE_URL;
            
            // Add click handler that will call the PoE2 trade API via background script
            new_node.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                const query = JSON.parse(this.dataset.poe2Query);
                const baseUrl = this.dataset.tradeUrl;
                const buttonEl = this;
                
                // Change button to loading state
                buttonEl.textContent = "Loading...";
                buttonEl.disabled = true;
                
                try {
                    // Get league preference from storage
                    const leagueStorage = await chrome.storage.local.get(["trade-league"]);
                    const leaguePref = leagueStorage["trade-league"] || "auto";
                    
                    let league = "Standard"; // default
                    
                    if (leaguePref === "auto") {
                        // Extract league from URL - try to detect from poe.ninja URL
                        const currentUrl = window.location.href;
                        
                        // Try to get league from poe.ninja URL
                        // URL format: https://poe.ninja/poe2/builds/league-name/...
                        const leagueMatch = currentUrl.match(/poe\.ninja\/poe2\/builds\/([^\/\?]+)/);
                        if (leagueMatch) {
                            // Convert URL-friendly name to proper league name
                            league = decodeURIComponent(leagueMatch[1].replace(/-/g, ' '));
                            // Capitalize first letter of each word
                            league = league.split(' ').map(word => 
                                word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                            ).join(' ');
                        } else if (currentUrl.includes("poe2")) {
                            // Fallback to current PoE2 league
                            league = "Fate of the Vaal";
                        }
                    } else {
                        // Use user's preferred league
                        league = leaguePref;
                    }
                    
                    console.log(`[PoE2 Trade] Using league: ${league} (pref: ${leaguePref})`);
                    console.log("[PoE2 Trade] Query:", JSON.stringify(query));
                    
                    // Send message to background script to make the API call
                    chrome.runtime.sendMessage({
                        action: "poe2TradeSearch",
                        query: query,
                        league: league
                    }, function(response) {
                        console.log("[PoE2 Trade] Response from background:", response);
                        
                        if (response && response.success) {
                            // Open the trade page with the search ID
                            const tradeUrl = `${baseUrl}/${encodeURIComponent(league)}/${response.searchId}`;
                            console.log("[PoE2 Trade] Opening:", tradeUrl);
                            window.open(tradeUrl, '_blank');
                        } else {
                            const errorMsg = response ? response.error : "No response from extension";
                            console.error("[PoE2 Trade] Error:", errorMsg);
                            showToastError("Error searching trade:\n" + errorMsg + "\n\nMake sure you have configured your Session ID in the extension popup.");
                        }
                        
                        // Restore button state
                        buttonEl.innerHTML = '';
                        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                        icon.setAttribute("viewBox", "0 0 24 24");
                        icon.setAttribute("fill", "currentColor");
                        icon.setAttribute("width", "1em");
                        icon.setAttribute("height", "1em");
                        icon.innerHTML = '<path fill-rule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clip-rule="evenodd" />';
                        buttonEl.appendChild(icon);
                        buttonEl.appendChild(document.createTextNode("Trade"));
                        buttonEl.disabled = false;
                    });
                    
                } catch (error) {
                    console.error("[PoE2 Trade] Error:", error);
                    showToast("Error: " + error.message, 'error');
                    
                    // Restore button state
                    buttonEl.innerHTML = '';
                    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                    icon.setAttribute("viewBox", "0 0 24 24");
                    icon.setAttribute("fill", "currentColor");
                    icon.setAttribute("width", "1em");
                    icon.setAttribute("height", "1em");
                    icon.innerHTML = '<path fill-rule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clip-rule="evenodd" />';
                    buttonEl.appendChild(icon);
                    buttonEl.appendChild(document.createTextNode("Trade"));
                    buttonEl.disabled = false;
                }
            });
            
        } else {
            // Original PoE1 behavior - simple URL redirect
            const encodedQuery = encodeURIComponent(target_query);
            const fullUrl = `${POE_TRADE_URL}?q=${encodedQuery}`;
            
            dbg_log(`[DEBUG] Trade URL: ${fullUrl.substring(0, 200)}...`);
            console.log("[DEBUG] Full Trade URL:", fullUrl);
            
            new_node.setAttribute("onclick", `console.log('Opening:', '${fullUrl.substring(0,100)}...'); window.open('${fullUrl}', '_blank');`);
        }

        return new_node;
    };

    /**
     * 生成排版用的 span
     * @returns {HTMLSpanElement}
     */
    function gen_btn_span_element() {
        const new_node = document.createElement("span");
        new_node.setAttribute("style", "padding: 3px;");

        return new_node;
    }

    /**
     * Generate a container with trade buttons for PoE2: Similar, Exact, and Base
     * @param {string} item_type Type of item ("items", "jewels", "flasks", "charms")
     * @param {int} item_index Index in the equipment array
     * @param {string} btn_position Position of buttons
     * @param {string} itemName Optional item name for tooltip
     * @returns {HTMLDivElement} Container with buttons
     */
    function gen_poe2_trade_buttons(item_type, item_index, btn_position, itemName = "") {
        // Generate queries
        const similarQuery = gen_item_target_query_str(item_type, item_index, "similar");
        const exactQuery = gen_item_target_query_str(item_type, item_index, "exact");
        const baseQuery = gen_base_only_query_str(item_type, item_index);
        
        // If no query could be generated, return null
        if (!similarQuery && !exactQuery && !baseQuery) {
            return null;
        }
        
        // Get item info for tooltip
        let baseName = "";
        if (!itemName) {
            try {
                const itemData = equipment_data[item_type][item_index];
                const data = itemData.itemData || itemData;
                itemName = data.name || data.typeLine || "item";
                baseName = data.baseType || data.typeLine || "base";
            } catch (e) {
                itemName = "item";
                baseName = "base";
            }
        }
        
        // Create container
        const container = document.createElement("div");
        container.setAttribute("class", "trade-buttons-container");
        
        // Position styles based on btn_position - buttons always visible now
        let positionStyle = "";
        let flexDirection = "row";
        
        if (btn_position === "top") {
            positionStyle = "position: absolute; top: -2px; right: 2px; z-index: 100;";
        } else if (btn_position === "bottom") {
            positionStyle = "position: absolute; bottom: 2px; right: 2px; z-index: 100;";
        } else if (btn_position === "center") {
            positionStyle = "position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 100;";
        } else if (btn_position === "popup") {
            positionStyle = "display: flex; justify-content: center; margin-top: 8px;";
        } else if (btn_position === "right") {
            // Right side with vertical column - for small items like rings, amulet, jewels, flasks
            positionStyle = "position: absolute; top: 50%; right: -2px; transform: translateY(-50%); z-index: 100;";
            flexDirection = "column";
        } else if (btn_position === "left") {
            // Left side with vertical column
            positionStyle = "position: absolute; top: 50%; left: -2px; transform: translateY(-50%); z-index: 100;";
            flexDirection = "column";
        } else {
            positionStyle = "position: relative;";
        }
        
        // Buttons always visible (opacity: 1)
        container.setAttribute("style", `${positionStyle} display: flex; flex-direction: ${flexDirection}; gap: 2px; opacity: 1;`);
        
        // Button base style - 20% larger (12px font instead of 10px)
        const btnBaseStyle = "border-radius: var(--rounded-sm); padding: 3px 6px; font-size: 12px; display: flex; align-items: center; gap: 3px; cursor: pointer; border: none; color: white; font-weight: 500;";
        
        // Create Similar button (yellow/amber) - flexible search
        if (similarQuery) {
            const similarBtn = document.createElement("button");
            similarBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">${BALANCE_ICON}</svg>`;
            similarBtn.setAttribute("class", "button trade-similar-btn");
            similarBtn.setAttribute("title", `Search similar: ${itemName}\n(${similar_percent}% stat values, flexible matching)`);
            similarBtn.setAttribute("style", `${btnBaseStyle} background-color: #b59f3b;`);
            
            // Add click handler
            setupPoe2ButtonHandler(similarBtn, similarQuery, itemName);
            container.appendChild(similarBtn);
        }
        
        // Create Exact button (green) - strict search
        if (exactQuery) {
            const exactBtn = document.createElement("button");
            exactBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">${BALANCE_ICON}</svg>`;
            exactBtn.setAttribute("class", "button trade-exact-btn");
            exactBtn.setAttribute("title", `Search exact: ${itemName}\n(100% stat values, all mods must match)`);
            exactBtn.setAttribute("style", `${btnBaseStyle} background-color: #2d8a4e;`);
            
            // Add click handler  
            setupPoe2ButtonHandler(exactBtn, exactQuery, itemName);
            container.appendChild(exactBtn);
        }
        
        // Create Base button (blue) - base type only search
        if (baseQuery) {
            const baseBtn = document.createElement("button");
            baseBtn.innerHTML = `B`;
            baseBtn.setAttribute("class", "button trade-base-btn");
            baseBtn.setAttribute("title", `Search base type: ${baseName}\n(No mods - for crafting)`);
            baseBtn.setAttribute("style", `${btnBaseStyle} background-color: #3b82f6; font-weight: bold;`);
            
            // Add click handler
            setupPoe2ButtonHandler(baseBtn, baseQuery, baseName);
            container.appendChild(baseBtn);
        }
        
        // Add price indicator badge if item has price info
        try {
            const itemData = equipment_data[item_type][item_index];
            const data = itemData.itemData || itemData;
            
            // Look for price in ninja's data structure
            const price = itemData.chaosValue || itemData.divineValue || itemData.price;
            if (price && price > 0) {
                const priceBadge = document.createElement("div");
                const priceInDivine = itemData.divineValue || (itemData.chaosValue / 170).toFixed(1);
                const priceDisplay = priceInDivine >= 1 ? `${parseFloat(priceInDivine).toFixed(1)}d` : `${Math.round(itemData.chaosValue || price)}c`;
                
                priceBadge.setAttribute("class", "price-badge");
                priceBadge.textContent = priceDisplay;
                priceBadge.setAttribute("style", `
                    position: absolute; 
                    bottom: -2px; 
                    left: 2px; 
                    background: rgba(0,0,0,0.8); 
                    color: #f0c000; 
                    font-size: 9px; 
                    padding: 1px 4px; 
                    border-radius: 3px;
                    font-weight: bold;
                    z-index: 99;
                `);
                priceBadge.setAttribute("title", `Estimated price from poe.ninja`);
                container.appendChild(priceBadge);
            }
        } catch (e) {
            // Price info not available - that's ok
        }
        
        return container;
    }
    
    /**
     * Generate trade buttons for item popup/tooltip
     * @param {string} item_type Type of item
     * @param {int} item_index Index in the equipment array
     * @param {string} itemName Item name for display
     * @returns {HTMLDivElement} Container with buttons for popup
     */
    function gen_poe2_popup_buttons(item_type, item_index, itemName) {
        const similarQuery = gen_item_target_query_str(item_type, item_index, "similar");
        const exactQuery = gen_item_target_query_str(item_type, item_index, "exact");
        const baseQuery = gen_base_only_query_str(item_type, item_index);
        
        // Get base type name
        let baseName = "";
        try {
            const itemData = equipment_data[item_type][item_index];
            const data = itemData.itemData || itemData;
            baseName = data.baseType || data.typeLine || "base";
        } catch (e) {
            baseName = "base";
        }
        
        if (!similarQuery && !exactQuery && !baseQuery) {
            return null;
        }
        
        const container = document.createElement("div");
        container.setAttribute("class", "trade-popup-buttons");
        container.setAttribute("style", "display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid hsla(var(--white), 0.2);");
        
        // Similar button with full text
        if (similarQuery) {
            const similarBtn = document.createElement("button");
            similarBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="margin-right: 6px;">${BALANCE_ICON}</svg>Open Similar Trade`;
            similarBtn.setAttribute("class", "button trade-similar-btn");
            similarBtn.setAttribute("title", `Search for items similar to ${itemName} (${similar_percent}% values)`);
            similarBtn.setAttribute("style", "background-color: #b59f3b; border-radius: var(--rounded-sm); padding: 6px 12px; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none; color: white; font-weight: 500; width: 100%;");
            setupPoe2ButtonHandler(similarBtn, similarQuery, itemName);
            container.appendChild(similarBtn);
        }
        
        // Exact button with full text
        if (exactQuery) {
            const exactBtn = document.createElement("button");
            exactBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="margin-right: 6px;">${BALANCE_ICON}</svg>Open Exact Trade`;
            exactBtn.setAttribute("class", "button trade-exact-btn");
            exactBtn.setAttribute("title", `Search for exact match of ${itemName}`);
            exactBtn.setAttribute("style", "background-color: #2d8a4e; border-radius: var(--rounded-sm); padding: 6px 12px; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none; color: white; font-weight: 500; width: 100%;");
            setupPoe2ButtonHandler(exactBtn, exactQuery, itemName);
            container.appendChild(exactBtn);
        }
        
        // Base button with full text
        if (baseQuery) {
            const baseBtn = document.createElement("button");
            baseBtn.innerHTML = `<span style="margin-right: 6px; font-weight: bold;">B</span>Search Base Type Only`;
            baseBtn.setAttribute("class", "button trade-base-btn");
            baseBtn.setAttribute("title", `Search for ${baseName} (no mods - for crafting)`);
            baseBtn.setAttribute("style", "background-color: #3b82f6; border-radius: var(--rounded-sm); padding: 6px 12px; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; border: none; color: white; font-weight: 500; width: 100%;");
            setupPoe2ButtonHandler(baseBtn, baseQuery, baseName);
            container.appendChild(baseBtn);
        }
        
        // Alt key hint
        const hint = document.createElement("div");
        hint.setAttribute("style", "font-size: 10px; color: hsla(var(--white), 0.5); text-align: center; margin-top: 4px;");
        hint.textContent = "Hold Alt to keep popup open";
        container.appendChild(hint);
        
        return container;
    }
    
    /**
     * Setup popup buttons injection for item tooltips
     * Watches for tooltip popups and injects trade buttons
     * @param {HTMLElement} itemContainer The item container element
     * @param {string} item_type Type of item
     * @param {int} item_index Index in the equipment array
     * @param {string} itemName Item name
     */
    function setupPopupButtonsInjection(itemContainer, item_type, item_index, itemName) {
        // Track Alt key state for keeping popup open
        let altPressed = false;
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Alt') altPressed = true;
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === 'Alt') altPressed = false;
        });
        
        // Use MutationObserver to watch for tooltip/popup creation
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Look for tooltip popups - they usually have specific classes or positioning
                        // The tooltip shown in the screenshot appears to be a positioned div
                        const isTooltip = node.classList?.contains('tooltip') || 
                                         node.classList?.contains('popup') ||
                                         node.querySelector?.('[class*="tooltip"]') ||
                                         (node.style?.position === 'fixed' && node.style?.zIndex > 50) ||
                                         (node.tagName === 'DIV' && node.querySelector?.('img[alt]') && node.innerText?.includes('Physical Damage'));
                        
                        if (isTooltip) {
                            // Check if this tooltip is related to our item
                            const tooltipText = node.innerText || '';
                            if (tooltipText.toLowerCase().includes(itemName.toLowerCase()) || 
                                tooltipText.includes('Physical Damage') || 
                                tooltipText.includes('DPS:')) {
                                
                                // Check if buttons already added
                                if (!node.querySelector('.trade-popup-buttons')) {
                                    const popupButtons = gen_poe2_popup_buttons(item_type, item_index, itemName);
                                    if (popupButtons) {
                                        node.appendChild(popupButtons);
                                        
                                        // Keep popup open if Alt is pressed
                                        if (altPressed) {
                                            node.dataset.keepOpen = 'true';
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        
        // Start observing the document body for added nodes
        observer.observe(document.body, { childList: true, subtree: true });
        
        // Also try to inject into existing tooltips on hover
        itemContainer.addEventListener('mouseenter', () => {
            setTimeout(() => {
                // Look for visible tooltips
                const tooltips = document.querySelectorAll('div[style*="position: fixed"], div[style*="position: absolute"][style*="z-index"]');
                for (const tooltip of tooltips) {
                    if (tooltip.innerText?.includes(itemName) && !tooltip.querySelector('.trade-popup-buttons')) {
                        const popupButtons = gen_poe2_popup_buttons(item_type, item_index, itemName);
                        if (popupButtons) {
                            tooltip.appendChild(popupButtons);
                        }
                    }
                }
            }, 100);
        });
    }

    /**
     * Setup click handler for PoE2 trade button
     */
    function setupPoe2ButtonHandler(button, queryString, itemName = "") {
        if (!queryString.startsWith("POE2_QUERY:")) {
            return;
        }
        
        const queryJson = queryString.substring(11);
        button.dataset.poe2Query = queryJson;
        button.dataset.tradeUrl = POE_TRADE_URL;
        button.dataset.itemName = itemName;
        
        button.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const query = JSON.parse(this.dataset.poe2Query);
            const baseUrl = this.dataset.tradeUrl;
            const storedItemName = this.dataset.itemName || "Unknown Item";
            const buttonEl = this;
            const originalHTML = buttonEl.innerHTML;
            
            // Change button to loading state
            buttonEl.textContent = "...";
            buttonEl.disabled = true;
            
            try {
                const currentUrl = window.location.href;
                let league = "Standard";
                
                const leagueMatch = currentUrl.match(/poe\.ninja\/poe2\/builds\/([^\/\?]+)/);
                if (leagueMatch) {
                    let leagueName = decodeURIComponent(leagueMatch[1]);
                    // Handle special league names
                    if (leagueName.toLowerCase() === 'vaal' || leagueName.toLowerCase() === 'fate-of-the-vaal') {
                        league = "Fate of the Vaal";
                    } else {
                        // Convert kebab-case to Title Case
                        league = leagueName.replace(/-/g, ' ').split(' ').map(word => 
                            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                        ).join(' ');
                    }
                } else if (currentUrl.includes("poe2")) {
                    league = "Fate of the Vaal";
                }
                
                console.log("[PoE2 Trade] League detected:", league);
                console.log("[PoE2 Trade] Query:", JSON.stringify(query, null, 2));
                
                chrome.runtime.sendMessage({
                    action: "poe2TradeSearch",
                    query: query,
                    league: league
                }, function(response) {
                    if (response && response.success) {
                        const tradeUrl = `${baseUrl}/${encodeURIComponent(league)}/${response.searchId}`;
                        
                        // Add to history with the trade URL
                        chrome.runtime.sendMessage({
                            action: "addToHistory",
                            name: storedItemName,
                            itemType: buttonEl.classList.contains('trade-similar-btn') ? 'similar' : 
                                     buttonEl.classList.contains('trade-exact-btn') ? 'exact' : 'base',
                            query: query,
                            league: league,
                            tradeUrl: tradeUrl
                        });
                        
                        window.open(tradeUrl, '_blank');
                    } else {
                        const errorMsg = response ? response.error : "No response from extension";
                        console.error("[PoE2 Trade] Error:", errorMsg);
                        showToast("Error searching trade: " + errorMsg, 'error');
                    }
                    
                    // Restore button state
                    buttonEl.innerHTML = originalHTML;
                    buttonEl.disabled = false;
                });
                
            } catch (error) {
                console.error("[PoE2 Trade] Error:", error);
                buttonEl.innerHTML = originalHTML;
                buttonEl.disabled = false;
            }
        });
    }

    /**
     * 將 物品,藥劑,珠寶 的重導向按鈕加入頁面
     * @returns {None}
     */
    async function add_btn_items() {
        dbg_log("[DEBUG] add_btn_items - Starting...");
        dbg_log(`[DEBUG] game_version = ${game_version}`);
        
        // Check if items array exists
        if (!equipment_data["items"] || equipment_data["items"].length === 0) {
            dbg_log("[DEBUG] No items in equipment_data");
            dbg_add_msg_to_page_top("[ERROR] No items found in equipment_data");
            return;
        }
        
        dbg_log(`[DEBUG] equipment_data has ${equipment_data["items"].length} items`);
        
        let itemContainers;
        
        if (game_version === "poe2") {
            // PoE2 structure: Items are in div with "group relative" classes and grid-area style
            // Example: <div class="grid content-center ... group relative ..." style="... grid-area: Weapon; ...">
            
            // Try multiple selectors - the order matters
            // First try the most specific selector that matches the HTML structure
            itemContainers = document.querySelectorAll("div[class*='group'][class*='relative'][style*='grid-area']");
            dbg_log(`[DEBUG] div[class*='group'][class*='relative'][style*='grid-area'] found: ${itemContainers.length}`);
            
            if (itemContainers.length === 0) {
                // Try with grid class
                itemContainers = document.querySelectorAll("div.grid[style*='grid-area']");
                dbg_log(`[DEBUG] div.grid[style*='grid-area'] found: ${itemContainers.length}`);
            }
            
            if (itemContainers.length === 0) {
                // Broader fallback: any div with grid-area in style
                itemContainers = document.querySelectorAll("div[style*='grid-area']");
                dbg_log(`[DEBUG] div[style*='grid-area'] found: ${itemContainers.length}`);
            }
            
            // Debug: log all found containers
            console.log(`[Vaal Trade] Found ${itemContainers.length} potential item containers`);
            for (let i = 0; i < Math.min(5, itemContainers.length); i++) {
                const c = itemContainers[i];
                console.log(`[Vaal Trade] Container ${i}: class="${c.className}", style="${c.getAttribute('style')?.substring(0, 100)}..."`);
            }
            
            if (itemContainers.length > 0) {
                dbg_add_msg_to_page_top(`[DEBUG] Found ${itemContainers.length} item slots`);
                
                // Map grid-area names to item slots for proper ordering
                const gridAreaToSlot = {
                    'Weapon': 0,
                    'Weapon2': 1, 
                    'Offhand': 2,
                    'Offhand2': 3,
                    'Helm': 4,
                    'BodyArmour': 5,
                    'Gloves': 6,
                    'Boots': 7,
                    'Amulet': 8,
                    'Ring': 9,
                    'Ring2': 10,
                    'Belt': 11
                };
                
                // Create array to store items in correct order
                const orderedContainers = [];
                
                for (const container of itemContainers) {
                    const style = container.getAttribute('style') || '';
                    const gridAreaMatch = style.match(/grid-area:\s*([^;]+)/);
                    if (gridAreaMatch) {
                        const gridArea = gridAreaMatch[1].trim();
                        dbg_log(`[DEBUG] Found item container with grid-area: ${gridArea}`);
                        orderedContainers.push({
                            element: container,
                            gridArea: gridArea
                        });
                    }
                }
                
                dbg_log(`[DEBUG] Ordered containers: ${orderedContainers.length}`);
                
                // Add buttons to each item container
                for (let i = 0; i < equipment_data["items"].length; i++) {
                    const item = equipment_data["items"][i];
                    const itemSlot = item["itemSlot"];
                    const inventoryId = item["inventoryId"] || item.itemData?.inventoryId;
                    const itemData = item.itemData || item;
                    const itemName = itemData.name || itemData.typeLine || "Item";
                    
                    dbg_log(`[DEBUG] Processing item ${i}: slot=${itemSlot}, inventoryId=${inventoryId}`);
                    
                    // Find matching container by inventoryId (grid-area name)
                    const matchingContainer = orderedContainers.find(c => 
                        c.gridArea === inventoryId || 
                        c.gridArea.toLowerCase() === inventoryId?.toLowerCase()
                    );
                    
                    if (matchingContainer) {
                        // Determine button position based on item type
                        // Use "right" for small items (rings, amulet, belt) to avoid overflow
                        const smallItems = ['Ring', 'Ring2', 'Amulet', 'Belt'];
                        const btnPosition = smallItems.includes(matchingContainer.gridArea) ? "right" : "top";
                        
                        // Use dual button system for PoE2
                        const buttonsContainer = gen_poe2_trade_buttons("items", i, btnPosition, itemName);
                        
                        // Skip if no buttons were created (null query)
                        if (!buttonsContainer) {
                            dbg_log(`[DEBUG] No buttons created for item ${i} - skipping`);
                            continue;
                        }
                        
                        // Add buttons to the container (always visible now)
                        matchingContainer.element.style.position = 'relative';
                        matchingContainer.element.appendChild(buttonsContainer);
                        
                        // Setup popup buttons injection
                        setupPopupButtonsInjection(matchingContainer.element, "items", i, itemName);
                        
                        dbg_log(`[DEBUG] Added trade buttons to ${matchingContainer.gridArea}`);
                    } else {
                        dbg_log(`[DEBUG] No matching container for inventoryId=${inventoryId}`);
                    }
                }
                
                // Also process jewels for PoE2
                if (equipment_data["jewels"] && equipment_data["jewels"].length > 0) {
                    dbg_log(`[DEBUG] Processing ${equipment_data["jewels"].length} jewels for PoE2`);
                    
                    // Find jewel containers - look for rounded-sm divs with item colors in style
                    // Example: <div class="rounded-sm" style="--aspect-ratio: 1; background-color: hsla(var(--item-rare),...">
                    let jewelContainers = document.querySelectorAll("div.rounded-sm[style*='item-']");
                    
                    if (jewelContainers.length === 0) {
                        // Fallback: any rounded-sm div with img inside
                        jewelContainers = document.querySelectorAll("div.rounded-sm:has(img[alt*='Jewel']), div.rounded-sm:has(img[alt*='Sapphire']), div.rounded-sm:has(img[alt*='Ruby']), div.rounded-sm:has(img[alt*='Emerald'])");
                    }
                    
                    dbg_log(`[DEBUG] Found ${jewelContainers.length} potential jewel containers`);
                    console.log(`[Vaal Trade] Found ${jewelContainers.length} jewel containers`);
                    
                    for (let i = 0; i < equipment_data["jewels"].length; i++) {
                        const jewel = equipment_data["jewels"][i];
                        const jewelData = jewel.itemData || jewel;
                        const jewelName = jewelData.name || jewelData.typeLine || "Jewel";
                        
                        dbg_log(`[DEBUG] Processing jewel ${i}: ${jewelName}`);
                        
                        // Try to find jewel container by image alt or by index
                        let jewelContainer = null;
                        
                        // First try: find by image alt text
                        for (const container of jewelContainers) {
                            const img = container.querySelector('img');
                            if (img && img.alt && (img.alt.includes(jewelName) || jewelName.includes(img.alt))) {
                                jewelContainer = container;
                                break;
                            }
                        }
                        
                        // Fallback: use index if we have matching count
                        if (!jewelContainer && jewelContainers.length > i) {
                            jewelContainer = jewelContainers[i];
                        }
                        
                        if (jewelContainer) {
                            const buttonsContainer = gen_poe2_trade_buttons("jewels", i, "right", jewelName);
                            
                            if (buttonsContainer) {
                                jewelContainer.style.position = 'relative';
                                jewelContainer.appendChild(buttonsContainer);
                                setupPopupButtonsInjection(jewelContainer, "jewels", i, jewelName);
                                dbg_log(`[DEBUG] Added jewel buttons for ${jewelName}`);
                            }
                        } else {
                            dbg_log(`[DEBUG] No container found for jewel: ${jewelName}`);
                        }
                    }
                }
                
                // Process flasks for PoE2
                if (equipment_data["flasks"] && equipment_data["flasks"].length > 0) {
                    dbg_log(`[DEBUG] Processing ${equipment_data["flasks"].length} flasks for PoE2`);
                    
                    // Find flask containers - look for grid areas containing Flask
                    const flaskContainers = document.querySelectorAll("div[style*='grid-area'][style*='Flask'] div.group.relative, div.gap-inherit[style*='Flask'] div.group.relative");
                    dbg_log(`[DEBUG] Found ${flaskContainers.length} potential flask containers`);
                    
                    for (let i = 0; i < equipment_data["flasks"].length; i++) {
                        const flask = equipment_data["flasks"][i];
                        const flaskData = flask.itemData || flask;
                        const flaskName = flaskData.name || flaskData.typeLine || "Flask";
                        
                        dbg_log(`[DEBUG] Processing flask ${i}: ${flaskName}`);
                        
                        if (flaskContainers.length > i) {
                            const flaskContainer = flaskContainers[i];
                            const buttonsContainer = gen_poe2_trade_buttons("flasks", i, "right", flaskName);
                            
                            if (buttonsContainer) {
                                flaskContainer.style.position = 'relative';
                                flaskContainer.appendChild(buttonsContainer);
                                setupPopupButtonsInjection(flaskContainer, "flasks", i, flaskName);
                                dbg_log(`[DEBUG] Added flask buttons for ${flaskName}`);
                            }
                        }
                    }
                }
                
                // Process charms for PoE2
                if (equipment_data["charms"] && equipment_data["charms"].length > 0) {
                    dbg_log(`[DEBUG] Processing ${equipment_data["charms"].length} charms for PoE2`);
                    
                    // Find the "OTHER" section which contains charms
                    // Charms are in the section after jewels, with similar structure
                    const otherSection = Array.from(document.querySelectorAll('div')).find(div => 
                        div.innerText?.trim().startsWith('OTHER'));
                    
                    let charmContainers = [];
                    if (otherSection) {
                        // Find all item containers within the OTHER section (siblings after the header)
                        let sibling = otherSection.nextElementSibling;
                        while (sibling) {
                            const itemDivs = sibling.querySelectorAll('div.rounded-sm[style*="item"], div.group.relative');
                            if (itemDivs.length > 0) {
                                charmContainers = [...charmContainers, ...itemDivs];
                            }
                            sibling = sibling.nextElementSibling;
                        }
                    }
                    
                    // Fallback: look for charm-like containers by their characteristics
                    if (charmContainers.length === 0) {
                        // Charms might be in containers with specific backgrounds
                        charmContainers = document.querySelectorAll('div.rounded-sm[style*="item-magic"], div.rounded-sm[style*="item-unique"]');
                        // Filter out jewels (which we already processed)
                        const jewelCount = equipment_data["jewels"]?.length || 0;
                        if (charmContainers.length > jewelCount) {
                            charmContainers = Array.from(charmContainers).slice(jewelCount);
                        }
                    }
                    
                    dbg_log(`[DEBUG] Found ${charmContainers.length} potential charm containers`);
                    
                    for (let i = 0; i < equipment_data["charms"].length; i++) {
                        const charm = equipment_data["charms"][i];
                        const charmData = charm.itemData || charm;
                        const charmName = charmData.name || charmData.typeLine || "Charm";
                        
                        dbg_log(`[DEBUG] Processing charm ${i}: ${charmName}`);
                        
                        // Try to find container by image alt text first
                        let charmContainer = null;
                        for (const container of charmContainers) {
                            const img = container.querySelector('img');
                            if (img && img.alt && (img.alt.includes(charmName) || charmName.includes(img.alt))) {
                                charmContainer = container;
                                break;
                            }
                        }
                        
                        // Fallback: use index
                        if (!charmContainer && charmContainers.length > i) {
                            charmContainer = charmContainers[i];
                        }
                        
                        if (charmContainer) {
                            const buttonsContainer = gen_poe2_trade_buttons("charms", i, "top", charmName);
                            
                            if (buttonsContainer) {
                                charmContainer.style.position = 'relative';
                                charmContainer.appendChild(buttonsContainer);
                                setupPopupButtonsInjection(charmContainer, "charms", i, charmName);
                                dbg_log(`[DEBUG] Added charm buttons for ${charmName}`);
                            }
                        }
                    }
                }
                
                return; // Done with PoE2 items
            }
        }
        
        // Original PoE1 logic
        const buttons = document.body.querySelectorAll("div.p-6:nth-child(2) button[title~=Copy]");
        console.log(buttons);

        let offset = 0;

        // items buttons
        for (let i = 0; i < equipment_data["items"].length; i++) {
            let slot_num = equipment_data["items"][i]["itemSlot"];

            var target_query = gen_item_target_query_str("items", i);
            if ([1, 2, 3, 5, 6, 7, 10].includes(slot_num)) var new_node = gen_btn_trade_element(target_query, "top");
            else var new_node = gen_btn_trade_element(target_query, "bottom");

            buttons[i].insertAdjacentElement("afterend", new_node);
        }

        offset += equipment_data["items"].length;

        // flasks buttons
        for (let i = 0; i < equipment_data["flasks"].length; i++) {
            var target_query = gen_item_target_query_str("flasks", i);
            var new_node = gen_btn_trade_element(target_query, "bottom");

            buttons[offset + equipment_data["flasks"][i]["itemData"]["x"]].insertAdjacentElement("afterend", new_node);
        }

        offset += equipment_data["flasks"].length;

        // jewels buttons
        let jewels_names = [];
        let jewels_nodes = document.body.querySelectorAll("div.p-6:nth-child(2) > div:nth-child(2) > div > div > div > div > div > div:nth-child(2)");
        for (let node of jewels_nodes) {
            const jewel_name = node.innerText.trim();
            jewels_names.push(jewel_name);
        }
        dbg_log(jewels_names);

        for (let i = 0; i < equipment_data["jewels"].length; i++) {
            let jewel_name = "";
            if (equipment_data["jewels"][i]["itemData"]["synthesised"]) {
                jewel_name = equipment_data["jewels"][i]["itemData"]["name"] + " " + equipment_data["jewels"][i]["itemData"]["typeLine"];
            } else {
                jewel_name = equipment_data["jewels"][i]["itemData"]["name"] + " " + equipment_data["jewels"][i]["itemData"]["baseType"];
            }
            jewel_name = jewel_name.trim()

            var target_query = gen_item_target_query_str("jewels", i);
            var new_node = gen_btn_trade_element(target_query, "bottom");

            buttons[offset + jewels_names.indexOf(jewel_name)].insertAdjacentElement("afterend", new_node);

            jewels_names[jewels_names.indexOf(jewel_name)] = "";
        }
    };

    /**
     * 將 技能寶石 的重導向按鈕加入頁面
     * @returns {None}
     */
    async function add_btn_skills() {
        const btns = document.body.querySelectorAll("div[style='flex: 1 1 auto;']");

        let btns_count = 0;
        for (const skill_section of equipment_data["skills"]) {
            for (const gem of skill_section["allGems"]) {
                if (!("itemData" in gem)) {
                    btns_count += 1;
                    continue
                }

                const target_query = gen_skills_target_query_str(gem.name, gem.level, gem.quality, redirect_to);
                const btn = gen_btn_trade_element(target_query, "skills");
                const btn_span = gen_btn_span_element();

                btns[btns_count].prepend(btn_span);
                btns[btns_count].prepend(btn);
                btns_count += 1;
            }
        }
    };

    /**
     * 將 msg 直接 push_front 到頁面最上方
     * @param {string} msg 要加在頁面最上方的 msg
     * @returns {None}
     */
    function dbg_add_msg_to_page_top(msg) {
        if (!is_debugging) return;

        const new_node = document.createElement("p");
        new_node.setAttribute("style", "width: max-content; max-width: none;");
        new_node.innerHTML = msg;

        document.querySelectorAll("header#header")[0].prepend(new_node);
    };

    /**
     * 英文詞墜翻成中文詞墜
     * @param {string} mod_string 要翻譯的英文詞墜
     * @returns {string} 翻譯成中文的詞墜
     */
    function translate_mod(mod_string) {
        dbg_log(`[Tippy Item] mod_string = "${mod_string}", lang_matching[mod_string] = "${lang_matching[mod_string]}"`);
        if (lang_matching[mod_string]) return lang_matching[mod_string];
        else return mod_string;
    }

    dbg_log(equipment_data);

    dbg_add_msg_to_page_top("[DEBUGGING]");

    // 將所有物品的重導向按鈕加入頁面
    try {
        dbg_log("[DEBUG] Starting add_btn_items...");
        dbg_add_msg_to_page_top("[DEBUG] Starting button injection...");
        await add_btn_items();
        dbg_log("[DEBUG] add_btn_items completed");
        // Skip skills for PoE2 - not needed
        if (game_version !== "poe2") {
            await add_btn_skills();
            dbg_log("[DEBUG] add_btn_skills completed");
        }
        dbg_add_msg_to_page_top("[DEBUG] Button injection completed!");
    } catch (e) {
        dbg_warn(e);
        dbg_add_msg_to_page_top(`[ERROR] ${e.message}`);
        console.error("[PoE Ninja Redirect] Error:", e);
    }

    // ============== OPEN ALL ITEMS BUTTON ==============
    /**
     * Create floating "Open All" button to search all items at once
     */
    function createOpenAllButton() {
        // Create container
        const container = document.createElement("div");
        container.id = "vaal-open-all-container";
        container.innerHTML = `
            <style>
                #vaal-open-all-container {
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    z-index: 10000;
                    font-family: 'Segoe UI', sans-serif;
                }
                #vaal-open-all-btn {
                    background: linear-gradient(135deg, #b59f3b 0%, #8b7a2e 100%);
                    color: white;
                    border: none;
                    padding: 12px 20px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                    transition: all 0.2s;
                }
                #vaal-open-all-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 20px rgba(0,0,0,0.4);
                    filter: brightness(1.1);
                }
                #vaal-open-all-btn:disabled {
                    background: #555;
                    cursor: not-allowed;
                    transform: none;
                }
                #vaal-progress-container {
                    display: none;
                    margin-top: 10px;
                    background: rgba(26, 26, 46, 0.95);
                    border-radius: 8px;
                    padding: 12px;
                    min-width: 220px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                }
                #vaal-progress-bar {
                    width: 100%;
                    height: 8px;
                    background: #333;
                    border-radius: 4px;
                    overflow: hidden;
                    margin-bottom: 8px;
                }
                #vaal-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #b59f3b, #f0c000);
                    width: 0%;
                    transition: width 0.3s;
                }
                #vaal-progress-text {
                    font-size: 12px;
                    color: #aaa;
                    text-align: center;
                }
                #vaal-progress-status {
                    font-size: 11px;
                    color: #888;
                    text-align: center;
                    margin-top: 4px;
                }
                .vaal-cancel-btn {
                    background: #c0392b;
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                    margin-top: 8px;
                    width: 100%;
                }
                .vaal-cancel-btn:hover {
                    background: #e74c3c;
                }
            </style>
            <button id="vaal-open-all-btn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
                </svg>
                Open All Items
            </button>
            <div id="vaal-progress-container">
                <div id="vaal-progress-bar">
                    <div id="vaal-progress-fill"></div>
                </div>
                <div id="vaal-progress-text">Preparing...</div>
                <div id="vaal-progress-status"></div>
                <button class="vaal-cancel-btn" id="vaal-cancel-btn">Cancel</button>
            </div>
        `;
        
        document.body.appendChild(container);
        
        // Variables for cancellation
        let isCancelled = false;
        
        // Cancel button handler
        document.getElementById("vaal-cancel-btn").addEventListener("click", () => {
            isCancelled = true;
            document.getElementById("vaal-progress-status").textContent = "Cancelling...";
        });
        
        // Main button handler
        document.getElementById("vaal-open-all-btn").addEventListener("click", async () => {
            const btn = document.getElementById("vaal-open-all-btn");
            const progressContainer = document.getElementById("vaal-progress-container");
            const progressFill = document.getElementById("vaal-progress-fill");
            const progressText = document.getElementById("vaal-progress-text");
            const progressStatus = document.getElementById("vaal-progress-status");
            
            // Reset state
            isCancelled = false;
            btn.disabled = true;
            btn.innerHTML = `<span>Processing...</span>`;
            progressContainer.style.display = "block";
            progressFill.style.width = "0%";
            progressText.textContent = "Collecting items...";
            progressStatus.textContent = "";
            
            try {
                // Collect all item queries
                const itemQueries = [];
                const itemTypes = ["items", "jewels", "flasks", "charms"];
                
                for (const itemType of itemTypes) {
                    if (!equipment_data[itemType]) continue;
                    
                    for (let i = 0; i < equipment_data[itemType].length; i++) {
                        const query = gen_item_target_query_str(itemType, i, "similar");
                        if (query && query.startsWith("POE2_QUERY:")) {
                            const itemData = equipment_data[itemType][i];
                            const data = itemData.itemData || itemData;
                            const name = data.name || data.typeLine || `${itemType} ${i}`;
                            itemQueries.push({
                                query: query,
                                name: name,
                                type: itemType
                            });
                        }
                    }
                }
                
                if (itemQueries.length === 0) {
                    progressText.textContent = "No items found!";
                    setTimeout(() => {
                        progressContainer.style.display = "none";
                        btn.disabled = false;
                        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg> Open All Items`;
                    }, 2000);
                    return;
                }
                
                progressText.textContent = `Found ${itemQueries.length} items`;
                
                // Get league from URL
                const currentUrl = window.location.href;
                let league = "Standard";
                const leagueMatch = currentUrl.match(/poe\.ninja\/poe2\/builds\/([^\/\?]+)/);
                if (leagueMatch) {
                    let leagueName = decodeURIComponent(leagueMatch[1]);
                    if (leagueName.toLowerCase() === 'vaal' || leagueName.toLowerCase() === 'fate-of-the-vaal') {
                        league = "Fate of the Vaal";
                    } else {
                        league = leagueName.replace(/-/g, ' ').split(' ').map(word => 
                            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
                        ).join(' ');
                    }
                } else if (currentUrl.includes("poe2")) {
                    league = "Fate of the Vaal";
                }
                
                // Check for user league preference
                const leagueStorage = await chrome.storage.local.get(["trade-league"]);
                const leaguePref = leagueStorage["trade-league"];
                if (leaguePref && leaguePref !== "auto") {
                    league = leaguePref;
                }
                
                const baseUrl = POE_TRADE_URL;
                const BASE_DELAY = 12000; // 12 seconds between requests (PoE API rate limit is ~5 requests per minute for search)
                
                let successCount = 0;
                let errorCount = 0;
                let currentDelay = BASE_DELAY;
                
                // Process items with rate limiting
                for (let i = 0; i < itemQueries.length; i++) {
                    if (isCancelled) {
                        progressText.textContent = `Cancelled! Opened ${successCount} items.`;
                        break;
                    }
                    
                    const item = itemQueries[i];
                    const progress = ((i + 1) / itemQueries.length * 100).toFixed(0);
                    progressFill.style.width = `${progress}%`;
                    progressText.textContent = `Processing ${i + 1}/${itemQueries.length}`;
                    progressStatus.textContent = `${item.name}`;
                    
                    let retryCount = 0;
                    const maxRetries = 3;
                    let success = false;
                    
                    while (!success && retryCount < maxRetries && !isCancelled) {
                        try {
                            const queryJson = item.query.substring(11); // Remove "POE2_QUERY:" prefix
                            const query = JSON.parse(queryJson);
                            
                            // Send to background script
                            const response = await new Promise((resolve) => {
                                chrome.runtime.sendMessage({
                                    action: "poe2TradeSearch",
                                    query: query,
                                    league: league
                                }, resolve);
                            });
                            
                            if (response && response.success) {
                                const tradeUrl = `${baseUrl}/${encodeURIComponent(league)}/${response.searchId}`;
                                // Open tab in background (not focused)
                                chrome.runtime.sendMessage({
                                    action: "openTabInBackground",
                                    url: tradeUrl
                                });
                                successCount++;
                                success = true;
                                currentDelay = BASE_DELAY; // Reset delay on success
                            } else if (response?.error?.includes("429") || response?.error?.includes("Rate limit")) {
                                // Rate limited - extract wait time if possible
                                const waitMatch = response.error.match(/wait (\d+) seconds/i);
                                let waitTime = waitMatch ? (parseInt(waitMatch[1]) + 5) * 1000 : 65000; // Add 5s buffer
                                waitTime = Math.max(waitTime, 60000); // Minimum 60 seconds
                                waitTime = Math.min(waitTime, 180000); // Max 3 minutes
                                
                                progressStatus.textContent = `Rate limited - waiting ${Math.ceil(waitTime/1000)}s...`;
                                
                                // Countdown display
                                const startWait = Date.now();
                                while (Date.now() - startWait < waitTime && !isCancelled) {
                                    const remaining = Math.ceil((waitTime - (Date.now() - startWait)) / 1000);
                                    progressStatus.textContent = `Rate limited - waiting ${remaining}s...`;
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                
                                retryCount++;
                                currentDelay = Math.min(currentDelay * 2, 30000); // Double delay up to 30s after rate limit
                            } else {
                                console.error(`[Open All] Error for ${item.name}:`, response?.error);
                                errorCount++;
                                success = true; // Don't retry non-rate-limit errors
                            }
                        } catch (err) {
                            console.error(`[Open All] Error processing ${item.name}:`, err);
                            errorCount++;
                            success = true; // Don't retry on exception
                        }
                    }
                    
                    if (retryCount >= maxRetries) {
                        console.error(`[Open All] Max retries reached for ${item.name}`);
                        errorCount++;
                    }
                    
                    // Rate limit delay (except for last item)
                    if (i < itemQueries.length - 1 && !isCancelled) {
                        progressStatus.textContent = `Waiting ${Math.ceil(currentDelay/1000)}s for rate limit...`;
                        await new Promise(r => setTimeout(r, currentDelay));
                    }
                }
                
                // Complete
                progressFill.style.width = "100%";
                if (!isCancelled) {
                    progressText.textContent = `Done! Opened ${successCount} items.`;
                    if (errorCount > 0) {
                        progressStatus.textContent = `${errorCount} errors`;
                    } else {
                        progressStatus.textContent = "All items opened successfully!";
                    }
                }
                
            } catch (error) {
                console.error("[Open All] Error:", error);
                progressText.textContent = `Error: ${error.message}`;
            }
            
            // Reset button after delay
            setTimeout(() => {
                progressContainer.style.display = "none";
                btn.disabled = false;
                btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg> Open All Items`;
            }, 3000);
        });
    }
    
    // Toast helper
    function showToastError(msg) {
        if (typeof Toastify !== "undefined") {
            Toastify({
                text: msg,
                duration: 4000,
                gravity: "top",
                position: "center",
                backgroundColor: "#c0392b",
                stopOnFocus: true
            }).showToast();
        } else {
            // fallback
            console.error(msg);
        }
    }
    
    dbg_log(lang_matching);

    // [Tippy Observers]
    const tippy_mods_record_callbacks = new Map();
    const tippy_mods_record = new Proxy({}, {
        set(target, key, value, receiver) {
            dbg_log(`[TIPPY MODS RECORD] key = ${key}, value = ${value}`);
            target[key] = value;

            // 如果有人在等這個 key，就觸發 callback
            if (tippy_mods_record_callbacks.has(key)) {
                const callbacks = tippy_mods_record_callbacks.get(key);
                callbacks();
                tippy_mods_record_callbacks.delete(key);
            }
        }
    });
    const translated_tippy_id = new Set();

    function translate_node(node) {
        const tippy_id = node.id;
        if (translated_tippy_id.has(tippy_id)) return;

        const section = node.querySelectorAll("div._item-body_1tb3h_1 section");
        if (section.length < 5) return;  // 此 Node 不是裝備的 tippy

        const enchant = section[2]?.querySelectorAll("div div")[0];
        const enchant_all = enchant?.querySelectorAll("div") || [];
        const implicit = section[3]?.querySelectorAll("div#implicit")[0];
        const implicit_all = section[3]?.querySelectorAll("div > div") || [];
        const explicit = section[4]?.querySelectorAll("div#explicit")[0];
        const explicit_all = section[4]?.querySelectorAll("div > div") || [];

        let mod_text = "";
        for (const mod_type of [enchant, implicit, explicit]) {
            if (mod_type !== undefined) mod_text += mod_type["textContent"];
        }
        tippy_mods_record[tippy_id] = mod_text;

        let translated = false;
        if (now_lang === "en") return;
        for (const ele of [...enchant_all, ...implicit_all, ...explicit_all]) {
            translated = true;

            const lang_mod_string = translate_mod(ele.innerText);

            if (["zh-tw", "ko", "ru"].includes(now_lang)) {
                ele.innerText = lang_mod_string;
            }
            else if (["en-zh-tw", "en-ko", "en-ru"].includes(now_lang) && ele.innerText !== lang_mod_string) {
                ele.innerText += "\n" + lang_mod_string;
            }
        }

        if (translated)
            translated_tippy_id.add(tippy_id);
    }

    function waiting_tippy_data(node) {
        dbg_log(node.innerHTML);
        if (node.innerText !== "") {
            dbg_log("tippy data already received, translate now");
            translate_node(node);
            return;
        }

        const content_observer = new MutationObserver((mutationRecords, observer) => {
            // XXX: 現在還是會觀察到兩次這個 node 的變化，不太確定是什麼原因
            // dbg_log(node.innerHTML);
            dbg_log("triggered tippy content observer");
            observer.disconnect();
            queueMicrotask(() => { translate_node(node); });  // 放到下一次的微任務中，確保 observer 已經斷開連線
        });

        content_observer.observe(node, {
            childList: true,
            subtree: true,
        });
    }

    const observer = new MutationObserver(mutationRecords => {
        for (const mutationRecord of mutationRecords) {
            for (const addedNode of mutationRecord["addedNodes"]) {
                waiting_tippy_data(addedNode);
            }
        }
    });
    observer.observe(document.body, {
        childList: true
    });

};

// 初始化所需設定
chrome.runtime.onInstalled.addListener(init_status);

// 當頁面建立或重新整理時，擷取送出的封包以取得能拿到角色資料的 api 網址
chrome.webRequest.onBeforeRequest.addListener(fetch_character_data, API_URLS_FILTER);

// Handle profile and builds pages directly (PoE2 uses EventSource which isn't caught by webRequest)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url) return;
    
    console.log(`[PoE Ninja Redirect] Tab updated: ${tab.url}`);
    
    // Match profile URLs for both PoE1 and PoE2
    // Format: https://poe.ninja/poe2/profile/{account}/character/{character}
    const profileMatch = tab.url.match(/https:\/\/poe\.ninja\/(poe[12])\/profile\/([^\/]+)\/character\/([^\/\?]+)/);
    
    // Match builds URLs for both PoE1 and PoE2 with name parameter
    // Format: https://poe.ninja/poe2/builds/{league}?class=...&name={account}/{character}
    const buildsMatch = tab.url.match(/https:\/\/poe\.ninja\/(poe[12])\/builds\/([^\/\?]+).*[?&]name=([^\/&]+)\/([^&]+)/);
    
    // Also match builds URLs without name parameter (when viewing a character from the list)
    // We'll need to intercept the API call in this case
    const buildsPageMatch = tab.url.match(/https:\/\/poe\.ninja\/(poe[12])\/builds\/([^\/\?]+)/);
    
    if (profileMatch) {
        const gameVersion = profileMatch[1]; // "poe1" or "poe2"
        const accountName = profileMatch[2];
        const characterName = profileMatch[3];
        
        console.log(`[PoE Ninja Redirect] Profile page detected: ${gameVersion}, account: ${accountName}, character: ${characterName}`);
        
        // Inject a script that listens to the EventSource and sends data back
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: interceptEventSource,
            args: [gameVersion, accountName, characterName]
        });
    } else if (buildsMatch) {
        const gameVersion = buildsMatch[1]; // "poe1" or "poe2"
        const league = buildsMatch[2];
        const accountName = decodeURIComponent(buildsMatch[3]);
        const characterName = decodeURIComponent(buildsMatch[4]);
        
        console.log(`[PoE Ninja Redirect] Builds page with character detected: ${gameVersion}, league: ${league}, account: ${accountName}, character: ${characterName}`);
        
        // Inject a script that listens to the EventSource and sends data back
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: interceptEventSource,
            args: [gameVersion, accountName, characterName]
        });
    } else if (buildsPageMatch) {
        // Builds page without specific character - inject interceptor that watches for API calls
        const gameVersion = buildsPageMatch[1];
        const league = buildsPageMatch[2];
        
        console.log(`[PoE Ninja Redirect] Builds list page detected: ${gameVersion}, league: ${league}`);
        
        // Inject a script that intercepts network requests for character data
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: interceptBuildsPageNetworkRequests,
            args: [gameVersion, league]
        });
    }
});

/**
 * Injected function to intercept EventSource data on the page
 * Works for both profile pages (EventSource) and builds pages (fetch API)
 */
function interceptEventSource(gameVersion, accountName, characterName) {
    const eventSourceUrl = `https://poe.ninja/${gameVersion}/api/events/character/${accountName}/${characterName}`;
    const buildsApiUrl = `https://poe.ninja/${gameVersion}/api/builds/${accountName}/character?name=${characterName}`;
    
    console.log(`[PoE Ninja Redirect] Setting up data interceptor`);
    console.log(`[PoE Ninja Redirect] EventSource URL: ${eventSourceUrl}`);
    console.log(`[PoE Ninja Redirect] Builds API URL: ${buildsApiUrl}`);
    
    // Check if already intercepted
    if (window.__poeNinjaIntercepted) {
        console.log(`[PoE Ninja Redirect] Already intercepted, skipping`);
        return;
    }
    window.__poeNinjaIntercepted = true;
    
    // Function to send data to background
    function sendDataToBackground(data) {
        console.log(`[PoE Ninja Redirect] Found character data, sending to background`);
        chrome.runtime.sendMessage({
            type: 'POE_NINJA_CHARACTER_DATA',
            gameVersion: gameVersion,
            data: data
        });
    }
    
    // Try EventSource first (for profile pages)
    const OriginalEventSource = window.EventSource;
    try {
        const es = new OriginalEventSource(eventSourceUrl);
        
        es.onmessage = (event) => {
            console.log(`[PoE Ninja Redirect] Received EventSource data`);
            try {
                const data = JSON.parse(event.data);
                if (data && (data.items || data.equipment || data.jewels)) {
                    sendDataToBackground(data);
                    es.close();
                }
            } catch (e) {
                console.log(`[PoE Ninja Redirect] EventSource data not JSON or no items:`, e);
            }
        };
        
        es.onerror = (e) => {
            console.warn(`[PoE Ninja Redirect] EventSource error, trying fetch API:`, e);
            es.close();
            
            // Fallback: try fetch API for builds pages
            tryFetchApi();
        };
        
        // Also set a timeout to try fetch API if EventSource doesn't respond
        setTimeout(() => {
            if (!window.__poeNinjaDataReceived) {
                console.log(`[PoE Ninja Redirect] EventSource timeout, trying fetch API`);
                es.close();
                tryFetchApi();
            }
        }, 3000);
        
    } catch (e) {
        console.warn(`[PoE Ninja Redirect] EventSource failed:`, e);
        tryFetchApi();
    }
    
    // Function to try fetch API (for builds pages)
    async function tryFetchApi() {
        if (window.__poeNinjaDataReceived) return;
        
        try {
            console.log(`[PoE Ninja Redirect] Trying fetch API: ${buildsApiUrl}`);
            const response = await fetch(buildsApiUrl);
            if (response.ok) {
                const data = await response.json();
                if (data && (data.items || data.equipment || data.jewels)) {
                    window.__poeNinjaDataReceived = true;
                    sendDataToBackground(data);
                }
            }
        } catch (e) {
            console.warn(`[PoE Ninja Redirect] Fetch API failed:`, e);
        }
    }
}

/**
 * Injected function to intercept network requests on builds pages
 * This watches for character data API calls when user selects a character from the list
 */
function interceptBuildsPageNetworkRequests(gameVersion, league) {
    console.log(`[PoE Ninja Redirect] Setting up network interceptor for builds page: ${gameVersion}/${league}`);
    
    // Check if already intercepted
    if (window.__poeNinjaNetworkIntercepted) {
        console.log(`[PoE Ninja Redirect] Network already intercepted, skipping`);
        return;
    }
    window.__poeNinjaNetworkIntercepted = true;
    
    // Intercept fetch requests
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0];
        
        // Check if this is a character API call
        if (typeof url === 'string' && url.includes('/api/builds/') && url.includes('/character')) {
            console.log(`[PoE Ninja Redirect] Intercepted character API call: ${url}`);
            
            // Clone response to read it without consuming it
            const clonedResponse = response.clone();
            try {
                const data = await clonedResponse.json();
                if (data && (data.items || data.equipment || data.jewels)) {
                    console.log(`[PoE Ninja Redirect] Found character data in fetch response`);
                    chrome.runtime.sendMessage({
                        type: 'POE_NINJA_CHARACTER_DATA',
                        gameVersion: gameVersion,
                        data: data
                    });
                }
            } catch (e) {
                console.log(`[PoE Ninja Redirect] Could not parse fetch response:`, e);
            }
        }
        
        return response;
    };
    
    // Also intercept XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._poeNinjaUrl = url;
        return originalXHROpen.apply(this, [method, url, ...rest]);
    };
    
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            if (this._poeNinjaUrl && this._poeNinjaUrl.includes('/api/builds/') && this._poeNinjaUrl.includes('/character')) {
                console.log(`[PoE Ninja Redirect] Intercepted XHR character API call: ${this._poeNinjaUrl}`);
                try {
                    const data = JSON.parse(this.responseText);
                    if (data && (data.items || data.equipment || data.jewels)) {
                        console.log(`[PoE Ninja Redirect] Found character data in XHR response`);
                        chrome.runtime.sendMessage({
                            type: 'POE_NINJA_CHARACTER_DATA',
                            gameVersion: gameVersion,
                            data: data
                        });
                    }
                } catch (e) {
                    console.log(`[PoE Ninja Redirect] Could not parse XHR response:`, e);
                }
            }
        });
        return originalXHRSend.apply(this, args);
    };
    
    console.log(`[Vaal Trade] Network interceptor installed`);
}

/**
 * Direct version of fetch_character_data that accepts pre-fetched data
 */
async function fetch_character_data_direct(details, equipment_data) {
    if (details.tabId === -1) return;
    if (!equipment_data) return;

    const api_url = details.url;
    console.log(`[Vaal Trade] Processing data from: ${api_url}`);

    const local_loader = new LocalDataLoader();
    await local_loader.update_data();

    // PoE2 data only
    let query_data, gems_query_data, stats_data;
    
    try {
        query_data = await local_loader.get_data("local_poe2_query_data");
        gems_query_data = await local_loader.get_data("local_poe2_gems_query_data");
        stats_data = await local_loader.get_data("local_poe2_stats_data");
    } catch (e) {
        console.error("Failed to load PoE2 data:", e);
        return;
    }

    chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        function: inject_script,
        args: [
            stats_data,
            {},
            {},
            query_data,
            gems_query_data,
            equipment_data,
            "poe2"
        ],
    });
}