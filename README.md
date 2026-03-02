# uasset viewer

Client-side web app that parses Unreal Engine `.uasset` / `.umap` files in the browser and displays a hex view with annotated byte ranges and a summary panel. No backend — runs entirely in the browser.

## Commands

| Command | Description |
|---|---|
| `bun run dev` | Start dev server at `http://localhost:3000` with live reload |
| `bun run build` | Bundle to `dist/` for deployment |
| `bun run test` | Run parser unit tests |
| `bun run dump <file.uasset>` | Dump parsed annotations to stdout |
