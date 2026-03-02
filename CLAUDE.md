# General tips and guidelines

* The assets and code in this project largely follow Unreal Engine 5.7.3 (available at `./UnrealEngine-5.7.3-release`), which can be different from what was in your training data. Be careful with your assumptions! If at any time you are in doubt, **CHECK THE SOURCE CODE** and don't just assume that you did!
* The above rule is very important: Every time you are stuck for more than a few paragraphs on an issue, stop what you're doing and read all of the the relevant code until you understand what is happening, without guessing.
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
structured sections that follow it. All 6 test assets pass (6/6).

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
- Metadata (NumObjectMeta + NumRootMeta entries with int32 soft path index + TMap<FName,FString>)
- Exports Footer Tag (0x9E2A83C1 at bulkDataStartOffset)
- PackageTrailer (FHeader + FLookupTableEntry × N + payload blobs + FFooter)
- Export object data (property tags loop + object-specific data region)

## Next steps

- **General cleanup**
   - `parseUAsset` has outgrown summary.ts: Make a dedicated file for the parser where that function
     can live. You can then make a separate function for parsing the package summary, and call it from
     `parseUAsset`. Pull out into that function only what is part of the summary itself though
   - On parser, make functions for the other segments of the UObject, like exports and imports table,
     metadata, etc. Then invoke them from the main `parseUAsset` function
   - Move those `resolveName` and `resolveClass` to a separate `utils` file
   - Move the `fGuidToString` and `fEngineVersionToString` functions to the utils file too (or make them members
     of the FGuid / FEngineVersion interfaces somehow? I'm not sure what the best practice for Typescript is here)
   - If the `primitives.ts` is left with only interface declarations after the previous step, rename it to `types.ts`
   - Should there be one for soft object paths inside the linker load as well? Note how we track `softObjectPaths`
     for the metadata parsing section for example
   - I don't like how `dispatchExport` does part of the generic UObject parsing for the export, like handling the
     tagged properties. The "dispatch" should only be about having code specific to each UAsset type (whenever we get
     to implementing that), like UStaticMesh-specific bytes, UMaterial bytes, etc. All generic UAsset parsing
     should be on parser.ts, and moved to a dedicated function that `parseUAsset` calls, if it gets too big
   - On the dump.ts output, you indent lines for annotations inside groups by adding the indent way on the start
     of the line. This makes it a bit difficult to read. Make sure the colored square, the address, and the size
     are always aligned, but only indent the annotation name itself (the value should not be indented either)
- **Implement HTML user interface** — this is the next major milestone. See the layout
   description above for the planned hex view + summary + legend layout.
   Key files to create: `src/ui/app.ts`, `src/ui/hex-view.ts`, `src/ui/legend.ts`

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.