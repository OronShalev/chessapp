/* Client asset cache for the app pages.
 *
 * - Navigations are network-first (with a cached fallback): the page must
 *   always reflect the latest deploy; the cache only covers reloads on a
 *   flaky connection.
 * - Same-origin static assets — above all the /engines/ WASM binaries,
 *   which are tens of MB — are served stale-while-revalidate: the cached
 *   copy is returned immediately and refreshed in the background, so a
 *   revisit never waits on a re-download, and a redeployed engine
 *   propagates on the first visit after the deploy.
 * - Everything else (API routes, cross-origin requests, the worker script
 *   itself) is left untouched.
 *
 * The worker is deliberately defensive: any failure inside it falls back
 * to the plain network path, so the cache can never block the page.
 */
const CACHE_NAME = "wintrchess-assets-v1";

self.addEventListener("install", () => {
    // Take control as soon as a new version activates.
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
        );

        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const { request } = event;

    if (request.method !== "GET") return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }

    // Only same-origin static assets are cached: never API traffic, never
    // the worker script (which must revalidate on every load), never
    // third parties.
    if (url.origin !== self.location.origin) return;
    if (url.pathname === "/sw.js" || url.pathname.startsWith("/api/")) return;
    if (
        !url.pathname.startsWith("/engines/")
        && !/(\.bundle\.js|\.(?:js|css|png|svg|gif|ttf|mp3))$/i
            .test(url.pathname)
    ) return;

    if (request.mode === "navigate") {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(request);
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, fresh.clone());
                return fresh;
            } catch {
                const cached = await caches.match(request);
                return cached || Response.error();
            }
        })());

        return;
    }

    // Stale-while-revalidate for static assets.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);

        const network = fetch(request)
            .then(fresh => {
                if (fresh && fresh.ok) cache.put(request, fresh.clone());
                return fresh;
            })
            .catch(() => cached);

        return cached || network;
    })());
});
