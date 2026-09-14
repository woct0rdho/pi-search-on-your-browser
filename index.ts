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

type RenderArgs = { query?: string; url?: string; clean?: boolean; summary?: boolean };
type RenderState = { expanded?: boolean; isPartial?: boolean };
type ToolTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
};

/** Footer status indicator for the subagent.
 *  Shows the pinned provider/model when configured, otherwise the current
 *  session model (since summary mode reuses it by default). */
function updateStatus(ctx: {
  ui: { setStatus: (id: string, text: string | undefined) => void };
  model?: { provider: string; id: string } | undefined;
}) {
  if (!config.enabled) {
    ctx.ui.setStatus("browse", undefined);
    return;
  }
  if (config.provider && config.model) {
    ctx.ui.setStatus("browse", `🌐 ${config.provider}/${config.model}`);
  } else if (ctx.model) {
    ctx.ui.setStatus("browse", `🌐 ${ctx.model.provider}/${ctx.model.id}`);
  } else {
    ctx.ui.setStatus("browse", "🌐 (no model)");
  }
}

export default function searchOnYourBrowser(pi: ExtensionAPI) {
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
        if (data.enabled !== undefined) config.enabled = data.enabled;
        if (data.proxy !== undefined) config.proxy = data.proxy;
      }
    }

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
        config.enabled = true;
        saveConfigFile();
        persistConfig();
        updateStatus(ctx);
        ctx.ui.notify("Browse subagent enabled. The 🌐 indicator is now visible in the footer.", "info");
        return;
      }

      if (trimmed === "off") {
        config.enabled = false;
        saveConfigFile();
        persistConfig();
        updateStatus(ctx);
        ctx.ui.notify("Browse subagent disabled. visit_page will return raw page markdown even when a summary is requested.", "info");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const subcommand = parts[0].toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (subcommand === "show" || subcommand === "status") {
        ctx.ui.notify(configSummary(ctx.model), "info");
        return;
      }

      if (subcommand === "clear" || subcommand === "reset") {
        config.provider = undefined;
        config.model = undefined;
        config.maxTokens = parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? "2048", 10);
        config.defaultReasoningEffort = validateReasoningLevel(process.env.PI_BROWSE_REASONING_EFFORT) ?? "off";
        config.enabled = true;
        config.proxy = normalizeProxy(process.env.PI_SEARCH_PROXY) ?? "";
        saveConfigFile();
        persistConfig();
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
        `Unknown subcommand: "${subcommand}". Use: config, show, clear, on, off (or provider/model)`,
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

  pi.registerTool({
    name: "visit_page",
    label: "Visit Page",
    description:
      "Open a URL in your visible Chrome browser and return the rendered page as Markdown. Works with authenticated sites, paywalls, and JavaScript-heavy pages. X (Twitter) URLs (search, profile, or tweet) are extracted as structured tweets with handle, timestamp, permalink, and engagement. Reddit post URLs are extracted as the post plus threaded comments with author, score, and OP marking. Amazon product pages are extracted as structured product data (title, price, availability, brand, rating, features, tech specs, ASIN) and Amazon search URLs as a clean product listing. Google Scholar search URLs are extracted as structured paper results (title, authors, venue, year, citation count, snippet, PDF link). Pass `summary: true` to have a configurable subagent model read the page and return only a concise summary of ALL the information on it — the raw page markdown is NOT added to your chat context, which keeps large pages from filling it. Configure the subagent with /browse.",
    promptSnippet:
      "visit_page: visit a URL in your visible browser, returns rendered markdown (X/Twitter URLs yield structured tweets; Reddit posts yield post + threaded comments; Amazon products yield structured product data; Google Scholar yields structured paper results). Pass `summary: true` to get only a concise subagent summary of the page instead of the full page markdown (keeps context small). Configure via /browse.",
    promptGuidelines: [
      "Use visit_page to read a web page you found via google_search. It opens in your visible Chrome so authenticated/paywalled sites work.",
      "For X (Twitter) URLs — search results, profiles, or individual tweets — visit_page extracts structured tweets (handle, text, timestamp, permalink, engagement). Search X by visiting https://x.com/search?q=<query>&f=top (or &f=live for latest).",
      "For Reddit post URLs (any reddit.com .../comments/... link) visit_page extracts the post (title, author, score, body) plus threaded comments (author, score, OP marking, depth-indented replies). Subreddit listings and user pages use the generic extractor.",
      "For Amazon product pages (any amazon.* /dp/ASIN, /gp/product/ASIN URL) visit_page extracts structured product data: title, price, list price, availability, brand, rating, review count, feature bullets, technical specifications, and ASIN. For Amazon search URLs (amazon.* /s?k=...) it returns a clean listing of products with title, price, rating, ASIN, and link. Other Amazon pages (category, seller, etc.) use the generic extractor.",
      "For Google Scholar URLs (scholar.google.com/scholar?q=...) visit_page extracts structured paper results: title, authors/venue/year, citation count, abstract snippet, and PDF link. Scholar paginates 10 results per page; for more, visit_page the next page URL (add &start=10, &start=20, etc.).",
      "visit_page accepts a `summary` flag. Pass `summary: true` and the full page content is read by a subagent model that returns only a concise summary of ALL the information on the page — the raw page markdown never enters your chat context. This keeps large pages (docs, articles, product pages) from filling the conversation. The subagent reuses your current Pi model by default (no setup needed); pin a different one with /browse. Prefer `summary` for large pages where you do not need every word verbatim. Avoid `summary` when you need verbatim text (code snippets, API signatures, exact numbers, error messages) since the subagent paraphrases; when the page is already small; or when the page content itself is the deliverable.",
      "visit_page accepts a `clean` flag. For articles, docs, or blog posts, pass `clean: true` to extract only the main article content as clean Markdown (drops nav/sidebars/ads/footer) — far fewer tokens. No effect on X/Reddit/Amazon/Scholar (already clean). Falls back to the generic extractor if Defuddle fails. Avoid `clean` on non-article pages (dashboards, indexes with no clear main content) where Defuddle may extract the wrong block or nothing. Note: `clean` preserves content links (article URLs, citations, story links) but drops chrome links (nav bars, sidebars, footers, action buttons) — so it's fine for gathering content links, but avoid it if you specifically need nav/footer links (e.g. finding the 'About' or 'Contact' page URL).",
      "For research tasks — reading multiple papers, articles, or docs — use `clean: true` + `summary: true` together by default. `clean` gives the subagent pure article text (no nav noise, no 90KB truncation) so its summary is faster and more reliable; `summary` keeps each page's full content out of your context. This combination is the optimal pattern for intensive research: search → visit each result with clean+summary → synthesize from the concise summaries.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to visit" }),
      clean: Type.Optional(
        Type.Boolean({
          description:
            "Extract only the page's main article content as clean Markdown (via Defuddle) instead of the default block-walker. Drops navigation, sidebars, ads, footers, and the visible-links dump — far fewer tokens. Best for articles, docs, blog posts. No effect on X/Reddit/Amazon/Scholar (already clean). Falls back to the generic extractor if Defuddle fails. Avoid on non-article pages (dashboards, indexes) where there is no clear main content. Preserves content links (article URLs, citations) but drops chrome links (nav/footer/action buttons).",
        }),
      ),
      summary: Type.Optional(
        Type.Boolean({
          description:
            "When true, the full page content is read by a subagent model that returns only a concise summary of ALL the information on the page — the raw page markdown is NOT added to your chat context. Use this for large pages to keep the conversation compact. The subagent reuses your current Pi model by default; pin a different one with /browse. Combine with `clean: true` for articles (gives the subagent clean text, avoiding nav noise and truncation). Avoid when you need verbatim text (code, API signatures, exact numbers) since the subagent paraphrases, or when the page is already small.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { url, clean, summary } = params;
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

      const summarize = summary === true;

      // ── Summary mode: resolve the subagent BEFORE fetching ────────────────
      // Resolves config/model/auth up front so a misconfigured subagent does
      // not waste a browser navigation. Mirrors the vision tool's checks.
      let subModel: Parameters<typeof callSubagentModel>[0] | undefined;
      let subApiKey: string | undefined;
      let subHeaders: Record<string, string> | undefined;

      if (summarize) {
        if (!config.enabled) {
          return {
            content: [
              { type: "text" as const, text: "Browse subagent is disabled. Use /browse on to enable it." },
            ],
            details: { url: targetUrl, summarized: true, error: "subagent_disabled" },
            isError: true,
          };
        }

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
          clean: clean === true,
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
          details: { url: result.url, elapsed: `${fetchElapsed}s`, chars: result.markdown.length, clean: clean === true },
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
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("google-search-kill", {
    description: "Kill the Google Search Chrome browser process",
    handler: async (_args, ctx) => {
      await shutdownChrome();
      ctx.ui.notify("Google Search Chrome killed. The next search relaunches it, applying any proxy change.", "info");
    },
  });
}
