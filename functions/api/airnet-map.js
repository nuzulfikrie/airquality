// POST /api/airnet-map  -> https://airnet.waqi.info/airnet/map/bounds  (no token needed)
export async function onRequest(context) {
  const body = await context.request.text();
  const upstream = await fetch("https://airnet.waqi.info/airnet/map/bounds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
