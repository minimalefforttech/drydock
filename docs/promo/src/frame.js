/* Deterministic frame driver for the promo scenes.
 *
 * Capture reloads the page once per frame with ?f=<index>&K=<total>. The scene
 * defines renderFrame() reading PROMO.t (progress 0..1) and paints an exact
 * static keyframe — no requestAnimationFrame, no CSS transitions during
 * capture, so frame N is byte-reproducible. PROMO.go() runs it and flips the
 * title to "ready" so the headless capture knows the paint is done. */
(function () {
  const q = new URLSearchParams(location.search);
  const f = Number(q.get("f") || 0);
  const K = Number(q.get("K") || 1);
  const t = K > 1 ? f / (K - 1) : 0;

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a, b, u) => a + (b - a) * clamp01(u);
  // Cubic ease-in-out for pleasant motion.
  const ease = (u) => {
    u = clamp01(u);
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  };
  // Local progress of a [a,b] window of the global timeline, clamped to 0..1.
  const seg = (a, b) => clamp01((t - a) / (b - a));
  // Eased local progress of a window.
  const eseg = (a, b) => ease(seg(a, b));
  // 1 while t is inside [a,b], else 0 (for show/hide gating).
  const during = (a, b) => (t >= a && t <= b ? 1 : 0);

  window.PROMO = { f, K, t, clamp01, lerp, ease, seg, eseg, during };

  window.PROMO.go = function (renderFrame) {
    const run = () => {
      renderFrame();
      // Two rAFs guarantee layout/paint settled before we signal readiness,
      // then title flips so --virtual-time-budget capture grabs a painted frame.
      requestAnimationFrame(() => requestAnimationFrame(() => { document.title = "ready"; }));
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  };

  // Cubic-bezier-ish path helper: quadratic point between p0 and p1 with a
  // horizontal bend, used for dependency edges. Returns an SVG path string.
  window.PROMO.edgePath = function (x0, y0, x1, y1) {
    const bend = Math.max(30, Math.min(110, Math.abs(x1 - x0) / 2));
    return `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}`;
  };
})();
