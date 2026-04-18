# assrt

AI-powered QA testing that runs real browser tests against web applications. Works as an MCP server for coding agents (Claude Code, Cursor, etc.) and as a standalone CLI.

## Why assrt over raw Playwright MCP?

Playwright MCP gives your agent browser tools. Assrt gives it a **QA engineer**.

| | Playwright MCP | assrt |
|---|---|---|
| Browser control | Manual tool calls (navigate, click, type) | Same tools, plus structured test scenarios with pass/fail |
| Test execution | Agent figures out assertions on its own | Built-in `#Case` format with automatic reporting |
| Extension mode | Env var setup, manual token management | First-use token flow with auto-save to `~/.assrt/extension-token` |
| Video recording | Not included | Every test run recorded, video player auto-opens |
| Cloud storage | None | Scenarios, runs, and artifacts saved with shareable URLs |
| Diagnosis | Agent guesses what went wrong | `assrt_diagnose` analyzes failures and suggests fixes |
| Retina screenshots | Breaks Claude API (>2000px) | File output mode avoids transport bloat |

## Install

```bash
npx @assrt-ai/assrt setup
```

This registers the MCP server globally, installs a QA reminder hook, and updates your CLAUDE.md.

## Usage

### MCP server (for coding agents)

After setup, three tools are available in Claude Code:

- **`assrt_test`** runs test scenarios against a URL and returns structured pass/fail results
- **`assrt_plan`** navigates to a URL and auto-generates test cases
- **`assrt_diagnose`** analyzes a failed test and suggests fixes

### CLI

```bash
# Run tests
assrt run --url http://localhost:3000 --plan "
#Case 1: Homepage loads
Navigate to the homepage and verify the heading is visible.

#Case 2: Login works
Click Sign In, enter test@example.com / password123, verify dashboard appears.
"

# Use your existing Chrome session
assrt run --url https://app.example.com --plan "..." --extension

# Record a video of the test and auto-open the player
assrt run --url http://localhost:3000 --plan "..." --video

# Record video but don't auto-open the player
assrt run --url http://localhost:3000 --plan "..." --video --no-auto-open

# Output JSON for CI
assrt run --url http://localhost:3000 --plan-file tests.txt --json
```

### Extension mode

Connect to your running Chrome instead of launching a new browser. Useful for testing behind authentication.

```bash
# First time: approve in Chrome, then pass the token
assrt run --url https://mail.google.com --plan "..." --extension --extension-token <token>

# Token is saved to ~/.assrt/extension-token; future runs just work
assrt run --url https://mail.google.com --plan "..." --extension
```

When used via MCP, the agent handles the token flow automatically by asking you to paste it on first use.

### Non-blocking usage in Claude Code

The MCP tools (`assrt_test`, `assrt_plan`) block the conversation until they finish. To run tests without blocking, use the CLI via the Bash tool with `run_in_background`:

```bash
# Run in background (non-blocking)
npx assrt run --url http://localhost:3000 --plan "#Case: Homepage loads
- Verify the page loads
- Check heading is visible" --video --json
```

When run this way in Claude Code, the agent can continue working while the test executes. Results (including `videoPlayerUrl`) are returned in the JSON output when the background task completes.

## How it works

Assrt wraps [@playwright/mcp](https://github.com/anthropics/playwright-mcp) and adds a test execution layer on top. Each `#Case` in your plan runs as an independent scenario in a shared browser session. An LLM agent (Claude Haiku by default) interprets the steps, interacts with the page using Playwright MCP tools, makes assertions, and reports results.

Scenarios and results are saved locally (`/tmp/assrt/`) and optionally synced to [app.assrt.ai](https://app.assrt.ai) for sharing and history.

## Options

| Flag | Description |
|---|---|
| `--url` | URL to test (required) |
| `--plan` | Test scenarios as inline text |
| `--plan-file` | Path to a file containing test scenarios |
| `--model` | LLM model (default: claude-haiku-4-5-20251001) |
| `--headed` | Show the browser window |
| `--isolated` | In-memory browser profile (no persistence) |
| `--extension` | Connect to existing Chrome |
| `--extension-token` | Playwright extension token (saved after first use) |
| `--keep-open` | Leave browser open after tests |
| `--video` | Record a video and open the player when done |
| `--no-auto-open` | Record video without auto-opening the player |
| `--json` | Output JSON report to stdout |
