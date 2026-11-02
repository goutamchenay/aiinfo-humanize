// Run with: node --test web/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { scan, clean } from "./core.js";

const enc = (s) => Buffer.from(s, "latin1");
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function pngChunk(type, data) {
  const td = Buffer.concat([enc(type), data]);
  return Buffer.concat([u32(data.length), td, u32(zlib.crc32(td))]);
}

function makePng(extra = []) {
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

function exifPayload({ software, orientation }) {
  // Big-endian TIFF with Software (ASCII, offset) and Orientation (SHORT) entries.
  const sw = enc(software + "\0");
  const entries = 2;
  const ifdSize = 2 + entries * 12 + 4;
  const swOffset = 8 + ifdSize;
  const ifd = Buffer.concat([
    Buffer.from([0, entries]),
    Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0]),
    Buffer.concat([Buffer.from([0x01, 0x31, 0, 2]), u32(sw.length), u32(swOffset)]),
    u32(0),
  ]);
  return Buffer.concat([enc("Exif\0\0MM\0\x2a"), u32(8), ifd, sw]);
}

function makeJpeg({ orientation = 1 } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    seg(0xe1, exifPayload({ software: "DALL-E 3", orientation })),
    seg(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x>trainedAlgorithmicMedia</x>")),
    seg(0xeb, enc("JP\0\x01jumbc2pa OpenAI")),
    seg(0xfe, enc("made with ChatGPT")),
    seg(0xdb, Buffer.alloc(65, 1)), // DQT
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
    enc("trailing c2pa"),
  ]);
}

function webpChunk(type, data) {
  const pad = data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([enc(type), u32le(data.length), data, pad]);
}

function makeWebp() {
  const vp8x = Buffer.from([0x2c, 0, 0, 0, 1, 0, 0, 1, 0, 0]); // ICC|EXIF|XMP flags
  const body = Buffer.concat([
    enc("WEBP"),
    webpChunk("VP8X", vp8x),
    webpChunk("ICCP", Buffer.alloc(20, 7)),
    webpChunk("VP8L", Buffer.from([0x2f, 1, 2, 3, 4])),
    webpChunk("EXIF", exifPayload({ software: "OpenAI", orientation: 1 }).subarray(6)),
    webpChunk("XMP ", enc("<x>compositeSynthetic</x>")),
  ]);
  return Buffer.concat([enc("RIFF"), u32le(body.length), body]);
}

test("PNG: detects and strips text, C2PA and ICC chunks, keeps image chunks byte-exact", () => {
  const png = makePng([
    pngChunk("iCCP", enc("icc\0\0xyz")),
    pngChunk("tEXt", enc("parameters\0a cat, Stable Diffusion")),
    pngChunk("caBX", enc("jumb c2pa")),
  ]);
  const r = scan(png);
  assert.equal(r.format, "PNG");
  assert.ok(r.hasAiMarkers);
  assert.ok(r.signatures.includes("PNG C2PA chunk (caBX)"));
  assert.ok(r.blocks.some((b) => b.detail.startsWith("parameters = a cat")));

  const out = clean(png).bytes;
  assert.deepEqual(Buffer.from(out), makePng());
  assert.equal(scan(out).hasMetadata, false);
});

test("JPEG: strips EXIF/XMP/APP11/COM and trailing data, keeps JFIF and scan", () => {
  const r = scan(makeJpeg());
  assert.ok(r.hasAiMarkers);
  assert.deepEqual(r.blocks.map((b) => b.name), ["EXIF (APP1)", "XMP (APP1)", "JUMBF / C2PA (APP11)", "JPEG comment (COM)"]);
  assert.match(r.blocks[0].detail, /Software = DALL-E 3/);

  const out = Buffer.from(clean(makeJpeg()).bytes);
  const after = scan(out);
  assert.equal(after.hasMetadata, false);
  assert.deepEqual(after.signatures, []);
  assert.equal(out.indexOf(enc("JFIF")), 6);
  assert.equal(out.subarray(-2).toString("hex"), "ffd9");
});

test("JPEG: preserves orientation with a minimal EXIF block", () => {
  const out = Buffer.from(clean(makeJpeg({ orientation: 6 })).bytes);
  const r = scan(out);
  assert.equal(r.hasMetadata, false);
  const app1 = out.indexOf(Buffer.from([0xff, 0xe1]));
  assert.ok(app1 > 0 && app1 > out.indexOf(enc("JFIF")), "APP1 follows JFIF APP0");
  assert.equal(out.indexOf(enc("DALL")), -1);
  assert.notEqual(out.indexOf(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])), -1);
});

test("WebP: drops ICCP/EXIF/XMP, clears VP8X flags and fixes RIFF size", () => {
  const webp = makeWebp();
  const r = scan(webp);
  assert.ok(r.hasAiMarkers);
  assert.deepEqual(r.blocks.map((b) => b.name), ["WebP chunk ICCP", "WebP chunk EXIF", "WebP chunk XMP"]);

  const out = Buffer.from(clean(webp).bytes);
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out[20] & 0x2c, 0);
  assert.equal(scan(out).hasMetadata, false);
  assert.notEqual(out.indexOf(enc("VP8L")), -1);
});

test("rejects unsupported files", () => {
  assert.throws(() => scan(enc("GIF89a....")), /Unsupported/);
  assert.throws(() => clean(enc("GIF89a....")), /Unsupported/);
});
