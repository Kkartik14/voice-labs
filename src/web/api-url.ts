export function resolveApiRequestUrl(apiBaseUrl: string, path: string, browserOrigin: string): string {
  if (!path.startsWith("/api/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Voice Labs API requests must use a relative /api path.");
  }

  const requestPath = path.split("?", 1)[0]!;
  const segments = requestPath.split("/").slice(1);
  if (segments.some((segment) => {
    if (!segment) return true;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  })) {
    throw new Error("Voice Labs API request path is invalid.");
  }

  let base: URL;
  try {
    base = new URL(apiBaseUrl, browserOrigin);
  } catch {
    throw new Error("Voice Labs API base URL is invalid.");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("Voice Labs API base URL is invalid.");
  }

  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const target = new URL(path.slice(1), base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new Error("Voice Labs API request path is invalid.");
  }
  return target.toString();
}
