# pi-search-on-your-browser

Search Google and browse the web in your own visible Chrome browser - no API keys, no headless detection, your real cookies and login sessions. A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives your coding agent two tools: `google_search` and `visit_page`.

## Highlights

- Google search via your real browser - returns compact markdown links + snippets
- `visit_page` fetches any URL as markdown using your visible Chrome (authenticated everywhere - paywalled sites, X, Reddit, Amazon, GitHub)
- `clean` extraction - reader-mode markdown via [Defuddle](https://github.com/kepano/defuddle) (the Obsidian Web Clipper library); drops nav/sidebars/ads, ~47% fewer tokens on docs pages
- `summary` subagent - pass `summary: true`, get only a concise summary of the whole page back (the full page never enters your chat context); reuses your current Pi model by default, no setup needed
- HTTP error detection - dead links return a clear `isError` with status-specific hints instead of error-page gibberish; bot-check 403s are waited out like a real browser
- Site-specific extractors - X/Twitter (structured tweets), Reddit (posts + threaded comments), Amazon (products + search), Google Scholar (papers)

> "If you need AI to do a search for you in the real world, ds4-agent is basically SOTA, because it can access the web sites without any limitations given that it uses your local Chrome browser (no, not in headless mode, that's the trick...)"
> - [@antirez on X](https://x.com/antirez/status/2066233392916525379), 2026-06-14

Inspired by the [ds4-agent](https://github.com/antirez/ds4) approach by @antirez: a visible Chrome window (not headless) driven via the Chrome DevTools Protocol, so you're authenticated everywhere - paywalled sites, Twitter, GitHub, Google - because it's your real browser.

## How it works

When you call `google_search` or `visit_page`:

1. A visible Chrome window opens (not headless) with a dedicated profile at `~/.pi-search-browser/`
2. Chrome DevTools Protocol (CDP) is used to navigate and extract content
3. JavaScript runs in the page to extract readable markdown - site-specific extractors for X, Reddit, Amazon, Scholar; [Defuddle](https://github.com/kepano/defuddle) reader-mode for `clean`; generic block-walker as fallback
4. Chrome stays alive between calls for speed (kill with `/google-search-kill`)

## Tools

### `google_search`

Search Google and get compact markdown links + text snippet.

```
google_search({ query: "TypeScript 5.7 release notes" })
```

Result links are direct destination URLs, not Google redirects: classic
`/url?q=` wrappers are unwrapped in the page, and the newer
`/goto?url=<encrypted token>` wrappers - a Tink-encrypted protobuf that cannot
be decoded offline - are resolved by following their HTTP 302 *inside the same
Chrome tab* (same cookies and proxy as the search), via the CDP network events.
A wrapper that cannot be resolved is returned as-is rather than dropped, so the
agent can still `visit_page` it.

### `visit_page`

Visit any URL and get the page content as markdown. Two parameters keep large pages from filling your conversation:

- `summary` - delegate to a subagent model that returns only a concise summary of the whole page (the raw page never enters your context; reuses your current model by default). [See below.](#optional-summary--keep-your-chat-context-small)
- `clean` - extract with Defuddle reader-mode (drops nav/sidebars/ads; ~47% fewer tokens). [See below.](#optional-clean--clean-article-markdown-via-defuddle)

`summary` and `clean` are required on every call while their mode is enabled
(both are on by default), so the schema asks for `true` or `false` explicitly.
Disable a mode with `"summaryEnabled": false` / `"cleanEnabled": false` in the
config file, `PI_BROWSE_SUMMARY_ENABLED=0` / `PI_BROWSE_CLEAN_ENABLED=0`, or
`/browse off` / `/browse clean off`: its parameter is then removed from the tool
schema (including the `required` list) and every mention of it disappears from
the description, prompt snippet, and guidelines - the model is not told the
option exists. Disabling one feature never affects the other, `url`, or
`google_search`.

```
visit_page({ url: "https://example.com/article", clean: false, summary: false })
visit_page({ url: "https://react.dev/reference/react/useState", clean: false, summary: true })
visit_page({ url: "https://react.dev/reference/react/useState", clean: true, summary: false })
```

X (Twitter) support: Any `x.com` / `twitter.com` URL - a search results
page, a profile, or an individual tweet - is extracted as structured tweets
(handle, text, timestamp, permalink, engagement). This works because the
dedicated Chrome profile carries your X login. X virtualizes its timeline, so
the extractor scrolls and collects tweets incrementally, deduping by permalink.

```
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=top", clean: false, summary: false })   // top results
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=live", clean: false, summary: false })  // latest
visit_page({ url: "https://x.com/xezpeleta", clean: false, summary: false })                   // a profile's tweets
```

Reddit support: Any `reddit.com` post URL (a path containing `/comments/`)
is extracted as the post (title, author, score, self-text) plus threaded
comments - each with author, score, OP marking, and depth-indented replies.
Reddit lazy-loads comments on scroll, so the extractor scrolls and collects
incrementally, deduping by comment id. Subreddit listings and user pages fall
through to the generic extractor.

```
visit_page({ url: "https://www.reddit.com/r/programming/comments/.../", clean: false, summary: false })
```

Amazon support: Any `amazon.*` product page (`/dp/ASIN`, `/gp/product/ASIN`)
or search page (`/s?k=...`) gets a dedicated extractor. Product pages return
structured data - title, price, list price, availability, brand, rating,
review count, feature bullets, technical specifications, ASIN, and top reviews
(best-effort) - instead of the ~110 KB of navigation noise the generic
extractor would pull. Search pages return a clean listing of products with
title, price, rating, ASIN, and link, scrolling to collect more results.

```
visit_page({ url: "https://www.amazon.es/s?k=E220-900T22D", clean: false, summary: false })        // search
visit_page({ url: "https://www.amazon.es/-/en/.../dp/B097GZBZ9Y", clean: false, summary: false })  // product
```

Other Amazon pages (category, seller, etc.) fall through to the generic
extractor.

Google Scholar support: Any `scholar.google.com` URL is extracted as
structured paper results - title, authors/venue/year, citation count, abstract
snippet, and PDF link - instead of the flat H3 headers the generic extractor
produces (which drops all the academic metadata). Scholar paginates 10 results
per page (not infinite scroll), so the extractor returns the current page;
for more results, visit the next page URL (`&start=10`, `&start=20`, etc.).
Citation counts are parsed locale-agnostically ("Cited by 1108" / "Cité 1108
fois" / "Citado por 1108" / "Zitiert von 1108").

```
visit_page({ url: "https://scholar.google.com/scholar?q=transformer+attention+is+all+you+need", clean: false, summary: false })
```

### Optional `summary` - keep your chat context small

By default, `visit_page` returns the full rendered page as markdown. For large
pages this can dump tens of thousands of characters into your conversation.
Pass `summary: true` and the full page content is instead read by a
configurable subagent model (a separate, cheap LLM call) that returns only
a concise summary of *all* the information on the page. The raw page markdown
never enters your chat context - only the subagent's summary does.

While summary mode is enabled, `summary` is required on every call: pass
`false` to get the page markdown instead.

```
visit_page({ url: "https://react.dev/reference/react/useState", clean: false, summary: true })
```

- `summary` summarizes the page - it reads the single page at the `url`
  you pass to `visit_page` and returns a concise summary of everything on it.
  It is not a search: it does not look at other pages or the web, and it is
  not a replacement for `google_search`. Use `google_search` to find pages,
  then `visit_page` + `summary` to get a compact digest of one of them.
- The page is fetched exactly as usual (your visible Chrome, all the
  site-specific extractors above still run); only the *return value* changes.
- The subagent reuses your current Pi model by default (no API keys to
  set up - Pi's already-configured auth is used). Pin a different model with
  `/browse` if you want a cheaper/faster one for summarization.
- The footer shows a `🌐 provider/model` indicator only when the subagent is
  pinned to a model different from your session model (run `/browse` with no
  arguments to see what it resolves to); an animated spinner appears while the
  subagent is summarizing. Reusing the session model needs no indicator -
  Pi's own footer already shows that model.
- The collapsed tool result shows the context savings, e.g.
  `-> 92,340->1,187 chars - openai/gpt-4o-mini - 3.2s - react.dev`.

This mirrors the subagent pattern from the
[pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool) extension.

Disabling summary mode. Set `"summaryEnabled": false` in
`~/.pi/agent/search-on-your-browser.json` (or run `/browse off`, or start Pi with
`PI_BROWSE_SUMMARY_ENABLED=0`) and `visit_page` stops offering `summary` at all:
the parameter is removed from the tool schema, and the description, prompt
snippet, and guidelines are swapped for variants that never mention it. The model
is not told the option exists, and pages are always returned as extracted
markdown. Your pinned model and settings are kept, so `/browse on` restores the
option on the next turn. This differs from the old behavior, where a disabled
subagent still advertised `summary` and returned an error when the model used
it.

Disabling clean mode. `"cleanEnabled": false` (or `/browse clean off`, or
`PI_BROWSE_CLEAN_ENABLED=0`) hides the `clean` option the same way: the
parameter is removed and every mention of it disappears - including the
"Combine with `clean: true`" sentence in the summary parameter's own
description. The default page extraction is always used. Clean and summary mode
are independent: disabling either leaves the other untouched.

### Optional `clean` - clean article Markdown via Defuddle

By default, `visit_page` on a generic (non-specialized) page uses a naive
block-walker that includes navigation, sidebars, up to 80 "visible links",
and truncates at 90 KB - noisy and token-heavy. Pass `clean: true` and the
page is instead extracted with [Defuddle](https://github.com/kepano/defuddle)
(the same library the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)
uses): a reader-mode-style article extractor that drops navigation, sidebars,
ads, and footers, returning only the main article content as clean Markdown.

While clean mode is enabled, `clean` is required on every call: pass `false`
for the default page extraction.

```
visit_page({ url: "https://react.dev/reference/react/useState", clean: true, summary: false })
```

- Best for articles, docs, and blog posts - cleaner output and far fewer
  tokens than the default.
- No effect on X, Reddit, Amazon, or Google Scholar URLs - those already
  use purpose-built extractors that produce clean compact Markdown.
- If Defuddle fails or returns nothing (e.g. on a SPA with no article content),
  it automatically falls back to the generic extractor in the same page load.
- Combine with `summary` for the best of both: `clean: true` gives the subagent
  clean article text to read, and `summary` returns only its concise digest -
  ideal for large articles.

Defuddle is a regular npm dependency (`defuddle`, MIT-licensed). Its full
browser entry (`dist/index.full.js`, ~750 KB, UMD) is injected into the page
via a single CDP `Runtime.evaluate` call before the extraction driver runs -
the full entry is what bundles Defuddle's Turndown-based Markdown converter
(and its math rendering), which is why `clean: true` returns Markdown rather
than HTML. Missing the dependency degrades gracefully - `clean: true` falls back to the
generic extractor.

```
visit_page({ url: "https://react.dev/reference/react/useState", clean: true, summary: true })
```

### HTTP error detection (4xx / 5xx)

`visit_page` monitors the page's HTTP response status via the CDP `Network`
domain. When the server returns a 4xx or 5xx status (e.g. a `404 Not Found`
on a dead or renamed link - a common occurrence with Cloudflare blog posts,
relocated docs, or hallucinated URLs), the tool returns an `isError` result
with a clear message instead of silently extracting the error page's content:

```
HTTP 404 Not Found - The page does not exist at this URL - the content may
have been moved, removed, or the URL may be incorrect. Try a different URL
or search for the content.
```

This tells the model the URL is dead so it can try a different one or search
again, rather than receiving "Page Not Found" gibberish as if it were page
content. The collapsed tool result shows the status code, e.g.
`-> HTTP 404 - 1.2s - blog.cloudflare.com`.

Bot-check interstitials are handled like a real browser. Cloudflare (and
DataDome, PerimeterX, Akamai, Imperva) answer the first request with 403/503
(Cloudflare marks it `cf-mitigated: challenge`), run a JavaScript challenge in
the page and reload to the real document a few seconds later - an ordinary
browser never shows the user that first response. `visit_page` now tracks every
document response per frame (an ad/iframe `Document` response cannot mask the
main page), keeps the tab open on a 403/503, activates it, and waits up to 15s
for the self-reload before believing the error. A 403/503 *without* challenge
markers gets one `Page.reload` retry instead (the F5 move). If the challenge
still does not clear, the result is `HTTP 403 Bot challenge not passed` with a
hint to open the visible Chrome window - the clearance cookie it obtains stays
in the profile, so the next attempt succeeds. The tool also no longer enables
the CDP `Runtime` domain: `Runtime.evaluate` works without it, and enabling it
is a known fingerprint that anti-bot scripts probe for.

Status-specific hints:

| Status | Hint |
|---|---|
| 404 | Page doesn't exist - try a different URL or search |
| 403 | Access denied or an unresolved bot check - the visible Chrome window can clear it, then retry |
| 429 | Rate limited - wait and retry |
| 5xx | Server error - retry shortly or try a different URL |

## Commands

- `/browse` - Configure the `visit_page` subagent and the Chrome proxy (see below).
- `/google-search-kill` - Kill the Chrome browser.

### Troubleshooting: Chrome launch flags are applied automatically

`visit_page` drives a visible Chrome that `pi-search-on-your-browser`
launches once and keeps alive across tool calls. The flags the live Chrome was
started with are recorded in a marker file inside the dedicated profile
(`~/.pi-search-browser/.pi-launch-args.json`), so when the effective flags
change - after an upgrade, or after adding/removing/changing a proxy - the
already-running Chrome is detected as stale and restarted automatically on
the next tool call ("Restarting Chrome to apply updated launch flags..."
appears in the tool call block).

You can still force a restart yourself at any time with `/google-search-kill`
(or `pkill -f remote-debugging-port=9322`); the next tool call relaunches
Chrome. Symptoms of a stale Chrome: `visit_page` hangs for ~30s on lazy-load
pages (e.g. `github.com`) and fails with `CDP call timeout: Runtime.evaluate`
when Chrome's window is in the background.

### Diagnostics: quiet by default

The extension writes nothing to stderr during normal operation. Pi's TUI
runs in raw mode and renders raw stderr writes on the text input bar, so
`[pi-search] ...` messages (Chrome launched/ready/exited, launch flags changed)
would appear as noise while you are typing. Progress the user should see
("Launching Chrome...", "Restarting Chrome...", "Navigating to ...") is
reported through the tool's status callback and rendered inside the tool call
block instead.

Set `PI_SEARCH_DEBUG=1` to get the diagnostics back on stderr when
troubleshooting (Chrome path, proxy flag, exit code, restart decisions). On
Windows PowerShell: `$env:PI_SEARCH_DEBUG="1"; pi`.

### Parallel tool calls

Agents commonly issue several `google_search` / `visit_page` calls in one
turn. They share the single visible Chrome window, which is intentional - but
it used to be fragile, and a real session shows why: two parallel GitHub
visits through a slow proxy took ~32s each, and the fixed 30s per-call CDP
timeout failed one of them with `visit_page failed: CDP call timeout:
Page.navigate`. Three things handle that now:

- `Page.navigate` is retried. Each attempt gets 15s; after a timeout the
  navigation is re-issued (up to 3 attempts). The command is idempotent for a
  fixed URL, so a retry either picks up the load that already started or
  restarts it. A page that finishes loading while the nav command's reply is
  still stuck in the browser is accepted immediately - the load event wins.
- A dead CDP socket fails fast. If Chrome exits or the tab/target crashes,
  in-flight calls reject right away with `CDP connection closed` instead of
  waiting out the 30s timeout and reporting a misleading navigation timeout.
- Chrome start/restart is serialized. Cold-starting five parallel calls
  launches exactly one Chrome (previously each could spawn its own), and two
  calls that both detect stale launch flags no longer restart the browser out
  from under each other.

Only genuine stalls are retried: connection errors and rejected CDP commands
propagate immediately. If a navigation still fails after all attempts, the
error says so explicitly (`... after 3 attempts of 15s - the page or the proxy
may be slow`), which is the signal to retry the tool call or check the proxy.

### `/browse` - subagent configuration

`visit_page`'s `summary` mode uses a subagent model to read the page and
return only a concise summary, keeping your chat context small. The subagent
is a normal model from your Pi model registry (the same providers/models you
already use), called through Pi's provider-neutral stream API
(`ctx.modelRegistry.streamSimple()`) using Pi's already-configured auth -
no separate API keys to set up, and every Pi provider works (OpenAI-compatible,
Anthropic, Google, Bedrock, ...).

By default the subagent reuses your current session model (the one you're
chatting with). So `summary` mode works with zero configuration. Use `/browse`
only if you want to pin a different (e.g. cheaper/faster) model:

```
/browse                          # show current config
/browse on                       # enable summary mode (default)
/browse off                      # disable: hide `summary` from the model; raw pages are returned
/browse clean on|off             # enable/disable clean mode (hide `clean` from the model)
/browse provider openai          # pin a provider (overrides current model)
/browse model gpt-4o-mini        # pin a model (overrides current model)
/browse max-tokens 2048          # max output tokens for the summary
/browse reasoning-effort low     # off|minimal|low|medium|high|xhigh
/browse clear                    # unpin -> back to current model
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

```jsonc
// ~/.pi/agent/search-on-your-browser.json
{
  "summaryEnabled": false,             // hide visit_page's `summary` option entirely
  "cleanEnabled": false,               // hide visit_page's `clean` option entirely
  "browser": { "proxy": "http://127.0.0.1:8010" }
}
```

Environment variables (optional - override the current-model default at
startup; the config file wins over these once set):

| Variable | Default | Meaning |
|---|---|---|
| `PI_BROWSE_PROVIDER` | - | pin a subagent provider (else: current model) |
| `PI_BROWSE_MODEL` | - | pin a subagent model (else: current model) |
| `PI_BROWSE_MAX_TOKENS` | `2048` | max output tokens for the summary |
| `PI_BROWSE_REASONING_EFFORT` | `off` | thinking level for reasoning models |
| `PI_BROWSE_SUMMARY_ENABLED` | `1` | `0`/`false`/`no`/`off` hides `visit_page`'s `summary` option |
| `PI_BROWSE_CLEAN_ENABLED` | `1` | `0`/`false`/`no`/`off` hides `visit_page`'s `clean` option |
| `PI_SEARCH_PROXY` | - | proxy for the Chrome browser (see below) |

### Proxy - browsing through a proxy

On machines that need a proxy to reach the internet, `google_search` and
`visit_page` would otherwise hang on pages that never load. Chrome is launched
with `--proxy-server=<value>`, which covers every request it makes - including
the CDP-driven navigations - so the whole tool keeps working. You do *not* need
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

- Google Chrome or Chromium installed (Firefox is not currently supported - see below)
- Node.js 22.19+ (Pi's minimum; tests use native TypeScript stripping)

### Why Chrome only?

Firefox uses the [WebDriver BiDi protocol](https://w3c.github.io/webdriver-bidi) for remote control, not the Chrome DevTools Protocol (CDP). While both use WebSocket, Firefox's BiDi server requires a manual WebSocket handshake with specific header handling (no `Origin` header). Node.js's built-in `WebSocket` doesn't expose custom headers. Pull requests welcome if you can solve this.

## Development

### Tests

```bash
pnpm install
pnpm test
```

Six layers of tests (123 total):

- `tests/unit/urls.test.ts` - table-driven tests for the URL classifiers (`isXUrl`, `isRedditPostUrl`, `isAmazonProductUrl`, `isAmazonSearchUrl`, `isScholarSearchUrl`).
- `tests/unit/extractors-parse.test.ts` - validates every extractor JS string (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, etc.) parses as valid JavaScript via `new Function()`. Catches template-literal escaping bugs (the `\n` vs real-newline class of errors) without a browser.
- `tests/unit/cdp-client.test.ts` - tests `runInPageSession` (the navigate/waitForSelector/scroll/extract logic) against a fake `CDPLike` implementation. Includes the regression test for the v0.5.1 bug: `cdp.evaluate()` stringifies return values, so `String(false)` -> `"false"` (truthy); the test asserts `waitForSelector` does *not* break on the first poll when the selector is absent. Also tests the `fallbackJs` path (Defuddle -> generic extractor fallback), HTTP error detection (4xx/5xx -> `__HTTP_ERROR__` marker, extraction skipped, no fallback), the Defuddle bundle resolved from the installed npm package (UMD, full entry with the Markdown converter, no Node-only deps, cached, and the dependency stays declared), the background-renderer launch flags, browser discovery (Windows install paths, `CHROME_PATH`, Edge fallback), the proxy flag, the actionable spawn-error message for the Windows `spawn google-chrome ENOENT` crash, and that the only `console.*` write in `chrome.ts` is the one gated behind `PI_SEARCH_DEBUG` (no TUI input-bar noise). Navigation resilience under parallel load is covered too: `Page.navigate` retries (and accepts a page that loads while the command reply is still pending), non-timeout errors (a dead socket) are *not* retried, and the final error names the attempt budget.
- `tests/unit/subagent.test.ts` - tests the subagent layer used by `visit_page`'s `summary` mode: config load/save/resolve (including the `summaryEnabled` and `cleanEnabled` flags, their independence, and the `PI_BROWSE_SUMMARY_ENABLED` / `PI_BROWSE_CLEAN_ENABLED` env vars), reasoning-level validation, context-window truncation with token-budget reservation, and summary-prompt construction. Also covers the browser proxy config: value normalization (`host:port` -> `http://`, socks, off switches, invalid values), resolution precedence (file `browser.proxy` > top-level `proxy` > `PI_SEARCH_PROXY` > direct), tolerance of a malformed file, the saved file shape, and the `/browse` summary line. No network calls - the model call itself lives in `index.ts` (via `ctx.modelRegistry.streamSimple()`) and is only exercised live.
- `tests/unit/tool-surface.test.ts` - asserts the agent-facing `visit_page` text across all four `summaryEnabled` * `cleanEnabled` combinations: a disabled feature is never mentioned (no parameter description, no guideline, no `/browse` hint) while the base stays minimal and the description/snippet only grow as features are enabled; no site-specific extractor names (X/Twitter, Reddit, Amazon, Scholar) appear anywhere; and `stripDisabledArguments` removes exactly the disabled arguments without mutating the input.
- `tests/unit/google-links.test.ts` - covers Google redirect handling: `isGoogleRedirectUrl` (`/url` and `/goto` on any google host, nothing else), `findGoogleRedirectUrls` (dedupe, order, non-redirect links ignored), `replaceGoogleRedirects` (mapped URLs swapped, unresolved ones kept), and the CDP-driven `resolveGoogleRedirectsInBrowser` against a fake CDP - redirect hops mapped from `Network.requestWillBeSent` events, `Location`-header preference, no-op when there is nothing to resolve, timeout keeping the original `/goto` link, and a failed trigger leaving the markdown untouched. No browser, no network.

### Type-checking

```bash
pnpm run typecheck
```

Uses `tsc --strict` and covers `index.ts`, `src/`, and `tests/`. The host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are declared in both `peerDependencies` (what Pi supplies at runtime) and `devDependencies` (so `tsc` resolves them locally). Pi loads extensions through jiti, which strips types without checking them - so the typecheck is the only place stale Pi APIs surface; it is expected to be clean.
