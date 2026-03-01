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
│   ├── parser/
│   │   ├── reader.ts          # BinaryReader — cursor-based, annotating reads
│   │   ├── primitives.ts      # FString, FName, FGuid, FEngineVersion, custom versions, etc.
│   │   ├── summary.ts         # FPackageFileSummary (the big header)
│   │   ├── dispatch.ts        # Detect asset class, route to the right parser
│   │   └── assets/
│   │       ├── static-mesh.ts
│   │       ├── texture2d.ts
│   │       ├── material.ts
│   │       └── ... (one file per asset class, added over time)
│   ├── viewer/
│   │   ├── hex-view.ts        # Renders hex rows with colored spans + virtual scroll
│   │   ├── legend.ts          # Right pane: table with swatch / name / value columns
│   │   └── segments.ts        # Computes DisplaySegment list from ByteRanges
│   ├── ui/
│   │   ├── app.ts             # Entry point: wires parser → viewer, handles file open
│   │   ├── menubar.ts         # Top menu bar (File, Options)
│   │   └── summary-panel.ts   # Plain-English summary card (shown in right column)
│   └── types.ts               # Shared types (ByteRange, ParseResult, etc.)
├── test/
│   ├── assets/                # Sample .uasset files for regression tests
│   └── parser/
│       ├── summary.test.ts
│       └── primitives.test.ts
├── index.html                 # Shell HTML (loads bundle)
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

* Begin by updating this file with the latest state of the project (for example double-check the Project Structure section and update it if any of the files have changed, etc.)
* Implement parser and output data to text
  * Update the parser and `dump.ts` to display more info about the collected data. For example
    - The output just lists the custom version entries as `Custom Version [N]`. I'd like to be able to see the GUID and the actual custom version number
    - The Names Table also only lists the names as `Name[N]`. This is not useful: I'd like to see the actual string too
    - Same for the Depends map, etc. etc. It's fine to just display the integer or whatever directly if you have nothing else better. For example the "Saved By Engine Version" display no value at all?
  * Continue trying to parse the property data from the UAssets
    - You were stuck trying to parse property tags and produced some code that fails the tests. I have disabled that code on dispatch.ts, line 58 by putting a `&& false)` within the if statement to disable it
    - If we don't disable that section the code just produces an error message like `Parse error: RangeError: Out of bounds access`: First, consider improving your error messages and just using asserts and producing a better stack trace for debugging. It's not clear what it even is trying to read, and when the out of bounds access occurred. Afterwards, try fixing this property tag parsing
  * After that, continue parsing the rest of the UObject file. Make sure *all the bytes in the file are understood and annotated*. However, note that you DO NOT need to parse data specific to each UObject type at this stage: For example UStaticMeshes will likely have the actual mesh data in there and serialized mesh description bulk data and so on. It's fine for that to be just annotated as "Static Mesh Data" or something like that at this point
* Implement HTML user interface (future)

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.