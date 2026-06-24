/* L'Appel — Équipe · service worker (PWA) — v17 (priorité des idées + fix barre onglets) */
const CACHE = "lappel-v17";
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

/* ---------- v4+ : Web Push ---------- */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {
    try { data = { title: "L'Appel", body: e.data ? e.data.text() : "" }; } catch (_) { data = {}; }
  }
  const title = data.title || "L'Appel — Équipe";
  const body = data.body || "";
  const url = data.url || "./";
  // tag : un par release/idée/draft pour éviter les doublons à l'écran
  let tag;
  if (url.indexOf("release=") >= 0) tag = "release-" + url.split("release=")[1];
  else if (url.indexOf("reviewRelease=") >= 0) tag = "review-" + url.split("reviewRelease=")[1];
  else if (url.indexOf("idea=") >= 0) tag = "idea-" + url.split("idea=")[1];
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag,
    renotify: false,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const targetUrl = new URL((data.url || "./"), self.location.href).href;
  // Détermine quel type de deep-link envoyer aux clients
  let msg = null;
  const u = data.url || "";
  if (u.indexOf("reviewRelease=") >= 0) {
    msg = { type: "open-review-release", releaseId: parseInt(u.split("reviewRelease=")[1], 10) };
  } else if (u.indexOf("release=") >= 0) {
    msg = { type: "open-release", releaseId: parseInt(u.split("release=")[1], 10) };
  } else if (u.indexOf("idea=") >= 0) {
    msg = { type: "open-idea", ideaId: parseInt(u.split("idea=")[1], 10) };
  }
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        const cu = new URL(c.url);
        if (cu.origin === self.location.origin) {
          if (msg) c.postMessage(msg);
          return c.focus();
        }
      } catch (_) {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(t