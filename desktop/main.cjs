/**
 * WintrChess desktop shell (Electron).
 *
 * Boots the bundled WintrChess server in-process on a free localhost port
 * and opens it in a single BrowserWindow. The server code is the same ESM
 * build `npm run build:server` produces; the `type: module` marker in
 * `app/http/package.json` is what makes Node load those files as ESM.
 */
"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// In a packaged build the app files live in `resources/app`; in
// development (`electron .`) they live in the repository root.
const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.resolve(__dirname, "..");

// `localhost` is on the hostname whitelist in development mode, which is
// exactly what this shell is: a local server + local window.
process.env.NODE_ENV = process.env.NODE_ENV || "development";

let server = null;

async function startServer() {
    // The page router resolves `public/apps/...` relative to the working
    // directory, so chdir into the app root first.
    process.chdir(appRoot);

    const { default: express } = await import("express");
    const { default: hostnameWhitelist } = await import(
        pathToFileURL(path.join(
            appRoot, "app/http/dist/http/src/lib/security/whitelist.js"
        )).href
    );
    const { default: mainRouter } = await import(
        pathToFileURL(path.join(
            appRoot, "app/http/dist/http/src/routes/index.js"
        )).href
    );

    const application = express();
    application.use(hostnameWhitelist);

    // Static assets (same layout as the web server, `app/http/src/index.ts`)
    application.use(express.static(path.join(appRoot, "app/ui/dist")));
    application.use(express.static(path.join(appRoot, "public")));

    // Normal endpoints (page routes + API)
    application.use("/", mainRouter);

    // A free, random localhost port: never collides with a locally
    // self-hosted server of the same app.
    const httpServer = application.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        httpServer.once("listening", resolve);
        httpServer.once("error", reject);
    });

    console.log(
        `WintrChess server: http://localhost:${httpServer.address().port}`
    );
    return { port: httpServer.address().port, close: () => httpServer.close() };
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        const [win] = BrowserWindow.getAllWindows();
        if (win) {
            win.show();
            win.focus();
        }
    });

    app.setAppUserModelId("com.wintrchess.desktop");

    app.whenReady().then(async () => {
        try {
            server = await startServer();
        } catch (error) {
            console.error(error);
            dialog.showErrorBox(
                "WintrChess could not start",
                error instanceof Error ? error.message : String(error)
            );
            app.quit();
            return;
        }

        const window = new BrowserWindow({
            width: 1400,
            height: 880,
            minWidth: 980,
            minHeight: 600,
            title: "WintrChess",
            icon: path.join(__dirname, "build/icon.ico"),
            autoHideMenuBar: true,
            backgroundColor: "#101319",
            show: false,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                spellcheck: false
            }
        });

        window.once("ready-to-show", () => window.show());

        // Links to other sites open in the default browser.
        window.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) shell.openExternal(url);
            return { action: "deny" };
        });
        window.webContents.on("will-navigate", (event, url) => {
            if (!url.startsWith(`http://localhost:${server.port}`)) {
                event.preventDefault();
                if (/^https?:/i.test(url)) shell.openExternal(url);
            }
        });

        await window.loadURL(`http://localhost:${server.port}/analysis`);
    });
}

app.on("window-all-closed", () => {
    // Desktop app: closing the window quits (standard win32 behaviour)
    app.quit();
});

app.on("will-quit", () => {
    try { server?.close(); } catch { /* already closed */ }
});