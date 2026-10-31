// generate_icons.js — creates PNG icons using pure Node.js (no dependencies)
// Generates minimal valid PNG files with the extension icon design

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const sizes = [16, 32, 48, 128];
fs.mkdirSync('icons', { recursive: true });

function writePNG(filename, width, height, pixelData) {
  // pixelData: Uint8Array of RGBA values, row by row
  const chunks = [];

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  function makeIHDR() {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
    data[8] = 8;  // bit depth
    data[9] = 2;  // color type: RGB (we'll use RGBA=6)
    data[9] = 6;  // RGBA
    data[10] = 0; // compression
    data[11] = 0; // filter
    data[12] = 0; // interlace
    return makeChunk('IHDR', data);
  }

  function makeIDAT() {
    // Build raw image data with filter byte per row
    const rawRows = [];
    for (let y = 0; y < height; y++) {
      const row = Buffer.alloc(width * 4 + 1);
      row[0] = 0; // filter type: None
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        row[1 + x * 4 + 0] = pixelData[idx + 0];
        row[1 + x * 4 + 1] = pixelData[idx + 1];
        row[1 + x * 4 + 2] = pixelData[idx + 2];
        row[1 + x * 4 + 3] = pixelData[idx + 3];
      }
      rawRows.push(row);
    }
    const raw = Buffer.concat(rawRows);
    const compressed = zlib.deflateSync(raw);
    return makeChunk('IDAT', compressed);
  }

  function makeIEND() {
    return makeChunk('IEND', Buffer.alloc(0));
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = makeCRCTable();
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  let crcTable = null;
  function makeCRCTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c;
    }
    return crcTable;
  }

  function makeChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
  }

  const pngData = Buffer.concat([signature, makeIHDR(), makeIDAT(), makeIEND()]);
  fs.writeFileSync(filename, pngData);
}

function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Transparent background
      pixels[idx + 3] = 0;

      // Red circle with anti-aliasing
      if (dist < r) {
        const alpha = dist > r - 1 ? Math.round((r - dist) * 255) : 255;
        pixels[idx + 0] = 231; // R
        pixels[idx + 1] = 76;  // G
        pixels[idx + 2] = 60;  // B
        pixels[idx + 3] = alpha;

        // Play triangle (white) inside circle
        // Triangle: left edge at 30%, right tip at 72%, vertical center
        const tx1 = cx - r * 0.28;
        const tx2 = cx + r * 0.35;
        const ty1 = cy - r * 0.40;
        const ty2 = cy + r * 0.40;

        // Point-in-triangle test
        function sign(px, py, ax, ay, bx, by) {
          return (px - bx) * (ay - by) - (ax - bx) * (py - by);
        }
        const d1 = sign(x, y, tx1, ty1, tx1, ty2);
        const d2 = sign(x, y, tx1, ty2, tx2, cy);
        const d3 = sign(x, y, tx2, cy, tx1, ty1);
        const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        if (!(hasNeg && hasPos)) {
          pixels[idx + 0] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = alpha;
        }

        // Download arrow (bottom right quadrant, sizes >= 32)
        if (size >= 32) {
          const ax = cx + r * 0.42;
          const ay = cy + r * 0.35;
          const aw = r * 0.12;
          const ah = r * 0.30;
          // Stem
          if (x >= ax - aw && x <= ax + aw && y >= ay - ah && y <= ay + ah * 0.5) {
            pixels[idx + 0] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
            pixels[idx + 3] = Math.round(alpha * 0.85);
          }
          // Arrow head (triangle pointing down)
          const ahx = ax;
          const ahy = ay + ah * 0.5;
          const ahs = aw * 2.2;
          const d1a = sign(x, y, ahx - ahs, ahy - ahs, ahx + ahs, ahy - ahs);
          const d2a = sign(x, y, ahx + ahs, ahy - ahs, ahx, ahy + ahs);
          const d3a = sign(x, y, ahx, ahy + ahs, ahx - ahs, ahy - ahs);
          const hn = (d1a < 0) || (d2a < 0) || (d3a < 0);
          const hp = (d1a > 0) || (d2a > 0) || (d3a > 0);
          if (!(hn && hp)) {
            pixels[idx + 0] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
            pixels[idx + 3] = Math.round(alpha * 0.85);
          }
        }
      }
    }
  }

  return pixels;
}

sizes.forEach(size => {
  const pixels = drawIcon(size);
  const outPath = path.join('icons', `icon${size}.png`);
  writePNG(outPath, size, size, pixels);
  console.log(`Generated ${outPath}`);
});

console.log('All icons generated!');
