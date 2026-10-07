/**
 * Assembles the self-contained web app for the Android package.
 *
 * Capacitor serves `android-web/dist` at the app's webview origin root, so
 * this merges the client bundles (app/ui/dist) with the static assets
 * (public/ - engines, locales, audio, images, ...) and adds a static
 * index.html (the analysis page, which is the app entry).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "android-web", "dist");

const uiDist = path.join(root, "app", "ui", "dist");
if (!fs.existsSync(uiDist)) {
    console.error("app/ui/dist not found - run `npm run build:client` first.");
    process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Client bundles
fs.cpSync(uiDist, outDir, { recursive: true, force: true });
// Static assets (engines, locales, audio, images, apps, sw.js, ...)
fs.cpSync(path.join(root, "public"), outDir, { recursive: true, force: true });
// Entry page (same document the web server serves at /analysis)
fs.copyFileSync(
    path.join(root, "public", "apps", "features", "analysis.html"),
    path.join(outDir, "index.html")
);

let total = 0;
for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    const p = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
        for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
            const sp = path.join(p, sub.name);
            total += sub.isDirectory()
                ? 0
                : fs.statSync(sp).size;
        }
    } else {
        total += fs.statSync(p).size;
    }
}

console.log(`android web assets: ${outDir} (${(total / 1048576).toFixed(1)} MB)`);