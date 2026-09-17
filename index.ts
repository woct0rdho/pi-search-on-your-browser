/**
 * pi-search-on-your-browser — exact same approach as ds4-agent, for Pi
 *
 * @antirez's ds4-agent strategy:
 *   https://x.com/antirez/status/2066233392916525379
 *   https://github.com/antirez/ds4
 *
 * Same approach: visible Chrome (not headless), CDP WebSocket, inline JS
 * extractors. No API keys, no headless detection.
 *
 * Registered tools:
 *   - google_search   — Search Google in a visible Chrome browser, returns markdown links + snippet
 *   - visit_page      — Visit a URL in a visible Chrome browser, returns rendered page as markdown.
 *                       X (Twitter) URLs get a dedicated tweet extractor (search/profile/tweet).
 *                       Reddit post URLs get a dedicated comment extractor (post + threaded comments).
 *                       Amazon product & search URLs get a dedicated product/listing extractor.
 *                       Google Scholar URLs get a dedicated academic paper extractor.
 *
 *                       Optional `summary` parameter: when `true`, the full page content is read
 *                       by a configurable subagent model and only a concise summary is returned —
 *                       the raw page markdown never enters the chat context. Configure the subagent
 *                       with /browse. (Mirrors the vision-tool extension's subagent pattern.)
 *
 *                       When summary mode is disabled — `"summaryEnabled": false` in the config
 *                       file, `PI_BROWSE_SUMMARY_ENABLED=0`, or `/browse off` — the `summary`
 *                       parameter is removed from the tool schema and the description, prompt
 *                       snippet, and guidelines are swapped for variants that never mention it,
 *                       so the model is not told the option exists.
 *
 *                       `clean` is gated independently by `cleanEnabled`: `"cleanEnabled": false`
 *                       in the config file, `PI_BROWSE_CLEAN_ENABLED=0`, or `/browse clean off`
 *                       removes the `clean` parameter and every mention of it, including the
 *                       "Combine with `clean: true`" sentence in the summary parameter
 *                       description. Disabling one feature never affects the other, or the rest
 *                       of the tool (`url` and google_search always work).
 *
 * Registered commands:
 *   - /browse             — Configure the visit_page subagent (provider, model, etc.)
 *   - /google-search-kill — Kill the Chrome process
 *
 * Chrome runs in a visible window (not headless) with a dedicated profile at
 * ~/.pi-search-browser/ — cookies and sessions persist across calls.
 */

import type { ExtensionAPI, ToolResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { googleSearch, visitPage, shutdownChrome } from "./src/chrome.js";
import {
  config,
  reloadConfig,
  saveConfigFile,
  configSummary,
  validateReasoningLevel,
  setConfigDir,
  truncateForContext,
  callSubagentModel,
  normalizeProxy,
  type SubagentConfig,
} from "./src/subagent.js";
import {
  visitPageSurface,
  stripDisabledArguments,
} from "./src/tool-surface.js";

type RenderArgs = { query?: string; url?: string; clean?: boolean; summary?: boolean };
type RenderState = { expanded?: boolean; isPartial?: boolean };
type ToolTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
};

/** Footer status indicator for the summary subagent.
 *
 *  Pi's own footer already shows the current session model, and by default the
 *  subagent reuses that exact model — so repeating it here adds nothing but a
 *  line of noise (it renders byte-for-byte the same `provider/model`). The
 *  status line therefore only appears when the subagent is pinned to a
 *  *different* model, which is the one thing Pi's footer cannot tell you.
 *
 *  The transient spinner shown while a summary call is in flight is set
 *  separately (and reflects the model actually being called), so it is
 *  unaffected by this. */
function updateStatus(ctx: {
  ui: { setStatus: (id: string, text: string | undefined) => void };
}) {
  if (config.summaryEnabled && config.provider && config.model) {
    ctx.ui.setStatus("browse", `🌐 ${config.provider}/${config.model}`);
    return;
  }
  ctx.ui.setStatus("browse", undefined);
}

/**
 * Build the visit_page tool definition from the current config.
 *
 * The `summaryEnabled` and `cleanEnabled` flags each gate one optional feature.
 * A disabled feature is hidden from the model completely: its parameter is
 * omitted from the schema and the description, prompt snippet, and guidelines
 * are built without any mention of it. Registered by syncVisitPageTool() in
 * the factory and re-registered on /browse on|off and /browse clean on|off, so
 * a config change applies to the next turn.
 */
function visitPageToolDefinition() {
  const summaryEnabled = config.summaryEnabled;
  const cleanEnabled = config.cleanEnabled;
  const surface = visitPageSurface({ summaryEnabled, cleanEnabled });

  const parameters = Type.Object({
    url: Type.String({ description: "Full URL to visit" }),
    ...(cleanEnabled
      ? { clean: Type.Optional(Type.Boolean({ description: surface.cleanParamDescription })) }
      : {}),
    ...(summaryEnabled
      ? { summary: Type.Optional(Type.Boolean({ description: surface.summaryParamDescription })) }
      : {}),
  });

  return {
    name: "visit_page",
    label: "Visit Page",
    description: surface.description,
    promptSnippet: surface.promptSnippet,
    promptGuidelines: surface.promptGuidelines,
    parameters,
    prepareArguments:
      summaryEnabled && cleanEnabled
        ? undefined
        : (args: unknown) => stripDisabledArguments(args, { summaryEnabled, cleanEnabled }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { url, clean } = params;
      if (!url || !url.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: visit_page requires a URL." }],
          details: {},
        };
      }

      let targetUrl: string;
      try {
        targetUrl = new URL(url.trim()).toString();
      } catch {
        return {
          content: [{ type: "text" as const, text: `Tool error: visit_page: invalid URL: ${url}` }],
          details: {},
        };
      }

      const summarize = config.summaryEnabled && (params as { summary?: unknown }).summary === true;
      const useClean = config.cleanEnabled && clean === true;

      // ── Summary mode: resolve the subagent BEFORE fetching ────────────────
      // Resolves config/model/auth up front so a misconfigured subagent does
      // not waste a browser navigation. Mirrors the vision tool's checks.
      let subModel: Parameters<typeof callSubagentModel>[0] | undefined;
      let subApiKey: string | undefined;
      let subHeaders: Record<string, string> | undefined;

      if (summarize) {
        // Resolve the subagent model. By default the subagent reuses the
        // current session model (ctx.model) — no provider/model config or API
        // keys needed, since Pi already has them. An explicit /browse override
        // takes precedence when both provider and model are set.
        let m: Parameters<typeof callSubagentModel>[0] | undefined;
        if (config.provider && config.model) {
          m = ctx.modelRegistry.find(config.provider, config.model) as
            | Parameters<typeof callSubagentModel>[0]
            | undefined;
          if (!m) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `Browse subagent error: model "${config.provider}/${config.model}" not found in the model registry.`,
                    "",
                    "Make sure the provider and model are defined in ~/.pi/agent/models.json,",
                    "or run /browse clear to fall back to the current session model.",
                  ].join("\n"),
                },
              ],
              details: { url: targetUrl, summarized: true, error: "model_not_found" },
              isError: true,
            };
          }
        } else {
          m = ctx.model as Parameters<typeof callSubagentModel>[0] | undefined;
          if (!m) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Browse subagent error: no model is active in this session. Start a session with a model first, or set one with /browse provider and /browse model.",
                },
              ],
              details: { url: targetUrl, summarized: true, error: "no_current_model" },
              isError: true,
            };
          }
        }

        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
        if (!auth.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Browse subagent error: unable to resolve API key for "${m.provider}". ${auth.error}`,
              },
            ],
            details: { url: targetUrl, summarized: true, error: "auth_error", authError: auth.error },
            isError: true,
          };
        }

        subModel = m;
        subApiKey = auth.apiKey;
        subHeaders = auth.headers;
      }

      // ── Fetch the page ──────────────────────────────────────────────────
      const started = Date.now();
      let result: { markdown: string; url: string };
      try {
        result = await visitPage(targetUrl, {
          onStatus: (msg) => {
            onUpdate?.({
              content: [{ type: "text", text: msg }],
              details: { _progress: true },
            });
          },
          clean: useClean,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`visit_page failed: ${message}`);
      }
      const fetchElapsed = ((Date.now() - started) / 1000).toFixed(1);

      // ── HTTP error (4xx/5xx) → surface as an error result ───────────────
      // The server returned an error status (e.g. 404 on a dead link). Return
      // isError so the LLM knows the URL didn't work and can try another —
      // instead of receiving the error page's content as if it were the page.
      if (result.httpStatus && result.httpStatus >= 400) {
        const code = result.httpStatus;
        const reason = result.httpStatusText || "";
        let hint: string;
        if (code === 404) {
          hint = "The page does not exist at this URL — the content may have been moved, removed, or the URL may be incorrect. Try a different URL or search for the content.";
        } else if (code === 403) {
          hint = "Access was denied — the site may be blocking automated access, require authentication, or be behind a paywall.";
        } else if (code === 429) {
          hint = "Rate limited — too many requests. Wait a moment and retry.";
        } else if (code >= 500) {
          hint = "The server had an error. Retry shortly, or try a different URL.";
        } else {
          hint = "The server returned an error. The URL may be incorrect or the content unavailable.";
        }
        return {
          content: [
            { type: "text" as const, text: `HTTP ${code}${reason ? ` ${reason}` : ""} — ${hint}` },
          ],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, httpStatus: code },
          isError: true,
        };
      }

      // ── No summary → return full page markdown (existing behavior) ───────
      if (!summarize) {
        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, chars: result.markdown.length, clean: useClean },
        };
      }

      // ── Summary mode → delegate to the subagent ──────────────────────────
      // Only the subagent's summary enters the chat context; the full page
      // markdown is consumed by the subagent and discarded.
      // subModel is guaranteed set here (summary mode passed the precheck above).
      const model = subModel!;
      const modelLabel = `${model.provider}/${model.id}`;
      if (!result.markdown.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Page fetched but no content was extracted, so the subagent has nothing to summarize.",
            },
          ],
          details: {
            url: result.url,
            summarized: true,
            originalChars: 0,
            model: modelLabel,
          },
        };
      }

      const { content: fitContent, truncated, originalChars } = truncateForContext(
        result.markdown,
        model,
        config.maxTokens,
      );

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Page fetched (${originalChars.toLocaleString()} chars in ${fetchElapsed}s). Asking ${model.id} to summarize…`,
          },
        ],
      });

      // Animated spinner in the footer status line.
      const spinnerFrames = ["◐", "◓", "◑", "◒"];
      let spinnerIndex = 0;
      let spinnerTimer: ReturnType<typeof setInterval> | null = null;
      const updateSpinner = () => {
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        ctx.ui.setStatus("browse", `${spinnerFrames[spinnerIndex]} ${modelLabel}`);
      };
      updateSpinner();
      spinnerTimer = setInterval(updateSpinner, 200);

      try {
        const answer = await callSubagentModel(
          model,
          subApiKey,
          subHeaders,
          result.url,
          fitContent,
          signal,
          config.defaultReasoningEffort,
          config.maxTokens,
        );

        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        return {
          content: [{ type: "text" as const, text: answer }],
          details: {
            url: result.url,
            elapsed: `${elapsed}s`,
            chars: answer.length,
            summarized: true,
            originalChars,
            model: modelLabel,
            truncated,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Browse subagent error: ${message}` },
          ],
          details: {
            url: result.url,
            summarized: true,
            originalChars,
            model: modelLabel,
            error: "subagent_call_error",
          },
          isError: true,
        };
      } finally {
        if (spinnerTimer) clearInterval(spinnerTimer);
        updateStatus(ctx);
      }
    },

    renderCall(args: Partial<RenderArgs>, theme: ToolTheme) {
      const u = args.url || "";
      const hostname = (() => {
        try {
          return new URL(u).hostname;
        } catch {
          return u;
        }
      })();
      const head = `${theme.fg("toolTitle", theme.bold("visit_page"))} ${theme.fg("accent", hostname)}`;
      const tags: string[] = [];
      if (args.clean) tags.push(theme.fg("dim", "clean"));
      if (args.summary) tags.push(theme.fg("dim", "summary"));
      return new Text(tags.length ? `${head}\n  ${tags.join("  ")}` : head, 0, 0);
    },

    renderResult(
      result: ToolResult,
      { expanded, isPartial }: RenderState,
      theme: ToolTheme,
    ) {
      if (isPartial) {
        const progress = result.content.find((c) => c.type === "text")?.text ?? "Loading...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details as {
        url?: string;
        elapsed?: string;
        chars?: number;
        summarized?: boolean;
        originalChars?: number;
        model?: string;
        clean?: boolean;
        httpStatus?: number;
        truncated?: boolean;
      } | undefined;

      if (!expanded) {
        const parts: string[] = [];

        // HTTP error (4xx/5xx) — show the status code prominently.
        if (details?.httpStatus) {
          parts.push(`HTTP ${details.httpStatus}`);
        }
        if (details?.summarized) {
          if (details.originalChars != null && details.chars != null && details.originalChars > 0) {
            parts.push(`${details.originalChars.toLocaleString()}→${details.chars.toLocaleString()} chars`);
          } else if (details?.chars) {
            parts.push(`${details.chars.toLocaleString()} chars`);
          }
          if (details?.clean) parts.push("clean");
          if (details?.model) parts.push(details.model);
          if (details?.elapsed) parts.push(details.elapsed);
          if (details?.url) {
            try {
              parts.push(new URL(details.url).hostname);
            } catch {
              /* */
            }
          }
          return new Text(theme.fg("muted", ` → ${parts.join(" · ")}`), 0, 0);
        }
        if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
        if (details?.clean) parts.push("clean");
        if (details?.elapsed) parts.push(details.elapsed);
        if (details?.url) {
          try {
            parts.push(new URL(details.url).hostname);
          } catch {
            /* */
          }
        }
        return new Text(theme.fg("muted", ` → ${parts.join(" · ")}`), 0, 0);
      }

      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
    },
  };
}

export default function searchOnYourBrowser(pi: ExtensionAPI) {
  // ── Load config before first use ────────────────────────────────────────
  // The visit_page tool surface depends on `summaryEnabled` (summary offered
  // vs hidden), so the config file is read before the tool is registered — not
  // just on session_start, where session-entry overrides are also restored.
  setConfigDir(getAgentDir());
  reloadConfig();

  // ── Session lifecycle: load & persist config ────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    setConfigDir(getAgentDir());
    reloadConfig();

    // Restore mid-session config changes from session entries (belt-and-suspenders
    // alongside the config file, mirroring the vision tool).
    const entries = ctx.sessionManager.getEntries();
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "browse-config") {
        const data = entry.data as Partial<SubagentConfig> | undefined;
        if (!data) continue;
        if (data.provider !== undefined) config.provider = data.provider || undefined;
        if (data.model !== undefined) config.model = data.model || undefined;
        if (data.maxTokens !== undefined) config.maxTokens = data.maxTokens;
        if (data.defaultReasoningEffort !== undefined) config.defaultReasoningEffort = data.defaultReasoningEffort;
        if (data.summaryEnabled !== undefined) config.summaryEnabled = data.summaryEnabled;
        if (data.cleanEnabled !== undefined) config.cleanEnabled = data.cleanEnabled;
        if (data.proxy !== undefined) config.proxy = data.proxy;
      }
    }

    syncVisitPageTool();
    updateStatus(ctx);
  });

  /** Persist current config into the session file (in addition to the file). */
  function persistConfig() {
    pi.appendEntry("browse-config", { ...config });
  }

  /** Apply a /browse proxy argument: a URL, or "off"/"none"/"direct" to
   *  connect directly. Chrome picks the value up when it is (re)launched, so
   *  the next tool call restarts it automatically when the value changed. */
  function applyProxyArgument(value: string): { ok: boolean; message: string } {
    const cleared = ["off", "none", "direct", "false", "0"].includes(value.toLowerCase());
    const proxy = cleared ? "" : normalizeProxy(value);
    if (proxy === undefined) {
      return {
        ok: false,
        message:
          `Invalid proxy: "${value}". Use a URL like http://127.0.0.1:8010 ` +
          `(or socks5://host:port), or "off" to connect directly.`,
      };
    }
    config.proxy = proxy;
    saveConfigFile();
    persistConfig();
    return {
      ok: true,
      message: proxy
        ? `Chrome proxy set to "${proxy}". Chrome restarts with the new proxy on the next google_search / visit_page call.`
        : "Chrome proxy cleared — Chrome will connect directly on the next call.",
    };
  }

  // ── /browse command ─────────────────────────────────────────────────────

  pi.registerCommand("browse", {
    description: "visit_page subagent settings (config, show, clear, on, off)",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        ctx.ui.notify(configSummary(ctx.model), "info");
        return;
      }

      if (trimmed === "on") {
        config.summaryEnabled = true;
        saveConfigFile();
        persistConfig();
        syncVisitPageTool();
        updateStatus(ctx);
        ctx.ui.notify(
          "Summary mode enabled — visit_page now offers `summary: true` to the model. " +
            "The subagent reuses the current session model by default (no footer indicator); " +
            "pin a different one with /browse provider + /browse model.",
          "info",
        );
        return;
      }

      if (trimmed === "off") {
        config.summaryEnabled = false;
        saveConfigFile();
        persistConfig();
        syncVisitPageTool();
        updateStatus(ctx);
        ctx.ui.notify(
          "Summary mode disabled — visit_page no longer advertises or accepts `summary`; the option is " +
            "hidden from the model and pages are returned as raw markdown. Re-enable with /browse on.",
          "info",
        );
        return;
      }

      const parts = trimmed.split(/\s+/);
      const subcommand = parts[0].toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (subcommand === "show" || subcommand === "status") {
        ctx.ui.notify(configSummary(ctx.model), "info");
        return;
      }

      // /browse clean on|off — toggle clean mode independently of summary mode
      if (subcommand === "clean") {
        const value = rest.trim().toLowerCase();
        if (!value) {
          ctx.ui.notify(
            `Clean mode is currently ${config.cleanEnabled ? "enabled" : "disabled"}. Use /browse clean on|off.`,
            "info",
          );
          return;
        }
        if (value !== "on" && value !== "off") {
          ctx.ui.notify(`Invalid value: "${rest}". Use /browse clean on|off.`, "error");
          return;
        }
        config.cleanEnabled = value === "on";
        saveConfigFile();
        persistConfig();
        syncVisitPageTool();
        ctx.ui.notify(
          config.cleanEnabled
            ? "Clean mode enabled — visit_page now offers `clean: true` to the model."
            : "Clean mode disabled — visit_page no longer advertises or accepts `clean`; the default extractor is always used.",
          "info",
        );
        return;
      }

      if (subcommand === "clear" || subcommand === "reset") {
        config.provider = undefined;
        config.model = undefined;
        config.maxTokens = parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? "2048", 10);
        config.defaultReasoningEffort = validateReasoningLevel(process.env.PI_BROWSE_REASONING_EFFORT) ?? "off";
        config.summaryEnabled = true;
        config.proxy = normalizeProxy(process.env.PI_SEARCH_PROXY) ?? "";
        saveConfigFile();
        persistConfig();
        syncVisitPageTool();
        updateStatus(ctx);
        ctx.ui.notify("Browse subagent config reset to defaults", "info");
        return;
      }

      // /browse config <setting> [value]
      if (subcommand === "config" || subcommand === "cfg") {
        const settingParts = rest.split(/\s+/);
        const setting = settingParts[0]?.toLowerCase();
        const value = settingParts.slice(1).join(" ");

        if (!setting) {
          ctx.ui.notify(configSummary(ctx.model), "info");
          return;
        }

        if (setting === "provider") {
          if (!value) {
            ctx.ui.notify(`Current provider: ${config.provider ?? "(not set)"}`, "info");
            return;
          }
          config.provider = value || undefined;
          saveConfigFile();
          persistConfig();
          updateStatus(ctx);
          ctx.ui.notify(`Browse subagent provider set to "${config.provider}"`, "info");
          return;
        }

        if (setting === "model") {
          if (!value) {
            ctx.ui.notify(`Current model: ${config.model ?? "(not set)"}`, "info");
            return;
          }
          config.model = value || undefined;
          saveConfigFile();
          persistConfig();
          updateStatus(ctx);
          ctx.ui.notify(`Browse subagent model set to "${config.model}"`, "info");
          return;
        }

        if (setting === "max-tokens" || setting === "maxtokens" || setting === "max_tokens") {
          if (!value) {
            ctx.ui.notify(`Current max tokens: ${config.maxTokens}`, "info");
            return;
          }
          const n = parseInt(value, 10);
          if (isNaN(n) || n < 1) {
            ctx.ui.notify(`Invalid max-tokens: "${value}". Must be a positive number.`, "error");
            return;
          }
          config.maxTokens = n;
          saveConfigFile();
          persistConfig();
          ctx.ui.notify(`Browse subagent max tokens set to ${config.maxTokens}`, "info");
          return;
        }

        if (setting === "reasoning-effort" || setting === "reasoning" || setting === "thinking") {
          if (!value) {
            ctx.ui.notify(`Current reasoning effort: ${config.defaultReasoningEffort}`, "info");
            return;
          }
          const level = validateReasoningLevel(value);
          if (!level) {
            ctx.ui.notify(
              `Invalid reasoning level: "${value}". Use: off, minimal, low, medium, high, xhigh`,
              "error",
            );
            return;
          }
          config.defaultReasoningEffort = level;
          saveConfigFile();
          persistConfig();
          ctx.ui.notify(`Browse subagent reasoning effort set to "${config.defaultReasoningEffort}"`, "info");
          return;
        }

        if (setting === "proxy") {
          if (!value) {
            ctx.ui.notify(
              `Current Chrome proxy: ${config.proxy || "(direct, no proxy)"}\n\n` +
                `Set it with: /browse config proxy http://127.0.0.1:8010\n` +
                `Clear it with: /browse config proxy off\n` +
                `Also honored: the PI_SEARCH_PROXY environment variable.`,
              "info",
            );
            return;
          }
          const applied = applyProxyArgument(value);
          ctx.ui.notify(applied.message, applied.ok ? "info" : "error");
          return;
        }

        ctx.ui.notify(
          `Unknown config setting: "${setting}". Use: provider, model, max-tokens, reasoning-effort, proxy`,
          "error",
        );
        return;
      }

      // Shorthand: /browse provider <name> or /browse model <name>
      if (subcommand === "provider") {
        if (!rest) {
          ctx.ui.notify(`Current provider: ${config.provider ?? "(not set)"}`, "info");
          return;
        }
        config.provider = rest || undefined;
        saveConfigFile();
        persistConfig();
        updateStatus(ctx);
        ctx.ui.notify(`Browse subagent provider set to "${config.provider}"`, "info");
        return;
      }

      if (subcommand === "model") {
        if (!rest) {
          ctx.ui.notify(`Current model: ${config.model ?? "(not set)"}`, "info");
          return;
        }
        config.model = rest || undefined;
        saveConfigFile();
        persistConfig();
        updateStatus(ctx);
        ctx.ui.notify(`Browse subagent model set to "${config.model}"`, "info");
        return;
      }

      // Shorthand: /browse proxy <url|off>
      if (subcommand === "proxy") {
        if (!rest) {
          ctx.ui.notify(`Current Chrome proxy: ${config.proxy || "(direct, no proxy)"}`, "info");
          return;
        }
        const applied = applyProxyArgument(rest);
        ctx.ui.notify(applied.message, applied.ok ? "info" : "error");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand: "${subcommand}". Use: config, show, clear, on, off, clean (or provider/model)`,
        "error",
      );
    },
  });

  // ── google_search tool ───────────────────────────────────────────────────

  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search Google in your visible Chrome browser and return compact Markdown links. Uses your real browser fingerprint — no API keys, no headless detection.",
    promptSnippet: "google_search: search Google in your visible browser, returns markdown links",
    promptGuidelines: [
      "Use google_search to find web pages when you need real-time information. Results include clickable markdown links.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query to send to Google" }),
    }),
    async execute(_toolCallId, params, _signal, onUpdate) {
      const { query } = params;
      if (!query || !query.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: google_search requires a query." }],
          details: {},
        };
      }

      try {
        const started = Date.now();
        const result = await googleSearch(query.trim(), (msg) => {
          onUpdate?.({
            content: [{ type: "text", text: msg }],
            details: { _progress: true },
          });
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);

        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: { url: result.url, elapsed: `${elapsed}s`, chars: result.markdown.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`google_search failed: ${message}`);
      }
    },

    renderCall(args: Partial<RenderArgs>, theme: ToolTheme) {
      const q = (args.query || "").slice(0, 60);
      const trunc = q.length < (args.query || "").length ? "..." : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("google_search"))} "${theme.fg("accent", q + trunc)}"`,
        0,
        0,
      );
    },

    renderResult(result: ToolResult, { expanded, isPartial }: RenderState, theme: ToolTheme) {
      if (isPartial) {
        const progress = result.content.find((c) => c.type === "text")?.text ?? "Searching...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details as { url?: string; elapsed?: string; chars?: number } | undefined;
      if (!expanded) {
        const parts: string[] = [];
        if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
        if (details?.elapsed) parts.push(details.elapsed);
        if (details?.url) parts.push(new URL(details.url).hostname);
        return new Text(theme.fg("muted", ` → ${parts.join(" · ")}`), 0, 0);
      }

      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
    },
  });

  // ── visit_page tool ──────────────────────────────────────────────────────
  // visit_page is (re)registered from the current config by syncVisitPageTool().
  // The flags (`summaryEnabled`, `cleanEnabled`) hide their option and every
  // mention of it from the model; pi replaces a same-named tool and refreshes
  // the registry in the same session, so /browse on|off and /browse clean
  // on|off take effect on the next turn.
  const syncVisitPageTool = () => pi.registerTool(visitPageToolDefinition());
  syncVisitPageTool();

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("google-search-kill", {
    description: "Kill the Google Search Chrome browser process",
    handler: async (_args, ctx) => {
      await shutdownChrome();
      ctx.ui.notify("Google Search Chrome killed. The next search relaunches it, applying any proxy change.", "info");
    },
  });
}
