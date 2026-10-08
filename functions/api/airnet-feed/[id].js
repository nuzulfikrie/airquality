// GET /api/airnet-feed/{id}  -> https://airnet.waqi.info/airnet/feed/hourly/{id}
export async function onRequest(context) {
  const id = String(context.params.id);
  if (!/^\w[\w.-]*$/.test(id)) return new Response("invalid id", { status: 400 });
  const upstream = await fetch("https://airnet.waqi.info/airnet/feed/hourly/" + encodeURIComponent(id));
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}