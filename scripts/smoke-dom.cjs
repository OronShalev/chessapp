/**
 * DOM smoke test: loads the app's HTML document into jsdom with scripts
 * enabled, at a chosen URL (the URL the app boots at - "/" in the Android
 * webview, "/analysis" on the website), lets React run, then reports what
 * was rendered plus console/jsdom errors.
 *
 * A static server with the app assets must be reachable at the URL's
 * origin (see scripts/static-server.cjs).
 *
 * Usage:
 *   node scripts/smoke-dom.cjs --doc <html-file> --url <absolute-url> [--wait ms]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const args = process.argv.slice(2);
function arg(name, dflt) {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
}

const docFile = path.resolve(arg("--doc", "index.html"));
const url = arg("--url", null);
const waitMs = parseInt(arg("--wait", "20000"), 10);
if (!url) {
    console.error("--url is required");
    process.exit(2);
}

const html = fs.readFileSync(docFile, "utf8");

// --- console / error capture -------------------------------------------
const jsdomErrors = [];
const consoleMessages = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", e => jsdomErrors.push(String(e.message || e).slice(0, 300)));
for (const m of ["log", "info", "warn", "error"]) {
    virtualConsole.on(m, (...a) => consoleMessages.push({
        channel: m,
        text: a.map(x => (typeof x === "string" ? x : String(x))).join(" ").slice(0, 300)
    }));
}

// --- browser API stubs jsdom lacks --------------------------------------
// The chess engine runs in a Web Worker; jsdom has no workers, so record
// what the app would have started instead of crashing.
const workerLog = [];
class FakeWorker {
    constructor(spec) {
        this.spec = spec;
        workerLog.push("new Worker(" + spec + ")");
    }
    postMessage(m) { workerLog.push("post: " + String(m).slice(0, 60)); }
    terminate() { workerLog.push("terminate"); }
    addEventListener() { }
    removeEventListener() { }
}

const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
        window.Worker = FakeWorker;
        window.matchMedia = query => ({
            matches: false,
            media: query,
            addListener() { },
            removeListener() { },
            addEventListener() { },
            removeEventListener() { },
            dispatchEvent() { return false; }
        });
        window.scrollTo = () => { };
        // jsdom has no layout engine: give elements a phone-like size so
        // size-driven logic does not operate on zeros.
        Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
            configurable: true, get() { return 480; }
        });
        Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
            configurable: true, get() { return 900; }
        });
    }
});

setTimeout(async () => {
    const document = dom.window.document;
    const root = document.querySelector(".root");
    const report = {
        url,
        title: document.title,
        rootChildren: root ? root.children.length : -1,
        bodyText: (document.body && document.body.textContent || "")
            .replace(/\s+/g, " ").trim().slice(0, 600),
        workers: workerLog.slice(0, 10),
        console: consoleMessages.slice(0, 30),
        jsdomErrors: jsdomErrors.slice(0, 20)
    };
    fs.writeFileSync(path.join(__dirname, "smoke-dom-result.json"), JSON.stringify(report, null, 2));
    console.log("DOM_STATE: " + JSON.stringify({
        rootChildren: report.rootChildren,
        title: report.title,
        workers: report.workers.length,
        bodyText: report.bodyText.slice(0, 300)
    }));
    console.log("CONSOLE(" + report.console.length + "): " + JSON.stringify(report.console.slice(0, 12)));
    console.log("JSDOM_ERRORS(" + report.jsdomErrors.length + "): " + JSON.stringify(report.jsdomErrors.slice(0, 8)));
    process.exit(0);
}, waitMs);
