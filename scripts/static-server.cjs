/**
 * Minimal static file server used for smoke tests (e.g. serving
 * android-web/dist exactly the way the Android webview sees it).
 *
 * Usage: node scripts/static-server.cjs <dir> <port>
 */
"use strict";

const path = require("path");
const express = require("express");

const dir = path.resolve(process.argv[2] || ".");
const port = parseInt(process.argv[3] || "8123", 10);

express()
    .use(express.static(dir))
    .listen(port, () => console.log(`serving ${dir} on port ${port}`));
