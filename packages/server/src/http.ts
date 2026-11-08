/**
 * Fastify wiring: Host allowlist, browser identity, CSRF, CSP, byte caps.
 *
 * There is no login. The first API request from a browser is quietly given an anonymous
 * session cookie, so opening the UI lands straight on the chats. What still applies to
 * every request: the Host allowlist (anti DNS-rebinding), the mutation Origin allowlist,
 * the double-submit CSRF token bound to the session, the CSP/referrer/frame headers and
 * the per-principal rate bucket. Script clients may still use `Authorization: Bearer`.
 * No CORS is granted for credentialed requests, so a foreign page can neither read the
 * responses nor learn its own session's CSRF token.
 */
import Fastify, { LogController, type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ERROR_HTTP_STATUS, MAX_REQUEST_BYTES, type ErrorCode } from "@piwebui/shared";
import { AuthService, COOKIE_NAME, parseCookies, type Config, type Principal } from "./auth.ts";
import { ApiError } from "./commands.ts";
import { logInfo, logWarn } from "./log.ts";

export interface ReqCtx {
  principal: Principal | null;
  csrfHeader: string;
}

/** Anonymous browser sessions live 30 days; the browser never has to sign in. */
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

function sessionCookie(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

export function buildServer(cfg: Config, auth: AuthService): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_REQUEST_BYTES,
    trustProxy: false,
    // Per-request access logs stay off (the launcher banner is the only startup noise).
    // fastify@5 wants this on the LogController; the top-level flag is deprecated.
    logController: new LogController({ disableRequestLogging: true }),
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

    // 2. Identity for all API paths: existing session cookie, API bearer, or a new
    //    anonymous session issued right here (this is what replaced the login page).
    let principal: Principal | null = null;
    let csrfCheck: ((supplied: string | undefined) => boolean) | null = null;
    if (isApi) {
      const cookies = parseCookies(req.headers.cookie);
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
      const web = cookies[COOKIE_NAME] ? auth.webSessionByCookie(cookies[COOKIE_NAME]) : null;
      if (web) { principal = web.principal; csrfCheck = web.csrfOk; }
      else if (bearer) { const p = auth.principalFromBearer(bearer); if (p) principal = p; }
      if (!principal) {
        const issued = auth.createWebSession();
        principal = issued.principal;
        csrfCheck = issued.csrfOk;
        reply.header("set-cookie", sessionCookie(issued.cookieValue, secure));
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
    logWarn("unhandled_error", { status: e.statusCode ?? 500, kind: String(e.code ?? ""), err: String(e.message ?? "").slice(0, 160), where: (err as { stack?: string }).stack ?? "".split("\n").slice(0, 2).join(" | ") });
    reply.code(e.statusCode ?? 500).send({ error: { code: (e.code as ErrorCode) ?? "internal", message: String(e.message ?? "internal error").slice(0, 200) } });
  });

  return app;
}
