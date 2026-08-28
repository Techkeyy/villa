import http from "node:http";
import { createOperatorAuth, bearerToken, OperatorAuthError } from "../src/operator/auth.mjs";
import { OperatorConfigError } from "../src/operator/config.mjs";
import { createEngineSupervisor, OperatorControlError } from "../src/operator/supervisor.mjs";

const MAX_BODY_BYTES = 16 * 1024;

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function originsFrom(env) {
  return String(env.VILLA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function send(response, status, body, origin = null, allowedOrigins = []) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  }
  response.writeHead(status, headers);
  response.end(jsonSafe(body));
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    let value = "";
    request.on("data", (chunk) => {
      value += String(chunk);
      if (Buffer.byteLength(value) > MAX_BODY_BYTES) {
        reject(new OperatorControlError("REQUEST_TOO_LARGE", "The request is too large.", 413));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!value.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(value)); } catch { reject(new OperatorControlError("REQUEST_INVALID", "Request body must be valid JSON.", 400)); }
    });
    request.on("error", reject);
  });
}

function isAllowedOrigin(origin, allowedOrigins) {
  return !origin || allowedOrigins.includes(origin);
}

function authError(error) {
  return error instanceof OperatorAuthError || error instanceof OperatorControlError || error instanceof OperatorConfigError;
}

function createRateLimiter({ windowMs = 60_000, maxRequests = 120 } = {}) {
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 60_000;
  const maximum = Number.isFinite(Number(maxRequests)) && Number(maxRequests) > 0 ? Math.floor(Number(maxRequests)) : 120;
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= window) {
      buckets.set(key, { startedAt: now, count: 1 });
      return { allowed: true, retryAfter: 0 };
    }
    current.count += 1;
    return {
      allowed: current.count <= maximum,
      retryAfter: Math.max(1, Math.ceil((window - (now - current.startedAt)) / 1000)),
    };
  };
}

export function createOperatorApiServer({
  control,
  auth,
  allowedOrigins = [],
  logger = () => undefined,
  rateLimit = {},
} = {}) {
  if (!control || !auth) throw new TypeError("control and auth are required");
  const origins = [...new Set(allowedOrigins)];
  const isWithinRateLimit = createRateLimiter(rateLimit);
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin ?? null;
    if (!isAllowedOrigin(origin, origins)) {
      send(response, 403, { error: "Origin is not allowed." });
      return;
    }
    if (request.method === "OPTIONS") {
      if (!origin) { response.writeHead(204); response.end(); return; }
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Vary": "Origin",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://operator.local");
    const rate = isWithinRateLimit(request.socket?.remoteAddress ?? "unknown");
    if (!rate.allowed) {
      const headers = { "Retry-After": String(rate.retryAfter) };
      response.writeHead(429, headers);
      response.end(jsonSafe({ error: "Too many requests. Try again later.", code: "RATE_LIMITED" }));
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const state = await control.getState();
        send(response, 200, { ok: true, service: "villa-engine", state: state.state, execution: state.executionEnabled === true ? "enabled" : "disabled" }, origin, origins);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/nonce") {
        const body = await readBody(request);
        send(response, 200, auth.issueNonce(body.address), origin, origins);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/verify") {
        const body = await readBody(request);
        send(response, 200, await auth.verify(body), origin, origins);
        return;
      }

      const session = auth.authenticate(bearerToken(request));
      if (!session) throw new OperatorAuthError("SESSION_REQUIRED", "Connect the authorized operator wallet to continue.");

      if (request.method === "GET" && url.pathname === "/state") {
        send(response, 200, await control.getState(), origin, origins);
        return;
      }
      if (request.method === "GET" && url.pathname === "/config") {
        send(response, 200, control.getConfig(), origin, origins);
        return;
      }
      if (request.method === "GET" && url.pathname === "/activity") {
        send(response, 200, { activity: control.getActivity() }, origin, origins);
        return;
      }

      if (request.method === "POST") {
        const body = await readBody(request);
        if (url.pathname === "/session/start") {
          send(response, 202, await control.start(body.config ?? body), origin, origins);
          return;
        }
        if (url.pathname === "/session/pause") {
          send(response, 202, await control.pause(), origin, origins);
          return;
        }
        if (url.pathname === "/session/resume") {
          send(response, 202, await control.resume(), origin, origins);
          return;
        }
        if (url.pathname === "/session/stop") {
          send(response, 202, await control.stop("OPERATOR_STOP"), origin, origins);
          return;
        }
        if (url.pathname === "/orders/cancel-all") {
          send(response, 202, await control.emergencyCancelAll(), origin, origins);
          return;
        }
      }
      send(response, 404, { error: "Operator route not found." }, origin, origins);
    } catch (error) {
      if (!authError(error)) logger(error);
      const status = authError(error) ? error.status ?? 409 : 500;
      const message = authError(error) ? error.message : "The private operator service could not complete the request.";
      send(response, status, { error: message, code: error?.code ?? "OPERATOR_REQUEST_FAILED" }, origin, origins);
    }
  });
}

export function createProductionOperatorServer(env = process.env, { readOnlyReader, runnerFactory } = {}) {
  const auth = createOperatorAuth({ authorizedAddress: env.OPERATOR_ADDRESS });
  const control = createEngineSupervisor({
    env,
    runnerFactory,
    readOnlyReader: readOnlyReader ?? (async () => (await import("../src/dashboard/live-adapter.mjs")).buildLiveEnvelope()),
  });
  return createOperatorApiServer({ control, auth, allowedOrigins: originsFrom(env) });
}

if (process.argv[1] && process.argv[1].endsWith("operator-api.mjs")) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.VILLA_BIND_HOST || "0.0.0.0";
  const server = createProductionOperatorServer();
  server.listen(port, host, () => {
    console.log(`VILLA private operator API listening on ${host}:${port}`);
    console.log("Execution signer remains inside this private engine process.");
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
