/**
 * Scenario file sync: keeps scenario plan text as an editable file on disk,
 * watches for changes, and auto-syncs back to central storage (Firestore).
 *
 * File layout:
 *   /tmp/assrt/scenario.md          — the plan text (agent edits this)
 *   /tmp/assrt/scenario.json        — metadata: {id, name, url, updatedAt}
 *   /tmp/assrt/results/latest.json  — most recent test run results
 *   /tmp/assrt/results/<runId>.json — historical run results
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { updateScenario } from "./scenario-store";

const ASSRT_DIR = "/tmp/assrt";
const SCENARIO_FILE = join(ASSRT_DIR, "scenario.md");
const SCENARIO_META = join(ASSRT_DIR, "scenario.json");
const RESULTS_DIR = join(ASSRT_DIR, "results");
const LATEST_RESULTS = join(RESULTS_DIR, "latest.json");

let activeWatcher: FSWatcher | null = null;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastWrittenContent: string | null = null;

interface ScenarioMeta {
  id: string;
  name?: string;
  url?: string;
  updatedAt?: string;
}

function ensureDirs(): void {
  mkdirSync(ASSRT_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Write a scenario to disk and start watching for edits.
 * Call this when assrt_test loads a scenario (by ID or inline plan).
 */
export function writeScenarioFile(plan: string, meta: ScenarioMeta): void {
  ensureDirs();
  lastWrittenContent = plan;
  writeFileSync(SCENARIO_FILE, plan, "utf-8");
  writeFileSync(SCENARIO_META, JSON.stringify(meta, null, 2), "utf-8");
  startWatching(meta.id);
}

/**
 * Read the current scenario plan from disk.
 */
export function readScenarioFile(): string | null {
  if (!existsSync(SCENARIO_FILE)) return null;
  try {
    return readFileSync(SCENARIO_FILE, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read scenario metadata from disk.
 */
export function readScenarioMeta(): ScenarioMeta | null {
  if (!existsSync(SCENARIO_META)) return null;
  try {
    return JSON.parse(readFileSync(SCENARIO_META, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write test run results to disk so the agent can access them.
 */
export function writeResultsFile(runId: string, results: unknown): { latestPath: string; runPath: string } {
  ensureDirs();
  const json = JSON.stringify(results, null, 2);
  writeFileSync(LATEST_RESULTS, json, "utf-8");
  const runPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(runPath, json, "utf-8");
  return { latestPath: LATEST_RESULTS, runPath };
}

/**
 * Start watching the scenario file for edits by the agent.
 * On change, debounce and sync back to Firestore.
 */
function startWatching(scenarioId: string): void {
  stopWatching();

  // Don't watch local-only scenarios (they can't sync)
  if (scenarioId.startsWith("local-")) return;

  try {
    activeWatcher = watch(SCENARIO_FILE, { persistent: false }, (_event) => {
      // Debounce: wait 1s after last change before syncing
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => {
        syncToFirestore(scenarioId);
      }, 1000);
    });

    activeWatcher.on("error", (err) => {
      console.error("[scenario-files] Watcher error:", err.message);
    });
  } catch (err) {
    console.error("[scenario-files] Failed to start watcher:", (err as Error).message);
  }
}

/**
 * Stop watching the scenario file.
 */
export function stopWatching(): void {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  if (activeWatcher) {
    activeWatcher.close();
    activeWatcher = null;
  }
}

/**
 * Read the file and sync to Firestore if content changed.
 */
async function syncToFirestore(scenarioId: string): Promise<void> {
  try {
    const currentContent = readScenarioFile();
    if (!currentContent) return;

    // Skip if content hasn't actually changed (avoids echoing our own writes)
    if (currentContent === lastWrittenContent) return;

    lastWrittenContent = currentContent;
    const meta = readScenarioMeta();

    console.error(`[scenario-files] Detected edit, syncing scenario ${scenarioId.slice(0, 8)}... to Firestore`);
    const success = await updateScenario(scenarioId, {
      plan: currentContent,
      name: meta?.name,
      url: meta?.url,
    });

    if (success) {
      // Update local metadata
      if (meta) {
        meta.updatedAt = new Date().toISOString();
        writeFileSync(SCENARIO_META, JSON.stringify(meta, null, 2), "utf-8");
      }
      console.error("[scenario-files] Sync complete");
    } else {
      console.error("[scenario-files] Sync failed (API returned false)");
    }
  } catch (err) {
    console.error("[scenario-files] Sync error:", (err as Error).message);
  }
}

/** Exported paths for tool responses */
export const PATHS = {
  scenarioFile: SCENARIO_FILE,
  scenarioMeta: SCENARIO_META,
  resultsDir: RESULTS_DIR,
  latestResults: LATEST_RESULTS,
} as const;
