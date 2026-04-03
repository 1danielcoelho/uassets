import type { ColoredRange } from "./utils.ts";

export interface MinimapHandle {
  updateColorMap(ranges: ColoredRange[]): void;
  updateViewport(scrollTop: number, clientHeight: number, totalScrollHeight: number): void;
}

let currentAbort: AbortController | null = null;

export function initMinimap(
  container: HTMLElement,
  initialColorMap: ColoredRange[],
  totalBytes: number,
  onSeek: (scrollTop: number) => void,
): MinimapHandle {
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  container.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;cursor:pointer;";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  let colorMap = initialColorMap;
  let vpScrollTop = 0;
  let vpClientHeight = 0;
  let vpTotalScrollHeight = 1;
  let cssW = 0;
  let cssH = 0;
  let rafId = 0;

  function requestDraw(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }
  signal.addEventListener("abort", () => { if (rafId) cancelAnimationFrame(rafId); });

  function resize(w: number, h: number): void {
    cssW = w; cssH = h;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }

  function draw(): void {
    if (cssW === 0 || cssH === 0 || totalBytes === 0) return;
    ctx.clearRect(0, 0, cssW, cssH);

    // Background
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, cssW, cssH);

    // Colored annotation ranges
    for (const cr of colorMap) {
      const yTop = (cr.start / totalBytes) * cssH;
      const yBot = (cr.end   / totalBytes) * cssH;
      ctx.fillStyle = cr.color;
      ctx.fillRect(0, yTop, cssW, Math.max(1, yBot - yTop));
    }

    // Viewport indicator
    if (vpTotalScrollHeight > 0 && vpClientHeight < vpTotalScrollHeight) {
      const vTop = (vpScrollTop / vpTotalScrollHeight) * cssH;
      const vH   = Math.max(2, (vpClientHeight / vpTotalScrollHeight) * cssH);
      const clampedH = Math.min(cssH - vTop, vH);

      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, vTop, cssW, clampedH);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, vTop + 0.5, cssW - 1, clampedH - 1);
    }
  }

  const ro = new ResizeObserver(entries => {
    const e = entries[0];
    if (!e) return;
    const { width, height } = e.contentRect;
    if (width > 0 && height > 0) resize(width, height);
  });
  ro.observe(container);
  signal.addEventListener("abort", () => ro.disconnect());

  // Drag/click to seek
  let dragging = false;

  function seekAt(clientY: number): void {
    if (vpTotalScrollHeight <= 0 || cssH === 0) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientY - rect.top) / cssH));
    const targetTop = frac * vpTotalScrollHeight - vpClientHeight / 2;
    onSeek(Math.max(0, targetTop));
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    seekAt(e.clientY);
    e.preventDefault();
  }, { signal });

  const onMouseMove = (e: MouseEvent) => { if (dragging) seekAt(e.clientY); };
  const onMouseUp   = (e: MouseEvent) => { if (e.button === 0) dragging = false; };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup",   onMouseUp);
  signal.addEventListener("abort", () => {
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup",   onMouseUp);
  });

  return {
    updateColorMap(ranges): void { colorMap = ranges; requestDraw(); },
    updateViewport(scrollTop, clientHeight, totalScrollHeight): void {
      vpScrollTop         = scrollTop;
      vpClientHeight      = clientHeight;
      vpTotalScrollHeight = totalScrollHeight;
      requestDraw();
    },
  };
}
