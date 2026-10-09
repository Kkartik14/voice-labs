import { resolveApiRequestUrl } from "./api-url.js";

export type ApiRequester = {
  <T>(path: string, init?: RequestInit): Promise<T>;
  isCurrent?: () => boolean;
};

export class ApiRequestError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ApiNetworkError extends Error {
  public constructor() {
    super("Could not reach Voice Labs. Check your connection and retry.");
    this.name = "ApiNetworkError";
  }
}

export class StaleApiRequestError extends Error {
  public constructor() {
    super("The request belongs to an inactive project context.");
    this.name = "StaleApiRequestError";
  }
}

export function createScopedApiRequester(
  requester: ApiRequester,
  isCurrent: () => boolean,
  onProjectUnavailable: (message: string) => void,
): ApiRequester {
  let contextUnavailable = false;
  const isScopedRequestCurrent = () => !contextUnavailable && isCurrent();
  const scopedRequest: ApiRequester = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!isScopedRequestCurrent()) throw new StaleApiRequestError();
    let result: T;
    try {
      result = await requester<T>(path, init);
    } catch (error) {
      if (!isScopedRequestCurrent()) throw new StaleApiRequestError();
      if (error instanceof ApiRequestError && error.status === 410) {
        contextUnavailable = true;
        onProjectUnavailable(error.message);
      }
      throw error;
    }
    if (!isScopedRequestCurrent()) throw new StaleApiRequestError();
    return result;
  };
  scopedRequest.isCurrent = isScopedRequestCurrent;
  return scopedRequest;
}

export function createApiRequester(apiBaseUrl: string | undefined, accessToken: string | undefined): ApiRequester {
  return async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const target = apiBaseUrl ? resolveApiRequestUrl(apiBaseUrl, path, window.location.origin) : path;
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    let response: Response;
    try {
      response = await fetch(target, { ...init, headers });
    } catch {
      throw new ApiNetworkError();
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw new ApiRequestError(`Request failed (${response.status})`, response.status);
      throw new Error("Lab returned an invalid response.");
    }
    if (!response.ok) throw new ApiRequestError(responseErrorMessage(payload, response.status), response.status);
    return payload as T;
  };
}

function responseErrorMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const fields = payload as Record<string, unknown>;
    for (const key of ["message", "error"]) {
      const value = fields[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    }
  }
  return `Request failed (${status})`;
}
