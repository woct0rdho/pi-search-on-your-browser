// Subagent - delegates page-content summarization to a text model.
//
// A model is resolved from Pi's registry and called through Pi's
// provider-neutral stream API with Pi's already-configured auth (no separate
// API keys). By default the subagent reuses the current session model
// (ctx.model). This module owns the config, the summary prompt, and
// context truncation - the model call itself lives in index.ts, next to the
// registry.
//
// Only the model's answer comes back to the chat context - the full page
// markdown is consumed by the subagent internally but never enters the
// conversation. This keeps visit_page results small when `summary` is used.
//
// This module is deliberately free of `@earendil-works/*` imports so it stays
// type-checkable under `tsc --noEmit` (which only resolves Node built-ins for
// src/).
//
// Config is read from <agent-dir>/search-on-your-browser.json (set via
// setConfigDir(getAgentDir()) on session_start). The file is edited by hand and
// is optional - missing keys fall back to the env vars below, then defaults.
//
// Env-var fallbacks (optional overrides, else current model is used):
// PI_BROWSE_PROVIDER, PI_BROWSE_MODEL, PI_BROWSE_MAX_TOKENS,
// PI_BROWSE_REASONING_EFFORT, PI_BROWSE_SUMMARY_ENABLED,
// PI_BROWSE_CLEAN_ENABLED.
//
// `summaryEnabled` and `cleanEnabled` select whether `visit_page` offers its
// `summary` / `clean` options at all (they never disable the tool itself).
//
// The same file also configures the browser itself (proxy), set as
// `"browser": { "proxy": "http://127.0.0.1:8010" }`. PI_SEARCH_PROXY overrides
// it when the file does not set one.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Reasoning effort levels
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

// Config
export interface SubagentConfig {
  provider?: string;
  model?: string;
  maxTokens: number;
  defaultReasoningEffort: ReasoningLevel;
  // Whether `visit_page` offers `summary` mode. When false the option is
  // hidden from the model completely - no `summary` parameter and no mention
  // of it in the tool description, snippet, or guidelines - and pages are
  // returned as raw markdown. It does not disable the tool itself.
  summaryEnabled: boolean;
  // Whether `visit_page` offers `clean` mode (the Defuddle reader-mode
  // extraction). When false the option is hidden from the model completely -
  // no `clean` parameter and no mention of it (or of combining it with
  // `summary`) anywhere in the tool surface. It does not disable the tool
  // itself.
  cleanEnabled: boolean;
  // Chrome `--proxy-server` value (e.g. "http://127.0.0.1:8010"). Empty
  // string means a direct connection. Passed to Chrome at launch, so a
  // change takes effect on the next Chrome start (the next tool call
  // restarts Chrome automatically when the value differs).
  proxy: string;
}

const DEFAULT_MAX_TOKENS = parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? "2048", 10);

const DEFAULT_CONFIG: SubagentConfig = {
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultReasoningEffort: "off",
  summaryEnabled: true,
  cleanEnabled: true,
  proxy: "",
};

// Live config singleton.
export const config: SubagentConfig = { ...DEFAULT_CONFIG };

// Config file path. Overridden by index.ts via setConfigDir(getAgentDir()) so
// PI_AGENT_DIR / custom config dirs are respected. Falls back to ~/.pi/agent.
let configDir: string | null = null;

export function setConfigDir(dir: string): void {
  configDir = dir;
}

function defaultConfigDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(configDir ?? defaultConfigDir(), "search-on-your-browser.json");
}

// System prompt for the subagent
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are an expert web research assistant.",
  "You are given the markdown content of a web page. Produce a comprehensive but",
  "concise summary of ALL the useful information the page actually contains.",
  "",
  "Guidelines:",
  "- Capture every meaningful piece of information present on the page: key facts,",
  "  numbers, names, dates, prices, code, URLs, claims, steps, options, definitions, etc.",
  "- Do not invent, assume, or add information that is not on the page. If the page",
  "  has no usable content, say so briefly.",
  "- Be concise and factual. Omit filler, navigation chrome, boilerplate, and repetition.",
  "- Preserve specific details that matter: numbers, names, dates, prices, code, URLs.",
  "- Preserve code blocks, tables, or lists when they are directly relevant.",
  "- Use markdown formatting (headings, lists, tables) when it aids clarity.",
  "- Structure the summary so it is easy to scan.",
  "- Do not mention that you were given page content or that you are a subagent -",
  "  just return the summary.",
].join("\n");

// Instruction appended to the page content in the user message.
const SUMMARY_INSTRUCTION = "Summarize all the useful information on this page.";

// Coercion helpers (config file is arbitrary JSON)
type RawConfig = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// Parse a boolean env var: 1/true/yes/on -> true, 0/false/no/off -> false.
function asEnvBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

// Normalize a proxy value into what Chrome's `--proxy-server` expects.
//
// Accepts a full URL (`http://`, `https://`, `socks4://`, `socks5://`), a bare
// `host:port` (scheme defaults to `http://`), and normalizes a trailing slash
// away. Returns undefined for anything that is not a usable proxy - including
// the explicit off switch (`""`, `"off"`, `"none"`, `"direct"`) - so callers
// can fall through to the next config layer.
export function normalizeProxy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (["off", "none", "direct", "false", "0"].includes(raw.toLowerCase())) return undefined;
  // Bare host:port has no scheme. Default to HTTP like Chrome does.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return undefined;
    return url.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function validateReasoningLevel(value: string | undefined): ReasoningLevel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if ((REASONING_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningLevel;
  }
  return undefined;
}

// Config loading

// Load config from the JSON file. Returns null if missing or unparseable.
function loadConfigFile(): RawConfig | null {
  try {
    const path = configPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object") return raw as RawConfig;
    return null;
  } catch {
    return null;
  }
}

// Resolve config with priority:
//   1. Config file (<agent-dir>/search-on-your-browser.json)
//   2. Environment variables (PI_BROWSE_PROVIDER, PI_BROWSE_MODEL, etc.)
//   3. Built-in defaults
//
// The file wins over env vars.
export function resolveConfig(): SubagentConfig {
  const file = loadConfigFile();
  const envReasoning = validateReasoningLevel(process.env.PI_BROWSE_REASONING_EFFORT);
  const fileReasoning = validateReasoningLevel(asString(file?.defaultReasoningEffort));
  const fileSummaryEnabled = asBool(file?.summaryEnabled);
  const envSummaryEnabled = asEnvBool(process.env.PI_BROWSE_SUMMARY_ENABLED);
  const fileCleanEnabled = asBool(file?.cleanEnabled);
  const envCleanEnabled = asEnvBool(process.env.PI_BROWSE_CLEAN_ENABLED);
  // Browser settings may live under `browser` (the documented shape) or at the
  // top level (hand-written convenience).
  const fileBrowser =
    file && typeof file.browser === "object" && file.browser !== null
      ? (file.browser as RawConfig)
      : {};
  return {
    provider: asString(file?.provider) || process.env.PI_BROWSE_PROVIDER || undefined,
    model: asString(file?.model) || process.env.PI_BROWSE_MODEL || undefined,
    maxTokens:
      file?.maxTokens !== undefined
        ? asNumber(file.maxTokens, DEFAULT_CONFIG.maxTokens)
        : parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS), 10),
    defaultReasoningEffort: fileReasoning ?? envReasoning ?? "off",
    summaryEnabled: fileSummaryEnabled ?? envSummaryEnabled ?? true,
    cleanEnabled: fileCleanEnabled ?? envCleanEnabled ?? true,
    proxy:
      normalizeProxy(fileBrowser.proxy) ??
      normalizeProxy(file?.proxy) ??
      normalizeProxy(process.env.PI_SEARCH_PROXY) ??
      "",
  };
}

// Reload config from file/env into the live singleton.
export function reloadConfig(): void {
  Object.assign(config, resolveConfig());
}

// Token budget / truncation

// Truncate page content so the subagent request fits within the model's
// context window. Tokens are estimated at 4 chars each (rough but safe).
// Room is reserved for the system prompt, the summary instruction, and max
// output tokens.
export function truncateForContext(
  content: string,
  contextWindow: number,
  maxTokens: number,
): { content: string; truncated: boolean; originalChars: number } {
  const originalChars = content.length;
  const TOKEN_CHARS = 4;
  const reservedTokens =
    Math.ceil(SUBAGENT_SYSTEM_PROMPT.length / TOKEN_CHARS) +
    Math.ceil(SUMMARY_INSTRUCTION.length / TOKEN_CHARS) +
    maxTokens +
    500; // safety buffer for URL, wrappers, message overhead
  const availableTokens = Math.max(0, contextWindow - reservedTokens);
  const maxChars = Math.max(0, availableTokens * TOKEN_CHARS);

  if (originalChars <= maxChars) {
    return { content, truncated: false, originalChars };
  }

  const NOTICE =
    "\n\n[... page content truncated to fit the subagent model's context window ...]";
  const slice = content.slice(0, Math.max(0, maxChars - NOTICE.length));
  return { content: slice + NOTICE, truncated: true, originalChars };
}

// Summary request

// Build the user-message text handed to the subagent: the page URL, the page
// markdown between delimiters, and the summarize instruction. index.ts wraps
// this into a user message and sends it through Pi's provider-neutral stream
// API (ctx.modelRegistry.streamSimple()).
export function buildSummaryPrompt(url: string, content: string): string {
  return (
    `URL: ${url}\n\n` +
    `PAGE CONTENT (markdown):\n` +
    `---\n${content}\n---\n\n` +
    SUMMARY_INSTRUCTION
  );
}
