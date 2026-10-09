import { describe, expect, it } from "vitest";
import { ApiNetworkError, ApiRequestError } from "./api-request.js";
import { shouldRetryStatusPoll, statusPollDelay } from "./polling.js";

describe("status polling retry policy", () => {
  it("stops when the requested resource is missing or gone", () => {
    expect(shouldRetryStatusPoll(new ApiRequestError("Run not found.", 404))).toBe(false);
    expect(shouldRetryStatusPoll(new ApiRequestError("Project was purged.", 410))).toBe(false);
  });

  it("retries transient HTTP and fetch failures", () => {
    expect(shouldRetryStatusPoll(new ApiRequestError("Deletion is in progress.", 409))).toBe(true);
    expect(shouldRetryStatusPoll(new ApiRequestError("Request timed out.", 408))).toBe(true);
    expect(shouldRetryStatusPoll(new ApiRequestError("Too many requests.", 429))).toBe(true);
    expect(shouldRetryStatusPoll(new ApiRequestError("Service unavailable.", 503))).toBe(true);
    expect(shouldRetryStatusPoll(new ApiNetworkError())).toBe(true);
    expect(shouldRetryStatusPoll(new TypeError("Malformed status response."))).toBe(false);
  });

  it("stops retrying permanent client errors", () => {
    expect(shouldRetryStatusPoll(new ApiRequestError("Unauthorized.", 401))).toBe(false);
    expect(shouldRetryStatusPoll(new ApiRequestError("Invalid request.", 422))).toBe(false);
    expect(shouldRetryStatusPoll(new Error("Lab returned an invalid response."))).toBe(false);
  });

  it("backs off repeated transient failures and returns to the normal cadence after recovery", () => {
    expect(statusPollDelay(0)).toBe(1_500);
    expect(statusPollDelay(1)).toBe(1_500);
    expect(statusPollDelay(2)).toBe(3_000);
    expect(statusPollDelay(3)).toBe(6_000);
    expect(statusPollDelay(20)).toBe(30_000);
    expect(statusPollDelay(0, "pending-evidence")).toBe(60_000);
    expect(statusPollDelay(2, "pending-evidence")).toBe(120_000);
    expect(statusPollDelay(20, "pending-evidence")).toBe(5 * 60_000);
  });
});
