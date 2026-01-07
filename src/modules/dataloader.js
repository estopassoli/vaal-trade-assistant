import { get_status, set_status } from "./storage_utils.js";

class LocalDataLoader {
    // PoE2 paths only
    static POE2_STATS_DATA_PATH = "./data/poe2/poe2_stats.min.json";
    static POE2_QUERY_PATH = "./data/poe2/query.json";
    static POE2_GEMS_QUERY_PATH = "./data/poe2/query_gems.json";

    async _fetch_json(path) {
        let res = null;
        try {
            const response = await fetch(path);
            if (response.ok) {
                res = await response.json();
            }
        } catch (e) {
            console.warn(`Failed to fetch ${path}:`, e);
        }
        return res;
    }

    async _can_fetch_again() {
        const data = await get_status("local_poe2_query_data");
        if (data === undefined || data === null) {
            return true;
        }
        return false;
    }

    async get_data(data_name) {
        console.log("get local data: " + data_name);

        const data = await get_status(data_name);
        if (data === undefined || data === null)
            throw new Error(data_name + " is not available for `data_name`.");
        return data;
    }

    async update_data() {
        if (!(await this._can_fetch_again())) return;

        console.log("Updating local data (PoE2 only)...");

        // PoE2 data only
        const poe2_urls = {
            local_poe2_stats_data: LocalDataLoader.POE2_STATS_DATA_PATH,
            local_poe2_query_data: LocalDataLoader.POE2_QUERY_PATH,
            local_poe2_gems_query_data: LocalDataLoader.POE2_GEMS_QUERY_PATH,
        };

        const poe2_results = await Promise.all(
            Object.values(poe2_urls).map(url =>
                fetch(url).then(response => response.json()).catch(e => {
                    console.error(`Failed to load ${url}:`, e);
                    return null;
                })
            )
        );

        // Save PoE2 data
        Object.keys(poe2_urls).forEach((key, i) => {
            if (poe2_results[i] !== null) {
                set_status(key, poe2_results[i]);
                console.log(`Loaded ${key} successfully`);
            } else {
                console.error(`Failed to load ${key}`);
            }
        });

        console.log("Local data update complete.");
    }
}

// Simplified OnlineDataLoader - not used for PoE2 currently
class OnlineDataLoader {
    async get_data(data_name) {
        console.log("get online data (not implemented for PoE2): " + data_name);
        throw new Error("Online data not available for PoE2");
    }

    async update_data() {
        console.log("Online data update skipped for PoE2");
    }
}

export { LocalDataLoader, OnlineDataLoader };