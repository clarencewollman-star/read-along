'use strict';

/* Read Along — photograph a workbook page, find the text, tap a zone to hear it. */

const $ = (id) => document.getElementById(id);
const MAX_SIDE = 2400;          // largest photo side we keep (pixels)
const PAGE_SIDE = 2600;         // long side of the straightened page used for reading
const ZONE_COLORS = ['#4f8cff', '#22b07d', '#ff8a3d', '#b46bff', '#ff5c8a', '#14b8c4'];

const state = {
  srcCanvas: null,   // the photo, before cropping
  corners: null,     // [tl, tr, br, bl] in photo pixels
  pageCanvas: null,  // flattened page
  zones: [],
  words: [],
  wordEls: [],
  zoneEls: [],
  mode: 'zone',
  lastZone: null,
  worker: null,
};

/* ---------------- Screens & busy overlay ---------------- */

function show(name) {
  document.querySelectorAll('.screen').forEach((s) =>
    s.classList.toggle('active', s.id === 'screen-' + name));
  $('btnHome').hidden = name === 'home';
  if (name !== 'camera') stopCamera();
  if (name !== 'reader') stopSpeech();
  if (name !== 'reader' && typeof edit !== 'undefined' && edit.on) setEditing(false);
  window.scrollTo(0, 0);
}

function busy(text, progress) {
  if (text === false) { $('busy').hidden = true; return; }
  $('busy').hidden = false;
  $('busyText').textContent = text;
  const p = $('busyProgress');
  if (typeof progress === 'number') { p.hidden = false; p.value = progress; } else { p.hidden = true; }
}

function note(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text || '';
}

/* ---------------- Loading photos ---------------- */

function canvasFrom(source, w, h) {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

async function loadImageFromUrl(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  startCrop(canvasFrom(img, img.naturalWidth, img.naturalHeight));
}

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const url = URL.createObjectURL(file);
  try { await loadImageFromUrl(url); }
  catch { note('homeNote', 'Sorry, that picture could not be opened. Try another one.'); }
  finally { URL.revokeObjectURL(url); }
});

/* ---------------- Camera ---------------- */

let stream = null;

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function startCamera(deviceId) {
  stopCamera();
  const size = { width: { ideal: 3840 }, height: { ideal: 2160 } };
  const video = deviceId
    ? { deviceId: { exact: deviceId }, ...size }
    : { facingMode: { ideal: 'environment' }, ...size };
  stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  $('video').srcObject = stream;
  await $('video').play();

  const current = stream.getVideoTracks()[0].getSettings().deviceId;
  try { localStorage.setItem('camera', current); } catch {}
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('cameraSelect');
  sel.innerHTML = '';
  cams.forEach((d, i) => sel.add(new Option(d.label || 'Camera ' + (i + 1), d.deviceId)));
  sel.value = current;
  sel.hidden = cams.length < 2;
}

$('btnCamera').addEventListener('click', async () => {
  note('homeNote', '');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    note('homeNote', 'The live camera is not available here. Use “Choose a photo” instead — on an iPad it lets you take a photo.');
    return;
  }
  show('camera');
  let saved = null;
  try { saved = localStorage.getItem('camera'); } catch {}
  try {
    await startCamera(saved);
  } catch (err) {
    try { if (saved) { await startCamera(null); return; } } catch {}
    show('home');
    note('homeNote', 'Could not open the camera. Check that it is plugged in and that the browser is allowed to use it.');
  }
});

$('cameraSelect').addEventListener('change', (e) => startCamera(e.target.value).catch(() => {}));

$('btnSnap').addEventListener('click', () => {
  const v = $('video');
  if (!v.videoWidth) return;
  const c = canvasFrom(v, v.videoWidth, v.videoHeight);
  stopCamera();
  startCrop(c);
});

/* ---------------- Crop ---------------- */

const crop = { scale: 1, dpr: 1, drag: -1 };

function fullCorners(c) {
  return [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]];
}

function startCrop(canvas) {
  state.srcCanvas = canvas;
  state.corners = detectPage(canvas) || fullCorners(canvas);
  show('crop');
  layoutCrop();
}

function layoutCrop() {
  const src = state.srcCanvas;
  if (!src) return;
  const cv = $('cropCanvas');
  const maxW = cv.parentElement.clientWidth || window.innerWidth - 32;
  const maxH = Math.max(240, window.innerHeight - 250);
  const s = Math.min(maxW / src.width, maxH / src.height);
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = src.width * s + 'px';
  cv.style.height = src.height * s + 'px';
  cv.width = Math.round(src.width * s * dpr);
  cv.height = Math.round(src.height * s * dpr);
  crop.scale = s;
  crop.dpr = dpr;
  drawCrop();
}

function drawCrop() {
  const cv = $('cropCanvas');
  const ctx = cv.getContext('2d');
  const src = state.srcCanvas;
  const k = crop.scale * crop.dpr;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.drawImage(src, 0, 0);

  const pts = state.corners;
  // Dim everything outside the page.
  ctx.beginPath();
  ctx.rect(0, 0, src.width, src.height);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill('evenodd');

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.lineWidth = 3 / crop.scale;
  ctx.strokeStyle = '#3b6cf6';
  ctx.stroke();

  const r = 14 / crop.scale;
  pts.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === crop.drag ? '#ffd600' : '#3b6cf6';
    ctx.fill();
    ctx.lineWidth = 3 / crop.scale;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
}

function cropPoint(e) {
  const rect = $('cropCanvas').getBoundingClientRect();
  return [(e.clientX - rect.left) / crop.scale, (e.clientY - rect.top) / crop.scale];
}

$('cropCanvas').addEventListener('pointerdown', (e) => {
  const [x, y] = cropPoint(e);
  let best = -1, bestD = 48 / crop.scale;
  state.corners.forEach(([cx, cy], i) => {
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD) { best = i; bestD = d; }
  });
  if (best < 0) return;
  crop.drag = best;
  e.target.setPointerCapture(e.pointerId);
  drawCrop();
});

$('cropCanvas').addEventListener('pointermove', (e) => {
  if (crop.drag < 0) return;
  const [x, y] = cropPoint(e);
  const src = state.srcCanvas;
  state.corners[crop.drag] = [Math.max(0, Math.min(src.width, x)), Math.max(0, Math.min(src.height, y))];
  drawCrop();
});

const endDrag = () => { if (crop.drag >= 0) { crop.drag = -1; drawCrop(); } };
$('cropCanvas').addEventListener('pointerup', endDrag);
$('cropCanvas').addEventListener('pointercancel', endDrag);

$('btnRotate').addEventListener('click', () => {
  const src = state.srcCanvas;
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  // Rotating 90° clockwise: (x, y) -> (H - y, x); keep corners in tl, tr, br, bl order.
  const rot = state.corners.map(([x, y]) => [src.height - y, x]);
  state.corners = [rot[3], rot[0], rot[1], rot[2]];
  state.srcCanvas = c;
  layoutCrop();
});

$('btnAuto').addEventListener('click', () => {
  state.corners = detectPage(state.srcCanvas) || fullCorners(state.srcCanvas);
  drawCrop();
});

$('btnFull').addEventListener('click', () => {
  state.corners = fullCorners(state.srcCanvas);
  drawCrop();
});

$('btnCropDone').addEventListener('click', async () => {
  busy('Straightening the page…');
  await new Promise((r) => setTimeout(r, 30)); // let the overlay paint
  state.pageCanvas = warpPage(state.srcCanvas, state.corners);
  await readPage();
});

window.addEventListener('resize', () => {
  if ($('screen-crop').classList.contains('active')) layoutCrop();
});

/* Find the page: the largest bright area in the photo (a white page on a darker desk). */
function detectPage(src) {
  const s = 320 / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const gray = new Uint8Array(w * h);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < w * h; i++) {
    const g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
    gray[i] = g;
    hist[g]++;
  }
  // Otsu threshold
  const total = w * h;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thresh = t; }
  }

  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  // Fill one connected bright region starting at `start`.
  const grow = (start, id) => {
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !label[q] && gray[q] > thresh) {
          label[q] = id;
          queue[tail++] = q;
        }
      }
    }
    return size;
  };

  // The largest bright area in the photo is taken to be the page.
  let bestLabel = 0, bestSize = 0, next = 1;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || gray[start] <= thresh) continue;
    const size = grow(start, next);
    if (size > bestSize) { bestSize = size; bestLabel = next; }
    next++;
  }
  if (bestSize < total * 0.12) return null;

  let tl, tr, br, bl;
  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
  for (let p = 0; p < w * h; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % w, y = (p / w) | 0;
    const sm = x + y, df = x - y;
    if (sm < minS) { minS = sm; tl = [x, y]; }
    if (sm > maxS) { maxS = sm; br = [x + 1, y + 1]; }
    if (df > maxD) { maxD = df; tr = [x + 1, y]; }
    if (df < minD) { minD = df; bl = [x, y + 1]; }
  }
  const quad = [tl, tr, br, bl];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) / 2 < total * 0.15) return null;
  return quad.map(([x, y]) => [Math.min(src.width, x / s), Math.min(src.height, y / s)]);
}

/* Solve for the 3x3 perspective transform that maps `from` points onto `to` points. */
function homography(from, to) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

function warpPage(src, corners) {
  const [tl, tr, br, bl] = corners;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(d(tl, tr), d(bl, br));
  let H = Math.max(d(tl, bl), d(tr, br));
  // Small text reads better when bigger, so enlarge the page (up to 2x) to about 2600px tall.
  const k = Math.min(2, PAGE_SIDE / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');

  const isFull = corners.every(([x, y], i) => {
    const f = fullCorners(src)[i];
    return Math.abs(x - f[0]) < 1 && Math.abs(y - f[1]) < 1;
  });
  if (isFull) { octx.drawImage(src, 0, 0, W, H); return out; }

  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], corners); // output -> photo
  const sw = src.width, sh = src.height;
  const sp = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const img = octx.createImageData(W, H);
  const op = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const z = m[6] * x + m[7] * y + m[8];
      let sx = (m[0] * x + m[1] * y + m[2]) / z;
      let sy = (m[3] * x + m[4] * y + m[5]) / z;
      sx = Math.max(0, Math.min(sw - 1.001, sx));
      sy = Math.max(0, Math.min(sh - 1.001, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sp[i00 + c] + (sp[i10 + c] - sp[i00 + c]) * fx;
        const bot = sp[i01 + c] + (sp[i11 + c] - sp[i01 + c]) * fx;
        op[o + c] = top + (bot - top) * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ---------------- Text recognition & zones ---------------- */

/* Make a clean black-on-white copy of the page for the text reader:
   - use the darkest color channel, so colored ink (brown, blue, red) turns dark;
   - divide by the local paper brightness, which removes shadows and uneven light;
   - push faint marks (text showing through from the back of the page) to white. */
function enhanceForOcr(src) {
  const w = src.width, h = src.height;
  const p = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = Math.min(p[j], p[j + 1], p[j + 2]);
  }

  // Paper brightness on a coarse grid: brightest pixel per cell, then spread and smooth it.
  const S = 32;
  const gw = Math.ceil(w / S), gh = Math.ceil(h / S);
  let bg = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = (y / S | 0) * gw;
    for (let x = 0; x < w; x++) {
      const c = row + (x / S | 0), v = gray[y * w + x];
      if (v > bg[c]) bg[c] = v;
    }
  }
  const filter = (a, fn) => {
    const out = new Float32Array(a.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) vals.push(a[yy * gw + xx]);
      }
      out[y * gw + x] = fn(vals);
    }
    return out;
  };
  bg = filter(bg, (v) => Math.max(...v));
  bg = filter(bg, (v) => v.reduce((s, n) => s + n, 0) / v.length);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const o = img.data;
  const LO = 0.45, HI = 0.86; // ratio to paper: below LO = solid ink, above HI = paper
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1.001, Math.max(0, y / S - 0.5));
    const y0 = gy | 0, fy = gy - y0, y1 = Math.min(gh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1.001, Math.max(0, x / S - 0.5));
      const x0 = gx | 0, fx = gx - x0, x1 = Math.min(gw - 1, x0 + 1);
      const b = (bg[y0 * gw + x0] * (1 - fx) + bg[y0 * gw + x1] * fx) * (1 - fy) +
                (bg[y1 * gw + x0] * (1 - fx) + bg[y1 * gw + x1] * fx) * fy;
      const r = gray[y * w + x] / Math.max(40, b);
      const v = r <= LO ? 0 : r >= HI ? 255 : ((r - LO) / (HI - LO)) * 255;
      const k = (y * w + x) * 4;
      o[k] = o[k + 1] = o[k + 2] = v;
      o[k + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

const STATUS_TEXT = {
  'loading tesseract core': 'Getting the reader ready…',
  'initializing tesseract': 'Getting the reader ready…',
  'loading language traineddata': 'Loading English words…',
  'initializing api': 'Almost ready…',
  'recognizing text': 'Finding the words…',
};

async function getWorker() {
  if (!state.worker) {
    state.worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => { if (STATUS_TEXT[m.status]) busy(STATUS_TEXT[m.status], m.progress); },
    });
  }
  return state.worker;
}

async function readPage() {
  try {
    busy('Getting the reader ready…');
    const worker = await getWorker();
    busy('Cleaning up the picture…');
    await new Promise((r) => setTimeout(r, 30));
    state.ocrCanvas = enhanceForOcr(state.pageCanvas);
    // Read each column on its own, top to bottom and left to right. Curved pages
    // otherwise make lines from side-by-side columns run into each other.
    const regions = findRegions(state.ocrCanvas);
    const lines = [];
    for (let i = 0; i < regions.length; i++) {
      busy('Finding the words…', i / regions.length);
      lines.push(...await readRegionLines(regions[i]));
    }
    state.autoSpecs = buildZones(lines, regions);
    setZones(state.autoSpecs.map((s) => ({ ...s })));
    if (edit.on) setEditing(false);
    renderReader();
    busy(false);
    show('reader');
    note('readerNote', state.zones.length ? '' :
      'No words were found. Try “Fix crop”, or take the photo again with more light.');
  } catch (err) {
    console.error(err);
    busy(false);
    show('home');
    note('homeNote', 'Something went wrong while reading the page. The first time, it needs the internet to download the reader.');
  }
}

/* Read the text lines in one area of the page (page pixels; may have curved column edges). */
async function readRegionLines(r) {
  const worker = await getWorker();
  const crop = cropRegion(state.ocrCanvas, r);
  const read = async (canvas, map) => {
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const found = collectLines(data, map);
    return { found, score: found.reduce((s, l) => s + l.score, 0) };
  };
  // On a curved page, leveling helps some sections and hurts others:
  // read tilted sections both ways and keep the version the reader is surer of.
  const ox = r.x - CROP_PAD, oy = r.y - CROP_PAD;
  let best = await read(crop, (x, y) => [x + ox, y + oy]);
  const level = levelText(crop, ox, oy);
  if (level.canvas !== crop) {
    const alt = await read(level.canvas, level.map);
    if (alt.score > best.score) best = alt;
  }
  return best.found;
}

function cleanWord(t) {
  return t.trim().replace(/^[^\w"'(“‘$]+/, '').replace(/[^\w.,!?;:'")”’%]+$/, '');
}

function unionBox(items) {
  return {
    x0: Math.min(...items.map((i) => i.bbox.x0)),
    y0: Math.min(...items.map((i) => i.bbox.y0)),
    x1: Math.max(...items.map((i) => i.bbox.x1)),
    y1: Math.max(...items.map((i) => i.bbox.y1)),
  };
}

/* Find side-by-side columns: a tall, clean white gap with text on both sides of it.
   Returns rectangles (page pixels) in reading order: full-width bands, and for each
   two-column section its left column then its right column. */
function findRegions(canvas) {
  const W = canvas.width, H = canvas.height;
  const w = 600, f = w / W, h = Math.max(1, Math.round(H * f));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const p = ctx.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = p[i * 4] < 150 ? 1 : 0;
  // Columns that are dark most of the way down are background, the page edge or a shadow,
  // not text: ignore them so they don't hide the blank rows between blocks of text.
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) n += ink[y * w + x];
    if (n > h * 0.35) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
  }

  const pre = new Int32Array((w + 1) * h); // per-row running ink count
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) pre[y * (w + 1) + x + 1] = pre[y * (w + 1) + x] + ink[y * w + x];
  }
  const inkIn = (y, a, b) => {
    a = Math.max(0, a); b = Math.min(w, b);
    return b > a ? pre[y * (w + 1) + b] - pre[y * (w + 1) + a] : 0;
  };

  const REACH = 30;    // text must be this close on both sides of the gap
  const MIN_ROWS = 45; // ...for at least this many rows (about 5 lines of text)
  const MAX_BREAK = 14; // a longer stretch with no text beside the gap ends it (e.g. above a title)
  const HALF_GAP = 3;   // a column gap is at least 7px wide here (about 21px on the page)
  const cands = [];
  // Real columns are at least a quarter of the page wide, which also ignores
  // the gap between list numbers ("1.", "2.") and their text.
  // The strip is 2*HALF_GAP+1 px wide: wider than the space between two words.
  const isWhite = (y, x) => x - HALF_GAP >= 0 && x + HALF_GAP < w && inkIn(y, x - HALF_GAP, x + HALF_GAP + 1) === 0;

  for (let x0 = Math.round(w * 0.25); x0 < w * 0.75; x0++) {
    // 1) Follow the white strip down the page. On a curved page the gap between columns
    //    bends, so when text blocks the way the strip may step one pixel left or right.
    //    Record stretches that have text right beside them.
    //    `solid` = the strip stayed white between the previous stretch and this one.
    const path = new Int16Array(h);
    const segs = [];
    let seg = null, inkSincePrev = true, x = x0;
    const close = () => { if (seg) segs.push(seg); seg = null; };
    for (let y = 0; y < h; y++) {
      const nx = isWhite(y, x) ? x : isWhite(y, x - 1) ? x - 1 : isWhite(y, x + 1) ? x + 1 : -1;
      if (nx < 0) { close(); inkSincePrev = true; x = x0; path[y] = x0; continue; }
      x = nx;
      path[y] = x;
      const beside = inkIn(y, x - REACH, x - HALF_GAP) && inkIn(y, x + HALF_GAP + 1, x + REACH + 1);
      if (!beside) continue;
      if (seg && y - seg.y1 > MAX_BREAK) close();
      if (!seg) { seg = { y0: y, y1: y, count: 0, lines: 0, far: 0, solid: !inkSincePrev }; inkSincePrev = false; }
      if (y - seg.y1 > 1 || seg.count === 0) seg.lines++; // a new line of text beside the gap
      // In real columns the text carries on well past the gap on both sides;
      // a list number ("1.") next to its sentence does not.
      if (inkIn(y, x - 150, x - 40) && inkIn(y, x + 40, x + 150)) seg.far++;
      seg.y1 = y;
      seg.count++;
    }
    close();
    // 2) Join stretches split by a short line (e.g. a paragraph's last line), as long as
    //    the strip stayed white and the pieces look like the same text: either both hold
    //    2+ lines, or their lines are the same height (a big lone title is not).
    const lineH = (s) => s.count / s.lines;
    const merged = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      const sameText = (prev && prev.lines >= 2 && s.lines >= 2) ||
        (prev && Math.max(lineH(prev), lineH(s)) / Math.min(lineH(prev), lineH(s)) < 1.5);
      if (prev && s.solid && s.y0 - prev.y1 < 45 && sameText) {
        prev.y1 = s.y1; prev.count += s.count; prev.lines += s.lines; prev.far += s.far;
      } else merged.push({ ...s });
    }
    for (const s of merged) {
      if (s.count >= MIN_ROWS && s.far >= s.count * 0.5) cands.push({ y0: s.y0, y1: s.y1, count: s.count, path: path.slice() });
    }
  }

  // Many starting points find the same gap: keep the strongest version of each.
  const xAt = (g, y) => g.path[Math.max(g.y0, Math.min(g.y1, y))];
  cands.sort((a, b) => b.count - a.count);
  const gutters = [];
  for (const cd of cands) {
    const same = gutters.some((g) => {
      const a = Math.max(g.y0, cd.y0), b = Math.min(g.y1, cd.y1);
      return b > a && Math.abs(xAt(g, (a + b) >> 1) - xAt(cd, (a + b) >> 1)) < 25;
    });
    if (!same) gutters.push(cd);
  }

  // Gutters that overlap vertically form one multi-column section.
  gutters.sort((a, b) => a.y0 - b.y0);
  const sections = [];
  for (const g of gutters) {
    const s = sections.find((s) => g.y0 < s.y1 && g.y1 > s.y0);
    if (s) { s.gs.push(g); s.y0 = Math.min(s.y0, g.y0); s.y1 = Math.max(s.y1, g.y1); }
    else sections.push({ gs: [g], y0: g.y0, y1: g.y1 });
  }

  // Cut between sections on the emptiest row nearby, so no line of text gets sliced.
  const quietRow = (from, to) => {
    let best = from, bestInk = Infinity;
    for (let y = Math.max(0, from); y <= Math.min(h - 1, to); y++) {
      const n = inkIn(y, 0, w);
      if (n < bestInk) { bestInk = n; best = y; }
    }
    return best;
  };

  // A region is a rectangle in page pixels; a column region also has a curved left and/or
  // right edge (page x for a page row) — anything beyond it gets blanked out before reading.
  const regions = [];
  const add = (y0, y1, left, right) => {
    const xL = left ? Math.min(...Array.from({ length: y1 - y0 }, (_, i) => xAt(left, y0 + i))) : 0;
    const xR = right ? Math.max(...Array.from({ length: y1 - y0 }, (_, i) => xAt(right, y0 + i))) : w;
    const r = { x: Math.round(xL / f), y: Math.round(y0 / f) };
    r.w = Math.min(W - r.x, Math.round(xR / f) - r.x);
    r.h = Math.min(H - r.y, Math.round(y1 / f) - r.y);
    if (left) r.left = (Y) => Math.round(xAt(left, Math.min(h - 1, Math.round(Y * f))) / f);
    if (right) r.right = (Y) => Math.round(xAt(right, Math.min(h - 1, Math.round(Y * f))) / f);
    if (r.w > 20 && r.h > 20) regions.push(r);
  };
  // Full-width stretches are split at blank rows, so a tilted block and the next
  // block (e.g. a heading) are each leveled with their own angle.
  const addBand = (y0, y1) => {
    let start = y0, blank = 0;
    for (let y = y0; y < y1; y++) {
      if (inkIn(y, 0, w) <= 2) { blank++; continue; }
      if (blank >= 4 && y - blank - start >= 20) {
        const cut = y - (blank >> 1);
        add(start, cut, null, null);
        start = cut;
      }
      blank = 0;
    }
    add(start, y1, null, null);
  };

  let cursor = 0;
  for (const s of sections) {
    const top = Math.max(cursor, quietRow(s.y0 - 25, s.y0 - 1));
    const bottom = quietRow(s.y1 + 1, s.y1 + 25);
    if (top > cursor + 3) addBand(cursor, top);
    const gs = s.gs.sort((a, b) => xAt(a, (s.y0 + s.y1) >> 1) - xAt(b, (s.y0 + s.y1) >> 1));
    const edges = [null, ...gs, null];
    for (let i = 0; i < edges.length - 1; i++) add(top, bottom, edges[i], edges[i + 1]);
    cursor = bottom;
  }
  if (cursor < h - 3) addBand(cursor, h);
  return regions;
}

/* Copy one region of the page for reading, blanking anything past a column's curved edges,
   with a white margin of CROP_PAD around it (text touching the edge reads badly). */
const CROP_PAD = 24;
function cropRegion(src, r) {
  const P = CROP_PAD;
  const c = document.createElement('canvas');
  c.width = r.w + P * 2; c.height = r.h + P * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, r.x, r.y, r.w, r.h, P, P, r.w, r.h);
  if (r.left || r.right) {
    for (let Y = 0; Y < r.h; Y++) {
      if (r.left) { const lx = r.left(r.y + Y) - r.x; if (lx > 0) ctx.fillRect(P, P + Y, lx, 1); }
      if (r.right) { const rx = r.right(r.y + Y) - r.x; if (rx < r.w) ctx.fillRect(P + rx, P + Y, r.w - rx, 1); }
    }
  }
  return c;
}

/* Measure how much the text in a region is tilted and turn it level.
   Tries angles from -12° to 12° and keeps the one where ink lines up into the sharpest
   horizontal rows. Returns the level canvas and a function that maps a point on it
   back to page pixels. */
function levelText(src, offX, offY) {
  const identity = { canvas: src, map: (x, y) => [x + offX, y + offY] };
  const s = Math.min(1, 500 / src.width);
  const sw = Math.max(1, Math.round(src.width * s)), sh = Math.max(1, Math.round(src.height * s));
  if (sh < 30) return identity;
  const t = document.createElement('canvas');
  t.width = sw; t.height = sh;
  const tctx = t.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(src, 0, 0, sw, sh);
  const p = tctx.getImageData(0, 0, sw, sh).data;
  const xs = [], ys = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (p[(y * sw + x) * 4] < 128) { xs.push(x - sw / 2); ys.push(y - sh / 2); }
  }
  if (xs.length < 200) return identity;

  const sharpness = (deg) => {
    const a = deg * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a);
    const off = Math.ceil(Math.hypot(sw, sh) / 2), hist = new Float64Array(off * 2 + 2);
    for (let i = 0; i < xs.length; i++) hist[Math.round(xs[i] * sin + ys[i] * cos) + off]++;
    let sum = 0;
    for (const v of hist) sum += v * v;
    return sum;
  };
  let best = 0, bestScore = sharpness(0);
  for (let d = -12; d <= 12; d += 1) {
    const sc = sharpness(d);
    if (sc > bestScore) { best = d; bestScore = sc; }
  }
  for (let d = best - 0.75; d <= best + 0.75; d += 0.25) {
    const sc = sharpness(d);
    if (sc > bestScore) { best = d; bestScore = sc; }
  }
  if (Math.abs(best) < 0.75) return identity;

  // Rotate by the angle that lined the ink up best, so the text runs level.
  const a = best * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a);
  const w = src.width, h = src.height;
  const W2 = Math.ceil(w * Math.abs(cos) + h * Math.abs(sin));
  const H2 = Math.ceil(w * Math.abs(sin) + h * Math.abs(cos));
  const out = document.createElement('canvas');
  out.width = W2; out.height = H2;
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, W2, H2);
  octx.translate(W2 / 2, H2 / 2);
  octx.rotate(a);
  octx.drawImage(src, -w / 2, -h / 2);
  const map = (u, v) => {
    const dx = u - W2 / 2, dy = v - H2 / 2;
    return [dx * cos + dy * sin + w / 2 + offX, -dx * sin + dy * cos + h / 2 + offY];
  };
  return { canvas: out, map };
}

/* Pull text lines (with page-pixel positions) out of a recognition result, dropping junk. */
function collectLines(data, map) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const ws = [];
        let confSum = 0;
        for (const w of line.words || []) {
          const text = cleanWord(w.text || '');
          if (!/[A-Za-z0-9]/.test(text) || w.confidence < 40) continue;
          const b = w.bbox;
          const pts = [map(b.x0, b.y0), map(b.x1, b.y0), map(b.x1, b.y1), map(b.x0, b.y1)];
          ws.push({ text, conf: w.confidence, bbox: {
            x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])),
            x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])),
          } });
          confSum += w.confidence;
        }
        if (!ws.length) continue;
        // Lines that are mostly guesses are smudges, ruled lines or show-through: skip them.
        if (confSum / ws.length < 60) continue;
        // score: how much readable text this line adds = letters x how sure the reader is
        const score = ws.reduce((s, w) => s + w.text.length * w.conf / 100, 0);
        lines.push({ words: ws, bbox: unionBox(ws), score });
      }
    }
  }
  return lines;
}

/* Find the blocks of print on the page the way a person sees them: smudge the ink
   sideways and a little downwards so the letters and lines of one paragraph run together
   into one blob, while the blank space around a paragraph, heading or question keeps it
   apart. Blobs never cross from one reading region (column) into another.
   Returns a function giving the block number at a page point (0 = none). */
function findBlocks(canvas, regions, textH) {
  const W = canvas.width, H = canvas.height;
  const w = 600, f = w / W, h = Math.max(1, Math.round(H * f));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const p = ctx.getImageData(0, 0, w, h).data;
  let ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = p[i * 4] < 150 ? 1 : 0;
  for (let x = 0; x < w; x++) { // dark page edges / background are not print
    let n = 0;
    for (let y = 0; y < h; y++) n += ink[y * w + x];
    if (n > h * 0.35) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
  }

  // Which column each pixel belongs to. Full-width strips all count as one area, so a
  // paragraph is never split just because it was read in two strips.
  const rid = new Int16Array(w * h).fill(-1);
  regions.forEach((r, idx) => {
    const i = r.left || r.right ? idx : 9999;
    const y0 = Math.max(0, Math.floor(r.y * f)), y1 = Math.min(h, Math.ceil((r.y + r.h) * f));
    for (let y = y0; y < y1; y++) {
      const Y = y / f;
      let xl = r.x, xr = r.x + r.w;
      if (r.left) xl = Math.max(xl, r.left(Y));
      if (r.right) xr = Math.min(xr, r.right(Y));
      for (let x = Math.max(0, Math.floor(xl * f)); x < Math.min(w, Math.ceil(xr * f)); x++) rid[y * w + x] = i;
    }
  });

  // Smudge: sideways about one letter-height (joins words), down/up about half (joins lines,
  // but not across the blank line between paragraphs).
  const th = textH * f;
  const rx = Math.max(2, Math.round(th * 0.9)), ry = Math.max(2, Math.round(th * 0.55));
  const smear = (src, horizontal) => {
    const out = new Uint8Array(w * h);
    const n = horizontal ? w : h, lines = horizontal ? h : w, r = horizontal ? rx : ry;
    const pre = new Int32Array(n + 1);
    for (let l = 0; l < lines; l++) {
      const at = (k) => (horizontal ? l * w + k : k * w + l);
      for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + src[at(k)];
      for (let k = 0; k < n; k++) {
        if (pre[Math.min(n, k + r + 1)] - pre[Math.max(0, k - r)] > 0) out[at(k)] = 1;
      }
    }
    return out;
  };
  ink = smear(smear(ink, true), false);

  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!ink[s] || label[s] || rid[s] < 0) continue;
    let head = 0, tail = 0;
    queue[tail++] = s;
    label[s] = next;
    while (head < tail) {
      const q = queue[head++], x = q % w, y = (q / w) | 0;
      for (const n2 of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (n2 >= 0 && ink[n2] && !label[n2] && rid[n2] === rid[s]) { label[n2] = next; queue[tail++] = n2; }
      }
    }
    next++;
  }

  return (X, Y) => {
    const x = Math.round(X * f), y = Math.round(Y * f);
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && label[yy * w + xx]) return label[yy * w + xx];
      }
    }
    return 0;
  };
}

/* Build zones: each block of print is a zone, except that a numbered or lettered item
   ("1.", "b)") starts a zone of its own so every question can be tapped by itself. */
function buildZones(allLines, regions) {
  // A page number or a stray letter on its own is not worth a zone.
  const lines = allLines.filter((l) => {
    const t = l.words.map((w) => w.text).join(' ');
    return !(/^\d{1,3}$/.test(t) || t.replace(/[^A-Za-z]/g, '').length < 2 && !/\d/.test(t));
  });
  const heights = lines.flatMap((l) => l.words.map((w) => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b);
  const textH = heights.length ? heights[heights.length >> 1] : 30;
  const blockAt = findBlocks(state.ocrCanvas, regions, textH);

  const groups = new Map(); // zone key -> words, in reading order
  const part = new Map();   // block -> how many numbered items it has been split into
  lines.forEach((line, li) => {
    const startsItem = /^(\d{1,2}|[a-hA-H])[.)]$/.test(line.words[0].text);
    for (const w of line.words) {
      const b = blockAt((w.bbox.x0 + w.bbox.x1) / 2, (w.bbox.y0 + w.bbox.y1) / 2);
      let key;
      if (!b) key = 'line' + li;
      else {
        if (startsItem && w === line.words[0] && groups.has('b' + b + '.' + (part.get(b) || 0))) {
          part.set(b, (part.get(b) || 0) + 1);
        }
        key = 'b' + b + '.' + (part.get(b) || 0);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...w, line: li });
    }
  });

  state.textH = textH;
  const specs = [];
  for (const g of groups.values()) {
    for (const para of splitParagraphs(readingRows(g, textH), textH)) {
      const zw = para.flat();
      // A speck with hardly any letters is not worth a zone.
      if (zw.map((w) => w.text).join('').replace(/[^A-Za-z0-9]/g, '').length < 2) continue;
      specs.push({ words: zw.map((w) => ({ text: w.text, bbox: w.bbox })), prio: 0 });
    }
  }
  return specs;
}

/* Turn zone descriptions into the live zones and words the reader uses.
   A spec is { words: [{text, bbox}], prio, box? } — `box` and a higher `prio` come from
   a zone drawn by hand: its box is kept exactly as drawn and wins over others. */
function setZones(specs) {
  state.specs = specs;
  const zones = [];
  const words = [];
  specs.forEach((spec, si) => {
    if (!spec.words.length) return;
    const zoneWords = spec.words.map((w) => {
      const word = { id: words.length, text: w.text, bbox: w.bbox, zone: zones.length };
      words.push(word);
      return word;
    });
    zones.push({
      id: zones.length, spec: si, words: zoneWords, prio: spec.prio || 0, manual: !!spec.box,
      box: spec.box || unionBox(zoneWords), sentences: splitSentences(zoneWords),
    });
  });
  state.zones = zones;
  state.words = words;
}

/* Split one block's rows (lines) into paragraphs, the way books mark them when there is
   no blank line between: a new paragraph starts
   - on an indented line, right after a line that finished a sentence, or
   - after a line that finished a sentence well short of the right edge. */
function splitParagraphs(rows, textH) {
  if (rows.length < 2) return [rows];
  const start = rows.map((r) => Math.min(...r.map((w) => w.bbox.x0)));
  const end = rows.map((r) => Math.max(...r.map((w) => w.bbox.x1)));
  const fullEnd = [...end].sort((a, b) => a - b)[Math.floor(end.length * 0.75)];
  const endsSentence = (r) => /[.!?:]["')\]”’]*$/.test(r[r.length - 1].text);
  const paras = [[rows[0]]];
  for (let i = 1; i < rows.length; i++) {
    const prevDone = endsSentence(rows[i - 1]);
    const indented = start[i] > start[i - 1] + textH * 0.7 &&
      (i + 1 >= rows.length || start[i + 1] < start[i] - textH * 0.5);
    const prevShort = end[i - 1] < fullEnd - textH * 2.5;
    if (prevDone && (indented || prevShort)) paras.push([]);
    paras[paras.length - 1].push(rows[i]);
  }
  return paras;
}

/* Put a block's words in reading order, as rows (lines) of words. The reader's word order
   inside one of its lines is kept; whole lines (or pieces of lines) are sorted top to
   bottom, measured along the slant of the text, and pieces on the same row go left to right. */
function readingRows(ws, textH) {
  const lines = new Map();
  ws.forEach((w) => { if (!lines.has(w.line)) lines.set(w.line, []); lines.get(w.line).push(w); });
  const pieces = [...lines.values()].map((lw) => ({ words: lw, bbox: unionBox(lw) }));
  return orderByPosition(pieces, textH, ws).map((row) => row.flatMap((p) => p.words));
}

/* Sort items (anything with a bbox) into rows, top to bottom along the text's slant,
   left to right within a row. The slant is measured from `slopeFrom` words. */
function orderByPosition(ws, textH, slopeFrom) {
  const cx = (w) => (w.bbox.x0 + w.bbox.x1) / 2, cy = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
  // Slant: median slope of the reader's lines that have 3+ words.
  const byLine = new Map();
  slopeFrom.forEach((w) => { if (!byLine.has(w.line)) byLine.set(w.line, []); byLine.get(w.line).push(w); });
  const slopes = [];
  for (const lw of byLine.values()) {
    if (lw.length < 3) continue;
    const mx = lw.reduce((s, w) => s + cx(w), 0) / lw.length, my = lw.reduce((s, w) => s + cy(w), 0) / lw.length;
    let num = 0, den = 0;
    for (const w of lw) { num += (cx(w) - mx) * (cy(w) - my); den += (cx(w) - mx) ** 2; }
    if (den > 0) slopes.push(num / den);
  }
  slopes.sort((a, b) => a - b);
  const slope = slopes.length ? Math.max(-0.3, Math.min(0.3, slopes[slopes.length >> 1])) : 0;

  const items = ws.map((w) => ({ w, x: cx(w), y: cy(w) - slope * cx(w) }));
  items.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.y - row.y < textH * 0.6) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((it) => it.w));
}

/* Make sure no two zone boxes overlap: where two boxes cross, move the shared edge to
   the middle of the overlap — between rows for boxes stacked above each other,
   between columns for boxes side by side. */
function separateBoxes(boxes) {
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0) continue;
        changed = true;
        // A zone drawn by hand (higher prio) keeps its box; the other one moves out of its way.
        if ((a.prio || 0) !== (b.prio || 0)) {
          const [hi, lo] = (a.prio || 0) > (b.prio || 0) ? [a, b] : [b, a];
          const cut = [
            { side: 'y1', v: hi.y0 - 1, cost: lo.y1 - (hi.y0 - 1) },
            { side: 'y0', v: hi.y1 + 1, cost: (hi.y1 + 1) - lo.y0 },
            { side: 'x1', v: hi.x0 - 1, cost: lo.x1 - (hi.x0 - 1) },
            { side: 'x0', v: hi.x1 + 1, cost: (hi.x1 + 1) - lo.x0 },
          ].map((c) => ({ ...c, cost: c.cost / (c.side[0] === 'y' ? lo.y1 - lo.y0 : lo.x1 - lo.x0) }))
            .sort((p, q) => p.cost - q.cost)[0];
          lo[cut.side] = cut.v;
          continue;
        }
        // Cut along whichever direction needs the smaller trim.
        if (oy / Math.min(a.y1 - a.y0, b.y1 - b.y0) <= ox / Math.min(a.x1 - a.x0, b.x1 - b.x0)) {
          const [top, bot] = (a.y0 + a.y1) <= (b.y0 + b.y1) ? [a, b] : [b, a];
          const mid = (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2;
          top.y1 = Math.min(top.y1, mid - 1);
          bot.y0 = Math.max(bot.y0, mid + 1);
        } else {
          const [lft, rgt] = (a.x0 + a.x1) <= (b.x0 + b.x1) ? [a, b] : [b, a];
          const mid = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2;
          lft.x1 = Math.min(lft.x1, mid - 1);
          rgt.x0 = Math.max(rgt.x0, mid + 1);
        }
      }
    }
    if (!changed) break;
  }
  return boxes;
}

function splitSentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const isItemNumber = /^(\d{1,2}|[A-Za-z])[.)]$/.test(w.text);
    if ((/[.!?]["')\]”’]*$/.test(w.text) && !isItemNumber) || cur.length >= 35) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function renderReader() {
  $('pageImg').src = state.pageCanvas.toDataURL('image/jpeg', 0.92);
  renderOverlay();
}

function renderOverlay() {
  const W = state.pageCanvas.width, H = state.pageCanvas.height;
  const overlay = $('overlay');
  overlay.innerHTML = '';
  const pct = (v, total) => (v / total) * 100 + '%';
  const pad = Math.round(Math.max(W, H) * 0.006);

  // A little breathing room around automatic zones (hand-drawn ones stay exactly as
  // drawn), then trim so no two zones overlap.
  const boxes = separateBoxes(state.zones.map((z) => {
    const p = z.manual ? 0 : pad;
    return { x0: z.box.x0 - p, y0: z.box.y0 - p, x1: z.box.x1 + p, y1: z.box.y1 + p, prio: z.prio };
  }));

  state.zoneEls = state.zones.map((z, i) => {
    const b = boxes[i];
    const el = document.createElement('div');
    el.className = 'zone' + (edit.selected === z.spec ? ' selected' : '');
    el.dataset.z = z.id;
    el.style.setProperty('--zc', ZONE_COLORS[z.id % ZONE_COLORS.length]);
    el.style.left = pct(b.x0, W);
    el.style.top = pct(b.y0, H);
    el.style.width = pct(Math.max(1, b.x1 - b.x0), W);
    el.style.height = pct(Math.max(1, b.y1 - b.y0), H);
    overlay.appendChild(el);
    return el;
  });

  state.wordEls = state.words.map((w) => {
    const el = document.createElement('div');
    el.className = 'word';
    el.dataset.w = w.id;
    el.style.left = pct(w.bbox.x0, W);
    el.style.top = pct(w.bbox.y0, H);
    el.style.width = pct(w.bbox.x1 - w.bbox.x0, W);
    el.style.height = pct(w.bbox.y1 - w.bbox.y0, H);
    overlay.appendChild(el);
    return el;
  });
}

/* ---------------- Changing zones by hand ---------------- */

const edit = { on: false, selected: -1, start: null, draft: null };

function pagePoint(e) {
  const rect = $('overlay').getBoundingClientRect();
  const W = state.pageCanvas.width, H = state.pageCanvas.height;
  return [
    Math.max(0, Math.min(W, (e.clientX - rect.left) / rect.width * W)),
    Math.max(0, Math.min(H, (e.clientY - rect.top) / rect.height * H)),
  ];
}

function setEditing(on) {
  edit.on = on;
  edit.selected = -1;
  stopSpeech();
  $('page').classList.toggle('editing', on);
  $('editTools').hidden = !on;
  document.querySelector('#screen-reader .reader-tools:not(.edit-tools)').hidden = on;
  $('btnRemoveZone').disabled = true;
  // While editing, shrink the page to fit the screen so boxes can be drawn without scrolling.
  if (on) {
    window.scrollTo(0, 0);
    const top = $('page').getBoundingClientRect().top;
    const fit = (window.innerHeight - top - 16) * state.pageCanvas.width / state.pageCanvas.height;
    $('page').style.maxWidth = Math.max(280, Math.min(900, fit)) + 'px';
  } else {
    $('page').style.maxWidth = '';
  }
  renderOverlay();
}

function selectZone(spec) {
  edit.selected = spec;
  $('btnRemoveZone').disabled = spec < 0;
  state.zoneEls.forEach((el, i) => el.classList.toggle('selected', state.zones[i].spec === spec));
}

$('overlay').addEventListener('pointerdown', (e) => {
  if (!edit.on) return;
  e.preventDefault();
  edit.start = { pt: pagePoint(e), x: e.clientX, y: e.clientY, zone: e.target.closest('.zone') };
  $('overlay').setPointerCapture(e.pointerId);
});

$('overlay').addEventListener('pointermove', (e) => {
  if (!edit.on || !edit.start) return;
  if (Math.hypot(e.clientX - edit.start.x, e.clientY - edit.start.y) < 10 && !edit.draft) return;
  const [x0, y0] = edit.start.pt, [x1, y1] = pagePoint(e);
  const W = state.pageCanvas.width, H = state.pageCanvas.height;
  if (!edit.draft) {
    edit.draft = document.createElement('div');
    edit.draft.className = 'draft';
    $('overlay').appendChild(edit.draft);
  }
  edit.draft.style.left = Math.min(x0, x1) / W * 100 + '%';
  edit.draft.style.top = Math.min(y0, y1) / H * 100 + '%';
  edit.draft.style.width = Math.abs(x1 - x0) / W * 100 + '%';
  edit.draft.style.height = Math.abs(y1 - y0) / H * 100 + '%';
});

const endDraw = async (e) => {
  if (!edit.on || !edit.start) return;
  const start = edit.start;
  edit.start = null;
  if (!edit.draft) { // a tap: pick the zone under the finger
    selectZone(start.zone ? state.zones[+start.zone.dataset.z].spec : -1);
    return;
  }
  edit.draft.remove();
  edit.draft = null;
  if (e.type === 'pointercancel') return;
  const [x0, y0] = start.pt, [x1, y1] = pagePoint(e);
  const box = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  if (box.x1 - box.x0 < 15 || box.y1 - box.y0 < 10) return;
  await addZone(box);
};
$('overlay').addEventListener('pointerup', endDraw);
$('overlay').addEventListener('pointercancel', endDraw);

/* Make a zone from a box drawn by hand: read the text inside just that box (more reliable
   than the whole-page read), and take those words away from any other zone. */
async function addZone(box) {
  const center = (w) => [(w.bbox.x0 + w.bbox.x1) / 2, (w.bbox.y0 + w.bbox.y1) / 2];
  const inside = (w) => { const [x, y] = center(w); return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1; };
  busy('Reading the words in your box…');
  let found = [];
  try {
    const r = { x: Math.round(box.x0), y: Math.round(box.y0), w: Math.round(box.x1 - box.x0), h: Math.round(box.y1 - box.y0) };
    const lines = await readRegionLines(r);
    found = lines.flatMap((l, li) => l.words.map((w) => ({ text: w.text, bbox: w.bbox, line: li })));
    found = found.filter(inside);
    found = readingRows(found, state.textH || 30).flat().map((w) => ({ text: w.text, bbox: w.bbox }));
  } catch (err) { console.error(err); }
  busy(false);

  const specs = state.specs.map((s) => ({ ...s, words: s.words.filter((w) => !inside(w)) }));
  if (!found.length) { // nothing read in the box: fall back to words already found there
    found = state.specs.flatMap((s) => s.words.filter(inside));
  }
  if (!found.length) {
    note('readerNote', 'No words were found in that box. Try drawing it a little bigger around the text.');
    return;
  }
  note('readerNote', '');
  edit.prio = (edit.prio || 0) + 1;
  specs.push({ words: found, box, prio: 1000 + edit.prio });
  setZones(specs.filter((s) => s.words.length));
  selectZone(-1);
  renderOverlay();
}

$('btnEdit').addEventListener('click', () => setEditing(true));
$('btnEditDone').addEventListener('click', () => setEditing(false));
$('btnRemoveZone').addEventListener('click', () => {
  if (edit.selected < 0) return;
  setZones(state.specs.filter((_, i) => i !== edit.selected));
  selectZone(-1);
  renderOverlay();
});
$('btnClearZones').addEventListener('click', () => {
  setZones([]);
  selectZone(-1);
  renderOverlay();
});
$('btnAutoZones').addEventListener('click', () => {
  setZones(state.autoSpecs.map((s) => ({ ...s })));
  selectZone(-1);
  renderOverlay();
});

$('overlay').addEventListener('click', (e) => {
  if (edit.on) return;
  const wordEl = e.target.closest('.word');
  const zoneEl = e.target.closest('.zone');
  if (state.mode === 'word') {
    if (wordEl) speakWord(state.words[+wordEl.dataset.w]);
    return;
  }
  const zid = wordEl ? state.words[+wordEl.dataset.w].zone : zoneEl ? +zoneEl.dataset.z : -1;
  if (zid >= 0) speakZone(state.zones[zid]);
});

function setMode(mode) {
  state.mode = mode;
  $('modeZone').classList.toggle('active', mode === 'zone');
  $('modeWord').classList.toggle('active', mode === 'word');
  stopSpeech();
}
$('modeZone').addEventListener('click', () => setMode('zone'));
$('modeWord').addEventListener('click', () => setMode('word'));
$('btnRecrop').addEventListener('click', () => { show('crop'); layoutCrop(); });
$('btnHome').addEventListener('click', () => { note('homeNote', ''); show('home'); });

/* ---------------- Speech ---------------- */

const speech = {
  token: 0,
  handles: [],
  rate: 0.9,
  voice: null,
  nowEl: null,
  sentEls: [],
  sentence: null,
};

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const all = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  if (!all.length) return;
  const score = (v) =>
    (/natural/i.test(v.name) ? 8 : 0) + (/online/i.test(v.name) ? 2 : 0) +
    (/aria|jenny|ava|guy|samantha|zira/i.test(v.name) ? 3 : 0) + (/en-us/i.test(v.lang) ? 1 : 0);
  all.sort((a, b) => score(b) - score(a));
  const sel = $('voiceSelect');
  sel.innerHTML = '';
  all.forEach((v) => sel.add(new Option(v.name.replace(/^Microsoft /, '').replace(/ - English.*$/, ''), v.name)));
  let saved = null;
  try { saved = localStorage.getItem('voice'); } catch {}
  const pick = all.find((v) => v.name === saved) || all[0];
  sel.value = pick.name;
  speech.voice = pick;
}

if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
  // iPad Safari sometimes fills the voice list late without telling us.
  [500, 1500, 4000].forEach((ms) => setTimeout(() => { if (!$('voiceSelect').options.length) loadVoices(); }, ms));
}

$('voiceSelect').addEventListener('change', (e) => {
  speech.voice = speechSynthesis.getVoices().find((v) => v.name === e.target.value) || null;
  try { localStorage.setItem('voice', e.target.value); } catch {}
});

try {
  const r = parseFloat(localStorage.getItem('rate'));
  if (r) { speech.rate = r; $('rate').value = r; }
} catch {}
$('rate').addEventListener('input', (e) => {
  speech.rate = parseFloat(e.target.value);
  try { localStorage.setItem('rate', e.target.value); } catch {}
});

function makeUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  if (speech.voice) { u.voice = speech.voice; u.lang = speech.voice.lang; } else { u.lang = 'en-US'; }
  u.rate = speech.rate;
  return u;
}

function stopSpeech() {
  speech.token++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speech.handles.forEach((h) => { clearTimeout(h.check); clearTimeout(h.timer); });
  speech.handles = [];
  clearHighlights();
}

function clearHighlights() {
  if (speech.nowEl) speech.nowEl.classList.remove('now');
  speech.nowEl = null;
  speech.sentEls.forEach((el) => el.classList.remove('sent'));
  speech.sentEls = [];
  speech.sentence = null;
  state.zoneEls.forEach((el) => el.classList.remove('active'));
  $('caption').hidden = true;
  document.body.classList.remove('has-caption');
}

function setSentence(words) {
  speech.sentEls.forEach((el) => el.classList.remove('sent'));
  speech.sentEls = words.map((w) => state.wordEls[w.id]);
  speech.sentEls.forEach((el) => el.classList.add('sent'));
  speech.sentence = words;
  const cap = $('caption');
  cap.innerHTML = '';
  words.forEach((w, i) => {
    const s = document.createElement('span');
    s.textContent = w.text;
    s.dataset.w = w.id;
    cap.appendChild(s);
    if (i < words.length - 1) cap.appendChild(document.createTextNode(' '));
  });
  cap.hidden = false;
  document.body.classList.add('has-caption');
}

function highlightWord(w) {
  if (speech.nowEl) speech.nowEl.classList.remove('now');
  const el = state.wordEls[w.id];
  el.classList.add('now');
  speech.nowEl = el;
  $('caption').querySelectorAll('span').forEach((s) => s.classList.toggle('now', +s.dataset.w === w.id));

  // Keep the word on screen.
  const r = el.getBoundingClientRect();
  const bottomLimit = window.innerHeight - ($('caption').hidden ? 0 : $('caption').offsetHeight) - 20;
  const topLimit = 150;
  if (r.top < topLimit || r.bottom > bottomLimit) {
    window.scrollBy({ top: r.top - (topLimit + bottomLimit) / 2, behavior: 'smooth' });
  }
}

function speakZone(zone) {
  if (!('speechSynthesis' in window)) { note('readerNote', 'This browser cannot read out loud.'); return; }
  stopSpeech();
  const tok = speech.token;
  state.lastZone = zone;
  state.zoneEls[zone.id].classList.add('active');

  zone.sentences.forEach((words, si) => {
    const starts = [];
    let text = '';
    words.forEach((w, i) => { if (i) text += ' '; starts.push(text.length); text += w.text; });

    const u = makeUtterance(text);
    const h = { u, got: false, ended: false, check: 0, timer: 0 };
    speech.handles.push(h); // keep a reference so the browser doesn't drop the events

    u.onstart = () => {
      if (tok !== speech.token) return;
      setSentence(words);
      highlightWord(words[0]);
      // Some voices never report word positions; estimate the timing for those.
      h.check = setTimeout(() => { if (!h.got) estimateWords(words, tok, h); }, 700);
    };
    u.onboundary = (e) => {
      if (tok !== speech.token || (e.name && e.name !== 'word')) return;
      h.got = true;
      clearTimeout(h.timer);
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= e.charIndex) i++;
      highlightWord(words[i]);
    };
    const done = () => {
      h.ended = true;
      clearTimeout(h.check);
      clearTimeout(h.timer);
      if (tok === speech.token && si === zone.sentences.length - 1) clearHighlights();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

function estimateWords(words, tok, h) {
  let i = 1;
  const step = () => {
    if (tok !== speech.token || h.got || h.ended || i >= words.length) return;
    highlightWord(words[i]);
    const ms = (170 + words[i].text.length * 60) / speech.rate;
    i++;
    h.timer = setTimeout(step, ms);
  };
  step();
}

function speakWord(word) {
  if (!('speechSynthesis' in window)) return;
  stopSpeech();
  const tok = speech.token;
  const u = makeUtterance(word.text.replace(/[.,!?;:]+$/, ''));
  u.rate = Math.min(speech.rate, 0.85);
  speech.handles.push({ u });
  setSentence([word]);
  highlightWord(word);
  const done = () => { if (tok === speech.token) clearHighlights(); };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

$('btnStop').addEventListener('click', stopSpeech);
$('btnReplay').addEventListener('click', () => { if (state.lastZone) speakZone(state.lastZone); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopSpeech(); });

// Offline copy + "Add to Home Screen" support (only works over https or localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Exposed for testing in the browser console.
window.readAlong = { loadImageFromUrl, findRegions, state };
