export function GET() {
  return new Response(JSON.stringify({
    engineApiUrl: process.env.VILLA_ENGINE_API_URL || null,
    publicMode: "DEMO / VERIFIED REPLAY",
    operatorMode: "single-operator testnet MVP",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
