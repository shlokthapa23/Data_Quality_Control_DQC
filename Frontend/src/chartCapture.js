/**
 * Turning the charts on screen into PNGs for an export.
 *
 * The charts are already drawn as SVG by Recharts, so they are captured rather
 * than redrawn. Redrawing them in Python would mean a second chart
 * implementation that slowly disagrees with this one, and an export that
 * doesn't match what the tester was looking at is worse than no export.
 */

/** Recharts writes presentation attributes, but text inherits font from CSS. */
const FONT_CSS = `
  text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
`;

/**
 * One <svg> -> a PNG data URL, at 2x for a document that may be printed.
 * Resolves to null rather than throwing: one chart that won't serialise must
 * not cost the tester the whole export.
 */
function svgToPng(svg, scale = 2) {
  return new Promise((resolve) => {
    try {
      const rect = svg.getBoundingClientRect();
      const width = Math.max(Math.round(rect.width), 1);
      const height = Math.max(Math.round(rect.height), 1);

      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', width);
      clone.setAttribute('height', height);
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = FONT_CSS;
      clone.insertBefore(style, clone.firstChild);

      const svgText = new XMLSerializer().serializeToString(clone);
      // encodeURIComponent, not btoa: the labels can hold non-Latin-1
      // characters and btoa throws on those.
      const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        // The charts sit on white cards; without this the PNG background is
        // transparent, which turns black in most document viewers.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Every chart currently rendered, as [{ title, image }].
 *
 * Titles come from each card's own heading, so a document's captions match the
 * page's without a second list of names to keep in step.
 */
export async function captureCharts(root = document) {
  // Direct child of the wrapper only. Recharts gives EVERY legend swatch its
  // own svg.recharts-surface, so the naive selector returned 20 "charts" for
  // six charts - fourteen of them 16px colour chips.
  const surfaces = [...root.querySelectorAll('.recharts-wrapper > svg.recharts-surface')];
  const captured = await Promise.all(surfaces.map(async (svg) => {
    const card = svg.closest('[data-chart-title]');
    const title = card?.getAttribute('data-chart-title') || 'Chart';
    const image = await svgToPng(svg);
    return image ? { title, image } : null;
  }));
  return captured.filter(Boolean);
}
