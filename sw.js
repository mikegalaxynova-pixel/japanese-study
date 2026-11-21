/* Basic offline cache for the Japanese study static pages. */
const CACHE_NAME = "japanese-study-v5";
const PRECACHE = [
  "./",
  "./index.html",
  "./404.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./n2/verbs.html",
  "./n2/adjectives.html",
  "./n2/nouns.html",
  "./n2/grammar.html",
  "./shokyu/verbs.html",
  "./shokyu/adjectives.html",
  "./shokyu/nouns.html",
  "./shokyu/grammar.html",
  "./shochukyu/verbs.html",
  "./shochukyu/adjectives.html",
  "./shochukyu/nouns.html",
  "./shochukyu/grammar.html",
  "./shochukyu/lesson7-9.html",
  "./kanji-words/",
  "./kanji-words/index.html",
  "./kanji-words/words.json",
  "./chukyu/verbs.html",
  "./chukyu/adjectives.html",
  "./chukyu/nouns.html",
  "./chukyu/grammar.html"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        return response;
      }).catch(function () {
        if (event.request.mode === "navigate") {
          return caches.match("./index.html");
        }
        return undefined;
      });
    })
  );
});
