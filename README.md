# pi-search-on-your-browser

Search Google and browse the web in your **own visible Chrome browser** — no API keys, no headless detection, your real cookies and login sessions. A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives your coding agent two tools: `google_search` and `visit_page`.

## Highlights

- **Google search** via your real browser — returns compact markdown links + snippets
- **`visit_page`** fetches any URL as markdown using your visible Chrome (authenticated everywhere — paywalled sites, X, Reddit, Amazon, GitHub)
- **`clean` extraction** — reader-mode markdown via [Defuddle](https://github.com/kepano/defuddle) (the Obsidian Web Clipper library); drops nav/sidebars/ads, ~47% fewer tokens on docs pages
- **`summary` subagent** — pass `summary: true`, get only a concise summary of the whole page back (the full page never enters your chat context); reuses your current Pi model by default, **no setup needed**
- **HTTP error detection** — dead links return a clear `isError` with status-specific hints instead of error-page gibberish
- **Site-specific extractors** — X/Twitter (structured tweets), Reddit (posts + threaded comments), Amazon (products + search), Google Scholar (papers)
- **Zero API keys, zero runtime npm dependencies** — uses your existing browser; nothing to sign up for

> "If you need AI to do a search for you in the real world, ds4-agent is basically SOTA, because it can access the web sites without any limitations given that it uses your local Chrome browser (no, not in headless mode, that's the trick...)"
> — [@antirez on X](https://x.com/antirez/status/2066233392916525379), 2026-06-14

Inspired by the [ds4-agent](https://github.com/antirez/ds4) approach by @antirez: a visible Chrome window (not headless) driven via the Chrome DevTools Protocol, so you're authenticated everywhere — paywalled sites, Twitter, GitHub, Google — because it's **your real browser**.

## How it works

When you call `google_search` or `visit_page`:

1. A **visible Chrome window** opens (not headless) with a dedicated profile at `~/.pi-search-browser/`
2. Chrome DevTools Protocol (CDP) is used to navigate and extract content
3. JavaScript runs in the page to extract readable markdown — site-specific extractors for X, Reddit, Amazon, Scholar; [Defuddle](https://github.com/kepano/defuddle) reader-mode for `clean`; generic block-walker as fallback
4. Chrome stays alive between calls for speed (kill with `/google-search-kill`)

## Install

```bash
pi install npm:pi-search-on-your-browser
```

Or from git:

```bash
pi install git:github.com/xezpeleta/pi-search-on-your-browser@v0.8.0
```

## Tools

### `google_search`

Search Google and get compact markdown links + text snippet.

```
google_search({ query: "TypeScript 5.7 release notes" })
```

### `visit_page`

Visit any URL and get the page content as markdown. Two optional parameters keep large pages from filling your conversation:

- **`summary`** — delegate to a subagent model that returns only a concise summary of the whole page (the raw page never enters your context; reuses your current model by default). [See below.](#optional-summary--keep-your-chat-context-small)
- **`clean`** — extract with Defuddle reader-mode (drops nav/sidebars/ads; ~47% fewer tokens). [See below.](#optional-clean--clean-article-markdown-via-defuddle)

```
visit_page({ url: "https://example.com/article" })
visit_page({ url: "https://react.dev/reference/react/useState", summary: true })
visit_page({ url: "https://react.dev/reference/react/useState", clean: true })
```

**X (Twitter) support:** Any `x.com` / `twitter.com` URL — a search results
page, a profile, or an individual tweet — is extracted as structured tweets
(handle, text, timestamp, permalink, engagement). This works because the
dedicated Chrome profile carries your X login. X virtualizes its timeline, so
the extractor scrolls and collects tweets incrementally, deduping by permalink.

```
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=top" })   // top results
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=live" })  // latest
visit_page({ url: "https://x.com/xezpeleta" })                   // a profile's tweets
```

**Reddit support:** Any `reddit.com` post URL (a path containing `/comments/`)
is extracted as the post (title, author, score, self-text) plus threaded
comments — each with author, score, OP marking, and depth-indented replies.
Reddit lazy-loads comments on scroll, so the extractor scrolls and collects
incrementally, deduping by comment id. Subreddit listings and user pages fall
through to the generic extractor.

```
visit_page({ url: "https://www.reddit.com/r/programming/comments/.../" })
```

**Amazon support:** Any `amazon.*` product page (`/dp/ASIN`, `/gp/product/ASIN`)
or search page (`/s?k=...`) gets a dedicated extractor. Product pages return
structured data — title, price, list price, availability, brand, rating,
review count, feature bullets, technical specifications, ASIN, and top reviews
(best-effort) — instead of the ~110 KB of navigation noise the generic
extractor would pull. Search pages return a clean listing of products with
title, price, rating, ASIN, and link, scrolling to collect more results.

```
visit_page({ url: "https://www.amazon.es/s?k=E220-900T22D" })                       // search
visit_page({ url: "https://www.amazon.es/-/en/.../dp/B097GZBZ9Y" })                  // product
```

Other Amazon pages (category, seller, etc.) fall through to the generic
extractor.

**Google Scholar support:** Any `scholar.google.com` URL is extracted as
structured paper results — title, authors/venue/year, citation count, abstract
snippet, and PDF link — instead of the flat H3 headers the generic extractor
produces (which drops all the academic metadata). Scholar paginates 10 results
per page (not infinite scroll), so the extractor returns the current page;
for more results, visit the next page URL (`&start=10`, `&start=20`, etc.).
Citation counts are parsed locale-agnostically ("Cited by 1108" / "Cité 1108
fois" / "Citado por 1108" / "Zitiert von 1108").

```
visit_page({ url: "https://scholar.google.com/scholar?q=transformer+attention+is+all+you+need" })
```

### Optional `summary` — keep your chat context small

By default, `visit_page` returns the full rendered page as markdown. For large
pages this can dump tens of thousands of characters into your conversation.
Pass **`summary: true`** and the full page content is instead read by a
configurable **subagent model** (a separate, cheap LLM call) that returns only
a concise summary of *all* the information on the page. The raw page markdown
never enters your chat context — only the subagent's summary does.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  summary: true,
})
```

- **`summary` summarizes the page** — it reads the single page at the `url`
  you pass to `visit_page` and returns a concise summary of everything on it.
  It is not a search: it does not look at other pages or the web, and it is
  not a replacement for `google_search`. Use `google_search` to find pages,
  then `visit_page` + `summary` to get a compact digest of one of them.
- The page is fetched exactly as usual (your visible Chrome, all the
  site-specific extractors above still run); only the *return value* changes.
- The subagent **reuses your current Pi model by default** (no API keys to
  set up — Pi's already-configured auth is used). Pin a different model with
  `/browse` if you want a cheaper/faster one for summarization.
- The footer shows a `🌐 provider/model` indicator **only when the subagent is
  pinned to a model different from your session model** (run `/browse` with no
  arguments to see what it resolves to); an animated spinner appears while the
  subagent is summarizing. Reusing the session model needs no indicator —
  Pi's own footer already shows that model.
- The collapsed tool result shows the context savings, e.g.
  `→ 92,340→1,187 chars · openai/gpt-4o-mini · 3.2s · react.dev`.

This mirrors the subagent pattern from the
[pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool) extension.

### Optional `clean` — clean article Markdown via Defuddle

By default, `visit_page` on a generic (non-specialized) page uses a naive
block-walker that includes navigation, sidebars, up to 80 "visible links",
and truncates at 90 KB — noisy and token-heavy. Pass **`clean: true`** and the
page is instead extracted with [**Defuddle**](https://github.com/kepano/defuddle)
(the same library the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)
uses): a reader-mode-style article extractor that drops navigation, sidebars,
ads, and footers, returning only the main article content as clean Markdown.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  clean: true,
})
```

- Best for **articles, docs, and blog posts** — cleaner output and far fewer
  tokens than the default.
- **No effect on X, Reddit, Amazon, or Google Scholar URLs** — those already
  use purpose-built extractors that produce clean compact Markdown.
- If Defuddle fails or returns nothing (e.g. on a SPA with no article content),
  it automatically falls back to the generic extractor in the same page load.
- Combine with `summary` for the best of both: `clean: true` gives the subagent
  clean article text to read, and `summary` returns only its concise digest —
  ideal for large articles.

The Defuddle bundle (~500 KB, MIT-licensed, with Turndown bundled in) is
vendored at `src/vendor/defuddle-browser.js` and injected into the page via a
single CDP `Runtime.evaluate` call before the extraction driver runs. See
[`src/vendor/README.md`](src/vendor/README.md) for build provenance.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  clean: true,
  summary: true,
})
```

### HTTP error detection (4xx / 5xx)

`visit_page` monitors the page's HTTP response status via the CDP `Network`
domain. When the server returns a **4xx or 5xx** status (e.g. a `404 Not Found`
on a dead or renamed link — a common occurrence with Cloudflare blog posts,
relocated docs, or hallucinated URLs), the tool returns an **`isError` result**
with a clear message instead of silently extracting the error page's content:

```
HTTP 404 Not Found — The page does not exist at this URL — the content may
have been moved, removed, or the URL may be incorrect. Try a different URL
or search for the content.
```

This tells the model the URL is dead so it can try a different one or search
again, rather than receiving "Page Not Found" gibberish as if it were page
content. The collapsed tool result shows the status code, e.g.
`→ HTTP 404 · 1.2s · blog.cloudflare.com`.

Status-specific hints:

| Status | Hint |
|---|---|
| **404** | Page doesn't exist — try a different URL or search |
| **403** | Access denied — may be bot protection, auth, or paywall |
| **429** | Rate limited — wait and retry |
| **5xx** | Server error — retry shortly or try a different URL |

## Commands

- `/browse` — Configure the `visit_page` subagent and the Chrome proxy (see below).
- `/google-search-kill` — Kill the Chrome browser.

### Troubleshooting: Chrome launch flags are applied automatically

`visit_page` drives a **visible Chrome** that `pi-search-on-your-browser`
launches once and keeps alive across tool calls. The flags the live Chrome was
started with are recorded in a marker file inside the dedicated profile
(`~/.pi-search-browser/.pi-launch-args.json`), so when the effective flags
change — after an upgrade, or after adding/removing/changing a proxy — the
already-running Chrome is detected as stale and **restarted automatically** on
the next tool call ("Restarting Chrome to apply updated launch flags..."
appears in the tool call block).

You can still force a restart yourself at any time with `/google-search-kill`
(or `pkill -f remote-debugging-port=9322`); the next tool call relaunches
Chrome. Symptoms of a stale Chrome: `visit_page` hangs for ~30s on lazy-load
pages (e.g. `github.com`) and fails with `CDP call timeout: Runtime.evaluate`
when Chrome's window is in the background.

### Diagnostics: quiet by default

The extension writes **nothing to stderr** during normal operation. Pi's TUI
runs in raw mode and renders raw stderr writes on the text input bar, so
`[pi-search] ...` messages (Chrome launched/ready/exited, launch flags changed)
would appear as noise while you are typing. Progress the user should see
("Launching Chrome...", "Restarting Chrome...", "Navigating to ...") is
reported through the tool's status callback and rendered inside the tool call
block instead.

Set `PI_SEARCH_DEBUG=1` to get the diagnostics back on stderr when
troubleshooting (Chrome path, proxy flag, exit code, restart decisions). On
Windows PowerShell: `$env:PI_SEARCH_DEBUG="1"; pi`.

### `/browse` — subagent configuration

`visit_page`'s `summary` mode uses a **subagent model** to read the page and
return only a concise summary, keeping your chat context small. The subagent
is a normal model from your Pi model registry (the same providers/models you
already use), called via its OpenAI-compatible API using **Pi's already-
configured auth** — no separate API keys to set up.

**By default the subagent reuses your current session model** (the one you're
chatting with). So `summary` mode works with zero configuration. Use `/browse`
only if you want to pin a different (e.g. cheaper/faster) model:

```
/browse                          # show current config
/browse on                       # enable (default)
/browse off                      # disable (summary → error until re-enabled)
/browse provider openai          # pin a provider (overrides current model)
/browse model gpt-4o-mini        # pin a model (overrides current model)
/browse max-tokens 2048          # max output tokens for the summary
/browse reasoning-effort low     # off|minimal|low|medium|high|xhigh
/browse clear                    # unpin → back to current model
```

Shorthand: `/browse provider openai` and `/browse model gpt-4o-mini` work
without the `config` prefix.

When the subagent is pinned to a different model, the footer shows
`🌐 provider/model`; otherwise no indicator appears, because the session model
it reuses is already in Pi's footer. Run `/browse` with no arguments to see
the resolved configuration.

Configuration is persisted to `~/.pi/agent/search-on-your-browser.json` and
also recorded in the session file, so changes survive across sessions and are
restored when you reopen one.

Environment variables (optional — override the current-model default at
startup; the config file wins over these once set):

| Variable | Default | Meaning |
|---|---|---|
| `PI_BROWSE_PROVIDER` | — | pin a subagent provider (else: current model) |
| `PI_BROWSE_MODEL` | — | pin a subagent model (else: current model) |
| `PI_BROWSE_MAX_TOKENS` | `2048` | max output tokens for the summary |
| `PI_BROWSE_REASONING_EFFORT` | `off` | thinking level for reasoning models |
| `PI_SEARCH_PROXY` | — | proxy for the Chrome browser (see below) |

### Proxy — browsing through a proxy

On machines that need a proxy to reach the internet, `google_search` and
`visit_page` would otherwise hang on pages that never load. Chrome is launched
with `--proxy-server=<value>`, which covers every request it makes — including
the CDP-driven navigations — so the whole tool keeps working. You do *not* need
`HTTP(S)_PROXY` for Pi itself.

```jsonc
// ~/.pi/agent/search-on-your-browser.json
{
  "browser": {
    "proxy": "http://127.0.0.1:8010"
  }
}
```

Accepted forms: a full URL (`http://`, `https://`, `socks4://`, `socks5://`),
credentials (`http://user:pass@proxy:3128`), or a bare `host:port` (the scheme
defaults to `http://`). Localhost is never proxied. Set it interactively, or
with the `PI_SEARCH_PROXY` environment variable (the config file wins once set):

```
/browse proxy http://127.0.0.1:8010   # or: /browse config proxy ...
/browse proxy off                     # connect directly again
/browse                               # shows the effective proxy
```

Changing the proxy takes effect on the next tool call: the running Chrome is
restarted with the new flag (no Pi restart, no manual `/google-search-kill`).

## Requirements

- **Google Chrome or Chromium** installed (Firefox is not currently supported — see below)
- Node.js 20+ (tests require Node.js 22.6+ for native TypeScript stripping)

### Why Chrome only?

Firefox uses the [WebDriver BiDi protocol](https://w3c.github.io/webdriver-bidi) for remote control, not the Chrome DevTools Protocol (CDP). While both use WebSocket, Firefox's BiDi server requires a manual WebSocket handshake with specific header handling (no `Origin` header). Node.js's built-in `WebSocket` doesn't expose custom headers, and adding a full WebSocket library like `ws` would break the zero-dependency constraint of this package. Pull requests welcome if you can solve this without dependencies.

## Development

### Tests

The test suite runs without a browser, without a network, and with **zero runtime dependencies** — only Node.js's built-in test runner and native TypeScript type-stripping (Node 22.6+, unflagged in Node 24).

```bash
npm test
```

Four layers of tests (84 total):

- **`tests/unit/urls.test.ts`** — table-driven tests for the URL classifiers (`isXUrl`, `isRedditPostUrl`, `isAmazonProductUrl`, `isAmazonSearchUrl`, `isScholarSearchUrl`).
- **`tests/unit/extractors-parse.test.ts`** — validates every extractor JS string (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, etc.) parses as valid JavaScript via `new Function()`. Catches template-literal escaping bugs (the `\n` vs real-newline class of errors) without a browser.
- **`tests/unit/cdp-client.test.ts`** — tests `runInPageSession` (the navigate/waitForSelector/scroll/extract logic) against a fake `CDPLike` implementation. Includes the **regression test for the v0.5.1 bug**: `cdp.evaluate()` stringifies return values, so `String(false)` → `"false"` (truthy); the test asserts `waitForSelector` does *not* break on the first poll when the selector is absent. Also tests the `fallbackJs` path (Defuddle → generic extractor fallback), HTTP error detection (4xx/5xx → `__HTTP_ERROR__` marker, extraction skipped, no fallback), the vendored Defuddle bundle (non-empty, UMD, no Node-only deps, cached), the background-renderer launch flags, browser discovery (Windows install paths, `CHROME_PATH`, Edge fallback), the proxy flag, the actionable spawn-error message for the Windows `spawn google-chrome ENOENT` crash, and that the only `console.*` write in `chrome.ts` is the one gated behind `PI_SEARCH_DEBUG` (no TUI input-bar noise).
- **`tests/unit/subagent.test.ts`** — tests the subagent layer used by `visit_page`'s `summary` mode: config load/save/resolve, reasoning-level validation, reasoning-param building (mirrors the vision tool), context-window truncation with token-budget reservation, and message construction. Also covers the browser proxy config: value normalization (`host:port` → `http://`, socks, off switches, invalid values), resolution precedence (file `browser.proxy` > top-level `proxy` > `PI_SEARCH_PROXY` > direct), tolerance of a malformed file, the saved file shape, and the `/browse` summary line. No network calls — `callSubagentModel` is exercised indirectly via its pure helpers.

### Type-checking

```bash
npm run typecheck
```

Uses `tsc --strict` (the `typescript` and `@types/node` devDependencies). Note: `index.ts` imports pi's own types (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) which are provided by the pi runtime — it is type-checked by pi at load time. The `tsconfig.json` scopes `tsc` to `src/` and `tests/` (which only use Node built-ins).

### Why no test framework?

The project uses `node:test` + `node:assert/strict` (built into Node.js) and native TypeScript stripping — no jest, vitest, mocha, or even `tsx`. This aligns with the zero-dependency ethos: the only devDependencies are `typescript` (for `tsc`) and `@types/node` (for type definitions), neither of which is installed by consumers.

## Comparison with ds4-agent

| | pi-search-on-your-browser | ds4-agent |
|---|---|---|
| Language | TypeScript (Node.js) | C |
| Chrome connection | CDP WebSocket (manual RFC 6455) | CDP WebSocket (manual RFC 6455) |
| Profile | `~/.pi-search-browser/` | `~/.ds4/browser` |
| Google consent | Auto-click "Accept all" (multi-language) | Auto-click "Accept all" (multi-language) |
| Page extraction | Same JS extractors, ported to TS | Inline JS in C |
| Dependencies | Zero npm deps (just Node.js built-ins) | Zero deps (just POSIX) |

## Changelog

### v0.8.1

- **Fix: `google_search` crashed the whole Pi process with `spawn google-chrome ENOENT` on Windows.** `findChrome()` only knew Linux/macOS install paths, so on Windows it fell through to the bare name `google-chrome` — which does not exist — and the resulting `spawn` `error` event had no listener, so Node re-threw it as an `uncaughtException` and Pi exited. Browser discovery now probes the real Windows locations (`%LOCALAPPDATA%\Google\Chrome`, `%PROGRAMFILES%`, `%PROGRAMFILES(x86)%`, Chromium), prefers `CHROME_PATH`, falls back to Edge (Chromium-based, same CDP flags), and `launchChrome()` attaches an `error` listener that turns a failed launch into a normal, actionable tool error (`Could not launch browser "…": … set CHROME_PATH …`) instead of killing the session.
- **New: proxy support for the Chrome browser.** Set `browser.proxy` in `~/.pi/agent/search-on-your-browser.json` (or `PI_SEARCH_PROXY`, or `/browse proxy <url|off>`) and Chrome is launched with `--proxy-server=<value>` — every request it makes, including CDP-driven navigations, goes through the proxy, so `google_search`/`visit_page` work on machines without a direct route to the internet. Accepts `http://`, `https://`, `socks4://`, `socks5://` URLs (with or without credentials) and bare `host:port` (defaults to `http://`); empty/`off`/`none`/`direct` means a direct connection. `/browse` now reports the effective proxy. Verified end-to-end: Google search + `visit_page` through `http://127.0.0.1:8010`, plus an automatic Chrome restart when the proxy is changed.
- **Chrome launch flags are now auto-detected instead of requiring a manual relaunch after upgrading.** The flags the live Chrome was started with are recorded in `~/.pi-search-browser/.pi-launch-args.json`; on the next tool call a mismatch (an upgrade that changed the flags, or a proxy added/removed/changed) is detected and the tool's Chrome restarted automatically. `shutdownChrome()` now also closes a Chrome started by an earlier Pi session (CDP `Browser.close`), not just its own child process. 12 new tests (83 total) cover browser discovery, the proxy launch flag, config precedence (file > env > direct), tolerant parsing, the saved config shape, the `/browse` summary line, and the actionability of the spawn-error message.
- **The `🌐` footer indicator no longer duplicates the model Pi already shows.** In the default (unpinned) configuration the subagent reuses the current session model, so the status line rendered the exact same `provider/model` as Pi's own footer — one line of pure noise. It now appears only when the subagent is pinned to a *different* model (`/browse provider` + `/browse model`), the one case Pi's footer can't tell you about; the transient spinner during a summary call is unchanged. The `/browse on` message and README were updated to match.
- **Fix: extension diagnostics no longer leak onto the TUI input line.** `src/chrome.ts` wrote `[pi-search] ...` messages (Chrome launched/ready/exited, launch flags changed) straight to stderr with `console.error()`. Pi's TUI runs in raw mode and renders raw stderr writes on the text input bar, so they showed up as noise while typing. All diagnostics now go through a `debugLog()` helper that writes only when `PI_SEARCH_DEBUG` is set. Progress the user should actually see ("Launching Chrome...", "Restarting Chrome...") is reported through the tool's `onStatus` callback instead — rendered inside the tool call block, where it belongs. A new regression test asserts the only `console.*` call in `chrome.ts` is the gated one. Verified: a full `google_search` through Chrome emits **0 bytes** on stderr by default, while `PI_SEARCH_DEBUG=1` restores the diagnostics.

### v0.8.0

- **Breaking: replaced `visit_page`'s `query` parameter with a `summary` boolean.** The `query` parameter caused recurring confusion — agents kept treating it as a search tool, asking pages questions about information they didn't contain (expecting them to search a site or replace `google_search`). It has been removed and replaced with `summary: true`, which has unambiguous semantics: the subagent reads the page and returns a concise summary of *all* the information on it (consuming far fewer tokens than the full page markdown, while still surfacing everything available). The subagent system prompt was rewritten from "answer this question" to "summarize all the useful information on this page". `buildMessages`, `truncateForContext`, and `callSubagentModel` no longer take a `query` argument; the `query` field was dropped from tool result `details`. Updated all agent-facing surfaces (tool `description`, `promptSnippet`, `promptGuidelines`, the `summary` parameter's own `description`), the `/browse` command messages, and the README. Tests updated to the new signatures. Migration: replace `visit_page({ url, query: "..." })` with `visit_page({ url, summary: true })`.

### v0.7.6

- **Fix: `visit_page` hung (~30s timeout) when Chrome's window was in the background.** Even with v0.7.4's `bringToFront` + background-throttling flags, Chrome's **native window-occlusion detection** (`CalculateNativeWinOcclusion`) could fully freeze the renderer when the Chrome *window* was behind another window or unfocused — `Runtime.evaluate` then timed out entirely (not just missed lazy loads). This was especially severe on **GNOME Wayland**, where the Chrome window can't be programmatically focused (xdotool/wmctrl are X11-only; GNOME Shell's D-Bus window APIs are access-denied). Added `--disable-features=CalculateNativeWinOcclusion` to the Chrome launch flags so the renderer stays alive regardless of window visibility/focus. Verified: `visit_page` on `github.com/antirez/ds4` (heavy lazy-loaded file tree) now scrapes the full page with Chrome in the background. The launch flags were also refactored into an exported `CHROME_LAUNCH_ARGS` constant (with 2 new regression tests asserting the throttling + occlusion flags are present). README gained a troubleshooting note: Chrome must be relaunched (`/google-search-kill`) after upgrading for new launch flags to take effect.

### v0.7.5

- **Docs: clarified that `visit_page`'s `query` parameter is not a search.** Agents were confusing `query` with a search tool — expecting it to search a whole website or replace `google_search`. In reality `query` only reads the single page at the URL passed to `visit_page` and answers a question about that page's content. Made this explicit and prominent across every agent-facing surface (tool `description`, `promptSnippet`, `promptGuidelines`, the `query` parameter's own `description`) plus the README, with the correct workflow spelled out: `google_search` to discover pages → `visit_page` + `query` to extract specific facts from one.

### v0.7.4

- **Fix: dynamic scrolling didn't trigger lazy-loaded content on background tabs.** Tool tabs open with `background: true` (to avoid stealing focus), but Chrome suspends the renderer of non-active tabs, so `window.scrollTo()`/`scrollBy()` were a no-op — the "Scrolling for dynamic content..." step silently did nothing until you manually clicked the tab. Two-layer fix: (1) added 3 Chrome launch flags (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`) to keep background-tab renderers alive; (2) added a `bringToFront` option that calls CDP `Page.bringToFront` after navigation (before scrolling/extraction) to activate the tab. `bringToFront: true` is enabled for the 5 scrolling paths (generic pages incl. GitHub, X, Reddit, Amazon product, Amazon search) and skipped for non-scrolling paths (Google search, Scholar, Defuddle clean) and HTTP errors. Added 5 regression tests.

### v0.7.3

- **Improved tool guidance for `clean` and `query`.** The `promptGuidelines` and parameter descriptions now tell the LLM not just *when to use* each flag but *when to avoid* it, so it doesn't apply them blindly:
  - **`clean` avoid:** non-article pages (dashboards, indexes) where there is no clear main content — Defuddle may extract the wrong block or nothing (and the fallback only triggers on error/empty, not wrong content).
  - **`clean` preserves content links** (article URLs, citations, story links) but **drops chrome links** (nav bars, sidebars, footers, action buttons). Verified empirically against the Hacker News front page: all 30 story links + all 30 comment links preserved in `clean` mode; only nav/footer/hide-action links dropped. So `clean` is fine for gathering content links — only avoid it if you specifically need nav/footer links (e.g. finding the 'About' or 'Contact' page URL). The previous guidance ("avoid clean when you need links") was too broad and misleading.
  - **`query` avoid:** when you need verbatim text (code snippets, API signatures, exact numbers, error messages) since the subagent paraphrases; when the page is already small; when you need to judge the content yourself; or when the page content is the deliverable.
  - **New research-workflow guideline:** use `clean: true` + `query` together by default for intensive research (search → visit each result with clean+query → synthesize).
  - Fixed stale `query` parameter description that still referenced the removed `not_configured` error path; now documents the current-model default and recommends combining with `clean`.

### v0.7.2

- **Fix: subagent `query` mode crashed on reasoning-enabled models with HTTP 400.** `buildReasoningParams` sent `{ reasoning_effort: "off" }` as a literal string when reasoning was disabled (the default), but many APIs (vLLM, OpenAI) reject `"off"` — they expect `"none"`/`"minimal"`/... or no param at all. Now mirrors pi's behavior: the default format omits `reasoning_effort` entirely when the level is `"off"`/`"none"` (pi only sends it when truthy); the OpenRouter format sends `effort: "none"`. This was the most impactful bug in v0.7.0 — it made `query` mode unusable with any reasoning-capable model (e.g. GLM-5.2 served via vLLM).

### v0.7.1

- **Internal refactor: split extractors into `src/extractors.ts`.** All JavaScript extractor strings (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, `AMAZON_PRODUCT_JS`, etc.), URL classifiers (`isXUrl`, `isRedditPostUrl`, etc.), and the Defuddle bundle/driver moved from `chrome.ts` (1214 lines) into a dedicated `extractors.ts` (608 lines). `chrome.ts` drops to 615 lines of pure CDP plumbing + public API. This isolates the high-churn site-specific code (which changes whenever a site redesigns its DOM) from the stable CDP infrastructure. Zero behavior change.
- **Deduplicated `visitPage` dispatch.** The 8 repeated `runInPage` + `resolveHttpError` blocks (one per specialized extractor + clean + generic) collapsed into a single `extractVia()` helper. `visitPage` is now a clean dispatch table — each path is one `return extractVia(...)` line instead of an 8-line block. `googleSearch` uses the same helper.

### v0.7.0

- **New: `visit_page` optional `clean` parameter.** Pass `clean: true` and generic (non-specialized) pages are extracted with [Defuddle](https://github.com/kepano/defuddle) (the same library the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) uses) — a reader-mode-style article extractor that drops navigation, sidebars, ads, and footers, returning only the main article content as clean Markdown. Far cleaner output and far fewer tokens than the default block-walker fallback. No effect on X/Reddit/Amazon/Scholar URLs (already clean). Falls back to the generic extractor automatically if Defuddle fails. Combine with `query` for the best of both: clean article text → subagent → concise answer.
- **New: HTTP error detection.** `visit_page` now monitors the page's HTTP response status via the CDP `Network` domain. When the server returns a 4xx/5xx status (e.g. a `404` on a dead or renamed link — common with Cloudflare blog posts, relocated docs, or hallucinated URLs), the tool returns an `isError` result with a clear, status-specific hint instead of silently extracting the error page's content. Extraction is skipped entirely on HTTP errors (no wasted work, no fallback trigger). The collapsed tool result shows the status code (e.g. `→ HTTP 404 · 1.2s · blog.cloudflare.com`).
- Vendored `src/vendor/defuddle-browser.js` (~500 KB, MIT-licensed, with Turndown bundled in) — a slim build of Defuddle without the `temml`/`mathml-to-latex` math libs (~300 KB saved). Injected into the page via a single CDP `Runtime.evaluate` call. See `src/vendor/README.md` for build provenance.
- Added `fallbackJs` option to `runInPageSession` (same-tab fallback when the primary extractor returns an error marker or empty content — no second navigation).
- **New: `visit_page` optional `query` parameter.** Pass a `query` and the full page content is read by a **subagent model** that returns only a concise answer — the raw page markdown never enters your chat context. Keeps large pages (docs, articles, product pages) from filling the conversation. Mirrors the subagent pattern from [pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool). The page is still fetched with your visible Chrome (all site-specific extractors run); only the return value changes. **The subagent reuses your current Pi model by default** (via Pi's already-configured auth — no API keys to set up); pin a different model with `/browse provider`/`/browse model` if desired.
- **New: `/browse` command** to configure the subagent (`provider`, `model`, `max-tokens`, `reasoning-effort`, `on`/`off`, `clear`, `show`). Config persists to `~/.pi/agent/search-on-your-browser.json` and the session file. Footer shows a `🌐 provider/model` indicator and an animated spinner during subagent calls.
- New env vars: `PI_BROWSE_PROVIDER`, `PI_BROWSE_MODEL`, `PI_BROWSE_MAX_TOKENS`, `PI_BROWSE_REASONING_EFFORT`.
- New `src/subagent.ts` module (config management, reasoning-param building, context truncation, OpenAI-compatible model call) with a structural `SubagentModel` interface so it type-checks under the `src/`-scoped `tsconfig` without importing pi packages.
- Added `tests/unit/subagent.test.ts` (17 tests) and 15 new tests in `tests/unit/cdp-client.test.ts` (fallbackJs path, HTTP error detection, Defuddle driver parse, vendored bundle integrity). Total test count: 58.
- **Subagent uses the current Pi model by default** — `query` mode works with zero configuration: no `/browse provider`/`/browse model` setup, no separate API keys (Pi's already-configured auth is reused via `ctx.modelRegistry.getApiKeyAndHeaders()`, mirroring pi-vision-tool). `/browse` is now optional and only needed to pin a cheaper/faster model. `/browse` with no args shows the resolved model (current or pinned).

### v0.6.0

- Added a test suite (`tests/unit/`) with 26 tests covering URL classifiers, extractor JS parse-validity, and CDP session logic (including a regression test for the v0.5.1 `waitForSelector` bug). Runs with `npm test` using Node's built-in test runner + native TypeScript stripping — zero runtime dependencies.
- Refactored `runInPage` to extract `runInPageSession(cdp, opts)` so the navigate/waitForSelector/scroll/extract logic is testable with a fake CDP client (no browser needed).
- Added `CDPLike` interface and exported testable internals (URL classifiers, extractor constants, `runInPageSession`).
- Added `waitForSelectorPollMs` option to `RunInPageOptions` (default 400ms).
- Fixed dangling `loadTimeout`/`consentTimeout` timers (now cleared after `Promise.race`).
- Added `tsconfig.json` (scoped to `src/` + `tests/`) and devDependencies (`typescript`, `@types/node`).

### v0.5.1

- **Critical fix**: `waitForSelector` was broken — `cdp.evaluate()` stringifies return values (`String(false)` → `"false"`, which is truthy), so the `if (found) break` check always broke on the first poll. This meant extractors ran **before** the target selector appeared in the DOM, causing flaky 0-result extractions (X ~60% failure rate). Fixed to compare `found === "true"`. Affects all extractors using `waitForSelector`: X, Reddit, Amazon (product + search), and Google Scholar.
- X extractor now detects X's "Something went wrong. Try reloading." error state (transient rate-limit) and reports it clearly, instead of the misleading "may require login" message. Also detects login walls.

### v0.5.0

- Added Google Scholar search extraction (`scholar.google.com/scholar?q=...`). Synchronous extractor (Scholar paginates 10/page, not infinite scroll) that extracts title, authors/venue/year, citation count (locale-agnostic), snippet, article link, and PDF link.

### v0.4.0

- Added Amazon product page extraction (`amazon.*/dp/ASIN`, `/gp/product/ASIN`, `/gp/aw/d/ASIN`). Async self-scrolling extractor for lazy-loaded reviews. Extracts title, price, list price, availability, brand, rating, review count, feature bullets, tech specs, ASIN, and best-effort top reviews.
- Added Amazon search results extraction (`amazon.*/s?k=...`). Async self-scrolling listing extractor, dedupes by ASIN.

### v0.3.0

- Added Reddit post + comment extraction (URLs containing `/comments/`). Async self-scrolling extractor with threaded comments (by `depth` attribute), dedupes by `thingid`, stale-break after 2 idle rounds.

### v0.2.0

- Added X (Twitter) extraction for search, profile, and individual tweet URLs. Async self-scrolling IIFE handles X's DOM virtualization, dedupes by permalink.

### v0.3.1

- Fixed Google consent auto-clicker: selector included `a` tags (consent buttons are never `<a>`) and regex patterns were unanchored (matched "Service Level Agreement" footer). Patterns now anchored with `^...$`, selector limited to `button,[role=button],input[type=submit]`.

## License

MIT
