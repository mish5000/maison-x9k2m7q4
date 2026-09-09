#!/usr/bin/env node
// Draws the app icon as PNG files with no dependencies (node's zlib only).
// Run: node tools/make-icons.js   -> writes icons/icon-180.png, icon-192.png, icon-512.png
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Simple painter: each shape is tested per pixel, with 4x supersampling for smooth edges.
function draw(size) {
  const bg = [0x1d, 0x4e, 0xd8];      // blue background
  const paper = [0xff, 0xff, 0xff];   // calendar page
  const header = [0xef, 0x44, 0x44];  // red header bar
  const ink = [0x11, 0x18, 0x27];     // dark dots
  const s = size;
  const shapes = [
    // [test(x,y)->bool, color]
    [(x, y) => true, bg],
    [(x, y) => rrect(x, y, s * 0.17, s * 0.22, s * 0.66, s * 0.60, s * 0.07), paper],
    [(x, y) => rrectTop(x, y, s * 0.17, s * 0.22, s * 0.66, s * 0.17, s * 0.07), header],
    // two binder rings
    [(x, y) => rrect(x, y, s * 0.30, s * 0.15, s * 0.06, s * 0.14, s * 0.03), ink],
    [(x, y) => rrect(x, y, s * 0.64, s * 0.15, s * 0.06, s * 0.14, s * 0.03), ink],
    // big "day" block: a bold tick/check mark made of two rectangles rotated -> keep simple: three dots row
    [(x, y) => circle(x, y, s * 0.36, s * 0.55, s * 0.045), ink],
    [(x, y) => circle(x, y, s * 0.50, s * 0.55, s * 0.045), ink],
    [(x, y) => circle(x, y, s * 0.64, s * 0.55, s * 0.045), ink],
    [(x, y) => circle(x, y, s * 0.36, s * 0.69, s * 0.045), ink],
    [(x, y) => circle(x, y, s * 0.50, s * 0.69, s * 0.045), header],
  ];
  const out = Buffer.alloc(s * s * 4);
  const SS = 4;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      let col = bg;
      for (const [test, c] of shapes) if (test(px, py)) col = c;
      r += col[0]; g += col[1]; b += col[2];
    }
    const n = SS * SS, i = (y * s + x) * 4;
    out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n; out[i + 3] = 255;
  }
  return png(s, s, out);
}
function rrect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
function rrectTop(px, py, x, y, w, h, r) { // rounded only on the top corners
  if (!rrect(px, py, x, y, w, h + r, r)) return false;
  return py <= y + h;
}
function circle(px, py, cx, cy, r) { return (px - cx) ** 2 + (py - cy) ** 2 <= r * r; }

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, draw(size));
  console.log("wrote", path.relative(process.cwd(), file));
}
