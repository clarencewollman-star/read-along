'use strict';

/* Read Along — photograph a workbook page, find the text, tap a zone to hear it. */

const $ = (id) => document.getElementById(id);
const MAX_SIDE = 2400;          // largest image side we keep (pixels)
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

  // Largest connected bright region
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let bestLabel = 0, bestSize = 0, next = 1;
  for (let start = 0; start < w * h; start++) {
    if (label[start] || gray[start] <= thresh) continue;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start;
    label[start] = next;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !label[q] && gray[q] > thresh) { label[q] = next; queue[tail++] = q; }
      }
    }
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
  const k = Math.min(1, MAX_SIDE / Math.max(W, H));
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
    busy('Finding the words…', 0);
    const { data } = await worker.recognize(state.pageCanvas, {}, { blocks: true, text: true });
    buildZones(data);
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

/* Group text lines into zones: lines close together belong to one zone; a bigger gap,
   a change in text size, or a numbered/lettered item starts a new zone. */
function buildZones(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const ws = [];
        for (const w of line.words || []) {
          const text = cleanWord(w.text || '');
          if (!/[A-Za-z0-9]/.test(text) || w.confidence < 35) continue;
          ws.push({ text, bbox: w.bbox });
        }
        if (ws.length) lines.push({ words: ws, bbox: unionBox(ws) });
      }
    }
  }

  const groups = [];
  let cur = null;
  for (const line of lines) {
    const prev = cur && cur[cur.length - 1];
    let join = false;
    if (prev) {
      const hPrev = prev.bbox.y1 - prev.bbox.y0, hLine = line.bbox.y1 - line.bbox.y0;
      const gap = line.bbox.y0 - prev.bbox.y1;
      const overlapX = Math.min(prev.bbox.x1, line.bbox.x1) - Math.max(prev.bbox.x0, line.bbox.x0);
      const sameSize = Math.max(hPrev, hLine) / Math.max(1, Math.min(hPrev, hLine)) < 1.35;
      const startsItem = /^(\d{1,2}|[a-hA-H])[.)]$/.test(line.words[0].text);
      join = gap > -hLine * 0.5 && gap < Math.max(hPrev, hLine) * 1.1 && overlapX > 0 && sameSize && !startsItem;
    }
    if (join) cur.push(line); else groups.push((cur = [line]));
  }

  const zones = [];
  const words = [];
  for (const g of groups) {
    const zw = [];
    for (const line of g) {
      for (const w of line.words) {
        const word = { id: words.length, text: w.text, bbox: w.bbox, zone: zones.length };
        words.push(word);
        zw.push(word);
      }
    }
    zones.push({ id: zones.length, words: zw, box: unionBox(g), sentences: splitSentences(zw) });
  }
  state.zones = zones;
  state.words = words;
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
  const W = state.pageCanvas.width, H = state.pageCanvas.height;
  $('pageImg').src = state.pageCanvas.toDataURL('image/jpeg', 0.92);
  const overlay = $('overlay');
  overlay.innerHTML = '';
  const pct = (v, total) => (v / total) * 100 + '%';
  const pad = Math.round(Math.max(W, H) * 0.006);

  state.zoneEls = state.zones.map((z) => {
    const el = document.createElement('div');
    el.className = 'zone';
    el.dataset.z = z.id;
    el.style.setProperty('--zc', ZONE_COLORS[z.id % ZONE_COLORS.length]);
    el.style.left = pct(z.box.x0 - pad, W);
    el.style.top = pct(z.box.y0 - pad, H);
    el.style.width = pct(z.box.x1 - z.box.x0 + pad * 2, W);
    el.style.height = pct(z.box.y1 - z.box.y0 + pad * 2, H);
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

$('overlay').addEventListener('click', (e) => {
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
window.readAlong = { loadImageFromUrl, state };
