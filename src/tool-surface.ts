/**
 * Agent-facing text for `visit_page` (description, prompt snippet, prompt
 * guidelines).
 *
 * Two variants exist because of the `summaryEnabled` config setting:
 *
 *   - WITH summary: summary mode is on (default). The tool advertises
 *     `summary: true` in its description, snippet, guidelines, and parameter
 *     schema.
 *   - WITHOUT summary: summary mode is off (`"summaryEnabled": false` in
 *     search-on-your-browser.json, `PI_BROWSE_SUMMARY_ENABLED=0`, or
 *     `/browse off`). The model must never be told the option exists — no
 *     string in this variant may mention summarization or /browse, and index.ts
 *     drops the `summary` parameter from the schema.
 *
 * Keeping the strings here (instead of inline in index.ts) makes it possible
 * to test that the hidden variant really hides the feature.
 */

const VISIT_PAGE_DESCRIPTION_BASE =
  "Open a URL in your visible Chrome browser and return the rendered page as Markdown. " +
  "Works with authenticated sites, paywalls, and JavaScript-heavy pages. " +
  "X (Twitter) URLs (search, profile, or tweet) are extracted as structured tweets with handle, timestamp, permalink, and engagement. " +
  "Reddit post URLs are extracted as the post plus threaded comments with author, score, and OP marking. " +
  "Amazon product pages are extracted as structured product data (title, price, availability, brand, rating, features, tech specs, ASIN) and Amazon search URLs as a clean product listing. " +
  "Google Scholar search URLs are extracted as structured paper results (title, authors, venue, year, citation count, snippet, PDF link).";

const VISIT_PAGE_DESCRIPTION_SUMMARY =
  " Pass `summary: true` to have a configurable subagent model read the page and return only a concise summary of ALL the information on it — " +
  "the raw page markdown is NOT added to your chat context, which keeps large pages from filling it. " +
  "Configure the subagent with /browse.";

export const VISIT_PAGE_DESCRIPTION_WITH_SUMMARY =
  VISIT_PAGE_DESCRIPTION_BASE + VISIT_PAGE_DESCRIPTION_SUMMARY;

export const VISIT_PAGE_DESCRIPTION_WITHOUT_SUMMARY = VISIT_PAGE_DESCRIPTION_BASE;

const VISIT_PAGE_SNIPPET_BASE =
  "visit_page: visit a URL in your visible browser, returns rendered markdown " +
  "(X/Twitter URLs yield structured tweets; Reddit posts yield post + threaded comments; " +
  "Amazon products yield structured product data; Google Scholar yields structured paper results).";

const VISIT_PAGE_SNIPPET_SUMMARY =
  " Pass `summary: true` to get only a concise subagent summary of the page instead of the full page markdown (keeps context small). " +
  "Configure via /browse.";

export const VISIT_PAGE_PROMPT_SNIPPET_WITH_SUMMARY =
  VISIT_PAGE_SNIPPET_BASE + VISIT_PAGE_SNIPPET_SUMMARY;

export const VISIT_PAGE_PROMPT_SNIPPET_WITHOUT_SUMMARY = VISIT_PAGE_SNIPPET_BASE;

/** Guidelines that do not mention `summary` — shared by both variants. */
export const VISIT_PAGE_CORE_GUIDELINES = [
  "Use visit_page to read a web page you found via google_search. It opens in your visible Chrome so authenticated/paywalled sites work.",
  "For X (Twitter) URLs — search results, profiles, or individual tweets — visit_page extracts structured tweets (handle, text, timestamp, permalink, engagement). Search X by visiting https://x.com/search?q=<query>&f=top (or &f=live for latest).",
  "For Reddit post URLs (any reddit.com .../comments/... link) visit_page extracts the post (title, author, score, body) plus threaded comments (author, score, OP marking, depth-indented replies). Subreddit listings and user pages use the generic extractor.",
  "For Amazon product pages (any amazon.* /dp/ASIN, /gp/product/ASIN URL) visit_page extracts structured product data: title, price, list price, availability, brand, rating, review count, feature bullets, technical specifications, and ASIN. For Amazon search URLs (amazon.* /s?k=...) it returns a clean listing of products with title, price, rating, ASIN, and link. Other Amazon pages (category, seller, etc.) use the generic extractor.",
  "For Google Scholar URLs (scholar.google.com/scholar?q=...) visit_page extracts structured paper results: title, authors/venue/year, citation count, abstract snippet, and PDF link. Scholar paginates 10 results per page; for more, visit_page the next page URL (add &start=10, &start=20, etc.).",
];

export const VISIT_PAGE_CLEAN_GUIDELINE =
  "visit_page accepts a `clean` flag. For articles, docs, or blog posts, pass `clean: true` to extract only the main article content as clean Markdown (drops nav/sidebars/ads/footer) — far fewer tokens. No effect on X/Reddit/Amazon/Scholar (already clean). Falls back to the generic extractor if Defuddle fails. Avoid `clean` on non-article pages (dashboards, indexes with no clear main content) where Defuddle may extract the wrong block or nothing. Note: `clean` preserves content links (article URLs, citations, story links) but drops chrome links (nav bars, sidebars, footers, action buttons) — so it's fine for gathering content links, but avoid it if you specifically need nav/footer links (e.g. finding the 'About' or 'Contact' page URL).";

export const VISIT_PAGE_SUMMARY_GUIDELINE =
  "visit_page accepts a `summary` flag. Pass `summary: true` and the full page content is read by a subagent model that returns only a concise summary of ALL the information on the page — the raw page markdown never enters your chat context. This keeps large pages (docs, articles, product pages) from filling the conversation. The subagent reuses your current Pi model by default (no setup needed); pin a different one with /browse. Prefer `summary` for large pages where you do not need every word verbatim. Avoid `summary` when you need verbatim text (code snippets, API signatures, exact numbers, error messages) since the subagent paraphrases; when the page is already small; or when the page content itself is the deliverable.";

export const VISIT_PAGE_RESEARCH_GUIDELINE =
  "For research tasks — reading multiple papers, articles, or docs — use `clean: true` + `summary: true` together by default. `clean` gives the subagent pure article text (no nav noise, no 90KB truncation) so its summary is faster and more reliable; `summary` keeps each page's full content out of your context. This combination is the optimal pattern for intensive research: search → visit each result with clean+summary → synthesize from the concise summaries.";

export const VISIT_PAGE_GUIDELINES_WITH_SUMMARY = [
  ...VISIT_PAGE_CORE_GUIDELINES,
  VISIT_PAGE_SUMMARY_GUIDELINE,
  VISIT_PAGE_CLEAN_GUIDELINE,
  VISIT_PAGE_RESEARCH_GUIDELINE,
];

export const VISIT_PAGE_GUIDELINES_WITHOUT_SUMMARY = [
  ...VISIT_PAGE_CORE_GUIDELINES,
  VISIT_PAGE_CLEAN_GUIDELINE,
];

/**
 * Drop a stale `summary` argument when the option is hidden.
 *
 * When the subagent is disabled the `summary` property is not part of the
 * tool's parameter schema, so a model that still sends it (e.g. from earlier
 * conversation context) must not fail validation — and must not trigger
 * summarization. This runs as the tool's `prepareArguments` shim, before
 * schema validation, and returns a plain `{ url, clean }` object.
 */
export function stripSummaryArgument(args: unknown): { url: string; clean?: boolean } {
  const source: Record<string, unknown> =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  delete source.summary;
  return source as { url: string; clean?: boolean };
}
