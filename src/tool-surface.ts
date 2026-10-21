// Agent-facing text + parameter schema for `visit_page` - description, prompt
// snippet, prompt guidelines, and parameter descriptions.
//
// The two features are each controlled by a config flag:
//   - `summaryEnabled` - the `summary: true` subagent mode.
//   - `cleanEnabled`   - the `clean: true` Defuddle reader-mode extraction.
//
// `visitPageSurface()` and `visitPageParameters()` build the text and schema for
// the current flags: a disabled feature is invisible to the model - no string
// may mention it and its parameter is dropped from the schema. Keeping this
// here makes it testable for every combination.

import { Type } from "typebox";

export interface VisitPageOptions {
  summaryEnabled: boolean;
  cleanEnabled: boolean;
}

export interface VisitPageSurface {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  // Present only when summary mode is enabled.
  summaryParamDescription?: string;
  // Present only when clean mode is enabled.
  cleanParamDescription?: string;
}

const DESCRIPTION_BASE =
  "Open a URL in your visible Chrome and return the rendered page as Markdown. Uses your real browser session, so authenticated pages work.";

const SNIPPET_BASE = "Open a URL in your visible browser. Returns markdown.";

const CLEAN_GUIDELINE =
  "Pass `clean: true` for articles/docs (main content only). `false` for dashboards/indexes, or when you need nav/footer links.";

const SUMMARY_GUIDELINE =
  "Pass `summary: true` for large pages you only need summarized. `false` when you need exact text or the page is small.";

const RESEARCH_GUIDELINE =
  "For multi-page research, combine `clean: true` + `summary: true`.";

const CLEAN_PARAM_DESCRIPTION =
  "Extract only the main article content (drops nav, ads, footer). Best for articles/docs. `false` on dashboards/index pages without a single main content. Falls back to the default extraction.";

const SUMMARY_PARAM_BASE =
  "Read the page with a subagent and return only a concise summary. The full markdown stays out of your context. Set `false` when you need verbatim text or the page is small.";

// Build the agent-facing visit_page surface for the current config.
//
// A disabled feature is omitted from every string. Interactions: the clean +
// summary research guideline appears only when both features are enabled.
// The description and snippet stay constant - the schema already explains each
// option, so repeating it here would only cost tokens.
export function visitPageSurface(options: VisitPageOptions): VisitPageSurface {
  const surface: VisitPageSurface = {
    description: DESCRIPTION_BASE,
    promptSnippet: SNIPPET_BASE,
    promptGuidelines: [],
  };

  if (options.cleanEnabled) {
    surface.promptGuidelines.push(CLEAN_GUIDELINE);
    surface.cleanParamDescription = CLEAN_PARAM_DESCRIPTION;
  }
  if (options.summaryEnabled) {
    surface.promptGuidelines.push(SUMMARY_GUIDELINE);
    surface.summaryParamDescription = SUMMARY_PARAM_BASE;
  }
  if (options.summaryEnabled && options.cleanEnabled) {
    surface.promptGuidelines.push(RESEARCH_GUIDELINE);
  }

  return surface;
}

// The `visit_page` parameter schema for the current config.
//
// An enabled feature's parameter is required. A disabled one is removed from
// both `properties` and `required`, so the schema stays valid and never asks
// for a hidden feature. The static type keeps both parameters: a disabled
// feature's key is absent at run time, so index.ts reads them only behind their
// config flag (`stripDisabledArguments` drops stale arguments before
// validation).
export function visitPageParameters(options: VisitPageOptions) {
  const surface = visitPageSurface(options);
  const parameters = Type.Object({
    url: Type.String({ description: "Full URL to visit" }),
    clean: Type.Boolean({ description: surface.cleanParamDescription ?? "" }),
    summary: Type.Boolean({ description: surface.summaryParamDescription ?? "" }),
  });

  const shape = parameters as unknown as { properties?: Record<string, unknown>; required?: string[] };
  const drop = (key: "clean" | "summary") => {
    if (shape.properties) delete shape.properties[key];
    if (shape.required) shape.required = shape.required.filter((name) => name !== key);
  };
  if (!options.cleanEnabled) drop("clean");
  if (!options.summaryEnabled) drop("summary");

  return parameters;
}

// Drop arguments for disabled features before schema validation.
//
// When a feature is off its property is not part of the tool's parameter
// schema, so a model that still sends it (e.g. from earlier conversation
// context) must not fail validation - and must not trigger the feature. This
// runs as the tool's `prepareArguments` shim.
export function stripDisabledArguments(
  args: unknown,
  options: VisitPageOptions,
): { url: string; clean?: boolean; summary?: boolean } {
  const source: Record<string, unknown> =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  if (!options.summaryEnabled) delete source.summary;
  if (!options.cleanEnabled) delete source.clean;
  return source as { url: string; clean?: boolean; summary?: boolean };
}
