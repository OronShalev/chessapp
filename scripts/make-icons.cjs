/**
 * Procedurally generates the WintrChess app icons (no external image
 * tooling required):
 *
 *   - desktop/build/icon.ico                 (Windows: PNG entries 16..256)
 *   - <androidResDir>/mipmap-*dpi/ic_launcher.png        (legacy, 48..192)
 *   - <androidResDir>/mipmap-*dpi/ic_launcher_foreground.png (adaptive, 108..432)
 *   - <androidResDir>/mipmap-anydpi-v26/ic_launcher.xml + background colour
 *
 * Usage:
 *   node scripts/make-icons.cjs                // desktop icon only
 *   node scripts/make-icons.cjs <androidRes>   // desktop + android icons
 *
 * The artwork is a dark navy tile with a chessboard and a white pawn.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++)
        c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
    const stride = size * 4;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type: RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0))
    ]);
}

// ---------------------------------------------------------------------------
// Artwork (all coordinates normalised to [0, 1])
// ---------------------------------------------------------------------------

const BG = [23, 27, 38];        // navy tile background
const BOARD_LIGHT = [240, 217, 181];
const BOARD_DARK = [181, 136, 99];
const PAWN = [248, 247, 244];   // piece white

function inRoundedSquare(x, y, radius) {
    const cx = Math.min(Math.max(x, radius), 1 - radius);
    const cy = Math.min(Math.max(y, radius), 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function pawnAt(x, y) {
    const cx = 0.5;
    // Head
    if ((x - cx) ** 2 + (y - 0.40) ** 2 <= 0.085 ** 2) return true;
    // Body (tapered)
    if (y >= 0.44 && y <= 0.615) {
        const t = (y - 0.44) / (0.615 - 0.44);
        if (Math.abs(x - cx) <= 0.062 + (0.118 - 0.062) * t) return true;
    }
    // Base
    if (y > 0.615 && y <= 0.665 && Math.abs(x - cx) <= 0.128) return true;
    return false;
}

function boardAt(x, y, margin) {
    if (x < margin || x > 1 - margin || y < margin || y > 1 - margin)
        return null;
    const side = 1 - 2 * margin;
    const col = Math.floor(((x - margin) / side) * 8);
    const row = Math.floor(((y - margin) / side) * 8);
    if (col > 7 || row > 7) return null;
    return (col + row) % 2 === 0 ? BOARD_LIGHT : BOARD_DARK;
}

/**
 * Samples the artwork at a normalised coordinate.
 * @param {string} variant "tile" (rounded-square background), "round"
 *        (circular background) or "adaptive" (transparent background,
 *        motif inside the adaptive-icon safe zone)
 */
function samplePixel(x, y, variant) {
    if (variant === "adaptive") {
        const motif = 0.68;
        const inset = (1 - motif) / 2;
        if (x < inset || x > 1 - inset || y < inset || y > 1 - inset)
            return [0, 0, 0, 0];
        const u = (x - inset) / motif;
        const v = (y - inset) / motif;
        if (pawnAt(u, v)) return [...PAWN, 255];
        const board = boardAt(u, v, 0.03);
        return board ? [...board, 255] : [0, 0, 0, 0];
    }
    if (variant === "round") {
        if ((x - 0.5) ** 2 + (y - 0.5) ** 2 > 0.5 ** 2)
            return [0, 0, 0, 0];
    } else { // tile
        if (!inRoundedSquare(x, y, 0.18)) return [0, 0, 0, 0];
    }
    if (pawnAt(x, y)) return [...PAWN, 255];
    const board = boardAt(x, y, 0.17);
    return board ? [...board, 255] : [...BG, 255];
}

function renderIcon(size, { variant = "tile" } = {}) {
    const rgba = Buffer.alloc(size * size * 4);
    const ss = 3; // 3x3 supersampling for smooth edges
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const c = samplePixel(
                        (px + (sx + 0.5) / ss) / size,
                        (py + (sy + 0.5) / ss) / size,
                        variant
                    );
                    r += c[0]; g += c[1]; b += c[2]; a += c[3];
                }
            }
            const n = ss * ss;
            const o = (py * size + px) * 4;
            rgba[o] = Math.round(r / n);
            rgba[o + 1] = Math.round(g / n);
            rgba[o + 2] = Math.round(b / n);
            rgba[o + 3] = Math.round(a / n);
        }
    }
    return encodePng(size, rgba);
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function makeIco(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(pngs.length, 4);

    // Layout: ICONDIR, then all 16-byte directory entries, then all image
    // data. Offsets in the directory must point into the trailing data.
    let dataOffset = header.length + pngs.length * 16;
    const dirEntries = pngs.map(({ size, data }) => {
        const entry = Buffer.alloc(16);
        entry[0] = size >= 256 ? 0 : size;
        entry[1] = size >= 256 ? 0 : size;
        entry[2] = 0; // no palette
        entry[3] = 0;
        entry.writeUInt16LE(1, 4);   // planes
        entry.writeUInt16LE(32, 6);  // bpp
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(dataOffset, 12);
        dataOffset += data.length;
        return entry;
    });

    return Buffer.concat([
        header,
        ...dirEntries,
        ...pngs.map(({ data }) => data)
    ]);
}

function writeDesktopIcon() {
    const dir = path.resolve(__dirname, "..", "desktop", "build");
    fs.mkdirSync(dir, { recursive: true });
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngs = sizes.map(size => ({ size, data: renderIcon(size) }));
    const out = path.join(dir, "icon.ico");
    fs.writeFileSync(out, makeIco(pngs));
    console.log(
        `desktop icon: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`
    );
}

const DENSITIES = [
    { name: "mdpi", scale: 1 },
    { name: "hdpi", scale: 1.5 },
    { name: "xhdpi", scale: 2 },
    { name: "xxhdpi", scale: 3 },
    { name: "xxxhdpi", scale: 4 }
];

function writeAndroidIcons(resDir) {
    const root = path.resolve(resDir);
    for (const { name, scale } of DENSITIES) {
        const dir = path.join(root, `mipmap-${name}`);
        fs.mkdirSync(dir, { recursive: true });
        // Legacy launcher icons: 48dp (square + round)
        fs.writeFileSync(
            path.join(dir, "ic_launcher.png"),
            renderIcon(Math.round(48 * scale), { variant: "tile" })
        );
        fs.writeFileSync(
            path.join(dir, "ic_launcher_round.png"),
            renderIcon(Math.round(48 * scale), { variant: "round" })
        );
        // Adaptive icon foreground: 108dp, safe-zone motif
        fs.writeFileSync(
            path.join(dir, "ic_launcher_foreground.png"),
            renderIcon(Math.round(108 * scale), { variant: "adaptive" })
        );
    }

    // Adaptive icon definitions (square + round)
    const anydpi = path.join(root, "mipmap-anydpi-v26");
    fs.mkdirSync(anydpi, { recursive: true });
    const adaptiveXml =
        `<?xml version="1.0" encoding="utf-8"?>\n`
        + `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n`
        + `    <background android:drawable="@color/ic_launcher_background"/>\n`
        + `    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n`
        + `</adaptive-icon>\n`;
    fs.writeFileSync(path.join(anydpi, "ic_launcher.xml"), adaptiveXml);
    fs.writeFileSync(path.join(anydpi, "ic_launcher_round.xml"), adaptiveXml);

    // Adaptive icon background colour (dedicated resource file, as the
    // Capacitor template provides it)
    const values = path.join(root, "values");
    fs.mkdirSync(values, { recursive: true });
    fs.writeFileSync(
        path.join(values, "ic_launcher_background.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n`
        + `    <color name="ic_launcher_background">#171B26</color>\n`
        + `</resources>\n`
    );

    console.log(`android icons: ${root}`);
}

// ---------------------------------------------------------------------------

const [androidResDir] = process.argv.slice(2);

writeDesktopIcon();
if (androidResDir) writeAndroidIcons(androidResDir);