import { describe, expect, it } from "vitest";
import { resolveApiRequestUrl } from "./api-url.js";

describe("Voice Labs feature API URL resolution", () => {
  it("keeps the feature API prefix when the host uses a same-origin BFF", () => {
    expect(resolveApiRequestUrl("/api/voice-labs", "/api/experiments/exp_1/run?revision_id=rev_2", "https://platform.example"))
      .toBe("https://platform.example/api/voice-labs/api/experiments/exp_1/run?revision_id=rev_2");
  });

  it("allows a standalone host to use an explicit API origin", () => {
    expect(resolveApiRequestUrl("https://voice-labs.example/prefix", "/api/bootstrap", "https://platform.example"))
      .toBe("https://voice-labs.example/prefix/api/bootstrap");
  });

  it("rejects request paths that could escape the configured API base", () => {
    expect(() => resolveApiRequestUrl("/api/voice-labs", "https://evil.example/api/bootstrap", "https://platform.example"))
      .toThrow("Voice Labs API requests must use a relative /api path.");
    expect(() => resolveApiRequestUrl("/api/voice-labs", "/api/../projects/purge", "https://platform.example"))
      .toThrow("Voice Labs API request path is invalid.");
  });
});
