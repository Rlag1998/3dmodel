/*
 * Allele Atelier — genetics engine.
 *
 * A diploid genome laid out on 22 autosomes plus X/Y. Each locus sits at an
 * approximate GRCh38 position, so linkage falls out of the meiosis model:
 * loci close together on a chromosome tend to be inherited together.
 *
 * Works in the browser (window.Genome) and in Node (require) for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Genome = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- random

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function poisson(lambda, rng) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng();
    } while (p > L);
    return k - 1;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ------------------------------------------------------------ chromosomes

  // Physical lengths in Mb (GRCh38, rounded).
  const CHROMOSOMES = [
    ['1', 248], ['2', 242], ['3', 198], ['4', 190], ['5', 181], ['6', 171],
    ['7', 159], ['8', 145], ['9', 138], ['10', 134], ['11', 135], ['12', 133],
    ['13', 114], ['14', 107], ['15', 102], ['16', 90], ['17', 83], ['18', 80],
    ['19', 59], ['20', 64], ['21', 47], ['22', 51],
  ].map(([id, mb]) => ({ id, mb }));
  const X_MB = 156;
  const Y_MB = 57;

  // Sex-specific recombination, cM per Mb. The female map is ~1.7x longer.
  const RATE = { F: 1.55, M: 0.9, FX: 1.15 };

  // ------------------------------------------------------------ gene pools

  const REGIONS = ['neu', 'med', 'mena', 'waf', 'sas', 'eas', 'ame'];
  const POOLS = [
    { id: 'mosaic', name: 'Global mosaic', note: 'The average of every regional pool. Founders carry many mixed loci, so siblings differ a lot.' },
    { id: 'neu', name: 'Northern Europe' },
    { id: 'med', name: 'Mediterranean' },
    { id: 'mena', name: 'Middle East & North Africa' },
    { id: 'waf', name: 'West Africa' },
    { id: 'sas', name: 'South Asia' },
    { id: 'eas', name: 'East Asia' },
    { id: 'ame', name: 'Indigenous Americas' },
    { id: 'lab', name: 'Lab stock (50/50)', note: 'Every allele at equal frequency. Useful for seeing the full range of each trait.' },
  ];

  // Frequency helper: f(neu, med, mena, waf, sas, eas, ame) for allele 0 of a biallelic locus.
  function f(neu, med, mena, waf, sas, eas, ame) {
    return { neu, med, mena, waf, sas, eas, ame };
  }

  // ----------------------------------------------------------------- loci
  //
  // fx keys (trait contributions per allele copy):
  //   skin  eye  lipo  hair  freck  curl  thick  grey  bald  beard  brow  mono
  //   faceW faceL jaw chin fhd eyeS eyeD tilt lid noseW noseL bridge tip lips mouthW earS lobe
  //   dimple cleft widow
  //
  // `dom: i` marks allele i as fully dominant. `special` loci are handled
  // explicitly in phenotype(). `mapped: false` marks illustrative, unmapped loci.

  const CATS = [
    { id: 'pig', name: 'Pigmentation' },
    { id: 'eye', name: 'Eye colour' },
    { id: 'hair', name: 'Hair' },
    { id: 'face', name: 'Face shape' },
    { id: 'feat', name: 'Features' },
    { id: 'folk', name: 'Classroom Mendelian traits' },
  ];

  const LOCI = [
    // --- pigmentation -----------------------------------------------------
    {
      id: 'SLC24A5', sym: 'SLC24A5', chr: '15', mb: 48.1, cat: 'pig', mapped: true,
      variant: 'rs1426654 · Ala111Thr',
      note: 'One of the largest single-gene effects on skin pigmentation. The derived Thr111 allele lightens skin.',
      alleles: [
        { s: 'A', n: 'Thr111 (lighter)', fx: { skin: -0.05, hair: -0.03, eye: -0.01 } },
        { s: 'G', n: 'Ala111 (ancestral)', fx: {} },
      ],
      freq: f(0.99, 0.97, 0.85, 0.03, 0.75, 0.05, 0.15),
    },
    {
      id: 'SLC45A2', sym: 'SLC45A2', chr: '5', mb: 33.95, cat: 'pig', mapped: true,
      variant: 'rs16891982 · Leu374Phe',
      note: 'A melanosome transporter. The Phe374 allele lightens skin, hair and eyes.',
      alleles: [
        { s: 'G', n: 'Phe374 (lighter)', fx: { skin: -0.04, hair: -0.06, eye: -0.03 } },
        { s: 'C', n: 'Leu374 (ancestral)', fx: {} },
      ],
      freq: f(0.96, 0.85, 0.5, 0.01, 0.15, 0.02, 0.05),
    },
    {
      id: 'OCA2s', sym: 'OCA2', chr: '15', mb: 27.95, cat: 'pig', mapped: true,
      variant: 'rs1800414 · His615Arg',
      note: 'An OCA2 variant common in East Asia that lightens skin. It sits right next to HERC2, so the two are tightly linked.',
      alleles: [
        { s: 'G', n: 'Arg615 (lighter)', fx: { skin: -0.05, hair: -0.01 } },
        { s: 'A', n: 'His615 (ancestral)', fx: {} },
      ],
      freq: f(0.0, 0.0, 0.01, 0.0, 0.02, 0.6, 0.1),
    },
    {
      id: 'TYR', sym: 'TYR', chr: '11', mb: 89.3, cat: 'pig', mapped: true,
      variant: 'rs1393350',
      note: 'Tyrosinase, the enzyme that starts melanin synthesis. The A allele is associated with lighter eyes and fair skin.',
      alleles: [
        { s: 'A', n: 'lighter', fx: { skin: -0.02, eye: -0.04, hair: -0.03 } },
        { s: 'G', n: 'ancestral', fx: {} },
      ],
      freq: f(0.28, 0.2, 0.1, 0.0, 0.05, 0.0, 0.01),
    },
    {
      id: 'IRF4', sym: 'IRF4', chr: '6', mb: 0.4, cat: 'pig', mapped: true,
      variant: 'rs12203592',
      note: 'Pleiotropic: the T allele lightens hair and eyes, raises freckling and sun sensitivity, and has been linked to earlier greying.',
      alleles: [
        { s: 'T', n: 'lighter, freckling', fx: { skin: -0.02, eye: -0.04, hair: -0.04, freck: 0.12, grey: -4 } },
        { s: 'C', n: 'ancestral', fx: {} },
      ],
      freq: f(0.2, 0.1, 0.05, 0.0, 0.02, 0.0, 0.0),
    },
    {
      id: 'MC1R', sym: 'MC1R', chr: '16', mb: 89.9, cat: 'pig', mapped: true, special: 'mc1r',
      variant: 'R151C · R160W · D294H (R), V60L · V92M (r)',
      note: 'The melanocortin-1 receptor switches pigment cells between dark eumelanin and red-yellow pheomelanin. Two strong loss-of-function (R) alleles usually give red hair; one is enough to raise freckling and redden a beard.',
      alleles: [
        { s: '+', n: 'consensus (functional)', fx: {} },
        { s: 'R', n: 'strong red-hair variant', fx: { skin: -0.03, hair: -0.05 } },
        { s: 'r', n: 'weak variant', fx: { skin: -0.01, hair: -0.01 } },
      ],
      freq: {
        neu: [0.67, 0.13, 0.2], med: [0.81, 0.04, 0.15], mena: [0.88, 0.02, 0.1],
        waf: [0.98, 0.0, 0.02], sas: [0.94, 0.01, 0.05], eas: [0.7, 0.0, 0.3], ame: [0.9, 0.0, 0.1],
      },
    },
    {
      id: 'MFSD12', sym: 'MFSD12', chr: '19', mb: 3.5, cat: 'pig', mapped: true,
      variant: 'lysosomal transporter variants',
      note: 'Derived variants here darken skin. They are common in parts of Africa and South Asia.',
      alleles: [
        { s: 'D', n: 'darker', fx: { skin: 0.03 } },
        { s: 'a', n: 'ancestral', fx: {} },
      ],
      freq: f(0.0, 0.0, 0.05, 0.4, 0.2, 0.02, 0.02),
    },
    {
      id: 'BNC2', sym: 'BNC2', chr: '9', mb: 16.4, cat: 'pig', mapped: true,
      variant: 'freckling association',
      note: 'Associated with freckling and skin saturation in European studies.',
      alleles: [
        { s: 'F', n: 'more freckles', fx: { freck: 0.1 } },
        { s: 'f', n: 'fewer freckles', fx: {} },
      ],
      freq: f(0.4, 0.3, 0.25, 0.2, 0.25, 0.25, 0.25),
    },
    ...[['PIG1', '3', 60], ['PIG2', '8', 40], ['PIG3', '10', 70], ['PIG4', '13', 50]].map(([id, chr, mb], i) => ({
      id, sym: id, chr, mb, cat: 'pig', mapped: false,
      variant: 'polygenic background',
      note: 'Stands in for the hundreds of small-effect pigmentation variants. Darkens skin, hair and eyes a little.',
      alleles: [
        { s: '+', n: 'darker', fx: { skin: 0.07, hair: 0.06, eye: 0.015 } },
        { s: '−', n: 'lighter', fx: {} },
      ],
      freq: f(0.05, 0.2, 0.3, 0.9, 0.55, 0.12, 0.4),
    })),

    // --- eye colour -------------------------------------------------------
    {
      id: 'HERC2', sym: 'HERC2', chr: '15', mb: 28.12, cat: 'eye', mapped: true, special: 'herc2',
      variant: 'rs12913832',
      note: 'An enhancer inside HERC2 that controls OCA2 expression in the iris. G/G nearly switches iris melanin off, which reads as blue. One A allele restores most of it.',
      alleles: [
        { s: 'G', n: 'blue-eye allele', fx: { skin: -0.015, hair: -0.05 } },
        { s: 'A', n: 'brown-eye allele', fx: {} },
      ],
      freq: f(0.8, 0.35, 0.12, 0.01, 0.07, 0.01, 0.02),
    },
    {
      id: 'OCA2e', sym: 'OCA2', chr: '15', mb: 28.0, cat: 'eye', mapped: true,
      variant: 'rs1800407 · Arg419Gln',
      note: 'Lowers iris melanin. On a brown background it often turns eyes green or hazel.',
      alleles: [
        { s: 'T', n: 'Gln419 (lighter)', fx: { eye: -0.18, hair: -0.02 } },
        { s: 'C', n: 'Arg419', fx: {} },
      ],
      freq: f(0.08, 0.05, 0.03, 0.0, 0.02, 0.0, 0.0),
    },
    {
      id: 'SLC24A4', sym: 'SLC24A4', chr: '14', mb: 92.3, cat: 'eye', mapped: true,
      variant: 'rs12896399',
      note: 'A small-effect eye and hair colour locus used in forensic prediction panels.',
      alleles: [
        { s: 'L', n: 'lighter', fx: { eye: -0.04, hair: -0.03 } },
        { s: 'D', n: 'darker', fx: {} },
      ],
      freq: f(0.55, 0.4, 0.3, 0.05, 0.25, 0.1, 0.1),
    },
    {
      id: 'GEY', sym: 'GEY', chr: '19', mb: 30, cat: 'eye', mapped: false, dom: 0,
      variant: 'EYCL1 (historical)',
      note: 'The green-eye gene from the classic two-gene model. Modern genetics finds no single green gene, so here it stands for the yellow lipochrome that turns a low-melanin iris green.',
      alleles: [
        { s: 'G', n: 'green (dominant)', fx: { lipo: 0.5 } },
        { s: 'b', n: 'blue', fx: {} },
      ],
      freq: f(0.12, 0.1, 0.08, 0.08, 0.08, 0.08, 0.08),
    },

    // --- hair -------------------------------------------------------------
    {
      id: 'KITLG', sym: 'KITLG', chr: '12', mb: 88.5, cat: 'hair', mapped: true,
      variant: 'rs12821256',
      note: 'A regulatory variant that lowers KITLG in hair follicles. The C allele is a classic blond-hair allele.',
      alleles: [
        { s: 'C', n: 'blond', fx: { hair: -0.08, skin: -0.005 } },
        { s: 'T', n: 'ancestral', fx: {} },
      ],
      freq: f(0.2, 0.12, 0.05, 0.0, 0.01, 0.0, 0.0),
    },
    ...[['HDK1', '17', 40], ['HDK2', '18', 30], ['HDK3', '21', 25]].map(([id, chr, mb]) => ({
      id, sym: id, chr, mb, cat: 'hair', mapped: false,
      variant: 'polygenic background',
      note: 'Small-effect hair darkness variants, independent of skin colour.',
      alleles: [
        { s: '+', n: 'darker hair', fx: { hair: 0.07 } },
        { s: '−', n: 'lighter hair', fx: {} },
      ],
      freq: f(0.45, 0.75, 0.85, 0.97, 0.92, 0.97, 0.97),
    })),
    {
      id: 'TCHH', sym: 'TCHH', chr: '1', mb: 152.1, cat: 'hair', mapped: true,
      variant: 'rs11803731',
      note: 'Trichohyalin hardens the inner root sheath. This variant is associated with straighter hair in Europeans.',
      alleles: [
        { s: 'T', n: 'straighter', fx: { curl: -0.08 } },
        { s: 'A', n: 'ancestral', fx: {} },
      ],
      freq: f(0.2, 0.15, 0.15, 0.0, 0.1, 0.05, 0.05),
    },
    {
      id: 'EDAR', sym: 'EDAR', chr: '2', mb: 108.9, cat: 'hair', mapped: true,
      variant: 'rs3827760 · Val370Ala',
      note: 'The 370A allele is near-fixed in East Asia and the Americas. It gives thicker, straighter hair fibres and, in studies, sparser beards, less chin protrusion and more attached earlobes.',
      alleles: [
        { s: 'G', n: '370Ala', fx: { curl: -0.1, thick: 0.25, beard: -0.12, chin: -0.08, lobe: 0.1 } },
        { s: 'A', n: '370Val (ancestral)', fx: {} },
      ],
      freq: f(0.0, 0.0, 0.0, 0.0, 0.05, 0.87, 0.95),
    },
    {
      id: 'PRSS53', sym: 'PRSS53', chr: '16', mb: 31.1, cat: 'hair', mapped: true,
      variant: 'hair shape association',
      note: 'A protease expressed in the hair follicle, associated with hair curl.',
      alleles: [
        { s: 'C', n: 'curlier', fx: { curl: 0.07 } },
        { s: 's', n: 'straighter', fx: {} },
      ],
      freq: f(0.3, 0.4, 0.45, 0.6, 0.4, 0.2, 0.2),
    },
    ...[['HC1', '1', 200], ['HC2', '4', 80], ['HC3', '12', 30]].map(([id, chr, mb]) => ({
      id, sym: id, chr, mb, cat: 'hair', mapped: false,
      variant: 'polygenic background',
      note: 'Tightly coiled hair is common across sub-Saharan Africa, but its genes are poorly mapped. These loci stand in for them.',
      alleles: [
        { s: '+', n: 'tighter curl', fx: { curl: 0.12 } },
        { s: '−', n: 'looser', fx: {} },
      ],
      freq: f(0.08, 0.15, 0.25, 0.9, 0.15, 0.03, 0.05),
    })),
    ...[['GRY1', '7', 120], ['GRY2', '11', 30]].map(([id, chr, mb]) => ({
      id, sym: id, chr, mb, cat: 'hair', mapped: false,
      variant: 'polygenic background',
      note: 'Shifts the age at which grey hair starts.',
      alleles: [
        { s: 'e', n: 'earlier greying', fx: { grey: -4 } },
        { s: 'l', n: 'later greying', fx: {} },
      ],
      freq: 0.5,
    })),
    {
      id: 'AR', sym: 'AR', chr: 'X', mb: 67.5, cat: 'hair', mapped: true,
      variant: 'androgen receptor',
      note: 'The strongest single locus for male-pattern baldness. It sits on the X chromosome, so men inherit it only from their mother.',
      alleles: [
        { s: 'B', n: 'baldness risk', fx: { bald: 0.22 } },
        { s: 'b', n: 'protective', fx: {} },
      ],
      freq: f(0.7, 0.65, 0.6, 0.35, 0.5, 0.4, 0.3),
    },
    {
      id: 'BALD20', sym: '20p11', chr: '20', mb: 22.0, cat: 'hair', mapped: true,
      variant: '20p11.22 locus',
      note: 'An autosomal baldness locus near PAX1 and FOXA2, so it is linked to the nose-width locus PAX1.',
      alleles: [
        { s: 'B', n: 'baldness risk', fx: { bald: 0.15 } },
        { s: 'b', n: 'protective', fx: {} },
      ],
      freq: 0.5,
    },
    ...[['BRD1', '22', 30], ['BRD2', '9', 100]].map(([id, chr, mb]) => ({
      id, sym: id, chr, mb, cat: 'hair', mapped: false,
      variant: 'polygenic background',
      note: 'Beard density. Only shows in people with adult male hormone levels.',
      alleles: [
        { s: '+', n: 'denser beard', fx: { beard: 0.12 } },
        { s: '−', n: 'sparser', fx: {} },
      ],
      freq: 0.5,
    })),

    // --- face shape -------------------------------------------------------
    ...morph('FW', 'Face width', 'faceW', [['2', 50], ['8', 110], ['14', 40]], 0.09),
    ...morph('FL', 'Face length', 'faceL', [['3', 170], ['10', 20]], 0.11),
    ...morph('JAW', 'Jaw width', 'jaw', [['6', 90], ['17', 70]], 0.12),
    ...morph('CHN', 'Chin size', 'chin', [['13', 95]], 0.18),
    ...morph('FHD', 'Forehead height', 'fhd', [['18', 60]], 0.2),

    // --- features ---------------------------------------------------------
    ...morph('EYS', 'Eye size', 'eyeS', [['1', 60], ['11', 120]], 0.12),
    ...morph('EYD', 'Eye spacing', 'eyeD', [['4', 20]], 0.2),
    ...morph('EYT', 'Eye tilt', 'tilt', [['7', 150]], 0.2),
    ...[['LID1', '2', 160], ['LID2', '12', 110]].map(([id, chr, mb]) => ({
      id, sym: id, chr, mb, cat: 'feat', mapped: false,
      variant: 'polygenic background',
      note: 'Upper eyelid crease. With more fold alleles, skin covers the crease (a monolid) and the inner corner.',
      alleles: [
        { s: 'M', n: 'monolid', fx: { lid: 0.25 } },
        { s: 'd', n: 'double lid', fx: {} },
      ],
      freq: f(0.02, 0.03, 0.04, 0.05, 0.08, 0.42, 0.3),
    })),
    {
      id: 'FOXL2', sym: 'FOXL2', chr: '3', mb: 138.9, cat: 'feat', mapped: true,
      variant: 'eyebrow thickness association',
      note: 'A transcription factor associated with eyebrow thickness in a large admixed-population study.',
      alleles: [
        { s: 'T', n: 'thicker brows', fx: { brow: 0.12 } },
        { s: 't', n: 'thinner', fx: {} },
      ],
      freq: 0.45,
    },
    {
      id: 'BRW1', sym: 'BRW1', chr: '5', mb: 120, cat: 'feat', mapped: false,
      variant: 'polygenic background',
      note: 'Eyebrow thickness.',
      alleles: [
        { s: '+', n: 'thicker', fx: { brow: 0.1 } },
        { s: '−', n: 'thinner', fx: {} },
      ],
      freq: 0.5,
    },
    {
      id: 'PAX3', sym: 'PAX3', chr: '2', mb: 222.2, cat: 'feat', mapped: true,
      variant: 'monobrow & nasion association',
      note: 'Associated with a joined brow (synophrys) and with the depth of the nose bridge between the eyes.',
      alleles: [
        { s: 'U', n: 'joined brow, high nasion', fx: { mono: 0.22, bridge: 0.08 } },
        { s: 'u', n: 'separate brows', fx: {} },
      ],
      freq: 0.3,
    },
    {
      id: 'GLI3', sym: 'GLI3', chr: '7', mb: 42.0, cat: 'feat', mapped: true,
      variant: 'nostril breadth association',
      note: 'A developmental signalling gene associated with the breadth of the nostrils.',
      alleles: [
        { s: 'W', n: 'broader nostrils', fx: { noseW: 0.12 } },
        { s: 'n', n: 'narrower', fx: {} },
      ],
      freq: 0.5,
    },
    {
      id: 'PAX1', sym: 'PAX1', chr: '20', mb: 21.7, cat: 'feat', mapped: true,
      variant: 'nose wing breadth association',
      note: 'Associated with nose wing breadth. Linked to the 20p11 baldness locus 300 kb away.',
      alleles: [
        { s: 'W', n: 'broader nose', fx: { noseW: 0.08 } },
        { s: 'n', n: 'narrower', fx: {} },
      ],
      freq: 0.5,
    },
    {
      id: 'RUNX2', sym: 'RUNX2', chr: '6', mb: 45.4, cat: 'feat', mapped: true,
      variant: 'nose bridge breadth association',
      note: 'A bone-development master gene associated with the breadth of the nose bridge.',
      alleles: [
        { s: 'B', n: 'broader, flatter bridge', fx: { bridge: -0.12 } },
        { s: 'n', n: 'narrower, higher bridge', fx: {} },
      ],
      freq: 0.5,
    },
    {
      id: 'DCHS2', sym: 'DCHS2', chr: '4', mb: 154.2, cat: 'feat', mapped: true,
      variant: 'columella inclination association',
      note: 'Associated with how upturned or pointed the nose tip is.',
      alleles: [
        { s: 'P', n: 'pointier tip', fx: { tip: 0.14 } },
        { s: 'r', n: 'rounder tip', fx: {} },
      ],
      freq: 0.5,
    },
    ...morph('NSL', 'Nose length', 'noseL', [['5', 160], ['22', 45]], 0.12),
    ...morph('LIP', 'Lip fullness', 'lips', [['9', 60], ['16', 60]], 0.13),
    ...morph('MTW', 'Mouth width', 'mouthW', [['10', 110]], 0.2),
    ...morph('EAR', 'Ear size', 'earS', [['17', 15]], 0.2),
    {
      id: 'ADGRG6', sym: 'ADGRG6', chr: '6', mb: 142.3, cat: 'feat', mapped: true,
      variant: 'GPR126 · earlobe attachment',
      note: 'Earlobe attachment is polygenic, not the single-gene trait from school. ADGRG6 is one of the larger-effect loci.',
      alleles: [
        { s: 'A', n: 'attached lobe', fx: { lobe: 0.18 } },
        { s: 'f', n: 'free lobe', fx: {} },
      ],
      freq: 0.4,
    },

    // --- classroom Mendelian ----------------------------------------------
    {
      id: 'DIMP', sym: 'DIMP', chr: '5', mb: 70, cat: 'folk', mapped: false, dom: 0,
      variant: 'textbook dominant',
      note: 'Taught as a single dominant gene. Real dimples are irregularly inherited and no gene has been confirmed.',
      alleles: [
        { s: 'D', n: 'dimples (dominant)', fx: { dimple: 0.5 } },
        { s: 'd', n: 'no dimples', fx: {} },
      ],
      freq: 0.2,
    },
    {
      id: 'CLEFT', sym: 'CLFT', chr: '19', mb: 50, cat: 'folk', mapped: false, dom: 0,
      variant: 'textbook dominant',
      note: 'Taught as a dominant trait. In reality its inheritance is not that simple.',
      alleles: [
        { s: 'C', n: 'cleft chin (dominant)', fx: { cleft: 0.5 } },
        { s: 'c', n: 'smooth chin', fx: {} },
      ],
      freq: 0.12,
    },
    {
      id: 'WIDOW', sym: 'WPK', chr: '8', mb: 5, cat: 'folk', mapped: false, dom: 0,
      variant: 'textbook dominant',
      note: 'A V-shaped hairline, taught as dominant. There is little evidence for a single gene.',
      alleles: [
        { s: 'W', n: "widow's peak (dominant)", fx: { widow: 0.5 } },
        { s: 'w', n: 'straight hairline', fx: {} },
      ],
      freq: 0.25,
    },
  ];

  function morph(prefix, label, trait, places, delta) {
    return places.map(([chr, mb], i) => ({
      id: prefix + (places.length > 1 ? i + 1 : ''),
      sym: prefix + (places.length > 1 ? i + 1 : ''),
      chr, mb,
      cat: ['faceW', 'faceL', 'jaw', 'chin', 'fhd'].includes(trait) ? 'face' : 'feat',
      mapped: false,
      variant: 'polygenic background',
      note: label + ' is highly polygenic. This locus is one of a few stand-ins with equal frequency in every pool.',
      alleles: [
        { s: '+', n: 'larger ' + label.toLowerCase(), fx: { [trait]: delta } },
        { s: '−', n: 'smaller ' + label.toLowerCase(), fx: { [trait]: -delta } },
      ],
      freq: 0.5,
    }));
  }

  const LOCUS = {};
  const LOCI_BY_CHR = {};
  for (const L of LOCI) {
    LOCUS[L.id] = L;
    (LOCI_BY_CHR[L.chr] = LOCI_BY_CHR[L.chr] || []).push(L);
  }
  for (const k in LOCI_BY_CHR) LOCI_BY_CHR[k].sort((a, b) => a.mb - b.mb);

  // Resolve per-pool allele frequency vectors once.
  const FREQ = {};
  for (const L of LOCI) {
    FREQ[L.id] = {};
    const n = L.alleles.length;
    const regional = {};
    for (const r of REGIONS) {
      let v = L.freq;
      if (typeof v === 'number') v = n === 2 ? [v, 1 - v] : null;
      else if (v && typeof v[r] === 'number') v = [v[r], 1 - v[r]];
      else if (v && Array.isArray(v[r])) v = v[r];
      regional[r] = v;
    }
    for (const r of REGIONS) FREQ[L.id][r] = regional[r];
    FREQ[L.id].mosaic = regional.neu.map((_, i) => REGIONS.reduce((s, r) => s + regional[r][i], 0) / REGIONS.length);
    FREQ[L.id].lab = L.alleles.map(() => 1 / n);
  }

  function sampleAllele(L, pool, rng) {
    const fr = FREQ[L.id][pool] || FREQ[L.id].mosaic;
    let x = rng();
    for (let i = 0; i < fr.length; i++) {
      x -= fr[i];
      if (x < 0) return i;
    }
    return fr.length - 1;
  }

  // --------------------------------------------------------------- genomes
  //
  // A haplotype: { kind: 'A'|'X'|'Y', segs: [[start, end, origin]], a: {locusId: alleleIndex}, mut: {locusId: 'de novo'|'edit'} }
  // A genome:    { '1': [hapFromMother, hapFromFather], ..., sex: [X from mother, X|Y from father] }

  function newHap(kind, len, origin, chrId, pool, rng) {
    const h = { kind, segs: [[0, len, origin]], a: {}, mut: {} };
    if (kind !== 'Y') for (const L of LOCI_BY_CHR[chrId] || []) h.a[L.id] = sampleAllele(L, pool, rng);
    return h;
  }

  function founderGenome(sex, pool, founderId, rng) {
    const g = {};
    for (const c of CHROMOSOMES) {
      g[c.id] = [newHap('A', c.mb, founderId + '.0', c.id, pool, rng), newHap('A', c.mb, founderId + '.1', c.id, pool, rng)];
    }
    g.sex = [
      newHap('X', X_MB, founderId + '.0', 'X', pool, rng),
      sex === 'M' ? newHap('Y', Y_MB, founderId + '.1', 'Y', pool, rng) : newHap('X', X_MB, founderId + '.1', 'X', pool, rng),
    ];
    return g;
  }

  function sexOf(genome) {
    return genome.sex[1].kind === 'Y' ? 'M' : 'F';
  }

  // Copy the [from, to) slice of a segment list onto out, merging same-origin neighbours.
  function spliceSegs(out, segs, from, to) {
    for (const [s, e, o] of segs) {
      const a = Math.max(s, from);
      const b = Math.min(e, to);
      if (b <= a) continue;
      const last = out[out.length - 1];
      if (last && last[2] === o && Math.abs(last[1] - a) < 1e-9) last[1] = b;
      else out.push([a, b, o]);
    }
  }

  // One chromatid out of a homologous pair, with Poisson crossovers.
  function recombine(pair, chrId, len, rate, rng, fast) {
    const n = poisson((len * rate) / 100, rng);
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(rng() * len);
    xs.sort((p, q) => p - q);
    const start = rng() < 0.5 ? 0 : 1;
    const out = { kind: pair[start].kind, segs: [], a: {}, mut: {}, xo: xs };
    if (!fast) {
      let cur = start;
      let from = 0;
      for (const x of [...xs, len]) {
        spliceSegs(out.segs, pair[cur].segs, from, x);
        from = x;
        cur ^= 1;
      }
    }
    for (const L of LOCI_BY_CHR[chrId] || []) {
      let k = start;
      for (const x of xs) if (x < L.mb) k ^= 1;
      out.a[L.id] = pair[k].a[L.id];
    }
    return out;
  }

  function copyHap(h, fast) {
    return { kind: h.kind, segs: fast ? [] : h.segs.map((s) => s.slice()), a: Object.assign({}, h.a), mut: {}, xo: [] };
  }

  function gamete(genome, rng, mu, fast) {
    const sex = sexOf(genome);
    const g = {};
    for (const c of CHROMOSOMES) g[c.id] = recombine(genome[c.id], c.id, c.mb, RATE[sex], rng, fast);
    if (sex === 'F') g.sex = recombine(genome.sex, 'X', X_MB, RATE.FX, rng, fast);
    else g.sex = copyHap(genome.sex[rng() < 0.5 ? 0 : 1], fast);
    if (mu > 0) {
      for (const L of LOCI) {
        const h = L.chr === 'X' ? g.sex : g[L.chr];
        if (!(L.id in h.a) || rng() >= mu) continue;
        const n = L.alleles.length;
        h.a[L.id] = (h.a[L.id] + 1 + Math.floor(rng() * (n - 1))) % n;
        h.mut[L.id] = 'de novo';
      }
    }
    return g;
  }

  function conceive(motherGenome, fatherGenome, rng, mu, fast) {
    const egg = gamete(motherGenome, rng, mu, fast);
    const sperm = gamete(fatherGenome, rng, mu, fast);
    const g = {};
    for (const c of CHROMOSOMES) g[c.id] = [egg[c.id], sperm[c.id]];
    g.sex = [egg.sex, sperm.sex];
    return g;
  }

  // Alleles at a locus as [fromMother, fromFather]; the second is null when hemizygous (X in males).
  function genotype(genome, L) {
    const pair = L.chr === 'X' ? genome.sex : genome[L.chr];
    const a = pair[0].a[L.id];
    const b = pair[1].kind === 'Y' ? null : pair[1].a[L.id];
    return [a, b];
  }

  function setAllele(genome, locusId, which, alleleIndex) {
    const L = LOCUS[locusId];
    const pair = L.chr === 'X' ? genome.sex : genome[L.chr];
    if (pair[which].kind === 'Y') return false;
    pair[which].a[locusId] = alleleIndex;
    pair[which].mut[locusId] = 'edit';
    return true;
  }

  function cloneGenome(genome) {
    const g = {};
    for (const k in genome) g[k] = genome[k].map((h) => ({ kind: h.kind, segs: h.segs.map((s) => s.slice()), a: Object.assign({}, h.a), mut: Object.assign({}, h.mut) }));
    return g;
  }

  // ------------------------------------------------------------ phenotype

  // Raw trait sums plus a per-locus contribution log (used to explain traits).
  function traitSums(genome) {
    const t = {};
    const why = {};
    const add = (L, fx, k) => {
      for (const key in fx) {
        const v = fx[key] * k;
        if (!v) continue;
        t[key] = (t[key] || 0) + v;
        (why[key] = why[key] || {})[L.id] = ((why[key] || {})[L.id] || 0) + v;
      }
    };
    for (const L of LOCI) {
      if (L.special === 'herc2') {
        // HERC2 still carries small skin/hair effects additively.
        const [a, b] = genotype(genome, L);
        add(L, L.alleles[a].fx, 1);
        add(L, L.alleles[b == null ? a : b].fx, 1);
        continue;
      }
      const [a, b] = genotype(genome, L);
      if (b == null) {
        add(L, L.alleles[a].fx, 2); // hemizygous: one copy sets the dose
      } else if (L.dom != null) {
        const al = a === L.dom || b === L.dom ? L.alleles[L.dom] : L.alleles[a];
        add(L, al.fx, 2);
      } else {
        add(L, L.alleles[a].fx, 1);
        add(L, L.alleles[b].fx, 1);
      }
    }
    return { t, why };
  }

  function phenotype(genome) {
    const { t, why } = traitSums(genome);
    const sex = sexOf(genome);
    const g = (k) => t[k] || 0;

    // HERC2 rs12913832 sets the iris melanin baseline.
    const [h1, h2] = genotype(genome, LOCUS.HERC2);
    const blue = (h1 === 0 ? 1 : 0) + (h2 === 0 ? 1 : 0);
    const irisBase = [0.86, 0.6, 0.1][blue];

    // MC1R: count strong (R) and weak (r) loss-of-function alleles.
    const [m1, m2] = genotype(genome, LOCUS.MC1R);
    const R = (m1 === 1) + (m2 === 1);
    const r = (m1 === 2) + (m2 === 2);
    let redness = 0;
    if (R === 2) redness = 1;
    else if (R === 1 && r === 1) redness = 0.55;
    else if (R === 1) redness = 0.12;
    else if (r === 2) redness = 0.22;
    else if (r === 1) redness = 0.04;
    const mc1rLoss = clamp(R * 0.5 + r * 0.18, 0, 1);

    const skin = clamp(0.3 + g('skin'), 0.02, 0.97);
    const p = {
      sex,
      skin,
      mc1rLoss,
      iris: clamp(irisBase + g('eye'), 0, 1),
      lipo: clamp(0.15 + g('lipo') * 1.6, 0, 1),
      hair: clamp(0.5 + g('hair'), 0, 1),
      redness,
      freckles: clamp(g('freck') + R * 0.28 + r * 0.08, 0, 1),
      curl: clamp(0.17 + g('curl'), 0, 1),
      thick: clamp(0.4 + g('thick'), 0, 1),
      greyOnset: 52 + g('grey'),
      baldRisk: clamp(0.05 + g('bald'), 0, 1),
      beard: clamp(0.55 + g('beard'), 0, 1),
      brow: clamp(0.4 + g('brow'), 0, 1),
      mono: clamp(0.15 + g('mono'), 0, 1),
      lid: clamp(g('lid'), 0, 1),
      lobe: clamp(0.25 + g('lobe'), 0, 1),
      dimples: g('dimple') >= 0.99,
      cleft: g('cleft') >= 0.99,
      widow: g('widow') >= 0.99,
      hidden: [],
      why,
    };
    for (const k of ['faceW', 'faceL', 'jaw', 'chin', 'fhd', 'eyeS', 'eyeD', 'tilt', 'noseW', 'noseL', 'bridge', 'tip', 'lips', 'mouthW', 'earS']) {
      p[k] = clamp(0.5 + g(k), 0, 1);
    }

    // Recessive alleles carried but not expressed.
    if (blue === 1) p.hidden.push({ locus: 'HERC2', text: 'Carries one blue-eye allele' });
    if (R === 1 && r === 0) p.hidden.push({ locus: 'MC1R', text: 'Carries one red-hair allele' });
    const recessiveText = { DIMP: 'Has dimples but carries the no-dimple allele', CLEFT: 'Has a cleft chin but carries the smooth-chin allele', WIDOW: "Has a widow's peak but carries the straight-hairline allele", GEY: 'Carries the recessive blue allele at GEY' };
    for (const id in recessiveText) {
      const [a, b] = genotype(genome, LOCUS[id]);
      if (a !== b) p.hidden.push({ locus: id, text: recessiveText[id] });
    }
    if (sex === 'F') {
      const [a, b] = genotype(genome, LOCUS.AR);
      if (a === 0 || b === 0) p.hidden.push({ locus: 'AR', text: 'Carries an X-linked baldness-risk allele she can pass to sons' });
    }
    return p;
  }

  // ------------------------------------------------- names for phenotypes

  function eyeName(M, L) {
    const green = L >= 0.5;
    if (M < 0.07) return green ? 'Blue-green' : 'Light blue';
    if (M < 0.17) return green ? 'Green' : 'Blue';
    if (M < 0.3) return green ? 'Green' : 'Grey-blue';
    if (M < 0.47) return green ? 'Green-hazel' : 'Hazel';
    if (M < 0.62) return 'Light brown';
    if (M < 0.8) return 'Brown';
    return 'Dark brown';
  }

  function eyeGroup(M, L) {
    const n = eyeName(M, L);
    if (/blue/i.test(n) && n !== 'Blue-green') return 'Blue';
    if (/green/i.test(n) && n !== 'Green-hazel') return 'Green';
    if (/hazel/i.test(n)) return 'Hazel';
    if (n === 'Dark brown') return 'Dark brown';
    return 'Brown';
  }

  function hairName(E, red) {
    if (red >= 0.5) {
      if (E < 0.3) return 'Strawberry blond';
      if (E < 0.55) return 'Copper red';
      if (E < 0.8) return 'Auburn';
      return 'Dark auburn';
    }
    if (E < 0.12) return 'Platinum blond';
    if (E < 0.25) return 'Blond';
    if (E < 0.38) return 'Dark blond';
    if (E < 0.55) return 'Light brown';
    if (E < 0.72) return 'Brown';
    if (E < 0.87) return 'Dark brown';
    return 'Black';
  }

  function hairGroup(E, red) {
    if (red >= 0.5) return 'Red';
    if (E < 0.38) return 'Blond';
    if (E < 0.72) return 'Brown';
    return 'Black';
  }

  function curlName(c) {
    if (c < 0.22) return 'Straight';
    if (c < 0.44) return 'Wavy';
    if (c < 0.72) return 'Curly';
    return 'Coily';
  }

  function skinName(S) {
    const names = ['Very fair', 'Fair', 'Light', 'Light-medium', 'Medium', 'Medium-deep', 'Deep', 'Very deep'];
    return names[clamp(Math.floor(S * names.length), 0, names.length - 1)];
  }

  // Fitzpatrick type: sun reaction, driven by melanin and MC1R function.
  function fitzpatrick(S, mc1rLoss) {
    const v = S - mc1rLoss * 0.14;
    if (v < 0.05) return 'I';
    if (v < 0.13) return 'II';
    if (v < 0.25) return 'III';
    if (v < 0.42) return 'IV';
    if (v < 0.65) return 'V';
    return 'VI';
  }

  // -------------------------------------------------------- DNA codes

  // Compact text code of a genotype: sex + one digit per allele copy, hap by hap.
  function encode(genome) {
    const sex = sexOf(genome);
    const digits = [[], []];
    for (const L of LOCI) {
      const [a, b] = genotype(genome, L);
      digits[0].push(a);
      digits[1].push(b == null ? 0 : b);
    }
    return 'AA1-' + sex + '-' + digits[0].join('') + '-' + digits[1].join('');
  }

  function decode(code, founderId) {
    const m = /^AA1-([FM])-([0-9]+)-([0-9]+)$/.exec(String(code).trim());
    if (!m || m[2].length !== LOCI.length || m[3].length !== LOCI.length) return null;
    const sex = m[1];
    const g = founderGenome(sex, 'lab', founderId, mulberry32(1));
    for (let i = 0; i < LOCI.length; i++) {
      const L = LOCI[i];
      const n = L.alleles.length;
      const a = +m[2][i];
      const b = +m[3][i];
      if (a >= n || b >= n) return null;
      const pair = L.chr === 'X' ? g.sex : g[L.chr];
      pair[0].a[L.id] = a;
      if (pair[1].kind !== 'Y') pair[1].a[L.id] = b;
    }
    return g;
  }

  return {
    mulberry32, hashString, clamp,
    CHROMOSOMES, X_MB, Y_MB, RATE, POOLS, REGIONS, CATS, LOCI, LOCUS, LOCI_BY_CHR, FREQ,
    founderGenome, conceive, gamete, genotype, setAllele, cloneGenome, sexOf,
    traitSums, phenotype,
    eyeName, eyeGroup, hairName, hairGroup, curlName, skinName, fitzpatrick,
    encode, decode,
  };
});
