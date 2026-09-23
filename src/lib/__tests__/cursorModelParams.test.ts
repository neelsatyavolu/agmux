import { describe, expect, it } from "vitest";
import type { CursorModel } from "../cursorSdkCommands";
import {
  cursorReasoningOptionsForModel,
  prettyCursorParamValueLabel,
} from "../cursorModelParams";

describe("prettyCursorParamValueLabel", () => {
  it("maps boolean catalog tokens to Off / On", () => {
    expect(prettyCursorParamValueLabel("false")).toBe("Off");
    expect(prettyCursorParamValueLabel("true")).toBe("On");
    expect(prettyCursorParamValueLabel("FALSE")).toBe("Off");
    expect(prettyCursorParamValueLabel("0")).toBe("Off");
    expect(prettyCursorParamValueLabel("1")).toBe("On");
  });

  it("overrides a boolean displayName", () => {
    expect(prettyCursorParamValueLabel("false", "false")).toBe("Off");
    expect(prettyCursorParamValueLabel("true", "True")).toBe("On");
  });

  it("keeps named thinking levels", () => {
    expect(prettyCursorParamValueLabel("high", "High")).toBe("High");
    expect(prettyCursorParamValueLabel("low")).toBe("low");
  });
});

describe("cursorReasoningOptionsForModel", () => {
  const opus: CursorModel = {
    slug: "claude-4.6-opus",
    name: "Opus 5",
    parameters: [
      {
        id: "thinking",
        displayName: "Thinking",
        values: [{ value: "false" }, { value: "true" }],
      },
    ],
  };

  it("labels a boolean thinking param Off / On", () => {
    const result = cursorReasoningOptionsForModel([opus], "claude-4.6-opus");
    expect(result.title).toBe("Thinking");
    expect(result.options.map((o) => o.label)).toEqual(["Off", "On"]);
    expect(result.options.map((o) => o.slug)).toEqual([
      "claude-4.6-opus?thinking=false",
      "claude-4.6-opus?thinking=true",
    ]);
    expect(result.minLabel).toBe("Off");
    expect(result.maxLabel).toBe("On");
    expect(result.currentLabel).toBeNull();
  });

  it("reads the current thinking value from the slug", () => {
    const result = cursorReasoningOptionsForModel(
      [opus],
      "claude-4.6-opus?thinking=true",
    );
    expect(result.currentLabel).toBe("On");
  });

  it("does not rewrite Low / High thinking levels", () => {
    const composer: CursorModel = {
      slug: "composer-2.5",
      name: "Composer 2.5",
      parameters: [
        {
          id: "thinking",
          displayName: "Thinking",
          values: [
            { value: "low", displayName: "Low" },
            { value: "high", displayName: "High" },
          ],
        },
      ],
    };
    const result = cursorReasoningOptionsForModel([composer], "composer-2.5");
    expect(result.options.map((o) => o.label)).toEqual(["Low", "High"]);
    expect(result.minLabel).toBeUndefined();
    expect(result.maxLabel).toBeUndefined();
  });

  it("does not bind the thinking slider to maxMode", () => {
    const composer: CursorModel = {
      slug: "composer-2.5",
      name: "Composer 2.5",
      parameters: [
        {
          id: "maxMode",
          displayName: "Max Mode",
          values: [{ value: "false" }, { value: "true" }],
        },
        {
          id: "thinking",
          displayName: "Thinking",
          values: [
            { value: "low", displayName: "Low" },
            { value: "high", displayName: "High" },
          ],
        },
      ],
    };
    const result = cursorReasoningOptionsForModel([composer], "composer-2.5");
    expect(result.title).toBe("Thinking");
    expect(result.options.map((o) => o.label)).toEqual(["Low", "High"]);
  });
});
