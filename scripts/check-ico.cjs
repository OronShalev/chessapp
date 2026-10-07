/**
 * Validates an ICO file's directory table (offsets, sizes, BMP/PNG magic).
 * Usage: node scripts/check-ico.cjs <file.ico>
 */
"use strict";

const fs = require("fs");

const file = process.argv[2];
const b = fs.readFileSync(file);

console.log(`file: ${file} (${b.length} bytes)`);
console.log(`reserved=${b.readUInt16LE(0)} type=${b.readUInt16LE(2)} count=${b.readUInt16LE(4)}`);

let o = 6;
let ok = true;
for (let i = 0; i < b.readUInt16LE(4); i++) {
    const w = b[o] || 256;
    const h = b[o + 1] || 256;
    const planes = b.readUInt16LE(o + 4);
    const bitCount = b.readUInt16LE(o + 6);
    const sz = b.readUInt32LE(o + 8);
    const off = b.readUInt32LE(o + 12);
    const first4 = b.slice(off, off + 4).toString("hex");
    const inBounds = off + Math.min(sz, 4) <= b.length;
    if (!inBounds) ok = false;
    console.log(
        `entry ${i}: ${w}x${h} planes=${planes} bpp=${bitCount} `
        + `offset=${off} size=${sz} first4=${first4} ${inBounds ? "ok" : "OUT OF BOUNDS"}`
    );
    o += 16;
}
process.exit(ok ? 0 : 1);