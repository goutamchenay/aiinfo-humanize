import { scan, clean } from "./core.js";

const $ = (id) => document.getElementById(id);
const drop = $("drop");
const input = $("file");
const results = $("results");
const toolbar = $("toolbar");
const template = $("card");
const cleaned = []; // { name, url }

const MIME = { PNG: "image/png", JPEG: "image/jpeg", WEBP: "image/webp" };

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function cleanName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}_clean${name.slice(dot)}` : `${name}_clean`;
}

function addFinding(list, text, ai) {
  const li = document.createElement("li");
  li.textContent = text;
  if (ai) li.className = "ai";
  list.append(li);
}

async function handle(file) {
  const node = template.content.firstElementChild.cloneNode(true);
  const $$ = (sel) => node.querySelector(sel);
  $$(".name").textContent = file.name;
  results.append(node);
  toolbar.hidden = false;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const report = scan(bytes);
    const badge = $$(".badge");
    if (report.hasAiMarkers) { badge.textContent = "AI markers found"; badge.classList.add("ai"); }
    else if (report.hasMetadata) { badge.textContent = "Metadata found"; badge.classList.add("meta"); }
    else { badge.textContent = "Already clean"; badge.classList.add("clean"); }
    $$(".meta").textContent = `${report.format} · ${kb(bytes.length)}`;

    const list = $$(".findings");
    for (const s of report.signatures) addFinding(list, `Signature: ${s}`, true);
    for (const b of report.blocks) addFinding(list, `${b.name}: ${b.detail}`, b.ai);

    const out = clean(bytes);
    const check = scan(out.bytes);
    const after = $$(".after");
    if (check.hasMetadata || check.hasAiMarkers) {
      after.textContent = `Cleaned to ${kb(out.bytes.length)}, but some markers remain: ${check.signatures.join(", ") || check.blocks.map((b) => b.name).join(", ")}`;
    } else {
      after.textContent = `✓ Clean file: ${kb(out.bytes.length)} (removed ${kb(bytes.length - out.bytes.length)})`;
      after.classList.add("ok");
    }

    const url = URL.createObjectURL(new Blob([out.bytes], { type: MIME[out.format] }));
    const link = $$(".download");
    link.href = url;
    link.download = cleanName(file.name);
    link.hidden = false;
    cleaned.push({ name: link.download, url });
  } catch (err) {
    const badge = $$(".badge");
    badge.textContent = "Error";
    badge.classList.add("error");
    $$(".meta").textContent = err.message;
  }
}

function handleFiles(files) {
  for (const f of files) handle(f);
}

input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
document.addEventListener("paste", (e) => handleFiles([...e.clipboardData.files]));

$("download-all").addEventListener("click", async () => {
  for (const { name, url } of cleaned) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    await new Promise((r) => setTimeout(r, 250));
  }
});

$("reset").addEventListener("click", () => {
  for (const { url } of cleaned) URL.revokeObjectURL(url);
  cleaned.length = 0;
  results.replaceChildren();
  toolbar.hidden = true;
});
