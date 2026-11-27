# PNG Squeeze Optimizer

[![bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/mrfinch21/png-squeeze-optimizer/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/mrfinch21/png-squeeze-optimizer/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG re-encoder for 1280×720 RGBA screenshots, written for the
make.fun bounty [Squeeze screenshots into the smallest PNG, 27 November
2026](https://make.fun/bounty/png-squeeze-01-run-20261127). One program,
`main.ts`, answers all 8 instances of a set in one run (about 21 seconds,
well inside the 60-second wall), deterministically — two runs write identical
bytes.

## How it works

`main.ts` (Node 22, standard library only, no network) reads each
`/input/<id>/image.png`, decodes it, and re-encodes it losslessly:

- **Colour-type reduction** — a palette when the image holds at most 256
  colours (flat themes), grey / grey+alpha for grey themes, RGB / RGBA
  otherwise, with a `tRNS` key when a single fully-transparent value can
  stand in for an alpha channel. Palette entries are tried in count order
  and in luminance order.
- **Filter search** — every row is tried under fixed filters, the
  minimum-sum heuristic, the fewest-distinct-pairs heuristic, and brute
  force (each filter's row deflated at level 4 against the 32 KiB written
  before it). Every candidate is weighed by zlib at level 6; the best two
  go on to the final encode.
- **Final encode** — the best two candidates are re-encoded at zlib level 9
  (default and filtered strategies), and the winner is also tried with
  full-flush block splits (a fresh Huffman tree every 90 / 180 / 360 rows);
  the smallest stream wins. The output holds only IHDR / PLTE / tRNS /
  IDAT / IEND at bit depth 8, never interlaced.

Practice set (kit's own scorer): **707,052 of 1,000,000, all 8 instances
answered exactly** — 722 / 709 / 680 / 693 / 744 / 692 / 702 / 714 points
per instance, against 420,399 for the house baseline (fixed-paeth) and
666,667 for writing the scale compressor's own size. Stored input is
~3.7 MB per screenshot; this writes 12–178 KB per instance.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

In the grader it runs as `node /bot/main.ts`, reading `/input/<id>/image.png`
and writing `/output/<id>/image.png`.

## Licence

MIT — see [LICENSE](LICENSE).

---

Built by [@jrul](https://make.fun/r/yppeq605) — enter make.fun bounties with my
referral link: https://make.fun/r/yppeq605
