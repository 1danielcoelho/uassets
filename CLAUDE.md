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

## Next steps

- **Test with cooked assets**: Cooked assets have different kinds of data in them. We should have some samples of assets cooked for a game (maybe the same asset types?)
- **Reverse Oodle compression of package trailer data**: The editor data for a static mesh asset (in the package trailer) is Oodle compressed: We can only parse some primitive compressed headers. It would be cool if we could uncompress it to show the underlying data somehow, maybe? Not sure if I want this though, because at that point we're not really showing the file contents anymore, are we?
- **Display enums as strings on the annotation view**: Whenever we have enums or flag values deserialized, we should display the string value too (e.g. "3 (EMethod::Oodle)" instead of just "3", or maybe Public | Standalone, etc. instead of just "0" for package flags)

## Polishing steps

- **Remove the automated tests that are inside the UE source**: Those are run when we do `bun test` and are always failing, causing Claude to lose a couple cycles
- **Property Type field has no displayed value**: Some properties like UsdAssetUserData / Properties / PrimPaths / Type have no actual value for the type, even though it consumes 24 bytes? Surely we can display something
- **Dereferencing the pointer-like types**: Some kinds of values are kind of like "pointers" to other areas in the binary, like how how for static meshes the StaticMaterial just has FNames for MaterialSlotName and ImportedMaterialSlotName. The display for the FName is just "Name Index" and "Name Number". It would be cool if this was also displayed as what the actual name string would have been (e.g. third entry in the name map with a suffix of _0). I think soft object paths are also indices into a list somewhere. Maybe at some other points we get fields that just point at an index on the exports/imports map that we could "resolve" to also display as the text of what that is pointing at, etc. This is mainly a convenience thing
- **Annotation scroll margin**: I want there to be some extra padding space after all the entries in the annotation. It's helpful because if you're exploring the items at the bottom of the list, the elements you're looking at are otherwise at the very bottom of the screen, and you can't scroll them up further: You have to expand a child, scroll up, expand another, scroll up, etc. It would be nice to be able to "overscroll" so that the last item of the list is visibly now at the top of the list viewport area and I can just expand, expand, expand the children without needing to scroll
- **Annotation overflow**: It's very easy for the value (or key) text of an annotation to be too long to fit on the display. It would be nice if we could mouse over it to show the full text in a tooltip of some kind, or display it on the right-click menu somehow, or something like that. I just want to be able to view the full text if possible. There should be some safety checks here too, because this may be a binary blob that is too large to display properly even with this mechanism. Maybe we could add this tooltip AND new options on the right-click menu to `Copy name` and `Copy value`?
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