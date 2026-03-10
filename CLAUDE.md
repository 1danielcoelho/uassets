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
│   │   ├── types.ts           # UE primitive interfaces (FGuid, FEngineVersion, FObjectExport, etc.)
│   │   ├── utils.ts           # Shared helpers (resolveName, resolveClass, fGuidToString, etc.)
│   │   ├── summary.ts         # parsePackageFileSummary — fixed header only
│   │   ├── parser.ts          # parseUAsset — main orchestrator + all segment parsing functions
│   │   ├── dispatch.ts        # Class-specific parser registry and dispatch
│   │   └── tagged-properties.ts  # FProperty / FPropertyTag parsing
│   ├── ui/
│   │   ├── app.ts             # File open/drop wiring, summary panel rendering, dev auto-load
│   │   ├── hex-view.ts        # Virtual-scrolling hex viewer with color-coded byte ranges
│   │   └── legend.ts          # Legend table (swatch/size/name/value columns, collapsible groups)
│   └── types.ts               # Shared types (ByteRange, ParseResult, AssetSummary, etc.)
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
├── index.html                 # Full UI shell (menu bar, hex column, right panel)
├── dev.ts                     # Bun dev server with live-reload SSE
├── package.json
├── tsconfig.json
└── bunfig.toml
```

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
- A `<table>` element with columns: `[swatch]` | `[Bytes]` | `[Name]` | `[Value]`
- `table-layout: fixed` — columns never auto-resize based on content; long names get ellipsis
- Groups are collapsible; clicking a group row expands/collapses its direct children
- Collapse state is derived from DOM visibility (not a closure boolean) so that collapsing a parent
  and re-expanding it leaves inner groups in a correctly-collapsed state (icons + toggle behaviour)
- Clicking a legend row scrolls the hex view to that range (TODO: not yet implemented)

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

## State of parser

The parser is fully refactored and all 6 test assets pass (6/6).

**Parser file layout:**
- `src/parser/types.ts` — UE primitive interfaces (FGuid, FEngineVersion, FObjectExport, FObjectImport, etc.)
- `src/parser/utils.ts` — resolveName, resolveClass, fGuidToString, fEngineVersionToString
- `src/parser/summary.ts` — parsePackageFileSummary (fixed header only) + UE version constants
- `src/parser/parser.ts` — parseUAsset orchestrator + segment functions (parseNamesTable,
  parseImportsTable, parseExportsTable, parseIndexTables, parseOpaqueBlobs, parseMetadata,
  parseGenericExport)
- `src/parser/dispatch.ts` — class-specific parser registry; dispatchExport returns bool
- `src/parser/tagged-properties.ts` — FPropertyTag parsing (UE5 new + old format)

**Sections parsed and annotated:**
- Package Header (magic, file versions UE4/UE5, package flags, package name/group) — all one group
- Thumbnail Table (TOC + image data blobs — JPEG/PNG with dimensions)
- Names Table (FString name + case-preserving hash per entry)
- Soft Object Paths, Gatherable Text Data, Import Map, Export Map
- Cell Export Map, Cell Import Map, Depends Map (with resolved object names)
- Soft Package References, Searchable Names
- Asset Registry Data (DependencyDataOffset + object+tag records + dependency blob)
- World Tile Info (opaque blob)
- Preload Dependency Data, Data Resource Map, Import Type Hierarchies
- Metadata (NumObjectMeta + NumRootMeta entries with int32 soft path index + TMap<FName,FString>)
- Exports Footer Tag (0x9E2A83C1 at bulkDataStartOffset)
- PackageTrailer (FHeader + FLookupTableEntry × N + payload blobs + FFooter)
- Exports group → per-export group → Properties group → per-property group + Export Tail

## Next steps

- **Resizeable divider** — Between the hex view and the legend view
- **Example assets** — Instead of just placeholder text, show buttons for easily opening example assets, so maybe have it say something like "File -> Open to open a .uasset file or click one of these examples:" and have some buttons after it for SM_Cube.uasset and the other samples
- **Hunt for the missing annotation** — If you look at the parsed output for SM_Cube.uasset (and the other assets), you'll find segments without annotation. For example before the imports table there seems to be some kind of ASCII GUID and some other bytes. Each Export of the export table, when expanded in the UI, also shows mostly unannotated bytes, only displaying a handful of the 112 bytes as annotated. What are the other bytes in these cases? Surely they mean something. Another example is the big segment between `Exports Footer Tag` and the `Asset Registry Dependency D..` (can't see the full text in the UI). There are a bunch of bytes there. What are those? So the goal for this section is to perform this task and catalog all the missing bytes you can find. The UE source code is here, it should be possible to annotate every single byte. Note that you still don't need to dive into asset-specific stuff just yet (like UStaticMesh-specific mesh data for example)

## Polishing steps

- **Contiguous selection** — This may be very difficult or make a mess, so feel free to push back, but it would be nice if doing a text select that starts on the bytes (raw) column only selected stuff in the bytes (raw) column. As it is now, doing a text selection treats the address, bytes (raw) and bytes (ascii) text as contiguous, which is not right
- **Sync selection** — I don't want to mess with the standard mouse behavior too much, but it would be nice if selecting a section on the bytes (raw) view selected the same section on the bytes (ascii) view in some (visual) way. It doesn't have to add it to the actual selection, but at least highlight it so that we know what corresponds to what. The same would happen when selecting something on the Bytes (ascii) view

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.