/**
 * Agent-facing text for `visit_page` — description, prompt snippet, prompt
 * guidelines, and parameter descriptions.
 *
 * The two optional features are each controlled by a config flag:
 *
 *   - `summaryEnabled` — the `summary: true` subagent mode.
 *   - `cleanEnabled`   — the `clean: true` Defuddle reader-mode extraction.
 *
 * `visitPageSurface()` builds the text for the current flags, so the tool
 * description sent to the model stays minimal and only grows as features are
 * enabled: base → +clean → +summary. A disabled feature must be invisible to
 * the model: no string may mention it (or point at /browse for it), and
 * index.ts drops its parameter from the schema. Keeping the strings here makes
 * that testable for every combination.
 */

export interface VisitPageOptions {
  summaryEnabled: boolean;
  cleanEnabled: boolean;
}

export interface VisitPageSurface {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  /** Present only when summary mode is enabled. */
  summaryParamDescription?: string;
  /** Present only when clean mode is enabled. */
  cleanParamDescription?: string;
}

const DESCRIPTION_BASE =
  "Open a URL in your visible Chrome browser and return the rendered page as Markdown. " +
  "Works with authenticated sites, paywalls, and JavaScript-heavy pages.";

const DESCRIPTION_CLEAN =
  " Pass `clean: true` to extract only the main article content — best for articles, docs, and blog posts (drops nav/sidebars/ads).";

const DESCRIPTION_SUMMARY =
  " Pass `summary: true` to have a configurable subagent model read the page and return only a concise summary of ALL the information on it — " +
  "the raw page markdown is NOT added to your chat context, which keeps large pages from filling it. " +
  "Configure the subagent with /browse.";

const SNIPPET_BASE =
  "visit_page: visit a URL in your visible browser, returns rendered markdown.";

const SNIPPET_CLEAN = " Pass `clean: true` for just the main article content.";

const SNIPPET_SUMMARY =
  " Pass `summary: true` to get only a concise subagent summary of the page instead of the full page markdown (keeps context small); configure via /browse.";

const CORE_GUIDELINES = [
  "Use visit_page to read a web page you found via google_search. It opens in your visible Chrome so authenticated/paywalled sites work.",
];

const CLEAN_GUIDELINE =
  "visit_page accepts a `clean` flag. For articles, docs, or blog posts, pass `clean: true` to extract only the main article content as clean Markdown (drops nav/sidebars/ads/footer) — far fewer tokens. Avoid `clean` on non-article pages (dashboards, indexes with no clear main content) where it may extract the wrong block or nothing. Note: `clean` preserves content links (article URLs, citations, story links) but drops chrome links (nav bars, sidebars, footers, action buttons) — so it's fine for gathering content links, but avoid it if you specifically need nav/footer links (e.g. finding the 'About' or 'Contact' page URL).";

const SUMMARY_GUIDELINE =
  "visit_page accepts a `summary` flag. Pass `summary: true` and the full page content is read by a subagent model that returns only a concise summary of ALL the information on the page — the raw page markdown never enters your chat context. This keeps large pages (docs, articles, product pages) from filling the conversation. The subagent reuses your current Pi model by default (no setup needed); pin a different one with /browse. Prefer `summary` for large pages where you do not need every word verbatim. Avoid `summary` when you need verbatim text (code snippets, API signatures, exact numbers, error messages) since the subagent paraphrases; when the page is already small; or when the page content itself is the deliverable.";

const RESEARCH_GUIDELINE =
  "For research tasks — reading multiple papers, articles, or docs — use `clean: true` + `summary: true` together by default. `clean` gives the subagent pure article text (no nav noise, no 90KB truncation) so its summary is faster and more reliable; `summary` keeps each page's full content out of your context. This combination is the optimal pattern for intensive research: search → visit each result with clean+summary → synthesize from the concise summaries.";

const CLEAN_PARAM_DESCRIPTION =
  "Extract only the page's main article content as clean Markdown instead of the default page extraction. Drops navigation, sidebars, ads, footers, and the visible-links dump — far fewer tokens. Best for articles, docs, blog posts. Avoid on non-article pages (dashboards, indexes) where there is no clear main content. Falls back to the default extraction if no article content is found. Preserves content links (article URLs, citations) but drops chrome links (nav/footer/action buttons).";

const SUMMARY_PARAM_BASE =
  "When true, the full page content is read by a subagent model that returns only a concise summary of ALL the information on the page — the raw page markdown is NOT added to your chat context. Use this for large pages to keep the conversation compact. The subagent reuses your current Pi model by default; pin a different one with /browse.";

const SUMMARY_PARAM_CLEAN =
  " Combine with `clean: true` for articles (gives the subagent clean text, avoiding nav noise and truncation).";

const SUMMARY_PARAM_TAIL =
  " Avoid when you need verbatim text (code, API signatures, exact numbers) since the subagent paraphrases, or when the page is already small.";

/**
 * Build the agent-facing visit_page surface for the current config.
 *
 * A disabled feature is omitted from every string. Interactions: when `clean`
 * is disabled, the "Combine with `clean: true`" sentence is dropped from the
 * summary parameter description; the clean+summary research guideline appears
 * only when both features are enabled.
 */
export function visitPageSurface(options: VisitPageOptions): VisitPageSurface {
  const surface: VisitPageSurface = {
    description:
      DESCRIPTION_BASE +
      (options.cleanEnabled ? DESCRIPTION_CLEAN : "") +
      (options.summaryEnabled ? DESCRIPTION_SUMMARY : ""),
    promptSnippet:
      SNIPPET_BASE +
      (options.cleanEnabled ? SNIPPET_CLEAN : "") +
      (options.summaryEnabled ? SNIPPET_SUMMARY : ""),
    promptGuidelines: [...CORE_GUIDELINES],
  };

  if (options.cleanEnabled) {
    surface.promptGuidelines.push(CLEAN_GUIDELINE);
    surface.cleanParamDescription = CLEAN_PARAM_DESCRIPTION;
  }
  if (options.summaryEnabled) {
    surface.promptGuidelines.push(SUMMARY_GUIDELINE);
    surface.summaryParamDescription =
      SUMMARY_PARAM_BASE + (options.cleanEnabled ? SUMMARY_PARAM_CLEAN : "") + SUMMARY_PARAM_TAIL;
  }
  if (options.summaryEnabled && options.cleanEnabled) {
    surface.promptGuidelines.push(RESEARCH_GUIDELINE);
  }

  return surface;
}

/**
 * Drop arguments for disabled features before schema validation.
 *
 * When a feature is off its property is not part of the tool's parameter
 * schema, so a model that still sends it (e.g. from earlier conversation
 * context) must not fail validation — and must not trigger the feature. This
 * runs as the tool's `prepareArguments` shim.
 */
export function stripDisabledArguments(
  args: unknown,
  options: VisitPageOptions,
): { url: string; clean?: boolean; summary?: boolean } {
  const source: Record<string, unknown> =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  if (!options.summaryEnabled) delete source.summary;
  if (!options.cleanEnabled) delete source.clean;
  return source as { url: string; clean?: boolean; summary?: boolean };
}
