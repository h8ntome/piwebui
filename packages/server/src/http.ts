/**
 * Fastify wiring: Host allowlist, cookie/bearer auth, CSRF, CSP, byte caps.
 * Every /api route requires authentication (only static boot assets and the bootstrap
 * exchange are public). No CORS for credentialed requests.
 */
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import { ERROR_HTTP_STATUS, MAX_REQUEST_BYTES, type ErrorCode } from "@pi-web/shared";
import { AuthService, COOKIE_NAME, parseCookies, type Config, type Principal } from "./auth.ts";
import { ApiError } from "./commands.ts";
import { logInfo } from "./log.ts";

export interface ReqCtx {
  principal: Principal | null;
  csrfHeader: string;
}

export function buildServer(cfg: Config, auth: AuthService): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_REQUEST_BYTES,
    trustProxy: false,
    disableRequestLogging: true,
    ...(cfg.tls ? { https: { cert: fs.readFileSync(cfg.tls.certFile, "utf8"), key: fs.readFileSync(cfg.tls.keyFile, "utf8") } } : {}),
  } as never) as unknown as FastifyInstance;

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const parsed = JSON.parse(body as string);
      done(null, parsed);
    } catch (e) {
      done(Object.assign(new ApiError("invalid_request", "invalid JSON body"), { statusCode: 400 }) as never);
    }
  });
  // Reject any other content type (no multipart uploads in v1).
  app.addContentTypeParser("*", (_req, _body, done) => {
    done(Object.assign(new ApiError("invalid_request", "unsupported content type"), { statusCode: 400 }) as never);
  });

  app.addHook("onRequest", async (req, reply) => {
    // 1. Host allowlist (independent of request-supplied Host; anti DNS-rebinding).
    const host = (req.headers.host ?? "").toLowerCase();
    if (!auth.hostAllowed(host)) {
      reply.code(403).send({ error: { code: "forbidden", message: "Host not allowlisted" } });
      return;
    }
    const url = req.url.split("?")[0] ?? "";
    const isApi = url === "/api" || url.startsWith("/api/");
    const secure = req.headers["x-forwarded-proto"] === "https" || (req as unknown as { socket?: { encrypted?: boolean } }).socket?.encrypted === true;

    // 2. Authentication for all API paths.
    let principal: Principal | null = null;
    let csrfCheck: ((supplied: string | undefined) => boolean) | null = null;
    if (isApi && url !== "/api/v1/auth/exchange") {
      const cookies = parseCookies(req.headers.cookie);
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
      const web = cookies[COOKIE_NAME] ? auth.webSessionByCookie(cookies[COOKIE_NAME]) : null;
      if (web) { principal = web.principal; csrfCheck = web.csrfOk; }
      else if (bearer) { const p = auth.principalFromBearer(bearer); if (p) principal = p; }
      if (!principal) {
        reply.code(401).send({ error: { code: "unauthorized", message: "authentication required" } });
        return;
      }
      if (!auth.rateOk(principal.id)) {
        reply.code(429).send({ error: { code: "capacity", message: "rate limited" } });
        return;
      }
    }

    // 3. Mutations: Origin + CSRF.
    const method = req.method.toUpperCase();
    if (isApi && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && !auth.originAllowed(origin)) {
        reply.code(403).send({ error: { code: "forbidden", message: "Origin not trusted" } });
        return;
      }
      if (csrfCheck) {
        const supplied = req.headers["x-piweb-csrf"] as string | undefined;
        if (!csrfCheck(supplied)) {
          reply.code(403).send({ error: { code: "forbidden", message: "CSRF token missing or invalid" } });
          return;
        }
      }
    }

    // 4. Headers on everything.
    void secure;
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    (req as unknown as { ctx: ReqCtx }).ctx = { principal, csrfHeader: "" };
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 413) {
      reply.code(413).send({ error: { code: "payload_too_large", message: "request body too large" } });
      return;
    }
    if (e instanceof ApiError) {
      const status = (ERROR_HTTP_STATUS as Record<string, number>)[e.code] ?? 400;
      reply.code(status).send({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } });
      return;
    }
    if ((e as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send({ error: { code: "payload_too_large", message: "request body too large" } });
      return;
    }
    logInfo("unhandled_error", { status: e.statusCode ?? 500 });
    reply.code(e.statusCode ?? 500).send({ error: { code: (e.code as ErrorCode) ?? "internal", message: String(e.message ?? "internal error").slice(0, 200) } });
  });

  return app;
}

function errorStatus(code: string): number {
  return (ERROR_HTTP_STATUS as Record<string, number>)[code] ?? 400;
}
void errorStatus;
