// pi-search-on-your-browser - exact same approach as ds4-agent, for Pi
//
// @antirez's ds4-agent strategy:
//   https://x.com/antirez/status/2066233392916525379
//   https://github.com/antirez/ds4
//
// Same approach: visible Chrome (not headless), CDP WebSocket, inline JS
// extractors. No API keys, no headless detection.
//
// Registered tools:
//   - google_search   - Search Google in a visible Chrome browser, returns markdown links + snippet
//   - google_image_search - Search Google Images. Every result is the image URL plus the
//                       URL of the page the image was found on (plus title and size). The
//                       original image URL is resolved through Google's preview panel. Hosts
//                       that block hotlinking fall back to Google's cached thumbnail.
//   - google_search_by_image - Reverse image search: upload a local image file to Google Lens
//                       and return the pages showing the same image (`mode: "exact"`) or
//                       visually similar images and their pages (`mode: "visual"`).
//   - visit_page      - Visit a URL in a visible Chrome browser, returns rendered page as markdown.
//                       X (Twitter) URLs get a dedicated tweet extractor (search/profile/tweet).
//                       Reddit post URLs get a dedicated comment extractor (post + threaded comments).
//                       Amazon product & search URLs get a dedicated product/listing extractor.
//                       Google Scholar URLs get a dedicated academic paper extractor.
//
//                       Optional `summary` parameter: when `true`, the full page content is read
//                       by a configurable subagent model and only a concise summary is returned -
//                       the raw page markdown never enters the chat context.
//
//                       When summary mode is disabled - `"summaryEnabled": false` in the config
//                       file, or `PI_BROWSE_SUMMARY_ENABLED=0` - the `summary`
//                       parameter is removed from the tool schema and the description, prompt
//                       snippet, and guidelines are swapped for variants that never mention it,
//                       so the model is not told the option exists.
//
//                       `clean` is gated independently by `cleanEnabled`: `"cleanEnabled": false`
//                       in the config file, or `PI_BROWSE_CLEAN_ENABLED=0`
//                       removes the `clean` parameter and every mention of it, including the
//                       "Combine with `clean: true`" sentence in the summary parameter
//                       description. Disabling one feature never affects the other, or the rest
//                       of the tool (`url` and google_search always work).
//
// Chrome runs in a visible window (not headless) with a dedicated profile at
// ~/.pi-search-browser/ - cookies and sessions persist across calls.

import {
  defineTool,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { googleSearch, googleImageSearch, reverseImageSearch, visitPage, type SearchResult } from "./src/chrome.js";
import {
  config,
  reloadConfig,
  setConfigDir,
  truncateForContext,
  buildSummaryPrompt,
  SUBAGENT_SYSTEM_PROMPT,
} from "./src/subagent.js";
import {
  visitPageSurface,
  visitPageParameters,
  stripDisabledArguments,
} from "./src/tool-surface.js";

// Structured details of the visit_page tool result (rendered + persisted).
interface VisitPageDetails {
  url?: string;
  elapsed?: string;
  chars?: number;
  summarized?: boolean;
  originalChars?: number;
  model?: string;
  clean?: boolean;
  httpStatus?: number;
  truncated?: boolean;
  error?: string;
  // Marks an onUpdate progress payload (never persisted).
  _progress?: boolean;
}

// Structured details of the google_search tool result (rendered + persisted).
interface GoogleSearchDetails {
  url?: string;
  elapsed?: string;
  chars?: number;
  // Marks an onUpdate progress payload (never persisted).
  _progress?: boolean;
}

interface GoogleImageSearchDetails extends GoogleSearchDetails {
  count?: number;
}

interface GoogleSearchByImageDetails extends GoogleSearchDetails {
  mode?: string;
  path?: string;
}

// First text block of a tool result, or "" when there is none.
function resultText<T>(result: AgentToolResult<T>): string {
  for (const part of result.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

// Footer status indicator for the summary subagent.
//
// Pi's own footer already shows the current session model, and by default the
// subagent reuses that exact model - so repeating it here adds nothing but a
// line of noise (it renders byte-for-byte the same `provider/model`). The
// status line therefore only appears when the subagent is pinned to a
// *different* model, which is the one thing Pi's footer cannot tell you.
//
// The transient spinner shown while a summary call is in flight is set
// separately (and reflects the model actually being called), so it is
// unaffected by this.
function updateStatus(ctx: {
  ui: { setStatus: (id: string, text: string | undefined) => void };
}) {
  if (config.summaryEnabled && config.provider && config.model) {
    ctx.ui.setStatus("browse", `🌐 ${config.provider}/${config.model}`);
    return;
  }
  ctx.ui.setStatus("browse", undefined);
}

// Build the visit_page tool definition from the current config.
//
// The `summaryEnabled` and `cleanEnabled` flags each gate one feature: while
// enabled its parameter is required, and when disabled it is hidden from the
// model completely - omitted from the schema and never mentioned in the
// description, prompt snippet, or guidelines. Registered by syncVisitPageTool()
// in the factory, so a config change applies to the next turn.
function visitPageToolDefinition() {
  const summaryEnabled = config.summaryEnabled;
  const cleanEnabled = config.cleanEnabled;
  const surface = visitPageSurface({ summaryEnabled, cleanEnabled });
  const parameters = visitPageParameters({ summaryEnabled, cleanEnabled });

  return defineTool<typeof parameters, VisitPageDetails>({
    name: "visit_page",
    label: "Visit Page",
    description: surface.description,
    promptSnippet: surface.promptSnippet,
    promptGuidelines: surface.promptGuidelines,
    parameters,
    prepareArguments:
      summaryEnabled && cleanEnabled
        ? undefined
        : (args: unknown) =>
            // A disabled feature was dropped from the schema, so the stripped
            // result can omit a property TypeBox's static type still lists. The
            // cast only bridges that (validation uses the built schema).
            stripDisabledArguments(args, { summaryEnabled, cleanEnabled }) as {
              url: string;
              clean: boolean;
              summary: boolean;
            },
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

      const summarize = config.summaryEnabled && params.summary === true;
      const useClean = config.cleanEnabled && clean === true;

      // Summary mode: resolve the subagent BEFORE fetching
      // Resolves model + credentials up front so a misconfigured subagent does
      // not waste a browser navigation.
      let subModel: Model<Api> | undefined;

      if (summarize) {
        // By default the subagent reuses the current session model (ctx.model)
        // - no provider/model config or API keys needed, since Pi already has
        // them.
        if (config.provider && config.model) {
          subModel = ctx.modelRegistry.find(config.provider, config.model);
          if (!subModel) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `Browse subagent error: model "${config.provider}/${config.model}" not found in the model registry.`,
                    "",
                    "Make sure the provider and model are defined in ~/.pi/agent/models.json .",
                  ].join("\n"),
                },
              ],
              details: { url: targetUrl, summarized: true, error: "model_not_found" },
              isError: true,
            };
          }
        } else {
          subModel = ctx.model;
          if (!subModel) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Browse subagent error: no model is active in this session. Start a session with a model first.",
                },
              ],
              details: { url: targetUrl, summarized: true, error: "no_current_model" },
              isError: true,
            };
          }
        }

        if (!ctx.modelRegistry.hasConfiguredAuth(subModel)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Browse subagent error: no credentials configured for provider "${subModel.provider}". Run /login for it.`,
              },
            ],
            details: { url: targetUrl, summarized: true, error: "auth_error" },
            isError: true,
          };
        }
      }

      // Fetch the page
      const started = Date.now();
      let result: SearchResult;
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

      // Navigation failed (DNS/proxy/TLS/HTTPS-upgrade): the tab never got a
      // document (Chrome's error page). Report it instead of an empty page so
      // the model can try another URL or check the network.
      if (result.navError) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Navigation failed for ${result.url} . The browser could not load the page ` +
                `(DNS, proxy, TLS, or the site redirected the tab to an error page). ` +
                `The URL may be unreachable from this network, or the page may have moved.`,
            },
          ],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, navError: result.navError },
          isError: true,
        };
      }

      // Wall instead of content: the page is a bot check that did not clear, a
      // CAPTCHA or login gate, a JavaScript shell, or a file download that is
      // not text. Say what it is so the model does not treat it as the page.
      if (result.blocked) {
        const { kind, detail } = result.blocked;
        // These are failures, not instructions. A gate that needs a person
        // (CAPTCHA, slider, login) stays an error: the agent runs unattended,
        // so "solve this in the window" is not an action it can take.
        // Delegating interactive gates to a general browser-use tool is
        // possible later. Until then they are reported as inaccessible.
        let text: string;
        if (kind === "challenge") {
          text =
            `The site answered ${result.url} with a bot check instead of the page (${detail}), ` +
            `and it did not clear after waiting. The page content is not reachable from this tool.`;
        } else if (kind === "captcha") {
          text =
            `${result.url} is gated by an interactive check (${detail}), which this tool does not ` +
            `perform. The page content is not reachable from this tool.`;
        } else if (kind === "login") {
          text = `${result.url} requires a login (${detail}). The page content is not reachable from this tool.`;
        } else if (kind === "shell") {
          text =
            `The page at ${result.url} rendered no readable text (${detail}) even after waiting. ` +
            `It is a JavaScript app that did not hydrate. Retrying once may work.`;
        } else if (kind === "download") {
          text =
            `${result.url} is a file download, not a web page (${detail}). ` +
            `It cannot be returned as page Markdown. Download the file instead.`;
        } else {
          text = `The page could not be read (${kind}: ${detail}).`;
        }
        return {
          content: [{ type: "text" as const, text }],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, blocked: kind },
          isError: true,
        };
      }

      // HTTP error (4xx/5xx) -> surface as an error result
      // The server returned an error status (e.g. 404 on a dead link). Return
      // isError so the LLM knows the URL didn't work and can try another -
      // instead of receiving the error page's content as if it were the page.
      if (result.httpStatus && result.httpStatus >= 400) {
        const code = result.httpStatus;
        const reason = result.httpStatusText || "";
        let hint: string;
        if (code === 404) {
          hint = "The page does not exist at this URL. The content may have been moved, removed, or the URL may be incorrect. Try a different URL or search for the content.";
        } else if (code === 403) {
          const isChallenge = /challenge|bot|captcha|cloudflare|datadome|perimeterx|incapsula/i.test(reason);
          hint = isChallenge
            ? "The site served a bot check that did not clear automatically. The page content is not reachable from this tool."
            : "Access was denied. The site may be blocking automated access, require authentication, or be behind a paywall.";
        } else if (code === 429) {
          hint = "Rate limited. Too many requests. Wait a moment and retry.";
        } else if (code >= 500) {
          hint = "The server had an error. Retry shortly, or try a different URL.";
        } else {
          hint = "The server returned an error. The URL may be incorrect or the content unavailable.";
        }
        return {
          content: [
            { type: "text" as const, text: `HTTP ${code}${reason ? ` ${reason}` : ""} - ${hint}` },
          ],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, httpStatus: code },
          isError: true,
        };
      }

      // No summary -> return full page markdown (existing behavior)
      if (!summarize) {
        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: { url: result.url, elapsed: `${fetchElapsed}s`, chars: result.markdown.length, clean: useClean },
        };
      }

      // Summary mode -> delegate to the subagent
      // Only the subagent's summary enters the chat context. The full page
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
        model.contextWindow,
        config.maxTokens,
      );

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Page fetched (${originalChars.toLocaleString()} chars in ${fetchElapsed}s). Asking ${model.id} to summarize...`,
          },
        ],
        details: { _progress: true },
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
        // Provider-neutral nested model call: Pi resolves auth, provider base
        // URL, headers, per-provider reasoning params, and usage accounting.
        const stream = ctx.modelRegistry.streamSimple(
          model,
          {
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: buildSummaryPrompt(result.url, fitContent),
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: config.maxTokens,
            temperature: 0,
            signal,
            ...(config.defaultReasoningEffort === "off"
              ? {}
              : { reasoning: config.defaultReasoningEffort }),
          },
        );
        const response = await stream.result();

        if (response.stopReason === "error" || response.stopReason === "aborted") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Browse subagent error: ${response.errorMessage || `request ${response.stopReason}`}`,
              },
            ],
            details: {
              url: result.url,
              summarized: true,
              originalChars,
              model: modelLabel,
              error: "subagent_call_error",
            },
            isError: true,
            usage: response.usage,
          };
        }

        const answer =
          response.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim() || "(no response from subagent model)";

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
          usage: response.usage,
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

    renderCall(args, theme) {
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

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const progress = resultText(result) || "Loading...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details;

      if (!expanded) {
        const parts: string[] = [];

        // HTTP error (4xx/5xx) - show the status code prominently.
        if (details?.httpStatus) {
          parts.push(`HTTP ${details.httpStatus}`);
        }
        if (details?.summarized) {
          if (details.originalChars != null && details.chars != null && details.originalChars > 0) {
            parts.push(`${details.originalChars.toLocaleString()}->${details.chars.toLocaleString()} chars`);
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
          return new Text(theme.fg("muted", ` -> ${parts.join(" - ")}`), 0, 0);
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
        return new Text(theme.fg("muted", ` -> ${parts.join(" - ")}`), 0, 0);
      }

      const text = resultText(result);
      return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
    },
  });
}

export default function searchOnYourBrowser(pi: ExtensionAPI) {
  // Load config before first use
  // The visit_page tool surface depends on `summaryEnabled` (summary offered
  // vs hidden), so the config file is read before the tool is registered, not
  // just on session_start.
  setConfigDir(getAgentDir());
  reloadConfig();

  // Re-read the config file for each session so edits made while Pi is running
  // apply on the next session, and re-register visit_page for the new surface.
  pi.on("session_start", async (_event, ctx) => {
    setConfigDir(getAgentDir());
    reloadConfig();
    syncVisitPageTool();
    updateStatus(ctx);
  });

  // google_search tool

  const googleSearchParams = Type.Object({
    query: Type.String({ description: "Search query to send to Google" }),
  });

  pi.registerTool(
    defineTool<typeof googleSearchParams, GoogleSearchDetails>({
      name: "google_search",
      label: "Google Search",
      description:
        "Search Google in your visible Chrome browser. Returns links.",
      promptSnippet: "Google search. Returns links.",
      parameters: googleSearchParams,
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

      renderCall(args, theme) {
        const q = (args.query || "").slice(0, 60);
        const trunc = q.length < (args.query || "").length ? "..." : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("google_search"))} "${theme.fg("accent", q + trunc)}"`,
          0,
          0,
        );
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial) {
          const progress = resultText(result) || "Searching...";
          return new Text(theme.fg("warning", progress), 0, 0);
        }

        const details = result.details;
        if (!expanded) {
          const parts: string[] = [];
          if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
          if (details?.elapsed) parts.push(details.elapsed);
          if (details?.url) parts.push(new URL(details.url).hostname);
          return new Text(theme.fg("muted", ` -> ${parts.join(" - ")}`), 0, 0);
        }

        const text = resultText(result);
        return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
      },
    }),
  );

  // google_image_search tool

  const googleImageSearchParams = Type.Object({
    query: Type.String({ description: "Image search query to send to Google Images" }),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 12,
        description: "How many image results to return (1-12, default 8). Higher counts are slower.",
      }),
    ),
  });

  pi.registerTool(
    defineTool<typeof googleImageSearchParams, GoogleImageSearchDetails>({
      name: "google_image_search",
      label: "Google Image Search",
      description:
        "Search Google Images in your visible Chrome browser. Each result gives the image URL, the page URL it appears on, title, and size. Hotlink-blocked images fall back to Google's cached thumbnail (marked google-cached).",
      promptSnippet:
        "Google Images. Returns each image URL with the page URL it appears on.",
      parameters: googleImageSearchParams,
      async execute(_toolCallId, params, _signal, onUpdate) {
        const { query, count } = params;
        if (!query || !query.trim()) {
          return {
            content: [{ type: "text" as const, text: "Tool error: google_image_search requires a query." }],
            details: {},
          };
        }

        try {
          const started = Date.now();
          const result = await googleImageSearch(query.trim(), {
            count,
            onStatus: (msg) => {
              onUpdate?.({
                content: [{ type: "text", text: msg }],
                details: { _progress: true },
              });
            },
          });
          const elapsed = ((Date.now() - started) / 1000).toFixed(1);

          return {
            content: [{ type: "text" as const, text: result.markdown }],
            details: {
              url: result.url,
              elapsed: `${elapsed}s`,
              chars: result.markdown.length,
              count,
            },
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`google_image_search failed: ${message}`);
        }
      },

      renderCall(args, theme) {
        const q = (args.query || "").slice(0, 60);
        const trunc = q.length < (args.query || "").length ? "..." : "";
        const count = args.count ? theme.fg("dim", ` x${args.count}`) : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("google_image_search"))} "${theme.fg("accent", q + trunc)}"${count}`,
          0,
          0,
        );
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial) {
          const progress = resultText(result) || "Searching images...";
          return new Text(theme.fg("warning", progress), 0, 0);
        }

        const details = result.details;
        if (!expanded) {
          const parts: string[] = [];
          if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
          if (details?.elapsed) parts.push(details.elapsed);
          if (details?.url) parts.push(new URL(details.url).hostname);
          return new Text(theme.fg("muted", ` -> ${parts.join(" - ")}`), 0, 0);
        }

        const text = resultText(result);
        return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
      },
    }),
  );

  // google_search_by_image tool

  const googleSearchByImageParams = Type.Object({
    path: Type.String({
      description:
        "Local image path (absolute, relative to cwd, or `~/...`), up to 20 MB.",
    }),
    mode: Type.Union([Type.Literal("exact"), Type.Literal("visual")], {
      description:
        "`exact`: find sources/usage. `visual`: find lookalikes/context.",
    }),
  });

  pi.registerTool(
    defineTool<typeof googleSearchByImageParams, GoogleSearchByImageDetails>({
      name: "google_search_by_image",
      label: "Google Search by Image",
      description:
        "Reverse image search: upload a local image file to Google Lens and return the pages where it appears, with their sources.",
      promptSnippet: "Reverse image search from a local image file.",
      parameters: googleSearchByImageParams,
      async execute(_toolCallId, params, _signal, onUpdate) {
        const { path, mode } = params;
        if (!path || !path.trim()) {
          return {
            content: [{ type: "text" as const, text: "Tool error: google_search_by_image requires an image path." }],
            details: {},
          };
        }

        try {
          const started = Date.now();
          const result = await reverseImageSearch(path.trim(), {
            mode,
            onStatus: (msg) => {
              onUpdate?.({
                content: [{ type: "text", text: msg }],
                details: { _progress: true },
              });
            },
          });
          const elapsed = ((Date.now() - started) / 1000).toFixed(1);

          return {
            content: [{ type: "text" as const, text: result.markdown }],
            details: {
              url: result.url,
              elapsed: `${elapsed}s`,
              chars: result.markdown.length,
              mode,
              path,
            },
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`google_search_by_image failed: ${message}`);
        }
      },

      renderCall(args, theme) {
        const base = (args.path || "").split(/[\\/]/).pop() || "";
        const mode = args.mode ? theme.fg("dim", ` ${args.mode}`) : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("google_search_by_image"))} ${theme.fg("accent", base)}${mode}`,
          0,
          0,
        );
      },

      renderResult(result, { expanded, isPartial }, theme) {
        if (isPartial) {
          const progress = resultText(result) || "Searching...";
          return new Text(theme.fg("warning", progress), 0, 0);
        }

        const details = result.details;
        if (!expanded) {
          const parts: string[] = [];
          if (details?.mode) parts.push(details.mode);
          if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
          if (details?.elapsed) parts.push(details.elapsed);
          if (details?.url) parts.push(new URL(details.url).hostname);
          return new Text(theme.fg("muted", ` -> ${parts.join(" - ")}`), 0, 0);
        }

        const text = resultText(result);
        return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
      },
    }),
  );

  // visit_page tool
  // visit_page is (re)registered from the current config by syncVisitPageTool().
  // The flags (`summaryEnabled`, `cleanEnabled`) hide their option and every
  // mention of it from the model. Pi replaces a same-named tool and refreshes
  // the registry in the same session.
  const syncVisitPageTool = () => pi.registerTool(visitPageToolDefinition());
  syncVisitPageTool();
}
