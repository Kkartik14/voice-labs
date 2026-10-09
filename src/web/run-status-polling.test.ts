import { describe, expect, it } from "vitest";
import { buildExperimentRunStatusUrl } from "./run-status-polling.js";

describe("buildExperimentRunStatusUrl", () => {
  it("requests reconciliation even when the visible recent page has no active runs", () => {
    expect(buildExperimentRunStatusUrl("exp-1", "rev-2", [])).toBe(
      "/api/experiments/exp-1/run-status?revision_id=rev-2",
    );
  });

  it("includes only visible active run IDs for exact status reconciliation", () => {
    expect(buildExperimentRunStatusUrl("exp-1", "rev-2", [
      { id: "run-active", status: "running" },
      { id: "run-done", status: "passed" },
    ])).toBe(
      "/api/experiments/exp-1/run-status?revision_id=rev-2&run_id=run-active",
    );
  });
});
