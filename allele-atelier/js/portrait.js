/*
 * Allele Atelier — procedural portrait renderer.
 *
 * render(phenotype, look) returns an SVG string (viewBox 0 0 400 500).
 * Everything genetic arrives through the phenotype; age, expression,
 * hairstyle, grooming, sun, clothing and backdrop come from `look`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./genome.js'));
  else root.Portrait = factory(root.Genome);
})(typeof self !== 'undefined' ? self : this, function (Genome) {
  'use strict';

  // ------------------------------------------------------------- helpers

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const r1 = (v) => Math.round(v * 10) / 10;

  function hex2rgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex([r, g, b]) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  function mix(a, b, t) {
    const A = hex2rgb(a);
    const B = hex2rgb(b);
    return rgb2hex(A.map((v, i) => lerp(v, B[i], clamp(t, 0, 1))));
  }
  const lighten = (c, t) => mix(c, '#ffffff', t);
  const darken = (c, t) => mix(c, '#000000', t);
  function ramp(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        const [x0, c0] = stops[i - 1];
        const [x1, c1] = stops[i];
        return mix(c0, c1, (x - x0) / (x1 - x0));
      }
    }
    return stops[stops.length - 1][1];
  }

  // Catmull-Rom spline through points, as cubic Bezier path data.
  function crPath(pts, closed, tension = 1) {
    const n = pts.length;
    if (n < 2) return '';
    const get = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
    let d = 'M' + r1(pts[0][0]) + ',' + r1(pts[0][1]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
      const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
      const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
      const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
      d += 'C' + r1(c1x) + ',' + r1(c1y) + ' ' + r1(c2x) + ',' + r1(c2y) + ' ' + r1(p2[0]) + ',' + r1(p2[1]);
    }
    return closed ? d + 'Z' : d;
  }

  // Dense samples along an open Catmull-Rom spline, roughly `step` px apart.
  function dense(pts, step = 4) {
    const out = [];
    const n = pts.length;
    const get = (i) => pts[clamp(i, 0, n - 1)];
    for (let i = 0; i < n - 1; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const m = Math.max(2, Math.ceil(len / step));
      for (let j = 0; j < m; j++) {
        const t = j / m;
        const t2 = t * t, t3 = t2 * t;
        const q = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
        out.push([q(0), q(1)]);
      }
    }
    out.push(pts[n - 1].slice());
    return out;
  }

  // Push points along their outward normal (tangent rotated -90°) by fn(arcLength, index).
  function perturb(pts, fn) {
    let s = 0;
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      const o = fn(s, i);
      return [p[0] + ty * o, p[1] - tx * o];
    });
  }

  function poly(pts) {
    return 'M' + pts.map((p) => r1(p[0]) + ',' + r1(p[1])).join('L') + 'Z';
  }

  const mirrorX = (pts, cx) => pts.map(([x, y]) => [2 * cx - x, y]);

  // Edge texture for a hair silhouette.
  function textureFn(curl, rng, scale = 1) {
    const phase = rng() * 10;
    if (curl < 0.22) return (s) => 0.6 * Math.sin(s / 9 + phase) * scale;
    if (curl < 0.44) return (s) => 3.2 * Math.sin(s / 13 + phase) * scale;
    if (curl < 0.72) return (s) => (5.5 * Math.abs(Math.sin(s / 8 + phase)) - 2) * scale;
    const jit = Array.from({ length: 64 }, () => rng());
    return (s) => (2.6 * Math.abs(Math.sin(s / 3.4 + phase)) + 2.4 * Math.abs(Math.sin(s / 11 + phase * 2)) + 1.6 * jit[Math.floor(s / 5) % 64] - 2.6) * scale;
  }

  // ------------------------------------------------------------- palettes

  const SKIN = [
    [0.0, '#fbe7dd'], [0.08, '#f6d6c3'], [0.18, '#edc3a4'], [0.28, '#e1ac88'],
    [0.4, '#cd946c'], [0.52, '#b57b53'], [0.64, '#97613d'], [0.76, '#784b2e'],
    [0.88, '#5b3621'], [1.0, '#3f2517'],
  ];
  const EU_HAIR = [
    [0.0, '#efdcae'], [0.15, '#dcbe86'], [0.3, '#b98e58'], [0.45, '#8e6439'],
    [0.6, '#654326'], [0.75, '#432b19'], [0.88, '#2a1c13'], [1.0, '#18120e'],
  ];
  const RED_HAIR = [[0.0, '#eab37c'], [0.3, '#d4813f'], [0.55, '#a8491f'], [0.8, '#6c2b16'], [1.0, '#3b1b10']];
  const IRIS_LO = [[0, '#94bce2'], [0.1, '#5b8fc9'], [0.25, '#71899b'], [0.42, '#8b7e50'], [0.56, '#8b6136'], [0.72, '#6a4123'], [0.9, '#3f2614'], [1, '#2b190d']];
  const IRIS_HI = [[0, '#8fc4b4'], [0.1, '#6fa08a'], [0.25, '#6f9a5a'], [0.42, '#808b3e'], [0.56, '#84663a'], [0.72, '#6a4123'], [0.9, '#3f2614'], [1, '#2b190d']];

  function skinColor(S, mc1rLoss) {
    let c = ramp(SKIN, S);
    c = mix(c, '#f2b9ae', 0.2 * mc1rLoss * clamp(1 - S * 2.5, 0, 1));
    return c;
  }
  function hairColor(E, red) {
    const eu = ramp(EU_HAIR, E);
    const rd = ramp(RED_HAIR, E);
    return mix(eu, rd, clamp(red, 0, 1) * (red >= 0.5 ? 1 : 0.6));
  }
  function irisColor(M, L) {
    return mix(ramp(IRIS_LO, M), ramp(IRIS_HI, M), L);
  }

  // ------------------------------------------------------------- derived

  // Phenotype + look -> the colours and stages used by the renderer.
  function derive(p, look) {
    const age = look.age;
    const sun = look.sun || 0;
    const tan = sun * (1 - p.mc1rLoss) * 0.16 * (1 - p.skin);
    const S = clamp(p.skin + tan, 0, 1);
    const childLight = lerp(1.9, 1, smooth(2, 18, age));
    const E = Math.pow(p.hair, childLight);
    const grey = age < 18 ? 0 : smooth(p.greyOnset, p.greyOnset + 28, age);
    let hc = hairColor(E, p.redness);
    const hairBase = hc;
    hc = mix(hc, '#b9b7b3', Math.min(1, grey * 1.15));
    hc = mix(hc, '#efeeea', smooth(0.6, 1, grey));
    const male = p.sex === 'M';
    const balding = male ? clamp(p.baldRisk * smooth(17, 72, age) * 1.3, 0, 1) : 0;
    const thinning = male ? 0 : clamp(p.baldRisk * smooth(40, 90, age) * 0.35, 0, 1);
    const freckles = p.freckles * (0.55 + sun * 0.9) * (1 - smooth(0.25, 0.55, S)) * smooth(2, 7, age) * (1 - smooth(60, 90, age) * 0.4);
    const skin = skinColor(S, p.mc1rLoss);
    const browE = Math.min(1, E * 1.08 + 0.04);
    let brow = mix(hairColor(browE, p.redness), '#c9c7c2', grey * 0.6);
    let beard = mix(hairBase, '#b3592a', p.redness >= 0.1 && p.redness < 0.5 ? 0.35 : 0);
    beard = mix(beard, '#d9d7d2', Math.min(1, grey * 1.25));
    return {
      age, S, E, grey, skin, hair: hc, hairBase, brow, beard, balding, thinning, freckles,
      sunburn: sun * p.mc1rLoss,
      iris: irisColor(p.iris, p.lipo),
      irisInner: mix(irisColor(p.iris, p.lipo), p.iris > 0.3 && p.iris < 0.65 ? '#b8862e' : irisColor(p.iris, p.lipo), 0.55),
    };
  }

  // ------------------------------------------------------------- render

  let uid = 0;

  function render(p, look, opts = {}) {
    const id = 'pt' + (++uid) + '-';
    const rng = Genome.mulberry32(look.seed || 1);
    const d = derive(p, look);
    const age = look.age;
    const k = 1 - smooth(3, 16, age); // childness
    const e = smooth(38, 88, age); // ageing
    const male = p.sex === 'M' ? 1 : 0;
    const md = male * smooth(11, 18, age);
    const expr = look.expr || 'neutral';
    const smile = expr === 'smile' ? 1 : expr === 'grin' ? 1.25 : 0;
    const cx = 200;

    // ----- proportions
    const W = 83 + (p.faceW - 0.5) * 22 + md * 4 + k * 4;
    const Wt = W * (0.95 + k * 0.03);
    const yTop = 92 + k * 6;
    const yEye = 219 - k * 1;
    const yChin = 341 + (p.faceL - 0.5) * 26 + (p.chin - 0.5) * 8 + md * 8 - k * 33 + e * 3;
    const yBrow = yEye - 25 + md * 3;
    const yNose = yEye + (yChin - yEye) * (0.41 + (p.noseL - 0.5) * 0.08 - k * 0.03) + e * 2;
    const yMouth = yNose + (yChin - yNose) * (0.36 + k * 0.03);
    const J = W * (0.67 + p.jaw * 0.18 + md * 0.07 - k * 0.06) + e * 3;
    const yJaw = yMouth + 2 + md * 4 + e * 7;
    const chinW = 17 + p.chin * 7 + md * 7 - k * 3;
    const yHair = yTop + 46 + (p.fhd - 0.5) * 16 + k * 4;
    const ex = 38 + (p.eyeD - 0.5) * 8 - k * 2;
    const ew = 18 + (p.eyeS - 0.5) * 5 - md * 1 + k * 3;
    const eh = ew * (0.47 + (p.eyeS - 0.5) * 0.08 + k * 0.1 - e * 0.05 - md * 0.03);
    const tilt = (p.tilt - 0.5) * 9;
    const nk = 37 + md * 10 - k * 9;
    const yBase = yChin + 60 - k * 14;
    const sh = 142 + md * 30 - k * 40;
    const yShoulder = yBase + 14 - k * 4;

    const skin = d.skin;
    const skinShadow = darken(mix(skin, '#7a3b2a', 0.12), 0.16);
    const skinDeep = darken(skin, 0.38);
    const skinLight = lighten(skin, 0.12);

    // ----- face outline (right half, mirrored)
    const half = [
      [cx + Wt * 0.6, yTop + 9],
      [cx + Wt * 0.92, yTop + 44],
      [cx + Wt, yEye - 40],
      [cx + W, yEye + 8 + k * 10],
      [cx + W * 0.55 + J * 0.45 + 1, (yEye + 8) * 0.5 + yJaw * 0.5],
      [cx + J, yJaw],
      [cx + chinW + (J - chinW) * 0.42, yChin - 14 + e * 2],
      [cx + chinW, yChin - 4],
    ];
    const facePts = [[cx, yTop], ...half, [cx, yChin], ...mirrorX(half, cx).reverse()];
    const facePath = crPath(facePts, true);

    // ----- hair style & volume
    let style = look.style || 'short';
    const curl = p.curl;
    if ((style === 'bob' || style === 'long') && curl >= 0.72) style = 'afro';
    const thick = p.thick;
    const v = {
      crop: 3 + curl * 5,
      short: 7 + curl * 12 + thick * 3,
      bun: 3 + curl * 4,
      bob: 9 + curl * 16 + thick * 4,
      long: 9 + curl * 20 + thick * 4,
      afro: 30 + thick * 8 + (look.style === 'long' ? 14 : 0),
    }[style];
    const partDir = rng() < 0.5 ? -1 : 1;
    const recede = clamp(d.balding * 1.7, 0, 1);
    const crown = smooth(0.5, 1, d.balding);
    const fringe = style === 'bob' ? 1 : style === 'short' ? 0.45 * (1 - recede) : 0;
    const tex = textureFn(curl, rng);

    function hairlineY(u) {
      const au = Math.abs(u);
      let y = yHair + (yEye - 34 - yHair) * Math.pow(au, 2.6);
      if (p.widow) y += 9 * Math.max(0, 1 - au / 0.14) - 2.5 * Math.exp(-Math.pow((au - 0.28) / 0.12, 2));
      y -= recede * (30 * Math.exp(-Math.pow((au - 0.6) / 0.22, 2)) + 12 * (1 - au * 0.5));
      if (fringe > 0) {
        const s = u * partDir;
        const reach = style === 'bob' ? yBrow - 9 - yHair : 20;
        const yf = yHair - 3 + reach * fringe * smooth(-0.35, 0.95, s) * (1 - 0.35 * smooth(0.85, 1, au));
        y = Math.max(y, yf);
      }
      return y;
    }
    const hx = (u) => cx + u * (Wt - 7);
    const hairline = [];
    for (let i = 0; i <= 28; i++) {
      const u = 1 - (2 * i) / 28;
      hairline.push([hx(u), hairlineY(u)]);
    }

    // Outer silhouette, right half, from crown down.
    const outerTop = [
      [cx, yTop - v],
      [cx + Wt * 0.6 + v * 0.55, yTop + 9 - v * 0.83],
      [cx + Wt * 0.92 + v * 0.93, yTop + 44 - v * 0.35],
      [cx + Wt + v, yEye - 40],
    ];
    let outerR, innerR, afroCapR; // innerR runs from the bottom of the side back up to the temple
    if (style === 'crop' || style === 'short' || style === 'bun') {
      outerR = [...outerTop, [cx + Wt + v * 0.55 - 1, yEye - 18]];
      innerR = [
        [cx + W - 1, yEye - 12],
        [cx + W - 3, yEye + 8 + md * 10],
        [cx + W - 10, yEye - 3],
        [cx + Wt - 8, yEye - 32],
      ];
    } else if (style === 'bob') {
      outerR = [...outerTop, [cx + W + v * 0.8 + 6, yEye + 12], [cx + W + v * 0.6 + 8, yJaw], [cx + W * 0.92 + v * 0.5, yChin + 10]];
      innerR = [[cx + J + 12, yChin + 8], [cx + J + 4, yJaw - 4], [cx + W - 6, yEye + 12], [cx + Wt - 7, yEye - 30]];
    } else if (style === 'long') {
      outerR = [...outerTop, [cx + W + v * 0.7 + 6, yEye + 22], [cx + W + v * 0.5 + 12, yChin - 8], [cx + W + 18 + v * 0.3, yBase + 24], [cx + W + 12 + v * 0.2, 494]];
      innerR = [[cx + nk + 24, 490], [cx + nk + 13, yBase + 12], [cx + J + 9, yChin - 6], [cx + J + 3, yJaw - 6], [cx + W - 6, yEye + 12], [cx + Wt - 7, yEye - 30]];
    } else {
      // afro: a rounded cloud
      const acx = cx, acy = yEye - 30;
      const rx = W + v + 6, ryTop = acy - (yTop - v - 4);
      outerR = [];
      for (let i = 0; i <= 10; i++) {
        const th = -Math.PI / 2 + (i / 10) * (Math.PI / 2 + 0.6);
        outerR.push([acx + Math.cos(th) * rx, acy + Math.sin(th) * (th < 0 ? ryTop : ryTop * 0.62)]);
      }
      outerR.push([cx + W + 6, yNose + 4]);
      afroCapR = [...outerR.slice(0, -2), [cx + W + v * 0.45, yNose - 4]];
      innerR = [[cx + W + 1, yNose - 6], [cx + W - 5, yEye + 10], [cx + Wt - 7, yEye - 30]];
    }

    // Dense, textured silhouette (left bottom → crown → right bottom).
    const textured = (pts) => {
      const r = dense(pts, 3.5);
      return perturb([...mirrorX(r, cx).reverse(), ...r.slice(1)], (s) => tex(s));
    };
    const outerTex = textured(outerR);
    const capOuter = afroCapR ? textured(afroCapR) : outerTex;
    const capInnerR = dense(innerR, 4);
    const capInnerL = mirrorX(capInnerR, cx).reverse();
    const innerTex = curl >= 0.44 ? perturb(hairline, (s) => -Math.abs(tex(s)) * 0.35) : hairline;
    const capPts = [...capOuter, ...capInnerR, ...innerTex, ...capInnerL];
    const capPath = poly(capPts);
    const backPath = style === 'bob' || style === 'long' || style === 'afro' ? poly(backSilhouette()) : '';

    function backSilhouette() {
      // Whole silhouette with a bottom edge behind the neck.
      const pts = [...outerTex];
      const last = pts[pts.length - 1];
      const first = pts[0];
      if (style === 'long' && curl < 0.22) {
        // straight hair ends in uneven points
        const n = 14;
        const bottom = [];
        for (let i = 1; i < n; i++) {
          const x = lerp(last[0], first[0], i / n);
          bottom.push([x, last[1] - 6 + (i % 2 ? 7 : -3) + rng() * 4]);
        }
        return [...pts, ...bottom];
      }
      return [...pts, [last[0] - 10, last[1] + 2], [first[0] + 10, first[1] + 2]];
    }

    // ----- defs
    const defs = [];
    const bg = look.bg || '#c9cfd0';
    defs.push(`<radialGradient id="${id}bg" cx="45%" cy="38%" r="75%"><stop offset="0" stop-color="${lighten(bg, 0.28)}"/><stop offset="1" stop-color="${darken(bg, 0.12)}"/></radialGradient>`);
    defs.push(`<radialGradient id="${id}face" cx="43%" cy="40%" r="65%"><stop offset="0" stop-color="${lighten(skin, 0.05)}"/><stop offset="0.72" stop-color="${skin}"/><stop offset="1" stop-color="${darken(skin, 0.12)}"/></radialGradient>`);
    defs.push(`<linearGradient id="${id}neck" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${darken(skin, 0.24)}"/><stop offset="0.45" stop-color="${darken(skin, 0.08)}"/><stop offset="1" stop-color="${darken(skin, 0.04)}"/></linearGradient>`);
    const shirt = look.shirt || '#45606f';
    defs.push(`<linearGradient id="${id}shirt" x1="0" y1="0" x2="0.25" y2="1"><stop offset="0" stop-color="${lighten(shirt, 0.08)}"/><stop offset="1" stop-color="${darken(shirt, 0.22)}"/></linearGradient>`);
    defs.push(`<linearGradient id="${id}hair" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${lighten(d.hair, 0.06)}"/><stop offset="1" stop-color="${darken(d.hair, 0.18)}"/></linearGradient>`);
    defs.push(`<filter id="${id}b1" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.1"/></filter>`);
    defs.push(`<filter id="${id}b2" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter>`);
    defs.push(`<filter id="${id}b5" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>`);
    defs.push(`<filter id="${id}b9" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>`);
    defs.push(`<clipPath id="${id}fc"><path d="${facePath}"/></clipPath>`);
    if (capPath) defs.push(`<clipPath id="${id}cc"><path d="${capPath}"/></clipPath>`);
    if (backPath) defs.push(`<clipPath id="${id}bc"><path d="${backPath}"/></clipPath>`);
    // baldness mask: once the hairline has receded, the top thins and then
    // clears, leaving hair only at the sides (a front view of the horseshoe)
    if (crown > 0 || d.thinning > 0) {
      let region = '';
      if (crown > 0) {
        const pts = [[cx - Wt + 4, -20]];
        for (let i = 0; i <= 20; i++) {
          const u = -1 + (2 * i) / 20;
          pts.push([cx + u * (Wt - 4), hairlineY(u) - 2]);
        }
        pts.push([cx + Wt - 4, -20]);
        region = `<path d="${poly(pts)}" fill="#000" fill-opacity="${r1(smooth(0, 0.45, crown))}" filter="url(#${id}b5)"/>`;
      }
      defs.push(`<mask id="${id}bm" maskUnits="userSpaceOnUse" x="0" y="0" width="400" height="500"><rect width="400" height="500" fill="#fff"/>` + region +
        (d.thinning > 0 ? `<ellipse cx="${cx}" cy="${r1(yTop + 8)}" rx="${r1(Wt * 0.5)}" ry="34" fill="#000" fill-opacity="${r1(d.thinning)}" filter="url(#${id}b9)"/>` : '') +
        `</mask>`);
    }
    const hairMask = crown > 0 || d.thinning > 0 ? ` mask="url(#${id}bm)"` : '';

    // hair texture patterns
    const hairDark = darken(d.hair, 0.28);
    const hairHi = lighten(d.hair, d.E > 0.75 ? 0.2 : 0.22);
    if (curl >= 0.44) {
      const light = d.E < 0.4 || d.grey > 0.5;
      const op = light ? 0.32 : 0.55;
      const rot = Math.round(rng() * 40);
      if (curl < 0.72) {
        const sz = 12, rr = 4;
        defs.push(`<pattern id="${id}curl" width="${sz}" height="${sz}" patternUnits="userSpaceOnUse" patternTransform="rotate(${rot})">` +
          `<path d="M2,6a${rr},${rr} 0 1,1 ${rr * 2},0" fill="none" stroke="${hairDark}" stroke-width="1.3" stroke-opacity="${op}"/>` +
          `<path d="M7,12a${rr},${rr} 0 1,0 ${rr * 2},0" fill="none" stroke="${hairHi}" stroke-width="1.1" stroke-opacity="${op * 0.8}"/>` +
          `</pattern>`);
      } else {
        // tight coils: small offset loops on two scales so the texture does not read as a grid
        defs.push(`<pattern id="${id}curl" width="9" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(${rot})">` +
          `<circle cx="2.2" cy="2.4" r="1.7" fill="none" stroke="${hairDark}" stroke-width="0.9" stroke-opacity="${op}"/>` +
          `<circle cx="6.8" cy="6" r="1.5" fill="none" stroke="${hairDark}" stroke-width="0.8" stroke-opacity="${op * 0.8}"/>` +
          `<circle cx="6.4" cy="1.6" r="0.9" fill="${hairHi}" fill-opacity="${op * 0.5}"/>` +
          `<circle cx="2.4" cy="6.4" r="0.8" fill="${hairHi}" fill-opacity="${op * 0.4}"/>` +
          `</pattern>`);
      }
    }
    // stubble pattern
    {
      // irregular tile so stubble does not read as a grid
      const srng = Genome.mulberry32(911);
      let dots = '';
      for (let i = 0; i < 22; i++) dots += `<circle cx="${r1(srng() * 11)}" cy="${r1(srng() * 11)}" r="${r1(0.4 + srng() * 0.3)}"/>`;
      defs.push(`<pattern id="${id}stub" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(17)"><g fill="${darken(d.beard, 0.15)}">${dots}</g></pattern>`);
    }

    const out = [];
    const add = (s) => out.push(s);

    // ----- backdrop
    add(`<rect width="400" height="500" fill="url(#${id}bg)"/>`);

    // ----- back hair
    if (style === 'bun') {
      const br = 22 + thick * 6 + curl * 6;
      add(`<g${hairMask}><circle cx="${cx + partDir * 4}" cy="${r1(yTop - v - br * 0.55)}" r="${r1(br)}" fill="url(#${id}hair)"/>` +
        `<path d="M${cx - br * 0.7},${r1(yTop - v - br * 0.4)}q${r1(br * 0.7)},${r1(-br * 0.6)} ${r1(br * 1.4)},0" fill="none" stroke="${hairHi}" stroke-opacity="0.35" stroke-width="2"/></g>`);
    }
    if (backPath) {
      add(`<g${hairMask}><path d="${backPath}" fill="${darken(d.hair, 0.12)}"/>`);
      add(strands('back'));
      add(`</g>`);
    }

    // ----- neck, collar back, shirt
    const neckPts = [
      [cx - nk * 0.96, yJaw - 4],
      [cx - nk, yChin + 18],
      [cx - nk - 7, yBase + 6],
      [cx + nk + 7, yBase + 6],
      [cx + nk, yChin + 18],
      [cx + nk * 0.96, yJaw - 4],
    ];
    add(`<path d="M${cx - nk - 16},${r1(yBase - 4)}Q${cx},${r1(yBase - 20)} ${cx + nk + 16},${r1(yBase - 4)}L${cx + nk + 10},${r1(yBase + 20)}L${cx - nk - 10},${r1(yBase + 20)}Z" fill="${darken(shirt, 0.42)}"/>`);
    add(`<path d="${crPath(neckPts, false, 0.6)}Z" fill="url(#${id}neck)"/>`);
    // neck tendons and age lines
    add(`<path d="M${r1(cx - nk * 0.55)},${r1(yChin + 6)}Q${r1(cx - nk * 0.3)},${r1(yBase - 18)} ${r1(cx - 6)},${r1(yBase + 2)}M${r1(cx + nk * 0.55)},${r1(yChin + 6)}Q${r1(cx + nk * 0.3)},${r1(yBase - 18)} ${r1(cx + 6)},${r1(yBase + 2)}" fill="none" stroke="${skinShadow}" stroke-width="2.4" stroke-opacity="${r1(0.12 + e * 0.15)}" filter="url(#${id}b2)"/>`);
    if (e > 0.2) {
      add(`<path d="M${r1(cx - nk * 0.7)},${r1(yChin + 32)}q${r1(nk * 0.7)},6 ${r1(nk * 1.4)},0M${r1(cx - nk * 0.6)},${r1(yChin + 46)}q${r1(nk * 0.6)},5 ${r1(nk * 1.2)},0" fill="none" stroke="${skinShadow}" stroke-width="1.2" stroke-opacity="${r1(e * 0.4)}"/>`);
    }
    const shirtPath = `M${cx - nk - 17},${r1(yBase - 6)}C${cx - nk - 8},${r1(yBase + 10)} ${cx - 16},${r1(yBase + 16)} ${cx},${r1(yBase + 16)}C${cx + 16},${r1(yBase + 16)} ${cx + nk + 8},${r1(yBase + 10)} ${cx + nk + 17},${r1(yBase - 6)}` +
      `C${cx + nk + 60},${r1(yBase + 2)} ${cx + sh - 24},${r1(yShoulder)} ${cx + sh},${r1(yShoulder + 34)}L${cx + sh + 16},500L${cx - sh - 16},500L${cx - sh},${r1(yShoulder + 34)}` +
      `C${cx - sh + 24},${r1(yShoulder)} ${cx - nk - 60},${r1(yBase + 2)} ${cx - nk - 17},${r1(yBase - 6)}Z`;
    add(`<path d="${shirtPath}" fill="url(#${id}shirt)"/>`);
    add(`<path d="M${cx - nk - 17},${r1(yBase - 6)}C${cx - nk - 8},${r1(yBase + 10)} ${cx - 16},${r1(yBase + 16)} ${cx},${r1(yBase + 16)}C${cx + 16},${r1(yBase + 16)} ${cx + nk + 8},${r1(yBase + 10)} ${cx + nk + 17},${r1(yBase - 6)}" fill="none" stroke="${darken(shirt, 0.3)}" stroke-width="4" stroke-linecap="round"/>`);
    add(`<path d="M${r1(cx - sh * 0.62)},${r1(yShoulder + 6)}q${r1(-sh * 0.2)},40 ${r1(-sh * 0.16)},${r1(500 - yShoulder)}M${r1(cx + sh * 0.62)},${r1(yShoulder + 6)}q${r1(sh * 0.2)},40 ${r1(sh * 0.16)},${r1(500 - yShoulder)}" fill="none" stroke="${darken(shirt, 0.25)}" stroke-width="1.5" stroke-opacity="0.35"/>`);

    // ----- ears
    const showEars = style === 'crop' || style === 'short' || style === 'bun';
    if (showEars) add(ear(1) + ear(-1));

    function ear(s) {
      const es = 1 + (p.earS - 0.5) * 0.28 + e * 0.1 - k * 0.04;
      const ax = cx + s * (W - 3);
      const ay = (yEye + yNose) / 2 - 3;
      const lobeY = lerp(31, 21, p.lobe);
      const P = (x, y) => [ax + s * x * es, ay + y * es];
      const outline = [P(-1, -24), P(8, -31), P(16, -19), P(16.5, -2), P(12, 15), P(lerp(8, 4, p.lobe), lobeY - 3), P(lerp(3, 0, p.lobe), lobeY), P(-1, lobeY - lerp(8, 1, p.lobe)), P(-2, 8)];
      const inner = [P(3, -21), P(10, -20), P(11.5, -5), P(8, 9), P(4, 13)];
      return `<path d="${crPath(outline, true)}" fill="${darken(skin, 0.05)}"/>` +
        `<path d="${crPath(inner, false)}" fill="none" stroke="${skinShadow}" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.75"/>` +
        `<path d="${crPath([P(5, -12), P(8, -2), P(5, 6)], false)}" fill="none" stroke="${skinDeep}" stroke-width="2.2" stroke-opacity="0.45" stroke-linecap="round"/>`;
    }

    // ----- face
    add(`<path d="${facePath}" fill="url(#${id}face)"/>`);
    const fShade = [];
    // side shading (light from upper left), jaw and temple shadows
    fShade.push(`<path d="M${r1(cx + W + 6)},${r1(yTop + 30)}Q${r1(cx + W - 18)},${r1(yEye + 10)} ${r1(cx + J - 6)},${r1(yChin + 10)}L${cx + W + 30},${r1(yChin + 10)}Z" fill="${skinShadow}" fill-opacity="0.28" filter="url(#${id}b9)"/>`);
    fShade.push(`<ellipse cx="${cx}" cy="${r1(yChin + 6)}" rx="${r1(J * 0.9)}" ry="16" fill="${skinShadow}" fill-opacity="0.25" filter="url(#${id}b9)"/>`);
    // eye sockets
    for (const s of [-1, 1]) {
      fShade.push(`<ellipse cx="${r1(cx + s * (ex + 2))}" cy="${r1(yEye - 9)}" rx="${r1(ew * 1.05)}" ry="${r1(eh * 1.25)}" fill="${skinShadow}" fill-opacity="${r1(0.22 + e * 0.12 + md * 0.06)}" filter="url(#${id}b5)"/>`);
      fShade.push(`<ellipse cx="${r1(cx + s * (ex + 6))}" cy="${r1(yEye + 31 - smile * 5)}" rx="23" ry="15" fill="#e0606e" fill-opacity="${r1(clamp(0.14 * (1 - d.S * 0.75) + d.sunburn * 0.22 + smile * 0.04, 0, 0.45))}" filter="url(#${id}b9)"/>`);
      // cheekbone highlight
      fShade.push(`<ellipse cx="${r1(cx + s * (ex + 14))}" cy="${r1(yEye + 18 - smile * 4)}" rx="16" ry="7" fill="${skinLight}" fill-opacity="${r1(0.25 + d.S * 0.12)}" filter="url(#${id}b5)"/>`);
    }
    // forehead highlight
    fShade.push(`<ellipse cx="${cx - 8}" cy="${r1(yBrow - 26)}" rx="${r1(Wt * 0.42)}" ry="16" fill="${skinLight}" fill-opacity="${r1(0.25 + d.S * 0.15)}" filter="url(#${id}b9)"/>`);
    // nose bridge shadows
    const bridgeOp = 0.12 + p.bridge * 0.14 + md * 0.04 - k * 0.06;
    const nw = 15 + (p.noseW - 0.5) * 10 + md * 2.5 - k * 3 + e * 1.5;
    fShade.push(`<path d="M${cx + 8},${r1(yEye - 10)}Q${cx + 10 - p.bridge * 4},${r1(yNose - 22)} ${r1(cx + nw * 0.55)},${r1(yNose - 6)}" fill="none" stroke="${skinShadow}" stroke-width="5" stroke-opacity="${r1(bridgeOp + 0.08)}" filter="url(#${id}b2)"/>`);
    fShade.push(`<path d="M${cx - 8},${r1(yEye - 10)}Q${cx - 10 + p.bridge * 4},${r1(yNose - 22)} ${r1(cx - nw * 0.55)},${r1(yNose - 6)}" fill="none" stroke="${skinShadow}" stroke-width="4" stroke-opacity="${r1(bridgeOp * 0.6)}" filter="url(#${id}b2)"/>`);
    fShade.push(`<path d="M${cx - 1},${r1(yEye - 4)}L${cx - 1.5},${r1(yNose - 12)}" stroke="${skinLight}" stroke-width="${r1(5 - p.bridge * 2.5)}" stroke-opacity="${r1(0.25 + p.bridge * 0.25)}" stroke-linecap="round" filter="url(#${id}b2)"/>`);
    // under-nose and under-lip shadows
    fShade.push(`<ellipse cx="${cx + 2}" cy="${r1(yNose + 9)}" rx="${r1(nw * 0.8)}" ry="3.5" fill="${skinShadow}" fill-opacity="0.22" filter="url(#${id}b2)"/>`);
    // hairline shadow
    if (style !== 'crop' || curl > 0.3) {
      fShade.push(`<path d="${crPath(hairline.map(([x, y]) => [x, y + 4]), false)}" fill="none" stroke="${darken(skin, 0.3)}" stroke-width="7" stroke-opacity="${r1(0.22 * (1 - crown))}" filter="url(#${id}b5)"/>`);
    }
    add(`<g clip-path="url(#${id}fc)">${fShade.join('')}</g>`);

    // ----- freckles
    if (d.freckles > 0.05) {
      const n = Math.round(d.freckles * 110);
      const fc = darken(mix(skin, '#9a5a32', 0.55), 0.06);
      const frng = Genome.mulberry32((look.seed || 1) ^ 0x9e3779b9);
      let fs = '';
      const gauss = () => (frng() + frng() + frng() - 1.5) / 1.5;
      for (let i = 0; i < n; i++) {
        let x, y;
        const zone = frng();
        if (zone < 0.18) {
          x = cx + gauss() * 10;
          y = yNose - 18 + gauss() * 10;
        } else {
          const s = zone < 0.59 ? -1 : 1;
          x = cx + s * (ex + 4 + gauss() * 20);
          y = yEye + 24 + gauss() * 13;
        }
        fs += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(0.7 + frng() * 1.2)}" fill-opacity="${r1(0.25 + frng() * 0.35)}"/>`;
      }
      add(`<g fill="${fc}" clip-path="url(#${id}fc)">${fs}</g>`);
    }

    // ----- wrinkles & folds
    const lines = [];
    const wl = darken(skin, 0.25);
    const nasoOp = clamp(0.06 + e * 0.32 + smile * 0.12 - k * 0.1, 0, 0.6);
    for (const s of [-1, 1]) {
      lines.push(`<path d="M${r1(cx + s * (nw + 3))},${r1(yNose - 4)}Q${r1(cx + s * (nw + 13 + smile * 3))},${r1(yNose + 12)} ${r1(cx + s * (23 + smile * 5 + 6))},${r1(yMouth + 5 + e * 4)}" fill="none" stroke="${wl}" stroke-width="1.8" stroke-opacity="${r1(nasoOp)}" stroke-linecap="round" filter="url(#${id}b2)"/>`);
      if (e > 0.15) {
        const ox = cx + s * (ex + ew + 4);
        for (let i = -1; i <= 1; i++) {
          lines.push(`<path d="M${r1(ox)},${r1(yEye + i * 5)}l${r1(s * 9)},${r1(i * 4 - 1)}" stroke="${wl}" stroke-width="1" stroke-opacity="${r1(e * 0.5 + smile * 0.1)}" stroke-linecap="round"/>`);
        }
        lines.push(`<path d="M${r1(cx + s * (ex - ew * 0.7))},${r1(yEye + eh + 5)}Q${r1(cx + s * ex)},${r1(yEye + eh + 11)} ${r1(cx + s * (ex + ew * 0.8))},${r1(yEye + eh + 4)}" fill="none" stroke="${wl}" stroke-width="1.3" stroke-opacity="${r1(e * 0.45)}"/>`);
      }
      if (e > 0.4) {
        lines.push(`<path d="M${r1(cx + s * 27)},${r1(yMouth + 6)}q${r1(s * 2)},10 ${r1(s * 1)},${r1(18)}" fill="none" stroke="${wl}" stroke-width="1.3" stroke-opacity="${r1((e - 0.4) * 0.6)}" filter="url(#${id}b2)"/>`);
      }
    }
    if (e > 0.12) {
      for (let i = 0; i < 3; i++) {
        const y = yBrow - 13 - i * 8;
        if (y < yHair + 6) continue;
        lines.push(`<path d="M${r1(cx - Wt * 0.42)},${r1(y + 2)}Q${cx},${r1(y - 3)} ${r1(cx + Wt * 0.42)},${r1(y + 2)}" fill="none" stroke="${wl}" stroke-width="1.1" stroke-opacity="${r1(e * 0.32)}"/>`);
      }
    }
    add(`<g clip-path="url(#${id}fc)">${lines.join('')}</g>`);

    // ----- eyes
    for (const s of [-1, 1]) add(eye(s));

    function eye(s) {
      const ecx = cx + s * ex;
      const ecy = yEye;
      const tiltPx = Math.tan((tilt * Math.PI) / 180) * ew;
      const lid = p.lid;
      const up = eh * (1 - 0.2 * lid - e * 0.06) * (1 - smile * 0.1);
      const low = eh * 0.58 * (1 - smile * 0.35);
      const I = [ecx - s * ew, ecy + 1.5];
      const O = [ecx + s * ew, ecy - tiltPx];
      const uc1 = [I[0] + s * ew * 0.28, ecy - up * 1.25];
      const uc2 = [O[0] - s * ew * 0.42, ecy - up * 1.2 - tiltPx * 0.6];
      const lc2 = [O[0] - s * ew * 0.38, ecy + low * 1.05 - tiltPx * 0.3];
      const lc1 = [I[0] + s * ew * 0.32, ecy + low * 1.02];
      const shape = `M${r1(I[0])},${r1(I[1])}C${r1(uc1[0])},${r1(uc1[1])} ${r1(uc2[0])},${r1(uc2[1])} ${r1(O[0])},${r1(O[1])}C${r1(lc2[0])},${r1(lc2[1])} ${r1(lc1[0])},${r1(lc1[1])} ${r1(I[0])},${r1(I[1])}Z`;
      const upperLid = `M${r1(I[0])},${r1(I[1])}C${r1(uc1[0])},${r1(uc1[1])} ${r1(uc2[0])},${r1(uc2[1])} ${r1(O[0])},${r1(O[1])}`;
      const ri = Math.min(eh * 1.02, ew * 0.5);
      const icx = ecx + s * 0.6;
      const icy = ecy + 0.5 - tiltPx * 0.2;
      const clip = `${id}e${s > 0 ? 'r' : 'l'}`;
      const gid = `${id}ir${s > 0 ? 'r' : 'l'}`;
      const lashC = mix(darken(d.brow, 0.45), '#1b130f', 0.55);
      let g = `<defs><clipPath id="${clip}"><path d="${shape}"/></clipPath>` +
        `<radialGradient id="${gid}" cx="50%" cy="50%" r="50%"><stop offset="0.3" stop-color="${d.irisInner}"/><stop offset="0.55" stop-color="${d.iris}"/><stop offset="0.86" stop-color="${darken(d.iris, 0.12)}"/><stop offset="1" stop-color="${darken(d.iris, 0.55)}"/></radialGradient></defs>`;
      g += `<path d="${shape}" fill="#f4eee6"/>`;
      g += `<g clip-path="url(#${clip})">`;
      g += `<circle cx="${r1(icx)}" cy="${r1(icy)}" r="${r1(ri)}" fill="url(#${gid})"/>`;
      // iris fibres
      let fib = '';
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + 0.2;
        fib += `M${r1(icx + Math.cos(a) * ri * 0.42)},${r1(icy + Math.sin(a) * ri * 0.42)}L${r1(icx + Math.cos(a) * ri * 0.88)},${r1(icy + Math.sin(a) * ri * 0.88)}`;
      }
      g += `<path d="${fib}" stroke="${lighten(d.iris, 0.3)}" stroke-width="0.7" stroke-opacity="0.35"/>`;
      g += `<circle cx="${r1(icx)}" cy="${r1(icy)}" r="${r1(ri * (0.4 + k * 0.06))}" fill="#0f0b09"/>`;
      g += `<path d="${upperLid}" fill="none" stroke="#2a1a14" stroke-width="${r1(up * 0.9)}" stroke-opacity="0.22" filter="url(#${id}b2)"/>`;
      g += `<circle cx="${r1(icx - ri * 0.36)}" cy="${r1(icy - ri * 0.36)}" r="${r1(ri * 0.22)}" fill="#fff" fill-opacity="0.92"/>`;
      g += `<circle cx="${r1(icx + ri * 0.34)}" cy="${r1(icy + ri * 0.3)}" r="${r1(ri * 0.09)}" fill="#fff" fill-opacity="0.6"/>`;
      g += `</g>`;
      // lid lines
      g += `<path d="${upperLid}" fill="none" stroke="${lashC}" stroke-width="${r1(2.1 + (1 - male) * 0.6 + lid * 0.6)}" stroke-linecap="round"/>`;
      g += `<path d="M${r1(O[0])},${r1(O[1])}C${r1(lc2[0])},${r1(lc2[1])} ${r1(lc1[0])},${r1(lc1[1])} ${r1(I[0])},${r1(I[1])}" fill="none" stroke="${skinDeep}" stroke-width="1" stroke-opacity="0.45"/>`;
      // lashes
      const nLash = male ? 3 : 6;
      let lashes = '';
      for (let i = 0; i < nLash; i++) {
        const t = 0.45 + (i / (nLash - 1 || 1)) * 0.55;
        const mt = 1 - t;
        const px = mt * mt * mt * I[0] + 3 * mt * mt * t * uc1[0] + 3 * mt * t * t * uc2[0] + t * t * t * O[0];
        const py = mt * mt * mt * I[1] + 3 * mt * mt * t * uc1[1] + 3 * mt * t * t * uc2[1] + t * t * t * O[1];
        const len = (male ? 2.6 : 4.2) * (0.6 + t * 0.6);
        lashes += `M${r1(px)},${r1(py)}q${r1(s * len * 0.5)},${r1(-len * 0.6)} ${r1(s * len)},${r1(-len * 0.7)}`;
      }
      g += `<path d="${lashes}" fill="none" stroke="${lashC}" stroke-width="1.1" stroke-linecap="round"/>`;
      // crease (double lid) or epicanthic fold (monolid)
      const creaseOp = clamp(0.55 * (1 - lid * 1.4), 0, 0.55);
      if (creaseOp > 0.02) {
        const off = 5 + (1 - lid) * 2 + e * 2;
        g += `<path d="M${r1(I[0] + s * ew * 0.25)},${r1(ecy - up * 0.9 - off * 0.5)}C${r1(uc1[0] + s * 2)},${r1(uc1[1] - off)} ${r1(uc2[0])},${r1(uc2[1] - off)} ${r1(O[0] + s * 2)},${r1(O[1] - off * 0.55)}" fill="none" stroke="${skinShadow}" stroke-width="1.3" stroke-opacity="${r1(creaseOp)}"/>`;
      }
      if (lid > 0.45) {
        g += `<path d="M${r1(I[0] - s * 3)},${r1(I[1] - 4)}Q${r1(I[0] + s * 4)},${r1(I[1] - 2)} ${r1(I[0] + s * 3.5)},${r1(I[1] + 2.5)}" fill="none" stroke="${skinShadow}" stroke-width="1.1" stroke-opacity="${r1((lid - 0.45) * 0.9)}"/>`;
      }
      return g;
    }

    // ----- brows
    add(brow(1) + brow(-1));
    function brow(s) {
      const ecx = cx + s * ex;
      const arch = 2 + (1 - male) * 2.5 - md * 0.5;
      const P0 = [ecx - s * ew * 0.98, yBrow + 4];
      const P1 = [ecx + s * ew * 0.35, yBrow - 3 - arch];
      const P2 = [ecx + s * ew * 1.35, yBrow + 3 - tilt * 0.3];
      const T = (3 + p.brow * 6.5 + md * 1.2 - e * 1.2 - k * 1) * (1 + smile * 0.05);
      const top = [], bot = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const mt = 1 - t;
        const x = mt * mt * P0[0] + 2 * mt * t * P1[0] + t * t * P2[0];
        const y = mt * mt * P0[1] + 2 * mt * t * P1[1] + t * t * P2[1];
        const dx = 2 * mt * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]);
        const dy = 2 * mt * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]);
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * s, ny = dx / l * s;
        const w = T * (t < 0.25 ? lerp(0.9, 1.05, t / 0.25) : lerp(1.05, 0.28, (t - 0.25) / 0.75)) / 2;
        top.push([x - nx * w, y - ny * w]);
        bot.push([x + nx * w, y + ny * w]);
      }
      const path = crPath([...top, ...bot.reverse()], true);
      let hairs = '';
      for (let i = 0; i < 14; i++) {
        const t = i / 13;
        const pt = top[Math.round(t * 16)];
        const pb = bot[16 - Math.round(t * 16)];
        hairs += `M${r1(pb[0])},${r1(pb[1])}L${r1(pt[0] + s * 2.5)},${r1(pt[1] - 0.5)}`;
      }
      let g = `<path d="${path}" fill="${d.brow}" fill-opacity="0.88"/>` +
        `<path d="${hairs}" stroke="${darken(d.brow, 0.25)}" stroke-width="0.8" stroke-opacity="0.5"/>`;
      if (s === 1 && p.mono > 0.42) {
        g += `<ellipse cx="${cx}" cy="${r1(yBrow + 3)}" rx="${r1(ex - ew * 0.95 + 1)}" ry="${r1(T * 0.32)}" fill="${d.brow}" fill-opacity="${r1(clamp((p.mono - 0.42) * 1.5, 0, 0.6))}" filter="url(#${id}b2)"/>`;
      }
      return g;
    }

    // ----- nose
    {
      const tipY = yNose;
      const tipDrop = (p.tip - 0.5) * 4;
      let g = '';
      g += `<ellipse cx="${cx - 2}" cy="${r1(tipY - 6 + tipDrop)}" rx="${r1(5 + (1 - p.tip) * 3.5 + nw * 0.08)}" ry="${r1(4.5 + (1 - p.tip))}" fill="${skinLight}" fill-opacity="0.55" filter="url(#${id}b2)"/>`;
      for (const s of [-1, 1]) {
        const a0 = [cx + s * nw * 0.6, tipY - 10];
        const a1 = [cx + s * nw * 1.02, tipY - 6];
        const a2 = [cx + s * nw * 1.0, tipY + 3];
        const a3 = [cx + s * nw * 0.58, tipY + 4];
        g += `<path d="M${r1(a0[0])},${r1(a0[1])}C${r1(a1[0])},${r1(a1[1])} ${r1(a2[0])},${r1(a2[1])} ${r1(a3[0])},${r1(a3[1])}" fill="none" stroke="${skinShadow}" stroke-width="1.7" stroke-opacity="${s > 0 ? 0.7 : 0.5}" stroke-linecap="round"/>`;
        g += `<ellipse cx="${r1(cx + s * nw * 0.42)}" cy="${r1(tipY + 2.5)}" rx="${r1(3 + p.noseW * 1.8)}" ry="1.9" transform="rotate(${s * 18} ${r1(cx + s * nw * 0.42)} ${r1(tipY + 2.5)})" fill="${darken(skin, 0.55)}" fill-opacity="0.75"/>`;
      }
      g += `<path d="M${r1(cx - nw * 0.3)},${r1(tipY + 3.5)}Q${cx},${r1(tipY + 6.5 + tipDrop * 0.4)} ${r1(cx + nw * 0.3)},${r1(tipY + 3.5)}" fill="none" stroke="${skinShadow}" stroke-width="1.4" stroke-opacity="0.45"/>`;
      add(g);
    }

    // ----- mouth
    {
      const mw = 23 + (p.mouthW - 0.5) * 8 + md * 1 - k * 4 + smile * 3.5;
      const ul = Math.max(2.4, 5.6 + (p.lips - 0.5) * 5 - md * 0.8 - e * 1.6 - k * 0.6) * (1 - smile * 0.18);
      const ll = Math.max(3.2, 8 + (p.lips - 0.5) * 6 - md * 0.5 - e * 1.6 - k * 0.6) * (1 - smile * 0.12);
      const cy = yMouth;
      const cdy = smile ? -4.2 * smile : 0.6 + e * 1.8;
      const L = [cx - mw, cy + cdy];
      const R = [cx + mw, cy + cdy];
      const curve = smile * 3.2;
      const open = expr === 'grin' ? 6.5 : 0;
      const lip = darken(mix(skin, '#c4505a', 0.4 - d.S * 0.18), 0.05 + d.S * 0.22);
      const lipUp = darken(lip, 0.1);
      const lipLow = mix(lip, '#b8646c', d.S * 0.15);
      const midTop = `C${r1(cx - mw * 0.5)},${r1(cy + curve + 0.8)} ${r1(cx + mw * 0.5)},${r1(cy + curve + 0.8)} ${r1(R[0])},${r1(R[1])}`;
      const lineTop = `M${r1(L[0])},${r1(L[1])}${midTop}`;
      const lowY = cy + open;
      const lineLow = `M${r1(L[0])},${r1(L[1])}C${r1(cx - mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(cx + mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(R[0])},${r1(R[1])}`;
      const upper = `M${r1(L[0])},${r1(L[1])}C${r1(cx - mw * 0.55)},${r1(cy - ul * 0.55 + curve * 0.3)} ${r1(cx - mw * 0.25)},${r1(cy - ul * 1.12 + curve * 0.2)} ${r1(cx - 4.5)},${r1(cy - ul)}` +
        `Q${cx},${r1(cy - ul * 0.7)} ${r1(cx + 4.5)},${r1(cy - ul)}C${r1(cx + mw * 0.25)},${r1(cy - ul * 1.12 + curve * 0.2)} ${r1(cx + mw * 0.55)},${r1(cy - ul * 0.55 + curve * 0.3)} ${r1(R[0])},${r1(R[1])}` +
        `C${r1(cx + mw * 0.5)},${r1(cy + curve + 0.8)} ${r1(cx - mw * 0.5)},${r1(cy + curve + 0.8)} ${r1(L[0])},${r1(L[1])}Z`;
      const lower = `M${r1(L[0])},${r1(L[1])}C${r1(cx - mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(cx + mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(R[0])},${r1(R[1])}` +
        `C${r1(cx + mw * 0.62)},${r1(lowY + ll * 1.12 + curve * 0.5)} ${r1(cx - mw * 0.62)},${r1(lowY + ll * 1.12 + curve * 0.5)} ${r1(L[0])},${r1(L[1])}Z`;
      let g = '';
      // philtrum
      g += `<path d="M${cx - 4},${r1(yNose + 7)}L${cx - 4.6},${r1(cy - ul - 0.5)}M${cx + 4},${r1(yNose + 7)}L${cx + 4.6},${r1(cy - ul - 0.5)}" stroke="${skinShadow}" stroke-width="1.4" stroke-opacity="0.25" filter="url(#${id}b2)"/>`;
      if (open) {
        g += `<path d="${lineTop}${`C${r1(cx + mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(cx - mw * 0.5)},${r1(lowY + curve + 0.8)} ${r1(L[0])},${r1(L[1])}`}Z" fill="#3a1a18"/>`;
        g += `<path d="M${r1(cx - mw * 0.78)},${r1(cy + curve * 0.6)}C${r1(cx - mw * 0.4)},${r1(cy + curve + 1)} ${r1(cx + mw * 0.4)},${r1(cy + curve + 1)} ${r1(cx + mw * 0.78)},${r1(cy + curve * 0.6)}L${r1(cx + mw * 0.7)},${r1(cy + curve * 0.6 + open * 0.55)}C${r1(cx + mw * 0.3)},${r1(cy + curve + open * 0.75)} ${r1(cx - mw * 0.3)},${r1(cy + curve + open * 0.75)} ${r1(cx - mw * 0.7)},${r1(cy + curve * 0.6 + open * 0.55)}Z" fill="#f3eee6"/>`;
      }
      g += `<path d="${lower}" fill="${lipLow}"/>`;
      g += `<path d="${upper}" fill="${lipUp}"/>`;
      g += `<ellipse cx="${cx - 3}" cy="${r1(lowY + ll * 0.5 + curve * 0.4)}" rx="${r1(mw * 0.36)}" ry="${r1(ll * 0.22)}" fill="#fff" fill-opacity="0.16" filter="url(#${id}b2)"/>`;
      g += `<path d="${lineTop}" fill="none" stroke="${darken(lip, 0.45)}" stroke-width="1.4" stroke-linecap="round"/>`;
      if (open) g += `<path d="${lineLow}" fill="none" stroke="${darken(lip, 0.3)}" stroke-width="0.8"/>`;
      // shadow under lower lip
      g += `<ellipse cx="${cx}" cy="${r1(lowY + ll + 6)}" rx="${r1(mw * 0.55)}" ry="3" fill="${skinShadow}" fill-opacity="0.2" filter="url(#${id}b2)"/>`;
      // corners
      g += `<path d="M${r1(L[0] - 1.5)},${r1(L[1] - 1.5)}q-1,1.5 0.5,3M${r1(R[0] + 1.5)},${r1(R[1] - 1.5)}q1,1.5 -0.5,3" fill="none" stroke="${skinShadow}" stroke-width="1.1" stroke-opacity="0.45"/>`;
      // dimples
      if (p.dimples) {
        const op = smile ? 0.55 : 0.14;
        g += `<path d="M${r1(cx - mw - 9)},${r1(cy - 5)}q-2.5,4 0,8M${r1(cx + mw + 9)},${r1(cy - 5)}q2.5,4 0,8" fill="none" stroke="${skinShadow}" stroke-width="1.6" stroke-linecap="round" stroke-opacity="${op}" filter="url(#${id}b2)"/>`;
      }
      // cleft chin
      if (p.cleft) {
        g += `<path d="M${cx},${r1(yChin - 17)}q1.6,6 0,12" fill="none" stroke="${skinShadow}" stroke-width="2.4" stroke-opacity="0.45" stroke-linecap="round" filter="url(#${id}b2)"/>`;
      }
      add(g);
    }

    // ----- beard
    const growth = male && age >= 15 ? ({ clean: 0, stubble: 0.45, beard: 1 }[look.facial || 'clean'] || 0) * smooth(14, 22, age) : 0;
    if (growth > 0) add(beardLayer());

    function beardLayer() {
      const D = p.beard;
      const full = growth > 0.6;
      const vol = full ? 3 + 9 * D : 0;
      const mw = 23 + (p.mouthW - 0.5) * 8 + md + smile * 3.5;
      // outer edge follows the lower face, pushed out by beard volume
      const ol = [
        [cx + W - 2, yEye + 2],
        [cx + W - 1 + vol * 0.2, yEye + 26],
        [cx + J + vol * 0.6, yJaw + vol * 0.4],
        [cx + chinW + (J - chinW) * 0.42 + vol * 0.5, yChin - 12 + vol * 0.9],
        [cx + chinW * 0.6, yChin + vol * 1.15],
        [cx, yChin + vol * 1.2],
      ];
      const outerB = [...ol, ...mirrorX(ol, cx).reverse().slice(1)];
      // inner edge runs right → left so the outline does not cross itself
      const cheekTop = lerp(yMouth - 4, yNose - 2, clamp(D * 1.4 - 0.25, 0, 1));
      const innerCheek = [
        [cx + W - 7, yEye + 6],
        [cx + W - 14, cheekTop],
        [cx + mw + 11, yMouth - 3],
        [cx + mw * 0.55, yMouth + 12],
        [cx, yMouth + 13],
        [cx - mw * 0.55, yMouth + 12],
        [cx - mw - 11, yMouth - 3],
        [cx - W + 14, cheekTop],
        [cx - W + 7, yEye + 6],
      ];
      const cheekPath = crPath([...outerB.reverse(), ...innerCheek], true, 0.8);
      const lipBottom = yMouth + 8 + (p.lips - 0.5) * 6;
      const goatee = crPath([
        [cx - mw - 4, yMouth + 2], [cx - mw * 0.7, lipBottom + 5], [cx, lipBottom + 4], [cx + mw * 0.7, lipBottom + 5], [cx + mw + 4, yMouth + 2],
        [cx + mw * 0.9, yChin - 4 + vol], [cx, yChin + vol * 1.15], [cx - mw * 0.9, yChin - 4 + vol],
      ], true, 0.8);
      const ulh = 5.6 + (p.lips - 0.5) * 5;
      const stache = crPath([
        [cx - mw - 2, yMouth + 2], [cx - mw * 0.72, yNose + 12], [cx, yNose + 8], [cx + mw * 0.72, yNose + 12], [cx + mw + 2, yMouth + 2],
        [cx + mw * 0.55, yMouth - ulh * 0.8], [cx, yMouth - ulh - 1], [cx - mw * 0.55, yMouth - ulh * 0.8],
      ], true, 0.7);
      const gf = Math.min(1, growth / (full ? 1 : 0.45));
      const coreOp = clamp(0.35 + D * 0.8, 0, 1) * (full ? 0.95 : 0.42) * gf;
      const cheekOp = coreOp * smooth(0.32, 0.78, D);
      const col = d.beard;
      let g = '';
      if (full) {
        g += `<g fill="${col}"><path d="${cheekPath}" fill-opacity="${r1(cheekOp)}" filter="url(#${id}b1)"/><path d="${goatee}" fill-opacity="${r1(coreOp)}"/><path d="${stache}" fill-opacity="${r1(coreOp)}"/></g>`;
        g += `<defs><clipPath id="${id}bdg"><path d="${goatee}"/><path d="${stache}"/></clipPath><clipPath id="${id}bdc"><path d="${cheekPath}"/></clipPath></defs>` +
          `<g clip-path="url(#${id}bdg)" stroke="${darken(col, 0.3)}" stroke-width="0.8" stroke-opacity="${r1(0.45 * coreOp)}" fill="none">${beardStrokes()}</g>` +
          (cheekOp > 0.05 ? `<g clip-path="url(#${id}bdc)" stroke="${darken(col, 0.3)}" stroke-width="0.8" stroke-opacity="${r1(0.45 * cheekOp)}" fill="none">${beardStrokes()}</g>` : '');
      } else {
        // stubble: a soft shadow of hair colour plus fine dots, both feathered at the edges
        g += `<g fill="${col}" filter="url(#${id}b2)"><path d="${cheekPath}" fill-opacity="${r1((0.06 + 0.16 * D) * gf)}"/><path d="${goatee}" fill-opacity="${r1((0.12 + 0.16 * D) * gf)}"/><path d="${stache}" fill-opacity="${r1((0.14 + 0.16 * D) * gf)}"/></g>`;
        g += `<g fill="url(#${id}stub)"><path d="${cheekPath}" fill-opacity="${r1(Math.min(1, cheekOp * 1.6))}"/><path d="${goatee}" fill-opacity="${r1(coreOp)}"/><path d="${stache}" fill-opacity="${r1(coreOp)}"/></g>`;
      }
      return g;

      function beardStrokes() {
        // short curved hairs that flow down and outward from the face midline
        let s = '';
        const brng = Genome.mulberry32((look.seed || 3) + 77);
        for (let i = 0; i < 170; i++) {
          const t = brng() * 2 - 1;
          const x = cx + t * (J + vol * 0.5);
          const yTopB = lerp(yMouth + 8, yEye + 8, Math.pow(Math.abs(t), 1.4));
          const y = lerp(yTopB, yChin + vol * (1 - Math.abs(t) * 0.4), Math.sqrt(brng()));
          const a = Math.PI / 2 - t * 0.5 + (brng() - 0.5) * 0.9;
          const len = 2.5 + brng() * 3.5 + vol * 0.15;
          const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
          s += `M${r1(x)},${r1(y)}q${r1(dx * 0.5 + (brng() - 0.5) * 2)},${r1(dy * 0.5)} ${r1(dx)},${r1(dy)}`;
        }
        return `<path d="${s}"/>`;
      }
    }

    // ----- front hair (cap)
    if (style !== 'crop' || true) {
      add(`<g${hairMask}>`);
      add(`<path d="${capPath}" fill="url(#${id}hair)"/>`);
      add(strands('cap'));
      // sheen
      add(`<g clip-path="url(#${id}cc)"><path d="M${r1(cx - Wt * 0.55)},${r1(yTop + 24 - v * 0.5)}Q${r1(cx - Wt * 0.1)},${r1(yTop - v * 0.6)} ${r1(cx + Wt * 0.38)},${r1(yTop + 10 - v * 0.55)}" fill="none" stroke="${lighten(d.hair, 0.4)}" stroke-width="${r1(7 + v * 0.15)}" stroke-opacity="${r1((1 - curl) * 0.28 + 0.05)}" filter="url(#${id}b5)"/></g>`);
      add(`</g>`);
    }
    // bald scalp sheen
    if (crown > 0.2) {
      add(`<ellipse cx="${cx - 14}" cy="${r1(yTop + 22)}" rx="${r1(Wt * 0.32)}" ry="10" fill="#fff" fill-opacity="${r1(crown * 0.2)}" filter="url(#${id}b5)"/>`);
    }

    function strands(where) {
      const clip = where === 'cap' ? `${id}cc` : `${id}bc`;
      let sd = '', sl = '';
      const srng = Genome.mulberry32((look.seed || 5) + (where === 'cap' ? 11 : 23));
      if (curl >= 0.44) {
        return `<g clip-path="url(#${clip})"><rect x="0" y="0" width="400" height="500" fill="url(#${id}curl)"/>` +
          `<path d="${where === 'cap' ? capPath : backPath}" fill="none" stroke="${hairDark}" stroke-width="3" stroke-opacity="0.25" filter="url(#${id}b2)"/></g>`;
      }
      const wave = curl < 0.22 ? 0.6 : 3.2;
      if (where === 'cap') {
        const px = cx + partDir * -Wt * (style === 'long' || style === 'afro' ? 0 : 0.32);
        const py = yTop - v * 0.6 + 4;
        for (let i = 0; i < 46; i++) {
          const u = -1.15 + (i / 45) * 2.3 + (srng() - 0.5) * 0.04;
          const au = Math.min(1, Math.abs(u));
          const tx = cx + u * (Wt + (Math.abs(u) > 1 ? v : 0)) * 0.98;
          const ty = Math.abs(u) > 1 ? yEye - 20 : hairlineY(Math.max(-1, Math.min(1, u))) - 1;
          const midx = lerp(px, tx, 0.5) + (tx - px) * 0.22;
          const midy = lerp(py, ty, 0.5) - 18 + au * 10;
          const pts = dense([[px + (srng() - 0.5) * 8, py], [midx, midy], [tx, ty]], 6);
          const wp = perturb(pts, (s) => Math.sin(s / 9 + i) * wave);
          const path = 'M' + wp.map((q) => r1(q[0]) + ',' + r1(q[1])).join('L');
          if (i % 3 === 0) sl += path;
          else sd += path;
        }
      } else {
        const bot = style === 'bob' ? yChin + 12 : 494;
        for (let i = 0; i < 40; i++) {
          const u = -1 + (i / 39) * 2;
          const x0 = cx + u * (Wt + v) * 0.7;
          const x1 = cx + u * (W + v + 22);
          const pts = dense([[x0, yTop - v + 10], [lerp(x0, x1, 0.6), yEye + 10], [x1, bot]], 6);
          const wp = perturb(pts, (s) => Math.sin(s / 12 + i * 0.7) * wave * 1.4);
          const path = 'M' + wp.map((q) => r1(q[0]) + ',' + r1(q[1])).join('L');
          if (i % 3 === 0) sl += path;
          else sd += path;
        }
      }
      let g = `<g clip-path="url(#${clip})" fill="none" stroke-linecap="round">`;
      g += `<path d="${sd}" stroke="${hairDark}" stroke-width="1.2" stroke-opacity="0.35"/>`;
      g += `<path d="${sl}" stroke="${hairHi}" stroke-width="1" stroke-opacity="0.28"/>`;
      if (d.grey > 0.12 && d.grey < 0.9) g += `<path d="${sl}" stroke="#f4f3f0" stroke-width="0.9" stroke-opacity="${r1(d.grey * 0.6)}" transform="translate(2,1)"/>`;
      g += `</g>`;
      return g;
    }

    const size = opts.size ? ` width="${opts.size}" height="${Math.round(opts.size * 1.25)}"` : '';
    const label = opts.label ? `<title>${opts.label}</title>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"${size} role="img">${label}<defs>${defs.join('')}</defs>${out.join('')}</svg>`;
  }

  return { render, derive, skinColor, hairColor, irisColor, mix, darken, lighten };
});
