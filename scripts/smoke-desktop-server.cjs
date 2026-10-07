"use strict";

/**
 * Smoke test for the packaged desktop server: boots the same in-process
 * express bootstrap that desktop/main.cjs uses, against any app directory
 * (repo root or an unpacked electron-builder output), and checks that the
 * main routes and assets resolve.
 *
 * Usage:
 *   node scripts/smoke-desktop-server.cjs [appRoot]
 */

const path = require("path");
const { pathToFileURL } = require("url");
const { createRequire } = require("module");

const appRoot = path.resolve(
    process.argv[2] || path.join(__dirname, "..")
);
process.chdir(appRoot);
process.env.NODE_ENV = process.env.NODE_ENV || "development";

// Resolve `express` from the app directory's own node_modules, so the
// packaged (resources/app/node_modules) copy is what gets exercised.
const requireRoot = createRequire(path.join(appRoot, "package.json"));
const express = requireRoot("express");

const application = express();

(async () => {
    const { default: hostnameWhitelist } = await import(pathToFileURL(path.join(
        appRoot, "app/http/dist/http/src/lib/security/whitelist.js"
    )).href);
    const { default: mainRouter } = await import(pathToFileURL(path.join(
        appRoot, "app/http/dist/http/src/routes/index.js"
    )).href);

    application.use(hostnameWhitelist);
    application.use(express.static(path.join(appRoot, "app/ui/dist")));
    application.use(express.static(path.join(appRoot, "public")));
    application.use("/", mainRouter);

    const server = application.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const get = (p, init) => fetch(
            `http://localhost:${port}${p}`, init
        ).then(res => res.status);
        const checks = [
            ["/", 302],
            ["/analysis", 200],
            ["/analysis.bundle.js", 200],
            ["/engines/stockfish-19-lite-single.js", 200],
            ["/engines/stockfish-19-lite-single.wasm", 200],
            ["/locales/en/analysis.json", 200],
            ["/img/logo.svg", 200],
            ["/settings", 200],
            // POST-only endpoint: an empty payload must be rejected (400)
            ["/api/analysis/analyse", 400, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}"
            }]
        ];
        const manual = { redirect: "manual" };

        (async () => {
            let failed = 0;
            for (const [p, want, init] of checks) {
                const got = await get(p, init ? { ...manual, ...init } : manual);
                if (got !== want) {
                    failed++;
                    console.error(`FAIL ${p}: got ${got}, want ${want}`);
                } else {
                    console.log(`ok   ${p} -> ${got}`);
                }
            }
            server.close(() => process.exit(failed ? 1 : 0));
        })();
    });

    server.on("error", error => {
        console.error("server error:", error);
        process.exit(1);
    });
})();