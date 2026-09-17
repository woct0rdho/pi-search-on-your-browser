import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGoogleRedirectUrl,
  findGoogleRedirectUrls,
  replaceGoogleRedirects,
  resolveGoogleRedirectsInBrowser,
  type GoogleRedirectCdp,
} from "../../src/google-links.ts";

// Google result links now use `/goto?url=<Tink-encrypted token>`, which cannot
// be decoded offline; the direct URL only comes back when the 302 is followed.
// These tests cover the pure parsing/replacement plus the CDP-driven resolver
// (with a fake CDP client — no browser, no network).

const GOTO = "https://www.google.com/goto?url=CAESabcDEF";
const URL_Q = "https://www.google.es/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=U";

test("isGoogleRedirectUrl: matches /url and /goto on google hosts", () => {
  assert.equal(isGoogleRedirectUrl(GOTO), true);
  assert.equal(isGoogleRedirectUrl(URL_Q), true);
  assert.equal(isGoogleRedirectUrl("https://www.google.com/url?url=https%3A%2F%2Fa.com"), true);
  assert.equal(isGoogleRedirectUrl("https://www.google.com/url/"), true, "trailing slash");
  assert.equal(isGoogleRedirectUrl("https://www.google.co.jp/goto?url=abc"), true);
});

test("isGoogleRedirectUrl: rejects non-redirect and non-Google URLs", () => {
  for (const url of [
    "https://accounts.google.com/ServiceLogin",
    "https://support.google.com/websearch/answer/181196",
    "https://www.google.com/search?q=test",
    "https://www.googleadservices.com/pagead/aclk?sa=L",
    "https://example.com/url?q=https%3A%2F%2Fa.com",
    "https://example.com/goto?url=abc",
    "not a url",
    "",
  ]) {
    assert.equal(isGoogleRedirectUrl(url), false, `${JSON.stringify(url)} should not match`);
  }
});

test("findGoogleRedirectUrls: dedupes, keeps order, ignores other links", () => {
  const markdown = [
    "# Google search results",
    "",
    "- [First](https://example.com/direct)",
    `- [Result A](${GOTO})`,
    `- [Result B](${URL_Q})`,
    "- [Again A](https://www.google.com/goto?url=CAESabcDEF)",
    "- [Google nav](https://www.google.com/search?q=test)",
    "",
  ].join("\n");

  assert.deepEqual(findGoogleRedirectUrls(markdown), [GOTO, URL_Q]);
});

test("replaceGoogleRedirects: swaps mapped URLs and leaves the rest alone", () => {
  const markdown = [
    `- [A](${GOTO})`,
    `- [B](${URL_Q})`,
    "- [C](https://example.com/direct)",
  ].join("\n");

  const resolved = new Map([[GOTO, "https://example.com/a"]]);
  const out = replaceGoogleRedirects(markdown, resolved);

  assert.ok(out.includes("- [A](https://example.com/a)"));
  assert.ok(out.includes(`- [B](${URL_Q})`), "unresolved redirect must stay");
  assert.ok(out.includes("- [C](https://example.com/direct)"));
});

test("replaceGoogleRedirects: no-op with an empty map", () => {
  const markdown = `- [A](${GOTO})`;
  assert.equal(replaceGoogleRedirects(markdown, new Map()), markdown);
});

/** One redirect hop: wrapper → destination, optionally via a Location header. */
interface RedirectHop {
  from: string;
  to: string;
  /** When set, the resolver should prefer this over `to` (header path). */
  location?: string;
}

/**
 * Fake CDP. The first `evaluate` (the fetch trigger) emits the prepared
 * `Network.requestWillBeSent` redirect events; later calls (the abort script)
 * emit nothing.
 */
function fakeCdp(hops: RedirectHop[] = []) {
  const handlers = new Map<string, Array<(params: unknown) => void>>();
  const cdp: GoogleRedirectCdp & { evaluated: string[] } = {
    evaluated: [],
    async evaluate(expression: string) {
      cdp.evaluated.push(expression);
      if (!expression.includes("__piRedirectAborts=[]")) return "0";
      for (const hop of hops) {
        for (const handler of handlers.get("Network.requestWillBeSent") ?? []) {
          handler({
            request: { url: hop.to },
            redirectResponse: {
              url: hop.from,
              headers: hop.location === undefined ? {} : { location: hop.location },
            },
          });
        }
      }
      return String(hops.length);
    },
    onEvent(method, handler) {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
    },
  };
  return cdp;
}

test("resolveGoogleRedirectsInBrowser: swaps in the followed destination", async () => {
  const cdp = fakeCdp([
    { from: GOTO, to: "https://example.com/from-goto" },
    { from: URL_Q, to: "https://example.com/from-url" },
    // A redirect hop for a URL that is not pending must be ignored.
    { from: "https://www.google.com/goto?url=other", to: "https://ignored.example" },
  ]);

  const markdown = `- [A](${GOTO})\n- [B](${URL_Q})`;
  const out = await resolveGoogleRedirectsInBrowser(cdp, markdown);

  assert.ok(out.includes("- [A](https://example.com/from-goto)"), out);
  assert.ok(out.includes("- [B](https://example.com/from-url)"), out);
  assert.equal(cdp.evaluated.length, 2, "trigger + abort");
  assert.ok(cdp.evaluated[0].includes("redirect:'follow'"), "the fetch must follow the 302");
  assert.ok(cdp.evaluated[1].includes("abort()"), "destination downloads must be aborted");
});

test("resolveGoogleRedirectsInBrowser: prefers the Location header when present", async () => {
  const cdp = fakeCdp([
    { from: GOTO, to: "https://www.google.com/goto?url=unexpected", location: "/sorry/index" },
  ]);
  const out = await resolveGoogleRedirectsInBrowser(cdp, `- [A](${GOTO})`);

  assert.ok(out.includes("- [A](https://www.google.com/sorry/index)"), out);
});

test("resolveGoogleRedirectsInBrowser: no redirect links → no page evaluation", async () => {
  const cdp = fakeCdp([]);
  const markdown = "- [A](https://example.com/direct)";
  const out = await resolveGoogleRedirectsInBrowser(cdp, markdown);

  assert.equal(out, markdown);
  assert.equal(cdp.evaluated.length, 0);
});

test("resolveGoogleRedirectsInBrowser: keeps unresolved links and reports them", async () => {
  // No redirect events at all: the resolver times out and must not drop links.
  const cdp = fakeCdp([]);
  const statuses: string[] = [];
  const out = await resolveGoogleRedirectsInBrowser(cdp, `- [A](${GOTO})`, {
    timeoutMs: 30,
    pollMs: 5,
    onStatus: (msg) => statuses.push(msg),
  });

  assert.equal(out, `- [A](${GOTO})`, "the /goto link is still visitable — never dropped");
  assert.ok(statuses.some((s) => s.includes("could not be resolved")), statuses.join(" | "));
});

test("resolveGoogleRedirectsInBrowser: a failed trigger leaves the markdown unchanged", async () => {
  const cdp: GoogleRedirectCdp = {
    async evaluate() {
      throw new Error("page is gone");
    },
    onEvent() {
      // no-op
    },
  };

  const markdown = `- [A](${GOTO})`;
  assert.equal(await resolveGoogleRedirectsInBrowser(cdp, markdown), markdown);
});
