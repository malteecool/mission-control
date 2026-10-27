// Draws the app icon (the favicon's cyan ring and violet dot on the dashboard's dark background) as a 1024px PNG,
// the source `tauri icon` turns into every size the bundles need. Run: node desktop/scripts/make-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const S = 1024;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons/source.png");

const VOID = [5, 7, 13];
const NEON = [34, 211, 238];
const PLASMA = [167, 139, 250];

/** Signed distance to a rounded square centred in the canvas (negative inside). */
function roundedBox(x, y, half, r) {
  const qx = Math.abs(x - S / 2) - (half - r);
  const qy = Math.abs(y - S / 2) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

const cover = (d) => Math.min(Math.max(0.5 - d, 0), 1); // 1px anti-aliasing
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const tile = cover(roundedBox(px, py, 480, 200));
    let rgb = VOID;
    const ring = cover(Math.abs(roundedBox(px, py, 300, 110)) - 46);
    rgb = mix(rgb, NEON, ring);
    const dot = cover(Math.hypot(px - S / 2, py - S / 2) - 110);
    rgb = mix(rgb, PLASMA, dot);
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(rgb[0]);
    raw[o + 1] = Math.round(rgb[1]);
    raw[o + 2] = Math.round(rgb[2]);
    raw[o + 3] = Math.round(tile * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log(`Wrote ${out}`);
