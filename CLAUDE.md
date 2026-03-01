# General tips and guidelines

* The assets and code in this project largely follow Unreal Engine 5.7.3 (available at `./UnrealEngine-5.7.3-release`), which can be different from what was in your training data. Be careful with your assumptions! If at any time you are in doubt, *CHECK THE SOURCE CODE* and don't just assume that you did!
* This file is your main memory for this project, and includes a section below for `Current Plan`. Whenever you progress on the plan, make sure do update this file as well with at least a summary of the actual current plan, both with your findings and the next steps.

# UAsset Viewer

## Project description

Fully client-side static webapp (no backend) that accepts Unreal Engine `.uasset` files via drag-and-drop/upload, parses them in the browser, and presents:
1. A **summary panel** describing the asset type and key properties in plain English
2. A **binary hex viewer** with color-coded byte ranges and a legend pane explaining each region

Hosted on GitHub Pages. No server required — all parsing runs in the user's browser via JavaScript.

## Tech Stack

- **Bun** — package manager, dev server, and bundler (`bun build`)
- **TypeScript** — all source for the shipped webapp (+HTML/CSS of course). Feel free to use other languages for utility scrips if you need though
- **No framework** — vanilla DOM for now; this keeps the bundle small and avoids framework overhead for what is fundamentally a data visualization tool
- **Bun's built-in test runner** — unit tests for parsing logic, asset tests
- **Output**: `dist/index.html` + `dist/bundle.js` (or inlined), deployable to GitHub Pages


## Project Structure

```
uassets/
├── src/
│   ├── cli/
│   │   └── dump.ts            # CLI tool: dumps parsed annotations to stdout
│   ├── parser/
│   │   ├── reader.ts          # BinaryReader — cursor-based, annotating reads
│   │   ├── primitives.ts      # FString, FName, FGuid, FEngineVersion, custom versions, etc.
│   │   ├── summary.ts         # FPackageFileSummary (the big header) + all structured sections
│   │   ├── dispatch.ts        # Detect asset class, route to the right parser
│   │   └── tagged-properties.ts  # FProperty / FPropertyTag parsing (WIP)
│   └── types.ts               # Shared types (ByteRange, ParseResult, etc.)
├── test/
│   ├── assets/5_7_3/          # Sample UE 5.7.3 .uasset/.umap files for regression tests
│   │   ├── Blueprint.uasset
│   │   ├── M_CustomMaterial.uasset
│   │   ├── MI_TextureMaterial.uasset
│   │   ├── MyMap.umap
│   │   ├── SM_cube.uasset
│   │   └── T_shapes.uasset
│   └── parser/
│       └── parse-all.test.ts
├── index.html                 # Shell HTML (loads bundle) — not yet implemented
├── package.json
├── tsconfig.json
└── bunfig.toml
```

Note: The viewer/UI files (hex-view.ts, legend.ts, app.ts, etc.) do not exist yet — that's a future milestone.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  [File ▾]  [Options ▾]   uasset viewer                          │  ← menu bar
├──────────────────────────────┬──────────────────────────────────┤
│                              │  Summary                         │
│  HEX VIEW                    │  UStaticMesh — /Game/.../SM_Hero │
│  00000000: 9E 2A 83 C1 ...   │  Engine: 5.3.2 (CL 27405482)     │
│  [colored spans]             ├──────────────────────────────────┤
│  [unannotated = default bg]  │  Legend                          │
│                              │  ┌──┬─────────────┬───────────┐  │
│  ... (199 MB, Bulk Data) ... │  │■ │ Name        │ Value     │  │
│                              │  │■ │ Magic Num.  │ 9E2A83C1  │  │
│                              │  │░ │ Pkg Name    │ /Game/... │  │ ← grayed = off-screen
│                              │  └──┴─────────────┴───────────┘  │
└──────────────────────────────┴──────────────────────────────────┘
```

- Menu bar spans full width
- Left column: hex view (scrollable, takes remaining height)
- Right column: summary card (fixed height) + legend table (scrollable, fills remaining)

### Bytes per row
- Configurable constant `BYTES_PER_ROW` (default 16), not hardcoded throughout
- Changing it recalculates all row positions

### All bytes are shown
- Every byte in the file has a color: either its annotation's color, or a default neutral background
- No bytes are silently skipped — unknown regions are rendered with "unannotated" styling

### Virtual scrolling
- The scroll container has a fixed pixel height; a "spacer" div is sized to the total virtual height
- Only ~100–200 rows are in the DOM at once; on scroll events the render window shifts
- Row height is fixed (simplifies math); ellipsis rows count as 1 row height
- `IntersectionObserver` on legend table rows: grays out entries whose byte ranges are entirely outside the current hex view viewport

### Legend table
- A `<table>` element with columns: `[swatch]` | `[Name]` | `[Value]`
- Initially: those three columns. Additional columns (Start, Size, Type) can be added later without structural changes
- Clicking a legend row scrolls the hex view to that range

### Summary Panel

A card in the top-right, above the legend. Built from `AssetSummary`

> **UStaticMesh** — `/Game/Characters/Hero/SM_Hero`
> Engine 5.3.2 (CL 27405482)
> 3 LODs · 1 material slot · 4.2 MB bulk mesh data
> Custom versions: Niagara 38, Chaos Physics 12, ...

Asset-specific properties (LOD count, material slots, etc.) are populated lazily as exports are parsed.

## UI Framework & State

**Vanilla DOM** — no framework. State model is simple:
- `ParseResult` — produced once per file open, then mutated only by lazy `resolve()` calls expanding byte ranges
- `ViewerState` — mutable: `{ scrollTop, hoveredRangeId, visibleRangeIds }` — drives targeted DOM updates (highlight hex row ↔ legend row, gray out off-screen legend entries)

Menu bar items:
- **File → Open** — triggers `<input type="file" accept=".uasset,.umap">` click
- **Options → Bytes per row** — number input, updates `BYTES_PER_ROW`, recomputes display segments and re-renders
- **Options → Theme** — light/dark (future)

# Current plan

## State of parser (summary.ts)

The parser in `src/parser/summary.ts` fully parses the FPackageFileSummary header and all
structured sections that follow it. Coverage is 100% for 5 of 6 test assets.

**Sections parsed and annotated:**
- Magic number, file versions (UE4/UE5), package flags, package name/group
- Thumbnail Table (TOC + image data blobs — JPEG/PNG with dimensions)
- Names Table (FString name + case-preserving hash per entry)
- Soft Object Paths, Gatherable Text Data, Import Map, Export Map
- Cell Export Map, Cell Import Map, Depends Map
- Soft Package References, Searchable Names
- Asset Registry Data (DependencyDataOffset + object+tag records + dependency blob)
- World Tile Info (opaque blob)
- Preload Dependency Data, Data Resource Map, Import Type Hierarchies
- Metadata (NumObjectMeta + NumRootMeta entries with FSoftObjectPath + TMap<FName,FString>)
- Exports Footer Tag (0x9E2A83C1 at bulkDataStartOffset)
- PackageTrailer (FHeader + FLookupTableEntry × N + payload blobs + FFooter)
- Export object data (property tags loop + object-specific data region)

**Known issue — Blueprint.uasset metadata parsing fails:**
- Error: `Out of bounds: tried to read 1157641728 bytes at offset 0x2B45`
- Root cause: `SoftObjectPathLoadSubPathWorkaround` in UE source — for assets with
  `FFortniteMainBranchObjectVersion < SoftObjectPathUtf8SubPaths`, the `SubPath` component
  of `FSoftObjectPath` is serialized as FWideString (UTF-16LE) rather than a normal FString.
  The 4-byte length prefix `00 36 00 45` is read as a little-endian int32 = 1157641728 (garbage).
- Fix: check the `FFortniteMainBranchObjectVersion::SoftObjectPathUtf8SubPaths` custom version
  entry value in the file. If it is below the threshold (check UE source for the version number),
  use a wide-string reader for sub-paths instead of `readFString`.

**dispatch.ts note:**
- Property tag parsing is partially implemented in `tagged-properties.ts` and called from
  `dispatch.ts`. The call is currently gated with `&& false` (line ~58) to disable it while
  it is being debugged. This needs to be fixed and re-enabled.

## Next steps

1. **Fix Blueprint metadata** — implement `SoftObjectPathLoadSubPathWorkaround` detection
   (check Fortnite custom version) and read wide-string sub-paths when needed
2. **Fix property tag parsing** — re-enable the disabled code in `dispatch.ts`, debug the
   remaining out-of-bounds reads in `tagged-properties.ts`, and ensure all property tags
   are parsed for all test assets
3. **Annotate all export object bytes** — after property tags, annotate any remaining bytes
   in each export as asset-class-specific data (e.g., "Static Mesh Data"), so that 100%
   of bytes are annotated for all test assets
4. **Improve dump.ts output** — make sure all the entries in the raw output display some
   useful value (for example the imports table just displays `Import[0]` right now, which
   is not useful. There may be other fields that are incomplete in this way)
4. **Implement HTML user interface** (future milestone)

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.