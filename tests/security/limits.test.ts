import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, resolveLimits } from "../../src/limits.js";
import { withTimeout } from "../../src/tool-registry.js";

describe("limits", () => {
  it("uses the spec Section 7.2 defaults as the single source of truth", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxBytesPerFile: 64 * 1024,
      maxFilesPerRead: 20,
      maxFilesPerSession: 200,
      maxContextBytes: 512 * 1024,
      maxSearchResults: 50,
      maxMatchPreviewBytes: 4 * 1024,
      maxDiffBytes: 256 * 1024,
      toolTimeoutMs: 15000,
      codexExecTimeoutMs: 1_800_000,
      proConsultTimeoutMs: 600_000
    });
  });

  it("allows config overrides without mutating defaults", () => {
    expect(resolveLimits({ maxSearchResults: 7 })).toMatchObject({
      maxSearchResults: 7,
      maxBytesPerFile: DEFAULT_LIMITS.maxBytesPerFile
    });
    expect(DEFAULT_LIMITS.maxSearchResults).toBe(50);
  });

  it("honors toolTimeoutMs through the shared tool timeout wrapper", async () => {
    await expect(
      withTimeout(new Promise((resolve) => setTimeout(() => resolve("late"), 25)), 1)
    ).rejects.toThrow("tool timed out after 1ms");
  });
});
