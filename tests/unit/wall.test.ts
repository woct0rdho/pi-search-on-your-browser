import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWall, gateFromSources, looksNavOnly, markdownProseLength, type WallState } from "../../src/extractors.ts";

// classifyWall() decides whether a settled page is a wall instead of content.
// The rules are deliberately conservative: every rule needs a short page, so a
// long article that merely mentions "Access Denied" stays content.

function state(overrides: Partial<WallState> = {}): WallState {
  return {
    href: "https://example.com/",
    title: "",
    len: 1000,
    head: "some page text",
    captcha: false,
    password: false,
    scripts: 3,
    images: 0,
    ...overrides,
  };
}

test("classifyWall: ordinary content is not a wall", () => {
  assert.equal(classifyWall(state()), null);
  assert.equal(classifyWall(state({ title: "An article about walls" })), null);
  // A long page that mentions a bot check is still content.
  assert.equal(
    classifyWall(state({ title: "Access Denied: a postmortem", len: 9000, head: "Just a moment! We fixed it." })),
    null,
  );
  // A reCAPTCHA embedded in a long contact page is not a wall.
  assert.equal(classifyWall(state({ captcha: true, len: 4000, head: "Contact us" })), null);
});

test("classifyWall: bot-check interstitials (served with 200)", () => {
  // Fastly "Client Challenge" (pypi.org): empty body, telling title.
  assert.equal(classifyWall(state({ title: "Client Challenge", len: 0, head: "" })), "challenge");
  // Cloudflare
  assert.equal(classifyWall(state({ title: "Just a moment...", len: 0 })), "challenge");
  // Fastly mid-check: title still there, body says it is verifying.
  assert.equal(
    classifyWall(state({ title: "Client Challenge", len: 28, head: "is verifying your browser..." })),
    "challenge",
  );
  // Body-only signal.
  assert.equal(
    classifyWall(state({ title: "example.com", len: 100, head: "Checking your browser before accessing" })),
    "challenge",
  );
  // Long pages are not interstitials even with that wording.
  assert.equal(classifyWall(state({ title: "Just a moment...", len: 3000 })), null);
});

test("classifyWall: CAPTCHA gates", () => {
  // jbovlaste: form with a reCAPTCHA widget plus one heading.
  assert.equal(
    classifyWall(state({ len: 25, head: "Login To Skip This Step", captcha: true })),
    "captcha",
  );
  assert.equal(classifyWall(state({ len: 600, head: "Verify you are human", captcha: true })), "captcha");
  // A page that merely EMBEDS a Turnstile widget (nowsecure.nl) is content.
  assert.equal(
    classifyWall(state({ len: 43, head: "NOWSECURE BY NODRIVER", captcha: true })),
    null,
  );
  // A long page with a CAPTCHA in a form is content.
  assert.equal(classifyWall(state({ len: 4000, head: "Contact us", captcha: true })), null);
});

test("classifyWall: wording that is specific to an interstitial", () => {
  // Cloudflare's newer wording ("Verifying you are human").
  assert.equal(
    classifyWall(state({ title: "example.com", len: 120, head: "Verifying you are human. This may take a few seconds." })),
    "challenge",
  );
  assert.equal(
    classifyWall(state({ len: 90, head: "Please complete the security check to access this site." })),
    "challenge",
  );
  // Generic wording that also appears in articles must NOT be enough.
  for (const head of [
    "你是真人吗？这是一个关于验证码的说明，讲的是滑块和语音验证码的差别。",
    "Human verification systems are described in this short note about CAPTCHAs.",
    "Are you a robot? This page explains how CAPTCHAs work in practice.",
    "A security check is all this paragraph is about, nothing more to see.",
    // A site's own check wording is not catalogued either: the general
    // short-page watch in chrome.ts handles pages like this one.
    "Automated bot check in progress This should only take a few seconds.",
  ]) {
    assert.equal(classifyWall(state({ len: 130, head })), null, head);
  }
});

test("classifyWall: gates identified by their scripts", () => {
  // Cloudflare managed challenge (vgmdb.net).
  assert.equal(
    classifyWall(state({ len: 255, head: "", gate: gateFromSources(["vgmdb.net/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=x"]) })),
    "challenge",
  );
  // Fastly challenge (pypi.org).
  assert.equal(classifyWall(state({ len: 0, head: "", gate: gateFromSources(["pypi.org/_fs-ch-1T1wmsGaOgGaSxcX/script.js"]) })), "challenge");
  // A slider gate is a CAPTCHA, and it never clears by waiting.
  assert.equal(
    classifyWall(state({ len: 110, head: "安全验证 请确认您不是机器人", gate: gateFromSources(["cstaticdun.126.net/load.min.js"]) })),
    "captcha",
  );
  // Short page, no wording: nothing to go on without infrastructure.
  assert.equal(classifyWall(state({ len: 43, head: "NOWSECURE BY NODRIVER", gate: "" })), null);
});

test("gateFromSources: widgets and detectors are not gates", () => {
  // nowsecure.nl embeds Turnstile in its own page and is content.
  assert.equal(gateFromSources(["challenges.cloudflare.com/turnstile/v0/api.js"]), "");
  assert.equal(gateFromSources(["static.cloudflareinsights.com/beacon.min.js"]), "");
  // Cloudflare injects its JS detector into ordinary pages.
  assert.equal(gateFromSources(["example.com/cdn-cgi/challenge-platform/scripts/jsd/main.js"]), "");
  // Contact forms embed reCAPTCHA / hCaptcha.
  assert.equal(gateFromSources(["www.google.com/recaptcha/api.js"]), "");
  assert.equal(gateFromSources(["js.hcaptcha.com/1/api.js"]), "");
  // Case is ignored, and a match anywhere in the list wins.
  assert.equal(gateFromSources(["https://CDN-CGI.evil/x", "a/_Incapsula_Resource?x=1"]), "challenge");
  assert.equal(gateFromSources([]), "");
});

test("classifyWall: slider wording only counts on a very short page", () => {
  const head = "请确认您不是机器人 向右拖动滑块填充拼图";
  assert.equal(classifyWall(state({ len: 110, head })), "captcha");
  // An article (or a long FAQ) about sliders is content.
  assert.equal(classifyWall(state({ len: 1200, head })), null);
});

test("looksNavOnly: chrome without a body", () => {
  const nav = Array.from({ length: 16 }, (_, i) => `- [首页 ${i}](https://example.com/${i})`).join("\n");
  assert.equal(looksNavOnly(nav), true);
  // A real article with a few links is not nav-only.
  assert.equal(looksNavOnly(`${nav}\n${'A real paragraph. '.repeat(60)}`), false);
  // A short page with two links (404, sign-in) is not nav-only either.
  assert.equal(looksNavOnly("## PAGE NOT FOUND\n[Take me home](https://example.com/)"), false);
});

test("markdownProseLength: link targets and markup do not count", () => {
  assert.equal(markdownProseLength("[ab](https://example.com/very/long/path)"), 2);
  assert.equal(markdownProseLength("## Title\n\nSome **prose** here."), "Titlesomeprosehere.".length);
});

test("classifyWall: login forms", () => {
  assert.equal(
    classifyWall(state({ len: 120, head: "Sign in to continue", password: true })),
    "login",
  );
  // No password field -> not a login wall.
  assert.equal(classifyWall(state({ len: 120, head: "Sign in to continue" })), null);
  // Long pages with a password field are content (e.g. an admin dashboard).
  assert.equal(classifyWall(state({ len: 5000, password: true })), null);
});

test("classifyWall: JavaScript shells", () => {
  // lensisku.lojban.org: nav text plus "Loading...".
  assert.equal(
    classifyWall(state({ title: "Lojban Dictionary", len: 36, head: "Lens Learn Activity More Loading..." })),
    "shell",
  );
  assert.equal(classifyWall(state({ len: 20, head: "Loading..." })), "shell");
  // Empty body but scripts present: a shell, not an empty page.
  assert.equal(classifyWall(state({ len: 0, head: "", scripts: 5 })), "shell");
  // An empty page without scripts (e.g. an image URL) is not a shell.
  assert.equal(classifyWall(state({ len: 0, head: "", scripts: 0 })), null);
  // An image-only page (a gallery) has no text either, but it is content.
  assert.equal(classifyWall(state({ len: 0, head: "", scripts: 5, images: 12 })), null);
  // A normal short page is not a shell.
  assert.equal(classifyWall(state({ len: 180, head: "Example Domain. This domain is for use in examples." })), null);
});
