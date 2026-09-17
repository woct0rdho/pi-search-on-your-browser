import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VISIT_PAGE_DESCRIPTION_WITH_SUMMARY,
  VISIT_PAGE_DESCRIPTION_WITHOUT_SUMMARY,
  VISIT_PAGE_PROMPT_SNIPPET_WITH_SUMMARY,
  VISIT_PAGE_PROMPT_SNIPPET_WITHOUT_SUMMARY,
  VISIT_PAGE_GUIDELINES_WITH_SUMMARY,
  VISIT_PAGE_GUIDELINES_WITHOUT_SUMMARY,
  stripSummaryArgument,
} from "../../src/tool-surface.ts";

// These strings are the agent-facing surface of visit_page. When summary mode
// is off (`summaryEnabled: false` / PI_BROWSE_SUMMARY_ENABLED=0 / /browse off)
// the model must not learn that a summary option exists — that is what the
// WITHOUT variants are for. index.ts also drops the `summary` parameter from
// the schema; the smoke path is covered via prepareArguments below.

test("without-summary surface never mentions summarization or /browse", () => {
  const hidden = [
    VISIT_PAGE_DESCRIPTION_WITHOUT_SUMMARY,
    VISIT_PAGE_PROMPT_SNIPPET_WITHOUT_SUMMARY,
    ...VISIT_PAGE_GUIDELINES_WITHOUT_SUMMARY,
  ];
  for (const text of hidden) {
    assert.ok(!/summar/i.test(text), `hidden surface must not mention summary: ${text}`);
    assert.ok(!/\/browse/.test(text), `hidden surface must not point at /browse: ${text}`);
  }
});

test("with-summary surface does advertise the summary option", () => {
  assert.match(VISIT_PAGE_DESCRIPTION_WITH_SUMMARY, /summary/i);
  assert.match(VISIT_PAGE_PROMPT_SNIPPET_WITH_SUMMARY, /summary/i);
  assert.ok(VISIT_PAGE_GUIDELINES_WITH_SUMMARY.some((g) => /summary/i.test(g)));
});

test("without-summary variants are the shared base minus summary additions", () => {
  // The two variants must not silently diverge on the non-summary text.
  assert.ok(
    VISIT_PAGE_DESCRIPTION_WITH_SUMMARY.startsWith(VISIT_PAGE_DESCRIPTION_WITHOUT_SUMMARY),
    "description without summary should be a prefix of the full description",
  );
  assert.ok(
    VISIT_PAGE_PROMPT_SNIPPET_WITH_SUMMARY.startsWith(VISIT_PAGE_PROMPT_SNIPPET_WITHOUT_SUMMARY),
    "snippet without summary should be a prefix of the full snippet",
  );
  for (const guideline of VISIT_PAGE_GUIDELINES_WITHOUT_SUMMARY) {
    assert.ok(
      VISIT_PAGE_GUIDELINES_WITH_SUMMARY.includes(guideline),
      `full guidelines should still include: ${guideline.slice(0, 60)}...`,
    );
  }
});

test("both variants keep the site-specific guidance", () => {
  for (const surface of [VISIT_PAGE_GUIDELINES_WITH_SUMMARY, VISIT_PAGE_GUIDELINES_WITHOUT_SUMMARY]) {
    const joined = surface.join("\n");
    for (const site of ["X (Twitter)", "Reddit", "Amazon", "Google Scholar"]) {
      assert.ok(joined.includes(site), `guidelines should mention ${site}`);
    }
    assert.ok(surface.some((g) => g.includes("`clean`")), "guidelines should document clean");
  }
});

test("stripSummaryArgument: removes a stale summary argument", () => {
  assert.deepEqual(stripSummaryArgument({ url: "https://example.com", summary: true }), {
    url: "https://example.com",
  });
  assert.deepEqual(
    stripSummaryArgument({ url: "https://example.com", clean: true, summary: false }),
    { url: "https://example.com", clean: true },
  );
});

test("stripSummaryArgument: leaves other arguments untouched and does not mutate the input", () => {
  const input = { url: "https://example.com", clean: true };
  const output = stripSummaryArgument(input);
  assert.deepEqual(output, input);

  const withSummary = { url: "https://example.com", summary: true };
  stripSummaryArgument(withSummary);
  assert.equal(withSummary.summary, true, "the original object must not be mutated");
});

test("stripSummaryArgument: tolerates non-object input", () => {
  assert.deepEqual(stripSummaryArgument(null), {});
  assert.deepEqual(stripSummaryArgument(undefined), {});
  assert.deepEqual(stripSummaryArgument("nonsense"), {});
});
