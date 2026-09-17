import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visitPageSurface,
  stripDisabledArguments,
  type VisitPageOptions,
} from "../../src/tool-surface.ts";

// visitPageSurface() builds the agent-facing text of visit_page from the two
// config flags. The core invariant: a disabled feature must be invisible to
// the model — no parameter, no description/guideline mention, no /browse hint
// — while the rest of the surface stays identical. index.ts drops the matching
// parameter from the schema; stripDisabledArguments covers stale arguments.

const COMBOS: VisitPageOptions[] = [
  { summaryEnabled: true, cleanEnabled: true },
  { summaryEnabled: true, cleanEnabled: false },
  { summaryEnabled: false, cleanEnabled: true },
  { summaryEnabled: false, cleanEnabled: false },
];

function allStrings(options: VisitPageOptions): string[] {
  const surface = visitPageSurface(options);
  return [
    surface.description,
    surface.promptSnippet,
    ...surface.promptGuidelines,
    surface.summaryParamDescription ?? "",
    surface.cleanParamDescription ?? "",
  ];
}

function label(options: VisitPageOptions): string {
  return `summary=${options.summaryEnabled} clean=${options.cleanEnabled}`;
}

test("each feature is mentioned iff its flag is enabled", () => {
  for (const options of COMBOS) {
    const text = allStrings(options).join("\n");
    assert.equal(
      /summar/i.test(text),
      options.summaryEnabled,
      `[${label(options)}] summary mention should match summaryEnabled`,
    );
    assert.equal(
      /\bclean\b/i.test(text),
      options.cleanEnabled,
      `[${label(options)}] clean mention should match cleanEnabled`,
    );
  }
});

test("disabled features are never hinted at via /browse", () => {
  // /browse is only mentioned in the summary strings; those must be absent
  // when summary mode is off (and the plain base never mentions it).
  for (const options of COMBOS) {
    const text = allStrings(options).join("\n");
    if (!options.summaryEnabled) {
      assert.ok(!/\/browse/.test(text), `[${label(options)}] no /browse hint`);
    }
  }
});

test("optional guidelines appear exactly when their feature (and combination) is enabled", () => {
  const summary = visitPageSurface({ summaryEnabled: true, cleanEnabled: true });
  const noSummary = visitPageSurface({ summaryEnabled: false, cleanEnabled: true });
  const noClean = visitPageSurface({ summaryEnabled: true, cleanEnabled: false });
  const neither = visitPageSurface({ summaryEnabled: false, cleanEnabled: false });

  const hasSummaryGuideline = (s: typeof summary) => s.promptGuidelines.some((g) => g.includes("accepts a `summary` flag"));
  const hasCleanGuideline = (s: typeof summary) => s.promptGuidelines.some((g) => g.includes("accepts a `clean` flag"));
  const hasResearchGuideline = (s: typeof summary) => s.promptGuidelines.some((g) => g.includes("For research tasks"));

  assert.ok(hasSummaryGuideline(summary) && hasCleanGuideline(summary) && hasResearchGuideline(summary));
  assert.ok(!hasSummaryGuideline(noSummary) && hasCleanGuideline(noSummary) && !hasResearchGuideline(noSummary));
  assert.ok(hasSummaryGuideline(noClean) && !hasCleanGuideline(noClean) && !hasResearchGuideline(noClean));
  assert.ok(!hasSummaryGuideline(neither) && !hasCleanGuideline(neither) && !hasResearchGuideline(neither));
});

test("optional parameter descriptions exist only when enabled", () => {
  for (const options of COMBOS) {
    const surface = visitPageSurface(options);
    assert.equal(
      surface.summaryParamDescription !== undefined,
      options.summaryEnabled,
      `[${label(options)}] summary param description`,
    );
    assert.equal(
      surface.cleanParamDescription !== undefined,
      options.cleanEnabled,
      `[${label(options)}] clean param description`,
    );
  }
});

test("the surface is the same base regardless of which optional features are on", () => {
  // The summary addition must be a suffix, and the core guidelines identical
  // apart from the optional ones — so the variants cannot silently diverge.
  for (const cleanEnabled of [true, false]) {
    const without = visitPageSurface({ summaryEnabled: false, cleanEnabled });
    const with_ = visitPageSurface({ summaryEnabled: true, cleanEnabled });
    assert.ok(
      with_.description.startsWith(without.description),
      `[clean=${cleanEnabled}] description base must match`,
    );
    assert.ok(
      with_.promptSnippet.startsWith(without.promptSnippet),
      `[clean=${cleanEnabled}] snippet base must match`,
    );
    for (const guideline of without.promptGuidelines) {
      assert.ok(
        with_.promptGuidelines.includes(guideline),
        `[clean=${cleanEnabled}] full surface must keep: ${guideline.slice(0, 60)}...`,
      );
    }
  }
});

test("no site-specific extractor names appear in the tool surface", () => {
  // Extraction is automatic; the model does not need to know which sites have
  // dedicated extractors. Those details belong in the user docs, not here.
  for (const options of COMBOS) {
    for (const text of allStrings(options)) {
      for (const name of ["Twitter", "Reddit", "Amazon", "Scholar", "Defuddle"]) {
        assert.ok(
          !text.includes(name),
          `[${label(options)}] should not mention ${name}: ${text}`,
        );
      }
    }
  }
});

test("the description stays minimal and grows monotonically with the flags", () => {
  const none = visitPageSurface({ summaryEnabled: false, cleanEnabled: false });
  const clean = visitPageSurface({ summaryEnabled: false, cleanEnabled: true });
  const summary = visitPageSurface({ summaryEnabled: true, cleanEnabled: false });
  const both = visitPageSurface({ summaryEnabled: true, cleanEnabled: true });

  // Minimal base: no extraction details are spelled out.
  for (const verbose of ["ASIN", "permalink", "citation count", "timestamp", "availability"]) {
    assert.ok(
      !none.description.includes(verbose),
      `base description should stay minimal (found "${verbose}")`,
    );
  }

  // Base → +clean → +summary, so the surface only grows as features are on.
  assert.ok(clean.description.startsWith(none.description));
  assert.ok(both.description.startsWith(clean.description));
  assert.ok(summary.description.startsWith(none.description));
  assert.ok(clean.description.length > none.description.length);
  assert.ok(summary.description.length > none.description.length);
  assert.ok(both.description.length > clean.description.length);
  assert.ok(both.description.length > summary.description.length);

  assert.ok(clean.promptSnippet.startsWith(none.promptSnippet));
  assert.ok(both.promptSnippet.startsWith(clean.promptSnippet));
  assert.ok(both.promptSnippet.length > none.promptSnippet.length);
});

test("stripDisabledArguments: removes exactly the disabled arguments", () => {
  const args = { url: "https://example.com", clean: true, summary: true };
  assert.deepEqual(stripDisabledArguments(args, { summaryEnabled: true, cleanEnabled: true }), args);
  assert.deepEqual(stripDisabledArguments(args, { summaryEnabled: true, cleanEnabled: false }), {
    url: "https://example.com",
    summary: true,
  });
  assert.deepEqual(stripDisabledArguments(args, { summaryEnabled: false, cleanEnabled: true }), {
    url: "https://example.com",
    clean: true,
  });
  assert.deepEqual(stripDisabledArguments(args, { summaryEnabled: false, cleanEnabled: false }), {
    url: "https://example.com",
  });
});

test("stripDisabledArguments: leaves other arguments untouched and does not mutate the input", () => {
  const input = { url: "https://example.com", clean: true, summary: true };
  const output = stripDisabledArguments(input, { summaryEnabled: false, cleanEnabled: false });
  assert.deepEqual(output, { url: "https://example.com" });
  assert.deepEqual(input, { url: "https://example.com", clean: true, summary: true }, "input must not be mutated");
});

test("stripDisabledArguments: tolerates non-object input", () => {
  const options = { summaryEnabled: false, cleanEnabled: false };
  assert.deepEqual(stripDisabledArguments(null, options), {});
  assert.deepEqual(stripDisabledArguments(undefined, options), {});
  assert.deepEqual(stripDisabledArguments("nonsense", options), {});
});
