/**
 * Snapshot regression tests for all assets found under test/assets/.
 *
 * First run: bun test test/parse-all.test.ts
 *   → writes snapshots to test/__snapshots__/parse-all.test.ts.snap
 * Subsequent runs: compares against those snapshots.
 * After adding new parser coverage: bun test --update-snapshots
 */

import { test, expect } from "bun:test";
import { Glob } from "bun";
import { parseUAsset } from "../../src/parser/parser.ts";
import type { ParseResult, ByteRange } from "../../src/types.ts";

// ── Asset discovery ───────────────────────────────────────────────────────────

const ASSETS = [...new Glob("**/*.{uasset,umap}").scanSync({ cwd: "test/assets" })]
  .map(f => `test/assets/${f}`)
  .sort();

// ── Coverage helper ───────────────────────────────────────────────────────────

function coveragePct(result: ParseResult): number {
  function flatten(ranges: ByteRange[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const r of ranges) {
      out.push([r.start, r.end]);
      if (r.kind === "group" && r.children.length > 0) {
        out.push(...flatten(r.children));
      }
    }
    return out;
  }

  const intervals = flatten(result.ranges).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curStart = -1;
  let curEnd   = -1;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      if (curStart >= 0) covered += curEnd - curStart;
      curStart = s;
      curEnd   = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curStart >= 0) covered += curEnd - curStart;
  return result.totalBytes > 0 ? (covered / result.totalBytes) * 100 : 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

for (const assetPath of ASSETS) {
  test(assetPath, async () => {
    const buf    = await Bun.file(assetPath).arrayBuffer();
    const result = parseUAsset(buf);

    // Structural snapshot: catches regressions in summary fields
    expect(result.summary).toMatchSnapshot();

    // Coverage floor: ensures we don't silently drop annotations.
    // UE4 textures store mipmap pixel data in a separate bulk region outside of
    // exports, so large legacy assets legitimately have < 5% header coverage.
    // For files ≥ 1 MB the floor is 0.5%; smaller files must hit 20%.
    const cov = coveragePct(result);
    const floor = result.totalBytes >= 1_000_000 ? 0.5 : 20;
    expect(cov).toBeGreaterThan(floor);
  });
}
