/**
 * Downloads the latest Temurin JDK 17 (windows x64) into .toolchain/.
 * Resolves the binary link through the GitHub releases API, so no pinned
 * version is required.
 * Usage: node scripts/fetch-jdk.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = path.join(root, ".toolchain");
const zipPath = path.join(dir, "jdk17.zip");
const outDir = path.join(dir, "jdk17");

fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(path.join(outDir, "bin", "java.exe"))) {
    console.log("JDK 17 already present:", outDir);
    process.exit(0);
}

console.log("resolving latest Temurin 17 windows x64 build via GitHub...");
const res = await fetch(
    "https://api.github.com/repos/adoptium/temurin17-binaries/releases?per_page=5"
);
const releases = await res.json();
if (!Array.isArray(releases)) {
    console.error("GitHub API error:", res.status,
        JSON.stringify(releases).slice(0, 200));
    process.exit(1);
}

let link = null;
for (const release of releases) {
    for (const asset of release.assets || []) {
        if (/OpenJDK17U-jdk_x64_windows_hotspot_.*\.zip$/.test(asset.name)) {
            link = asset.browser_download_url;
            break;
        }
    }
    if (link) break;
}
if (!link) {
    console.error("No windows x64 JDK asset found in the latest releases.");
    process.exit(1);
}

console.log("Downloading", link);
const file = await fetch(link); // follows redirects
if (!file.ok) {
    console.error("Download failed:", file.status);
    process.exit(1);
}
const nodeStream = Readable.fromWeb(file.body);
nodeStream.on("data", chunk => process.stdout.write(
    `\rdownloading... ${(chunk.length / 1024).toFixed(0)} KB`
));
await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    nodeStream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    nodeStream.pipe(out);
});
console.log(`\ndownloaded ${fs.statSync(zipPath).size} bytes`);

console.log("extracting...");
execFileSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
], { stdio: "inherit" });
console.log("JDK 17 ready at", outDir);