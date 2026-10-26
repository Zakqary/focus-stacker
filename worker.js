/*
 * Background worker: decodes photos, runs the stacking engine and encodes the
 * results, so the page stays responsive. Nothing is uploaded anywhere.
 */
importScripts('stacker.js');

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

let canvas = null, ctx = null;
function context(w, h) {
  if (!canvas) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return ctx;
}

// Pick the working size: the original, or scaled down to at most maxPixels.
async function probe(file, maxPixels) {
  const bmp = await createImageBitmap(file);
  const srcW = bmp.width, srcH = bmp.height;
  bmp.close();
  const scale = maxPixels ? Math.min(1, Math.sqrt(maxPixels / (srcW * srcH))) : 1;
  return { srcW, srcH, w: Math.round(srcW * scale), h: Math.round(srcH * scale) };
}

async function decode(file, size, index) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (e) {
    throw new Error(`Couldn't read "${file.name}". Use JPEG or PNG photos (this browser can't open this file type).`);
  }
  if (bmp.width !== size.srcW || bmp.height !== size.srcH) {
    const msg = `"${file.name}" is ${bmp.width}×${bmp.height}, but the first photo is ${size.srcW}×${size.srcH}. All photos in a stack must be the same size.`;
    bmp.close();
    throw new Error(msg);
  }
  const c = context(size.w, size.h);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, size.w, size.h);
  bmp.close();
  const rgba = c.getImageData(0, 0, size.w, size.h).data;
  const n = size.w * size.h, r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = rgba[j]; g[i] = rgba[j + 1]; b[i] = rgba[j + 2]; }
  return { w: size.w, h: size.h, r, g, b, index };
}

async function encode(img, type) {
  const n = img.w * img.h, rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    rgba[j] = img.r[i]; rgba[j + 1] = img.g[i]; rgba[j + 2] = img.b[i]; rgba[j + 3] = 255;
  }
  const c = context(img.w, img.h);
  c.putImageData(new ImageData(rgba, img.w, img.h), 0, 0);
  return canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.95 } : { type });
}

function friendly(err) {
  const text = String((err && err.message) || err);
  if (err instanceof RangeError || /memory|allocat|array buffer|invalid array length/i.test(text)) {
    return 'Ran out of memory. Open Settings and choose a smaller working size, then try again.';
  }
  return text;
}

self.onmessage = async (e) => {
  const { stacks, opts } = e.data;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    post({ type: 'fatal', message: 'This browser is too old to run the stacker. Please update it (Safari 16.4+, Chrome, Edge or Firefox).' });
    return;
  }
  for (let si = 0; si < stacks.length; si++) {
    const st = stacks[si];
    const t0 = Date.now();
    try {
      post({ type: 'start', index: si, name: st.name, n: st.files.length });
      if (st.files.length < 2) throw new Error('A stack needs at least 2 photos.');
      const size = await probe(st.files[0], opts.maxPixels);
      if (size.w !== size.srcW) {
        post({ type: 'note', index: si, message: `Working at ${size.w}×${size.h} (photos are ${size.srcW}×${size.srcH}). Change this under Settings → Working size.` });
      }
      const result = await self.Stacker.runStack(
        st.files.length, (k) => decode(st.files[k], size, k), opts,
        (frac, msg) => post({ type: 'progress', index: si, frac, msg }));

      post({ type: 'progress', index: si, frac: 1, msg: 'Saving results' });
      const ext = opts.format === 'image/png' ? 'png' : 'jpg';
      const outputs = [];
      for (const [kind, label] of [['pyramid', 'Pyramid'], ['depthmap', 'Depth map'], ['depth', 'Depth image']]) {
        const img = result[kind];
        if (!img) continue;
        const type = kind === 'depth' ? 'image/png' : opts.format;
        const blob = await encode(img, type);
        outputs.push({ kind, label, blob, w: img.w, h: img.h,
          filename: `${st.name}_${kind}.${kind === 'depth' ? 'png' : ext}` });
      }
      post({ type: 'result', index: si, outputs, seconds: (Date.now() - t0) / 1000 });
    } catch (err) {
      post({ type: 'error', index: si, message: friendly(err) });
    }
  }
  post({ type: 'done' });
};
