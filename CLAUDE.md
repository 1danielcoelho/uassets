# General tips and guidelines

* The assets and code in this project largely follow Unreal Engine 5.7.3 (available at `./UnrealEngine-5.7.3-release`), which can be different from what was in your training data. Be careful with your assumptions! If at any time you are in doubt, **CHECK THE SOURCE CODE** and don't just assume that you did!
* This file is your main memory for this project, and includes a section below for `Current Plan`. Whenever you progress on the plan, make sure do update this file as well with at least a summary of the actual current plan, both with your findings and the next steps.
* Comments should always explain *why* something is done that way, and never explain *what* is done: The code itself should explain that. To achieve that, always use meaningful variable names (never abbreviations or single letters), and meaningful function and class names.
* Never use "separator" comments like `// ── Rows ──` or `// ─── Generic helpers ──`

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
│   │   ├── dump.ts            # CLI tool: dumps parsed annotations to stdout
│   │   └── harvest-guids.ts   # CLI tool: extracts custom version GUIDs from UE source
│   ├── parser/
│   │   ├── reader.ts          # BinaryReader — cursor-based, annotating reads
│   │   ├── types.ts           # UE primitive interfaces (FGuid, FEngineVersion, FObjectExport, etc.)
│   │   ├── utils.ts           # Shared helpers (readFName, resolveClass, fGuidToString, etc.)
│   │   ├── enums.ts           # Enum and flags value→name mappings
│   │   ├── custom-version-guids.ts  # GUID→name lookup for custom version entries
│   │   ├── summary.ts         # parsePackageFileSummary — fixed header only
│   │   ├── parser.ts          # parseUAsset — main orchestrator + all segment parsing functions
│   │   ├── dispatch.ts        # Class-specific parser registry and dispatch
│   │   ├── tagged-properties.ts  # FProperty / FPropertyTag parsing
│   │   ├── compressed-buffer.ts  # FCompressedBuffer header parsing
│   │   └── assets/            # Class-specific export parsers (registered via dispatch.ts)
│   │       ├── blueprint.ts
│   │       ├── material.ts
│   │       ├── static-mesh.ts
│   │       ├── texture2d.ts
│   │       └── world.ts
│   ├── ui/
│   │   ├── app.ts             # File open/drop wiring, summary panel rendering, dev auto-load
│   │   ├── hex-view.ts        # Canvas-based virtual-scrolling hex viewer with color-coded byte ranges
│   │   ├── annotation.ts      # Annotation table (swatch/size/name/value columns, collapsible groups)
│   │   ├── minimap.ts         # File overview minimap — canvas thumbnail of color map + viewport indicator
│   │   └── utils.ts           # Search, color derivation, range building, shared UI helpers
│   └── types.ts               # Shared types (ByteRange, ParseResult, AssetSummary, etc.)
├── test/
│   ├── assets/                # Sample .uasset/.umap files for regression tests, organized by UE version
│   │   ├── 4_15/
│   │   ├── 4_20/
│   │   ├── 4_21/
│   │   ├── 4_24/
│   │   ├── 4_27_2/
│   │   ├── 5_0/
│   │   ├── 5_1/
│   │   ├── 5_2/
│   │   ├── 5_3_2/
│   │   ├── 5_4_4/
│   │   ├── 5_5_4/
│   │   ├── 5_6_1/
│   │   └── 5_7_3/
│   └── parser/
│       └── parse-all.test.ts
├── index.html                 # Full UI shell (menu bar, hex column, minimap, right panel)
├── dev.ts                     # Bun dev server with live-reload SSE
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│  [File ▾]  [Options ▾]   uasset viewer                                │  ← menu bar
├────────────────────────────────┬───┬──────────────────────────────────┤
│                                │ M │  Summary                         │
│  HEX VIEW (canvas)             │ I │  UStaticMesh — /Game/.../SM_Hero │
│  00000000: 9E 2A 83 C1 ...     │ N │  Engine: 5.3.2 (CL 27405482)     │
│  [color-coded bytes]           │ I ├──────────────────────────────────┤
│  [unannotated = neutral bg]    │ M │  Annotations                     │
│                                │ A │  ┌──┬──────┬─────────────┬─────┐ │
│  ... (199 MB, Bulk Data) ...   │ P │  │■ │Bytes │ Name        │ Val │ │
│                                │   │  │■ │  4 B │ Magic Num.  │ ... │ │
│                                │   │  └──┴──────┴─────────────┴─────┘ │
└────────────────────────────────┴───┴──────────────────────────────────┘
```

- Menu bar spans full width
- Left column: hex view (canvas-rendered, scrollable, takes remaining height)
- Center column: minimap (canvas thumbnail of color map + viewport indicator, click/drag to seek)
- Right column: summary card (fixed height) + annotation table (scrollable, fills remaining)

### Bytes per row
- Configurable constant `BYTES_PER_ROW` (default 16), not hardcoded throughout
- Changing it recalculates all row positions

### All bytes are shown
- Every byte in the file has a color: either its annotation's color, or a default neutral background
- No bytes are silently skipped — unknown regions are rendered with "unannotated" styling

### Virtual scrolling (hex view)
- The hex view renders to a `<canvas>` element using a sticky-position trick: the canvas stays fixed in the viewport while a tall spacer div drives the scrollbar
- Row height is fixed (simplifies math); only visible rows are repainted on each animation frame
- Canvas is redrawn on scroll via `requestAnimationFrame`

### Annotation table
- A `<table>` element with columns: `[swatch]` | `[Bytes]` | `[Name]` | `[Value]`
- `table-layout: fixed` — columns never auto-resize based on content; long names get ellipsis
- Groups are collapsible; clicking a group row expands/collapses its direct children
- Collapse state is derived from DOM visibility (not a closure boolean) so that collapsing a parent
  and re-expanding it leaves inner groups in a correctly-collapsed state (icons + toggle behavior)
- Clicking an annotation row scrolls the hex view to that byte range

### Summary Panel

A card in the top-right, above the annotation table. Built from `AssetSummary`

> **UStaticMesh** — `/Game/Characters/Hero/SM_Hero`
> Engine 5.3.2 (CL 27405482)
> 3 LODs · 1 material slot · 4.2 MB bulk mesh data
> Custom versions: Niagara 38, Chaos Physics 12, ...

Asset-specific properties (LOD count, material slots, etc.) are populated lazily as exports are parsed.

## Next steps

- **Test with cooked assets**: Cooked assets have different kinds of data in them. We should have some samples of assets cooked for a game (maybe the same asset types?)
- **Reverse Oodle compression of package trailer data**: The editor data for a static mesh asset (in the package trailer) is Oodle compressed: We can only parse some primitive compressed headers. It would be cool if we could uncompress it to show the underlying data somehow, maybe? Not sure if I want this though, because at that point we're not really showing the file contents anymore, are we?
- **Dereferencing the pointer-like types**: Some kinds of values are kind of like "pointers" to other areas in the binary, like how how for static meshes the StaticMaterial just has FNames for MaterialSlotName and ImportedMaterialSlotName. The display for the FName is just "Name Index" and "Name Number". It would be cool if this was also displayed as what the actual name string would have been (e.g. third entry in the name map with a suffix of _0). I think soft object paths are also indices into a list somewhere. Maybe at some other points we get fields that just point at an index on the exports/imports map that we could "resolve" to also display as the text of what that is pointing at, etc. This is mainly a convenience thing

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
