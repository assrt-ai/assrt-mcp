#!/usr/bin/env node
/**
 * Assrt MCP Server: exposes AI-powered QA testing as tools for coding agents.
 *
 * Tools:
 *   assrt_test     — Run QA test scenarios against a URL
 *   assrt_plan     — Auto-generate test scenarios from a URL
 *   assrt_diagnose — Diagnose a failed test scenario
 *
 * Usage:
 *   npx assrt-mcp               (stdio transport, for Claude Code / Cursor / etc.)
 *   echo '{"jsonrpc":"2.0",...}' | npx tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { getCredential } from "../core/keychain";
import { TestAgent } from "../core/agent";
import { McpBrowserManager } from "../core/browser";
import type { TestReport } from "../core/types";
import { trackEvent, shutdownTelemetry } from "../core/telemetry";

// ── Video player HTML generator ──

function generateVideoPlayerHtml(
  videoFilename: string,
  testUrl: string,
  passedCount: number,
  failedCount: number,
  durationSec: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Assrt Test Recording</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0f; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; padding: 8px; }
  .header { width: 100%; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 0 8px; flex-shrink: 0; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
  .brand span { color: #22c55e; }
  .meta { display: flex; gap: 16px; font-size: 13px; color: #9ca3af; }
  .meta .pass { color: #22c55e; font-weight: 600; }
  .meta .fail { color: #ef4444; font-weight: 600; }
  .video-wrap { width: 100%; flex: 1; min-height: 0; background: #111118; border-radius: 12px; overflow: hidden; border: 1px solid #1f1f2e; display: flex; flex-direction: column; }
  video { width: 100%; flex: 1; min-height: 0; object-fit: contain; display: block; }
  .controls { padding: 8px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex-shrink: 0; }
  .speed-group { display: flex; gap: 4px; }
  .speed-btn { background: #1a1a26; border: 1px solid #2a2a3a; color: #9ca3af; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .speed-btn:hover { background: #252536; color: #e5e7eb; }
  .speed-btn.active { background: #22c55e; color: #0a0a0f; border-color: #22c55e; font-weight: 700; }
  .hint { margin-left: auto; font-size: 12px; color: #6b7280; }
  kbd { background: #1a1a26; border: 1px solid #2a2a3a; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-family: inherit; }
</style>
</head>
<body>
<div class="header">
  <div class="brand">assrt<span>.</span></div>
  <div class="meta">
    <span>${testUrl}</span>
    <span class="pass">${passedCount} passed</span>
    ${failedCount > 0 ? `<span class="fail">${failedCount} failed</span>` : ''}
    <span>${durationSec}s</span>
  </div>
</div>
<div class="video-wrap">
  <video id="v" controls autoplay muted>
    <source src="${videoFilename}" type="video/webm">
  </video>
  <div class="controls">
    <div class="speed-group">
      <button class="speed-btn" data-speed="1">1x</button>
      <button class="speed-btn" data-speed="2">2x</button>
      <button class="speed-btn" data-speed="3">3x</button>
      <button class="speed-btn active" data-speed="5">5x</button>
      <button class="speed-btn" data-speed="10">10x</button>
    </div>
    <div class="hint"><kbd>Space</kbd> play/pause &nbsp; <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>5</kbd> speed &nbsp; <kbd>\u2190</kbd><kbd>\u2192</kbd> seek 5s</div>
  </div>
</div>
<script>
const v = document.getElementById('v');
const btns = document.querySelectorAll('.speed-btn');
function setSpeed(s) {
  v.playbackRate = s;
  btns.forEach(b => b.classList.toggle('active', +b.dataset.speed === s));
}
v.addEventListener('loadeddata', () => setSpeed(5));
btns.forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
document.addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); }
  if (e.key === 'ArrowRight') { v.currentTime += 5; }
  const speedMap = { '1': 1, '2': 2, '3': 3, '5': 5, '0': 10 };
  if (speedMap[e.key]) setSpeed(speedMap[e.key]);
});
</script>
</body>
</html>`;
}

// ── Plan generation prompt (reused from web app) ──

const PLAN_SYSTEM_PROMPT = `You are a Senior QA Engineer generating test cases for an AI browser agent. The agent can: navigate URLs, click buttons/links by text or selector, type into inputs, scroll, press keys, and make assertions. It CANNOT: resize the browser, test network errors, inspect CSS, or run JavaScript.

## Output Format
Generate test cases in this EXACT format:

#Case 1: [short action-oriented name]
[Step-by-step instructions the agent can execute. Be SPECIFIC about what to click, what to type, and what to verify.]

#Case 2: [short action-oriented name]
[Step-by-step instructions...]

## CRITICAL Rules for Executable Tests
1. **Each case must be SELF-CONTAINED** — do not assume previous cases ran. If a test needs login, include the login steps.
2. **Be specific about selectors** — say "click the Login button" not "navigate to login". Say "type test@email.com into the email field" not "fill in credentials".
3. **Verify observable things** — check for visible text, page titles, URLs, element presence. NOT for CSS, colors, performance, or responsive layout.
4. **Keep cases SHORT** — 3-5 actions max per case. A focused test that passes is better than a complex one that fails.
5. **Avoid testing what you can't see** — don't generate cases for features behind authentication unless there's a visible signup/login form.
6. **Generate 5-8 cases max** — focused on the MOST IMPORTANT user flows visible on the page.`;

// ── Diagnosis prompt (reused from fix-case route) ──

const DIAGNOSE_SYSTEM_PROMPT = `You are a senior QA engineer and debugging expert. You are given a failing test case report from an automated web testing agent. Your job is to:

1. **Diagnose** the root cause — is it a bug in the application, a flawed test, or an environment issue?
2. **Provide a fix** — give a concrete, actionable solution:
   - If the app has a bug: describe what the app should do differently
   - If the test is flawed: provide a corrected test scenario in the exact #Case format
   - If it's an environment issue: explain what needs to change
3. **Provide a corrected test scenario** if the test itself needs adjustment

## Output Format

### Root Cause
[1-2 sentences identifying the core issue]

### Analysis
[3-5 sentences explaining what went wrong and why]

### Recommended Fix
[Concrete steps to fix the issue]

### Corrected Test Scenario
#Case 1: [corrected case name]
[corrected steps that will pass]

## Rules
- Be specific — reference actual elements, URLs, error messages from the report
- If the test failed because a feature doesn't exist, say so clearly
- If the test steps are valid but the app is broken, focus on the app issue
- Keep it concise and actionable — no filler`;

// ── Server setup ──

const SERVER_INSTRUCTIONS = `You are connected to Assrt, an AI-powered QA testing server that runs real browser tests against web applications.

## When to use Assrt

**Proactively use Assrt after any user-facing change.** Do not wait for the user to ask for testing. Specifically:

1. **After implementing a feature or bug fix** that touches UI, routes, forms, or user flows: run \`assrt_test\` against the local dev server to verify the change works end-to-end in a real browser.
2. **Before committing code**: if the changes affect anything a user would see or interact with, generate a quick test with \`assrt_plan\` or write a targeted test case and run it with \`assrt_test\`.
3. **When a test fails**: use \`assrt_diagnose\` to understand root cause before attempting a fix. Do not guess.

## How to use the tools

- **assrt_test**: The primary tool. Pass a URL (usually http://localhost:3000 or whatever the dev server is) and a test plan. Returns structured pass/fail results with screenshots showing the browser at each step.
- **assrt_plan**: Use when you need test cases but don't have them. Navigates to the URL, analyzes the page, and generates executable test scenarios.
- **assrt_diagnose**: Use after a failed test. Pass the URL, the scenario that failed, and the error. Returns root cause analysis and a corrected test.

## Important

- Always include the correct local dev server URL. Check package.json scripts or running processes to find it.
- Test plans use \`#Case N: name\` format. Each case should be self-contained (3-5 steps).
- The browser runs headless at 1280x720. Screenshots are returned as images in the response.
- If the dev server is not running, start it first before calling assrt_test.`;

const server = new McpServer(
  { name: "assrt", version: "0.2.0" },
  { instructions: SERVER_INSTRUCTIONS },
);

// ── Tool: assrt_test ──

server.tool(
  "assrt_test",
  "Run AI-powered QA test scenarios against a URL. Returns a structured report with pass/fail results, assertions, and improvement suggestions.",
  {
    url: z.string().describe("URL to test (e.g. http://localhost:3000)"),
    plan: z.string().describe("Test scenarios in text format. Use #Case N: format for multiple scenarios."),
    model: z.string().optional().describe("LLM model override (default: claude-haiku-4-5-20251001)"),
    autoOpenPlayer: z.boolean().optional().describe("Auto-open the video player in the browser when test completes (default: true)"),
  },
  async ({ url, plan, model, autoOpenPlayer }) => {
    const shouldAutoOpen = autoOpenPlayer !== false;
    const credential = getCredential();

    // Create a temp directory for this test run's artifacts
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(tmpdir(), "assrt", runId);
    const screenshotDir = join(runDir, "screenshots");
    mkdirSync(screenshotDir, { recursive: true });

    const logs: string[] = [];
    const allEvents: Array<{ time: string; type: string; data: unknown }> = [];
    const improvements: Array<{ title: string; severity: string; description: string; suggestion: string }> = [];
    const screenshots: Array<{ step: number; action: string; description: string; base64: string; file: string }> = [];
    let currentStep = 0;
    let currentAction = "";
    let currentDescription = "";
    let screenshotIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emit = (type: string, data: any) => {
      const time = new Date().toISOString();
      allEvents.push({ time, type, data: type === "screenshot" ? { step: currentStep, action: currentAction } : data });

      if (type === "status") logs.push(`[${time}] [status] ${data.message}`);
      else if (type === "step") {
        currentStep = data.id || currentStep;
        currentAction = data.action || "";
        currentDescription = data.description || "";
        logs.push(`[${time}] [step ${currentStep}] (${currentAction}) ${currentDescription} — ${data.status || "running"}`);
      } else if (type === "reasoning") {
        logs.push(`[${time}] [reasoning] ${data.text}`);
      } else if (type === "assertion") {
        const icon = data.passed ? "PASS" : "FAIL";
        logs.push(`[${time}] [${icon}] ${data.description}${data.evidence ? ` — ${data.evidence}` : ""}`);
      } else if (type === "scenario_start") {
        logs.push(`[${time}] [scenario_start] ${data.name}`);
      } else if (type === "scenario_complete") {
        const result = data.passed ? "PASSED" : "FAILED";
        logs.push(`[${time}] [${result}] ${data.name}`);
      } else if (type === "improvement_suggestion") {
        logs.push(`[${time}] [issue] ${data.severity}: ${data.title} — ${data.description}`);
        improvements.push({ title: data.title, severity: data.severity, description: data.description, suggestion: data.suggestion });
      } else if (type === "screenshot" && data.base64) {
        // Save screenshot to disk
        const filename = `${String(screenshotIndex).padStart(2, "0")}_step${currentStep}_${currentAction || "init"}.png`;
        const filepath = join(screenshotDir, filename);
        try { writeFileSync(filepath, Buffer.from(data.base64, "base64")); } catch { /* best effort */ }
        screenshotIndex++;

        // Deduplicate: replace if same step, only keep last screenshot per step
        const last = screenshots[screenshots.length - 1];
        if (last && last.step === currentStep) {
          last.base64 = data.base64;
          last.file = filepath;
        } else {
          screenshots.push({
            step: currentStep,
            action: currentAction,
            description: currentDescription,
            base64: data.base64,
            file: filepath,
          });
        }
      }
      // Send progress via server logging
      if (type === "status" || type === "scenario_start") {
        server.server.sendLoggingMessage({
          level: "info",
          data: type === "status" ? data.message : `Starting scenario: ${data.name}`,
        });
      }
    };

    const t0 = Date.now();
    const videoDir = join(runDir, "video");
    const agent = new TestAgent(credential.token, emit, model, "anthropic", null, "local", credential.type, videoDir);
    const report: TestReport = await agent.run(url, plan);

    // Close the browser so Playwright finalizes the video recording
    await agent.close();

    // Write execution log to disk
    const logContent = logs.join("\n");
    const logFile = join(runDir, "execution.log");
    try { writeFileSync(logFile, logContent); } catch { /* best effort */ }

    // Write full event trace to disk
    const eventsFile = join(runDir, "events.json");
    try { writeFileSync(eventsFile, JSON.stringify(allEvents, null, 2)); } catch { /* best effort */ }

    // Find the video file (Playwright saves as .webm in the videoDir)
    let videoFile: string | null = null;
    let videoPlayerFile: string | null = null;
    let videoPlayerUrl: string | null = null;
    try {
      const videoFiles = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
      if (videoFiles.length > 0) {
        videoFile = join(videoDir, videoFiles[0]);
        // Generate a self-contained HTML player alongside the video
        videoPlayerFile = join(videoDir, "player.html");
        writeFileSync(videoPlayerFile, generateVideoPlayerHtml(
          basename(videoFiles[0]),
          url,
          report.passedCount,
          report.failedCount,
          +(report.totalDuration / 1000).toFixed(1),
        ));
        // Serve the video directory over HTTP (browsers block file:// video loading)
        try {
          const http = await import("http");
          const fs = await import("fs");
          const path = await import("path");
          const srv = http.createServer((req, res) => {
            const filePath = join(videoDir, path.basename(req.url || "/"));
            const ext = path.extname(filePath).toLowerCase();
            const mime: Record<string, string> = { ".html": "text/html", ".webm": "video/webm", ".mp4": "video/mp4" };
            try {
              const data = fs.readFileSync(filePath);
              res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
              res.end(data);
            } catch {
              res.writeHead(404);
              res.end("Not found");
            }
          });
          // Wait for server to be ready and capture the URL
          await new Promise<void>((resolve) => {
            srv.listen(0, "127.0.0.1", () => {
              const port = (srv.address() as { port: number }).port;
              videoPlayerUrl = `http://127.0.0.1:${port}/player.html`;
              if (shouldAutoOpen) {
                try { execSync(`open "${videoPlayerUrl}"`); } catch { /* best effort */ }
              }
              // Auto-shutdown after 10 minutes
              setTimeout(() => { try { srv.close(); } catch {} }, 600_000).unref();
              resolve();
            });
          });
          srv.unref();
        } catch { /* best effort */ }
      }
    } catch { /* no video directory or no files */ }

    const summary: Record<string, unknown> = {
      passed: report.failedCount === 0,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      duration: +(report.totalDuration / 1000).toFixed(1),
      screenshotCount: screenshots.length,
      artifactsDir: runDir,
      logFile,
      videoFile,
      videoPlayerFile,
      videoPlayerUrl,
      scenarios: report.scenarios.map((s) => ({
        name: s.name,
        passed: s.passed,
        summary: s.summary,
        assertions: s.assertions.map((a) => ({
          description: a.description,
          passed: a.passed,
          evidence: a.evidence,
        })),
      })),
      improvements: improvements,
    };

    // Build response: JSON summary with screenshot file paths (not inline base64, which can exceed 20MB)
    // Screenshots are saved to disk and can be viewed via the file paths in the summary
    const screenshotFiles = screenshots.map((ss) => ({
      step: ss.step,
      action: ss.action,
      description: ss.description,
      file: ss.file,
    }));
    summary.screenshots = screenshotFiles;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [
      { type: "text", text: JSON.stringify(summary, null, 2) },
    ];

    trackEvent("assrt_test_run", {
      url,
      model: model || "default",
      passed: report.failedCount === 0,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      screenshotCount: screenshots.length,
      scenarioCount: report.scenarios.length,
      source: "mcp",
    });

    return { content };
  }
);

// ── Tool: assrt_plan ──

server.tool(
  "assrt_plan",
  "Auto-generate QA test scenarios by analyzing a URL. Launches a browser, takes screenshots, and uses AI to create executable test cases.",
  {
    url: z.string().describe("URL to analyze (e.g. http://localhost:3000)"),
    model: z.string().optional().describe("LLM model override for plan generation"),
  },
  async ({ url, model }) => {
    const t0 = Date.now();
    const credential = getCredential();
    const Anthropic = (await import("@anthropic-ai/sdk")).default;

    const anthropic = new Anthropic({
      authToken: credential.token,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });

    const browser = new McpBrowserManager();
    try {
      server.server.sendLoggingMessage({ level: "info", data: "Launching local browser..." });
      await browser.launchLocal();

      server.server.sendLoggingMessage({ level: "info", data: `Navigating to ${url}...` });
      await browser.navigate(url);

      // Take screenshots at different scroll positions
      const screenshot1 = await browser.screenshot();
      const snapshotText1 = await browser.snapshot();

      await browser.scroll(0, 800);
      await new Promise((r) => setTimeout(r, 500));
      const screenshot2 = await browser.screenshot();
      const snapshotText2 = await browser.snapshot();

      await browser.scroll(0, 800);
      await new Promise((r) => setTimeout(r, 500));
      const screenshot3 = await browser.screenshot();
      const snapshotText3 = await browser.snapshot();

      await browser.close();

      const allText = [snapshotText1, snapshotText2, snapshotText3].join("\n\n").slice(0, 8000);

      server.server.sendLoggingMessage({ level: "info", data: "Generating test plan with AI..." });

      // Build message content with screenshots
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentParts: any[] = [];
      for (const img of [screenshot1, screenshot2, screenshot3]) {
        if (img) {
          contentParts.push({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: img },
          });
        }
      }
      contentParts.push({
        type: "text",
        text: `Analyze this web application and generate a comprehensive test plan.\n\n**URL:** ${url}\n\n**Visible Text Content:**\n${allText}\n\nBased on the screenshots and page analysis above, generate comprehensive test cases for this web application.`,
      });

      const response = await anthropic.messages.create({
        model: model || "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: PLAN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: contentParts }],
      });

      const plan = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      trackEvent("assrt_plan_run", {
        url,
        model: model || "default",
        duration_s: +((Date.now() - t0) / 1000).toFixed(1),
        source: "mcp",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ plan, url }, null, 2),
          },
        ],
      };
    } catch (err) {
      try { await browser.close(); } catch { /* already closed */ }
      trackEvent("assrt_plan_error", { url, error: (err as Error).message?.slice(0, 200), source: "mcp" });
      throw err;
    }
  }
);

// ── Tool: assrt_diagnose ──

server.tool(
  "assrt_diagnose",
  "Diagnose a failed test scenario. Analyzes the failure and suggests fixes for both application bugs and flawed tests.",
  {
    url: z.string().describe("URL that was tested"),
    scenario: z.string().describe("The test scenario that failed"),
    error: z.string().describe("The failure description, evidence, or error message"),
  },
  async ({ url, scenario, error }) => {
    const t0 = Date.now();
    const credential = getCredential();
    const Anthropic = (await import("@anthropic-ai/sdk")).default;

    const anthropic = new Anthropic({
      authToken: credential.token,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });

    const debugPrompt = `## Failed Test Report

**URL:** ${url}

**Test Scenario:**
${scenario}

**Failure:**
${error}

Please diagnose this failure and provide a corrected test scenario.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: DIAGNOSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: debugPrompt }],
    });

    const diagnosis = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    trackEvent("assrt_diagnose_run", {
      url,
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      source: "mcp",
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ diagnosis, url, scenario }, null, 2),
        },
      ],
    };
  }
);

// ── Start ──

async function main() {
  trackEvent("mcp_server_start", { source: "mcp" }, { dedupeDaily: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[assrt-mcp] server started, waiting for JSON-RPC on stdin");

  process.on("SIGINT", async () => { await shutdownTelemetry(); process.exit(0); });
  process.on("SIGTERM", async () => { await shutdownTelemetry(); process.exit(0); });
}

main().catch((err) => {
  console.error(`[assrt-mcp] fatal: ${err.message || err}`);
  process.exit(1);
});
