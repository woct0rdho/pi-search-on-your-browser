# pi-search-on-your-browser

Search Google and browse the web in your own visible Chrome browser - no API keys, no headless detection, your real cookies and login sessions. A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives your coding agent four tools: `google_search`, `google_image_search`, `google_search_by_image`, and `visit_page`.

## Highlights

- Google search via your real browser - returns compact markdown links + snippets
- Google image search - every result comes with the image URL and the URL of the page it appears on, plus title and size. The original file is resolved through Google's preview panel when the site allows it
- Reverse image search - upload a local image file to Google Lens and get the pages showing that exact image (`exact`) or visually similar images and their pages (`visual`)
- `visit_page` fetches any URL as markdown using your visible Chrome (authenticated everywhere - paywalled sites, X, Reddit, Amazon, GitHub)
- `clean` extraction - reader-mode markdown via [Defuddle](https://github.com/kepano/defuddle) (the Obsidian Web Clipper library). Drops nav/sidebars/ads, ~47% fewer tokens on docs pages
- `summary` subagent - pass `summary: true`, get only a concise summary of the whole page back (the full page never enters your chat context). Reuses your current Pi model by default, no setup needed
- HTTP error detection - dead links return a clear `isError` with status-specific hints instead of error-page gibberish. Bot-check 403s are waited out like a real browser
- Generic pages come back as main text plus inline links and image URLs, an `## Images` list, and a `## Navigation` list (next/previous page, article list, original source)
- Holds up on niche and legacy sites: plain `http://`, JavaScript/meta-refresh redirects, and pages whose ad scripts navigate the tab away mid-visit
- Site-specific extractors - X/Twitter (structured tweets), Reddit (posts + threaded comments), Amazon (products + search), Google Scholar (papers)

> "If you need AI to do a search for you in the real world, ds4-agent is basically SOTA, because it can access the web sites without any limitations given that it uses your local Chrome browser (no, not in headless mode, that's the trick...)"
> - [@antirez on X](https://x.com/antirez/status/2066233392916525379), 2026-06-14

Inspired by the [ds4-agent](https://github.com/antirez/ds4) approach by @antirez: a visible Chrome window (not headless) driven via the Chrome DevTools Protocol, so you're authenticated everywhere - paywalled sites, Twitter, GitHub, Google - because it's your real browser.

## How it works

When you call `google_search`, `google_image_search`, `google_search_by_image`, or `visit_page`:
- A visible Chrome window opens (not headless) with a dedicated profile at `~/.pi-search-browser/`
- Chrome DevTools Protocol (CDP) is used to navigate and extract content
- JavaScript runs in the page to extract readable markdown - site-specific extractors for X, Reddit, Amazon, Scholar. [Defuddle](https://github.com/kepano/defuddle) reader-mode for `clean`. Generic pages come back as main text plus images and navigation links
- Chrome stays alive between calls for speed

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

### `google_image_search`

Search Google Images (`udm=2`) and get, for every result, both the image URL
and the URL of the page the image was found on:

```
google_image_search({ query: "red panda" })
google_image_search({ query: "red panda", count: 12 })
```

Each result carries the page title, the image URL, the source page URL and (when
known) the image size:

```
1. Red panda - Wikipedia
   image: https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fd/Red_Panda...1280px-....jpg
   page: https://en.wikipedia.org/wiki/Red_panda
   size: 1280x853
2. Red Panda | National Geographic Kids
   image: https://i.natgeofe.com/k/63b1a8a7-.../red-panda-full-body_16x9.jpg
   page: https://kids.nationalgeographic.com/animals/mammals/facts/red-panda
   size: 1200x675
```

- The image URL is the original file when the site allows hotlinking. Some
  hosts don't (Facebook, for one), and Google only keeps a cached copy. Those
  results are returned with Google's cached thumbnail and are marked
  `(google-cached)`, so the agent knows the difference. Either way the page URL
  is the real source page.
- Google's grid does not contain the original URLs at all - they only show up in
  the preview panel after a tile is clicked. The extractor therefore opens the
  first `count` tiles in that panel in the same tab (the page itself is never
  left) and reads the original URL when it loads. That makes the call take a few
  seconds longer than `google_search`. Results it doesn't get to in time still
  come back from the grid data, with the cached thumbnail.
- `count` is 1-12 (default 8). Fewer results means more time per image, so the
  top results are more likely to come back at full resolution.
- Like the other tools it uses your visible Chrome, so it sees the same Google
  session (consent, language, region, proxy) as `google_search`.

### `google_search_by_image`

Reverse image search: upload a local image file to Google Lens and get back
where it appears. `mode` is required - the agent has to choose what it wants:

- `mode: "exact"` - pages that show the same image. Use it to find the
  original page, credits, or other places the image is reused.
- `mode: "visual"` - visually similar images and the pages they appear on.
  Use it to find lookalikes, related photos, products, or the likely subject.

```
google_search_by_image({ path: "screenshots/header.png", mode: "exact" })
google_search_by_image({ path: "~/Downloads/photo.jpg", mode: "visual" })
```

Every result carries the page URL, the source site, and (for visual matches,
when Google exposes one) the matched image URL:

```
1. [Noemys Viviers-du-lac, Viviers-du-lac (updated prices 2027)](https://www.booking.com/hotel/fr/hotel-le-clos-du-lac.html)
   source: Booking.com
2. [View of the Lake Lugano promenade - Komoot](https://www.komoot.com/smarttour/24899533)
   source: Komoot
```

- The path resolves like Pi's read tool: absolute, relative to the working
  directory, or `~/...`. PNG, JPEG, GIF, WebP and BMP up to 20 MB are accepted.
  The file is checked by its signature before anything is uploaded.
- The upload goes through Lens's own file input in the visible Chrome, so it
  carries the real browser's cookies, user agent and proxy. The mode is
  Google's own result tab (`udm=48` exact, `udm=44` visual).
- Page links are Google `/goto?url=` wrappers and are resolved to the real pages
  by following the redirect inside the same tab, exactly like `google_search`.
  A link that cannot be resolved is kept as-is so it is still visitable.
- The bot-check handling from `visit_page` applies here too: a challenge page is
  waited out (and clicked if it needs a gesture), and a CAPTCHA is reported
  instead of being returned as results.
- Results are capped at the top 12 per mode. Exact matches are pages (every one
  shows the uploaded image, so no per-result image URL). Visual matches include
  the matched image URL when available.

### `visit_page`

Visit any URL and get the page content as markdown. Two parameters keep large pages from filling your conversation:
- `summary` - delegate to a subagent model that returns only a concise summary of the whole page (the raw page never enters your context, reuses your current model by default). [See below.](#optional-summary--keep-your-chat-context-small)
- `clean` - extract with Defuddle reader-mode (drops nav/sidebars/ads, ~47% fewer tokens). [See below.](#optional-clean--clean-article-markdown-via-defuddle)

`summary` and `clean` are required on every call while their mode is enabled
(both are on by default), so the schema asks for `true` or `false` explicitly.
Disable a mode with `"summaryEnabled": false` / `"cleanEnabled": false` in the
config file, or `PI_BROWSE_SUMMARY_ENABLED=0` / `PI_BROWSE_CLEAN_ENABLED=0`:
its parameter is then removed from the tool
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
per page (not infinite scroll), so the extractor returns the current page.
For more results, visit the next page URL (`&start=10`, `&start=20`, etc.).
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
  site-specific extractors above still run). Only the *return value* changes.
- The subagent reuses your current Pi model by default (no API keys to
  set up - Pi's already-configured auth is used).
- The footer shows a `🌐 provider/model` indicator only when the subagent is
  pinned to a model different from your session model.
  An animated spinner appears while the
  subagent is summarizing. Reusing the session model needs no indicator -
  Pi's own footer already shows that model.
- The collapsed tool result shows the context savings, e.g.
  `-> 92,340->1,187 chars - openai/gpt-4o-mini - 3.2s - react.dev`.

This mirrors the subagent pattern from the
[pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool) extension.

Disabling summary mode. Set `"summaryEnabled": false` in
`~/.pi/agent/search-on-your-browser.json` (or start Pi with
`PI_BROWSE_SUMMARY_ENABLED=0`) and `visit_page` stops offering `summary` at all:
the parameter is removed from the tool schema, and the description, prompt
snippet, and guidelines are swapped for variants that never mention it. The model
is not told the option exists, and pages are always returned as extracted
markdown.

Disabling clean mode. `"cleanEnabled": false` (or
`PI_BROWSE_CLEAN_ENABLED=0`) hides the `clean` option the same way: the
parameter is removed and every mention of it disappears - including the
"Combine with `clean: true`" sentence in the summary parameter's own
description. The default page extraction is always used. Clean and summary mode
are independent: disabling either leaves the other untouched.

### What the generic extraction returns

Generic (non-specialized) pages are read by an in-page walker that takes the
page apart the way a person skimming it would. The markdown has up to four
sections:
- `## Content` - the main text: headings, paragraphs, list items, quotes, table
  cells. Links inside the text stay inline (`[text](url)`), images too
  (`![alt](url)`).
- `## Images (N)` - the page's content images, resolved from `srcset` (best
  candidate), `currentSrc`, and the usual lazy-load attributes (`data-src`,
  `data-original`, `data-lazy-src`, `data-echo`, ...). Icons, spacers, and
  images smaller than 64px are skipped. At most 60 are listed.
- `## Navigation` - navigation back to the site's content: declared
  (`<link rel=next|prev|up|contents|...>`, `a[rel]`) and heuristic
  (next/previous page, article list, index, original source, pagination).
- `## Visible links` - the remaining visible links (120 max).

`nav`/`aside`/`header`/`footer` and their ARIA-landmark equivalents are
skipped, so the text is not diluted by site chrome. Use `clean: true` when you
want a single article and nothing else. The default extraction is what keeps
comments, image galleries, and the links out.

### Niche and legacy sites

The long tail of the web is not article-shaped, and a specialized extractor is
not worth writing per site. What the tool does for those pages:
- Plain `http://` works. Chrome's automatic HTTPS upgrades are disabled
  (`HttpsUpgrades`, `HttpsFirstModeV2`, ...), because the sites that never got
  a certificate would otherwise be replaced by `ERR_BLOCKED_BY_CLIENT` before
  the request is even made.
- JavaScript redirects, meta refreshes, and `document.write` reloads are
  waited out (`waitForSettledDocument`): the extraction runs on the page the
  redirect lands on, not on the redirect stub, and not while `document.body`
  is still null.
- Ad/anti-bot scripts that navigate the tab away a few seconds after load no
  longer cost the extraction: a copy is taken as soon as the page settles, and
  it is what gets returned if the tab has left the page you asked for by the
  time scrolling and waiting are done.
- Extraction starts as soon as the page has text instead of waiting for the
  load event, which ad frames and analytics can delay for ten seconds - the
  text is usually there long before, and extracting earlier is what keeps a
  hijack from happening first.
- A navigation that ends on Chrome's error page (transient proxy/DNS/TLS
  failures are common when several calls run at once) is re-navigated once
  before the tool reports a navigation error.
- Sites that answer every request from a fresh IP with a challenge remain
  outside what an extraction tool can do. The visible Chrome window can clear
  those interactively, and the cookie stays in the profile.

### Walls, shell pages and downloads

A page can answer `200 OK` and still not be the page: a bot check, a CAPTCHA,
a login form, a JavaScript shell that has not hydrated, or a file download.
These used to come back as short, plausible-looking "content". Now:

- Bot checks served as 200 (Fastly's "Client Challenge" on pypi.org,
  Cloudflare's "Just a moment...") and JavaScript shells ("Loading...",
  lensisku.lojban.org) are detected in the page after it settles, the tab is
  activated and given up to 30 s to render itself. Both clear once the tab is
  visible - a hidden tab pauses rAF and challenge scripts - so the extraction
  runs on the real page. If nothing moves after 12 s, the challenge gets one
  reload (Cloudflare's script occasionally stalls waiting for a fresh
  document). If it still does not clear, the tool returns an error naming what
  was on the page instead of handing the wall back as content.
- Interactive bot checks (the "Verify you are human" Turnstile checkbox,
  reCAPTCHA/hCaptcha equivalents) are clicked like a user would: the tool finds
  the widget's box - including inside a *closed shadow root*, which only CDP's
  DOM domain can see - and dispatches a real mouse move + click at the
  checkbox, then at the widget centre if the first click did not take. This is
  the same approach FlareSolverr and nodriver use for Cloudflare. No extra
  service or dependency. CAPTCHA *solving* is out of scope by design.
- CAPTCHA gates (a `reCAPTCHA`/`hCaptcha`/Turnstile widget plus gate
  wording such as "Verify you are human" or "Login To Skip This Step", e.g.
  jbovlaste's export form) and login forms (a *visible* password field on a
  short page. A hidden login modal in a long page's header is not a wall) are
  reported straight away with a hint to solve/sign in in the visible Chrome
  window and retry. A page that merely embeds a Turnstile widget in its own
  form (nowsecure.nl) is content, not a gate.
- File downloads (`Content-Disposition: attachment`: Gitiles'
  `?format=TEXT`, API endpoints, CSV/JSON exports) are read with a same-origin
  `fetch()` from the browser - cookies, TLS and proxy included - and returned
  as fenced text, base64 bodies decoded. Binary files are reported as a
  download instead of being rendered as garbage.
- Redirects that change the page shape are called out with a
  `> Redirected: <requested> -> <final>` line (t.me/s/`<group>` redirects to
  the group's join page and drops the message feed). Scheme, `www.`, trailing
  slash and query-only changes are not reported.

What stays out of scope: solving CAPTCHAs, multi-step interactive forms, and
sites that challenge every request from a fresh IP (a rotating proxy defeats
`cf_clearance`). Those are reported as errors instead of pretending they
worked, which is also the point where a general browser-use tool is the better
answer.

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
markers gets one `Page.reload` retry instead (the F5 move). A 5xx does too: a
gateway error from a proxy or upstream (a plain `http://` page answering 502
while the same URL loads fine seconds later) is just as transient, and one
reload is what a user does about it. If the challenge
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
| 5xx | Server or gateway error - the tool reloads once. If it persists, retry shortly or try a different URL |

### Troubleshooting: Chrome launch flags are applied automatically

`visit_page` drives a visible Chrome that `pi-search-on-your-browser`
launches once and keeps alive across tool calls. The flags the live Chrome was
started with are recorded in a marker file inside the dedicated profile
(`~/.pi-search-browser/.pi-launch-args.json`), so when the effective flags
change - after an upgrade, or after adding/removing/changing a proxy - the
already-running Chrome is detected as stale and restarted automatically on
the next tool call ("Restarting Chrome to apply updated launch flags..."
appears in the tool call block).

You can still force a restart yourself at any time with
`pkill -f remote-debugging-port=9322`. The next tool call relaunches
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

Agents commonly issue several `google_search` / `google_image_search` / `visit_page` calls in one
turn. They share the single visible Chrome window, which is intentional - but
it used to be fragile, and a real session shows why: two parallel GitHub
visits through a slow proxy took ~32s each, and the fixed 30s per-call CDP
timeout failed one of them with `visit_page failed: CDP call timeout:
Page.navigate`. Three things handle that now:
- `Page.navigate` is retried. Each attempt gets 15s. After a timeout the
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

### Subagent configuration

`visit_page`'s `summary` mode uses a subagent model to read the page and
return only a concise summary, keeping your chat context small. The subagent
is a normal model from your Pi model registry (the same providers/models you
already use), called through Pi's provider-neutral stream API
(`ctx.modelRegistry.streamSimple()`) using Pi's already-configured auth -
no separate API keys to set up, and every Pi provider works (OpenAI-compatible,
Anthropic, Google, Bedrock, ...).

By default the subagent reuses your current session model (the one you're
chatting with). So `summary` mode works with zero configuration.

When the subagent is pinned to a different model, the footer shows
`🌐 provider/model`. Otherwise no indicator appears, because the session model
it reuses is already in Pi's footer.

The config file is optional - every key falls back to an environment variable,
then to the session model or a built-in default. It is read
when a session starts, so a new session picks up changes (no Pi restart).

```jsonc
// ~/.pi/agent/search-on-your-browser.json
{
  "summaryEnabled": false,             // hide visit_page's `summary` option entirely
  "cleanEnabled": false,               // hide visit_page's `clean` option entirely
  "provider": "openai",                // pin a subagent provider (optional)
  "model": "gpt-4o-mini",              // pin a subagent model (optional)
  "maxTokens": 2048,                   // max output tokens for the summary
  "defaultReasoningEffort": "off",     // off|minimal|low|medium|high|xhigh
  "browser": { "proxy": "http://127.0.0.1:8010" }
}
```

`provider` and `model` go together (`maxTokens` defaults to `2048`). Leave both
out to reuse the session model.

Environment variables (optional - override the current-model default at
startup. The config file wins over these once set):

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

On machines that need a proxy to reach the internet, `google_search`,
`google_image_search` and `visit_page` would otherwise hang on pages that never load. Chrome is launched
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
defaults to `http://`). Localhost is never proxied. Set it in the config file,
or with the `PI_SEARCH_PROXY` environment variable (the config file wins once
set).

Changing the proxy takes effect on the next tool call: the running Chrome is
restarted with the new flag (no Pi restart).

## Requirements

- Google Chrome or Chromium installed (Firefox is not currently supported - see below)
- Node.js 22.19+ (Pi's minimum, tests use native TypeScript stripping)

### Why Chrome only?

Firefox uses the [WebDriver BiDi protocol](https://w3c.github.io/webdriver-bidi) for remote control, not the Chrome DevTools Protocol (CDP). While both use WebSocket, Firefox's BiDi server requires a manual WebSocket handshake with specific header handling (no `Origin` header). Node.js's built-in `WebSocket` doesn't expose custom headers. Pull requests welcome if you can solve this.

## Development

### Tests

```bash
pnpm install
pnpm test
```

Nine layers of tests (167 total):
- `tests/unit/urls.test.ts` - table-driven tests for the URL classifiers (`isXUrl`, `isRedditPostUrl`, `isAmazonProductUrl`, `isAmazonSearchUrl`, `isScholarSearchUrl`).
- `tests/unit/extractors-parse.test.ts` - validates every extractor JS string (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, etc.) parses as valid JavaScript via `new Function()`. Catches template-literal escaping bugs (the `\n` vs real-newline class of errors) without a browser.
- `tests/unit/cdp-client.test.ts` - tests `runInPageSession` (the navigate/waitForSelector/scroll/extract logic) against a fake `CDPLike` implementation. Includes the regression test for the v0.5.1 bug: `cdp.evaluate()` stringifies return values, so `String(false)` -> `"false"` (truthy). The test asserts `waitForSelector` does *not* break on the first poll when the selector is absent. Also tests the `fallbackJs` path (Defuddle -> generic extractor fallback), HTTP error detection (4xx/5xx -> `__HTTP_ERROR__` marker, extraction skipped, no fallback), the Defuddle bundle resolved from the installed npm package (UMD, full entry with the Markdown converter, no Node-only deps, cached, and the dependency stays declared), the background-renderer launch flags, browser discovery (Windows install paths, `CHROME_PATH`, Edge fallback), the proxy flag, the actionable spawn-error message for the Windows `spawn google-chrome ENOENT` crash, and that the only `console.*` write in `chrome.ts` is the one gated behind `PI_SEARCH_DEBUG` (no TUI input-bar noise). Navigation resilience under parallel load is covered too: `Page.navigate` retries (and accepts a page that loads while the command reply is still pending), non-timeout errors (a dead socket) are *not* retried, and the final error names the attempt budget. Client-side redirects are waited out (`waitForSettledDocument`), the pre-scroll extraction is kept when the page navigates away mid-visit, a tab that lands on Chrome's error page re-navigates once, and specialized extractors still run exactly once. The wall/download paths are covered too: a bot-check page that clears is extracted after the tab is activated, one that does not returns a `__BLOCKED__: challenge` marker (likewise `captcha` and `login`), a visible bot-check widget is clicked at the checkbox coordinates (then at the widget centre) and an off-screen duplicate is ignored, no click happens for a JavaScript-only challenge, a text download is read through a same-origin `fetch()` and returned fenced (base64 decoded), a binary download is reported, and a host/path-changing redirect adds a `> Redirected:` line.
- `tests/unit/subagent.test.ts` - tests the subagent layer used by `visit_page`'s `summary` mode: config load/resolve (including the `summaryEnabled` and `cleanEnabled` flags, their independence, and the `PI_BROWSE_SUMMARY_ENABLED` / `PI_BROWSE_CLEAN_ENABLED` env vars), reasoning-level validation, context-window truncation with token-budget reservation, and summary-prompt construction. Also covers the browser proxy config: value normalization (`host:port` -> `http://`, socks, off switches, invalid values), resolution precedence (file `browser.proxy` > top-level `proxy` > `PI_SEARCH_PROXY` > direct), and tolerance of a malformed file. No network calls - the model call itself lives in `index.ts` (via `ctx.modelRegistry.streamSimple()`) and is only exercised live.
- `tests/unit/tool-surface.test.ts` - asserts the agent-facing `visit_page` text across all four `summaryEnabled` * `cleanEnabled` combinations: a disabled feature is never mentioned (no parameter description, no guideline) while the base stays minimal and the description/snippet only grow as features are enabled. No site-specific extractor names (X/Twitter, Reddit, Amazon, Scholar) appear anywhere, and `stripDisabledArguments` removes exactly the disabled arguments without mutating the input.
- `tests/unit/google-links.test.ts` - covers Google redirect handling: `isGoogleRedirectUrl` (`/url` and `/goto` on any google host, nothing else), `findGoogleRedirectUrls` (dedupe, order, non-redirect links ignored), `replaceGoogleRedirects` (mapped URLs swapped, unresolved ones kept), and the CDP-driven `resolveGoogleRedirectsInBrowser` against a fake CDP - redirect hops mapped from `Network.requestWillBeSent` events, `Location`-header preference, no-op when there is nothing to resolve, timeout keeping the original `/goto` link, and a failed trigger leaving the markdown untouched. No browser, no network.
- `tests/unit/image-search.test.ts` - covers Google Images: `clampImageCount` (default, floors, clamps, non-numbers) and the generated extractor (`getGoogleImageSearchJs`) - it parses as JavaScript, embeds the clamped count, keeps the DOM contract it depends on (data-lpage tiles, the preview image selector, gstatic detection, the `(google-cached)` marker, and both the image and page URL lines), and bounds its own runtime against the CDP timeout. No browser, no network.
- `tests/unit/reverse-image.test.ts` - covers `google_search_by_image`'s pure parts: path resolution (absolute, cwd-relative, `~`), image signature sniffing (PNG/JPEG/GIF/WebP/BMP and rejections), `readImageFile` (missing/empty/non-file/non-image errors), the 20 MB limit, the exact/visual mode helpers, and the generated extractor for both modes (parses, differs per mode, keeps the Lens/web/grid card selectors, caps results, emits absolute page links for the redirect resolver). No browser, no network.
- `tests/unit/wall.test.ts` - table-driven tests for `classifyWall`, the pure function behind wall detection: a bot-check interstitial served with 200 (Fastly "Client Challenge", Cloudflare "Just a moment..."), a CAPTCHA gate, a login form, a JavaScript shell ("Loading..."), and the negative cases that must stay content (a long article mentioning "Access Denied", a contact page with a reCAPTCHA, a page that merely embeds a Turnstile widget, an image-only gallery, an image URL with no scripts, a short static page).

### Type-checking

```bash
pnpm run typecheck
```

Uses `tsc --strict` and covers `index.ts`, `src/`, and `tests/`. The host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are declared in both `peerDependencies` (what Pi supplies at runtime) and `devDependencies` (so `tsc` resolves them locally). Pi loads extensions through jiti, which strips types without checking them - so the typecheck is the only place stale Pi APIs surface. It is expected to be clean.
