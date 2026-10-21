import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWall, type WallState } from "../../src/extractors.ts";

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
