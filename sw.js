// WakeGuard service worker: keeps the app working offline after the first visit.
const CACHE = "wakeguard-v6";
const APP_FILES = ["./", "index.html", "style.css", "app.js", "i18n.js", "manifest.webmanifest", "icon.svg", "bg.jpg", "icon-192.png", "icon-512.png", "alarm.mp3"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(APP_FILES.map((f) => cache.add(f).catch(() => {}))))   // alarm.mp3 or icons may be missing: skip them
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (url.origin === self.location.origin) {
    // Your own files: network first, so edits show up on reload. Falls back to the cache when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
    );
  } else {
    // Face-tracking library, model files and fonts (pinned versions): cache first
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});