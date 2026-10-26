/*
 * Focus stacking engine: frame alignment plus two fusion methods.
 * A JavaScript port of the desktop stacker.py, written to run in a Web Worker
 * (or Node, for testing). No DOM access and no dependencies.
 *
 * - Pyramid fusion: Laplacian-pyramid blend that favours the sharpest frame per
 *   pixel at every scale. Best for fine detail (hairs, setae, ommatidia).
 * - Depth-map fusion: picks the sharpest frame per pixel, smooths that choice,
 *   and blends the source frames. Cleaner colour/tone, fewer contrast artefacts.
 *
 * Memory: frames are streamed (decoded, used and dropped one at a time), so a
 * long stack needs little more memory than a short one. That keeps phones happy.
 *
 * Images are passed around as planes: {w, h, r, g, b} with Uint8Array channels,
 * or single Float32Array planes for grey/intermediate data.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Filtering helpers (OpenCV-compatible where it matters)
  // ---------------------------------------------------------------------------

  function reflect101(i, n) {
    if (n === 1) return 0;
    while (i < 0 || i >= n) {
      if (i < 0) i = -i;
      if (i >= n) i = 2 * n - 2 - i;
    }
    return i;
  }

  function gaussianKernel(sigma, ksize) {
    // OpenCV's automatic size for float images: round(sigma * 8 + 1) | 1
    let k = ksize || (Math.round(sigma * 8 + 1) | 1);
    if (k < 3) k = 3;
    const r = k >> 1, ker = new Float32Array(k);
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const x = i - r;
      ker[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
      sum += ker[i];
    }
    for (let i = 0; i < k; i++) ker[i] /= sum;
    return ker;
  }

  // Separable convolution with reflect-101 borders (OpenCV BORDER_DEFAULT).
  function sepConv(src, w, h, kx, ky) {
    const tmp = new Float32Array(w * h);
    const nx = kx.length, rx = nx >> 1, ny = ky.length, ry = ny >> 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        if (x >= rx && x < w - rx) {
          const base = row + x - rx;
          for (let k = 0; k < nx; k++) s += src[base + k] * kx[k];
        } else {
          for (let k = 0; k < nx; k++) s += src[row + reflect101(x - rx + k, w)] * kx[k];
        }
        tmp[row + x] = s;
      }
    }
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let k = 0; k < ny; k++) {
        const yy = reflect101(y - ry + k, h) * w, c = ky[k];
        for (let x = 0; x < w; x++) dst[o + x] += tmp[yy + x] * c;
      }
    }
    return dst;
  }

  // One box-blur pass of radius r along rows (horizontal) or columns.
  function boxPass(src, w, h, r, horizontal) {
    const dst = new Float32Array(w * h);
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    const step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
    const inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[base + reflect101(i, n) * step];
      for (let i = 0; i < n; i++) {
        dst[base + i * step] = s * inv;
        s += src[base + reflect101(i + r + 1, n) * step] - src[base + reflect101(i - r, n) * step];
      }
    }
    return dst;
  }

  // Gaussian blur. Large sigmas use three box passes (a close, much faster approximation).
  function gaussianBlur(src, w, h, sigma) {
    if (sigma <= 4) {
      const k = gaussianKernel(sigma);
      return sepConv(src, w, h, k, k);
    }
    // Box sizes whose triple convolution has the requested sigma (Kovesi).
    const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    let out = src;
    for (let i = 0; i < n; i++) {
      const r = ((i < m ? wl : wu) - 1) >> 1;
      out = boxPass(boxPass(out, w, h, r, true), w, h, r, false);
    }
    return out;
  }

  // cv2.pyrDown: 5-tap [1 4 6 4 1]/16 blur then drop every other row/column.
  function pyrDown(src, w, h) {
    const dw = (w + 1) >> 1, dh = (h + 1) >> 1;
    const tmp = new Float32Array(dw * h);
    for (let y = 0; y < h; y++) {
      const row = y * w, o = y * dw;
      for (let X = 0; X < dw; X++) {
        const x = 2 * X;
        tmp[o + X] = (src[row + reflect101(x - 2, w)] + src[row + reflect101(x + 2, w)]
          + 4 * (src[row + reflect101(x - 1, w)] + src[row + reflect101(x + 1, w)])
          + 6 * src[row + x]) / 16;
      }
    }
    const dst = new Float32Array(dw * dh);
    for (let Y = 0; Y < dh; Y++) {
      const y = 2 * Y, o = Y * dw;
      const a = reflect101(y - 2, h) * dw, b = reflect101(y - 1, h) * dw, c = y * dw,
        d = reflect101(y + 1, h) * dw, e = reflect101(y + 2, h) * dw;
      for (let X = 0; X < dw; X++) {
        dst[o + X] = (tmp[a + X] + tmp[e + X] + 4 * (tmp[b + X] + tmp[d + X]) + 6 * tmp[c + X]) / 16;
      }
    }
    return { data: dst, w: dw, h: dh };
  }

  // cv2.pyrUp to an explicit size (dw x dh).
  function pyrUp(src, w, h, dw, dh) {
    const lo = (i) => (i < 0 ? -i : i);           // reflect at the start
    const hi = (i, n) => (i >= n ? n - 1 : i);    // replicate at the end (as OpenCV does)
    const tmp = new Float32Array(dw * h);
    for (let y = 0; y < h; y++) {
      const row = y * w, o = y * dw;
      for (let X = 0; X < dw; X++) {
        const i = X >> 1;
        tmp[o + X] = (X & 1)
          ? (src[row + i] + src[row + hi(i + 1, w)]) * 0.5
          : (src[row + lo(i - 1)] + 6 * src[row + i] + src[row + hi(i + 1, w)]) * 0.125;
      }
    }
    const dst = new Float32Array(dw * dh);
    for (let Y = 0; Y < dh; Y++) {
      const i = Y >> 1, o = Y * dw;
      if (Y & 1) {
        const a = i * dw, b = hi(i + 1, h) * dw;
        for (let X = 0; X < dw; X++) dst[o + X] = (tmp[a + X] + tmp[b + X]) * 0.5;
      } else {
        const a = lo(i - 1) * dw, b = i * dw, c = hi(i + 1, h) * dw;
        for (let X = 0; X < dw; X++) dst[o + X] = (tmp[a + X] + 6 * tmp[b + X] + tmp[c + X]) * 0.125;
      }
    }
    return dst;
  }

  // cv2.Laplacian(ksize=3): kernel [[2,0,2],[0,-8,0],[2,0,2]].
  function laplacian3(src, w, h) {
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ym = reflect101(y - 1, h) * w, yp = reflect101(y + 1, h) * w, yc = y * w;
      for (let x = 0; x < w; x++) {
        const xm = reflect101(x - 1, w), xp = reflect101(x + 1, w);
        dst[yc + x] = 2 * (src[ym + xm] + src[ym + xp] + src[yp + xm] + src[yp + xp]) - 8 * src[yc + x];
      }
    }
    return dst;
  }

  // 5x5 median of small integer labels (0..n-1), replicate border, sliding histogram.
  function median5(src, w, h, n) {
    const dst = new Uint8Array(w * h), hist = new Int32Array(n);
    const cx = (x) => (x < 0 ? 0 : x >= w ? w - 1 : x), cy = (y) => (y < 0 ? 0 : y >= h ? h - 1 : y);
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      const rows = [];
      for (let dy = -2; dy <= 2; dy++) rows.push(cy(y + dy) * w);
      for (const r of rows) for (let dx = -2; dx <= 2; dx++) hist[src[r + cx(dx)]]++;
      for (let x = 0; x < w; x++) {
        let c = 0, v = 0;
        while ((c += hist[v]) < 13) v++;
        dst[y * w + x] = v;
        if (x + 1 < w) {
          const out = cx(x - 2), inn = cx(x + 3);
          for (const r of rows) { hist[src[r + out]]--; hist[src[r + inn]]++; }
        }
      }
    }
    return dst;
  }

  // ---------------------------------------------------------------------------
  // Colour / resampling
  // ---------------------------------------------------------------------------

  function toGray(img) {
    const n = img.w * img.h, g = new Float32Array(n), { r, g: G, b } = img;
    for (let i = 0; i < n; i++) g[i] = Math.round(0.299 * r[i] + 0.587 * G[i] + 0.114 * b[i]);
    return g; // 0..255
  }

  // Area (box) resize by an arbitrary factor < 1, like cv2.INTER_AREA.
  function resizeArea(src, w, h, dw, dh) {
    const dst = new Float32Array(dw * dh);
    const sx = w / dw, sy = h / dh;
    for (let Y = 0; Y < dh; Y++) {
      const y0 = Y * sy, y1 = y0 + sy;
      for (let X = 0; X < dw; X++) {
        const x0 = X * sx, x1 = x0 + sx;
        let s = 0, a = 0;
        for (let y = Math.floor(y0); y < Math.min(Math.ceil(y1), h); y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          for (let x = Math.floor(x0); x < Math.min(Math.ceil(x1), w); x++) {
            const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
            s += src[y * w + x] * wgt; a += wgt;
          }
        }
        dst[Y * dw + X] = s / a;
      }
    }
    return dst;
  }

  // Bilinear sample of a float plane; NaN outside the image.
  function bilinear(src, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
    const x0 = Math.min(Math.floor(x), w - 2), y0 = Math.min(Math.floor(y), h - 2);
    const fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (src[i] * (1 - fx) + src[i + 1] * fx) * (1 - fy) + (src[i + w] * (1 - fx) + src[i + w + 1] * fx) * fy;
  }

  // Bicubic (OpenCV A = -0.75) affine warp of an RGB frame. A maps output pixel
  // coordinates to source coordinates (cv2.WARP_INVERSE_MAP); replicate border.
  function warpAffineRGB(img, A) {
    const { w, h } = img;
    if (Math.abs(A[0] - 1) < 1e-9 && Math.abs(A[1]) < 1e-9 && Math.abs(A[2]) < 1e-6 &&
        Math.abs(A[3]) < 1e-9 && Math.abs(A[4] - 1) < 1e-9 && Math.abs(A[5]) < 1e-6) return img;
    const out = { w, h, r: new Uint8ClampedArray(w * h), g: new Uint8ClampedArray(w * h), b: new Uint8ClampedArray(w * h) };
    const C = -0.75, wx = new Float64Array(4), wy = new Float64Array(4), xi = new Int32Array(4), yi = new Int32Array(4);
    const planes = [img.r, img.g, img.b], outs = [out.r, out.g, out.b];
    const coef = (t, wv) => {
      const t1 = t + 1, u = 1 - t;
      wv[0] = ((C * t1 - 5 * C) * t1 + 8 * C) * t1 - 4 * C;
      wv[1] = ((C + 2) * t - (C + 3)) * t * t + 1;
      wv[2] = ((C + 2) * u - (C + 3)) * u * u + 1;
      wv[3] = 1 - wv[0] - wv[1] - wv[2];
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = A[0] * x + A[1] * y + A[2], sy = A[3] * x + A[4] * y + A[5];
        const ix = Math.floor(sx), iy = Math.floor(sy);
        coef(sx - ix, wx); coef(sy - iy, wy);
        for (let k = 0; k < 4; k++) {
          const xx = ix - 1 + k, yy = iy - 1 + k;
          xi[k] = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          yi[k] = (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * w;
        }
        const o = y * w + x;
        for (let c = 0; c < 3; c++) {
          const p = planes[c];
          let s = 0;
          for (let j = 0; j < 4; j++) {
            const r = yi[j];
            s += wy[j] * (wx[0] * p[r + xi[0]] + wx[1] * p[r + xi[1]] + wx[2] * p[r + xi[2]] + wx[3] * p[r + xi[3]]);
          }
          outs[c][o] = s; // Uint8ClampedArray rounds and saturates, like cv2's uint8 output
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3x3 matrix helpers (row-major arrays of 9)
  // ---------------------------------------------------------------------------

  const eye = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function mul(a, b) {
    const c = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      c[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return c;
  }
  function inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  const diag = (s) => [s, 0, 0, 0, s, 0, 0, 0, 1];

  function invertN(M, n) {
    // Gauss-Jordan inverse of an n x n matrix (array of rows); null if singular.
    const a = M.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-30) return null;
      [a[c], a[p]] = [a[p], a[c]];
      const pv = a[c][c];
      for (let j = 0; j < 2 * n; j++) a[c][j] /= pv;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = a[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
      }
    }
    return a.map((row) => row.slice(n));
  }

  // ---------------------------------------------------------------------------
  // Alignment: phase correlation (coarse shift) + ECC affine refinement
  // ---------------------------------------------------------------------------

  function fft1d(re, im, n, inverse) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function fft2d(re, im, W, H, inverse) {
    const rr = new Float64Array(Math.max(W, H)), ri = new Float64Array(Math.max(W, H));
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) { rr[x] = re[o + x]; ri[x] = im[o + x]; }
      fft1d(rr, ri, W, inverse);
      for (let x = 0; x < W; x++) { re[o + x] = rr[x]; im[o + x] = ri[x]; }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) { rr[y] = re[y * W + x]; ri[y] = im[y * W + x]; }
      fft1d(rr, ri, H, inverse);
      for (let y = 0; y < H; y++) { re[y * W + x] = rr[y]; im[y * W + x] = ri[y]; }
    }
  }

  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  // Returns [dx, dy] such that b(x + d) ~= a(x)  (same convention as cv2.phaseCorrelate).
  function phaseCorrelate(a, b, w, h) {
    const W = nextPow2(w), H = nextPow2(h);
    const ar = new Float64Array(W * H), ai = new Float64Array(W * H);
    const br = new Float64Array(W * H), bi = new Float64Array(W * H);
    const hx = new Float64Array(w), hy = new Float64Array(h);
    for (let x = 0; x < w; x++) hx[x] = 0.5 * (1 - Math.cos(2 * Math.PI * x / (w - 1)));
    for (let y = 0; y < h; y++) hy[y] = 0.5 * (1 - Math.cos(2 * Math.PI * y / (h - 1)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const win = hx[x] * hy[y];
      ar[y * W + x] = a[y * w + x] * win; br[y * W + x] = b[y * w + x] * win;
    }
    fft2d(ar, ai, W, H, false); fft2d(br, bi, W, H, false);
    for (let i = 0; i < W * H; i++) {
      // conj(A) * B, normalised -> peak sits at the shift of b relative to a
      const re = ar[i] * br[i] + ai[i] * bi[i], im = ar[i] * bi[i] - ai[i] * br[i];
      const mag = Math.hypot(re, im) + 1e-12;
      ar[i] = re / mag; ai[i] = im / mag;
    }
    fft2d(ar, ai, W, H, true);
    let best = -Infinity, px = 0, py = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (ar[y * W + x] > best) { best = ar[y * W + x]; px = x; py = y; }
    }
    // Sub-pixel peak: weighted centroid over a 5x5 neighbourhood (wrapping).
    let sx = 0, sy = 0, s = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const v = ar[((py + dy + H) % H) * W + ((px + dx + W) % W)];
      if (v > 0) { sx += v * dx; sy += v * dy; s += v; }
    }
    let dx = px + (s ? sx / s : 0), dy = py + (s ? sy / s : 0);
    if (dx > W / 2) dx -= W;
    if (dy > H / 2) dy -= H;
    return [dx, dy];
  }

  // Enhanced Correlation Coefficient maximisation, affine motion (cv2.findTransformECC).
  // Finds W (2x3, row-major) with inp(W [x y 1]) ~= tmpl(x, y).
  // Returns {W, rho} (rho = correlation achieved, up to 1), or null on failure.
  function eccAffine(tmpl, inp, w, h, W0, maxIter, eps) {
    const k5 = gaussianKernel(1.1, 5); // cv2's gaussFiltSize = 5
    const T = sepConv(tmpl, w, h, k5, k5), I = sepConv(inp, w, h, k5, k5);
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = (I[y * w + reflect101(x + 1, w)] - I[y * w + reflect101(x - 1, w)]) * 0.5;
      gy[i] = (I[reflect101(y + 1, h) * w + x] - I[reflect101(y - 1, h) * w + x]) * 0.5;
    }
    const Wm = W0.slice();
    const iw = new Float32Array(w * h), wgx = new Float32Array(w * h), wgy = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    let lastRho = -Infinity;
    for (let it = 0; it < maxIter; it++) {
      let cnt = 0, sT = 0, sI = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const sx = Wm[0] * x + Wm[1] * y + Wm[2], sy = Wm[3] * x + Wm[4] * y + Wm[5];
        const v = bilinear(I, w, h, sx, sy);
        if (v !== v) { mask[i] = 0; continue; }
        mask[i] = 1; cnt++;
        iw[i] = v; wgx[i] = bilinear(gx, w, h, sx, sy); wgy[i] = bilinear(gy, w, h, sx, sy);
        sT += T[i]; sI += v;
      }
      if (cnt < 100) return null;
      const mT = sT / cnt, mI = sI / cnt;
      const H6 = Array.from({ length: 6 }, () => new Float64Array(6));
      const ip = new Float64Array(6), tp = new Float64Array(6), J = new Float64Array(6);
      let corr = 0, nT = 0, nI = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const t = T[i] - mT, v = iw[i] - mI, gxv = wgx[i], gyv = wgy[i];
        J[0] = gxv * x; J[1] = gyv * x; J[2] = gxv * y; J[3] = gyv * y; J[4] = gxv; J[5] = gyv;
        for (let a = 0; a < 6; a++) {
          const ja = J[a];
          ip[a] += ja * v; tp[a] += ja * t;
          const row = H6[a];
          for (let b = a; b < 6; b++) row[b] += ja * J[b];
        }
        corr += t * v; nT += t * t; nI += v * v;
      }
      for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H6[a][b] = H6[b][a];
      const rho = corr / Math.sqrt(nT * nI);
      if (!(rho === rho)) return null;
      if (Math.abs(rho - lastRho) < eps) return { W: Wm, rho };
      lastRho = rho;
      const Hi = invertN(H6.map((r) => Array.from(r)), 6);
      if (!Hi) return null;
      const iph = Hi.map((row) => row.reduce((s, v, j) => s + v * ip[j], 0));
      let pIph = 0, tIph = 0;
      for (let a = 0; a < 6; a++) { pIph += ip[a] * iph[a]; tIph += tp[a] * iph[a]; }
      const lamD = corr - tIph;
      if (lamD <= 0) return null;
      const lam = (nI - pIph) / lamD;
      const ep = new Float64Array(6);
      for (let a = 0; a < 6; a++) ep[a] = lam * tp[a] - ip[a];
      const dp = Hi.map((row) => row.reduce((s, v, j) => s + v * ep[j], 0));
      // parameter order follows the Jacobian columns: a11, a21, a12, a22, tx, ty
      Wm[0] += dp[0]; Wm[3] += dp[1]; Wm[1] += dp[2]; Wm[4] += dp[3]; Wm[2] += dp[4]; Wm[5] += dp[5];
    }
    return { W: Wm, rho: lastRho };
  }

  // Reject transforms that are clearly wrong for a focus stack.
  function plausible(M, w, h) {
    return Math.max(Math.abs(M[0] - 1), Math.abs(M[1]), Math.abs(M[3]), Math.abs(M[4] - 1)) <= 0.05
      && Math.abs(M[2]) < 0.15 * w && Math.abs(M[5]) < 0.15 * h;
  }

  /**
   * Alignment pyramid for one frame: grey at a "fine" scale (long side <= 1024)
   * and a "coarse" one (half that). The desktop version used 1/2 and 1/4 of a
   * 2592px frame; capping the size keeps phones fast on 12+ MP photos.
   */
  function alignLevels(img) {
    const full = toGray(img);
    const sFine = Math.min(0.5, 1024 / Math.max(img.w, img.h));
    const fw = Math.max(16, Math.round(img.w * sFine)), fh = Math.max(16, Math.round(img.h * sFine));
    const fine = resizeArea(full, img.w, img.h, fw, fh);
    const cw = Math.max(8, Math.round(fw / 2)), ch = Math.max(8, Math.round(fh / 2));
    const coarse = resizeArea(fine, fw, fh, cw, ch);
    for (const p of [fine, coarse]) for (let i = 0; i < p.length; i++) p[i] /= 255;
    return { W: img.w, H: img.h, fine: { d: fine, w: fw, h: fh, s: fw / img.w },
      coarse: { d: coarse, w: cw, h: ch, s: cw / img.w } };
  }

  const ECC_EPS = 1e-5;

  // Coarse-to-fine ECC from a starting guess. Returns {W, rho}; rho = -1 if nothing worked.
  function refine(a, b, W) {
    let rho = -1;
    for (const [lev, iters] of [['coarse', 100], ['fine', 50]]) {
      const la = a[lev], lb = b[lev], S = diag(la.s);
      const Ws = mul(mul(S, W), inv(S));
      const res = eccAffine(la.d, lb.d, la.w, la.h, Ws.slice(0, 6), iters, ECC_EPS);
      if (!res) continue;
      const cand = mul(mul(inv(S), [...res.W, 0, 0, 1]), S);
      if (plausible(cand, a.W, a.H)) { W = cand; rho = res.rho; }
    }
    return { W, rho };
  }

  // 3x3 W (full-res coords) such that b(W x) ~= a(x).
  function pairTransform(a, b) {
    // Phase correlation gives a starting shift, but on real stacks it can lock onto
    // a false peak (repeating texture, the eyepiece circle). So also refine from
    // "no movement" and keep whichever start ends with the better correlation.
    const c = a.coarse;
    const [dx, dy] = phaseCorrelate(c.d, b.coarse.d, c.w, c.h);
    const guess = eye();
    guess[2] = dx / c.s; guess[5] = dy / c.s;
    const fromIdentity = refine(a, b, eye());
    if (!plausible(guess, a.W, a.H) || Math.hypot(dx, dy) < 2) return fromIdentity.W;
    const fromGuess = refine(a, b, guess);
    return fromGuess.rho > fromIdentity.rho ? fromGuess.W : fromIdentity.W;
  }

  // Chain pairwise transforms so every frame maps onto the middle frame.
  function chainTransforms(pairs, n) {
    const ref = n >> 1, M = new Array(n);
    M[ref] = eye();
    for (let k = ref + 1; k < n; k++) M[k] = mul(pairs[k - 1], M[k - 1]);
    for (let k = ref - 1; k >= 0; k--) M[k] = mul(inv(pairs[k]), M[k + 1]);
    return M;
  }

  // Pixels that every warped frame covers (nearest-neighbour test, as cv2 does).
  function validMask(M, w, h) {
    const valid = new Uint8Array(w * h).fill(1);
    for (const T of M) {
      if (T.every((v, i) => Math.abs(v - eye()[i]) < 1e-9)) continue;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.round(T[0] * x + T[1] * y + T[2]), sy = Math.round(T[3] * x + T[4] * y + T[5]);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) valid[y * w + x] = 0;
      }
    }
    return valid;
  }

  // Trim edges until the box is fully inside the (convex) valid area.
  function validBox(mask, w, h) {
    let t = 0, b = h, l = 0, r = w;
    const badRow = (y) => { let n = 0; for (let x = l; x < r; x++) n += !mask[y * w + x]; return n; };
    const badCol = (x) => { let n = 0; for (let y = t; y < b; y++) n += !mask[y * w + x]; return n; };
    while (b - t > 10 && r - l > 10) {
      const bad = [badRow(t), badRow(b - 1), badCol(l), badCol(r - 1)];
      if (!bad[0] && !bad[1] && !bad[2] && !bad[3]) break;
      const i = bad.indexOf(Math.max(...bad));
      if (i === 0) t++; else if (i === 1) b--; else if (i === 2) l++; else r--;
    }
    return { t, b, l, r };
  }

  // Brightness gains from the coarse alignment images (cheap stand-in for full-res means).
  function brightnessGains(levels, M) {
    const n = levels.length, ref = n >> 1, c0 = levels[0].coarse, { w, h, s } = c0;
    const S = diag(s), Si = inv(S);
    const Ms = M.map((T) => mul(mul(S, T), Si));
    const valid = new Uint8Array(w * h).fill(1);
    for (const T of Ms) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = T[0] * x + T[1] * y + T[2], sy = T[3] * x + T[4] * y + T[5];
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) valid[y * w + x] = 0;
    }
    const means = levels.map((lv, k) => {
      const T = Ms[k]; let sum = 0, cnt = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!valid[y * w + x]) continue;
        sum += bilinear(lv.coarse.d, w, h, T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]); cnt++;
      }
      return cnt ? sum / cnt : 0;
    });
    return means.map((m) => {
      const g = means[ref] / Math.max(m, 1e-3);
      return Math.abs(g - 1) > 0.002 ? g : 1;
    });
  }

  function applyGain(img, gain) {
    if (gain === 1) return img;
    const out = { w: img.w, h: img.h };
    for (const c of ['r', 'g', 'b']) {
      const src = img[c], dst = new Uint8ClampedArray(src.length);
      for (let i = 0; i < src.length; i++) dst[i] = src[i] * gain; // round + saturate (cv2.convertScaleAbs)
      out[c] = dst;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Pyramid fusion (streaming; constant memory in the number of frames)
  // ---------------------------------------------------------------------------

  function pyramidLevels(w, h) {
    return Math.max(3, Math.floor(Math.log2(Math.min(w, h))) - 5);
  }

  function createPyramidFuser(w, h, sharpness) {
    const levels = pyramidLevels(w, h);
    let m = null, z = null, s = null, top = null, count = 0;
    const k1 = gaussianKernel(1.0);

    function add(img) {
      // Gaussian pyramid of the frame, per channel, in 0..1
      const gauss = ['r', 'g', 'b'].map((c) => {
        const src = img[c], f = new Float32Array(src.length);
        for (let i = 0; i < src.length; i++) f[i] = src[i] / 255;
        const lv = [{ data: f, w, h }];
        for (let i = 0; i < levels; i++) { const p = lv[lv.length - 1]; lv.push(pyrDown(p.data, p.w, p.h)); }
        return lv;
      });
      if (!m) { m = new Array(levels); z = new Array(levels); s = new Array(levels); }
      for (let i = 0; i < levels; i++) {
        const lw = gauss[0][i].w, lh = gauss[0][i].h, n = lw * lh;
        const L = gauss.map((g) => {
          const up = pyrUp(g[i + 1].data, g[i + 1].w, g[i + 1].h, lw, lh), cur = g[i].data;
          for (let j = 0; j < n; j++) up[j] = cur[j] - up[j];
          return up;
        });
        const e = new Float32Array(n);
        for (let j = 0; j < n; j++) e[j] = L[0][j] * L[0][j] + L[1][j] * L[1][j] + L[2][j] * L[2][j];
        const energy = sepConv(e, lw, lh, k1, k1);
        if (!m[i]) {
          const mi = new Float32Array(n);
          for (let j = 0; j < n; j++) mi[j] = sharpness * Math.log(energy[j] + 1e-10);
          m[i] = mi; z[i] = new Float32Array(n).fill(1); s[i] = L;
        } else {
          const mi = m[i], zi = z[i], si = s[i];
          for (let j = 0; j < n; j++) {
            // Online soft-max: keeps memory constant regardless of stack size
            const logw = sharpness * Math.log(energy[j] + 1e-10), mNew = Math.max(mi[j], logw);
            const a = Math.exp(mi[j] - mNew), b = Math.exp(logw - mNew);
            zi[j] = zi[j] * a + b;
            si[0][j] = si[0][j] * a + L[0][j] * b;
            si[1][j] = si[1][j] * a + L[1][j] * b;
            si[2][j] = si[2][j] * a + L[2][j] * b;
            mi[j] = mNew;
          }
        }
      }
      const t = gauss.map((g) => g[levels].data);
      if (!top) top = t.map((p) => Float32Array.from(p));
      else for (let c = 0; c < 3; c++) for (let j = 0; j < t[c].length; j++) top[c][j] += t[c][j];
      count++;
    }

    function finish() {
      const out = { w, h };
      ['r', 'g', 'b'].forEach((c, ci) => {
        let cur = top[ci].map((v) => v / count), cw = Math.max(1, Math.ceil(w / 2 ** levels)), chh = Math.max(1, Math.ceil(h / 2 ** levels));
        for (let i = levels - 1; i >= 0; i--) {
          const lw = Math.ceil(w / 2 ** i), lh = Math.ceil(h / 2 ** i);
          const up = pyrUp(cur, cw, chh, lw, lh), si = s[i][ci], zi = z[i];
          for (let j = 0; j < up.length; j++) up[j] += si[j] / zi[j];
          cur = up; cw = lw; chh = lh;
        }
        const o = new Uint8ClampedArray(w * h);
        for (let j = 0; j < o.length; j++) o[j] = cur[j] * 255;
        out[c] = o;
      });
      return out;
    }

    return { add, finish };
  }

  // ---------------------------------------------------------------------------
  // Depth-map fusion
  // ---------------------------------------------------------------------------

  function weightedBlur(values, weights, w, h, sigma) {
    const vw = new Float32Array(values.length);
    for (let i = 0; i < vw.length; i++) vw[i] = values[i] * weights[i];
    const num = gaussianBlur(vw, w, h, sigma), den = gaussianBlur(weights, w, h, sigma);
    for (let i = 0; i < num.length; i++) num[i] /= Math.max(den[i], 1e-12);
    return num;
  }

  function median(arr) {
    const step = Math.max(1, Math.floor(arr.length / 1e6)); // sample big images
    const sample = new Float32Array(Math.ceil(arr.length / step));
    for (let i = 0, j = 0; i < arr.length; i += step) sample[j++] = arr[i];
    sample.sort();
    return sample[sample.length >> 1];
  }

  function createDepthMapper(w, h, focusSigma) {
    let best = null, idx = null, k = 0;
    const k1 = gaussianKernel(1.0), kf = gaussianKernel(focusSigma);
    function add(img) {
      const g = toGray(img);
      for (let i = 0; i < g.length; i++) g[i] /= 255;
      const lap = laplacian3(sepConv(g, w, h, k1, k1), w, h);
      for (let i = 0; i < lap.length; i++) lap[i] *= lap[i];
      const focus = sepConv(lap, w, h, kf, kf);
      if (!best) { best = focus; idx = new Uint8Array(w * h); }
      else for (let i = 0; i < focus.length; i++) if (focus[i] > best[i]) { best[i] = focus[i]; idx[i] = k; }
      k++;
    }
    // Smooth the per-pixel frame choice into a continuous depth map.
    function depth(n, smoothing) {
      const lab = median5(idx, w, h, Math.max(n, 1));
      const fidx = Float32Array.from(lab);
      const conf = new Float32Array(best.length);
      for (let i = 0; i < conf.length; i++) conf[i] = Math.sqrt(best[i]);
      best = null; idx = null;
      // Confident (textured) pixels keep their own depth; featureless areas
      // (blank slide, smooth cuticle) borrow depth from a wide neighbourhood.
      const fine = weightedBlur(fidx, conf, w, h, smoothing);
      const broad = weightedBlur(fidx, conf, w, h, 25.0);
      const refConf = median(conf) + 1e-12;
      const d = new Float32Array(w * h);
      for (let i = 0; i < d.length; i++) {
        const a = Math.min(1, Math.max(0, conf[i] / refConf));
        d[i] = a * fine[i] + (1 - a) * broad[i];
      }
      return d;
    }
    return { add, depth };
  }

  function createDepthBlender(w, h, depth) {
    const acc = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    let k = 0;
    function add(img) {
      const p = [img.r, img.g, img.b];
      for (let i = 0; i < depth.length; i++) {
        const wk = 1 - Math.abs(depth[i] - k);
        if (wk > 0) { acc[0][i] += p[0][i] * wk; acc[1][i] += p[1][i] * wk; acc[2][i] += p[2][i] * wk; }
      }
      k++;
    }
    function finish() {
      return { w, h, r: Uint8ClampedArray.from(acc[0]), g: Uint8ClampedArray.from(acc[1]), b: Uint8ClampedArray.from(acc[2]) };
    }
    return { add, finish };
  }

  // Viridis colour map (polynomial fit), 256 entries.
  const VIRIDIS = (() => {
    const c = [[0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
      [0.1050930431085774, 1.404613529898575, 1.384590162594685],
      [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
      [-4.634230498983486, -5.799100973351585, -19.33244095627987],
      [6.228269936347081, 14.17993336680509, 56.69055260068105],
      [4.776384997670288, -13.74514537774601, -65.35303263337234],
      [-5.435455855934631, 4.645852612178535, 26.3124352495832]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let ch = 0; ch < 3; ch++) {
        let v = c[6][ch];
        for (let j = 5; j >= 0; j--) v = v * t + c[j][ch];
        lut[i * 3 + ch] = v * 255;
      }
    }
    return lut;
  })();

  function depthToColor(depth, n, w, h) {
    const out = { w, h, r: new Uint8Array(w * h), g: new Uint8Array(w * h), b: new Uint8Array(w * h) };
    const sc = 255 / Math.max(n - 1, 1);
    for (let i = 0; i < depth.length; i++) {
      const d = Math.min(255, Math.max(0, Math.floor(depth[i] * sc))) * 3;
      out.r[i] = VIRIDIS[d]; out.g[i] = VIRIDIS[d + 1]; out.b[i] = VIRIDIS[d + 2];
    }
    return out;
  }

  function crop(img, box) {
    const { t, b, l, r } = box, w = r - l, h = b - t;
    if (w === img.w && h === img.h) return img;
    const out = { w, h };
    for (const c of ['r', 'g', 'b']) {
      const dst = new Uint8ClampedArray(w * h), src = img[c];
      for (let y = 0; y < h; y++) dst.set(src.subarray((t + y) * img.w + l, (t + y) * img.w + r), y * w);
      out[c] = dst;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Top level
  // ---------------------------------------------------------------------------

  /**
   * Stack n frames. `getFrame(k)` returns (a promise of) {w, h, r, g, b}; it is
   * called once per frame per pass, so frames never all sit in memory at once.
   * `progress(fraction, message)` is called as work proceeds.
   *
   * Returns {pyramid?, depthmap?, depth?} images (cropped if requested).
   */
  async function runStack(n, getFrame, opts, progress) {
    const o = Object.assign({ pyramid: true, depthmap: true, align: true, crop: true,
      saveDepth: true, sharpness: 6.0, smoothing: 2.0, focusSigma: 2.0 }, opts);
    progress = progress || (() => {});
    if (n < 2) throw new Error('A stack needs at least 2 images.');
    const passes = (o.align ? 1 : 0) + 1 + (o.depthmap ? 1 : 0);
    let done = 0;
    const tick = (msg) => { done++; progress(done / (passes * n), msg); };

    // Pass 1: alignment (only small grey copies are kept)
    let w, h, M = null, gains = null, box = null;
    let first = await getFrame(0);
    w = first.w; h = first.h;
    if (o.align) {
      const levels = [];
      const pairs = [];
      for (let k = 0; k < n; k++) {
        const img = k === 0 ? first : await getFrame(k);
        if (img.w !== w || img.h !== h) throw new Error(`Image ${k + 1} is ${img.w}x${img.h}, but the first is ${w}x${h}. All images in a stack must be the same size.`);
        levels.push(alignLevels(img));
        if (k > 0) {
          pairs.push(pairTransform(levels[k - 1], levels[k]));
          levels[k - 1].fine = null; // only consecutive frames need the fine level
        }
        tick(`Aligning: frame ${k + 1} of ${n}`);
      }
      first = null;
      M = chainTransforms(pairs, n);
      gains = brightnessGains(levels, M);
      box = validBox(validMask(M, w, h), w, h);
    }

    const aligned = async (k) => {
      let img = (k === 0 && !o.align) ? first : await getFrame(k);
      if (img.w !== w || img.h !== h) throw new Error(`Image ${k + 1} is ${img.w}x${img.h}, but the first is ${w}x${h}. All images in a stack must be the same size.`);
      if (M) img = applyGain(warpAffineRGB(img, M[k].slice(0, 6)), gains[k]);
      return img;
    };

    // Pass 2: pyramid fusion and/or depth measurement
    let fuser = o.pyramid ? createPyramidFuser(w, h, o.sharpness) : null;
    let mapper = o.depthmap ? createDepthMapper(w, h, o.focusSigma) : null;
    for (let k = 0; k < n; k++) {
      const img = await aligned(k);
      if (fuser) fuser.add(img);
      if (mapper) mapper.add(img);
      tick(`${o.pyramid ? 'Pyramid' : 'Depth map'}: frame ${k + 1} of ${n}`);
    }
    const out = {};
    const finish = (img) => (o.crop && box ? crop(img, box) : img);
    if (fuser) {
      progress(done / (passes * n), 'Building pyramid result');
      out.pyramid = finish(fuser.finish());
      fuser = null; // release the pyramid's working memory before the depth pass
    }

    // Pass 3: depth-map blend
    if (mapper) {
      progress(done / (passes * n), 'Smoothing depth map');
      const depth = mapper.depth(n, o.smoothing);
      mapper = null;
      const blender = createDepthBlender(w, h, depth);
      for (let k = 0; k < n; k++) {
        blender.add(await aligned(k));
        tick(`Depth map blend: frame ${k + 1} of ${n}`);
      }
      out.depthmap = finish(blender.finish());
      if (o.saveDepth) out.depth = finish(depthToColor(depth, n, w, h));
    }
    return out;
  }

  const api = { runStack, pairTransform, alignLevels, phaseCorrelate, eccAffine, pyrDown, pyrUp,
    warpAffineRGB, toGray, gaussianBlur, median5, validBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stacker = api;
})(typeof self !== 'undefined' ? self : this);
