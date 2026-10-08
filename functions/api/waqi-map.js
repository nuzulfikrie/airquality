// POST /api/waqi-map  -> https://api.waqi.info/mapq/bounds  (no token needed)
export async function onRequest(context) {
  const body = await context.request.text();
  const upstream = await fetch("https://api.waqi.info/mapq/bounds", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
