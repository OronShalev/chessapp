/**
 * Loads a URL in a headless Electron window (Chromium - the same engine
 * as the Android webview) and reports the resulting page state, console
 * output and resource loads. Used to verify the analysis app boots at a
 * given URL (mobile: origin root "/", web/desktop: "/analysis").
 *
 * Usage: npx electron scripts/smoke-webview.cjs <url> [waitMs]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

// stdout of GUI-subsystem Electron processes is unreliable to capture on
// Windows, so results are always written to a file as well.
const RESULT_FILE = path.join(__dirname, "smoke-result.json");
try { fs.unlinkSync(RESULT_FILE); } catch { }
fs.writeFileSync(RESULT_FILE + ".start", "started " + new Date().toISOString());

// Headless-friendly: no GPU, no sandbox - this script runs in agent
// contexts where neither is available.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

const url = process.argv[2];
const waitMs = parseInt(process.argv[3] || "20000", 10);
if (!url) {
    console.error("usage: smoke-webview <url> [waitMs]");
    process.exit(2);
}

const consoleMessages = [];
const loadErrors = [];

process.on("uncaughtException", err => {
    try { fs.writeFileSync(RESULT_FILE + ".crash", String((err && err.stack) || err)); } catch { }
});

app.whenReady().then(() => {
    const win = new BrowserWindow({
        show: false,
        width: 480,
        height: 900, // phone-like viewport, like the Android app
        webPreferences: {
            // WASM + workers, same as the packaged app
        }
    });

    win.webContents.on("console-message", (e, level, message) => {
        consoleMessages.push({ level, message: message.slice(0, 300) });
    });
    win.webContents.on("did-fail-load", (e, code, desc, validatedURL) => {
        loadErrors.push({ code, desc, url: validatedURL });
    });
    win.webContents.on("render-process-gone", (e, details) => {
        loadErrors.push({ renderProcessGone: details.reason });
    });

    win.loadURL(url);

    setTimeout(async () => {
        let state;
        try {
            state = await win.webContents.executeJavaScript(`
                (() => {
                    const root = document.querySelector(".root");
                    const resources = performance.getEntriesByType("resource")
                        .filter(r => r.name.includes("engines/") || r.name.includes(".wasm"));
                    return JSON.stringify({
                        href: location.href,
                        title: document.title,
                        rootChildren: root ? root.children.length : -1,
                        bodyText: document.body.innerText.replace(/\\s+/g, " ").slice(0, 400),
                        engineResources: resources.map(r => ({
                            name: r.name.split("/").pop(),
                            kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024)
                        }))
                    });
                })()
            `);
            console.log("PAGE_STATE: " + state);
        } catch (err) {
            state = "EVAL_ERROR: " + err.message;
        }

        const report = {
            state,
            console: consoleMessages.slice(0, 30),
            loadErrors
        };
        console.log("CONSOLE(" + consoleMessages.length + "): " + JSON.stringify(consoleMessages.slice(0, 20)));
        console.log("LOAD_ERRORS: " + JSON.stringify(loadErrors));
        try {
            fs.writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
        } catch (err) {
            console.error("could not write " + RESULT_FILE + ": " + err.message);
        }

        app.exit(0);
    }, waitMs);
}).catch(err => {
    try { fs.writeFileSync(RESULT_FILE + ".crash", "whenReady failed: " + err); } catch { }
    app.exit(1);
});
