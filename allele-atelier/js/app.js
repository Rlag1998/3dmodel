/*
 * Allele Atelier — app state and UI.
 */
(function () {
  'use strict';

  const G = window.Genome;
  const P = window.Portrait;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => Math.round(x * 100) + '%';

  const STORE_KEY = 'allele-atelier-v1';
  const NAMES = {
    F: ['Ada', 'Amara', 'Ines', 'Mei', 'Leila', 'Freya', 'Priya', 'Sofia', 'Yara', 'Noor', 'Zuri', 'Hana', 'Elena', 'Aiyana', 'Ingrid', 'Chiara',
      'Nia', 'Rosa', 'Aiko', 'Maya', 'Saoirse', 'Lucia', 'Imani', 'Nadia', 'Ayla', 'Tova', 'Esi', 'Kalani', 'Mira', 'Astrid', 'Linnea', 'Paloma',
      'Rania', 'Thandi', 'Vera', 'Wren', 'Xochitl', 'Yasmin', 'Zofia', 'Ama', 'Beatriz', 'Carys', 'Dalia', 'Farah', 'Greta', 'Ilse', 'Kiri', 'Lior'],
    M: ['Kofi', 'Mateo', 'Liam', 'Arjun', 'Kenji', 'Omar', 'Finn', 'Tariq', 'Diego', 'Malik', 'Lars', 'Ravi', 'Hiro', 'Emeka', 'Nikolai', 'Tomas',
      'Wei', 'Idris', 'Rhys', 'Kai', 'Felix', 'Amir', 'Jonas', 'Sami', 'Theo', 'Bao', 'Rafael', 'Oisin', 'Tane', 'Elias', 'Anders', 'Bilal',
      'Cyrus', 'Dmitri', 'Eamon', 'Gael', 'Hamid', 'Ivo', 'Jomo', 'Kwame', 'Luca', 'Milan', 'Nnamdi', 'Oren', 'Pavel', 'Rohan', 'Soren', 'Tenzin', 'Yusuf'],
  };
  const SHIRTS = ['#3f5f6f', '#7a3e48', '#3f6b4f', '#6b5a3e', '#4b4370', '#2f4858', '#8a6a3a', '#5b6b75', '#6e4a62', '#3d3d45', '#9a5b45', '#486a6a'];
  const BGS = ['#c7cfd0', '#d4c8b6', '#b9c7c6', '#cbbfcd', '#c9ccb8', '#bfc6d4', '#d3c1b8', '#b8c4b4'];
  const STYLES = { crop: 'Cropped', short: 'Short', bob: 'Chin length', long: 'Long', bun: 'Tied up' };
  const FACIAL = { clean: 'Clean-shaven', stubble: 'Stubble', beard: 'Full beard' };
  const EXPR = { neutral: 'Neutral', smile: 'Smile', grin: 'Grin' };
  const SEX_MARK = { F: '○', M: '□' };

  // ------------------------------------------------------------ randomness

  function freshSeed() {
    try {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0];
    } catch (e) {
      return (Math.random() * 4294967296) >>> 0;
    }
  }
  let rand = G.mulberry32(freshSeed());
  const seed = () => (rand() * 4294967296) >>> 0;
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  // ----------------------------------------------------------------- state

  let state = null;
  let snapshot = null;
  const phenoCache = new Map();
  let outlookCache = { key: '', val: null };

  function freshState() {
    return { v: 1, people: {}, founders: {}, motherId: null, fatherId: null, kids: [], history: [], selected: null, gen: 1, mu: 0.0025, kidAge: 27, pools: { F: 'mosaic', M: 'mosaic' }, hue: 0, seq: 1, tab: 'traits', born: [] };
  }

  function makeLook(sex, age, s) {
    const r = G.mulberry32(s);
    const style = sex === 'F' ? pick(r, ['long', 'long', 'bob', 'bob', 'bun', 'short']) : pick(r, ['short', 'short', 'short', 'crop', 'crop', 'crop', 'bob', 'long']);
    return {
      age,
      expr: pick(r, ['neutral', 'smile', 'neutral', 'smile', 'grin']),
      style,
      facial: sex === 'M' ? pick(r, ['clean', 'clean', 'stubble', 'beard']) : 'clean',
      sun: Math.round((0.15 + r() * 0.35) * 100) / 100,
      shirt: pick(r, SHIRTS),
      bg: pick(r, BGS),
      seed: s,
    };
  }

  function pickName(sex) {
    const used = new Set(Object.values(state.people).map((p) => p.name));
    const pool = NAMES[sex].filter((n) => !used.has(n));
    return pick(rand, pool.length ? pool : NAMES[sex]);
  }

  function makeFounder(sex, pool, genome) {
    const id = 'p' + state.seq++;
    const hue = state.hue++ % 8;
    const g = genome || G.founderGenome(sex, pool, id, G.mulberry32(seed()));
    if (genome) relabelOrigins(g, id);
    const person = { id, name: pickName(sex), sex, genome: g, founder: true, pool, hue, gen: state.gen, look: makeLook(sex, 31 + Math.floor(rand() * 14), seed()), edited: false };
    state.people[id] = person;
    state.founders[id] = { name: person.name, hue };
    return person;
  }

  function relabelOrigins(g, id) {
    for (const k in g) g[k].forEach((h, i) => { h.segs = [[0, h.segs.length ? h.segs[h.segs.length - 1][1] : 1, id + '.' + i]]; });
  }

  function makeChild(m, f, genome, lookFrom) {
    const g = genome || G.conceive(m.genome, f.genome, G.mulberry32(seed()), state.mu, false);
    const sex = G.sexOf(g);
    const id = 'p' + state.seq++;
    const look = lookFrom ? Object.assign({}, lookFrom, { shirt: pick(rand, SHIRTS) }) : makeLook(sex, state.kidAge, seed());
    look.age = state.kidAge;
    const mutations = [];
    for (const k in g) g[k].forEach((h) => { for (const L in h.mut) if (h.mut[L] === 'de novo') mutations.push(L); });
    const person = { id, name: pickName(sex), sex, genome: g, founder: false, motherId: m.id, fatherId: f.id, gen: state.gen + 1, look, edited: false, mutations };
    state.people[id] = person;
    return person;
  }

  function pheno(person) {
    let c = phenoCache.get(person.id);
    if (!c) {
      c = G.phenotype(person.genome);
      phenoCache.set(person.id, c);
    }
    return c;
  }

  function prune() {
    const keep = new Set([state.motherId, state.fatherId, ...state.kids]);
    state.history = state.history.slice(0, 5);
    for (const h of state.history) {
      keep.add(h.motherId);
      keep.add(h.fatherId);
      h.kids.forEach((k) => keep.add(k));
    }
    for (const id in state.people) if (!keep.has(id)) { delete state.people[id]; phenoCache.delete(id); }
    if (!state.people[state.selected]) state.selected = state.motherId;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && s.v === 1 && s.people && s.people[s.motherId] && s.people[s.fatherId]) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function takeSnapshot() {
    snapshot = JSON.stringify(state);
  }

  // Opening family: two founders from different pools, one of their children
  // raised as a parent, and a second generation where segregation shows.
  function demo(demoSeed) {
    state = freshState();
    rand = G.mulberry32(demoSeed || 20261002);
    const m = makeFounder('F', 'neu');
    const f = makeFounder('M', 'waf');
    state.motherId = m.id;
    state.fatherId = f.id;
    let daughter = null;
    for (let i = 0; i < 3 || !daughter; i++) {
      const c = makeChild(m, f);
      state.kids.push(c.id);
      if (!daughter && c.sex === 'F') daughter = c;
      if (i > 8) break;
    }
    state.selected = daughter.id;
    promote(true);
    for (let i = 0; i < 4; i++) state.kids.push(makeChild(state.people[state.motherId], state.people[state.fatherId]).id);
    state.selected = state.kids[0];
    rand = G.mulberry32(freshSeed());
  }

  // ----------------------------------------------------------- genotype text

  function alleleSym(L, i) {
    return L.alleles[i].s;
  }
  function genoStr(genome, id) {
    const L = G.LOCUS[id];
    const [a, b] = G.genotype(genome, L);
    return alleleSym(L, a) + '/' + (b == null ? 'Y' : alleleSym(L, b));
  }
  function topDrivers(p, genome, key, n = 3) {
    const w = p.why[key] || {};
    return Object.entries(w)
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
      .slice(0, n)
      .map(([id]) => `<span class="gene">${esc(G.LOCUS[id].sym)}</span> ${esc(genoStr(genome, id))}`);
  }

  function originBg(o) {
    const [fid, h] = String(o).split('.');
    const f = state.founders[fid];
    const v = `var(--l${f ? f.hue : 0})`;
    return h === '0' ? v : `repeating-linear-gradient(135deg, ${v} 0 3px, color-mix(in srgb, ${v} 40%, var(--sheet)) 3px 6px)`;
  }
  function originLabel(o) {
    const [fid, h] = String(o).split('.');
    const f = state.founders[fid];
    return (f ? f.name : 'Unknown founder') + (h === '0' ? "'s maternal set" : "'s paternal set");
  }
  function originAt(hap, mb) {
    for (const s of hap.segs) if (mb >= s[0] && mb <= s[1]) return s[2];
    return hap.segs.length ? hap.segs[0][2] : '';
  }

  // ---------------------------------------------------------------- portraits

  function portraitSvg(person, opts) {
    return P.render(pheno(person), person.look, Object.assign({ label: person.name }, opts || {}));
  }

  function poolName(id) {
    const pl = G.POOLS.find((x) => x.id === id);
    return pl ? pl.name : id;
  }

  function relationText(person) {
    if (person.founder) return 'Founder · ' + poolName(person.pool);
    const m = state.people[person.motherId];
    const f = state.people[person.fatherId];
    const role = person.sex === 'F' ? 'Daughter' : 'Son';
    return `${role} of ${m ? esc(m.name) : 'a mother'} and ${f ? esc(f.name) : 'a father'}`;
  }

  function cardHtml(person, extra = '') {
    const sel = state.selected === person.id ? ' selected' : '';
    const born = state.born.includes(person.id) ? ' born' : '';
    const badges = (person.edited ? '<span class="badge">edited</span>' : '') + (person.mutations && person.mutations.length ? `<span class="badge" title="New mutations: ${esc(person.mutations.map((m) => G.LOCUS[m].sym).join(', '))}">✱ ${person.mutations.length}</span>` : '') + (person.twin ? '<span class="badge">twin</span>' : '');
    return `<article class="card${sel}${born}" data-id="${person.id}">
      <button class="frame" type="button" data-action="select" data-id="${person.id}" aria-label="Inspect ${esc(person.name)}" aria-pressed="${state.selected === person.id}"><span class="matte">${portraitSvg(person)}</span></button>
      <div class="placard"><span class="name">${esc(person.name)}${badges}</span>
      <span class="meta">${SEX_MARK[person.sex]} ${person.sex === 'F' ? 'XX' : 'XY'} · age ${person.look.age}</span></div>${extra}</article>`;
  }

  // ------------------------------------------------------------------ couple

  function renderCouple() {
    const m = state.people[state.motherId];
    const f = state.people[state.fatherId];
    const tools = (person) => {
      const sex = person.sex;
      const opts = G.POOLS.map((pl) => `<option value="${pl.id}"${state.pools[sex] === pl.id ? ' selected' : ''}>${esc(pl.name)}</option>`).join('');
      const where = person.founder ? poolName(person.pool) : `Born in generation ${person.gen - 1}'s family`;
      return `<p class="meta muted" style="margin:0;font-size:.78rem">${where}</p><div class="founder-tools">
        <select id="pool-${sex}" data-sex="${sex}" aria-label="Gene pool for a new ${sex === 'F' ? 'mother' : 'father'}">${opts}</select>
        <button class="btn small" type="button" data-action="reroll" data-sex="${sex}">New ${sex === 'F' ? 'mother' : 'father'}</button></div>`;
    };
    $('#couple').innerHTML =
      cardHtml(m, tools(m)) +
      `<div class="union" aria-hidden="true">
        <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="10" cy="16" r="7"/><rect x="31" y="9" width="14" height="14"/><path d="M17 16h14M24 16v20M14 36h20"/></svg>
        <span class="gen">Generation ${state.gen}</span><span class="eyebrow">Mating line</span></div>` +
      cardHtml(f, tools(f));
  }

  // ----------------------------------------------------------------- outlook

  function computeOutlook(m, f) {
    const key = G.encode(m.genome) + '|' + G.encode(f.genome);
    if (outlookCache.key === key) return outlookCache.val;
    const r = G.mulberry32(G.hashString(key));
    const N = 1000;
    const eye = {}, hair = {}, curl = {};
    const skin = new Array(12).fill(0);
    let blue = 0, red = 0, dimples = 0, cleft = 0, widow = 0, freck = 0, boys = 0;
    for (let i = 0; i < N; i++) {
      const g = G.conceive(m.genome, f.genome, r, 0, true);
      const p = G.phenotype(g);
      const eg = G.eyeGroup(p.iris, p.lipo);
      eye[eg] = (eye[eg] || 0) + 1;
      const hg = G.hairGroup(p.hair, p.redness);
      hair[hg] = (hair[hg] || 0) + 1;
      const cg = G.curlName(p.curl);
      curl[cg] = (curl[cg] || 0) + 1;
      skin[Math.min(11, Math.floor(p.skin * 12))]++;
      if (eg === 'Blue') blue++;
      if (p.redness >= 0.5) red++;
      if (p.dimples) dimples++;
      if (p.cleft) cleft++;
      if (p.widow) widow++;
      if (p.freckles > 0.3) freck++;
      if (p.sex === 'M') boys++;
    }
    const val = { N, eye, hair, curl, skin, blue, red, dimples, cleft, widow, freck, boys };
    outlookCache = { key, val };
    return val;
  }

  function stackRow(title, counts, order, colors, N) {
    const parts = order.filter((k) => counts[k]);
    const bar = parts.map((k) => `<span style="flex:${counts[k]};background:${colors[k]}" title="${esc(k)}: ${pct(counts[k] / N)}"></span>`).join('');
    const legend = parts.map((k) => `<span><i style="background:${colors[k]}"></i>${esc(k)} <b>${pct(counts[k] / N)}</b></span>`).join('');
    return `<div class="odd"><h4>${title}</h4><div class="stack" role="img" aria-label="${esc(title)}">${bar}</div><div class="legend">${legend}</div></div>`;
  }

  function renderOutlook() {
    const m = state.people[state.motherId];
    const f = state.people[state.fatherId];
    const o = computeOutlook(m, f);
    const eyeC = { Blue: P.irisColor(0.08, 0), Green: P.irisColor(0.2, 1), Hazel: P.irisColor(0.42, 0.3), Brown: P.irisColor(0.68, 0), 'Dark brown': P.irisColor(0.93, 0) };
    const hairC = { Blond: P.hairColor(0.22, 0), Red: P.hairColor(0.45, 1), Brown: P.hairColor(0.58, 0), Black: P.hairColor(0.93, 0) };
    const hairLabels = { Blond: 'Blond', Red: 'Red', Brown: 'Brown', Black: 'Black' };
    const curlC = { Straight: 'color-mix(in srgb, var(--stain) 25%, var(--sheet))', Wavy: 'color-mix(in srgb, var(--stain) 50%, var(--sheet))', Curly: 'color-mix(in srgb, var(--stain) 75%, var(--sheet))', Coily: 'var(--stain)' };
    const maxBin = Math.max(...o.skin);
    const hist = o.skin.map((c, i) => `<span style="height:${Math.max(2, (c / maxBin) * 100)}%;background:${P.skinColor((i + 0.5) / 12, 0)}" title="${pct(c / o.N)} of children"></span>`).join('');
    const hairCounts = {};
    for (const k in o.hair) hairCounts[hairLabels[k]] = o.hair[k];
    $('#outlook').innerHTML = `
      <div class="outlook-head"><div><p class="eyebrow">Before they are born</p><h2 class="panel-title">Odds for the next child</h2></div>
      <span class="mono muted">${o.N.toLocaleString()} simulated conceptions</span></div>
      <div class="odds">
        ${stackRow('Eye colour', o.eye, ['Blue', 'Green', 'Hazel', 'Brown', 'Dark brown'], eyeC, o.N)}
        ${stackRow('Hair colour', hairCounts, ['Blond', 'Red', 'Brown', 'Black'], hairC, o.N)}
        ${stackRow('Hair texture', o.curl, ['Straight', 'Wavy', 'Curly', 'Coily'], curlC, o.N)}
        <div class="odd"><h4>Skin tone spread</h4><div class="hist" role="img" aria-label="Distribution of skin melanin among simulated children">${hist}</div><div class="hist-axis"><span>Less melanin</span><span>More melanin</span></div></div>
      </div>
      <div class="facts">
        <span>Blue eyes <b>${pct(o.blue / o.N)}</b></span>
        <span>Red hair <b>${pct(o.red / o.N)}</b></span>
        <span>Freckles <b>${pct(o.freck / o.N)}</b></span>
        <span>Dimples <b>${pct(o.dimples / o.N)}</b></span>
        <span>Cleft chin <b>${pct(o.cleft / o.N)}</b></span>
        <span>Widow's peak <b>${pct(o.widow / o.N)}</b></span>
        <span>Sons <b>${pct(o.boys / o.N)}</b></span>
      </div>`;
  }

  // ---------------------------------------------------------------- children

  function renderKids() {
    const kids = state.kids.map((id) => state.people[id]).filter(Boolean);
    $('#kids-title').textContent = kids.length ? `${kids.length} ${kids.length === 1 ? 'child' : 'children'}` : 'Children';
    $('#kids').innerHTML = kids.length
      ? kids.map((k) => cardHtml(k)).join('')
      : `<p class="empty" style="grid-column:1/-1">No children yet. Each conception runs meiosis in both parents, so every child is a new draw.</p>`;
  }

  function renderLineage() {
    const el = $('#lineage');
    if (!state.history.length) { el.innerHTML = ''; return; }
    const thumb = (id) => {
      const p = state.people[id];
      if (!p) return '';
      return `<button class="ancestor" type="button" data-action="select" data-id="${id}"><span>${P.render(pheno(p), Object.assign({}, p.look, { expr: p.look.expr }), {})}</span><span>${esc(p.name)}<small>${SEX_MARK[p.sex]} gen ${p.gen}</small></span></button>`;
    };
    el.innerHTML = `<div><p class="eyebrow">Pedigree</p><h2 class="panel-title">Earlier generations</h2></div>` +
      state.history.map((h) => `<div class="lineage-row">${thumb(h.motherId)}${thumb(h.fatherId)}${h.kids.filter((k) => k !== state.motherId && k !== state.fatherId).map(thumb).join('')}</div>`).join('');
  }

  // --------------------------------------------------------------- specimen

  function freckName(v) {
    if (v < 0.12) return 'None';
    if (v < 0.3) return 'A few';
    if (v < 0.55) return 'Moderate';
    return 'Many';
  }
  function level(v, words) {
    return words[Math.min(words.length - 1, Math.floor(v * words.length))];
  }

  function traitsHtml(person) {
    const p = pheno(person);
    const g = person.genome;
    const d = P.derive(p, person.look);
    const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
    const gt = (id) => `<span class="gene">${esc(G.LOCUS[id].sym)}</span> ${esc(genoStr(g, id))}`;
    const male = person.sex === 'M';
    const join = (arr) => arr.filter(Boolean).join(' · ');
    let hairNote = G.hairName(d.E, p.redness);
    if (person.look.age < 16 && d.E < p.hair - 0.05) hairNote += ' (will darken with age)';
    if (d.grey > 0.12) hairNote += `, ${pct(d.grey)} grey`;
    let bald;
    if (male) {
      const risk = p.baldRisk < 0.3 ? 'Low' : p.baldRisk < 0.5 ? 'Moderate' : 'High';
      bald = `${risk} genetic risk` + (d.balding > 0.08 ? `; ${d.balding > 0.6 ? 'mostly bald' : 'receding'} at ${person.look.age}` : '');
    } else {
      bald = 'Low (androgen-driven loss mostly affects men)';
    }
    const lid = p.lid < 0.2 ? 'Double lid (visible crease)' : p.lid < 0.45 ? 'Partly hooded crease' : 'Monolid with inner fold';
    const lobe = p.lobe < 0.4 ? 'Free' : p.lobe < 0.65 ? 'Partly attached' : 'Attached';
    const folk = [p.dimples ? 'Dimples' : 'No dimples', p.cleft ? 'cleft chin' : 'smooth chin', p.widow ? "widow's peak" : 'straight hairline'].join(', ');
    const rows = [
      ['Eye colour', sw(d.iris) + G.eyeName(p.iris, p.lipo), join([gt('HERC2'), gt('OCA2e'), p.lipo >= 0.5 ? gt('GEY') : '', ...topDrivers(p, g, 'eye', 1)])],
      ['Hair colour', sw(d.hair) + esc(hairNote), join([gt('MC1R'), ...topDrivers(p, g, 'hair', 2)])],
      ['Hair texture', G.curlName(p.curl) + (p.thick > 0.75 ? ', thick strands' : ''), join(topDrivers(p, g, 'curl', 3))],
      ['Skin', sw(d.skin) + G.skinName(d.S) + ` · Fitzpatrick type ${G.fitzpatrick(d.S, p.mc1rLoss)}`, join(topDrivers(p, g, 'skin', 3))],
      ['Freckles', freckName(p.freckles), join([gt('MC1R'), gt('IRF4'), gt('BNC2')])],
      ['Greying', `Starts around age ${Math.round(p.greyOnset)}`, join([gt('IRF4'), gt('GRY1'), gt('GRY2')])],
      ['Hair loss', bald, join([gt('AR') + (male ? ' (from mother)' : ''), gt('BALD20')])],
      ['Beard', male ? level(p.beard, ['Sparse', 'Patchy', 'Medium', 'Dense', 'Very dense']) : `Not expressed (${level(p.beard, ['sparse', 'patchy', 'medium', 'dense', 'very dense'])} potential)`, join([gt('EDAR'), gt('BRD1'), gt('BRD2')])],
      ['Eyebrows', level(p.brow, ['Fine', 'Light', 'Medium', 'Full', 'Bold']) + (p.mono > 0.42 ? ', joined' : ''), join([gt('FOXL2'), gt('BRW1'), gt('PAX3')])],
      ['Eyelids', lid, join([gt('LID1'), gt('LID2')])],
      ['Nose', `${level(p.noseW, ['Narrow', 'Slim', 'Medium', 'Broad', 'Wide'])}, ${p.bridge > 0.55 ? 'high' : p.bridge < 0.4 ? 'low' : 'medium'} bridge, ${p.tip > 0.55 ? 'pointed' : p.tip < 0.42 ? 'rounded' : 'soft'} tip`, join([gt('GLI3'), gt('PAX1'), gt('RUNX2'), gt('DCHS2')])],
      ['Lips', level(p.lips, ['Thin', 'Slim', 'Medium', 'Full', 'Very full']), join([gt('LIP1'), gt('LIP2')])],
      ['Earlobes', lobe, join([gt('ADGRG6'), gt('EDAR')])],
      ['Classroom traits', folk, join([gt('DIMP'), gt('CLEFT'), gt('WIDOW')])],
    ];
    const hidden = p.hidden.length
      ? `<div class="hidden-note"><strong>Hidden in the genotype</strong>${p.hidden.map((h) => `<span>${esc(h.text)} (<span class="gene">${esc(G.LOCUS[h.locus].sym)}</span>)</span>`).join('')}</div>`
      : '';
    const muts = person.mutations && person.mutations.length
      ? `<div class="hidden-note"><strong>New mutations</strong><span>Arose in a parent's egg or sperm at ${person.mutations.map((m) => `<span class="gene">${esc(G.LOCUS[m].sym)}</span>`).join(', ')}.</span></div>`
      : '';
    return `<table class="traits"><tbody>${rows.map(([k, v, b]) => `<tr><th scope="row">${k}</th><td>${v}<span class="basis">${b}</span></td></tr>`).join('')}</tbody></table>${hidden}${muts}`;
  }

  function genesHtml(person) {
    const g = person.genome;
    const male = person.sex === 'M';
    let html = `<p class="muted" style="margin:0;font-size:.8125rem">Left allele from the mother, right from the father. Click an allele to edit it. The coloured edge shows which founder chromosome it traces back to.</p>`;
    for (const cat of G.CATS) {
      const loci = G.LOCI.filter((L) => L.cat === cat.id);
      html += `<details class="gene-group" open><summary><h3>${cat.name} · ${loci.length}</h3></summary>`;
      for (const L of loci) {
        const pair = L.chr === 'X' ? g.sex : g[L.chr];
        const chips = [0, 1].map((w) => {
          const h = pair[w];
          if (h.kind === 'Y') return `<span class="chip y" title="Males carry a Y here, not a second X">Y</span>`;
          const a = h.a[L.id];
          const al = L.alleles[a];
          const mark = h.mut[L.id] === 'edit' ? '<sup>✎</sup>' : h.mut[L.id] === 'de novo' ? '<sup>✱</sup>' : '';
          const o = originAt(h, L.mb);
          return `<button type="button" class="chip" style="--lc:${originBg(o)}" data-action="allele" data-locus="${L.id}" data-which="${w}" title="${esc(al.n)} · ${esc(originLabel(o))}" aria-label="${esc(L.sym)} ${w ? 'paternal' : 'maternal'} allele ${esc(al.s)}, ${esc(al.n)}. Click to change">${esc(al.s)}${mark}</button>`;
        }).join('');
        html += `<div class="gene-row"><div class="g-name"><span class="sym">${esc(L.sym)}</span>${L.mapped ? '' : '<span class="unmapped">unmapped</span>'}
          <div class="g-sub">chr${L.chr} · ${L.mb} Mb · ${esc(L.variant)}</div></div>
          <div class="chips">${chips}</div>
          <details><summary>About this locus</summary><p>${esc(L.note)}</p><p class="mono">${L.alleles.map((a) => `${esc(a.s)} = ${esc(a.n)}`).join(' · ')}</p></details></div>`;
      }
      html += `</details>`;
    }
    if (male) html += `<p class="muted" style="margin:0;font-size:.8125rem">X-linked loci show a single allele: a son's X always comes from his mother.</p>`;
    return html;
  }

  function chromosomesHtml(person) {
    const g = person.genome;
    const maxMb = 248;
    const origins = new Set();
    const bar = (h, len) => {
      const spans = h.segs.map(([s, e, o]) => {
        origins.add(o);
        return `<span style="left:${((s / len) * 100).toFixed(2)}%;width:${(((e - s) / len) * 100).toFixed(2)}%;background:${originBg(o)}" title="${esc(originLabel(o))}"></span>`;
      }).join('');
      return `<div class="bar" style="width:${((len / maxMb) * 100).toFixed(1)}%">${spans}</div>`;
    };
    const ticks = (chrId, len) => (G.LOCI_BY_CHR[chrId] || []).map((L) => `<span class="tick" style="left:${((L.mb / maxMb) * 100).toFixed(2)}%" title="${esc(L.sym)} · ${L.mb} Mb"></span>`).join('');
    let rows = G.CHROMOSOMES.map((c) => `<div class="chr"><span class="cid">${c.id}</span><div class="bars">${ticks(c.id, c.mb)}${bar(g[c.id][0], c.mb)}${bar(g[c.id][1], c.mb)}</div></div>`).join('');
    const xLen = G.X_MB;
    const second = g.sex[1].kind === 'Y' ? G.Y_MB : xLen;
    rows += `<div class="chr"><span class="cid">${g.sex[1].kind === 'Y' ? 'XY' : 'XX'}</span><div class="bars">${ticks('X', xLen)}${bar(g.sex[0], xLen)}${bar(g.sex[1], second)}</div></div>`;
    // crossovers made in the egg and sperm that formed this person
    let xoEgg = 0, xoSperm = 0;
    for (const c of G.CHROMOSOMES) {
      xoEgg += (g[c.id][0].xo || []).length;
      xoSperm += (g[c.id][1].xo || []).length;
    }
    xoEgg += (g.sex[0].xo || []).length;
    const legend = [...origins].sort().map((o) => `<div><i style="background:${originBg(o)}"></i>${esc(originLabel(o))}</div>`).join('');
    const facts = person.founder
      ? `${esc(person.name)} is a founder, so each chromosome is still one unbroken copy from an unseen parent.`
      : `The egg that made ${esc(person.name)} carried <b>${xoEgg}</b> crossovers and the sperm <b>${xoSperm}</b>. Egg-making recombines about 1.7 times as much. Colour changes also include older crossovers from earlier generations.`;
    return `<p class="muted" style="margin:0;font-size:.8125rem">Top bar of each pair came from the mother, bottom from the father. Ticks mark the loci in this model.</p>
      <div class="karyotype">${rows}</div><div class="karyo-legend">${legend}</div><p class="xo-facts">${facts}</p>`;
  }

  function renderSpecimen() {
    const person = state.people[state.selected] || state.people[state.motherId];
    state.selected = person.id;
    const male = person.sex === 'M';
    const isParent = person.id === state.motherId || person.id === state.fatherId;
    const isKid = state.kids.includes(person.id);
    const look = person.look;
    const styleOpts = Object.entries(STYLES).map(([k, v]) => `<option value="${k}"${look.style === k ? ' selected' : ''}>${v}</option>`).join('');
    const facialOpts = Object.entries(FACIAL).map(([k, v]) => `<option value="${k}"${look.facial === k ? ' selected' : ''}>${v}</option>`).join('');
    const exprBtns = Object.entries(EXPR).map(([k, v]) => `<button type="button" data-action="expr" data-v="${k}" aria-pressed="${look.expr === k}">${v}</button>`).join('');
    const tab = state.tab;
    const body = tab === 'genes' ? genesHtml(person) : tab === 'chromosomes' ? chromosomesHtml(person) : traitsHtml(person);
    const canSave = saveMode() !== 'none';
    $('#specimen').innerHTML = `
      <div class="spec-top">
        <div class="spec-portrait">
          <div class="frame" id="spec-frame"><span class="matte">${portraitSvg(person)}</span></div>
          <div class="spec-id">
            <p class="eyebrow">Specimen sheet</p>
            <h2>${esc(person.name)}</h2>
            <p>${relationText(person)}</p>
            <p class="karyo">${SEX_MARK[person.sex]} 46,${male ? 'XY' : 'XX'} · generation ${person.gen}${person.edited ? ' · edited' : ''}</p>
            <div class="spec-actions">
              ${isKid ? `<button class="btn small primary" type="button" data-action="promote">Raise as a parent</button>` : ''}
              ${canSave ? `<button class="btn small" type="button" data-action="save-png">Save PNG</button><button class="btn small" type="button" data-action="save-svg">Save SVG</button>` : ''}
              <button class="btn small" type="button" data-action="copy-dna">Copy DNA code</button>
            </div>
          </div>
        </div>
        <div class="look">
          <label class="field" for="look-age"><span>Age</span><input type="range" id="look-age" min="3" max="90" step="1" value="${look.age}"><output id="look-age-out" for="look-age">${look.age} years</output></label>
          <label class="field" for="look-sun"><span>Sun exposure</span><input type="range" id="look-sun" min="0" max="1" step="0.05" value="${look.sun}"><output id="look-sun-out" for="look-sun">${sunWord(look.sun)}</output></label>
          <div class="field wide"><span>Expression</span><div class="seg" role="group" aria-label="Expression">${exprBtns}</div></div>
          <label class="field" for="look-style"><span>Hairstyle</span><select id="look-style">${styleOpts}</select></label>
          ${male ? `<label class="field" for="look-facial"><span>Facial hair</span><select id="look-facial">${facialOpts}</select></label>` : ''}
        </div>
      </div>
      <div class="tabs" role="tablist">
        ${['traits', 'genes', 'chromosomes'].map((t) => `<button type="button" role="tab" data-action="tab" data-v="${t}" aria-selected="${tab === t}">${{ traits: 'Traits', genes: 'Genes', chromosomes: 'Chromosomes' }[t]}</button>`).join('')}
      </div>
      <div class="tab-body" role="tabpanel">${body}</div>`;
  }

  function sunWord(v) {
    return v < 0.15 ? 'Indoors' : v < 0.45 ? 'Some sun' : v < 0.75 ? 'Outdoorsy' : 'Sun-soaked';
  }

  // ----------------------------------------------------------------- render

  function renderAll() {
    renderCouple();
    renderOutlook();
    renderKids();
    renderLineage();
    renderSpecimen();
    state.born = [];
    save();
  }

  // Update one person's portraits without rebuilding the page.
  function refreshPortraits(person) {
    document.querySelectorAll(`.card[data-id="${person.id}"] .matte`).forEach((el) => { el.innerHTML = portraitSvg(person); });
    const f = $('#spec-frame .matte');
    if (f && state.selected === person.id) f.innerHTML = portraitSvg(person);
  }

  // ---------------------------------------------------------------- saving

  let downloads = null;
  let framed = !!(window.claude && typeof window.claude.use === 'function');
  function saveMode() {
    if (downloads) return 'cap';
    if (!framed) return 'link';
    return 'none';
  }
  if (framed) {
    window.claude.use('downloads').then((d) => {
      downloads = d;
      if (state) renderSpecimen();
    }).catch(() => {});
  }

  async function offerFile(filename, data) {
    if (downloads) {
      try {
        await downloads.save({ filename, data });
        toast(`Saved ${filename}`);
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') toast('Save cancelled');
        else if (code === 'rate_limited') toast('A save prompt is already open');
        else toast('Saving is not available in this view');
      }
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function svgToPng(svg, width) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round(width * 1.25);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('render failed')); };
      img.src = url;
    });
  }

  // ----------------------------------------------------------------- toast

  let toastTimer = 0;
  function toast(msg, undo) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>` + (undo ? `<button type="button" data-action="undo">Undo</button>` : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 8000 : 3200);
  }

  // ---------------------------------------------------------------- actions

  function conceive(n) {
    const m = state.people[state.motherId];
    const f = state.people[state.fatherId];
    for (let i = 0; i < n; i++) {
      if (state.kids.length >= 16) { toast('This family is full. Clear some children first.'); break; }
      const c = makeChild(m, f);
      state.kids.push(c.id);
      state.born.push(c.id);
      state.selected = c.id;
    }
    renderAll();
  }

  function twins() {
    if (state.kids.length >= 15) { toast('This family is full. Clear some children first.'); return; }
    const m = state.people[state.motherId];
    const f = state.people[state.fatherId];
    const a = makeChild(m, f);
    const b = makeChild(m, f, G.cloneGenome(a.genome), a.look);
    b.mutations = a.mutations.slice();
    a.twin = b.id;
    b.twin = a.id;
    state.kids.push(a.id, b.id);
    state.born.push(a.id, b.id);
    state.selected = a.id;
    renderAll();
    toast('Identical twins share one genome. Any difference you see is styling.');
  }

  function replaceParent(sex, person) {
    takeSnapshot();
    const had = state.kids.length;
    const old = sex === 'F' ? state.motherId : state.fatherId;
    if (sex === 'F') state.motherId = person.id;
    else state.fatherId = person.id;
    state.kids = [];
    if (state.selected === old || !state.people[state.selected]) state.selected = person.id;
    else state.selected = person.id;
    prune();
    renderAll();
    toast(had ? `New ${sex === 'F' ? 'mother' : 'father'}. ${had} ${had === 1 ? 'child' : 'children'} cleared.` : `New ${sex === 'F' ? 'mother' : 'father'}: ${person.name}`, true);
  }

  function promote(quiet) {
    const person = state.people[state.selected];
    if (!person || !state.kids.includes(person.id)) return;
    if (!quiet) takeSnapshot();
    state.history.unshift({ gen: state.gen, motherId: state.motherId, fatherId: state.fatherId, kids: state.kids.slice() });
    state.gen++;
    const other = makeFounder(person.sex === 'F' ? 'M' : 'F', state.pools[person.sex === 'F' ? 'M' : 'F']);
    other.gen = person.gen;
    if (person.sex === 'F') { state.motherId = person.id; state.fatherId = other.id; }
    else { state.fatherId = person.id; state.motherId = other.id; }
    state.kids = [];
    state.selected = person.id;
    prune();
    if (quiet) return;
    renderAll();
    toast(`${person.name} now starts generation ${state.gen} with ${other.name}.`, true);
  }

  function editAllele(locusId, which) {
    const person = state.people[state.selected];
    const L = G.LOCUS[locusId];
    const pair = L.chr === 'X' ? person.genome.sex : person.genome[L.chr];
    const cur = pair[which].a[locusId];
    G.setAllele(person.genome, locusId, which, (cur + 1) % L.alleles.length);
    person.edited = true;
    phenoCache.delete(person.id);
    const scroll = $('#specimen').scrollTop;
    renderAll();
    $('#specimen').scrollTop = scroll;
  }

  async function copyDna() {
    const person = state.people[state.selected];
    const code = G.encode(person.genome);
    try {
      await navigator.clipboard.writeText(code);
      toast(`Copied ${person.name}'s DNA code`);
    } catch (e) {
      const input = $('#dna-in');
      input.value = code;
      input.focus();
      input.select();
      toast('Copy blocked here. The code is selected in the DNA codes box below.');
    }
  }

  function loadDna() {
    const input = $('#dna-in');
    const g = G.decode(input.value, 'tmp');
    if (!g) {
      toast('That code is not valid. Codes look like AA1-F- followed by two strings of digits.');
      return;
    }
    const sex = G.sexOf(g);
    const person = makeFounder(sex, 'lab', g);
    person.pool = 'lab';
    input.value = '';
    replaceParent(sex, person);
  }

  // ----------------------------------------------------------------- events

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'select') {
      state.selected = t.dataset.id;
      document.querySelectorAll('.card').forEach((c) => {
        const on = c.dataset.id === state.selected;
        c.classList.toggle('selected', on);
        const b = c.querySelector('.frame');
        if (b) b.setAttribute('aria-pressed', on);
      });
      renderSpecimen();
      save();
      if (window.matchMedia('(max-width: 980px)').matches) $('#specimen').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (a === 'conceive') conceive(+t.dataset.n || 1);
    else if (a === 'twins') twins();
    else if (a === 'clear-kids') {
      if (!state.kids.length) return;
      takeSnapshot();
      const n = state.kids.length;
      state.kids = [];
      prune();
      renderAll();
      toast(`Cleared ${n} ${n === 1 ? 'child' : 'children'}`, true);
    } else if (a === 'reroll') {
      const sex = t.dataset.sex;
      replaceParent(sex, makeFounder(sex, state.pools[sex]));
    } else if (a === 'promote') promote();
    else if (a === 'tab') {
      state.tab = t.dataset.v;
      renderSpecimen();
      save();
    } else if (a === 'expr') {
      const person = state.people[state.selected];
      person.look.expr = t.dataset.v;
      t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === t));
      refreshPortraits(person);
      save();
    } else if (a === 'allele') editAllele(t.dataset.locus, +t.dataset.which);
    else if (a === 'copy-dna') copyDna();
    else if (a === 'load-dna') loadDna();
    else if (a === 'undo') {
      if (!snapshot) return;
      state = JSON.parse(snapshot);
      snapshot = null;
      phenoCache.clear();
      $('#toast').hidden = true;
      renderAll();
    } else if (a === 'save-png' || a === 'save-svg') {
      const person = state.people[state.selected];
      const base = `${person.name.toLowerCase()}-gen${person.gen}`;
      if (a === 'save-svg') offerFile(base + '.svg', portraitSvg(person, { size: 800 }));
      else svgToPng(portraitSvg(person, { size: 1200 }), 1200).then((b) => offerFile(base + '.png', b)).catch(() => toast('Could not render the PNG in this browser'));
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    const person = state && state.people[state.selected];
    if (t.id === 'look-age' && person) {
      person.look.age = +t.value;
      $('#look-age-out').textContent = `${t.value} years`;
      const f = $('#spec-frame .matte');
      if (f) f.innerHTML = portraitSvg(person);
    } else if (t.id === 'look-sun' && person) {
      person.look.sun = +t.value;
      $('#look-sun-out').textContent = sunWord(+t.value);
      const f = $('#spec-frame .matte');
      if (f) f.innerHTML = portraitSvg(person);
    } else if (t.id === 'mu') {
      state.mu = +t.value;
      $('#mu-out').textContent = +(state.mu * 100).toFixed(2) + '%';
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    const person = state.people[state.selected];
    if (t.id === 'look-age' || t.id === 'look-sun') {
      refreshPortraits(person);
      document.querySelectorAll(`.card[data-id="${person.id}"] .meta`).forEach((m) => { m.textContent = `${SEX_MARK[person.sex]} ${person.sex === 'F' ? 'XX' : 'XY'} · age ${person.look.age}`; });
      const scroll = $('#specimen').scrollTop;
      if (state.tab === 'traits') { $('.tab-body').innerHTML = traitsHtml(person); }
      $('#specimen').scrollTop = scroll;
      save();
    } else if (t.id === 'look-style') {
      person.look.style = t.value;
      refreshPortraits(person);
      save();
    } else if (t.id === 'look-facial') {
      person.look.facial = t.value;
      refreshPortraits(person);
      save();
    } else if (t.id === 'pool-F' || t.id === 'pool-M') {
      state.pools[t.dataset.sex] = t.value;
      save();
    } else if (t.id === 'kid-age') {
      state.kidAge = +t.value;
      save();
    } else if (t.id === 'mu') save();
  });

  // ------------------------------------------------------------------ boot

  const demoParam = /[?&]demo=(\d+)/.exec(location.search);
  state = demoParam ? null : load();
  if (!state) demo(demoParam ? +demoParam[1] : 0);
  $('#mu').value = state.mu;
  $('#mu').dispatchEvent(new Event('input', { bubbles: true }));
  $('#kid-age').value = String(state.kidAge);
  renderAll();
})();
