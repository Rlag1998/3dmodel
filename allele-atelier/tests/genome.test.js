// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/genome.js');
const P = require('../js/portrait.js');

const rng = G.mulberry32(12345);

// A genome where every locus is set from two allele maps (maternal, paternal).
function genomeWith(sex, mat, pat) {
  const g = G.founderGenome(sex, 'lab', 'T', G.mulberry32(1));
  for (const L of G.LOCI) {
    const pair = L.chr === 'X' ? g.sex : g[L.chr];
    if (L.id in mat) pair[0].a[L.id] = mat[L.id];
    if (L.id in pat && pair[1].kind !== 'Y') pair[1].a[L.id] = pat[L.id];
  }
  return g;
}

test('founders have 22 autosome pairs plus sex chromosomes', () => {
  const f = G.founderGenome('F', 'mosaic', 'a', rng);
  const m = G.founderGenome('M', 'mosaic', 'b', rng);
  assert.equal(G.CHROMOSOMES.length, 22);
  for (const c of G.CHROMOSOMES) assert.equal(f[c.id].length, 2);
  assert.deepEqual(f.sex.map((h) => h.kind), ['X', 'X']);
  assert.deepEqual(m.sex.map((h) => h.kind), ['X', 'Y']);
  assert.equal(G.sexOf(f), 'F');
  assert.equal(G.sexOf(m), 'M');
});

test('sex ratio is close to 1:1', () => {
  const mom = G.founderGenome('F', 'lab', 'a', rng);
  const dad = G.founderGenome('M', 'lab', 'b', rng);
  let boys = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) if (G.sexOf(G.conceive(mom, dad, rng, 0, true)) === 'M') boys++;
  assert.ok(Math.abs(boys / N - 0.5) < 0.03, `boys ${boys / N}`);
});

test('two HERC2 carriers have about one blue-eyed child in four', () => {
  // HERC2 allele 0 = G (blue), 1 = A (brown)
  const mom = genomeWith('F', { HERC2: 0 }, { HERC2: 1 });
  const dad = genomeWith('M', { HERC2: 1 }, { HERC2: 0 });
  let gg = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const [a, b] = G.genotype(G.conceive(mom, dad, rng, 0, true), G.LOCUS.HERC2);
    if (a === 0 && b === 0) gg++;
  }
  assert.ok(Math.abs(gg / N - 0.25) < 0.02, `GG fraction ${gg / N}`);
});

test('a dominant trait shows in heterozygotes and hides in homozygous recessives', () => {
  assert.equal(G.phenotype(genomeWith('F', { DIMP: 0 }, { DIMP: 1 })).dimples, true);
  assert.equal(G.phenotype(genomeWith('F', { DIMP: 1 }, { DIMP: 1 })).dimples, false);
  assert.equal(G.phenotype(genomeWith('F', { DIMP: 0 }, { DIMP: 0 })).dimples, true);
});

test('MC1R: two strong variants give red hair, one does not', () => {
  assert.equal(G.phenotype(genomeWith('F', { MC1R: 1 }, { MC1R: 1 })).redness, 1);
  assert.ok(G.phenotype(genomeWith('F', { MC1R: 1 }, { MC1R: 0 })).redness < 0.5);
});

test('sons inherit their X-linked AR allele only from their mother', () => {
  const mom = genomeWith('F', { AR: 1 }, { AR: 1 }); // protective/protective
  const dad = genomeWith('M', { AR: 0 }, {}); // risk on his only X
  for (let i = 0; i < 500; i++) {
    const kid = G.conceive(mom, dad, rng, 0, true);
    const [a, b] = G.genotype(kid, G.LOCUS.AR);
    if (G.sexOf(kid) === 'M') {
      assert.equal(a, 1);
      assert.equal(b, null);
    } else {
      assert.equal(b, 0); // every daughter gets dad's X
    }
  }
});

function recombinationFraction(idA, idB, N = 6000) {
  const mat = { [idA]: 0, [idB]: 0 };
  const pat = { [idA]: 1, [idB]: 1 };
  const mom = genomeWith('F', mat, pat);
  let rec = 0;
  for (let i = 0; i < N; i++) {
    const egg = G.gamete(mom, rng, 0, true);
    const pa = G.LOCUS[idA].chr, pb = G.LOCUS[idB].chr;
    if (egg[pa].a[idA] !== egg[pb].a[idB]) rec++;
  }
  return rec / N;
}

test('linkage follows physical distance', () => {
  const tight = recombinationFraction('HERC2', 'OCA2e'); // ~0.12 Mb apart on chr15
  const medium = recombinationFraction('HERC2', 'SLC24A5'); // ~20 Mb apart on chr15
  const unlinked = recombinationFraction('HERC2', 'MC1R'); // chr15 vs chr16
  assert.ok(tight < 0.02, `tight ${tight}`);
  assert.ok(medium > 0.15 && medium < 0.35, `medium ${medium}`);
  assert.ok(Math.abs(unlinked - 0.5) < 0.03, `unlinked ${unlinked}`);
});

test('eggs carry more crossovers than sperm', () => {
  const mom = G.founderGenome('F', 'lab', 'a', rng);
  const dad = G.founderGenome('M', 'lab', 'b', rng);
  const count = (g) => G.CHROMOSOMES.reduce((s, c) => s + g[c.id].xo.length, 0);
  let e = 0, s = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    e += count(G.gamete(mom, rng, 0, true));
    s += count(G.gamete(dad, rng, 0, true));
  }
  e /= N;
  s /= N;
  assert.ok(e > 40 && e < 50, `egg mean ${e}`);
  assert.ok(s > 22 && s < 30, `sperm mean ${s}`);
});

test('segments tile each chromosome without gaps', () => {
  const mom = G.founderGenome('F', 'lab', 'a', rng);
  const dad = G.founderGenome('M', 'lab', 'b', rng);
  const kid = G.conceive(mom, dad, rng, 0, false);
  for (const c of G.CHROMOSOMES) {
    for (const h of kid[c.id]) {
      assert.equal(h.segs[0][0], 0);
      assert.ok(Math.abs(h.segs[h.segs.length - 1][1] - c.mb) < 1e-9);
      for (let i = 1; i < h.segs.length; i++) assert.ok(Math.abs(h.segs[i][0] - h.segs[i - 1][1]) < 1e-9);
    }
  }
});

test('DNA codes round-trip', () => {
  for (const sex of ['F', 'M']) {
    const g = G.founderGenome(sex, 'mosaic', 'a', rng);
    const code = G.encode(g);
    const back = G.decode(code, 'z');
    assert.ok(back);
    assert.equal(G.encode(back), code);
    const p1 = G.phenotype(g), p2 = G.phenotype(back);
    assert.equal(p1.skin, p2.skin);
    assert.equal(p1.iris, p2.iris);
  }
  assert.equal(G.decode('nonsense', 'z'), null);
});

test('mutation rate produces de novo changes at about the expected rate', () => {
  const mom = G.founderGenome('F', 'lab', 'a', rng);
  let n = 0;
  const N = 300, mu = 0.02;
  for (let i = 0; i < N; i++) {
    const egg = G.gamete(mom, rng, mu, true);
    for (const k in egg) n += Object.keys(egg[k].mut).length;
  }
  const expected = N * mu * G.LOCI.length;
  assert.ok(Math.abs(n - expected) < expected * 0.25, `${n} vs ${expected}`);
});

test('phenotypes stay in range and portraits render cleanly', () => {
  for (const pool of G.POOLS.map((p) => p.id)) {
    for (let i = 0; i < 20; i++) {
      const g = G.founderGenome(i % 2 ? 'M' : 'F', pool, 'q', rng);
      const p = G.phenotype(g);
      for (const k of ['skin', 'iris', 'hair', 'curl', 'faceW', 'noseW', 'lips', 'lid']) {
        assert.ok(p[k] >= 0 && p[k] <= 1, `${k}=${p[k]}`);
      }
      for (const age of [4, 30, 80]) {
        for (const style of ['crop', 'short', 'bob', 'long', 'bun']) {
          const svg = P.render(p, { age, style, facial: 'beard', expr: 'grin', sun: 0.5, seed: i + 1 });
          assert.ok(svg.startsWith('<svg'));
          assert.ok(!/NaN|undefined/.test(svg), `bad svg for ${pool} ${age} ${style}`);
        }
      }
    }
  }
});
