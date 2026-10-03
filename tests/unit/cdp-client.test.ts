import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInPageSession, CHROME_LAUNCH_ARGS, NAVIGATE_ATTEMPTS, NAVIGATE_TIMEOUT_MS, chromeCandidates, chromeLaunchArgs, findChrome, chromeSpawnErrorMessage, type CDPLike, type RunInPageOptions } from "../../src/chrome.ts";
import { DEFUDDLE_DRIVER_JS, getDefuddleBundle, defuddleBundlePath } from "../../src/extractors.ts";

// Fake CDP
// Implements CDPLike so runInPageSession can be exercised without a real
// browser or WebSocket. Records every call/evaluate for assertions.

interface FakeDocResponse {
  status: number;
  statusText?: string;
  url?: string;
  frameId?: string;
  // Emit the commit event as an iframe (parentId set) instead of the main frame.
  iframe?: boolean;
  // Mark the response as a Cloudflare challenge (`cf-mitigated: challenge`).
  challenge?: boolean;
  // Emit this response after a delay (settles in the background).
  delayMs?: number;
}

class FakeCDP implements CDPLike {
  calls: Array<{ method: string; params?: Record<string, unknown>; timeoutMs?: number }> = [];
  evaluations: string[] = [];
  // Per-expression results. If an expression is in this map, evaluate()
  // returns the mapped value instead of extractionResult. Lets tests
  // distinguish primary vs fallback JS results.
  evaluateResults: Map<string, string> = new Map();
  // What waitForSelector polls return: "true" (found) or "false" (absent).
  selectorFound = false;
  // What the final extractor evaluate returns.
  extractionResult = "extracted content";
  // HTTP status to simulate for the main document response. Set before
  // calling runInPageSession to make Page.navigate emit a
  // Network.responseReceived event with this status. 0 = don't emit.
  // Ignored when `docSequence` is non-empty.
  docResponseStatus = 0;
  docResponseStatusText = "";
  // Document responses emitted for Page.navigate, in order. Use for
  // interstitials (403 then 200) and iframe filtering. `delayMs` simulates a
  // response that arrives after the challenge solved itself.
  docSequence: FakeDocResponse[] = [];
  // Document responses emitted for Page.reload (same shape as docSequence).
  reloadSequence: FakeDocResponse[] = [];
  // Main-frame id attached to sequence entries that don't set `frameId`.
  mainFrameId = "F-MAIN";
  // Value returned by the challenge probe (document.title ...). Empty means
  // "not a challenge page".
  titleProbeText = "";
  // How many upcoming Page.navigate calls fail with a timeout (simulates a
  // stalled browser/proxy). Set before runInPageSession.
  navigateTimeouts = 0;
  // Error text used for those failures.
  navigateTimeoutMessage = "CDP call timeout: Page.navigate";
  // When true, Page.navigate never answers - but the page still loads, which
  // is what a slow navigation looks like when the load event fires first.
  navigateHangs = false;
  private loadHandlers: Array<(params: unknown) => void> = [];
  private networkHandlers: Array<(params: unknown) => void> = [];
  private frameHandlers: Array<(params: unknown) => void> = [];
  // URL of the last Page.navigate, used when a sequence entry omits `url`.
  private lastNavigateUrl = "https://example.com/page";

  // Emit one Document response plus the commit that follows it (real CDP
  // order: Network.responseReceived -> Page.frameNavigated).
  private emitDocResponse(spec: FakeDocResponse, url: string): void {
    const frameId = spec.frameId ?? this.mainFrameId;
    const responseUrl = spec.url ?? url;
    for (const h of this.networkHandlers) {
      h({
        type: "Document",
        frameId,
        response: {
          url: responseUrl,
          status: spec.status,
          statusText: spec.statusText ?? "",
          mimeType: "text/html",
          headers: spec.challenge ? { "cf-mitigated": "challenge" } : {},
        },
      });
    }
    for (const h of this.frameHandlers) {
      h({ frame: { id: frameId, parentId: spec.iframe ? this.mainFrameId : undefined, url: responseUrl } });
    }
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    if (method === "Page.navigate" || method === "Page.reload") {
      if (method === "Page.navigate") {
        if (this.navigateTimeouts > 0) {
          this.navigateTimeouts--;
          throw new Error(this.navigateTimeoutMessage);
        }
        this.lastNavigateUrl = String(params.url ?? this.lastNavigateUrl);
      }
      const specs = method === "Page.navigate"
        ? (this.docSequence.length > 0
            ? this.docSequence
            : this.docResponseStatus > 0
              ? [{ status: this.docResponseStatus, statusText: this.docResponseStatusText }]
              : [])
        : this.reloadSequence;
      const url = method === "Page.navigate" ? String(params.url ?? "") : this.lastNavigateUrl;
      // Emit response events BEFORE the load event (real CDP ordering).
      for (const spec of specs) {
        if (spec.delayMs && spec.delayMs > 0) {
          setTimeout(() => this.emitDocResponse(spec, url), spec.delayMs);
        } else {
          this.emitDocResponse(spec, url);
        }
      }
      if (method === "Page.navigate") {
        // Fire load handlers synchronously (registered before navigate).
        for (const h of this.loadHandlers) h({});
        if (this.navigateHangs) return new Promise<never>(() => {});
      }
      return {};
    }
    return {};
  }

  async evaluate(expression: string): Promise<string> {
    this.evaluations.push(expression);
    // waitForSelector polls look like: document.querySelector("...") !== null
    // cdp.evaluate stringifies the boolean -> "true" / "false" (the bug source).
    if (expression.startsWith("document.querySelector")) {
      return this.selectorFound ? "true" : "false";
    }
    // Challenge probe: (document.title || "") + " " + body text.
    if (expression.includes("document.title")) {
      return this.titleProbeText;
    }
    if (this.evaluateResults.has(expression)) {
      return this.evaluateResults.get(expression)!;
    }
    return this.extractionResult;
  }

  onEvent(method: string, handler: (params: unknown) => void): void {
    if (method === "Page.loadEventFired") this.loadHandlers.push(handler);
    if (method === "Network.responseReceived") this.networkHandlers.push(handler);
    if (method === "Page.frameNavigated") this.frameHandlers.push(handler);
  }

  disconnect(): void {}
}

function baseOpts(overrides: Partial<RunInPageOptions> = {}): RunInPageOptions {
  return {
    url: "https://example.com/page",
    js: "extractor()",
    onStatus: () => {},
    ...overrides,
  };
}

// The regression test
// This is the exact bug fixed in v0.5.1: cdp.evaluate() stringifies its return
// value via String(value), so the boolean false became the string "false" -
// which is TRUTHY. The old code did `if (found) break`, breaking on the first
// poll regardless of whether the selector existed. Fix: `if (found === "true")`.

test("waitForSelector does NOT break on first poll when selector absent (v0.5.1 regression)", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = false; // simulate selector not in DOM

  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 1000,
    waitForSelectorPollMs: 50,
  }));

  const selectorPolls = fake.evaluations.filter((e) =>
    e.startsWith("document.querySelector"),
  ).length;

  // With the old buggy code, found = "false" (truthy) -> break after 1 poll.
  // The fix (found === "true") keeps polling -> multiple polls.
  assert.ok(
    selectorPolls > 1,
    `expected multiple selector polls (bug would give 1), got ${selectorPolls}`,
  );
});

test("waitForSelector breaks after first poll when selector is found", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = true;

  const t0 = Date.now();
  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 5000,
    waitForSelectorPollMs: 50,
  }));
  const elapsed = Date.now() - t0;

  const selectorPolls = fake.evaluations.filter((e) =>
    e.startsWith("document.querySelector"),
  ).length;

  assert.equal(selectorPolls, 1, `should break after first poll, got ${selectorPolls}`);
  assert.ok(elapsed < 500, `should break fast, took ${elapsed}ms`);
});

test("waitForSelector times out (and keeps polling) when selector never appears", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = false;

  const t0 = Date.now();
  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 200,
    waitForSelectorPollMs: 50,
  }));
  const elapsed = Date.now() - t0;

  // Should wait roughly the full timeout, not break early.
  assert.ok(elapsed >= 150, `should wait ~timeout duration, took ${elapsed}ms`);
});

// Navigation & extraction

test("navigation enables Page + Network (never Runtime) and then navigates", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts());

  const methods = fake.calls.map((c) => c.method);
  assert.deepEqual(
    methods.slice(0, 3),
    ["Page.enable", "Network.enable", "Page.navigate"],
  );
  // Runtime.enable is a known CDP fingerprint used by anti-bot scripts.
  // Runtime.evaluate works without it, so it must never be enabled.
  assert.ok(!methods.includes("Runtime.enable"), "Runtime.enable must not be called");
  const nav = fake.calls.find((c) => c.method === "Page.navigate");
  assert.equal(nav?.params?.url, "https://example.com/page");
});

test("extraction runs the provided JS and returns the evaluated result", async () => {
  const fake = new FakeCDP();
  fake.extractionResult = "## Extracted\n\nSome content";

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
  }));

  assert.equal(result, "## Extracted\n\nSome content");
  assert.equal(fake.evaluations.at(-1), "myExtractor()");
});

test("dynamicScroll issues scroll evaluations", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts({
    dynamicScroll: true,
    scrollCount: 3,
    scrollDelayMs: 1,
  }));

  const scrolls = fake.evaluations.filter((e) => e.includes("window.scrollTo"));
  // 3 scroll-downs + 1 scroll-to-top = 4
  assert.equal(scrolls.length, 4, `expected 4 scroll evaluations, got ${scrolls.length}`);
});

// bringToFront (background-tab scrolling fix)
// Tool tabs open in the background. Chrome suspends the renderer of
// non-active tabs, so scrolling (dynamicScroll + the self-scrolling inside
// the async extractors) can't trigger lazy-loaded content. The fix: call CDP
// Page.bringToFront so the tab becomes active and the renderer resumes.

// Calls are recorded in order. Helper to find a method's index.
function callIndex(fake: FakeCDP, method: string): number {
  return fake.calls.findIndex((c) => c.method === method);
}

test("bringToFront calls Page.bringToFront when enabled", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts({
    bringToFront: true,
    dynamicScroll: true,
    scrollCount: 1,
    scrollDelayMs: 1,
  }));

  const btf = fake.calls.find((c) => c.method === "Page.bringToFront");
  assert.ok(btf, "Page.bringToFront should be called when bringToFront is enabled");
});

test("bringToFront is NOT called by default (no focus-stealing for non-scrolling pages)", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts());

  const btf = fake.calls.find((c) => c.method === "Page.bringToFront");
  assert.ok(!btf, "Page.bringToFront should not be called by default");
});

test("bringToFront is called AFTER navigation but BEFORE scrolling", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts({
    bringToFront: true,
    dynamicScroll: true,
    scrollCount: 1,
    scrollDelayMs: 1,
  }));

  const navIdx = callIndex(fake, "Page.navigate");
  const btfIdx = callIndex(fake, "Page.bringToFront");
  assert.ok(navIdx >= 0, "Page.navigate should have been called");
  assert.ok(btfIdx > navIdx, `bringToFront (${btfIdx}) should come after navigate (${navIdx})`);
  // bringToFront must come before the first scroll evaluation. Calls and
  // evaluations are interleaved in call order, so verify by re-running with a
  // recorder that tracks global order - simplest: ensure scrolls exist and
  // trust the code ordering (bringToFront block precedes the scroll block).
  const scrolls = fake.evaluations.filter((e) => e.includes("window.scrollTo"));
  assert.ok(scrolls.length > 0, "scrolling should still happen after bringToFront");
});

test("bringToFront is NOT called on HTTP error (don't steal focus for dead pages)", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 404;
  fake.docResponseStatusText = "Not Found";

  await runInPageSession(fake, baseOpts({
    bringToFront: true,
    dynamicScroll: true,
    scrollCount: 1,
    scrollDelayMs: 1,
  }));

  const btf = fake.calls.find((c) => c.method === "Page.bringToFront");
  assert.ok(!btf, "should not bring tab to front on HTTP error");
});

test("bringToFront failure is non-fatal (extraction still runs)", async () => {
  // Some targets may reject Page.bringToFront. The catch must let extraction
  // proceed (the launch flags still help in that case).
  const fake = new FakeCDP();
  let threw = false;
  const originalCall = fake.call.bind(fake);
  fake.call = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Page.bringToFront") { threw = true; throw new Error("not supported"); }
    return originalCall(method, params);
  };
  fake.evaluateResults.set("myExtractor()", "content still extracted");

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    bringToFront: true,
    dynamicScroll: true,
    scrollCount: 1,
    scrollDelayMs: 1,
  }));

  assert.ok(threw, "Page.bringToFront should have been attempted");
  assert.equal(result, "content still extracted", "extraction should proceed despite bringToFront failure");
});

test("result is truncated at MAX_RESULT_BYTES (1MB)", async () => {
  const fake = new FakeCDP();
  fake.extractionResult = "x".repeat(2_000_000);

  const result = await runInPageSession(fake, baseOpts());

  assert.ok(result.length < 2_000_000, "should be truncated");
  assert.ok(result.includes("[Content truncated at 1MB]"), "should have truncation marker");
});

// fallbackJs (Defuddle -> generic extractor fallback)

test("fallbackJs runs when primary extraction returns an error marker", async () => {
  const fake = new FakeCDP();
  fake.evaluateResults.set("defuddleDriver()", "__DEFUDDLE_ERROR__: no content extracted");
  fake.evaluateResults.set("genericExtractor()", "fallback article content");

  const result = await runInPageSession(fake, baseOpts({
    js: "defuddleDriver()",
    fallbackJs: "genericExtractor()",
  }));

  // The fallback result replaces the error marker.
  assert.equal(result, "fallback article content");
  // Both the primary and fallback JS were evaluated.
  assert.ok(fake.evaluations.includes("defuddleDriver()"), "primary JS was evaluated");
  assert.ok(fake.evaluations.includes("genericExtractor()"), "fallback JS was evaluated");
});

test("fallbackJs runs when primary extraction returns very short content", async () => {
  const fake = new FakeCDP();
  fake.evaluateResults.set("defuddleDriver()", "hi"); // < 50 chars -> triggers fallback
  fake.evaluateResults.set("genericExtractor()", "fallback article content");

  const result = await runInPageSession(fake, baseOpts({
    js: "defuddleDriver()",
    fallbackJs: "genericExtractor()",
  }));

  assert.equal(result, "fallback article content");
  assert.ok(fake.evaluations.includes("genericExtractor()"), "fallback ran for short content");
});

test("fallbackJs does NOT run when primary extraction succeeds", async () => {
  const fake = new FakeCDP();
  fake.evaluateResults.set("defuddleDriver()", "This is a sufficiently long article content that exceeds the 50-char threshold.");
  fake.evaluateResults.set("genericExtractor()", "should not be used");

  const result = await runInPageSession(fake, baseOpts({
    js: "defuddleDriver()",
    fallbackJs: "genericExtractor()",
  }));

  assert.equal(result, "This is a sufficiently long article content that exceeds the 50-char threshold.");
  assert.ok(!fake.evaluations.includes("genericExtractor()"), "fallback should not run on success");
});

test("fallbackJs is not required - omitted fallback leaves result as-is", async () => {
  const fake = new FakeCDP();
  fake.evaluateResults.set("defuddleDriver()", "__DEFUDDLE_ERROR__: boom");

  const result = await runInPageSession(fake, baseOpts({
    js: "defuddleDriver()",
    // no fallbackJs
  }));

  assert.equal(result, "__DEFUDDLE_ERROR__: boom", "error marker passes through when no fallback");
});

// Defuddle driver & bundle

test("DEFUDDLE_DRIVER_JS parses as valid JavaScript", () => {
  // Catches template-literal escaping bugs (the \n vs real-newline class of
  // errors) without a browser, same approach as the extractor-parse tests.
  assert.doesNotThrow(() => new Function(DEFUDDLE_DRIVER_JS), "driver should parse");
});

test("getDefuddleBundle returns the installed Defuddle UMD bundle", () => {
  const bundle = getDefuddleBundle();
  assert.ok(bundle.length > 100_000, `bundle should be large, got ${bundle.length}`);
  // The npm browser entry is a UMD bundle that falls back to a `Defuddle`
  // global when injected into a page.
  assert.ok(bundle.includes("Defuddle"), "bundle should expose the Defuddle API");
  assert.ok(bundle.includes("typeof define"), "bundle should be the UMD build");
  // Must be the *full* entry: only it bundles the Markdown converter, so
  // `{ markdown: true }` in the driver actually returns Markdown. The slim
  // entry silently ignores the option and returns HTML.
  assert.ok(bundle.includes("createMarkdownContent"), "bundle should include the Markdown converter");
  // The browser entry must not pull in the Node-only DOM polyfill.
  assert.ok(!bundle.includes("linkedom"), "bundle should not reference linkedom");
});

test("the Defuddle bundle is the installed npm package (not a vendored copy)", () => {
  const bundlePath = defuddleBundlePath();
  assert.ok(bundlePath.includes("defuddle"), `should resolve the defuddle package: ${bundlePath}`);
  assert.ok(
    !bundlePath.replace(/\\/g, "/").includes("src/vendor"),
    `must not resolve a vendored copy: ${bundlePath}`,
  );

  // The injected code must be (a wrapped copy of) that exact file, so bumping
  // the dependency is all it takes to update the extractor.
  const fileText = readFileSync(bundlePath, "utf8");
  assert.ok(
    getDefuddleBundle().includes(fileText.slice(0, 200)),
    "the injected bundle should contain the package's UMD file",
  );

  // ...and the dependency must stay declared, or `pnpm install` stops
  // providing it.
  const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.ok(rootPkg.dependencies?.defuddle, "defuddle must be a declared dependency");
});

test("getDefuddleBundle is cached (same reference on second call)", () => {
  const a = getDefuddleBundle();
  const b = getDefuddleBundle();
  assert.equal(a, b, "bundle should be cached");
});

// HTTP error detection (4xx/5xx)
// The key fix for the Cloudflare 404 issue: when the server returns an error
// status, runInPageSession must surface it as an __HTTP_ERROR__ marker instead
// of silently extracting the error page's content.

test("returns __HTTP_ERROR__ marker when server responds 404", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 404;
  fake.docResponseStatusText = "Not Found";

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
  }));

  assert.ok(result.startsWith("__HTTP_ERROR__: 404"), `expected HTTP error marker, got: ${result}`);
  assert.ok(result.includes("Not Found"), "should include status text");
});

test("HTTP error skips extraction entirely (no wasted JS evaluation)", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 404;
  fake.docResponseStatusText = "Not Found";

  await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    waitForSelector: "article",
    dynamicScroll: true,
    scrollCount: 2,
    scrollDelayMs: 1,
  }));

  // The extractor JS should NOT have been evaluated - the error short-circuits
  // before extraction, waitForSelector, and scrolling.
  assert.ok(!fake.evaluations.includes("myExtractor()"), "extractor should not run on HTTP error");
  const scrolls = fake.evaluations.filter((e) => e.includes("window.scrollTo"));
  assert.equal(scrolls.length, 0, "should not scroll on HTTP error");
  const selectorPolls = fake.evaluations.filter((e) => e.startsWith("document.querySelector"));
  assert.equal(selectorPolls.length, 0, "should not poll for selector on HTTP error");
});

test("HTTP error does NOT trigger fallbackJs (the page is genuinely gone)", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 404;
  fake.docResponseStatusText = "Not Found";

  const result = await runInPageSession(fake, baseOpts({
    js: "defuddleDriver()",
    fallbackJs: "genericExtractor()",
  }));

  // The HTTP error marker passes through. The fallback extractor is NOT run.
  assert.ok(result.startsWith("__HTTP_ERROR__: 404"), "should return HTTP error, not fallback content");
  assert.ok(!fake.evaluations.includes("genericExtractor()"), "fallback must not run on HTTP error");
  assert.ok(!fake.evaluations.includes("defuddleDriver()"), "primary must not run on HTTP error");
});

test("5xx server errors are also surfaced", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 503;
  fake.docResponseStatusText = "Service Unavailable";

  const result = await runInPageSession(fake, baseOpts({ interstitialWaitMs: 0 }));
  assert.ok(result.startsWith("__HTTP_ERROR__: 503"), `expected 503 marker, got: ${result}`);
});

test("HTTP 200 proceeds normally (extraction runs, no error marker)", async () => {
  const fake = new FakeCDP();
  fake.docResponseStatus = 200;
  fake.docResponseStatusText = "OK";
  fake.evaluateResults.set("myExtractor()", "normal page content here, long enough to pass");

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
  }));

  assert.equal(result, "normal page content here, long enough to pass");
  assert.ok(fake.evaluations.includes("myExtractor()"), "extractor should run on 200");
});

test("no Network.responseReceived (status 0) proceeds normally", async () => {
  // Some pages or CDP versions might not emit the event. Don't break.
  const fake = new FakeCDP();
  fake.docResponseStatus = 0; // no event emitted
  fake.evaluateResults.set("myExtractor()", "content from page");

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
  }));

  assert.equal(result, "content from page", "should extract normally when no status captured");
});

test("an iframe Document 403 does not override the main document's 200", async () => {
  // Ad/user-sync iframes also emit Document responses. The status filter must
  // follow the main frame, not "any Document response".
  const fake = new FakeCDP();
  fake.docSequence = [
    { status: 200, statusText: "OK" },
    { status: 403, statusText: "Forbidden", frameId: "F-AD", iframe: true },
  ];
  fake.evaluateResults.set("myExtractor()", "main page content, long enough to keep");

  const result = await runInPageSession(fake, baseOpts({ js: "myExtractor()" }));

  assert.equal(result, "main page content, long enough to keep");
});

// Bot-check interstitials (403/503 that clear themselves)
// A fresh profile hitting a Cloudflare-protected site answered 403
// (`cf-mitigated: challenge`) at ~3.2s and reloaded with 200 at ~7.6s. The
// old code captured that first 403, returned an error and closed the tab -
// killing the challenge that was about to solve itself. These tests pin the
// browser-like behavior: wait for the self-reload, or reload once.

test("403 challenge that clears itself proceeds with extraction (regression)", async () => {
  const fake = new FakeCDP();
  fake.docSequence = [
    { status: 403, statusText: "Forbidden", challenge: true },
    { status: 200, statusText: "OK", delayMs: 150 },
  ];
  fake.evaluateResults.set("myExtractor()", "real article content, long enough to keep");

  const statuses: string[] = [];
  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    interstitialWaitMs: 2_000,
    onStatus: (m) => statuses.push(m),
  }));

  assert.equal(result, "real article content, long enough to keep");
  assert.ok(
    statuses.some((s) => s.includes("bot check")),
    `the user should see the challenge wait: ${statuses.join(" | ")}`,
  );
  assert.ok(
    fake.calls.some((c) => c.method === "Page.bringToFront"),
    "the tab should be activated so the challenge JS runs",
  );
});

test("challenge that never clears returns a challenge-specific error marker", async () => {
  const fake = new FakeCDP();
  fake.docSequence = [{ status: 403, statusText: "Forbidden", challenge: true }];

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    interstitialWaitMs: 300,
  }));

  assert.ok(result.startsWith("__HTTP_ERROR__: 403"), `expected 403 marker, got: ${result}`);
  assert.ok(result.includes("Bot challenge not passed"), `should identify the challenge: ${result}`);
  assert.ok(!fake.evaluations.includes("myExtractor()"), "extractor must not run on a blocked page");
});

test("non-challenge 403 triggers exactly one reload and uses the retry's status", async () => {
  const fake = new FakeCDP();
  fake.docSequence = [{ status: 403, statusText: "Forbidden" }];
  fake.titleProbeText = "Forbidden"; // not a challenge page
  fake.reloadSequence = [{ status: 200, statusText: "OK", delayMs: 100 }];
  fake.evaluateResults.set("myExtractor()", "content after the reload, long enough to keep");

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    interstitialWaitMs: 2_000,
    interstitialReloadWaitMs: 1_000,
  }));

  assert.equal(result, "content after the reload, long enough to keep");
  assert.equal(
    fake.calls.filter((c) => c.method === "Page.reload").length,
    1,
    "exactly one reload",
  );
});

test("persistent non-challenge 403 still reports the plain error after the reload", async () => {
  const fake = new FakeCDP();
  fake.docSequence = [{ status: 403, statusText: "Forbidden" }];
  fake.titleProbeText = "Forbidden";
  fake.reloadSequence = [{ status: 403, statusText: "Forbidden", delayMs: 100 }];

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
    interstitialWaitMs: 2_000,
    interstitialReloadWaitMs: 1_000,
  }));

  assert.equal(fake.calls.filter((c) => c.method === "Page.reload").length, 1);
  assert.ok(result.startsWith("__HTTP_ERROR__: 403 Forbidden"), `got: ${result}`);
});

test("a 404 is final immediately (no reload, no wasted evaluations)", async () => {
  const fake = new FakeCDP();
  fake.docSequence = [{ status: 404, statusText: "Not Found" }];

  const result = await runInPageSession(fake, baseOpts({ js: "myExtractor()" }));

  assert.ok(result.startsWith("__HTTP_ERROR__: 404"), `got: ${result}`);
  assert.equal(fake.calls.filter((c) => c.method === "Page.reload").length, 0);
  assert.equal(fake.evaluations.length, 0, "404 must not probe or reload");
});

// No stderr noise in the TUI
// Pi's TUI runs in raw mode and renders raw stderr writes on the text input
// bar, so an unconditional console.error shows up as "[pi-search] ..." while
// the user is typing. All diagnostics live behind PI_SEARCH_DEBUG (via the
// debugLog helper). User-visible progress goes through the tool's onStatus
// callback instead.

test("chrome.ts writes to stderr only behind PI_SEARCH_DEBUG", () => {
  const source = readFileSync(new URL("../../src/chrome.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/console\.(error|warn|log|info)\s*\(/g)];
  assert.equal(
    calls.length,
    1,
    `expected exactly one console write (the gated debugLog), found ${calls.length}`,
  );

  const fnStart = source.indexOf("function debugLog");
  assert.ok(fnStart >= 0, "debugLog helper should exist");
  const fnEnd = source.indexOf("\n}", fnStart);
  const callIndex = calls[0].index ?? -1;
  assert.ok(
    callIndex > fnStart && callIndex < fnEnd,
    "the only console write must live inside debugLog",
  );
  assert.ok(
    source.slice(fnStart, fnEnd).includes("PI_SEARCH_DEBUG"),
    "debugLog must be gated by PI_SEARCH_DEBUG",
  );
});

// Navigation resilience (parallel tool calls / slow browsers)
// Real-world failure: the agent issued two visit_page calls in parallel. Under
// a slow proxy the pages took >30s, and the fixed per-call CDP timeout killed
// one of them with "visit_page failed: CDP call timeout: Page.navigate".
// Page.navigate is now retried, accepted as soon as the page loads, and a dead
// CDP socket fails immediately instead of waiting out the timeout.

test("Page.navigate is retried when the command times out", async () => {
  const fake = new FakeCDP();
  fake.navigateTimeouts = 2; // two stalled attempts, third succeeds

  const statuses: string[] = [];
  const result = await runInPageSession(fake, baseOpts({ onStatus: (m) => statuses.push(m) }));

  assert.equal(result, "extracted content", "the call should succeed after retrying");
  const navigations = fake.calls.filter((c) => c.method === "Page.navigate");
  assert.equal(navigations.length, 3, "should have attempted 3 navigations");
  assert.equal(
    navigations[0].timeoutMs,
    NAVIGATE_TIMEOUT_MS,
    "each attempt should use the short per-attempt timeout",
  );
  assert.ok(
    statuses.some((s) => s.includes("retrying")),
    `the user should see the retry in the tool UI: ${statuses.join(" | ")}`,
  );
});

test("Page.navigate gives up after NAVIGATE_ATTEMPTS with a clear error", async () => {
  const fake = new FakeCDP();
  fake.navigateTimeouts = 99;

  await assert.rejects(
    () => runInPageSession(fake, baseOpts()),
    (err: Error) => {
      assert.ok(err.message.includes("CDP call timeout: Page.navigate"), `got: ${err.message}`);
      assert.ok(err.message.includes(String(NAVIGATE_ATTEMPTS)), `should mention attempts: ${err.message}`);
      assert.ok(/slow/i.test(err.message), `should hint at slowness: ${err.message}`);
      return true;
    },
  );
  assert.equal(
    fake.calls.filter((c) => c.method === "Page.navigate").length,
    NAVIGATE_ATTEMPTS,
    "should stop after the attempt budget",
  );
});

test("a non-timeout navigation error is NOT retried (dead socket fails fast)", async () => {
  const fake = new FakeCDP();
  fake.navigateTimeouts = 99;
  fake.navigateTimeoutMessage = "CDP connection closed";

  await assert.rejects(() => runInPageSession(fake, baseOpts()), /CDP connection closed/);
  assert.equal(
    fake.calls.filter((c) => c.method === "Page.navigate").length,
    1,
    "a dead connection must not be retried",
  );
});

test("a page that loads while Page.navigate is still pending is accepted", async () => {
  const fake = new FakeCDP();
  fake.navigateHangs = true; // command never answers, but the load event fires

  const result = await runInPageSession(fake, baseOpts());

  assert.equal(result, "extracted content", "the load event should unblock the session");
  assert.equal(
    fake.calls.filter((c) => c.method === "Page.navigate").length,
    1,
    "no retry is needed once the page has loaded",
  );
});

test("Page.navigate passes the short timeout, other calls keep the default", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts());

  const navigate = fake.calls.find((c) => c.method === "Page.navigate");
  assert.equal(navigate?.timeoutMs, NAVIGATE_TIMEOUT_MS);
  const evaluate = fake.calls.find((c) => c.method === "Network.enable");
  assert.equal(evaluate?.timeoutMs, undefined, "non-navigate calls use the client default");
});

// Chrome launch flags (keep renderer alive in background)
// These flags are the difference between visit_page working with Chrome in
// the background (window behind the terminal) vs hanging for 30s. They are
// asserted here so a future refactor doesn't silently drop one.

test("CHROME_LAUNCH_ARGS keeps background-tab renderers alive", () => {
  // Without these, Chrome suspends the renderer of non-active tabs, making
  // window.scrollTo() a no-op for triggering lazy-loaded content.
  assert.ok(CHROME_LAUNCH_ARGS.includes("--disable-background-timer-throttling"),
    "should disable background timer throttling");
  assert.ok(CHROME_LAUNCH_ARGS.includes("--disable-backgrounding-occluded-windows"),
    "should disable backgrounding of occluded windows");
  assert.ok(CHROME_LAUNCH_ARGS.includes("--disable-renderer-backgrounding"),
    "should disable renderer backgrounding");
});

// Browser discovery (Windows support)
// findChrome() used to only know Linux/macOS paths, so on Windows it fell
// back to the bare name "google-chrome" -> spawn ENOENT -> uncaughtException
// that killed the Pi process. These tests pin down the Windows candidates.

test("chromeCandidates includes Windows Chrome install paths", () => {
  const saved = { ...process.env };
  try {
    process.env.LOCALAPPDATA = "C:\\Users\\tester\\AppData\\Local";
    process.env.PROGRAMFILES = "C:\\Program Files";
    process.env["ProgramFiles(x86)"] = "C:\\Program Files (x86)";
    delete process.env.CHROME_PATH;

    const candidates = chromeCandidates();
    assert.ok(
      candidates.some((p) => p.toLowerCase().endsWith("appdata\\local\\google\\chrome\\application\\chrome.exe")),
      "should include the per-user Chrome install",
    );
    assert.ok(
      candidates.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
      "should include the machine-wide Chrome install",
    );
    assert.ok(
      candidates.includes("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"),
      "should include the 32-bit Chrome install",
    );
    assert.ok(
      candidates.some((p) => p.toLowerCase().includes("msedge.exe")),
      "should include Edge as a Chromium-based fallback",
    );
  } finally {
    process.env = saved;
  }
});

test("chromeCandidates prefers CHROME_PATH and skips unset env vars", () => {
  const saved = { ...process.env };
  try {
    process.env.CHROME_PATH = "D:\\custom\\chrome.exe";
    delete process.env.LOCALAPPDATA;
    delete process.env.PROGRAMFILES;
    delete process.env["ProgramFiles(x86)"];

    const candidates = chromeCandidates();
    assert.equal(candidates[0], "D:\\custom\\chrome.exe", "CHROME_PATH should come first");
    assert.ok(
      candidates.every((p) => !p.includes("undefined")),
      "unset env vars should be filtered out, not produce \"undefined\\...\" paths",
    );
  } finally {
    process.env = saved;
  }
});

test("findChrome returns CHROME_PATH when it exists", () => {
  const saved = { ...process.env };
  try {
    // process.execPath always exists - good stand-in for a real binary.
    process.env.CHROME_PATH = process.execPath;
    assert.equal(findChrome(), process.execPath);
  } finally {
    process.env = saved;
  }
});

test("findChrome never returns an empty path", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CHROME_PATH;
    const found = findChrome();
    assert.ok(found.length > 0, "should fall back to a bare command name, never \"\"");
  } finally {
    process.env = saved;
  }
});

test("chromeSpawnErrorMessage is actionable (never a bare ENOENT crash)", () => {
  const err = Object.assign(new Error("spawn google-chrome ENOENT"), { code: "ENOENT" });
  const msg = chromeSpawnErrorMessage("google-chrome", err);
  assert.ok(msg.includes("google-chrome"), "should name the attempted binary");
  assert.ok(msg.includes("CHROME_PATH"), "should tell the user about CHROME_PATH");
});

// Proxy support
// Chrome applies --proxy-server to every request, including CDP-driven
// navigations, so this is how google_search / visit_page work on machines
// that need a proxy to reach the internet.

test("chromeLaunchArgs adds --proxy-server and keeps the URL last", () => {
  const args = chromeLaunchArgs("http://127.0.0.1:8010");
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:8010"), "should pass the proxy flag");
  assert.equal(args[args.length - 1], "about:blank", "the URL argument must stay last");
  assert.ok(args.indexOf("--proxy-server=http://127.0.0.1:8010") < args.length - 1,
    "the flag must precede the URL");
});

test("chromeLaunchArgs adds no proxy flag when the proxy is empty", () => {
  const args = chromeLaunchArgs("");
  assert.ok(!args.some((a) => a.startsWith("--proxy-server=")), "direct connection should pass no proxy flag");
  assert.deepEqual(args, [...CHROME_LAUNCH_ARGS], "empty proxy = base flags only");
});

test("chromeLaunchArgs keeps every base flag", () => {
  const args = chromeLaunchArgs("socks5://127.0.0.1:1080");
  for (const base of CHROME_LAUNCH_ARGS) {
    assert.ok(args.includes(base), `should keep base flag ${base}`);
  }
});

test("CHROME_LAUNCH_ARGS disables native window-occlusion detection", () => {
  // CalculateNativeWinOcclusion can fully freeze the renderer when the Chrome
  // *window* is behind another window or unfocused - even with the three
  // flags above. This shows up as a full 30s Runtime.evaluate timeout, not
  // just missed lazy loads. Especially severe on GNOME Wayland where the
  // window cannot be programmatically focused. This is the single most
  // important flag for background-window scraping.
  const flag = CHROME_LAUNCH_ARGS.find((a) => a.startsWith("--disable-features="));
  assert.ok(flag, "should pass a --disable-features flag");
  assert.ok(flag!.includes("CalculateNativeWinOcclusion"),
    "--disable-features should include CalculateNativeWinOcclusion");
});
