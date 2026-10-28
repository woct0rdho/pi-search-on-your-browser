import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForShortPageGrowth } from "../../src/chrome.ts";

// waitForShortPageGrowth() is the vendor-agnostic half of wall handling: a
// short document that is still rewriting itself is a placeholder (a bot check
// whose wording nobody catalogued, a consent stub, a client-rendered page),
// while a genuinely short page (404, sign-in stub, link list) does not move.

function fakePage(states: Array<{ len: number; kind?: string; scripts?: number }>) {
  let i = 0;
  const seen: string[] = [];
  const cdp = {
    async evaluate(expression: string): Promise<string> {
      if (expression.includes("document.scripts.length")) {
        const scripts = states[Math.min(i, states.length - 1)].scripts ?? 3;
        return String(scripts);
      }
      if (expression.includes("/* pi-short-page */")) {
        const s = states[Math.min(i, states.length - 1)];
        i++;
        seen.push(String(s.len));
        return `${s.kind ?? "body"}|complete|${s.len}|https://example.com/page`;
      }
      throw new Error(`unexpected probe: ${expression}`);
    },
  };
  return { cdp, seen, probes: () => i };
}

test("a short page that grows is reported as still rendering", async () => {
  const { cdp } = fakePage([{ len: 150 }, { len: 150 }, { len: 9000 }]);
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 2_000 }), true);
});

test("a short page that blanks for a reload counts as still rendering", async () => {
  const { cdp } = fakePage([{ len: 150 }, { len: 0 }]);
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 2_000 }), true);
});

test("a short page that never moves is taken as final", async () => {
  const { cdp, probes } = fakePage([{ len: 150 }]);
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 700 }), false);
  assert.ok(probes() >= 2, "it watched for a while before giving up");
});

test("a long page is not watched at all", async () => {
  const { cdp, probes } = fakePage([{ len: 4000 }]);
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 5_000 }), false);
  assert.equal(probes(), 1, "one probe, no waiting");
});

test("a short page without scripts is not watched", async () => {
  const { cdp, probes } = fakePage([{ len: 120, scripts: 0 }]);
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 5_000 }), false);
  assert.equal(probes(), 1, "nothing can render without scripts");
});

test("an unreadable document state is not treated as growth", async () => {
  const cdp = { async evaluate(): Promise<string> { return "not-a-state"; } };
  assert.equal(await waitForShortPageGrowth(cdp, { timeoutMs: 200 }), false);
});
