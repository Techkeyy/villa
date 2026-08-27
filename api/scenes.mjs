import { REPLAY_SCENES } from "../src/dashboard/replay.mjs";

export function GET() {
  return new Response(JSON.stringify({ scenes: REPLAY_SCENES }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
