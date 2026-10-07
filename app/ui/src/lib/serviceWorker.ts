/**
 * Registers the client asset service worker (served as /sw.js from
 * `public/`). The worker serves the engine binaries (tens of MB of WASM)
 * and other static assets stale-while-revalidate, so revisits of the app
 * do not re-download them; navigations stay network-first so a deploy is
 * always picked up.
 *
 * Production only — the worker must never intercept dev traffic — and
 * deliberately fire-and-forget: the cache is an optimisation, so its
 * registration or operation failing must never break the app.
 */
if (
    process.env.NODE_ENV === "production"
    && typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && window.isSecureContext
) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
            // No cache support for this browser/context: the app is fully
            // functional without the worker, so swallow the failure.
        });
    });
}
