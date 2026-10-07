/**
 * Builds the Android debug APK with the local .toolchain toolchain
 * (Temurin JDK 21 + Android SDK) and stages the artifact in releases/.
 *
 * Prerequisite: `npm run app:android` (builds server/client assets,
 * assembles the android-web bundle and runs `cap sync android`).
 *
 * Usage:
 *   node scripts/build-android-apk.cjs
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const jdkRoot = path.join(root, ".toolchain", "jdk21");
const sdkRoot = path.join(root, ".toolchain", "android-sdk");

function fail(msg) {
    console.error(`android apk: ${msg}`);
    process.exit(1);
}

// The JDK archive extracts into a nested folder (jdk-21.x.y+z/), so locate
// the home directory that actually contains bin/java.
function locateJdkHome(base) {
    const java = "java" + (isWin ? ".exe" : "");
    if (fs.existsSync(path.join(base, "bin", java))) return base;
    if (!fs.existsSync(base)) return null;
    for (const entry of fs.readdirSync(base)) {
        const candidate = path.join(base, entry);
        if (fs.existsSync(path.join(candidate, "bin", java))) return candidate;
    }
    return null;
}

const jdkHome = locateJdkHome(jdkRoot);
if (!jdkHome) {
    fail(`JDK 21 not found under ${jdkRoot} (expected jdk-21.0.x+y/bin/java). Install it into .toolchain/jdk21 or set JAVA_HOME.`);
}
if (!fs.existsSync(path.join(sdkRoot, "platforms"))) {
    fail(`Android SDK not found under ${sdkRoot} (expected platforms/, build-tools/, platform-tools/).`);
}

const env = {
    ...process.env,
    JAVA_HOME: jdkHome,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot
};
const sep = isWin ? ";" : ":";
env.PATH = [path.join(jdkHome, "bin"), path.join(sdkRoot, "platform-tools"), env.PATH].join(sep);

const androidDir = path.join(root, "android");
const gradlew = path.join(androidDir, isWin ? "gradlew.bat" : "gradlew");
console.log(`android apk: using JDK ${jdkHome}`);
console.log(`android apk: using Android SDK ${sdkRoot}`);

console.log("android apk: running gradlew assembleDebug ...");
const run = spawnSync(gradlew, ["assembleDebug", "--console=plain"], {
    cwd: androidDir,
    env,
    stdio: "inherit",
    shell: isWin // gradlew.bat must go through cmd.exe
});
if (run.status !== 0) fail(`gradle assembleDebug failed (exit ${run.status}).`);

const apk = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!fs.existsSync(apk)) fail("build finished but app-debug.apk was not produced.");

const { version } = require(path.join(root, "package.json"));
const releases = path.join(root, "releases");
fs.mkdirSync(releases, { recursive: true });
const out = path.join(releases, `WintrChess-${version}-android-debug.apk`);
fs.copyFileSync(apk, out);
console.log(`android apk: staged ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
