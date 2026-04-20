/**
 * Assrt telemetry: anonymous, non-blocking usage tracking via PostHog.
 *
 * Opt-out: set DO_NOT_TRACK=1 or ASSRT_TELEMETRY=0 in your environment.
 *
 * What we track: event names, tool durations, pass/fail counts, model used,
 * URL domain (not full URL), version, OS. Nothing sensitive.
 */

import { createHash } from "crypto";
import { hostname, platform, arch, userInfo } from "os";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const POSTHOG_KEY = "phc_mS27BrT7FC5m3BiVjDj9T4iOpVY9Oh1PB3g3bHsEiQv";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Resolve version from the nearest package.json at runtime.
// Walks up from this file's directory so it works from both dist/ and npm/.
let cachedVersion: string | null = null;
function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
        if (typeof pkg.version === "string" && (pkg.name === "@assrt-ai/assrt" || pkg.name === "assrt-sdk")) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      } catch { /* keep walking */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* */ }
  cachedVersion = "unknown";
  return cachedVersion;
}

function isEnabled(): boolean {
  if (process.env.DO_NOT_TRACK === "1") return false;
  if (process.env.ASSRT_TELEMETRY === "0") return false;
  return true;
}

function getMachineId(): string {
  const raw = `${hostname()}:${userInfo().username}:assrt`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let posthogClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getClient(): Promise<any> {
  if (posthogClient) return posthogClient;
  try {
    const { PostHog } = await import("posthog-node");
    posthogClient = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      // Custom fetch that silently swallows TLS/network errors.
      // Returns a fake 200 so PostHog SDK doesn't log errors to stderr.
      fetch: async (url: string, options: Record<string, unknown>) => {
        try {
          return await globalThis.fetch(url, options as RequestInit);
        } catch {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
      },
    });
    // Suppress PostHog's internal error logging to stderr
    posthogClient.on("error", () => {});
    return posthogClient;
  } catch {
    return null;
  }
}

export interface TestEventProps {
  url: string;
  model?: string;
  passed?: boolean;
  passedCount?: number;
  failedCount?: number;
  duration_s?: number;
  screenshotCount?: number;
  scenarioCount?: number;
  error?: string;
  source: "cli" | "mcp";
}

// Cross-process daily dedup: persist last-sent date per event to a temp file.
// Prevents noisy lifecycle events (mcp_server_start) from firing on every reconnect.
import { readFileSync as readSync, writeFileSync as writeSync } from "fs";
import { join as joinPath } from "path";
import { tmpdir as getTmpdir } from "os";

const DEDUP_FILE = joinPath(getTmpdir(), "assrt-telemetry-dedup.json");

function shouldSend(event: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const machineId = getMachineId();
  const key = `${machineId}:${event}`;
  try {
    const data = JSON.parse(readSync(DEDUP_FILE, "utf-8"));
    if (data[key] === today) return false;
    data[key] = today;
    writeSync(DEDUP_FILE, JSON.stringify(data));
    return true;
  } catch {
    try { writeSync(DEDUP_FILE, JSON.stringify({ [key]: today })); } catch { /* */ }
    return true;
  }
}

export async function trackEvent(event: string, props: Partial<TestEventProps> & Record<string, unknown> = {}, options?: { dedupeDaily?: boolean }): Promise<void> {
  if (!isEnabled()) return;
  if (options?.dedupeDaily && !shouldSend(event)) return;
  try {
    const client = await getClient();
    if (!client) return;
    const { url, ...rest } = props;
    client.capture({
      distinctId: getMachineId(),
      event,
      properties: {
        ...rest,
        domain: url ? getDomain(url as string) : undefined,
        version: getVersion(),
        os: platform(),
        arch: arch(),
        node_version: process.version,
      },
    });
  } catch {
    // telemetry should never break the tool
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (posthogClient) {
    try { await posthogClient.shutdown(); } catch { /* */ }
  }
}
