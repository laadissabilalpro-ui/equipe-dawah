/* L'Appel — Équipe · service worker (PWA) — v4 (push notifications app fermée) */
const CACHE = "lappel-v4";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
const CDN  = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE);
    try { await c.add(CDN); } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Réseau d'abord pour le HTML (toujours la dernière version)
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", copy));
        return r;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Cache d'abord pour le reste (CDN supabase, icônes, manifest)
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((r) => {
        if (url.origin === location.origin || url.host.includes("jsdelivr")) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return r;
      }).catch(() => cached)
    )
  );
});

/* ---------- v4 : Web Push ---------- */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {
    try { data = { title: "L'Appel", body: e.data ? e.data.text() : "" }; } catch (_) { data = {}; }
  }
  const title = data.title || "L'Appel — Équipe";
  const body = data.body || "";
  const ideaId = data.ideaId || null;
  const url = data.url || "./";
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: ideaId ? ("idea-" + ideaId) : undefined,
    renotify: false,
    data: { ideaId, url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const targetUrl = new URL((data.url || "./"), self.location.href).href;
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        const u = new URL(c.url);
        if (u.origin === self.location.origin) {
          c.postMessage({ type: "open-idea", ideaId: data.ideaId });
          return c.focus();
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
