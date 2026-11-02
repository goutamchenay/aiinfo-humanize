// Pure, dependency-free metadata scanner/cleaner for PNG, JPEG and WebP.
// Cleaning removes metadata blocks from the file structure without decoding
// pixels, so image data is preserved byte-for-byte (no quality loss).

export const SIGNATURES = [
  ["C2PA manifest", "c2pa"],
  ["JUMBF box (C2PA container)", "jumb"],
  ["PNG C2PA chunk (caBX)", "caBX"],
  ["IPTC 'trainedAlgorithmicMedia' source type", "trainedAlgorithmicMedia"],
  ["IPTC 'compositeSynthetic' source type", "compositeSynthetic"],
  ["OpenAI", "OpenAI"],
  ["ChatGPT", "ChatGPT"],
  ["DALL-E", "DALL"],
  ["Midjourney", "Midjourney"],
  ["Stable Diffusion", "Stable Diffusion"],
  ["ComfyUI workflow", '"class_type"'],
  ["Adobe Firefly", "Firefly"],
  ["Google Imagen / Gemini", "Imagen"],
];

const GENERATOR_TEXT_KEYS = new Set(["parameters", "prompt", "workflow", "Software", "Comment", "Description"]);

// PNG chunks needed to render the image (incl. APNG animation); everything else is dropped.
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "acTL", "fcTL", "fdAT"]);
// WebP chunks needed to render the image; EXIF, XMP, ICCP, C2PA etc. are dropped.
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

const EXIF_TEXT_TAGS = {
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0131: "Software",
  0x013b: "Artist",
  0x8298: "Copyright",
};

const latin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const ascii = (bytes, start, len) => latin1(bytes.subarray(start, start + len));
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const short = (text, limit = 80) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : t.slice(0, limit - 3) + "...";
};

export function detectFormat(b) {
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return "PNG";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "JPEG";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "WEBP";
  return null;
}

// ---------- PNG ----------

function* pngChunks(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new Error("Corrupt PNG chunk");
    yield { type, start: i, end, data: b.subarray(i + 8, i + 8 + len) };
    i = end;
    if (type === "IEND") break;
  }
}

function pngTextEntry(type, data) {
  const nul = data.indexOf(0);
  const key = ascii(data, 0, nul < 0 ? data.length : nul);
  let value = "";
  if (type === "tEXt") value = latin1(data.subarray(nul + 1));
  else if (type === "iTXt" && data[nul + 1] === 0) {
    // keyword\0 compFlag compMethod lang\0 translated\0 text
    let p = nul + 3;
    p = data.indexOf(0, p) + 1;
    p = data.indexOf(0, p) + 1;
    value = new TextDecoder().decode(data.subarray(p));
  } else value = "(compressed)";
  return { key, value };
}

// ---------- JPEG ----------

function* jpegSegments(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("Corrupt JPEG segment");
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) { yield { marker, start: i, end: b.length, scan: true }; return; }
    const len = u16be(b, i + 2);
    const end = i + 2 + len;
    if (end > b.length) throw new Error("Corrupt JPEG segment");
    yield { marker, start: i, end, data: b.subarray(i + 4, end) };
    i = end;
  }
}

// WebP EXIF chunks hold raw TIFF, sometimes (non-standard) prefixed with "Exif\0\0".
const webpExifPayload = (d) => {
  if (d.length > 6 && ascii(d, 0, 6) === "Exif\0\0") return d;
  const out = new Uint8Array(d.length + 6);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  out.set(d, 6);
  return out;
};

const isExif = (d) => d.length > 6 && ascii(d, 0, 6) === "Exif\0\0";

function readExif(d) {
  // d = "Exif\0\0" + TIFF
  const t = d.subarray(6);
  const le = ascii(t, 0, 2) === "II";
  const u16 = (i) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]);
  const u32 = (i) => (le ? u32le(t, i) : u32be(t, i));
  const out = { orientation: 1, text: {}, entries: 0 };
  const ifd = u32(4);
  if (ifd + 2 > t.length) return out;
  const n = u16(ifd);
  out.entries = n;
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    if (tag === 0x0112 && type === 3) out.orientation = u16(e + 8);
    if (EXIF_TEXT_TAGS[tag] && type === 2) {
      const off = count <= 4 ? e + 8 : u32(e + 8);
      out.text[EXIF_TEXT_TAGS[tag]] = ascii(t, off, Math.max(0, count - 1));
    }
  }
  return out;
}

const isOrientationOnly = (d) => {
  const ex = readExif(d);
  return ex.entries === 1 && ex.orientation > 1 && Object.keys(ex.text).length === 0;
};

// Minimal APP1 carrying only the Orientation tag, so cleaned photos don't rotate.
function orientationApp1(orientation) {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
}

function jpegBlockName(seg) {
  const m = seg.marker;
  const d = seg.data;
  if (m === 0xfe) return "JPEG comment (COM)";
  if (m === 0xe1) return isExif(d) ? "EXIF (APP1)" : ascii(d, 0, 29) === "http://ns.adobe.com/xap/1.0/\0" ? "XMP (APP1)" : "APP1";
  if (m === 0xe2) return ascii(d, 0, 12) === "ICC_PROFILE\0" ? "ICC profile (APP2)" : "APP2";
  if (m === 0xeb) return "JUMBF / C2PA (APP11)";
  if (m === 0xed) return "IPTC / Photoshop (APP13)";
  return `APP${m - 0xe0}`;
}

// Keep APP0 only for JFIF, APP14 only for Adobe (needed for colour transform).
function jpegKeep(seg) {
  const m = seg.marker;
  if (seg.scan) return true;
  if (m === 0xe0) return ascii(seg.data, 0, 5) === "JFIF\0";
  if (m === 0xee) return ascii(seg.data, 0, 5) === "Adobe";
  return !(m >= 0xe1 && m <= 0xef) && m !== 0xfe;
}

// ---------- WebP ----------

function* webpChunks(b) {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const end = Math.min(b.length, i + 8 + len + (len & 1));
    yield { type, start: i, end, data: b.subarray(i + 8, i + 8 + len) };
    i = end;
  }
}

// ---------- public API ----------

export function scan(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = detectFormat(b);
  if (!format) throw new Error("Unsupported file: only PNG, JPEG and WebP are supported");
  const raw = latin1(b);
  const signatures = SIGNATURES.filter(([, needle]) => raw.includes(needle)).map(([label]) => label);
  const blocks = []; // { name, detail, ai }

  if (format === "PNG") {
    for (const c of pngChunks(b)) {
      if (PNG_KEEP.has(c.type)) continue;
      if (c.type === "tEXt" || c.type === "iTXt" || c.type === "zTXt") {
        const { key, value } = pngTextEntry(c.type, c.data);
        blocks.push({ name: `PNG text (${c.type})`, detail: `${key} = ${short(value)}`, ai: GENERATOR_TEXT_KEYS.has(key) });
      } else if (c.type === "caBX") blocks.push({ name: "C2PA manifest (caBX)", detail: `${c.data.length} bytes`, ai: true });
      else if (c.type === "eXIf") blocks.push({ name: "EXIF (eXIf)", detail: `${c.data.length} bytes`, ai: false });
      else blocks.push({ name: `PNG chunk ${c.type}`, detail: `${c.data.length} bytes`, ai: false });
    }
  } else if (format === "JPEG") {
    for (const s of jpegSegments(b)) {
      if (jpegKeep(s)) continue;
      if (s.marker === 0xe1 && isExif(s.data) && isOrientationOnly(s.data)) continue;
      const name = jpegBlockName(s);
      let detail = `${s.data.length} bytes`;
      if (s.marker === 0xe1 && isExif(s.data)) {
        const ex = readExif(s.data);
        const parts = Object.entries(ex.text).map(([k, v]) => `${k} = ${short(v, 40)}`);
        if (parts.length) detail = parts.join(", ");
      } else if (s.marker === 0xfe) detail = short(latin1(s.data));
      blocks.push({ name, detail, ai: s.marker === 0xeb });
    }
  } else {
    for (const c of webpChunks(b)) {
      if (WEBP_KEEP.has(c.type)) continue;
      if (c.type === "EXIF" && isOrientationOnly(webpExifPayload(c.data))) continue;
      blocks.push({ name: `WebP chunk ${c.type.trim()}`, detail: `${c.data.length} bytes`, ai: c.type === "C2PA" });
    }
  }

  const hasAiMarkers = signatures.length > 0 || blocks.some((x) => x.ai);
  return { format, signatures, blocks, hasMetadata: blocks.length > 0, hasAiMarkers };
}

export function clean(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = detectFormat(b);
  if (!format) throw new Error("Unsupported file: only PNG, JPEG and WebP are supported");
  const parts = [];

  if (format === "PNG") {
    parts.push(b.subarray(0, 8));
    for (const c of pngChunks(b)) if (PNG_KEEP.has(c.type)) parts.push(b.subarray(c.start, c.end));
  } else if (format === "JPEG") {
    parts.push(b.subarray(0, 2));
    let orientation = 1;
    const kept = [];
    for (const s of jpegSegments(b)) {
      if (s.marker === 0xe1 && isExif(s.data)) orientation = readExif(s.data).orientation || 1;
      if (!jpegKeep(s)) continue;
      if (s.scan) {
        // Drop anything appended after the final EOI marker.
        let end = s.end;
        for (let i = b.length - 2; i > s.start; i--) if (b[i] === 0xff && b[i + 1] === 0xd9) { end = i + 2; break; }
        kept.push(b.subarray(s.start, end));
      } else kept.push(b.subarray(s.start, s.end));
    }
    // Place the orientation APP1 after JFIF APP0 (if present) to keep a valid order.
    const jfifFirst = kept.length && kept[0][1] === 0xe0 ? 1 : 0;
    if (orientation > 1 && orientation <= 8) kept.splice(jfifFirst, 0, orientationApp1(orientation));
    parts.push(...kept);
  } else {
    const chunks = [];
    let orientation = 1;
    let vp8x = null;
    for (const c of webpChunks(b)) {
      if (c.type === "EXIF") orientation = readExif(webpExifPayload(c.data)).orientation || 1;
      if (!WEBP_KEEP.has(c.type)) continue;
      const chunk = b.slice(c.start, c.end);
      if (c.type === "VP8X") {
        chunk[8] &= ~(0x20 | 0x08 | 0x04); // clear ICC, EXIF, XMP flags
        vp8x = chunk;
      }
      chunks.push(chunk);
    }
    if (vp8x && orientation > 1 && orientation <= 8) {
      const tiff = orientationApp1(orientation).subarray(10); // strip FFE1 + length + "Exif\0\0"
      const exif = new Uint8Array(8 + tiff.length);
      exif.set([0x45, 0x58, 0x49, 0x46, tiff.length, 0, 0, 0]);
      exif.set(tiff, 8);
      vp8x[8] |= 0x08;
      chunks.push(exif);
    }
    const body = chunks.reduce((n, c) => n + c.length, 0) + 4;
    const header = new Uint8Array(12);
    header.set([0x52, 0x49, 0x46, 0x46, body & 0xff, (body >> 8) & 0xff, (body >> 16) & 0xff, (body >>> 24) & 0xff, 0x57, 0x45, 0x42, 0x50]);
    parts.push(header, ...chunks);
  }

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { format, bytes: out };
}
