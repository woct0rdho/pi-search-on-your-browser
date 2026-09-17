/**
 * Google search-result redirect resolution.
 *
 * Google rewrites some result links to `https://www.google.com/goto?url=<opaque>`
 * — a Tink-encrypted protobuf that cannot be decoded offline (no encoder key,
 * no plaintext URL inside). The classic `google.com/url?q=<target>` wrapper
 * still appears for signed-out users and is unwrapped for free by the
 * extractor JS; `/goto` links are kept as-is so they can be resolved here.
 *
 * The one reliable way to reveal a `/goto` target is to ask Google: the
 * endpoint answers HTTP 302 with the destination in the `Location` header
 * (verified). The request must go through the same Chrome as the search (the
 * extension's Chrome has the configured proxy and cookies), so the links are
 * fetched *inside the open SERP tab* — JavaScript gets only an opaque response
 * and cannot read the redirect, but the CDP client observes the network. Each
 * fetch follows the 302 (`redirect: "follow"`); the follow-up request event
 * carries the previous hop in `redirectResponse` (a `Network.Response`, whose
 * `url` is the wrapper) and the direct destination in `request.url`. Chrome
 * does not emit `responseReceived` for a manual redirect, which is why the
 * chain has to be walked for real. The destination downloads are aborted once
 * the chain has been observed.
 *
 * Resolution is best-effort: links whose Location is not captured within the
 * timeout are left as the original `/goto` URL (still visitable — Chrome
 * follows the 302), never dropped.
 *
 * This module is free of `@earendil-works/*` imports so it type-checks under
 * the src/-scoped tsconfig; chrome.ts passes its CDP client in structurally.
 */

/** Matches the Google host of a redirect wrapper (www.google.com, google.es, ...). */
const GOOGLE_HOST_RE = /(^|\.)google\./;
/** Matches the redirect endpoint paths: /url and /goto (with optional trailing slash). */
const GOOGLE_REDIRECT_PATH_RE = /^\/(url|goto)\/?$/;

/** True when `raw` is a Google redirect wrapper (`/url?...` or `/goto?...`). */
export function isGoogleRedirectUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return GOOGLE_HOST_RE.test(u.hostname) && GOOGLE_REDIRECT_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/** Markdown links as emitted by the extractor: `[text](https://...)`. */
const MARKDOWN_LINK_RE = /\]\((https?:\/\/[^()\s]+)\)/g;

/** Unique Google redirect URLs referenced by markdown links, in first-seen order. */
export function findGoogleRedirectUrls(markdown: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    const url = match[1];
    if (seen.has(url) || !isGoogleRedirectUrl(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Replace markdown link URLs that have a resolved destination. Unmapped URLs
 *  are left untouched. */
export function replaceGoogleRedirects(
  markdown: string,
  resolved: ReadonlyMap<string, string>,
): string {
  if (resolved.size === 0) return markdown;
  return markdown.replace(MARKDOWN_LINK_RE, (full, url: string) => {
    const target = resolved.get(url);
    return target ? `](${target})` : full;
  });
}

/** The subset of the CDP client this module needs (chrome.ts's CDPClient fits). */
export interface GoogleRedirectCdp {
  evaluate(expression: string): Promise<string>;
  onEvent(method: string, handler: (params: unknown) => void): void;
}

export interface ResolveGoogleRedirectsOptions {
  onStatus?: (msg: string) => void;
  /** How long to wait for the Location headers. Default 8000ms. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 100ms. */
  pollMs?: number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Case-insensitive header lookup (CDP returns HTTP/1.1 casing over HTTP/2 lowercase). */
function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Resolve every Google redirect link in `markdown` through the page the CDP
 * client is attached to, returning markdown with direct URLs where possible.
 * Best-effort: unresolved links keep their original redirect URL.
 */
export async function resolveGoogleRedirectsInBrowser(
  cdp: GoogleRedirectCdp,
  markdown: string,
  options: ResolveGoogleRedirectsOptions = {},
): Promise<string> {
  const redirects = findGoogleRedirectUrls(markdown);
  if (redirects.length === 0) return markdown;

  const { onStatus, timeoutMs = 8000, pollMs = 100, sleep = defaultSleep } = options;
  const pending = new Set(redirects);
  const resolved = new Map<string, string>();

  // Chrome follows the 302; the follow-up request carries the previous hop in
  // `redirectResponse` (whose `url` is the redirect wrapper) and the direct
  // destination in `request.url`. Manual redirects are invisible here — Chrome
  // delivers them to the renderer as opaque responses with no
  // `responseReceived` event — so the chain has to be walked for real.
  cdp.onEvent("Network.requestWillBeSent", (params) => {
    const p = params as {
      request?: { url?: string };
      redirectResponse?: { url?: string; headers?: Record<string, unknown> };
    };
    const from = p.redirectResponse?.url;
    if (!from || !pending.has(from)) return;
    const location = headerValue(p.redirectResponse?.headers, "location");
    const to = location || p.request?.url;
    if (!to) return;
    let target: string;
    try {
      target = new URL(to, from).href;
    } catch {
      return;
    }
    if (!/^https?:/i.test(target)) return;
    resolved.set(from, target);
    pending.delete(from);
  });

  onStatus?.(
    `Resolving ${redirects.length} Google redirect link${redirects.length === 1 ? "" : "s"}...`,
  );

  // Fire the requests inside the SERP tab: same origin, same cookies, same
  // proxy as the search. `redirect: "follow"` makes Chrome walk the redirect
  // chain so the network events reveal the destination; `mode: "no-cors"`
  // keeps the (cross-origin) response opaque so the fetch cannot fail on CORS.
  // The destination downloads are aborted once the chains have been observed.
  const script =
    "(() => {" +
    `const urls=${JSON.stringify(redirects)};` +
    "window.__piRedirectAborts=[];" +
    "for(const u of urls){try{const ac=new AbortController();window.__piRedirectAborts.push(ac);" +
    "fetch(u,{redirect:'follow',mode:'no-cors',credentials:'include',signal:ac.signal}).catch(()=>{});}catch{}}" +
    "return urls.length;" +
    "})()";

  try {
    await cdp.evaluate(script);
  } catch {
    // Best-effort: a failed trigger (page gone, CSP) leaves the links unresolved.
    return markdown;
  }

  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(pollMs);
  }

  // Stop the destination downloads we no longer need (the tab closes anyway).
  try {
    await cdp.evaluate(
      "(() => {const a=window.__piRedirectAborts||[];for(const c of a)try{c.abort();}catch{}delete window.__piRedirectAborts;return a.length;})()",
    );
  } catch {
    // best effort
  }

  if (pending.size > 0) {
    onStatus?.(
      `${pending.size} Google redirect link${pending.size === 1 ? "" : "s"} could not be resolved`,
    );
  }

  return replaceGoogleRedirects(markdown, resolved);
}
