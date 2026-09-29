import { describe, expect, it } from "vitest";
import { describeModelEnv, hasNative1m, modelEnv, parseClaudeModel, pickClaudeModels } from "../src/targets/claudeModels";

describe("parseClaudeModel", () => {
  it("reads family and version from common proxy spellings", () => {
    expect(parseClaudeModel("claude-5-sonnet")).toEqual({ family: "sonnet", version: [5, 0] });
    expect(parseClaudeModel("claude-4.5-haiku")).toEqual({ family: "haiku", version: [4, 5] });
    expect(parseClaudeModel("claude-opus-4-7")).toEqual({ family: "opus", version: [4, 7] });
    expect(parseClaudeModel("claude-sonnet-5-5")).toEqual({ family: "sonnet", version: [5, 5] });
    expect(parseClaudeModel("bedrock/anthropic.claude-sonnet-4-6-v1:0")).toEqual({ family: "sonnet", version: [4, 6] });
    expect(parseClaudeModel("claude-3-5-sonnet-20241022")).toEqual({ family: "sonnet", version: [3, 5] });
    expect(parseClaudeModel("claude-fable-5-1")).toEqual({ family: "fable", version: [5, 1] });
    expect(parseClaudeModel("gpt-5.6-terra")).toBeUndefined();
  });

  it("treats only models with a built-in 1M window as 1M", () => {
    const native = (id: string) => hasNative1m(parseClaudeModel(id)!);
    expect(native("claude-5-sonnet")).toBe(true);
    expect(native("claude-5-opus")).toBe(true);
    expect(native("claude-opus-4-7")).toBe(true);
    expect(native("claude-fable-5")).toBe(true);
    // 1M only through a beta header, which proxies may strip.
    expect(native("claude-opus-4-6")).toBe(false);
    expect(native("claude-sonnet-4-6")).toBe(false);
    expect(native("claude-4.5-haiku")).toBe(false);
  });
});

describe("pickClaudeModels", () => {
  const ids = ["claude-4.5-haiku", "claude-5-sonnet", "claude-5-opus", "claude-opus-4-6", "claude-sonnet-4-5-20250929", "gpt-6-sol"];

  it("picks the newest of each family and marks 1M models", () => {
    expect(pickClaudeModels(ids)).toEqual({
      opus: { id: "claude-5-opus", oneM: true },
      sonnet: { id: "claude-5-sonnet", oneM: true },
      haiku: { id: "claude-4.5-haiku", oneM: false },
    });
  });

  it("lets the proxy's reported context window decide", () => {
    const windows = new Map([
      ["claude-5-opus", 200_000],
      ["claude-4.5-haiku", 1_000_000],
    ]);
    const picks = pickClaudeModels(ids, windows);
    expect(picks.opus).toEqual({ id: "claude-5-opus", oneM: false });
    expect(picks.haiku).toEqual({ id: "claude-4.5-haiku", oneM: true });
    expect(picks.sonnet).toEqual({ id: "claude-5-sonnet", oneM: true });
  });

  it("prefers the shorter id on a version tie, and skips ids with unexpected characters", () => {
    expect(pickClaudeModels(["claude-sonnet-5-20260101", "claude-sonnet-5"]).sonnet?.id).toBe("claude-sonnet-5");
    expect(pickClaudeModels(["claude-9-opus](command:x)", "claude 9 opus", "claude-5-opus"]).opus?.id).toBe("claude-5-opus");
  });

  it("returns nothing for a key without Claude models", () => {
    expect(pickClaudeModels(["gpt-6-sol"])).toEqual({});
  });
});

describe("modelEnv", () => {
  const picks = pickClaudeModels(["claude-4.5-haiku", "claude-5-sonnet", "claude-5-opus"]);

  it("writes [1m] for 1M models unless turned off", () => {
    expect(modelEnv(picks, true)).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-5-opus[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-5-sonnet[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-4.5-haiku",
    });
    expect(modelEnv(picks, false).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-5-opus");
  });

  it("describes the result without brackets", () => {
    expect(describeModelEnv(modelEnv(picks, true))).toBe(
      "Models: opus → claude-5-opus (1M context), sonnet → claude-5-sonnet (1M context), haiku → claude-4.5-haiku.",
    );
    expect(describeModelEnv({})).toBe("");
  });
});
