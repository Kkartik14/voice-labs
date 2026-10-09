import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNetworkError, ApiRequestError, createApiRequester, createScopedApiRequester, StaleApiRequestError, type ApiRequester } from "./api-request.js";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("window", { location: { origin: "https://platform.example" } });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Voice Labs API requester", () => {
  it("shows the Platform BFF's actionable timeout message", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      code: "voice_labs_timeout",
      message: "Lab did not respond in time. Check the run status before retrying.",
    }), { status: 504, headers: { "content-type": "application/json" } }));

    await expect(createApiRequester("/api/voice-labs", undefined)("/api/bootstrap"))
      .rejects.toMatchObject({
        message: "Lab did not respond in time. Check the run status before retrying.",
        status: 504,
      });
  });

  it("falls back to a stable request error when the response is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream failure", { status: 502 }));

    await expect(createApiRequester("/api/voice-labs", undefined)("/api/bootstrap"))
      .rejects.toMatchObject({ message: "Request failed (502)", status: 502 });
  });

  it("identifies fetch failures separately from invalid successful responses", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(createApiRequester("/api/voice-labs", undefined)("/api/bootstrap"))
      .rejects.toBeInstanceOf(ApiNetworkError);
  });

  it("discards a successful response from an obsolete project context", async () => {
    let current = true;
    let resolveResponse!: () => void;
    const baseRequest: ApiRequester = <T,>() => new Promise<T>((resolve) => {
      resolveResponse = () => resolve({ projectId: "old-project" } as T);
    });
    const scopedRequest = createScopedApiRequester(baseRequest, () => current, vi.fn());
    const pending = scopedRequest<{ projectId: string }>("/api/bootstrap");
    current = false;
    resolveResponse();

    await expect(pending).rejects.toBeInstanceOf(StaleApiRequestError);
  });

  it("does not start a request after its project context becomes obsolete", async () => {
    const baseCall = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
    const baseRequest: ApiRequester = async <T,>(path: string, init?: RequestInit) => {
      await baseCall(path, init);
      return undefined as T;
    };
    const scopedRequest = createScopedApiRequester(baseRequest, () => false, vi.fn());

    await expect(scopedRequest("/api/experiments/experiment-a/run", { method: "POST" }))
      .rejects.toBeInstanceOf(StaleApiRequestError);
    expect(baseCall).not.toHaveBeenCalled();
  });

  it("does not clear a newer project context for an obsolete 410 response", async () => {
    let current = true;
    let rejectResponse!: (error: Error) => void;
    const baseRequest: ApiRequester = () => new Promise((_resolve, reject) => { rejectResponse = reject; });
    const onProjectUnavailable = vi.fn();
    const scopedRequest = createScopedApiRequester(baseRequest, () => current, onProjectUnavailable);
    const pending = scopedRequest("/api/bootstrap");
    current = false;
    rejectResponse(new ApiRequestError("Old project is unavailable.", 410));

    await expect(pending).rejects.toBeInstanceOf(StaleApiRequestError);
    expect(onProjectUnavailable).not.toHaveBeenCalled();
  });

  it("clears the active project context for a 410 and preserves the HTTP error", async () => {
    const onProjectUnavailable = vi.fn();
    const baseRequest: ApiRequester = async () => { throw new ApiRequestError("Project is being deleted.", 410); };
    const scopedRequest = createScopedApiRequester(baseRequest, () => true, onProjectUnavailable);

    await expect(scopedRequest("/api/bootstrap")).rejects.toMatchObject({
      message: "Project is being deleted.",
      status: 410,
    });
    expect(onProjectUnavailable).toHaveBeenCalledWith("Project is being deleted.");
  });

  it("discards an older success that arrives after the project returned 410", async () => {
    let resolveSlow!: () => void;
    const baseRequest: ApiRequester = async <T,>(path: string) => {
      if (path === "/slow") {
        return new Promise<T>((resolve) => { resolveSlow = () => resolve({ projectId: "old-project" } as T); });
      }
      throw new ApiRequestError("Project is being deleted.", 410);
    };
    const scopedRequest = createScopedApiRequester(baseRequest, () => true, vi.fn());
    const olderSuccess = scopedRequest<{ projectId: string }>("/slow");

    await expect(scopedRequest("/gone")).rejects.toMatchObject({ status: 410 });
    resolveSlow();

    await expect(olderSuccess).rejects.toBeInstanceOf(StaleApiRequestError);
  });
});
