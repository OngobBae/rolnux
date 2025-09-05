/// <reference types="@fastly/js-compute" />
addEventListener("fetch", (event) => {
  event.respondWith(new Response(JSON.stringify({ ok: true, edge: "fastly" }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  }));
});
