// GET /api/feed/{id}  -> https://api.waqi.info/api/feed/@{id}/aqi.json  (needs WAQI_TOKEN secret)
// {id} is the WAQI map field `x` (the station uid that feed/@{uid} expects; verified @2625 = Batu Muda).
// The map's `idx` field is a different id space (@5092 is a station in France), so it is not accepted here.
// Without WAQI_TOKEN this returns 503 JSON and the dashboard falls back to AQI-only for official stations.
export async function onRequest(context) {
  const token = context.env.WAQI_TOKEN;
  if (!token) return new Response(JSON.stringify({ status: "error", data: "WAQI_TOKEN not set" }), {
    status: 503, headers: { "Content-Type": "application/json" },
  });
  const id = String(context.params.id).replace(/^@/, "");
  if (!/^\d+$/.test(id)) return new Response("invalid id", { status: 400 });
  const upstream = await fetch(
    "https://api.waqi.info/api/feed/@" + id + "/aqi.json?token=" + encodeURIComponent(token)
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
