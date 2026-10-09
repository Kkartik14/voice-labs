import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IncomingMessage } from "node:http";
import type { ProjectContext } from "../domain/model.js";

export class AuthenticationError extends Error {
  constructor(message = "A valid Platform access token is required.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface AuthenticatedIdentity {
  readonly context: ProjectContext;
  readonly scopes: ReadonlySet<string>;
}

export interface Authenticator {
  authenticate(request: IncomingMessage): Promise<AuthenticatedIdentity>;
  readonly mode: "local" | "jwt";
  readonly allowedOrigins: ReadonlySet<string>;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function parseOrigins(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function createAuthenticator(options: {
  mode: "local" | "jwt";
  localProjectId?: string;
  localUserId?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
  allowedOrigins?: string;
}): Authenticator {
  const allowedOrigins = parseOrigins(options.allowedOrigins);
  if (options.mode === "local" && allowedOrigins.size === 0) {
    allowedOrigins.add("http://localhost:4321");
    allowedOrigins.add("http://127.0.0.1:4321");
  }
  if (options.mode === "local") {
    return {
      mode: "local",
      allowedOrigins,
      async authenticate(request) {
        if (!isLoopback(request.socket.remoteAddress)) throw new AuthenticationError("Local mode accepts loopback requests only.");
        return {
          context: {
            userId: options.localUserId ?? "local-development",
            projectId: options.localProjectId ?? "local",
          },
          scopes: new Set(["voice-labs:read", "voice-labs:write", "voice-labs:project:delete"]),
        };
      },
    };
  }

  const jwksUrl = new URL(options.jwksUrl ?? requiredEnvironment("VOICE_LABS_AUTH_JWKS_URL"));
  const loopbackJwksHost = ["localhost", "127.0.0.1", "[::1]"].includes(jwksUrl.hostname);
  if (jwksUrl.protocol !== "https:" && !(jwksUrl.protocol === "http:" && loopbackJwksHost)) {
    throw new Error("VOICE_LABS_AUTH_JWKS_URL must use HTTPS; HTTP is allowed only for loopback tests.");
  }
  const issuer = options.issuer ?? requiredEnvironment("VOICE_LABS_AUTH_ISSUER");
  const audience = options.audience ?? requiredEnvironment("VOICE_LABS_AUTH_AUDIENCE");
  const jwks = createRemoteJWKSet(jwksUrl);

  return {
    mode: "jwt",
    allowedOrigins,
    async authenticate(request) {
      const [scheme, token, extra] = (request.headers.authorization ?? "").split(" ");
      if (scheme?.toLowerCase() !== "bearer" || !token || extra) throw new AuthenticationError();
      try {
        const verified = await jwtVerify(token, jwks, {
          issuer,
          audience,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["exp", "iat", "sub", "project_id", "scope", "jti"],
          maxTokenAge: "5m",
          clockTolerance: "30s",
        });
        const subject = verified.payload.sub;
        const projectId = verified.payload.project_id;
        const issuedAt = verified.payload.iat;
        const expiresAt = verified.payload.exp;
        const tokenId = verified.payload.jti;
        const scopeClaim = verified.payload.scope;
        if (verified.payload.aud !== audience) {
          throw new AuthenticationError("The Platform token audience must match Voice Labs exactly.");
        }
        if (typeof subject !== "string" || subject.trim() === "" || typeof projectId !== "string" || projectId.trim() === "") {
          throw new AuthenticationError("The Platform token is missing its user or project identity.");
        }
        if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || expiresAt - issuedAt > 300) {
          throw new AuthenticationError("The Platform token must expire within five minutes of issuance.");
        }
        if (typeof tokenId !== "string" || tokenId.trim() === "" || tokenId.length > 200) {
          throw new AuthenticationError("The Platform token is missing a valid token identifier.");
        }
        if (typeof scopeClaim !== "string" || scopeClaim.length > 1_000) {
          throw new AuthenticationError("The Platform token is missing valid operation scopes.");
        }
        const scopes = scopeClaim.split(" ");
        if (scopes.length === 0 || scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
          throw new AuthenticationError("The Platform token contains malformed operation scopes.");
        }
        const assertedProject = request.headers["x-platform-project-id"];
        if (typeof assertedProject === "string" && assertedProject !== projectId) {
          throw new AuthenticationError("The requested project does not match the Platform token.");
        }
        return { context: { userId: subject, projectId }, scopes: new Set(scopes) };
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
        throw new AuthenticationError();
      }
    },
  };
}

export function createAuthenticatorFromEnvironment(host: string): Authenticator {
  const mode = process.env.VOICE_LABS_AUTH_MODE ?? "jwt";
  if (mode !== "local" && mode !== "jwt") throw new Error("VOICE_LABS_AUTH_MODE must be local or jwt.");
  if (mode === "local" && process.env.NODE_ENV === "production") throw new Error("Local authentication is disabled in production.");
  if (mode === "local" && !isLoopback(host)) throw new Error("Local authentication requires VOICE_LABS_HOST to be loopback.");
  return createAuthenticator({
    mode,
    localProjectId: process.env.VOICE_LABS_LOCAL_PROJECT_ID,
    localUserId: process.env.VOICE_LABS_LOCAL_USER_ID,
    jwksUrl: process.env.VOICE_LABS_AUTH_JWKS_URL,
    issuer: process.env.VOICE_LABS_AUTH_ISSUER,
    audience: process.env.VOICE_LABS_AUTH_AUDIENCE,
    allowedOrigins: process.env.VOICE_LABS_ALLOWED_ORIGINS,
  });
}
