# Allele Atelier

A genetics-driven 2D portrait creator. Every face is grown from a simulated
diploid human genome: pick two founders, conceive children, and watch alleles,
dominance, linkage and crossovers decide who looks like whom.

Open `index.html` in a browser. There is no build step and no dependency
beyond Google Fonts.

## What it does

- **Founders from gene pools.** Each new parent is drawn from a gene pool
  (Northern Europe, West Africa, East Asia, a global mosaic, a 50/50 lab stock
  and others) with rough per-region allele frequencies.
- **Real meiosis.** 22 autosomes plus X/Y, sex-specific Poisson crossovers
  (about 1.55 cM/Mb in eggs, 0.9 cM/Mb in sperm), X-linked inheritance, and an
  adjustable mutation rate. Identical twins share one genome.
- **Odds before birth.** 1,000 simulated conceptions show the eye colour, hair
  colour, texture and skin-tone spread to expect from the current couple.
- **Specimen sheet.** For anyone in the family: traits with the genotypes
  behind them, hidden recessive alleles, an editable genotype table (click an
  allele to change it), and a karyotype that colours every stretch of DNA by
  the founder chromosome it came from.
- **Generations.** Raise any child as a parent; a new founder partner joins
  and the earlier generations stay in the pedigree.
- **Appearance.** Age (3 to 90: childhood blondness, greying, balding,
  wrinkles), sun exposure (tanning, or freckling and burning for MC1R
  variants), expression, hairstyle and facial hair.
- **Export.** Save a portrait as PNG or SVG, or copy a person's DNA code and
  paste it back in later as a founder.

## The model

64 loci, 24 of them named genes with published trait associations, placed at
approximate GRCh38 positions:

| Trait | Loci |
|---|---|
| Skin | *SLC24A5*, *SLC45A2*, *OCA2* (His615Arg), *TYR*, *MFSD12*, *IRF4*, *MC1R* + polygenic background |
| Eyes | *HERC2* rs12913832 (the blue/brown switch), *OCA2* rs1800407, *SLC24A4*, *TYR*, *IRF4*, classic *GEY* |
| Hair colour | *MC1R* (R and r variants), *KITLG* rs12821256, the pigment genes above + background |
| Hair texture | *TCHH*, *EDAR* 370A, *PRSS53* + background |
| Greying, baldness, beard | *IRF4*, X-linked *AR*, 20p11, *EDAR* |
| Face and features | *PAX3*, *FOXL2*, *GLI3*, *PAX1*, *RUNX2*, *DCHS2*, *ADGRG6* + background |
| Classroom traits | dimples, cleft chin, widow's peak (textbook dominant model) |

Effect sizes are illustrative and hand-tuned. Loci tagged *unmapped* stand in
for the many small-effect variants behind polygenic traits. Morphology loci use
the same frequencies in every gene pool.

## Files

- `js/genome.js` – loci, gene pools, meiosis, phenotype. Runs in Node too.
- `js/portrait.js` – procedural SVG portrait renderer.
- `js/app.js` – family state and UI.
- `tests/genome.test.js` – Mendelian ratios, X-linkage, linkage vs distance,
  crossover counts, DNA-code round trips, renderer smoke tests.
- `tools/build_artifact.py` – bundles everything into one HTML file.

```sh
npm test                 # or: node --test tests/genome.test.js
npm run build            # writes dist/allele-atelier.html (single file)
```
