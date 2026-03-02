import { watch } from "fs";

const PORT = 3000;
const RELOAD_SNIPPET = `<script>
  const __es = new EventSource("/__reload");
  __es.onmessage = () => location.reload();
</script>`;

// SSE clients waiting for reload events
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function notifyClients() {
  const msg = new TextEncoder().encode("data: reload\n\n");
  for (const client of clients) {
    try { client.enqueue(msg); } catch { clients.delete(client); }
  }
}

async function rebuild(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: ["./index.html"],
    outdir: "./dist",
  });
  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) console.error(" ", log);
    return false;
  }
  return true;
}

// Initial build
console.log("Building...");
await rebuild();
console.log("Done. Starting dev server...");

// Watch src/ and index.html for changes
let debounce: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(async () => {
    process.stdout.write("Rebuilding... ");
    const ok = await rebuild();
    if (ok) {
      console.log("done.");
      notifyClients();
    }
  }, 50);
}

watch("./src", { recursive: true }, scheduleRebuild);
watch("./index.html", scheduleRebuild);

// HTTP server
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // SSE live-reload endpoint
    if (url.pathname === "/__reload") {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { ctrl = c; clients.add(c); },
        cancel() { clients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Map "/" to index.html
    const filePath = url.pathname === "/"
      ? "./dist/index.html"
      : `./dist${url.pathname}`;

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    // Inject reload snippet into HTML responses
    if (filePath.endsWith(".html")) {
      const html = (await file.text()).replace("</body>", `${RELOAD_SNIPPET}</body>`);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    return new Response(file);
  },
});

console.log(`Dev server: http://localhost:${PORT}`);
