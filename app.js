/* Page logic: choosing photos, settings, running the worker, showing results. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|heic|heif|avif|tiff?)$/i;

  // Phones and tablets have much less memory than computers.
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac
  const MP = 1e6;
  const SIZES = [
    ['auto', isMobile ? 'Automatic (up to 8 MP on this device)' : 'Automatic (up to 24 MP)'],
    ['0', 'Full size'], ['24', 'Up to 24 MP'], ['12', 'Up to 12 MP'], ['8', 'Up to 8 MP'],
    ['6', 'Up to 6 MP'], ['3', 'Up to 3 MP'],
  ];
  const AUTO_MP = isMobile ? 8 : 24;
  const DEFAULTS = { pyramid: true, depthmap: true, depth: true, align: true, crop: true,
    size: 'auto', format: 'image/jpeg', sharp: 6, smooth: 2, order: 'name' };

  // ---------------------------------------------------------------- storage
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem('fs.' + key)); } catch (e) { return null; } },
    set(key, v) { try { localStorage.setItem('fs.' + key, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------------------------------------------------------------- settings
  const sizeSel = $('o-size');
  for (const [v, label] of SIZES) sizeSel.add(new Option(label, v));

  const fields = {
    pyramid: $('o-pyramid'), depthmap: $('o-depthmap'), depth: $('o-depth'), align: $('o-align'),
    crop: $('o-crop'), size: sizeSel, format: $('o-format'), sharp: $('o-sharp'), smooth: $('o-smooth'),
    order: $('order'),
  };
  function readSettings() {
    const s = {};
    for (const [k, el] of Object.entries(fields)) s[k] = el.type === 'checkbox' ? el.checked : el.value;
    return s;
  }
  function applySettings(s) {
    for (const [k, el] of Object.entries(fields)) {
      if (s[k] === undefined || s[k] === null) continue;
      if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    }
    $('v-sharp').textContent = Number(fields.sharp.value).toFixed(1);
    $('v-smooth').textContent = Number(fields.smooth.value).toFixed(1);
  }
  applySettings(Object.assign({}, DEFAULTS, store.get('settings') || {}));
  for (const el of Object.values(fields)) {
    el.addEventListener('input', () => { applySettings(readSettings()); store.set('settings', readSettings()); updateGo(); });
  }
  $('reset').addEventListener('click', () => { applySettings(DEFAULTS); store.set('settings', readSettings()); updateGo(); });

  // If the last run never finished, the page most likely ran out of memory and
  // the browser reloaded it. Step the working size down and say so.
  const unfinished = store.get('running');
  if (unfinished) {
    store.set('running', null);
    const cur = sizeSel.value === 'auto' ? AUTO_MP : (Number(sizeSel.value) || Infinity); // 0 = full size
    const smaller = [24, 12, 8, 6, 3].find((mp) => mp < cur);
    sizeSel.value = String(smaller || 3);
    store.set('settings', readSettings());
    showNotice(`The last stack didn't finish, probably because this device ran out of memory. ` +
      `Working size has been lowered to “${sizeSel.selectedOptions[0].text}”. Try again.`);
  }

  function showNotice(text, isError) {
    const n = $('notice');
    n.textContent = text;
    n.className = 'notice' + (isError ? ' error' : '');
    n.hidden = !text;
  }

  // ---------------------------------------------------------------- choosing photos
  let stacks = []; // {name, files: [{file, pick}], folder}
  let pickCounter = 0;

  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  function sortFiles(list) {
    const by = fields.order.value;
    return list.slice().sort((a, b) => {
      if (by === 'pick') return a.pick - b.pick;
      if (by === 'time') return (a.file.lastModified - b.file.lastModified) || (a.pick - b.pick);
      return natural(a.file.name, b.file.name) || (a.file.lastModified - b.file.lastModified) || (a.pick - b.pick);
    });
  }

  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const isImage = (f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name);

  function addLoose(files) {
    const imgs = Array.from(files).filter(isImage).map((file) => ({ file, pick: pickCounter++ }));
    if (!imgs.length) { showNotice('No photos found in what you picked.', true); return; }
    stacks.push({ files: imgs, folder: null });
    renderStacks();
  }

  function addFolders(groups) {
    // groups: Map folderName -> File[]
    let added = 0;
    for (const [folder, files] of groups) {
      const imgs = files.filter(isImage).map((file) => ({ file, pick: pickCounter++ }));
      if (imgs.length) { stacks.push({ files: imgs, folder }); added++; }
    }
    if (!added) showNotice('No photos found in that folder.', true);
    renderStacks();
  }

  function stackName(st) {
    if (st.folder) return st.folder;
    return baseName(sortFiles(st.files)[0].file.name) + '_stack';
  }

  function renderStacks() {
    const list = $('stack-list');
    list.textContent = '';
    stacks.forEach((st, i) => {
      const files = sortFiles(st.files);
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${stackName(st)} · ${files.length} photo${files.length === 1 ? '' : 's'}`;
      const sub = document.createElement('div');
      sub.className = 'files';
      sub.textContent = files.length > 1
        ? `${files[0].file.name} → ${files[files.length - 1].file.name}` : files[0].file.name;
      meta.append(name, sub);
      if (files.length < 2) {
        const w = document.createElement('div');
        w.className = 'warn';
        w.textContent = 'Needs at least 2 photos.';
        meta.append(w);
      }
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'link'; rm.textContent = 'Remove';
      rm.addEventListener('click', () => { stacks.splice(i, 1); renderStacks(); });
      li.append(meta, rm);
      list.append(li);
    });
    $('stacks').hidden = !stacks.length;
    $('drop-hint').textContent = stacks.length
      ? 'Add another stack, or press “Stack photos”.'
      : 'Pick all the photos of one subject, from the nearest focus to the farthest.';
    updateGo();
  }

  function updateGo() {
    const s = readSettings();
    const ready = stacks.some((st) => st.files.length >= 2) && (s.pyramid || s.depthmap);
    $('go').disabled = !ready || running;
    $('go').textContent = stacks.length > 1 ? `Stack photos (${stacks.length} stacks)` : 'Stack photos';
  }

  $('in-files').addEventListener('change', (e) => { showNotice(''); addLoose(e.target.files); e.target.value = ''; });
  $('order').addEventListener('change', renderStacks);
  $('clear').addEventListener('click', () => { stacks = []; renderStacks(); });

  // Folder picking (computers only; phones don't support it).
  const folderInput = $('in-folder');
  if (!isMobile && 'webkitdirectory' in folderInput) {
    $('folder-btn').hidden = false;
    folderInput.addEventListener('change', (e) => {
      showNotice('');
      const groups = new Map();
      for (const f of e.target.files) {
        const parts = (f.webkitRelativePath || f.name).split('/');
        const folder = parts.length > 1 ? parts[parts.length - 2] : 'stack';
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(f);
      }
      addFolders(groups);
      e.target.value = '';
    });
  }

  // Drag and drop: loose files make one stack; each dropped folder is its own stack.
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
    if (t === 'dragleave' && e.relatedTarget) return;
    e.preventDefault(); drop.classList.remove('over');
  }));
  document.addEventListener('drop', async (e) => {
    showNotice('');
    const items = Array.from(e.dataTransfer.items || []);
    const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) { addLoose(e.dataTransfer.files); return; }
    const loose = [], groups = new Map();
    for (const entry of entries) {
      if (entry.isFile) loose.push(await new Promise((res, rej) => entry.file(res, rej)));
      else groups.set(entry.name, await readFolder(entry));
    }
    if (loose.length) addLoose(loose);
    if (groups.size) addFolders(groups);
  });

  async function readFolder(dir) {
    const reader = dir.createReader(), files = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const ent of batch) if (ent.isFile) files.push(await new Promise((res, rej) => ent.file(res, rej)));
    }
    return files;
  }

  // ---------------------------------------------------------------- running
  let worker = null, running = false, wakeLock = null, results = [];

  function newWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = onWorker;
    worker.onerror = (e) => {
      finishRun();
      showNotice('Something went wrong: ' + (e.message || 'the stacker stopped unexpectedly') +
        '. If this keeps happening, try a smaller working size in Settings.', true);
    };
  }
  newWorker();

  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* not supported or not allowed: fine */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (running && document.visibilityState === 'visible') keepAwake(true);
  });

  let jobs = [];
  $('go').addEventListener('click', () => {
    const s = readSettings();
    jobs = stacks.filter((st) => st.files.length >= 2).map((st) => ({
      name: stackName(st), files: sortFiles(st.files).map((x) => x.file),
    }));
    if (!jobs.length) return;
    const mp = s.size === 'auto' ? AUTO_MP : Number(s.size);
    const opts = {
      pyramid: s.pyramid, depthmap: s.depthmap, saveDepth: s.depth && s.depthmap,
      align: s.align, crop: s.crop, format: s.format,
      sharpness: Number(s.sharp), smoothing: Number(s.smooth),
      maxPixels: mp ? mp * MP : 0,
    };
    showNotice('');
    clearResults();
    running = true;
    store.set('running', true);
    updateGo();
    $('status').hidden = false; $('keep-open').hidden = false;
    setProgress(0, 'Starting…');
    keepAwake(true);
    worker.postMessage({ stacks: jobs, opts });
  });

  $('cancel').addEventListener('click', () => {
    worker.terminate();
    newWorker();
    finishRun();
    showNotice('Cancelled.');
  });

  function finishRun() {
    running = false;
    store.set('running', null);
    $('status').hidden = true; $('keep-open').hidden = true;
    keepAwake(false);
    updateGo();
  }

  function setProgress(frac, text) {
    $('bar-fill').style.width = `${Math.round(frac * 100)}%`;
    $('status-text').textContent = text;
  }

  const cards = [];
  function card(index) {
    if (cards[index]) return cards[index];
    const el = document.createElement('section');
    el.className = 'card result';
    const h = document.createElement('h2');
    h.textContent = jobs[index].name;
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = `${jobs[index].files.length} photos · waiting`;
    const msgs = document.createElement('div');
    const outs = document.createElement('div');
    outs.className = 'outs';
    el.append(h, sub, msgs, outs);
    $('results').append(el);
    return (cards[index] = { el, sub, msgs, outs });
  }

  function clearResults() {
    for (const u of results) URL.revokeObjectURL(u);
    results = [];
    cards.length = 0;
    $('results').textContent = '';
  }

  const canShareFiles = (file) => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
  };

  function onWorker(e) {
    const m = e.data;
    const total = jobs.length;
    if (m.type === 'fatal') { finishRun(); showNotice(m.message, true); return; }
    if (m.type === 'done') { finishRun(); return; }
    const c = card(m.index);
    const prefix = total > 1 ? `Stack ${m.index + 1} of ${total}: ` : '';
    if (m.type === 'start') {
      c.sub.textContent = `${m.n} photos · working…`;
      c.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (m.type === 'progress') {
      setProgress((m.index + m.frac) / total, prefix + m.msg);
    } else if (m.type === 'note') {
      const p = document.createElement('p'); p.className = 'msg'; p.textContent = m.message; c.msgs.append(p);
    } else if (m.type === 'error') {
      c.sub.textContent = 'Failed';
      const p = document.createElement('p'); p.className = 'msg error'; p.textContent = m.message; c.msgs.append(p);
    } else if (m.type === 'result') {
      c.sub.textContent = `${jobs[m.index].files.length} photos · done in ${formatTime(m.seconds)}`;
      for (const o of m.outputs) c.outs.append(outputView(o));
    }
  }

  function formatTime(s) {
    return s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  }

  function outputView(o) {
    const url = URL.createObjectURL(o.blob);
    results.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'out';
    const fig = document.createElement('figure');
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = url; img.alt = `${o.label} result`; img.width = o.w; img.height = o.h;
    a.append(img);
    const cap = document.createElement('figcaption');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = o.label + ' ';
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = `${o.w}×${o.h} · ${(o.blob.size / 1e6).toFixed(1)} MB`;
    label.append(size);
    const acts = document.createElement('span');
    acts.className = 'acts';
    const dl = document.createElement('a');
    dl.className = 'btn'; dl.href = url; dl.download = o.filename; dl.textContent = 'Download';
    acts.append(dl);
    const file = new File([o.blob], o.filename, { type: o.blob.type });
    if (canShareFiles(file)) {
      const sh = document.createElement('button');
      sh.type = 'button'; sh.className = 'btn primary'; sh.textContent = 'Save / Share';
      sh.addEventListener('click', () => navigator.share({ files: [file] }).catch(() => {}));
      acts.append(sh);
    }
    cap.append(label, acts);
    fig.append(a, cap);
    wrap.append(fig);
    return wrap;
  }

  renderStacks();
})();
