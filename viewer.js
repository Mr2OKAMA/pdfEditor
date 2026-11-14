"use strict";
const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

const $ = (s) => document.querySelector(s);
const viewerEl = $("#viewer");
const state = {
  bytes: null,
  name: "document.pdf",
  pdf: null,
  zoom: 1.2,
  tool: "select",
  current: 0,
  viewports: [], // scale=1 viewports
  pages: [], // { div, ov, ctx }
  annots: {}, // pageIndex -> annotation[]
  history: [],
  selected: null, // { page, a }
  pendingImage: null,
  docs: [], // { name, bytes, current } (active entry is synced via stashActive)
  active: -1,
  textReady: Promise.resolve(), // resolves when every page's text layer is built
};

// incremented on every renderAll() so stale async text-layer builds can bail out
let renderSeq = 0;

const search = { q: "", cs: false, matches: [], idx: -1 };

function status(msg, ms = 2500) {
  const el = $("#status");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(status.t);
  if (ms) status.t = setTimeout(() => (el.style.display = "none"), ms);
}

const hexToRgb = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const hasDoc = () => !!state.bytes;
const countAnnots = () => Object.values(state.annots).reduce((n, l) => n + l.length, 0);

// ---------- loading / rendering ----------
async function loadBytes(bytes, name) {
  state.bytes = bytes;
  if (name) state.name = name;
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.annots = {};
  state.history = [];
  state.selected = null;
  state.current = Math.min(state.current, state.pdf.numPages - 1);
  $("#btn-save").disabled = false;
  $("#btn-print").disabled = false;
  $("#search-input").disabled = false;
  await renderAll();
}

async function renderAll() {
  const keep = viewerEl.scrollTop;
  const token = ++renderSeq;
  viewerEl.textContent = "";
  state.pages = [];
  state.viewports = [];
  const textTasks = [];
  const dpr = window.devicePixelRatio || 1;
  for (let i = 0; i < state.pdf.numPages; i++) {
    const page = await state.pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: state.zoom });
    state.viewports.push(vp1);

    const div = document.createElement("div");
    div.className = "page";
    div.style.width = vp.width + "px";
    div.style.height = vp.height + "px";
    div.style.setProperty("--scale-factor", state.zoom);
    const cv = document.createElement("canvas");
    cv.width = vp.width * dpr;
    cv.height = vp.height * dpr;
    cv.style.width = vp.width + "px";
    cv.style.height = vp.height + "px";
    const tl = document.createElement("div");
    tl.className = "textLayer";
    const ov = document.createElement("canvas");
    ov.className = "ov";
    ov.width = vp.width * dpr;
    ov.height = vp.height * dpr;
    ov.style.width = vp.width + "px";
    ov.style.height = vp.height + "px";
    div.append(cv, tl, ov);
    viewerEl.append(div);
    const entry = { div, ov, ctx: ov.getContext("2d"), tl, textDivs: [], textStrs: [], divStart: [], pageText: "", hlDivs: [], textReady: false };
    state.pages.push(entry);
    attachPageEvents(i, entry);
    page.render({ canvasContext: cv.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    textTasks.push(buildTextLayer(i, page, vp, entry, token));
    redraw(i);
  }
  state.textReady = Promise.all(textTasks);
  viewerEl.scrollTop = keep;
  updatePageLabel();
  $("#zoom-label").textContent = Math.round((state.zoom / 1.2) * 100) + "%";
  setTool(state.tool);
  if (search.q) runSearch(false);
}

// ---------- text layer (selection + search) ----------
async function buildTextLayer(i, page, vp, entry, token) {
  try {
    const source = await page.getTextContent();
    if (token !== renderSeq) return;
    const textDivs = [];
    await pdfjsLib.renderTextLayer({ textContentSource: source, container: entry.tl, viewport: vp, textDivs }).promise;
    if (token !== renderSeq) return;
    entry.textDivs = textDivs;
    entry.textStrs = textDivs.map((d) => d.textContent || "");
    entry.divStart = [];
    let off = 0;
    for (const s of entry.textStrs) { entry.divStart.push(off); off += s.length; }
    entry.pageText = entry.textStrs.join("");
    const eoc = document.createElement("div");
    eoc.className = "endOfContent";
    entry.tl.append(eoc);
    entry.tl.addEventListener("pointerdown", () => eoc.classList.add("active"));
    entry.tl.addEventListener("pointerup", () => eoc.classList.remove("active"));
    entry.textReady = true;
  } catch (e) {
    if (e && e.name !== "AbortException") console.error(e);
  }
}

function clearHighlights(i) {
  const e = state.pages[i];
  if (!e || !e.hlDivs.length) return;
  for (const k of e.hlDivs) if (e.textDivs[k]) e.textDivs[k].textContent = e.textStrs[k];
  e.hlDivs = [];
}

function clearAllHighlights() {
  state.pages.forEach((_, i) => clearHighlights(i));
}

function applyHighlights(i) {
  const e = state.pages[i];
  if (!e || !e.textReady) return;
  clearHighlights(i);
  const segs = new Map();
  search.matches.forEach((m, g) => {
    if (m.page !== i) return;
    const sel = g === search.idx;
    let k = divIndexAt(e, m.begin);
    let pos = m.begin;
    while (k < e.textStrs.length && pos < m.end) {
      const ds = e.divStart[k], de = ds + e.textStrs[k].length;
      const s = Math.max(pos, ds) - ds, en = Math.min(m.end, de) - ds;
      if (en > s) {
        if (!segs.has(k)) segs.set(k, []);
        segs.get(k).push({ s, e: en, sel });
        pos = ds + en;
      }
      k++;
    }
  });
  for (const [k, list] of segs) {
    const div = e.textDivs[k];
    if (!div) continue;
    const str = e.textStrs[k];
    list.sort((a, b) => a.s - b.s);
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const sg of list) {
      if (sg.s < last) continue;
      if (sg.s > last) frag.append(document.createTextNode(str.slice(last, sg.s)));
      const sp = document.createElement("span");
      sp.className = "highlight" + (sg.sel ? " selected" : "");
      sp.textContent = str.slice(sg.s, sg.e);
      frag.append(sp);
      last = sg.e;
    }
    if (last < str.length) frag.append(document.createTextNode(str.slice(last)));
    div.textContent = "";
    div.append(frag);
    e.hlDivs.push(k);
  }
}

function divIndexAt(e, off) {
  let lo = 0, hi = e.divStart.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (e.divStart[mid] <= off) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function updateSearchCount() {
  const n = search.matches.length;
  $("#search-count").textContent = !search.q ? "" : n ? `${search.idx + 1} / ${n}` : "0 件";
  $("#search-prev").disabled = $("#search-next").disabled = n < 2;
}

async function runSearch(reset = true) {
  const q = $("#search-input").value;
  search.q = q;
  search.cs = $("#search-case").checked;
  clearAllHighlights();
  if (!q || !hasDoc()) {
    search.matches = [];
    search.idx = -1;
    updateSearchCount();
    return;
  }
  const token = renderSeq;
  await state.textReady;
  if (token !== renderSeq || search.q !== q) return;
  const needle = search.cs ? q : q.toLowerCase();
  const matches = [];
  state.pages.forEach((e, i) => {
    if (!e.textReady) return;
    const hay = search.cs ? e.pageText : e.pageText.toLowerCase();
    for (let p = 0; ;) {
      const k = hay.indexOf(needle, p);
      if (k < 0) break;
      matches.push({ page: i, begin: k, end: k + needle.length });
      p = k + needle.length;
    }
  });
  search.matches = matches;
  if (reset || search.idx < 0 || search.idx >= matches.length) search.idx = matches.length ? 0 : -1;
  state.pages.forEach((_, i) => applyHighlights(i));
  updateSearchCount();
  if (reset) scrollToMatch();
}

function gotoMatch(d) {
  const n = search.matches.length;
  if (!n) return;
  const prev = search.idx;
  search.idx = (search.idx + d + n) % n;
  const pages = new Set([search.matches[prev]?.page, search.matches[search.idx].page]);
  pages.forEach((i) => i !== undefined && applyHighlights(i));
  updateSearchCount();
  scrollToMatch();
}

function scrollToMatch() {
  const m = search.matches[search.idx];
  if (!m) return;
  const e = state.pages[m.page];
  const el = e && e.textDivs[divIndexAt(e, m.begin)];
  (el || e?.div)?.scrollIntoView({ block: "center" });
  if (state.current !== m.page) { state.current = m.page; updatePageLabel(); }
}

// ---------- printing ----------
let printing = false;

async function printDoc() {
  if (!hasDoc() || printing) return;
  printing = true;
  const container = $("#print-container");
  container.textContent = "";
  const style = document.getElementById("print-style") || Object.assign(document.createElement("style"), { id: "print-style" });
  document.head.append(style);
  try {
    const n = state.pdf.numPages;
    // 150dpi for normal documents, lower for long ones to limit memory use
    const scale = (n > 50 ? 110 : 150) / 72;
    const v1 = state.viewports[0] || state.pdf.getPage(1).getViewport({ scale: 1 });
    style.textContent = `@page { size: ${Math.round(v1.width)}pt ${Math.round(v1.height)}pt; margin: 0; }`;
    for (let i = 0; i < n; i++) {
      status(`印刷の準備中… ${i + 1}/${n}`, 0);
      const page = await state.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale });
      const cv = document.createElement("canvas");
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      (state.annots[i] || []).forEach((a) => drawAnnot(ctx, a, scale));
      const img = new Image();
      img.src = cv.toDataURL("image/png");
      cv.width = cv.height = 0;
      await img.decode();
      const wrap = document.createElement("div");
      wrap.className = "print-page";
      wrap.append(img);
      container.append(wrap);
    }
    status("");
    window.addEventListener("afterprint", endPrint, { once: true });
    window.print();
  } catch (e) {
    console.error(e);
    status("印刷に失敗: " + e.message, 5000);
    endPrint();
  }
}

function endPrint() {
  printing = false;
  $("#print-container").textContent = "";
  document.getElementById("print-style")?.remove();
}

function updatePageLabel() {
  const n = state.pdf ? state.pdf.numPages : 0;
  $("#page-label").textContent = `${state.current + 1} / ${n}`;
  state.pages.forEach((p, i) => p.div.classList.toggle("current", i === state.current));
}

// ---------- annotations drawing ----------
function setFont(ctx, a, z) {
  ctx.font = `${a.size * z}px "Yu Gothic UI", "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
}

function measureText(a) {
  const c = document.createElement("canvas").getContext("2d");
  c.font = `${a.size}px "Yu Gothic UI", "Segoe UI", sans-serif`;
  const lines = a.text.split("\n");
  a.w = Math.max(...lines.map((l) => c.measureText(l).width), 4);
  a.h = lines.length * a.size * 1.2;
}

function drawAnnot(ctx, a, z) {
  ctx.save();
  switch (a.type) {
    case "highlight":
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x * z, a.y * z, a.w * z, a.h * z);
      break;
    case "rect":
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.lw * z;
      ctx.strokeRect(a.x * z, a.y * z, a.w * z, a.h * z);
      break;
    case "draw":
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.lw * z;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      a.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * z, y * z) : ctx.moveTo(x * z, y * z)));
      if (a.pts.length === 1) ctx.lineTo(a.pts[0][0] * z + 0.01, a.pts[0][1] * z);
      ctx.stroke();
      break;
    case "text":
      ctx.fillStyle = a.color;
      setFont(ctx, a, z);
      a.text.split("\n").forEach((l, i) => ctx.fillText(l, a.x * z, (a.y + i * a.size * 1.2) * z));
      break;
    case "image":
      ctx.drawImage(a.img, a.x * z, a.y * z, a.w * z, a.h * z);
      break;
  }
  ctx.restore();
}

function bounds(a) {
  if (a.type === "draw") {
    const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function redraw(i, preview) {
  const { ov, ctx } = state.pages[i];
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ov.width, ov.height);
  (state.annots[i] || []).forEach((a) => drawAnnot(ctx, a, state.zoom));
  if (preview) drawAnnot(ctx, preview, state.zoom);
  if (state.selected && state.selected.page === i) {
    const b = bounds(state.selected.a);
    ctx.save();
    ctx.strokeStyle = "#0f6cbd";
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(b.x * state.zoom - 3, b.y * state.zoom - 3, b.w * state.zoom + 6, b.h * state.zoom + 6);
    ctx.restore();
  }
}

// ---------- history ----------
function pushHistory() {
  const snap = {};
  for (const k in state.annots) snap[k] = state.annots[k].slice();
  state.history.push(snap);
  if (state.history.length > 100) state.history.shift();
}
function undo() {
  const snap = state.history.pop();
  if (!snap) return;
  state.annots = snap;
  state.selected = null;
  state.pages.forEach((_, i) => redraw(i));
}
function addAnnot(i, a) {
  pushHistory();
  (state.annots[i] ||= []).push(a);
  redraw(i);
}

// ---------- events ----------
function setTool(t) {
  state.tool = t;
  document.querySelectorAll("#tools [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  state.pages.forEach((p) => {
    p.div.classList.toggle("select", t === "select");
    p.div.classList.toggle("textsel", t === "textsel");
  });
  if (t === "highlight") $("#color").value = "#ffeb3b";
  else if (t === "draw" || t === "rect") $("#color").value = "#e53935";
  else if (t === "text") $("#color").value = "#000000";
}

function hit(i, x, y) {
  const list = state.annots[i] || [];
  for (let k = list.length - 1; k >= 0; k--) {
    const b = bounds(list[k]);
    const m = 4;
    if (x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m) return list[k];
  }
  return null;
}

function attachPageEvents(i, { div, ov }) {
  const pos = (e) => {
    const r = ov.getBoundingClientRect();
    return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom];
  };
  ov.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    state.current = i;
    updatePageLabel();
    const [x, y] = pos(e);
    const tool = state.tool;
    const color = $("#color").value;
    const lw = +$("#width").value || 2;

    if (tool === "select") {
      const a = hit(i, x, y);
      const prev = state.selected && state.selected.page;
      state.selected = a ? { page: i, a } : null;
      if (prev !== undefined && prev !== i) redraw(prev);
      redraw(i);
      if (!a) return;
      pushHistory();
      const list = state.annots[i];
      const clone = structuredCloneAnnot(a);
      list[list.indexOf(a)] = clone;
      state.selected = { page: i, a: clone };
      let lx = x, ly = y;
      ov.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const [nx, ny] = pos(ev);
        shift(clone, nx - lx, ny - ly);
        lx = nx; ly = ny;
        redraw(i);
      };
      const up = () => {
        ov.removeEventListener("pointermove", move);
        ov.removeEventListener("pointerup", up);
      };
      ov.addEventListener("pointermove", move);
      ov.addEventListener("pointerup", up);
      return;
    }

    if (tool === "text") {
      startTextInput(i, div, x, y, color);
      return;
    }
    if (tool === "image") {
      if (!state.pendingImage) { $("#file-image").click(); return; }
      const im = state.pendingImage;
      const w = Math.min(im.width || 200, im.img.naturalWidth), h = (w * im.img.naturalHeight) / im.img.naturalWidth;
      addAnnot(i, { type: "image", x: x - w / 2, y: y - h / 2, w, h, img: im.img, bytes: im.bytes, mime: im.mime });
      return;
    }

    ov.setPointerCapture(e.pointerId);
    let cur;
    if (tool === "draw") cur = { type: "draw", pts: [[x, y]], color, lw };
    else cur = { type: tool, x, y, w: 0, h: 0, color, lw };
    const move = (ev) => {
      const [nx, ny] = pos(ev);
      if (tool === "draw") cur.pts.push([nx, ny]);
      else { cur.w = nx - x; cur.h = ny - y; }
      redraw(i, cur);
    };
    const up = () => {
      ov.removeEventListener("pointermove", move);
      ov.removeEventListener("pointerup", up);
      if (tool !== "draw") {
        if (Math.abs(cur.w) < 2 || Math.abs(cur.h) < 2) return redraw(i);
        if (cur.w < 0) { cur.x += cur.w; cur.w = -cur.w; }
        if (cur.h < 0) { cur.y += cur.h; cur.h = -cur.h; }
      }
      addAnnot(i, cur);
    };
    ov.addEventListener("pointermove", move);
    ov.addEventListener("pointerup", up);
  });
}

function structuredCloneAnnot(a) {
  const c = { ...a };
  if (a.pts) c.pts = a.pts.map((p) => p.slice());
  return c;
}
function shift(a, dx, dy) {
  if (a.pts) a.pts.forEach((p) => { p[0] += dx; p[1] += dy; });
  else { a.x += dx; a.y += dy; }
}

function startTextInput(i, div, x, y, color) {
  const size = +$("#fontsize").value || 16;
  const ta = document.createElement("textarea");
  ta.style.left = x * state.zoom + "px";
  ta.style.top = y * state.zoom + "px";
  ta.style.fontSize = size * state.zoom + "px";
  ta.style.color = color;
  ta.style.minWidth = "120px";
  ta.rows = 1;
  ta.placeholder = "テキスト";
  div.append(ta);
  setTimeout(() => ta.focus(), 0);
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, "");
    ta.remove();
    if (!text) return;
    const a = { type: "text", x, y, text, size, color };
    measureText(a);
    addAnnot(i, a);
  };
  ta.addEventListener("input", () => {
    ta.rows = ta.value.split("\n").length;
    ta.style.width = "auto";
    ta.style.width = Math.max(120, ta.scrollWidth) + "px";
  });
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { ta.value = ""; commit(); }
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); commit(); }
  });
}

// ---------- baking annotations into PDF ----------
function renderTextPng(text, size, color, rotationDeg = 0, alpha = 1) {
  const S = 3;
  const m = document.createElement("canvas").getContext("2d");
  const font = `${size * S}px "Yu Gothic UI", "Segoe UI", sans-serif`;
  m.font = font;
  const lines = text.split("\n");
  const w = Math.max(...lines.map((l) => m.measureText(l).width), 4);
  const h = lines.length * size * S * 1.2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cw = Math.ceil(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
  const ch = Math.ceil(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(-rad);
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  lines.forEach((l, i) => ctx.fillText(l, -w / 2, -h / 2 + i * size * S * 1.2));
  return { dataUrl: c.toDataURL("image/png"), w: cw / S, h: ch / S };
}
const dataUrlBytes = (u) => Uint8Array.from(atob(u.split(",")[1]), (c) => c.charCodeAt(0));

async function bakeAnnotations(doc) {
  for (const [k, list] of Object.entries(state.annots)) {
    const idx = +k;
    const page = doc.getPage(idx);
    const vp = state.viewports[idx];
    const R = vp.rotation || 0;
    const pt = (x, y) => vp.convertToPdfPoint(x, y);
    const box = (a) => {
      const [x1, y1] = pt(a.x, a.y), [x2, y2] = pt(a.x + a.w, a.y + a.h);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    };
    for (const a of list) {
      if (a.type === "highlight") {
        page.drawRectangle({ ...box(a), color: hexToRgb(a.color), opacity: 0.35 });
      } else if (a.type === "rect") {
        page.drawRectangle({ ...box(a), borderColor: hexToRgb(a.color), borderWidth: a.lw });
      } else if (a.type === "draw") {
        const c = hexToRgb(a.color);
        const p = a.pts.length === 1 ? [a.pts[0], [a.pts[0][0] + 0.01, a.pts[0][1]]] : a.pts;
        for (let j = 1; j < p.length; j++) {
          const [sx, sy] = pt(...p[j - 1]), [ex, ey] = pt(...p[j]);
          page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.lw, color: c, lineCap: 1 });
        }
      } else if (a.type === "text" || a.type === "image") {
        let img;
        if (a.type === "text") {
          const t = renderTextPng(a.text, a.size, a.color);
          img = await doc.embedPng(dataUrlBytes(t.dataUrl));
        } else {
          img = a.mime === "image/png" ? await doc.embedPng(a.bytes) : await doc.embedJpg(a.bytes);
        }
        const [x, y] = pt(a.x, a.y + a.h);
        page.drawImage(img, { x, y, width: a.w, height: a.h, rotate: degrees(R) });
      }
    }
  }
}

async function commitAnnotations() {
  if (!countAnnots()) return;
  const doc = await PDFDocument.load(state.bytes);
  await bakeAnnotations(doc);
  state.bytes = await doc.save();
  state.annots = {};
  state.history = [];
}

async function currentDoc() {
  await commitAnnotations();
  return PDFDocument.load(state.bytes);
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function save() {
  if (!hasDoc()) return;
  try {
    status("保存中…", 0);
    await commitAnnotations();
    download(state.bytes, state.name.replace(/\.pdf$/i, "") + "_edited.pdf");
    await loadBytes(state.bytes);
    status("保存しました");
  } catch (e) { console.error(e); status("保存に失敗: " + e.message, 5000); }
}

// ---------- page operations ----------
function parseRange(str, n) {
  const out = new Set();
  for (const part of str.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) if (p >= 1 && p <= n) out.add(p - 1);
  }
  return [...out].sort((x, y) => x - y);
}

async function pageOp(op) {
  if (!hasDoc()) return;
  const cur = state.current;
  try {
    const doc = await currentDoc();
    const n = doc.getPageCount();
    let reload = true;
    switch (op) {
      case "rotate-l":
      case "rotate-r": {
        const p = doc.getPage(cur);
        const r = (p.getRotation().angle + (op === "rotate-r" ? 90 : -90) + 360) % 360;
        p.setRotation(degrees(r));
        break;
      }
      case "delete":
        if (n <= 1) return status("最後のページは削除できません");
        if (!confirm(`${cur + 1} ページ目を削除しますか？`)) return;
        doc.removePage(cur);
        state.current = Math.min(cur, n - 2);
        break;
      case "up":
      case "down": {
        const to = cur + (op === "up" ? -1 : 1);
        if (to < 0 || to >= n) return;
        const p = doc.getPage(cur);
        doc.removePage(cur);
        doc.insertPage(to, p);
        state.current = to;
        break;
      }
      case "blank": {
        const { width, height } = doc.getPage(cur).getSize();
        doc.insertPage(cur + 1, [width, height]);
        state.current = cur + 1;
        break;
      }
      case "merge":
        reload = false;
        $("#file-merge").click();
        break;
      case "extract": {
        reload = false;
        const s = prompt(`抽出するページ（例: 1-3,5）。全${n}ページ`, String(cur + 1));
        if (!s) return;
        const idx = parseRange(s, n);
        if (!idx.length) return status("ページ指定が不正です");
        const out = await PDFDocument.create();
        (await out.copyPages(doc, idx)).forEach((p) => out.addPage(p));
        download(await out.save(), state.name.replace(/\.pdf$/i, "") + "_extract.pdf");
        break;
      }
      case "watermark": {
        const text = prompt("透かしの文字列", "社外秘");
        if (!text) return;
        const t = renderTextPng(text, 80, "#888888", 45, 0.3);
        const img = await doc.embedPng(dataUrlBytes(t.dataUrl));
        doc.getPages().forEach((p) => {
          const { width, height } = p.getSize();
          p.drawImage(img, { x: width / 2 - t.w / 2, y: height / 2 - t.h / 2, width: t.w, height: t.h });
        });
        break;
      }
      case "numbers": {
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.getPages().forEach((p, i) => {
          const label = `${i + 1} / ${n}`;
          const { width } = p.getSize();
          p.drawText(label, { x: width / 2 - font.widthOfTextAtSize(label, 10) / 2, y: 20, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
        });
        break;
      }
    }
    if (reload) {
      state.bytes = await doc.save();
      await loadBytes(state.bytes);
      viewerEl.children[state.current]?.scrollIntoView();
    } else {
      state.bytes = await doc.save();
      await loadBytes(state.bytes);
    }
  } catch (e) { console.error(e); status("操作に失敗: " + e.message, 5000); }
}

async function mergeFile(file) {
  try {
    const doc = await currentDoc();
    const other = await PDFDocument.load(await file.arrayBuffer());
    (await doc.copyPages(other, other.getPageIndices())).forEach((p) => doc.addPage(p));
    await loadBytes(await doc.save());
    status("結合しました");
  } catch (e) { console.error(e); status("結合に失敗: " + e.message, 5000); }
}

// ---------- tabs ----------
function stashActive() {
  if (state.active < 0) return;
  Object.assign(state.docs[state.active], { name: state.name, bytes: state.bytes, current: state.current });
}

function renderTabs() {
  const bar = $("#tabs");
  bar.textContent = "";
  bar.hidden = !state.docs.length;
  state.docs.forEach((d, i) => {
    const t = document.createElement("div");
    t.className = "tab" + (i === state.active ? " active" : "");
    t.title = d.name;
    const label = document.createElement("span");
    label.textContent = d.name;
    const x = document.createElement("button");
    x.className = "close";
    x.textContent = "×";
    x.title = "閉じる";
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    t.append(label, x);
    t.onclick = () => switchTab(i);
    bar.append(t);
  });
  $("#btn-insert").disabled = !state.docs.length;
}

async function activate(i) {
  state.active = i;
  const d = state.docs[i];
  state.current = d.current;
  await loadBytes(d.bytes, d.name);
  renderTabs();
  viewerEl.children[state.current]?.scrollIntoView();
}

async function switchTab(i) {
  if (i === state.active) return;
  try {
    await commitAnnotations(); // inactive tabs keep annotations baked into their bytes
    stashActive();
    await activate(i);
  } catch (e) { console.error(e); status("タブ切替に失敗: " + e.message, 5000); }
}

async function closeTab(i) {
  if (i === state.active && countAnnots() && !confirm("未保存の注釈があります。閉じますか？")) return;
  if (i !== state.active && !confirm(`「${state.docs[i].name}」を閉じますか？`)) return;
  stashActive();
  const activeDoc = state.docs[state.active];
  state.docs.splice(i, 1);
  if (!state.docs.length) {
    Object.assign(state, { bytes: null, pdf: null, active: -1, annots: {}, history: [], selected: null, pages: [], viewports: [], current: 0 });
    viewerEl.innerHTML = '<div id="drop">PDFファイルをここにドラッグ＆ドロップ、または「開く」を押してください</div>';
    $("#btn-save").disabled = true;
    $("#btn-print").disabled = true;
    $("#search-input").disabled = true;
    $("#search-input").value = "";
    runSearch();
    updatePageLabel();
    return renderTabs();
  }
  if (state.docs.includes(activeDoc)) {
    state.active = state.docs.indexOf(activeDoc);
    renderTabs();
  } else {
    state.annots = {};
    await activate(Math.min(i, state.docs.length - 1));
  }
}

async function addDoc(bytes, name) {
  if (hasDoc()) { await commitAnnotations(); stashActive(); }
  state.docs.push({ name, bytes, current: 0 });
  await activate(state.docs.length - 1);
}

// ---------- insert pages from other tab ----------
function openInsertDialog() {
  if (!hasDoc()) return;
  stashActive();
  const src = $("#ins-src");
  src.textContent = "";
  state.docs.forEach((d, i) => {
    const o = new Option(`${d.name}${i === state.active ? "（このタブ）" : ""}`, i);
    src.add(o);
  });
  src.value = state.docs.length > 1 ? (state.active === 0 ? 1 : 0) : state.active;
  $("#ins-range").value = "";
  $("#ins-where").value = "after";
  updateInsertInfo();
  $("#ins-dialog").showModal();
}

function updateInsertInfo() {
  const d = state.docs[+$("#ins-src").value];
  $("#ins-info").textContent = "";
  if (!d) return;
  PDFDocument.load(d.bytes, { ignoreEncryption: true }).then((p) => {
    $("#ins-info").textContent = `全${p.getPageCount()}ページ（空欄で全ページ）`;
  }).catch(() => {});
}

async function insertPages() {
  const srcIdx = +$("#ins-src").value;
  const where = $("#ins-where").value;
  try {
    const doc = await currentDoc();
    stashActive();
    const src = srcIdx === state.active ? doc : await PDFDocument.load(state.docs[srcIdx].bytes);
    const rangeStr = $("#ins-range").value.trim();
    const idx = rangeStr ? parseRange(rangeStr, src.getPageCount()) : src.getPageIndices();
    if (!idx.length) return status("ページ指定が不正です");
    const pages = await doc.copyPages(src, idx);
    const n = doc.getPageCount();
    const pos = where === "before" ? state.current : where === "end" ? n : state.current + 1;
    pages.forEach((p, k) => doc.insertPage(pos + k, p));
    state.current = pos;
    await loadBytes(await doc.save());
    stashActive();
    viewerEl.children[state.current]?.scrollIntoView();
    status(`${pages.length}ページを挿入しました`);
  } catch (e) { console.error(e); status("挿入に失敗: " + e.message, 5000); }
}

// ---------- open ----------
async function openFile(file) {
  try {
    await addDoc(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (e) { console.error(e); status("PDFを開けません: " + e.message, 5000); }
}

async function openUrl(url) {
  try {
    status("読み込み中…", 0);
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status + " " + res.statusText);
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "document.pdf");
    await addDoc(new Uint8Array(await res.arrayBuffer()), /\.pdf$/i.test(name) ? name : name + ".pdf");
    status("読み込みました");
  } catch (e) { console.error(e); status("URLを開けません: " + e.message, 6000); }
}

// ---------- wiring ----------
$("#btn-open").onclick = () => $("#file-open").click();
$("#file-open").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) await openFile(f);
};
$("#btn-insert").onclick = openInsertDialog;
$("#ins-src").onchange = updateInsertInfo;
$("#ins-cancel").onclick = () => $("#ins-dialog").close();
$("#ins-ok").onclick = () => { $("#ins-dialog").close(); insertPages(); };
$("#btn-save").onclick = save;
$("#btn-print").onclick = printDoc;
$("#btn-undo").onclick = undo;
$("#file-merge").onchange = (e) => { if (e.target.files[0]) mergeFile(e.target.files[0]); e.target.value = ""; };
$("#file-image").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([bytes], { type: f.type }));
  await img.decode();
  state.pendingImage = { img, bytes, mime: f.type };
  status("配置したい位置をクリックしてください");
};
document.querySelectorAll("#tools [data-tool]").forEach((b) => (b.onclick = () => {
  if (b.dataset.tool === "image") state.pendingImage = null;
  setTool(b.dataset.tool);
  if (b.dataset.tool === "image") $("#file-image").click();
}));
document.querySelectorAll("#page-ops [data-op]").forEach((b) => (b.onclick = () => pageOp(b.dataset.op)));
const zoom = (d) => {
  if (!hasDoc()) return;
  state.zoom = Math.min(4, Math.max(0.4, state.zoom + d));
  renderAll();
};
$("#btn-zoom-in").onclick = () => zoom(0.2);
$("#btn-zoom-out").onclick = () => zoom(-0.2);

let searchTimer;
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(), 200);
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); clearTimeout(searchTimer); search.q === e.target.value ? gotoMatch(e.shiftKey ? -1 : 1) : runSearch(); }
  else if (e.key === "Escape") { e.target.value = ""; runSearch(); e.target.blur(); }
});
$("#search-case").onchange = () => runSearch();
$("#search-prev").onclick = () => gotoMatch(-1);
$("#search-next").onclick = () => gotoMatch(1);

viewerEl.addEventListener("scroll", () => {
  const mid = viewerEl.getBoundingClientRect().top + viewerEl.clientHeight / 3;
  for (let i = 0; i < state.pages.length; i++) {
    const r = state.pages[i].div.getBoundingClientRect();
    if (r.bottom > mid) { if (state.current !== i) { state.current = i; updatePageLabel(); } break; }
  }
});

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    const el = $("#search-input");
    if (!el.disabled) { el.focus(); el.select(); }
    return;
  }
  if (mod && e.key.toLowerCase() === "p") { e.preventDefault(); printDoc(); return; }
  if (e.key === "F3") { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); return; }
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && state.selected) {
    const { page, a } = state.selected;
    pushHistory();
    state.annots[page] = state.annots[page].filter((x) => x !== a);
    state.selected = null;
    redraw(page);
  }
});

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  (async () => {
    for (const f of [...e.dataTransfer.files].filter((x) => x.type === "application/pdf" || /\.pdf$/i.test(x.name))) await openFile(f);
  })();
});
renderTabs();
window.addEventListener("beforeunload", (e) => { if (countAnnots()) e.preventDefault(); });

const param = new URLSearchParams(location.search).get("url");
if (param) openUrl(param);

// ---------- 電子印（日付印） ----------
function drawStamp(cv, top, date, bottom, color) {
  const S = cv.width, c = cv.getContext("2d");
  c.clearRect(0, 0, S, S);
  c.strokeStyle = c.fillStyle = color;
  c.lineWidth = S * 0.035;
  c.beginPath();
  c.arc(S / 2, S / 2, S / 2 - c.lineWidth, 0, Math.PI * 2);
  c.stroke();
  c.textAlign = "center";
  c.textBaseline = "middle";
  const fam = '"Yu Gothic","Meiryo",sans-serif';
  const fit = (t, size, y, maxW) => {
    c.font = `bold ${size}px ${fam}`;
    const w = c.measureText(t).width;
    if (w > maxW) c.font = `bold ${size * maxW / w}px ${fam}`;
    c.fillText(t, S / 2, y);
  };
  fit(top, S * 0.24, S * 0.28, S * 0.6);
  c.lineWidth = S * 0.015;
  [0.41, 0.59].forEach((r) => { c.beginPath(); c.moveTo(S * 0.1, S * r); c.lineTo(S * 0.9, S * r); c.stroke(); });
  fit(date, S * 0.14, S * 0.5, S * 0.76);
  fit(bottom, S * 0.24, S * 0.72, S * 0.6);
}
function fmtStampDate(v, fmt) {
  const [y, m, d] = v.split("-").map(Number);
  if (!y) return "";
  const t = y * 10000 + m * 100 + d;
  const era = t >= 20190501 ? ["令和", "R", 2018] : t >= 19890108 ? ["平成", "H", 1988] : t >= 19261225 ? ["昭和", "S", 1925] : ["", "", 0];
  const wy = y - era[2], wy1 = wy === 1 ? "元" : wy;
  return {
    dot: `${y}.${m}.${d}`,
    slash: `${y}/${m}/${d}`,
    kanji: `${y}年${m}月${d}日`,
    short: `${String(y).slice(2)}.${m}.${d}`,
    wdot: era[0] ? `${era[1]}${wy}.${m}.${d}` : `${y}.${m}.${d}`,
    wkanji: era[0] ? `${era[0]}${wy1}年${m}月${d}日` : `${y}年${m}月${d}日`,
  }[fmt];
}
const stampVals = () => [$("#stamp-top").value, fmtStampDate($("#stamp-date").value, $("#stamp-fmt").value), $("#stamp-bottom").value, $("#stamp-color").value];
const stampPreview = () => drawStamp($("#stamp-preview"), ...stampVals());
["stamp-top", "stamp-date", "stamp-fmt", "stamp-bottom", "stamp-color"].forEach((id) => ($("#" + id).oninput = stampPreview));
$("#btn-stamp").onclick = () => {
  const s = JSON.parse(localStorage.getItem("stamp") || "{}");
  $("#stamp-top").value = s.top || "";
  $("#stamp-bottom").value = s.bottom || "";
  $("#stamp-color").value = s.color || "#d32f2f";
  $("#stamp-fmt").value = s.fmt || "dot";
  const n = new Date(), p = (v) => String(v).padStart(2, "0");
  $("#stamp-date").value = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
  stampPreview();
  $("#stamp-dialog").showModal();
};
$("#stamp-cancel").onclick = () => $("#stamp-dialog").close();
$("#stamp-ok").onclick = async () => {
  const [top, date, bottom, color] = stampVals();
  localStorage.setItem("stamp", JSON.stringify({ top, bottom, color, fmt: $("#stamp-fmt").value }));
  $("#stamp-dialog").close();
  const cv = document.createElement("canvas");
  cv.width = cv.height = 400;
  drawStamp(cv, top, date, bottom, color);
  const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  state.pendingImage = { img, bytes, mime: "image/png", width: 60 };
  setTool("image");
  status("印を押したい位置をクリックしてください");
};
