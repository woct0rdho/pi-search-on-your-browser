// Chrome DevTools Protocol (CDP) client - Node.js built-in WebSocket.
//
// Same approach as ds4-agent (@antirez): visible Chrome (not headless),
// CDP WebSocket navigation, inline JavaScript extractors in the page.
//
// Reference: https://x.com/antirez/status/2066233392916525379
//
// Profile at ~/.pi-search-browser/ - dedicated, like ds4-agent's ~/.ds4/browser.
// Cookies and sessions persist across calls.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { resolveConfig } from "./subagent.ts";
import { resolveGoogleRedirectsInBrowser } from "./google-links.ts";

import {
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  getGoogleImageSearchJs,
  clampImageCount,
  getReverseImageSearchJs,
  isReverseImageMode,
  REVERSE_IMAGE_MODES,
  type ReverseImageMode,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
  getDefuddleBundle,
  isXUrl,
  isRedditPostUrl,
  isAmazonProductUrl,
  isAmazonSearchUrl,
  isScholarSearchUrl,
  WALL_PROBE_JS,
  classifyWall,
  type WallKind,
  type WallState,
  WIDGET_RECTS_JS,
  looksNavOnly,
  markdownProseLength,
  downloadFetchJs,
} from "./extractors.ts";

const PROFILE_DIR = join(homedir(), ".pi-search-browser");
const CDP_PORT = 9322;
const CDP_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 1_048_576; // 1 MB

// Timeout for the small HTTP calls to Chrome's DevTools endpoint
// (/json/version, /json/close). They answer instantly while Chrome is alive.
// Without a timeout a wedged browser would hang the tool forever.
const CDP_HTTP_TIMEOUT_MS = 3_000;

// `Page.navigate` normally answers in milliseconds, but it is dispatched
// through the browser process and can stall for tens of seconds when the
// browser is busy: several parallel tool tabs loading heavy pages at once, a
// proxy re-establishing its tunnels, or a background renderer that is still
// starting up. A single stall used to fail the whole tool call with "CDP call
// timeout: Page.navigate" (observed for real: two parallel GitHub visits
// through a slow proxy, one navigation took >30s). The command is idempotent
// for a fixed URL, so a timed-out attempt is retried.
export const NAVIGATE_TIMEOUT_MS = 15_000;
export const NAVIGATE_ATTEMPTS = 3;

// Default wait for a bot-check interstitial to solve itself. These pages
// answer the first request with 403/503 (Cloudflare marks it
// `cf-mitigated: challenge`), run their challenge in the page and reload to
// the real document a few seconds later. Measured on a fresh profile through
// a proxy: 403 at ~3.2s, self-reload to 200 at ~7.6s. An ordinary browser
// never surfaces that first response - it only shows the final page.
export const INTERSTITIAL_WAIT_MS = 30_000;
// After `Page.reload` on a non-challenge 403/503 (the F5 move), how long to
// wait for the retried document response before giving up.
export const INTERSTITIAL_RELOAD_WAIT_MS = 8_000;
const INTERSTITIAL_POLL_MS = 300;

// Text bot-check interstitials render in their title/body. Covers Cloudflare,
// DataDome, PerimeterX/HUMAN ("Access to this page has been denied"), Akamai,
// Imperva ("Request unsuccessful...") and generic "verify you are human"
// pages. Deliberately specific: a bare "Access Denied" auth page must not be
// mistaken for a solvable challenge.
export const CHALLENGE_PAGE_RE =
  /just a moment|attention required|checking (?:your browser|if the site)|verify (?:you are|you're|that you are) (?:a )?human|are you a robot|access to this page has been denied|request unsuccessful|enable javascript and cookies|ddos protection|under attack|incapsula|datadome|perimeterx|please wait while we (?:verify|check)/i;

// How long a wall (challenge page, JavaScript shell) gets to render itself
// after the tab is activated. Measured through the proxy: pypi.org's Fastly
// challenge renders at ~6s, lensisku.lojban.org's SPA at ~4s, Cloudflare's
// "Just a moment..." at ~10s. An interactive Turnstile checkbox needs the
// click below.
export const WALL_WAIT_MS = 30_000;
const WALL_POLL_MS = 500;
// A challenge that has not cleared by then gets one reload - Cloudflare's
// script occasionally stalls waiting for a fresh document.
const CHALLENGE_RELOAD_AFTER_MS = 12_000;
// Poll interval of the challenge wait.
const CHALLENGE_POLL_MS = 400;

// Probe evaluated on a 403/503 to tell a solvable interstitial from a plain
// denial. Cheap (title + first 400 chars of visible text).
const CHALLENGE_PROBE_JS = `(document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 400) : "")`;

// Utilities

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Progress callback for the tool UI (Rendered inside the tool call block by
// `onUpdate`, so it never disturbs the input line).
type StatusFn = (msg: string) => void;

// Diagnostics go to stderr only when PI_SEARCH_DEBUG is set. Pi's TUI runs in
// raw mode and prints raw stderr writes on the input bar, so anything logged
// unconditionally shows up as `[pi-search] ...` noise while typing. Messages
// the user should actually see go through the tool's status callback instead
// (see StatusFn). Everything else is available with PI_SEARCH_DEBUG=1.
function debugLog(message: string): void {
  if (process.env.PI_SEARCH_DEBUG) console.error(`[pi-search] ${message}`);
}

// Case-insensitive environment lookup joined with path segments.
// Windows env var names are not consistently cased in `process.env`
// ("ProgramFiles(x86)", "PROGRAMFILES", ...), so look the name up
// case-insensitively rather than guessing the exact casing.
function envPath(name: string, ...segments: string[]): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() !== wanted) continue;
    const base = process.env[key];
    if (base) return join(base, ...segments);
  }
  return undefined;
}

// Candidate browser executables, most-preferred first. `CHROME_PATH` always
// wins. Then the platform's default install locations. Edge is last on
// Windows - it is Chromium-based and accepts the same CDP flags, so it
// works as a fallback when Google Chrome is not installed.
export function chromeCandidates(): string[] {
  return [
    process.env.CHROME_PATH,
    // Windows - Google Chrome (per-user then machine-wide installs)
    envPath("LOCALAPPDATA", "Google", "Chrome", "Application", "chrome.exe"),
    envPath("PROGRAMFILES", "Google", "Chrome", "Application", "chrome.exe"),
    envPath("ProgramFiles(x86)", "Google", "Chrome", "Application", "chrome.exe"),
    // Windows - Chromium
    envPath("LOCALAPPDATA", "Chromium", "Application", "chrome.exe"),
    envPath("PROGRAMFILES", "Chromium", "Application", "chrome.exe"),
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    // Windows - Microsoft Edge (Chromium-based, same CDP flags)
    envPath("PROGRAMFILES", "Microsoft", "Edge", "Application", "msedge.exe"),
    envPath("ProgramFiles(x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    envPath("LOCALAPPDATA", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((p): p is string => Boolean(p));
}

// First candidate that exists on disk, else a bare command name that spawn()
// resolves through PATH (the binary may be installed somewhere non-standard
// on Linux). launchChrome() turns a PATH-resolution failure into a readable
// error instead of an uncaughtException.
export function findChrome(): string {
  for (const p of chromeCandidates()) {
    if (existsSync(p)) return p;
  }
  return process.platform === "win32" ? "chrome.exe" : "google-chrome";
}

// CDP over WebSocket

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// Minimal CDP interface used by runInPageSession. CDPClient implements this.
// Tests pass a fake so the navigate/waitForSelector/extract logic can be
// exercised without a real browser or WebSocket.
interface CDPLike {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  evaluate(expression: string): Promise<string>;
  onEvent(method: string, handler: (params: unknown) => void): void;
  disconnect(): void;
}

class CDPClient implements CDPLike {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private connectPromise: Promise<void> | null = null;
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();

  async connect(wsUrl: string): Promise<void> {
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connect timeout`));
      }, CDP_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      // The socket can die at any time (Chrome killed, tab/target crashed, a
      // restart). Reject the in-flight calls immediately so callers get a real
      // error instead of waiting out the full per-call timeout - otherwise a
      // dead target turns into a misleading "CDP call timeout" 30s later.
      ws.onclose = () => {
        clearTimeout(timer);
        this.failPending("CDP connection closed");
      };

      ws.onmessage = (event) => {
        let msg: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        // Events (no id field) - dispatch to handlers
        if (msg.id === undefined || msg.id === null) {
          if (msg.method) {
            const handlers = this.eventHandlers.get(msg.method);
            if (handlers) {
              for (const h of handlers) h(msg.params);
            }
          }
          return;
        }
        const cb = this.pending.get(msg.id);
        if (!cb) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          cb.reject(new Error(`CDP error: ${msg.error.message || JSON.stringify(msg.error)}`));
        } else {
          cb.resolve(msg.result);
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.failPending("CDP connection error");
        } else {
          reject(new Error("WebSocket connection error"));
        }
      };
    });
    await this.connectPromise;
  }

  // Reject every in-flight call (used when the socket dies).
  private failPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const cb of pending) cb.reject(new Error(reason));
  }

  onEvent(method: string, handler: (params: unknown) => void) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = CDP_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws!.send(msg);
    });
  }

  async evaluate(expression: string): Promise<string> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const r = result as { result?: { value?: unknown; description?: string } };
    if (r.result?.value !== undefined) return String(r.result.value);
    return r.result?.description ?? "";
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Chrome process management

let chromeProcess: ChildProcess | null = null;
// Serializes Chrome start/restart decisions across parallel tool calls (see
// withChromeLifecycle).
let chromeLifecycle: Promise<unknown> = Promise.resolve();
// Args of the Chrome started by this process (null when the live Chrome was
// started elsewhere - an earlier Pi session using the same profile).
let launchedArgs: string[] | null = null;
// False once writing the launch marker has failed. Disables restart-on-stale
// logic (no marker means we would restart Chrome on every call).
let canPersistLaunchArgs = true;

async function isChromeAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Command-line flags used to launch the visible Chrome instance. Exported
// so the presence of individual flags (e.g. the backgrounding/occlusion
// flags that keep the renderer alive in background tabs/windows) can be
// asserted by unit tests without spawning a real Chrome.
export const CHROME_LAUNCH_ARGS: readonly string[] = [
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${PROFILE_DIR}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--password-store=basic",
  "--mute-audio",
  // Keep non-active tabs rendering at full speed. Tool tabs are opened in
  // the background (Target.createTarget { background: true }) to avoid
  // stealing focus, but Chrome otherwise suspends the renderer of background
  // tabs - which makes window.scrollTo()/scrollBy() a no-op for triggering
  // lazy-loaded content (infinite scroll, lazy images, GitHub's deferred
  // sections). The async self-scrolling extractors (X/Reddit/Amazon) hit the
  // same wall. These flags keep the renderer alive so scrolling works even
  // when the tab isn't active. The bringToFront option (below) handles the
  // remaining visibility-dependent cases.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  // Chrome's native window-occlusion detection (CalculateNativeWinOcclusion)
  // can fully freeze the renderer when the Chrome window is behind another
  // window or unfocused - even with the three flags above. This shows up as
  // a full 30s Runtime.evaluate timeout (the renderer stops responding to
  // CDP entirely), not just missed lazy loads. It is especially severe on
  // GNOME Wayland, where we cannot programmatically focus/activate the
  // Chrome window (xdotool/wmctrl are X11-only, and GNOME Shell's D-Bus
  // window APIs are access-denied). Disabling the feature keeps the renderer
  // alive regardless of window visibility/focus, so scrolling + extraction
  // work with Chrome in the background. Without this flag, visit_page on
  // lazy-load pages (e.g. github.com) hangs unless the user manually focuses
  // the Chrome window first.
  //
  // The HTTPS flags keep plain-HTTP pages reachable. Chrome upgrades an
  // `http://` navigation to `https://`. On the many niche/legacy sites that
  // have no HTTPS endpoint the upgrade fails and the tab lands on
  // `chrome-error://chromewebdata/` instead of the page (this is exactly what
  // happened to blog.esuteru.com, vippers.jp, blog.livedoor.jp in testing,
  // although all three serve fine over HTTP). We are a local browsing tool,
  // not a security product: no automatic HTTPS upgrades, no HTTPS-only mode.
  "--disable-features=CalculateNativeWinOcclusion,HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedMode,HttpsFirstModeIncognito",
  "about:blank",
];

// Full launch arguments: the base flags above plus anything the configuration
// demands (currently only the proxy). Exported so tests can assert the proxy
// flag without spawning a real Chrome.
//
// The proxy comes from `browser.proxy` in
// <agent-dir>/search-on-your-browser.json, or the PI_SEARCH_PROXY env var
// (e.g. "http://127.0.0.1:8010", "socks5://127.0.0.1:1080"). Chrome applies
// it to every request, including the CDP-driven navigations, so google_search
// and visit_page work behind a required proxy. The value is read fresh on each
// call so a config change is picked up without restarting Pi.
export function chromeLaunchArgs(proxy: string = resolveConfig().proxy): string[] {
  const args = [...CHROME_LAUNCH_ARGS];
  if (proxy) {
    // Must come before the trailing URL argument (Chrome treats the last
    // non-flag argument as the URL to open).
    args.splice(args.length - 1, 0, `--proxy-server=${proxy}`);
  }
  return args;
}

// File inside the dedicated profile recording the flags the *currently
// running* Chrome was started with. The profile directory outlives a Pi
// session, so without this we cannot tell whether an already-open Chrome is
// stale (e.g. launched before a proxy was configured) - it would silently keep
// using the old flags. Read/written best-effort.
const LAUNCH_MARKER_FILE = join(PROFILE_DIR, ".pi-launch-args.json");

// Launch args recorded for the running Chrome, or null if unknown.
export function readLaunchMarker(): string[] | null {
  try {
    if (!existsSync(LAUNCH_MARKER_FILE)) return null;
    const raw = JSON.parse(readFileSync(LAUNCH_MARKER_FILE, "utf-8")) as { args?: unknown };
    if (!Array.isArray(raw.args)) return null;
    if (!raw.args.every((a) => typeof a === "string")) return null;
    return raw.args as string[];
  } catch {
    return null;
  }
}

// Record the launch args. Returns false when the marker can't be written.
export function writeLaunchMarker(args: readonly string[]): boolean {
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(LAUNCH_MARKER_FILE, JSON.stringify({ args }, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// Same flags in any order (Chrome only cares about the set).
function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((arg) => set.has(arg));
}

// Actionable message for a spawn failure (ENOENT/EACCES): says which binary
// was attempted and how to point the tool at the right one.
export function chromeSpawnErrorMessage(chromePath: string, err: Error): string {
  return (
    `Could not launch browser "${chromePath}": ${err.message}. ` +
    `Install Google Chrome, or set CHROME_PATH to the browser executable ` +
    `(e.g. CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").`
  );
}

async function launchChrome(args: readonly string[], status: StatusFn): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const chromePath = findChrome();

  debugLog(`Launching visible Chrome at ${chromePath}`);
  const proxyFlag = args.find((a) => a.startsWith("--proxy-server="));
  if (proxyFlag) debugLog(proxyFlag);

  status("Launching Chrome...");

  const child = spawn(chromePath, [...args], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  chromeProcess = child;

  // spawn() failure (ENOENT/EACCES) arrives asynchronously as an 'error'
  // event. With no listener attached, Node re-throws it as an
  // uncaughtException - which kills the whole Pi process ("pi exiting due to
  // uncaughtException: Error: spawn google-chrome ENOENT"). Capture it here
  // and turn it into a normal rejected promise instead.
  const spawnState: { error: Error | null } = { error: null };
  child.on("error", (err) => {
    spawnState.error = err;
    chromeProcess = null;
  });

  child.on("exit", (code) => {
    debugLog(`Chrome exited with code ${code}`);
    chromeProcess = null;
    launchedArgs = null;
  });

  // Wait for CDP to become available
  for (let i = 0; i < 60; i++) {
    if (spawnState.error) {
      throw new Error(chromeSpawnErrorMessage(chromePath, spawnState.error));
    }
    if (await isChromeAlive()) {
      launchedArgs = [...args];
      canPersistLaunchArgs = writeLaunchMarker(args);
      debugLog("Chrome is ready");
      return;
    }
    await sleep(500);
  }
  throw new Error(`Chrome did not become ready within 30s (launched from "${chromePath}")`);
}

async function ensureChrome(status: StatusFn): Promise<void> {
  return withChromeLifecycle(async () => {
    const desired = chromeLaunchArgs();

    if (await isChromeAlive()) {
      // What were the running Chrome's flags? Our own record wins. Otherwise
      // the marker file left by the process that launched it.
      const current = launchedArgs ?? readLaunchMarker();
      if (current && sameArgs(current, desired)) return;

      // Unknown flags (Chrome started by an older version, before the marker
      // existed). Restart it once so the current flags - including a proxy -
      // are actually applied and recorded. If the marker can't be written we'd
      // restart on every single call, so leave it alone instead.
      if (current === null && !canPersistLaunchArgs) return;

      debugLog(
        current
          ? "Chrome launch flags changed - restarting Chrome"
          : "Restarting Chrome to align its launch flags"
      );
      status(current ? "Restarting Chrome to apply updated launch flags..." : "Restarting Chrome...");
      await stopChrome();
    } else if (chromeProcess) {
      chromeProcess.kill();
      chromeProcess = null;
      await sleep(500);
    }

    await launchChrome(desired, status);
  });
}

// Run a Chrome lifecycle operation (ensure/start/restart/stop) under a lock.
//
// The agent often issues several google_search / visit_page calls in one turn,
// and every call calls ensureChrome() first. Without serialization two calls
// could (a) spawn two Chrome processes on a cold start, or (b) both detect the
// same stale launch flags and each restart Chrome - the second killing the
// browser the first one had already opened and navigated a tab in, which shows
// up as a random "CDP call timeout" / connection error on the surviving call.
function withChromeLifecycle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chromeLifecycle.then(fn, fn);
  // Keep the chain alive regardless of this operation's outcome. The caller
  // still observes the rejection through the returned promise.
  chromeLifecycle = run.catch(() => undefined);
  return run;
}

// Stop the running Chrome (ours: signal it. Started by another Pi session:
// ask it to close over CDP) and wait for the debugging port to go away.
async function stopChrome(): Promise<void> {
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  } else {
    try {
      const browserCdp = new CDPClient();
      await browserCdp.connect(await getBrowserWSUrl());
      await browserCdp.call("Browser.close");
      browserCdp.disconnect();
    } catch {
      // best effort - it may already be gone
    }
  }
  launchedArgs = null;

  for (let i = 0; i < 20; i++) {
    if (!(await isChromeAlive())) return;
    await sleep(250);
  }
  debugLog("Chrome did not exit within 5s - continuing anyway");
}

// Page operations

interface CDPTab {
  wsUrl: string;
  targetId: string;
}

async function getBrowserWSUrl(): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
    signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
  });
  const data = (await resp.json()) as { webSocketDebuggerUrl: string };
  return data.webSocketDebuggerUrl;
}

async function openTab(): Promise<CDPTab> {
  const browserUrl = await getBrowserWSUrl();
  const browserCdp = new CDPClient();
  await browserCdp.connect(browserUrl);

  const result = (await browserCdp.call("Target.createTarget", {
    url: "about:blank",
    background: true,
    newWindow: false,
  })) as { targetId: string };

  browserCdp.disconnect();

  const wsUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${result.targetId}`;
  return { wsUrl, targetId: result.targetId };
}

async function closeTab(targetId: string): Promise<void> {
  try {
    await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/close/${encodeURIComponent(targetId)}`,
      { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) }
    );
  } catch {
    // best effort
  }
}

interface RunInPageOptions {
  url: string;
  js: string;
  clickConsent?: boolean;
  dynamicScroll?: boolean;
  scrollCount?: number;
  scrollDelayMs?: number;
  initialWaitMs?: number;
  waitForSelector?: string;
  waitForTimeoutMs?: number;
  // Poll interval for waitForSelector (ms). Default 400.
  waitForSelectorPollMs?: number;
  // How long to wait for a bot-check interstitial (403/503) to clear itself.
  // 0 disables the interstitial handling entirely (used by tests that pin the
  // plain HTTP-error path). Default INTERSTITIAL_WAIT_MS.
  interstitialWaitMs?: number;
  // How long to wait for the response to a `Page.reload` retry on a
  // non-challenge 403/503. Default INTERSTITIAL_RELOAD_WAIT_MS.
  interstitialReloadWaitMs?: number;
  // Optional fallback JS to run in the SAME tab if the primary `js` returns
  // an error marker or very short content. Avoids a second navigation when
  // the primary extractor (e.g. Defuddle) fails on a page.
  fallbackJs?: string;
  // When true, call CDP `Page.bringToFront` after navigation so the tab
  // becomes the active tab and Chrome resumes its renderer. Needed for any
  // path that scrolls - `dynamicScroll` (generic pages) or the async
  // self-scrolling extractors (X/Reddit/Amazon) - because background tabs
  // don't paint and scroll-triggered lazy loading never fires without it.
  // Default false so non-scrolling pages (Google search, Scholar, Defuddle)
  // don't steal focus.
  bringToFront?: boolean;
  // When true, resolve Google `/goto` redirect links in the open tab before
  // returning the markdown (see src/google-links.ts). Used by googleSearch.
  // Requires the CDP client to receive `Network.responseReceived` events
  // (Network.enable is already called by this session).
  resolveGoogleRedirects?: boolean;
  // When true, extract once right after the page settles and once after the
  // waits/scrolling, returning the second only if the page is still there.
  // Ad/anti-bot scripts that navigate the tab away a few seconds after load
  // then cost nothing. Default false: the specialized extractors scroll
  // themselves and must run exactly once.
  safetyExtract?: boolean;
  // When true, proceed as soon as the document has text instead of waiting for
  // the load event - ad frames and analytics frequently keep that event from
  // firing for the full timeout while the text has been rendered for seconds.
  // Used by visit_page's generic extraction. The specialized extractors wait
  // for their own selectors instead.
  contentFirst?: boolean;
  // When true, re-probe the live page once after extraction: a gate can
  // replace the document after the settle probe and be handed back as content
  // (a check page that paints late). Also retries a nav-only result, which is
  // how snapshots and slow SPAs fail. Off for Google/Scholar searches, which
  // have their own result shapes.
  wallRecheck?: boolean;
  // How long a detected wall (bot-check interstitial, JavaScript app shell)
  // gets to render itself after the tab is activated. 0 disables the wait
  // (tests). Default WALL_WAIT_MS.
  wallWaitMs?: number;
  onStatus: (msg: string) => void;
}

// Issue `Page.navigate`, retrying when the command itself times out.
//
// Two things make this more than a plain await:
//  - The page may finish loading while the command's reply is still stuck in
//    the browser - exactly what a slow proxy or a saturated network looks
//    like. The load event wins the race, so the call proceeds normally.
//  - A timeout is retried (up to NAVIGATE_ATTEMPTS). Errors that are not
//    timeouts - a closed CDP socket, a rejected command - are fatal and are
//    re-thrown immediately: retrying on a dead connection is pointless.
async function navigateToPage(
  cdp: CDPLike,
  url: string,
  pageLoaded: Promise<void>,
  onStatus: StatusFn,
): Promise<{ isDownload: boolean }> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= NAVIGATE_ATTEMPTS; attempt++) {
    let navigateResult: { isDownload?: boolean } | undefined;
    const outcome = cdp.call("Page.navigate", { url }, NAVIGATE_TIMEOUT_MS).then(
      (res) => {
        navigateResult = res as { isDownload?: boolean };
        return "done" as const;
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!/timeout/i.test(e.message)) throw e;
        lastError = e;
        return "timeout" as const;
      },
    );
    // If we walk away because the page already loaded, a later rejection of
    // this promise must not surface as an unhandled rejection.
    outcome.catch(() => {});

    const winner = await Promise.race([outcome, pageLoaded.then(() => "loaded" as const)]);
    if (winner !== "timeout") {
      // A `Content-Disposition: attachment` response turns the navigation into
      // a download: Chrome never commits a document, the tab stays on
      // about:blank and the load event never fires. Page.navigate reports it.
      return { isDownload: Boolean(navigateResult?.isDownload) };
    }

    if (attempt < NAVIGATE_ATTEMPTS) {
      onStatus(`Navigation is slow - retrying (${attempt + 1}/${NAVIGATE_ATTEMPTS})...`);
      await sleep(500);
    }
  }

  throw new Error(
    `${lastError?.message ?? "CDP call timeout: Page.navigate"} ` +
      `(after ${NAVIGATE_ATTEMPTS} attempts of ${NAVIGATE_TIMEOUT_MS / 1000}s - the page or the proxy may be slow)`,
  );
}

// True when the committed 403/503 page is a solvable bot-check interstitial
// (Cloudflare, DataDome, ...) rather than a plain denial.
async function looksLikeChallengePage(cdp: CDPLike): Promise<boolean> {
  try {
    const probe = await cdp.evaluate(CHALLENGE_PROBE_JS);
    return CHALLENGE_PAGE_RE.test(probe);
  } catch {
    return false;
  }
}

interface WallInfo {
  kind: WallKind;
  // Short, human-readable thing that was on the page ("Client Challenge").
  detail: string;
}

// Read the page state once and decide whether it is a wall (challenge page,
// CAPTCHA, login form, JavaScript shell) instead of content.
async function probeWall(cdp: CDPLike): Promise<WallInfo | null> {
  let state: WallState | undefined;
  try {
    state = parseWallState(String(await cdp.evaluate(WALL_PROBE_JS)));
  } catch {
    return null;
  }
  if (!state) return null;
  const kind = classifyWall(state);
  if (!kind) return null;
  // A challenge names itself in the title ("Client Challenge"). A login form or
  // a shell says more in its text ("Sign in to continue", "Loading...").
  const preferText = kind === "login" || kind === "shell";
  const raw = preferText ? state.head || state.title : state.title.length > 2 ? state.title : state.head;
  const seen = raw.replace(/\s+/g, " ").trim();
  return { kind, detail: `"${seen.slice(0, 120)}"` };
}

// Parse the JSON returned by WALL_PROBE_JS. Returns undefined for anything
// unexpected so a broken probe never blocks a visit.
function parseWallState(raw: string): WallState | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<WallState> & { error?: string };
    if (parsed.error || typeof parsed.len !== "number" || typeof parsed.scripts !== "number") {
      return undefined;
    }
    return {
      href: String(parsed.href ?? ""),
      title: String(parsed.title ?? ""),
      len: Number(parsed.len),
      head: String(parsed.head ?? ""),
      captcha: Boolean(parsed.captcha),
      password: Boolean(parsed.password),
      scripts: Number(parsed.scripts),
      images: Number(parsed.images ?? 0),
      gate: typeof parsed.gate === "string" ? parsed.gate : "",
    };
  } catch {
    return undefined;
  }
}

// Bot-check widgets (Turnstile, reCAPTCHA, hCaptcha, ...)
//
// Mostly the challenge scripts solve themselves and only need a visible tab and
// a few seconds. When the site escalates to the interactive variant ("Verify
// you are human" checkbox), a human gesture is required - a click at the right
// coordinates. The widget usually lives in a cross-origin iframe inside a
// closed shadow root, so it cannot be reached from page JavaScript. CDP's DOM
// domain can see through both, and Input events land wherever the coordinates
// point regardless of origins.

const WIDGET_SRC_RE =
  /challenge|turnstile|recaptcha|hcaptcha|captcha|datadome|px-captcha|perimeterx|imperva/i;

interface WidgetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DomNodeLike {
  nodeName?: string;
  nodeId?: number;
  attributes?: string[];
  children?: DomNodeLike[];
  shadowRoots?: DomNodeLike[];
  contentDocument?: DomNodeLike;
}

// Collect iframe/frame node ids whose src/title look like a bot-check widget,
// walking shadow roots (including closed ones) and frame documents.
function collectWidgetNodes(root: DomNodeLike | undefined, out: number[]): void {
  if (!root || out.length >= 8) return;
  if ((root.nodeName === "IFRAME" || root.nodeName === "FRAME") && typeof root.nodeId === "number") {
    const attrs = root.attributes ?? [];
    let text = "";
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "src" || attrs[i] === "title") text += `${attrs[i + 1]} `;
    }
    if (WIDGET_SRC_RE.test(text)) out.push(root.nodeId);
  }
  for (const child of root.children ?? []) collectWidgetNodes(child, out);
  for (const shadow of root.shadowRoots ?? []) collectWidgetNodes(shadow, out);
  if (root.contentDocument) collectWidgetNodes(root.contentDocument, out);
}

// Prefer the largest on-screen widget: challenge pages often carry an
// off-screen duplicate that must not be clicked.
function pickWidget(boxes: WidgetBox[]): WidgetBox | null {
  const usable = boxes.filter(
    (b) => b.w >= 40 && b.h >= 18 && b.x > -1 && b.y > -1 && b.x < 5000 && b.y < 5000,
  );
  usable.sort((a, b) => b.w * b.h - a.w * a.h);
  return usable[0] ?? null;
}

async function findChallengeWidget(cdp: CDPLike): Promise<WidgetBox | null> {
  // Light DOM first: one cheap evaluation, covers widgets that are not inside a
  // shadow root.
  try {
    const raw = String(await cdp.evaluate(WIDGET_RECTS_JS));
    const frames = JSON.parse(raw) as Array<WidgetBox & { src?: string }>;
    const box = pickWidget(frames.filter((f) => WIDGET_SRC_RE.test(String(f.src ?? ""))));
    if (box) return box;
  } catch {
    // Fall through to the DOM domain.
  }
  // Shadow roots (Cloudflare wraps its iframe in one, usually closed).
  try {
    const doc = (await cdp.call("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: DomNodeLike;
    };
    const nodeIds: number[] = [];
    collectWidgetNodes(doc?.root, nodeIds);
    const boxes: WidgetBox[] = [];
    for (const nodeId of nodeIds) {
      const resolved = (await cdp.call("DOM.resolveNode", { nodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = resolved?.object?.objectId;
      if (!objectId) continue;
      const measured = (await cdp.call("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height,vis:s.visibility,disp:s.display});}",
        returnByValue: true,
      })) as { result?: { value?: string } };
      try {
        const box = JSON.parse(measured?.result?.value ?? "{}") as WidgetBox & {
          vis?: string;
          disp?: string;
        };
        if (box.vis !== "visible" || box.disp === "none") continue;
        boxes.push(box);
      } catch {
        // Skip unmeasurable nodes.
      }
    }
    return pickWidget(boxes);
  } catch {
    return null;
  }
}

async function dispatchClick(cdp: CDPLike, x: number, y: number): Promise<void> {
  const base = { x, y, button: "left" as const, clickCount: 1 };
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await sleep(80);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(60);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

// Click the challenge checkbox the way a user would. The first attempt targets
// the checkbox (left edge, vertically centred), the second the widget centre.
async function clickChallengeWidget(cdp: CDPLike, attempt: number): Promise<boolean> {
  const box = await findChallengeWidget(cdp);
  if (!box) return false;
  const x = attempt === 0 ? box.x + Math.min(28, box.w * 0.15) : box.x + box.w / 2;
  const y = box.y + box.h / 2;
  await dispatchClick(cdp, Math.round(x), Math.round(y));
  return true;
}

// Wait for a bot check to clear. Bot checks that only need JavaScript clear on
// their own once the tab is visible. The interactive variant needs one click.
// A challenge that has not moved after CHALLENGE_RELOAD_AFTER_MS gets a single
// reload. Returns false when nothing worked within `timeoutMs`.
async function waitForChallengeToClear(
  cdp: CDPLike,
  opts: {
    timeoutMs: number;
    isCleared: () => boolean | Promise<boolean>;
    onStatus: StatusFn;
    // Reload once after this long without progress. 0 disables it (a
    // JavaScript shell is already loading - a reload would restart it).
    reloadAfterMs?: number;
  },
): Promise<boolean> {
  const startedAt = Date.now();
  let finderRuns = 0;
  let reloaded = false;
  const reloadAfterMs = opts.reloadAfterMs ?? CHALLENGE_RELOAD_AFTER_MS;
  while (Date.now() - startedAt < opts.timeoutMs) {
    await sleep(CHALLENGE_POLL_MS);
    if (await opts.isCleared()) return true;
    const elapsed = Date.now() - startedAt;
    // A visible widget is the one case that needs a gesture. Give the challenge
    // script a moment to render the widget first, and look for it at most three
    // times (the DOM walk is not free).
    if (finderRuns < 3 && elapsed > 1_200) {
      const attempt = finderRuns++;
      if (await clickChallengeWidget(cdp, attempt)) {
        opts.onStatus(attempt === 0 ? "Clicking the bot check..." : "Clicking the bot check again...");
      }
    }
    if (!reloaded && reloadAfterMs > 0 && elapsed > reloadAfterMs) {
      opts.onStatus("Bot check is taking long - reloading once...");
      try {
        await cdp.call("Page.reload", { ignoreCache: false });
      } catch {
        // Non-fatal: the wait below decides.
      }
      reloaded = true;
    }
  }
  return false;
}

function blockedMarker(wall: WallInfo): string {
  return `__BLOCKED__: ${wall.kind}: ${wall.detail}`;
}

// The page the tab ended up on is not the one that was asked for. Only host and
// path count: http->https, `www.`, a trailing slash, query parameters and
// fragments are not worth reporting, but a different page shape is - t.me/s/
// <group> redirects to the group's join page and drops the message feed.
function redirectNoteFor(requested: string, final: string): string | null {
  try {
    const a = new URL(requested);
    const b = new URL(final);
    const host = (u: URL): string => u.hostname.toLowerCase().replace(/^www\./, "");
    const path = (u: URL): string => u.pathname.replace(/\/+$/, "");
    if (host(a) === host(b) && path(a) === path(b)) return null;
    return `> Redirected: ${requested} -> ${final}`;
  } catch {
    return null;
  }
}

const DOWNLOAD_TEXT_MAX = 200_000;

interface DownloadBody {
  status?: number;
  ct?: string;
  total?: number;
  truncated?: boolean;
  bad?: number;
  text?: string;
  decoded?: string;
  error?: string;
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

// Longest run of backticks in the body, so a code fence can be longer than any
// fence the file itself contains.
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

// A URL can answer with `Content-Disposition: attachment`, which Chrome turns
// into a download instead of a document - the tab stays on about:blank. The
// bytes are still reachable: fetch() ignores that header. Doing it from a page
// on the site's own origin keeps cookies, TLS and proxy in play and avoids
// CORS (about:blank has an opaque origin, so fetching from it would fail).
async function readDownload(cdp: CDPLike, url: string, onStatus: StatusFn): Promise<string> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return "__BLOCKED__: download: invalid URL";
  }
  onStatus("The URL is a file download - reading it through the browser...");
  const originLoaded = new Promise<void>((resolve) => {
    cdp.onEvent("Page.loadEventFired", () => resolve());
  });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, LOAD_WAIT_MS); });
  try {
    await cdp.call("Page.navigate", { url: `${origin}/` }, NAVIGATE_TIMEOUT_MS);
  } catch {
    return `__BLOCKED__: download: could not open ${origin} to read the file`;
  }
  await Promise.race([originLoaded, timeout]);
  clearTimeout(timer);

  let info: DownloadBody;
  try {
    info = JSON.parse(String(await cdp.evaluate(downloadFetchJs(url)))) as DownloadBody;
  } catch {
    return "__BLOCKED__: download: could not read the file";
  }
  if (info.error) {
    return `__BLOCKED__: download: ${info.error.replace(/\s+/g, " ").slice(0, 160)}`;
  }

  const total = info.total ?? 0;
  const ct = (info.ct ?? "").split(";")[0].trim() || "unknown type";
  if (total === 0) return `__BLOCKED__: download: empty file (${ct})`;
  const rawText = info.text ?? "";
  const binary = !info.decoded && rawText.length > 0 && (info.bad ?? 0) / rawText.length > 0.01;
  if (binary) return `__BLOCKED__: download: ${ct}, ${formatBytes(total)} - binary data, not text`;
  const text = (info.decoded || rawText).slice(0, DOWNLOAD_TEXT_MAX);
  if (!text.trim()) return `__BLOCKED__: download: ${ct}, ${formatBytes(total)} - no readable text`;

  const note =
    `The URL is a file download (${ct}, ${formatBytes(total)}), not a web page.` +
    (info.decoded ? " The server sent it base64-encoded. The text below is decoded." : "") +
    (text.length < (info.decoded || rawText).length
      ? ` Showing the first ${DOWNLOAD_TEXT_MAX.toLocaleString("en-US")} characters.`
      : "");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return [
    `# ${url}`,
    "",
    `URL: ${url}`,
    "",
    `> ${note}`,
    "",
    "## Content",
    fence,
    text,
    fence,
  ].join("\n");
}

// Page-state probe used by waitForSettledDocument():
// "<body?>|<readyState>|<textLength>|<href>". The `pi-settle` marker lets the
// unit-test fake recognise this evaluation.
export const DOC_STATE_JS =
  "(() => { /* pi-settle */ try { const b = document.body; return (document.documentElement ? (b ? 'body' : 'nobody') : 'nodoc') + '|' + document.readyState + '|' + (b && b.innerText ? b.innerText.length : 0) + '|' + location.href; } catch (e) { return 'err|' + document.readyState + '|0|'; } })()";

// A document with at least this much text is considered settled: it has real
// content, so a later client-side navigation is an ad/hijack rather than the
// page still loading.
const SETTLED_TEXT_CHARS = 400;

// Activate the tab if a content-first wait still has no text by then: JS app
// shells and bot-check scripts need a visible tab to make progress.
const CONTENT_ACTIVATE_MS = 2_500;

// How long a visit waits for the load event (or for content, see
// CONTENT_POLL_MS) before carrying on with whatever the page has.
const LOAD_WAIT_MS = 10_000;

// Poll interval of the content-first readiness probe.
const CONTENT_POLL_MS = 200;

// Extracted output shorter than this is checked against the live page's wall
// state: a gate that appeared after the settle probe returns a few hundred
// characters of "verify you are human" and must not pass as content.
const LATE_WALL_RECHECK_CHARS = 600;

// How long a nav-only result gets for its body to render before it is
// extracted a second time.
const THIN_CONTENT_WAIT_MS = 5_000;
const THIN_CONTENT_POLL_MS = 400;

// A short page can be a placeholder that the site is about to replace: an
// unrecognised vendor check, a cookie/consent stub, a client-rendered page.
// Matching those by their wording is endless and site-specific, so a document
// that settles with little text and scripts running is watched for a few
// seconds instead. Well under the 30s wall budget: it only decides whether the
// text is final, and long pages skip it entirely.
const SHORT_PAGE_WATCH_CHARS = 600;
const SHORT_PAGE_WATCH_MS = 6_000;
const SHORT_PAGE_POLL_MS = 300;

// Wait until the document stops changing.
//
// A page that already has content is returned immediately - waiting on it only
// gives ad scripts time to navigate the tab away (observed on baike.baidu.com,
// new-akiba.com, oricon.co.jp, whose pages hijack themselves to ad URLs after
// load). Pages without content (a JS/meta-refresh stub, a mid-reload document
// with no body) are polled until the URL stops changing, which is what makes
// client-side redirects work (e.g. the livedoor stub, jin115's reload).
//
// Best-effort: a probe that does not look like our marker (e.g. a test fake)
// counts as settled rather than blocking.
async function waitForSettledDocument(cdp: CDPLike, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastHref: string | null = null;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(DOC_STATE_JS);
    const match = /^(body|nobody|nodoc|err)\|(\w*)\|(\d+)\|(.*)$/.exec(state);
    if (!match) return;
    const [, kind, , textLength, href] = match;
    if (kind === "body" && Number(textLength) >= SETTLED_TEXT_CHARS) return;
    if (kind === "body" && href === lastHref) return;
    lastHref = href;
    await sleep(150);
  }
}

// Watch a short document for a few seconds and report whether it grew. This is
// how a placeholder page is recognised without knowing its wording: bot checks,
// consent stubs and client-rendered pages all paint a few lines first and
// replace them shortly after, while a genuinely short page (a 404, a sign-in
// stub, an index of links) does not move at all. Only the text length is
// compared, so nothing here is specific to a site or a vendor.
async function waitForShortPageGrowth(
  cdp: Pick<CDPLike, "evaluate">,
  opts: { timeoutMs?: number; onStatus?: StatusFn } = {},
): Promise<boolean> {
  const read = async (): Promise<{ len: number } | undefined> => {
    const state = await cdp.evaluate("/* pi-short-page */" + DOC_STATE_JS);
    const match = /^(body|nobody|nodoc|err)\|\w*\|(\d+)\|/.exec(state);
    return match ? { len: Number(match[2]) } : undefined;
  };
  const first = await read();
  if (!first || first.len >= SHORT_PAGE_WATCH_CHARS) return false;
  // A document without scripts cannot render more on its own.
  if (Number(await cdp.evaluate("document.scripts.length")) === 0) return false;
  const deadline = Date.now() + (opts.timeoutMs ?? SHORT_PAGE_WATCH_MS);
  while (Date.now() < deadline) {
    await sleep(SHORT_PAGE_POLL_MS);
    const next = await read();
    if (!next) return false;
    // Grew, or blanked for a reload: something is still painting.
    if (next.len > first.len + 300 || next.len < 40) {
      opts.onStatus?.("Short page is still rendering - waiting...");
      return true;
    }
  }
  return false;
}

// Session logic: navigate, wait, scroll, extract - all against a connected
// CDP client. Split out from runInPage so it can be tested with a fake
// CDPLike (no real Chrome, no WebSocket).
async function runInPageSession(cdp: CDPLike, opts: RunInPageOptions): Promise<string> {
  const {
    url,
    js,
    clickConsent = false,
    dynamicScroll = false,
    scrollCount = 3,
    scrollDelayMs = 300,
    initialWaitMs = 0,
    waitForSelector,
    waitForTimeoutMs = 8000,
    waitForSelectorPollMs = 400,
    interstitialWaitMs = INTERSTITIAL_WAIT_MS,
    interstitialReloadWaitMs = INTERSTITIAL_RELOAD_WAIT_MS,
    resolveGoogleRedirects = false,
    safetyExtract = false,
    contentFirst = false,
    wallRecheck = true,
    wallWaitMs = WALL_WAIT_MS,
    onStatus,
  } = opts;

  onStatus(`Navigating to ${new URL(url).hostname}...`);

  await cdp.call("Page.enable");
  // Runtime.enable is deliberately NOT called: Runtime.evaluate works without
  // it, and enabling the domain is a known CDP detection vector used by
  // anti-bot scripts (they probe for its console-API side effects). Skipping
  // it keeps the browser closer to an ordinary user's Chrome.

  // Track every Document response, not just the first. Bot-check interstitials
  // answer the initial request with 403/503, run their challenge in the page
  // and reload to the real document - an ordinary browser never sees that
  // first response. The frame id is recorded and matched against the main
  // frame after the fact because `responseReceived` arrives before
  // `Page.frameNavigated`. iframe Document responses (ad/user-sync pages) are
  // filtered out by that match.
  interface DocResponse {
    status: number;
    statusText: string;
    url: string;
    frameId?: string;
    // Cloudflare marks challenge interstitials with `cf-mitigated: challenge`.
    challenge: boolean;
  }
  const docResponses: DocResponse[] = [];
  let mainFrameId: string | undefined;
  let mainFrameUrl: string | undefined;
  cdp.onEvent("Page.frameNavigated", (params) => {
    const p = params as { frame?: { id?: string; parentId?: string; url?: string } };
    if (p.frame && !p.frame.parentId) {
      mainFrameId = p.frame.id;
      mainFrameUrl = p.frame.url ?? mainFrameUrl;
    }
  });
  cdp.onEvent("Network.responseReceived", (params) => {
    const p = params as {
      type?: string;
      frameId?: string;
      response?: {
        url?: string;
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
      };
    };
    if (p.type !== "Document" || !p.response) return;
    docResponses.push({
      status: p.response.status ?? 0,
      statusText: p.response.statusText ?? "",
      url: p.response.url ?? "",
      frameId: p.frameId,
      challenge: String(p.response.headers?.["cf-mitigated"] ?? "").toLowerCase() === "challenge",
    });
  });
  await cdp.call("Network.enable");

  // Latest Document response belonging to the main frame. Falls back to the
  // first response when no frame was ever captured (e.g. a fake CDP).
  const sameDoc = (r: DocResponse): boolean => {
    if (mainFrameId !== undefined) return r.frameId === mainFrameId;
    if (mainFrameUrl !== undefined) {
      const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
      return norm(r.url) === norm(mainFrameUrl);
    }
    return true;
  };
  const latestMainDoc = (): DocResponse | undefined => {
    for (let i = docResponses.length - 1; i >= 0; i--) {
      if (sameDoc(docResponses[i])) return docResponses[i];
    }
    return docResponses[0];
  };
  const mainDocCount = (): number => docResponses.filter(sameDoc).length;

  // Resolve a 403/503 the way a browser would. Challenge pages reload
  // themselves once solved - the tab must stay open and alive for that (the
  // old code closed it right away). Anything without challenge markers gets
  // one reload, the F5 move.
  //
  // 5xx gateway errors are the same kind of transient: a proxy or upstream
  // hiccup (a plain http:// page through the proxy answered 502 twice in five
  // visits while the same URL loaded fine in between) clears on the next
  // request. A 503 stays on the challenge path below - Cloudflare interstitials
  // answer 503 and need their wait, not an F5.
  const resolveInterstitial = async (): Promise<void> => {
    const first = latestMainDoc();
    const gatewayError =
      first !== undefined && first.status >= 500 && first.status < 600 && first.status !== 503;
    if (!first || (first.status !== 403 && first.status !== 503 && !gatewayError)) return;

    // Bot-check JS can be visibility-sensitive. Activate the tab like a user
    // opening the page would, even on paths that normally avoid focus theft.
    try {
      await cdp.call("Page.bringToFront");
    } catch {
      // Non-fatal: some targets reject it. The launch flags still help.
    }

    if (
      first.challenge ||
      (!gatewayError && (await looksLikeChallengePage(cdp)))
    ) {
      onStatus(`HTTP ${first.status} - waiting for the site's bot check to clear...`);
      const cleared = await waitForChallengeToClear(cdp, {
        timeoutMs: interstitialWaitMs,
        onStatus,
        isCleared: () => {
          const doc = latestMainDoc();
          return !!doc && doc.status < 400;
        },
      });
      if (cleared) onStatus("Bot check cleared - extracting...");
      return; // still blocked -> error marker below
    }

    // No challenge markers: treat it as a stale first response (cookie wall,
    // transient WAF rule, proxy hiccup, ...) and reload once, like a user
    // pressing F5.
    onStatus(`HTTP ${first.status} - retrying once...`);
    const responsesBefore = mainDocCount();
    try {
      await cdp.call("Page.reload", { ignoreCache: false });
    } catch {
      return; // reload refused -> report the original error
    }
    const deadline = Date.now() + interstitialReloadWaitMs;
    while (Date.now() < deadline) {
      await sleep(INTERSTITIAL_POLL_MS);
      // As soon as the retry answers, its status decides (the check below).
      // Count main-frame documents only: an ad iframe response must not make
      // us give up while the main retry is still arriving.
      if (mainDocCount() > responsesBefore) return;
    }
  };

  const loaded = new Promise<void>((resolve) => {
    cdp.onEvent("Page.loadEventFired", () => resolve());
  });
  let loadTimer!: ReturnType<typeof setTimeout>;
  const loadTimeout = new Promise<void>((resolve) => { loadTimer = setTimeout(resolve, LOAD_WAIT_MS); });

  const navInfo = await navigateToPage(cdp, url, loaded, onStatus);

  // A download never becomes a document (the tab stays on about:blank), so
  // there is nothing to wait for and nothing to extract here.
  if (navInfo.isDownload) {
    return readDownload(cdp, url, onStatus);
  }

  // Waiting for the load event is not always worth it: on ad-heavy pages hung
  // frames and analytics requests keep it from firing for the full timeout
  // while the text has been rendered for seconds. Proceed as soon as the
  // document has content. The settle step and the HTTP checks below are
  // unaffected, and extracting earlier is what keeps an ad/anti-bot script
  // from navigating the tab out from under the extraction.
  let loadRaceDone = false;
  const racers: Array<Promise<void>> = [loaded, loadTimeout];
  if (contentFirst) {
    const contentReady = (async () => {
      const startedAt = Date.now();
      let activated = false;
      while (!loadRaceDone && Date.now() - startedAt < LOAD_WAIT_MS) {
        const state = String(await cdp.evaluate(DOC_STATE_JS));
        const m = /^(body|nobody|nodoc|err)\|(\w*)\|(\d+)\|/.exec(state);
        if (!m) return;
        if (m[1] === "body" && Number(m[3]) >= SETTLED_TEXT_CHARS) return;
        // Chrome pauses requestAnimationFrame and visibility-gated JS in a
        // hidden tab. Bot-check scripts and JavaScript app shells therefore
        // never get past "Loading..." until the tab is visible (observed on
        // pypi.org and lensisku.lojban.org), so activate it after a moment
        // without text.
        if (!activated && Date.now() - startedAt >= CONTENT_ACTIVATE_MS) {
          activated = true;
          try {
            await cdp.call("Page.bringToFront");
          } catch {
            // Non-fatal: the launch flags still keep the renderer alive.
          }
        }
        await sleep(CONTENT_POLL_MS);
      }
    })();
    contentReady.catch(() => {});
    racers.push(contentReady);
  }
  await Promise.race(racers);
  loadRaceDone = true;
  clearTimeout(loadTimer);

  // A 403/503 from the first response is not final: it is usually a bot-check
  // interstitial that clears itself seconds later. Wait for it (or retry once)
  // before believing the error.
  if (interstitialWaitMs > 0) {
    await resolveInterstitial();
  }

  // If the server returned an HTTP error (4xx/5xx) that stuck, don't bother
  // running the extractor on the error page - return a clear marker so
  // visitPage can surface it to the LLM as an error result. This prevents the
  // model from receiving "Page Not Found" gibberish as if it were content.
  const finalDoc = latestMainDoc();
  if (finalDoc && finalDoc.status >= 400) {
    const challenge =
      finalDoc.challenge ||
      ((finalDoc.status === 403 || finalDoc.status === 503) && (await looksLikeChallengePage(cdp)));
    const text = challenge
      ? `${finalDoc.status} Bot challenge not passed`
      : `${finalDoc.status} ${finalDoc.statusText}`.trim();
    onStatus(`HTTP ${text}`);
    return `__HTTP_ERROR__: ${text}`;
  }

  // Client-side redirects (location.replace, meta refresh, document.write
  // reloads) replace the document after the load event. Extracting during
  // that window captures the redirect stub - or throws, because document.body
  // is still null (observed on jin115.com and baike.baidu.com). Let the
  // document settle first so the extraction sees the final page.
  await waitForSettledDocument(cdp);

  // A navigation that never became a document (DNS/proxy/TLS/HTTPS-upgrade
  // failure) leaves the tab on Chrome's error page. Report that instead of
  // its empty shell (`chrome-error://chromewebdata/`). These transport
  // failures are transient when several visits load at once through a proxy -
  // the same URL loads fine on its own - so re-navigate once before giving up.
  // The retry skips navigateToPage's 3x15s ladder: the first attempt already
  // spent that, and a retry that hangs is another dead page.
  let settledHref = String(await cdp.evaluate("location.href"));
  if (settledHref.startsWith("chrome-error://")) {
    onStatus("Navigation failed - retrying once...");
    const retryLoaded = new Promise<void>((resolve) => {
      cdp.onEvent("Page.loadEventFired", () => resolve());
    });
    let retryTimer!: ReturnType<typeof setTimeout>;
    const retryTimeout = new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, LOAD_WAIT_MS); });
    try {
      await cdp.call("Page.navigate", { url }, NAVIGATE_TIMEOUT_MS);
    } catch {
      // Leave the tab to whatever it is doing and report below.
    }
    await Promise.race([retryLoaded, retryTimeout]);
    clearTimeout(retryTimer);
    await waitForSettledDocument(cdp);
    settledHref = String(await cdp.evaluate("location.href"));
    if (settledHref.startsWith("chrome-error://")) {
      return `__NAV_ERROR__: ${url}`;
    }
  }

  // A page can answer 200 and still be a wall instead of content: Fastly's
  // "Client Challenge" (pypi.org), a reCAPTCHA gate (jbovlaste.lojban.org), a
  // login form, or a JavaScript shell that still says "Loading..."
  // (lensisku.lojban.org). A challenge and a shell clear themselves once the
  // tab is visible and given a few seconds, so activate it and wait. A CAPTCHA
  // or a login cannot be solved from here and is reported instead.
  let wall = await probeWall(cdp);
  // Nothing recognisable, but the page is short and still moving: probe again
  // once it grew, in case the growth was a check page or a route change. This
  // is the vendor-agnostic path - no wording list involved.
  if (!wall && wallWaitMs > 0 && (await waitForShortPageGrowth(cdp, { onStatus }))) {
    await waitForSettledDocument(cdp);
    settledHref = String(await cdp.evaluate("location.href"));
    if (settledHref.startsWith("chrome-error://")) {
      return `__NAV_ERROR__: ${url}`;
    }
    wall = await probeWall(cdp);
  }
  if (wall) {
    if (wall.kind === "captcha" || wall.kind === "login") {
      onStatus(`Page is a ${wall.kind} gate - cannot read it`);
      return blockedMarker(wall);
    }
    onStatus(
      wall.kind === "challenge"
        ? "Bot check page - activating the tab and waiting..."
        : "Page is still loading - activating the tab and waiting...",
    );
    try {
      await cdp.call("Page.bringToFront");
    } catch {
      // Non-fatal: the launch flags still keep the renderer alive.
    }
    if (!(await waitForChallengeToClear(cdp, { timeoutMs: wallWaitMs, onStatus, reloadAfterMs: wall.kind === "challenge" ? CHALLENGE_RELOAD_AFTER_MS : 0, isCleared: async () => !(await probeWall(cdp)) }))) {
      onStatus(`Page did not become readable (${wall.kind})`);
      return blockedMarker(wall);
    }
    // The page may have reloaded itself (bot check) or routed (SPA).
    settledHref = String(await cdp.evaluate("location.href"));
    if (settledHref.startsWith("chrome-error://")) {
      return `__NAV_ERROR__: ${url}`;
    }
    await waitForSettledDocument(cdp);
  }

  // Safety extraction, taken before the waits and scrolling below. Ad and
  // anti-bot scripts on legacy sites navigate the tab away a few seconds after
  // load (observed on hmv.co.jp, oricon.co.jp, koenote.info, baike.baidu.com).
  // By the time the second extraction runs it would read the ad page or
  // Chrome's error page instead. The first pass is cheap, and the second,
  // post-scroll pass below is the one that catches lazy-loaded content.
  const originOf = (target: string): string => {
    try {
      return new URL(target).origin;
    } catch {
      return target;
    }
  };
  // Where the site itself put us: mirror domains (hibari.5ch.net ->
  // kako.5ch.io) and JS redirects are a normal part of loading a page, and
  // only a move away from this is a hijack.
  const settledOrigin = originOf(settledHref);
  const safety = safetyExtract ? await cdp.evaluate(js) : "";
  const leftSettledPage = async (): Promise<boolean> => {
    try {
      return originOf(String(await cdp.evaluate("location.href"))) !== settledOrigin;
    } catch {
      // The tab is gone: something took it, so the safety copy is the page.
      return true;
    }
  };

  // Make this the active tab before any scrolling. Tool tabs open in the
  // background. Chrome suspends rendering for non-active tabs, so
  // window.scrollTo() (dynamicScroll, below) and the self-scrolling inside
  // the async extractors would otherwise not trigger lazy-loaded content -
  // the "Scrolling for dynamic content..." step silently did nothing until
  // you manually clicked the tab. Skipped for HTTP errors (dead pages) and
  // when bringToFront is unset (Google/Scholar/Defuddle: no scrolling).
  if (opts.bringToFront) {
    onStatus("Activating tab for scrolling...");
    try {
      await cdp.call("Page.bringToFront");
    } catch {
      // Non-fatal: some targets reject it. The launch flags above still help.
    }
    await sleep(150); // let the renderer resume before scrolling/extracting
  }

  if (clickConsent) {
    const clicked = await cdp.evaluate(GOOGLE_CONSENT_JS);
    if (clicked) {
      onStatus(`Consent: ${clicked}`);
      const consentLoaded = new Promise<void>((resolve) => {
        cdp.onEvent("Page.loadEventFired", () => resolve());
      });
      let consentTimer!: ReturnType<typeof setTimeout>;
      const consentTimeout = new Promise<void>((resolve) => { consentTimer = setTimeout(resolve, 5_000); });
      await Promise.race([consentLoaded, consentTimeout]);
      clearTimeout(consentTimer);
    }
  }

  if (initialWaitMs > 0) {
    onStatus("Waiting for page to render...");
    await sleep(initialWaitMs);
  }

  if (waitForSelector) {
    onStatus(`Waiting for ${waitForSelector}...`);
    const deadline = Date.now() + waitForTimeoutMs;
    while (Date.now() < deadline) {
      // cdp.evaluate stringifies the return value (String(value)), so the
      // boolean false becomes "false" (a truthy string). Compare explicitly
      // to "true" instead of relying on truthiness.
      const found = await cdp.evaluate(
        `document.querySelector(${JSON.stringify(waitForSelector)}) !== null`
      );
      if (found === "true") break;
      await sleep(waitForSelectorPollMs);
    }
  }

  if (dynamicScroll) {
    onStatus("Scrolling for dynamic content...");
    for (let i = 0; i < scrollCount; i++) {
      await cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await sleep(scrollDelayMs);
    }
    await cdp.evaluate("window.scrollTo(0, 0)");
    await sleep(200);
  }

  onStatus("Extracting content...");
  let result = await cdp.evaluate(js);

  // If the page was replaced while we waited and scrolled, the extraction
  // above may have read an ad page, a redirect stub, or a page still showing
  // its loading skeleton. Keep whichever copy has more text: the safety pass
  // caught the page early, the second pass caught it late.
  if (safety.trim().length >= 50 && !safety.startsWith("__") && (await leftSettledPage())) {
    if (result.trim().length < safety.trim().length) {
      onStatus("Page navigated away - keeping the pre-scroll extraction...");
      result = safety;
    }
  }

  // Fallback: if the primary extractor returned an error marker or nothing
  // useful, run the fallback JS in the same tab (no re-navigation).
  if (opts.fallbackJs && (result.startsWith("__DEFUDDLE_ERROR__") || result.trim().length < 50)) {
    onStatus("Clean extraction failed - falling back to the generic extractor...");
    result = await cdp.evaluate(opts.fallbackJs);
  }

  // A gate can still show up after the settle probe and swap the document out
  // while the extractor runs (a check page that paints late, after the first
  // render). Short output is the tell: ask the live page once whether it is a
  // gate now instead of handing the gate back as content.
  if (
    wallRecheck &&
    result.trim().length > 0 &&
    result.trim().length < LATE_WALL_RECHECK_CHARS &&
    !result.startsWith("__")
  ) {
    const late = await probeWall(cdp);
    if (late) {
      if (late.kind === "captcha" || late.kind === "login") {
        onStatus(`Page is a ${late.kind} gate - cannot read it`);
        return blockedMarker(late);
      }
      onStatus(`Page became a ${late.kind} - waiting for it...`);
      const cleared = await waitForChallengeToClear(cdp, {
        timeoutMs: wallWaitMs,
        onStatus,
        reloadAfterMs: late.kind === "challenge" ? CHALLENGE_RELOAD_AFTER_MS : 0,
        isCleared: async () => !(await probeWall(cdp)),
      });
      if (!cleared) {
        onStatus(`Page did not become readable (${late.kind})`);
        return blockedMarker(late);
      }
      await waitForSettledDocument(cdp);
      onStatus("Extracting content...");
      result = await cdp.evaluate(js);
    }
  }

  // A snapshot or SPA can render its navigation before its body: retry a
  // result that is mostly links, and keep whichever copy has more prose. The
  // wait ends as soon as the page stops changing, so an index page that is
  // legitimately a list of links costs about a second and no second pass.
  if (wallRecheck && !result.startsWith("__") && looksNavOnly(result)) {
    onStatus("Page rendered only its navigation - waiting for the body...");
    const before = markdownProseLength(result);
    const startedAt = Date.now();
    let lastLen = -1;
    let stable = 0;
    let grew = false;
    while (Date.now() - startedAt < THIN_CONTENT_WAIT_MS) {
      await sleep(THIN_CONTENT_POLL_MS);
      const match = /^(body|nobody|nodoc|err)\|\w*\|(\d+)\|/.exec(await cdp.evaluate(DOC_STATE_JS));
      const len = match ? Number(match[2]) : -1;
      if (len > before * 2 + 200) {
        grew = true;
        break;
      }
      if (len === lastLen) {
        if (++stable >= 2) break; // nothing is coming
      } else {
        stable = 0;
      }
      lastLen = len;
    }
    if (grew) {
      const retried = await cdp.evaluate(js);
      if (!retried.startsWith("__") && markdownProseLength(retried) > before) {
        onStatus("Got the page body on the second pass");
        result = retried;
      }
    }
  }

  // Google search results may contain `/goto?url=<opaque>` redirect wrappers
  // that JavaScript cannot decode or follow. Ask Google for the destination
  // (302 Location) from inside this tab - it has the session, cookies and
  // proxy of the search - and swap the direct URLs into the markdown.
  if (opts.resolveGoogleRedirects) {
    result = await resolveGoogleRedirectsInBrowser(cdp, result, { onStatus });
  }

  // Truncate
  if (result.length > MAX_RESULT_BYTES) {
    return result.slice(0, MAX_RESULT_BYTES) + "\n\n[Content truncated at 1MB]";
  }
  // A redirect can land on a different page shape entirely (t.me/s/<group>
  // redirects to the group's join page, dropping the message feed). Say so
  // instead of letting the model assume it got the page it asked for.
  const redirectNote = redirectNoteFor(url, settledHref);
  return redirectNote ? `${redirectNote}\n\n${result}` : result;
}

async function runInPage(opts: RunInPageOptions): Promise<string> {
  await ensureChrome(opts.onStatus);

  const tab = await openTab();

  const cdp = new CDPClient();
  await cdp.connect(tab.wsUrl);

  try {
    return await runInPageSession(cdp, opts);
  } finally {
    cdp.disconnect();
    await closeTab(tab.targetId);
  }
}

// Public API

export interface SearchResult {
  markdown: string;
  url: string;
  // HTTP status of the main document response, when captured. Set (with an
  // empty `markdown`) when the server returned a 4xx/5xx error, so the tool
  // layer can surface it as an error instead of extracting the error page.
  httpStatus?: number;
  httpStatusText?: string;
  // Set (with an empty `markdown`) when the navigation itself failed - DNS,
  // proxy, TLS, or an HTTP->HTTPS upgrade to a host without HTTPS. The tab
  // sits on Chrome's error page (chrome-error://chromewebdata/), which has no
  // content to extract.
  navError?: string;
  // Set (with an empty `markdown`) when the page is a wall rather than content:
  // a bot check, a CAPTCHA, a login form, a JavaScript shell, or a file
  // download whose body is not text.
  blocked?: { kind: string; detail: string };
}

export interface VisitPageOptions {
  onStatus?: (msg: string) => void;
  // When true, generic (non-specialized) pages are extracted with Defuddle -
  // a reader-mode-style article extractor that drops navigation, sidebars,
  // ads, and footers, returning clean Markdown. Far better than the default
  // block-walker for articles, docs, and blog posts. If Defuddle fails or
  // returns nothing, falls back to the generic extractor automatically.
  //
  // Specialized pages (X, Reddit, Amazon, Scholar) always use their
  // purpose-built extractors, which already produce clean compact Markdown -
  // `clean` has no additional effect on them.
  clean?: boolean;
}

// Run an extractor in a fresh tab, then resolve HTTP errors. Wraps the
// common pattern shared by every visitPage path and googleSearch: navigate,
// (optionally) wait for a selector, extract, resolve. Defaults match the
// specialized extractors (no consent click, no dynamic scroll, 500ms render
// wait, 10s selector timeout) - callers override only what differs.
async function extractVia(
  url: string,
  status: (msg: string) => void,
  msg: string,
  js: string,
  opts: {
    waitForSelector?: string;
    waitForTimeoutMs?: number;
    clickConsent?: boolean;
    dynamicScroll?: boolean;
    initialWaitMs?: number;
    fallbackJs?: string;
    bringToFront?: boolean;
    safetyExtract?: boolean;
    contentFirst?: boolean;
    // Re-probe the page after extraction (late gates, nav-only results). Off
    // for searches, whose results are already lists of links.
    wallRecheck?: boolean;
    // Resolve Google `/goto` redirect links in the open tab before returning
    // (see src/google-links.ts). Used by googleSearch.
    resolveGoogleRedirects?: boolean;
  } = {},
): Promise<SearchResult> {
  if (msg) status(msg);
  const markdown = await runInPage({
    url,
    js,
    clickConsent: opts.clickConsent ?? false,
    dynamicScroll: opts.dynamicScroll ?? false,
    initialWaitMs: opts.initialWaitMs ?? 500,
    waitForSelector: opts.waitForSelector,
    waitForTimeoutMs: opts.waitForTimeoutMs ?? 10_000,
    fallbackJs: opts.fallbackJs,
    bringToFront: opts.bringToFront ?? false,
    safetyExtract: opts.safetyExtract ?? false,
    contentFirst: opts.contentFirst ?? false,
    wallRecheck: opts.wallRecheck ?? false,
    resolveGoogleRedirects: opts.resolveGoogleRedirects ?? false,
    onStatus: status,
  });
  return resolveHttpError(markdown, url);
}

// A Google search URL with SafeSearch explicitly off.
//
// The dedicated profile is anonymous and its signed-out SafeSearch choice is
// "Off" (google.com/safesearch offers Filter / Blur / Off without an account),
// so results are already unfiltered. Sending `safe=off` anyway keeps them that
// way per request: it overrides a Filter/Blur choice saved in the profile, and
// it asks for the "show everything" behaviour where Google's blur-by-default
// for signed-out users would otherwise apply. If SafeSearch is locked (parental
// controls, school/work network) Google ignores the parameter - nothing a
// parameter can do about that.
export function googleSearchUrl(query: string, opts?: { images?: boolean }): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("safe", "off");
  if (opts?.images) url.searchParams.set("udm", "2");
  return url.href;
}

export async function googleSearch(
  query: string,
  onStatus?: (msg: string) => void
): Promise<SearchResult> {
  const status = onStatus ?? (() => {});
  const url = googleSearchUrl(query);
  return extractVia(url, status, `Searching Google for: ${query}`,
    GOOGLE_SEARCH_JS, { clickConsent: true, initialWaitMs: 0, resolveGoogleRedirects: true });
}

export interface GoogleImageSearchOptions {
  // How many image results to return (1-12, default 8).
  count?: number;
  onStatus?: (msg: string) => void;
}

// Google Images (`udm=2`): every result is the image URL plus the URL of the
// page the image came from. The original image URL only exists in the preview
// panel, so the extractor clicks through the tiles to resolve it (falling back
// to Google's cached thumbnail) - see getGoogleImageSearchJs().
export async function googleImageSearch(
  query: string,
  options?: GoogleImageSearchOptions
): Promise<SearchResult> {
  const status = options?.onStatus ?? (() => {});
  const count = clampImageCount(options?.count);
  const url = googleSearchUrl(query, { images: true });
  return extractVia(url, status, `Searching Google Images for: ${query}`,
    getGoogleImageSearchJs(count),
    {
      clickConsent: true,
      // The preview panel only loads its (original) image in an active tab.
      bringToFront: true,
      waitForSelector: "[data-lpage], .isv-r",
      waitForTimeoutMs: 10_000,
      initialWaitMs: 1000,
    });
}

export interface ReverseImageSearchOptions {
  mode: ReverseImageMode;
  onStatus?: (msg: string) => void;
}

// Largest upload Google Lens accepts (the UI rejects bigger files).
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Resolve a read-tool-style path: absolute, relative to the cwd, or `~/...`.
export function resolveImagePath(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new Error("An image path is required.");
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

// MIME type from the file signature (what Lens accepts), or undefined.
export function sniffImageMime(head: Buffer): string | undefined {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === "PNG" && head[4] === 0x0d && head[5] === 0x0a) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (head.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
  return undefined;
}

export interface LocalImage {
  // Absolute path, as Chrome's file-input API needs it.
  path: string;
  // Base name, for messages and tool output.
  name: string;
  mime: string;
  size: number;
}

// Validate a local image the way Pi's read tool resolves paths, before Chrome
// is touched: it must exist, be a regular file, fit Lens's upload limit, and
// actually be an image (sniffed, not trusted from the extension).
export function readImageFile(input: string): LocalImage {
  const path = resolveImagePath(input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`Image not found: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (stat.size === 0) throw new Error(`Image is empty: ${path}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    throw new Error(`Image is too large (${mb} MB). Google Lens accepts up to ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
  }

  const head = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const mime = sniffImageMime(head);
  if (!mime) {
    throw new Error(`Unsupported image format: ${path} (expected PNG, JPEG, GIF, WebP, or BMP)`);
  }
  return { path, name: basename(path), mime, size: stat.size };
}

// Poll an in-page boolean expression until it is true or the timeout expires.
// Evaluation errors are expected while the page navigates (the execution
// context is destroyed) and are treated as "not yet".
async function waitForPageCondition(cdp: CDPLike, expression: string, timeoutMs: number, pollMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await cdp.evaluate(expression)) === "true") return true;
    } catch {
      // navigation in progress
    }
    await sleep(pollMs);
  }
  return false;
}

// Current tab URL, or "" while the page is navigating.
async function currentPageUrl(cdp: CDPLike): Promise<string> {
  try {
    return await cdp.evaluate("location.href");
  } catch {
    return "";
  }
}

// Absolute href of the "Exact matches" / "Visual matches" tab, if rendered.
async function reverseImageModeHref(cdp: CDPLike, mode: ReverseImageMode): Promise<string> {
  const label = mode === "exact" ? "Exact matches" : "Visual matches";
  try {
    return await cdp.evaluate(
      `(() => {
        const clean = s => (s || "").replace(/\\s+/g, " ").trim();
        const a = [...document.querySelectorAll("a")].find((x) => clean(x.innerText) === ${JSON.stringify(label)});
        return a ? a.href : "";
      })()`,
    );
  } catch {
    return "";
  }
}

// Add/replace the mode parameter on a Lens results URL (fallback for when the
// tab link has not rendered yet).
function withReverseImageMode(url: string, mode: ReverseImageMode): string | undefined {
  try {
    const u = new URL(url);
    u.searchParams.set("udm", mode === "exact" ? "48" : "44");
    return u.href;
  } catch {
    return undefined;
  }
}

// Google search by image: upload a local file to Lens, then read the results
// for the chosen mode (exact matches = pages with the same image. Visual
// matches = visually similar images). The upload goes through Lens's own file
// input, so the request carries the real browser's cookies, user agent and
// proxy. The mode switch uses the same tab and Google's own tab links.
export async function reverseImageSearch(
  filePath: string,
  options: ReverseImageSearchOptions,
): Promise<SearchResult> {
  const status = options.onStatus ?? (() => {});
  const mode = options.mode;
  if (!isReverseImageMode(mode)) {
    throw new Error(`Invalid mode "${String(mode)}" - use ${REVERSE_IMAGE_MODES.map((m) => `"${m}"`).join(" or ")}.`);
  }
  const image = readImageFile(filePath);

  await ensureChrome(status);
  const tab = await openTab();
  const cdp = new CDPClient();
  await cdp.connect(tab.wsUrl);

  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Network.enable");
    // Uploading and previewing need an active tab, like the scrolling paths.
    await cdp.call("Page.bringToFront");

    status("Opening Google Lens...");
    await cdp.call("Page.navigate", { url: "https://lens.google.com/" });
    await sleep(1500);

    // Consent / bot-check walls on the Lens entry page.
    try {
      const consent = await cdp.evaluate(GOOGLE_CONSENT_JS);
      if (consent) status(`Consent: ${consent}`);
    } catch {
      // not a consent page
    }
    if (await probeWall(cdp)) {
      status("Google is showing a check page - waiting for it to clear...");
      await waitForChallengeToClear(cdp, {
        timeoutMs: WALL_WAIT_MS,
        onStatus: status,
        reloadAfterMs: CHALLENGE_RELOAD_AFTER_MS,
        isCleared: async () => !(await probeWall(cdp)),
      });
    }

    status("Waiting for the upload control...");
    if (!(await waitForPageCondition(cdp, `document.querySelector('input[type=file]') !== null`, 20_000))) {
      throw new Error("Google Lens did not show its upload control (the page may be blocked or waiting on consent).");
    }

    status(`Uploading ${image.name}...`);
    const doc = (await cdp.call("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } };
    const node = (await cdp.call("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" })) as {
      nodeId: number;
    };
    if (!node || !node.nodeId) throw new Error("Google Lens upload input was not found.");
    await cdp.call("DOM.setFileInputFiles", { files: [image.path], nodeId: node.nodeId });

    status("Waiting for Google's image analysis...");
    if (!(await waitForPageCondition(cdp, `/\\/search\\?vsrid=/.test(location.href)`, 45_000, 500))) {
      throw new Error("Google did not return a results page for the uploaded image.");
    }

    status(`Switching to ${mode === "exact" ? "exact" : "visual"} matches...`);
    // Setting `udm` on the results URL is what the mode tabs do. The tab href
    // carries short-lived session params and sometimes lands back on "All",
    // so it is only a fallback.
    const target = withReverseImageMode(await currentPageUrl(cdp), mode) || (await reverseImageModeHref(cdp, mode));
    if (target) {
      await cdp.call("Page.navigate", { url: target });
      await waitForPageCondition(cdp, `document.readyState === "complete"`, 20_000);
      await sleep(2000);
    }

    status("Waiting for results...");
    // Visual matches render as Lens cards. Exact matches as result cards (an
    // image grid or ordinary web results).
    const resultSelector =
      mode === "visual"
        ? "a.LBcIee"
        : 'a[href*="/goto?url="]';
    await waitForPageCondition(
      cdp,
      `document.querySelectorAll(${JSON.stringify(resultSelector)}).length > 0`,
      30_000,
      400,
    );
    await sleep(1500);

    status("Extracting results...");
    let markdown = await cdp.evaluate(getReverseImageSearchJs(mode));
    // Result links are /goto?url=<opaque> wrappers: resolve them to the real
    // pages by following the 302 inside this tab, like google_search does.
    markdown = await resolveGoogleRedirectsInBrowser(cdp, markdown, { onStatus: status });
    return { markdown, url: await currentPageUrl(cdp) };
  } finally {
    cdp.disconnect();
    await closeTab(tab.targetId);
  }
}

// If the extraction returned an HTTP-error marker (set by runInPageSession
// when the server responded 4xx/5xx), convert it to a SearchResult that
// carries the status - so the tool layer can surface it as an error instead
// of returning the error-page content as if it were the page itself.
function resolveHttpError(markdown: string, url: string): SearchResult {
  const httpErr = markdown.match(/^__HTTP_ERROR__: (\d{3})\s*(.*)$/);
  if (httpErr) {
    return {
      markdown: "",
      url,
      httpStatus: Number(httpErr[1]),
      httpStatusText: httpErr[2].trim(),
    };
  }
  const navErr = markdown.match(/^__NAV_ERROR__: (\S*)$/);
  if (navErr) {
    return { markdown: "", url: navErr[1] || url, navError: "navigation failed" };
  }
  const blocked = markdown.match(/^__BLOCKED__: (\w+): (.*)$/);
  if (blocked) {
    return { markdown: "", url, blocked: { kind: blocked[1], detail: blocked[2].trim() } };
  }
  return { markdown, url };
}

export async function visitPage(
  url: string,
  options?: VisitPageOptions
): Promise<SearchResult> {
  const status = options?.onStatus ?? (() => {});
  const clean = options?.clean ?? false;
  status(`Visiting: ${url}`);

  if (isXUrl(url)) {
    return extractVia(url, status, "Detected X (Twitter) \u2014 using tweet extractor...",
      X_EXTRACT_JS, { waitForSelector: 'article[data-testid="tweet"]', bringToFront: true });
  }

  if (isRedditPostUrl(url)) {
    return extractVia(url, status, "Detected Reddit post \u2014 using comment extractor...",
      REDDIT_EXTRACT_JS, { waitForSelector: "shreddit-comment, shreddit-post", bringToFront: true });
  }

  if (isAmazonProductUrl(url)) {
    return extractVia(url, status, "Detected Amazon product page \u2014 using product extractor...",
      AMAZON_PRODUCT_JS, { waitForSelector: "#productTitle, #titleSection", bringToFront: true });
  }

  if (isAmazonSearchUrl(url)) {
    return extractVia(url, status, "Detected Amazon search \u2014 using listing extractor...",
      AMAZON_SEARCH_JS, { waitForSelector: '[data-component-type="s-search-result"]', bringToFront: true });
  }

  if (isScholarSearchUrl(url)) {
    return extractVia(url, status, "Detected Google Scholar \u2014 using academic extractor...",
      SCHOLAR_EXTRACT_JS, { waitForSelector: ".gs_r, .gs_ri" });
  }

  // Generic page. When `clean` is requested, use Defuddle (reader-mode article
  // extraction) for far cleaner Markdown than the block-walker fallback. If
  // Defuddle fails or returns nothing, the fallbackJs runs in the same tab.
  if (clean) {
    // Defuddle is an npm dependency. If it is missing (dependencies never
    // installed), degrade to the generic extractor instead of failing the
    // call: an empty bundle makes the driver return a __DEFUDDLE_ERROR__
    // marker, which triggers fallbackJs. The real reason is logged for
    // PI_SEARCH_DEBUG.
    let bundle = "";
    try {
      bundle = getDefuddleBundle();
    } catch (err) {
      debugLog(`Defuddle unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return extractVia(url, status, "Using Defuddle for clean article extraction...",
      bundle + "\n;" + DEFUDDLE_DRIVER_JS,
      { clickConsent: true, fallbackJs: EXTRACT_PAGE_JS, safetyExtract: true, contentFirst: true, wallRecheck: true });
  }

  return extractVia(url, status, "", EXTRACT_PAGE_JS,
    { clickConsent: true, dynamicScroll: true, initialWaitMs: 0, bringToFront: true, safetyExtract: true, contentFirst: true, wallRecheck: true });
}

// Exported for testing - internal API, not part of the extension's tool surface
// (index.ts only imports googleSearch, visitPage, and the reverse-image helpers).
// Extractor JS strings + URL classifiers are re-exported from ./extractors.ts
// so existing test imports from chrome.ts keep working.
export {
  type CDPLike,
  type RunInPageOptions,
  runInPageSession,
  waitForShortPageGrowth,
};
export {
  isXUrl,
  isRedditPostUrl,
  isAmazonProductUrl,
  isAmazonSearchUrl,
  isScholarSearchUrl,
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
  getDefuddleBundle,
} from "./extractors.ts";
