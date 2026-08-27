import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplayEnvelope, REPLAY_SCENES } from "../src/dashboard/replay.mjs";
import { buildLiveEnvelope } from "../src/dashboard/live-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = path.join(root, "dashboard");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) || process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const defaultMode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--live") ? "live" : "replay";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
});

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const requested = path.resolve(dashboardRoot, relative);
  if (!requested.startsWith(`${dashboardRoot}${path.sep}`)) return json(response, 403, { error: "forbidden path" });
  try {
    const body = await fs.readFile(requested);
    const extension = path.extname(requested).toLowerCase();
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/presenter.mjs") {
    try {
      const body = await fs.readFile(path.join(root, "src", "dashboard", "presenter.mjs"));
      response.writeHead(200, { "Content-Type": CONTENT_TYPES[".mjs"], "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      json(response, 404, { error: "presentation module unavailable" });
    }
    return;
  }
  if (url.pathname === "/api/scenes") return json(response, 200, { scenes: REPLAY_SCENES });
  if (url.pathname === "/api/operator-config") return json(response, 200, {
    engineApiUrl: process.env.VILLA_ENGINE_API_URL || null,
    publicMode: "DEMO / VERIFIED REPLAY",
    operatorMode: "single-operator testnet MVP",
  });
  if (url.pathname === "/api/snapshot") {
    const requestedMode = (url.searchParams.get("mode") || defaultMode).toLowerCase();
    try {
      if (requestedMode === "live") return json(response, 200, await buildLiveEnvelope());
      return json(response, 200, buildReplayEnvelope(url.searchParams.get("scene") || "quote"));
    } catch (error) {
      return json(response, 503, { error: requestedMode === "live" ? `Live read refused: ${error?.message || error}` : `Replay unavailable: ${error?.message || error}` });
    }
  }
  return serveStatic(response, url.pathname);
});

server.listen(port, host, () => {
  console.log(`VILLA dashboard listening at http://${host}:${port}`);
  console.log(`Default mode: ${defaultMode.toUpperCase()}; live mode is read-only`);
});
