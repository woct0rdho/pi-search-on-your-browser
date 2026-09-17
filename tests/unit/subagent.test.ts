import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  validateReasoningLevel,
  buildReasoningParams,
  truncateForContext,
  buildMessages,
  configSummary,
  config as __config,
  normalizeProxy,
  reloadConfig,
  resolveConfig,
  saveConfigFile,
  setConfigDir,
  configPath,
  SUBAGENT_SYSTEM_PROMPT,
  type SubagentModel,
} from "../../src/subagent.ts";

// Minimal model fixtures. truncateForContext / buildReasoningParams only read
// the fields below, so a partial object is sufficient.
function model(overrides: Partial<SubagentModel> = {}): SubagentModel {
  return {
    id: "test-model",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    contextWindow: 8000,
    ...overrides,
  };
}

// ── validateReasoningLevel ────────────────────────────────────────────────

test("validateReasoningLevel: accepts all valid levels (case-insensitive)", () => {
  for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(validateReasoningLevel(lvl), lvl);
    assert.equal(validateReasoningLevel(lvl.toUpperCase()), lvl);
  }
});

test("validateReasoningLevel: rejects unknown and empty", () => {
  assert.equal(validateReasoningLevel(undefined), undefined);
  assert.equal(validateReasoningLevel(""), undefined);
  assert.equal(validateReasoningLevel("max"), undefined);
  assert.equal(validateReasoningLevel("ultra"), undefined);
});

// ── buildReasoningParams ──────────────────────────────────────────────────

test("buildReasoningParams: returns undefined for non-reasoning model", () => {
  assert.equal(buildReasoningParams(model({ reasoning: false }), "high"), undefined);
});

test("buildReasoningParams: default format uses reasoning_effort", () => {
  const params = buildReasoningParams(model({ reasoning: true }), "high");
  assert.deepEqual(params, { reasoning_effort: "high" });
});

test("buildReasoningParams: default format with 'off' returns undefined (not reasoning_effort: 'off')", () => {
  // 'off' must not be sent as reasoning_effort — many APIs (vLLM, OpenAI)
  // reject it. Mirror pi: don't send the param when reasoning is off.
  const params = buildReasoningParams(model({ reasoning: true }), "off");
  assert.equal(params, undefined);
});

test("buildReasoningParams: openrouter format uses reasoning.effort", () => {
  const params = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "openrouter" } }),
    "medium",
  );
  assert.deepEqual(params, { reasoning: { effort: "medium" } });
});

test("buildReasoningParams: openrouter format with 'off' sends effort: 'none'", () => {
  // Mirror pi's OpenRouter path: falsy reasoning → effort: "none".
  const params = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "openrouter" } }),
    "off",
  );
  assert.deepEqual(params, { reasoning: { effort: "none" } });
});

test("buildReasoningParams: qwen format uses enable_thinking boolean", () => {
  const on = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "qwen" } }),
    "high",
  );
  assert.deepEqual(on, { enable_thinking: true });

  const off = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "qwen" } }),
    "off",
  );
  assert.deepEqual(off, { enable_thinking: false });
});

test("buildReasoningParams: thinkingLevelMap null skips params entirely", () => {
  // Some providers mark certain levels as unsupported via null.
  const params = buildReasoningParams(
    model({ reasoning: true, thinkingLevelMap: { high: null } }),
    "high",
  );
  assert.equal(params, undefined);
});

test("buildReasoningParams: thinkingLevelMap remaps level", () => {
  const params = buildReasoningParams(
    model({ reasoning: true, thinkingLevelMap: { high: "max" } }),
    "high",
  );
  assert.deepEqual(params, { reasoning_effort: "max" });
});

// ── truncateForContext ────────────────────────────────────────────────────

test("truncateForContext: returns content unchanged when it fits", () => {
  const m = model({ contextWindow: 8000 }); // ~lots of room
  const content = "x".repeat(1000);
  const out = truncateForContext(content, m, 2048);
  assert.equal(out.truncated, false);
  assert.equal(out.content, content);
  assert.equal(out.originalChars, 1000);
});

test("truncateForContext: truncates when content exceeds context window", () => {
  // Tiny context window forces truncation.
  const m = model({ contextWindow: 500 });
  const content = "x".repeat(10_000);
  const out = truncateForContext(content, m, 256);
  assert.equal(out.truncated, true);
  assert.equal(out.originalChars, 10_000);
  assert.ok(out.content.length < 10_000, "truncated content should be smaller");
  assert.ok(
    out.content.includes("truncated to fit"),
    "should append a truncation notice",
  );
});

test("truncateForContext: reserves room for maxTokens", () => {
  // Same content + context window, but larger maxTokens → less room for content.
  const m = model({ contextWindow: 4000 });
  const content = "y".repeat(20_000);
  const small = truncateForContext(content, m, 256);
  const large = truncateForContext(content, m, 3000);
  // Larger maxTokens reservation → smaller available content budget.
  assert.ok(
    large.content.length <= small.content.length,
    `larger maxTokens should leave less room (got ${large.content.length} vs ${small.content.length})`,
  );
});

test("truncateForContext: empty content passes through untouched", () => {
  const out = truncateForContext("", model({ contextWindow: 1000 }), 100);
  assert.equal(out.truncated, false);
  assert.equal(out.content, "");
  assert.equal(out.originalChars, 0);
});

// ── buildMessages ─────────────────────────────────────────────────────────

test("buildMessages: produces system + user messages with URL and content", () => {
  const msgs = buildMessages("https://example.com/page", "Hello world");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, SUBAGENT_SYSTEM_PROMPT);
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[1].content.includes("https://example.com/page"));
  assert.ok(msgs[1].content.includes("Hello world"));
  assert.ok(msgs[1].content.includes("PAGE CONTENT"));
  assert.ok(msgs[1].content.includes("Summarize"));
});

test("buildMessages: content is wrapped between delimiters", () => {
  const msgs = buildMessages("https://ex.com", "BODY");
  const user = msgs[1].content;
  const before = user.indexOf("---\n");
  const after = user.indexOf("\n---", before + 1);
  assert.ok(before >= 0, "opening delimiter missing");
  assert.ok(after > before, "closing delimiter missing");
  assert.ok(user.slice(before + 4, after).includes("BODY"), "content not between delimiters");
});

// ── configSummary: current-model fallback ─────────────────────────────────
// The key behavior change in v0.7: when no provider/model is pinned, the
// subagent reuses the current session model — configSummary should make that
// visible instead of showing "(not set)".

test("configSummary: shows current model when no override is configured", () => {
  __config.provider = undefined;
  __config.model = undefined;
  reloadConfig();
  const summary = configSummary({ provider: "openai", id: "gpt-4o", name: "GPT-4o" });
  assert.ok(summary.includes("openai/gpt-4o"), "should show current model");
  assert.ok(summary.includes("current model"), "should label it as the current model");
  assert.ok(!summary.includes("(not set)"), "should not say not-set when a current model exists");
});

test("configSummary: shows pinned override when provider+model are configured", () => {
  __config.provider = "anthropic";
  __config.model = "claude-3-5-haiku";
  const summary = configSummary({ provider: "openai", id: "gpt-4o" });
  // The Model line should show the override, not the current model.
  const modelLine = summary.split("\n").find((l) => l.includes("Model:"));
  assert.ok(modelLine?.includes("anthropic/claude-3-5-haiku"), `model line should show override: ${modelLine}`);
  assert.ok(!modelLine?.includes("current model"), "override should not be labeled current");
  // cleanup
  __config.provider = undefined;
  __config.model = undefined;
});

test("configSummary: shows (none) when no override and no current model", () => {
  __config.provider = undefined;
  __config.model = undefined;
  reloadConfig();
  const summary = configSummary(undefined);
  assert.ok(summary.includes("(none"), "should indicate no model available");
});

// ── Chrome proxy configuration ────────────────────────────────────────────
// The proxy is handed to Chrome as --proxy-server when the browser is
// launched (see chrome.ts), so on machines that need a proxy to reach the
// internet google_search / visit_page keep working. These tests pin down how
// the value is read, validated, and written.

test("normalizeProxy: accepts URLs and bare host:port", () => {
  assert.equal(normalizeProxy("http://127.0.0.1:8010"), "http://127.0.0.1:8010");
  assert.equal(normalizeProxy("  http://127.0.0.1:8010/  "), "http://127.0.0.1:8010",
    "trailing slash and whitespace should be normalized away");
  assert.equal(normalizeProxy("127.0.0.1:8010"), "http://127.0.0.1:8010",
    "a bare host:port should default to http");
  assert.equal(normalizeProxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080",
    "socks proxies should pass through");
  assert.equal(normalizeProxy("http://user:pass@proxy.internal:3128"), "http://user:pass@proxy.internal:3128",
    "credentials should be preserved");
});

test("normalizeProxy: off switches and invalid values yield undefined", () => {
  for (const v of ["", "  ", "off", "OFF", "none", "direct", "false", "0"]) {
    assert.equal(normalizeProxy(v), undefined, `"${v}" should mean \"no proxy\"`);
  }
  for (const v of ["not a url", "http://", ":8080", undefined, 42, null]) {
    assert.equal(normalizeProxy(v), undefined, `${JSON.stringify(v)} should be rejected`);
  }
});

/** Run `fn` with the config file pointed at a throwaway agent dir. */
function withTempConfigDir(fn: (dir: string) => void): void {
  const originalDir = dirname(configPath());
  const originalProxyEnv = process.env.PI_SEARCH_PROXY;
  const originalSummaryEnv = process.env.PI_BROWSE_SUMMARY_ENABLED;
  const originalCleanEnv = process.env.PI_BROWSE_CLEAN_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), "pi-search-cfg-"));
  try {
    setConfigDir(dir);
    delete process.env.PI_SEARCH_PROXY;
    delete process.env.PI_BROWSE_SUMMARY_ENABLED;
    delete process.env.PI_BROWSE_CLEAN_ENABLED;
    fn(dir);
  } finally {
    setConfigDir(originalDir);
    if (originalProxyEnv === undefined) delete process.env.PI_SEARCH_PROXY;
    else process.env.PI_SEARCH_PROXY = originalProxyEnv;
    if (originalSummaryEnv === undefined) delete process.env.PI_BROWSE_SUMMARY_ENABLED;
    else process.env.PI_BROWSE_SUMMARY_ENABLED = originalSummaryEnv;
    if (originalCleanEnv === undefined) delete process.env.PI_BROWSE_CLEAN_ENABLED;
    else process.env.PI_BROWSE_CLEAN_ENABLED = originalCleanEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveConfig: reads browser.proxy from the config file", () => {
  withTempConfigDir((dir) => {
    writeFileSync(
      join(dir, "search-on-your-browser.json"),
      JSON.stringify({ summaryEnabled: true, browser: { proxy: "127.0.0.1:8010" } }),
    );
    assert.equal(resolveConfig().proxy, "http://127.0.0.1:8010");
  });
});

test("resolveConfig: accepts a top-level proxy and lets the file win over the env var", () => {
  withTempConfigDir((dir) => {
    writeFileSync(
      join(dir, "search-on-your-browser.json"),
      JSON.stringify({ proxy: "socks5://127.0.0.1:1080" }),
    );
    process.env.PI_SEARCH_PROXY = "http://env-proxy:3128";
    assert.equal(resolveConfig().proxy, "socks5://127.0.0.1:1080",
      "the config file should win (so /browse changes are sticky)");
  });
});

test("resolveConfig: falls back to PI_SEARCH_PROXY, then direct", () => {
  withTempConfigDir((dir) => {
    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ summaryEnabled: true }));
    process.env.PI_SEARCH_PROXY = "http://127.0.0.1:8010";
    assert.equal(resolveConfig().proxy, "http://127.0.0.1:8010");

    delete process.env.PI_SEARCH_PROXY;
    assert.equal(resolveConfig().proxy, "", "no proxy anywhere means a direct connection");
  });
});

test("resolveConfig: tolerates a malformed config file and an invalid proxy", () => {
  withTempConfigDir((dir) => {
    writeFileSync(join(dir, "search-on-your-browser.json"), "{ this is not json");
    assert.equal(resolveConfig().proxy, "", "a malformed file behaves like a missing one");

    writeFileSync(
      join(dir, "search-on-your-browser.json"),
      JSON.stringify({ browser: { proxy: 42 } }),
    );
    assert.equal(resolveConfig().proxy, "", "an invalid proxy falls back to direct");
  });
});

test("saveConfigFile: persists the proxy under browser.proxy", () => {
  withTempConfigDir((dir) => {
    const savedProxy = __config.proxy;
    const savedSummary = __config.summaryEnabled;
    try {
      __config.proxy = "http://127.0.0.1:8010";
      __config.summaryEnabled = true;
      saveConfigFile();
      const raw = JSON.parse(readFileSync(join(dir, "search-on-your-browser.json"), "utf-8"));
      assert.equal(raw.browser.proxy, "http://127.0.0.1:8010");
      // Round-trip: what was written is what resolveConfig reads back.
      assert.equal(resolveConfig().proxy, "http://127.0.0.1:8010");
    } finally {
      __config.proxy = savedProxy;
      __config.summaryEnabled = savedSummary;
    }
  });
});

test("configSummary: shows the effective Chrome proxy", () => {
  const saved = __config.proxy;
  try {
    __config.proxy = "http://127.0.0.1:8010";
    const summary = configSummary({ provider: "openai", id: "gpt-4o" });
    const line = summary.split("\n").find((l) => l.includes("Chrome proxy:"));
    assert.ok(line?.includes("http://127.0.0.1:8010"), `proxy line should show the value: ${line}`);

    __config.proxy = "";
    const direct = configSummary({ provider: "openai", id: "gpt-4o" });
    const directLine = direct.split("\n").find((l) => l.includes("Chrome proxy:"));
    assert.ok(directLine?.includes("direct"), `proxy line should say direct: ${directLine}`);
  } finally {
    __config.proxy = saved;
  }
});

// ── summary-mode configuration (`summaryEnabled`) ─────────────────────────
// `summaryEnabled: false` does not disable visit_page — ``url``/``clean`` keep
// working — it is what makes index.ts hide the `summary` option from the model
// entirely (no parameter, no description/guideline mention). These tests pin
// down how the flag is read and what /browse reports.

test("resolveConfig: summary mode defaults to enabled", () => {
  withTempConfigDir(() => {
    assert.equal(resolveConfig().summaryEnabled, true);
  });
});

test("resolveConfig: reads summaryEnabled from the config file", () => {
  withTempConfigDir((dir) => {
    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ summaryEnabled: false }));
    assert.equal(resolveConfig().summaryEnabled, false);
  });
});

test("resolveConfig: PI_BROWSE_SUMMARY_ENABLED can disable summary mode", () => {
  withTempConfigDir(() => {
    for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.PI_BROWSE_SUMMARY_ENABLED = truthy;
      assert.equal(resolveConfig().summaryEnabled, true, `"${truthy}" should enable`);
    }
    for (const falsy of ["0", "false", "no", "off", "FALSE"]) {
      process.env.PI_BROWSE_SUMMARY_ENABLED = falsy;
      assert.equal(resolveConfig().summaryEnabled, false, `"${falsy}" should disable`);
    }
    process.env.PI_BROWSE_SUMMARY_ENABLED = "maybe";
    assert.equal(resolveConfig().summaryEnabled, true, "unparseable values fall back to the default");
  });
});

test("resolveConfig: the config file wins over PI_BROWSE_SUMMARY_ENABLED", () => {
  withTempConfigDir((dir) => {
    process.env.PI_BROWSE_SUMMARY_ENABLED = "0";
    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ summaryEnabled: true }));
    assert.equal(resolveConfig().summaryEnabled, true, "the file should win over the env var");

    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ summaryEnabled: false }));
    process.env.PI_BROWSE_SUMMARY_ENABLED = "1";
    assert.equal(resolveConfig().summaryEnabled, false, "the file should win over the env var");
  });
});

test("saveConfigFile: round-trips summaryEnabled = false", () => {
  withTempConfigDir((dir) => {
    const saved = __config.summaryEnabled;
    try {
      __config.summaryEnabled = false;
      saveConfigFile();
      const raw = JSON.parse(readFileSync(join(dir, "search-on-your-browser.json"), "utf-8"));
      assert.equal(raw.summaryEnabled, false);
      assert.equal(resolveConfig().summaryEnabled, false);
    } finally {
      __config.summaryEnabled = saved;
    }
  });
});

test("configSummary: reports summary mode as enabled by default", () => {
  const saved = __config.summaryEnabled;
  try {
    __config.summaryEnabled = true;
    const summary = configSummary({ provider: "openai", id: "gpt-4o" });
    const line = summary.split("\n").find((l) => l.includes("Summary mode:"));
    assert.ok(line?.includes("enabled"), `summary-mode line should say enabled: ${line}`);
  } finally {
    __config.summaryEnabled = saved;
  }
});

test("configSummary: reports the hidden summary option when disabled", () => {
  const saved = __config.summaryEnabled;
  try {
    __config.summaryEnabled = false;
    const summary = configSummary({ provider: "openai", id: "gpt-4o" });
    const line = summary.split("\n").find((l) => l.includes("Summary mode:"));
    assert.ok(line?.includes("disabled"), `summary-mode line should say disabled: ${line}`);
    assert.ok(/hidden from the model/i.test(summary), "should explain that the option is hidden");
  } finally {
    __config.summaryEnabled = saved;
  }
});

// ── clean-mode configuration (`cleanEnabled`) ─────────────────────────────
// Clean mode is toggled independently of summary mode: `cleanEnabled: false`
// hides the `clean` option from the model without affecting `summary` (and
// vice versa). Same resolution rules as summaryEnabled.

test("resolveConfig: clean mode defaults to enabled", () => {
  withTempConfigDir(() => {
    assert.equal(resolveConfig().cleanEnabled, true);
  });
});

test("resolveConfig: reads cleanEnabled from the config file", () => {
  withTempConfigDir((dir) => {
    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ cleanEnabled: false }));
    assert.equal(resolveConfig().cleanEnabled, false);
  });
});

test("resolveConfig: the two feature flags are independent", () => {
  withTempConfigDir((dir) => {
    writeFileSync(
      join(dir, "search-on-your-browser.json"),
      JSON.stringify({ summaryEnabled: false, cleanEnabled: true }),
    );
    assert.equal(resolveConfig().summaryEnabled, false);
    assert.equal(resolveConfig().cleanEnabled, true);

    writeFileSync(
      join(dir, "search-on-your-browser.json"),
      JSON.stringify({ summaryEnabled: true, cleanEnabled: false }),
    );
    assert.equal(resolveConfig().summaryEnabled, true);
    assert.equal(resolveConfig().cleanEnabled, false);
  });
});

test("resolveConfig: PI_BROWSE_CLEAN_ENABLED can disable clean mode", () => {
  withTempConfigDir(() => {
    for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.PI_BROWSE_CLEAN_ENABLED = truthy;
      assert.equal(resolveConfig().cleanEnabled, true, `"${truthy}" should enable`);
    }
    for (const falsy of ["0", "false", "no", "off", "FALSE"]) {
      process.env.PI_BROWSE_CLEAN_ENABLED = falsy;
      assert.equal(resolveConfig().cleanEnabled, false, `"${falsy}" should disable`);
    }
    process.env.PI_BROWSE_CLEAN_ENABLED = "maybe";
    assert.equal(resolveConfig().cleanEnabled, true, "unparseable values fall back to the default");
  });
});

test("resolveConfig: the config file wins over PI_BROWSE_CLEAN_ENABLED", () => {
  withTempConfigDir((dir) => {
    process.env.PI_BROWSE_CLEAN_ENABLED = "0";
    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ cleanEnabled: true }));
    assert.equal(resolveConfig().cleanEnabled, true, "the file should win over the env var");

    writeFileSync(join(dir, "search-on-your-browser.json"), JSON.stringify({ cleanEnabled: false }));
    process.env.PI_BROWSE_CLEAN_ENABLED = "1";
    assert.equal(resolveConfig().cleanEnabled, false, "the file should win over the env var");
  });
});

test("saveConfigFile: round-trips cleanEnabled = false", () => {
  withTempConfigDir((dir) => {
    const saved = __config.cleanEnabled;
    try {
      __config.cleanEnabled = false;
      saveConfigFile();
      const raw = JSON.parse(readFileSync(join(dir, "search-on-your-browser.json"), "utf-8"));
      assert.equal(raw.cleanEnabled, false);
      assert.equal(resolveConfig().cleanEnabled, false);
    } finally {
      __config.cleanEnabled = saved;
    }
  });
});

test("configSummary: reports clean mode on or off", () => {
  const saved = __config.cleanEnabled;
  try {
    __config.cleanEnabled = true;
    const on = configSummary({ provider: "openai", id: "gpt-4o" });
    const onLine = on.split("\n").find((l) => l.includes("Clean mode:"));
    assert.ok(onLine?.includes("enabled"), `clean-mode line should say enabled: ${onLine}`);

    __config.cleanEnabled = false;
    const off = configSummary({ provider: "openai", id: "gpt-4o" });
    const offLine = off.split("\n").find((l) => l.includes("Clean mode:"));
    assert.ok(offLine?.includes("disabled"), `clean-mode line should say disabled: ${offLine}`);
    assert.ok(/\/browse clean on/.test(off), "should point at /browse clean on");
  } finally {
    __config.cleanEnabled = saved;
  }
});
