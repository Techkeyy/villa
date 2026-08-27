import { buildReplayEnvelope } from "../src/dashboard/replay.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const requestedMode = (url.searchParams.get("mode") || "replay").toLowerCase();
  const scene = url.searchParams.get("scene") || "quote";

  try {
    if (requestedMode === "live") {
      const { buildLiveEnvelope } = await import("../src/dashboard/live-adapter.mjs");
      return json(200, await buildLiveEnvelope());
    }
    return json(200, buildReplayEnvelope(scene));
  } catch (error) {
    return json(503, {
      error: requestedMode === "live"
        ? `Live read refused: ${error?.message || error}`
        : `Replay unavailable: ${error?.message || error}`,
    });
  }
}
