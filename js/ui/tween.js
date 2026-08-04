/**
 * Number easing for the money readouts.
 *
 * The desktop app mirrors each total into an animated property with a
 * 180ms OutCubic NumberAnimation so the figure eases rather than jumps.
 * This is the same idea: hand it a render function and set() a new
 * target; it interpolates on animation frames and re-renders.
 *
 * The easing is decoration, but the final number is not — so it never
 * depends on animation frames arriving. Frames are paused in a
 * background tab (and in any context that isn't compositing), so a
 * timer backstop guarantees the target value is painted either way.
 */

const DURATION = 180;

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function outCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * @param render called with the interpolated value on every frame
 * @returns {{set(value: number, opts?: {animate?: boolean}): void}}
 */
export function tweenNumber(render) {
  let current = 0;
  let from = 0;
  let target = 0;
  let startedAt = 0;
  let frame = 0;
  let backstop = 0;
  // The element still shows whatever the HTML shipped with until the
  // first paint, so the opening value has to be drawn even when it
  // happens to equal the initial target of 0.
  let painted = false;

  function paint(value) {
    current = value;
    painted = true;
    render(value);
  }

  function settle() {
    cancelAnimationFrame(frame);
    clearTimeout(backstop);
    frame = 0;
    backstop = 0;
    paint(target);
  }

  function step(now) {
    const t = Math.min(1, (now - startedAt) / DURATION);
    if (t >= 1) {
      settle();
      return;
    }
    paint(from + (target - from) * outCubic(t));
    frame = requestAnimationFrame(step);
  }

  return {
    set(value, { animate = true } = {}) {
      const next = Number(value) || 0;

      if (next === target) {
        // Already heading here (or sitting here) — don't restart the
        // easing, but do make sure it has been drawn at least once.
        if (!frame && !painted) paint(next);
        return;
      }

      target = next;

      if (!animate || reduceMotion?.matches) {
        settle();
        return;
      }

      // Re-aiming mid-flight: ease on from wherever the number is now
      // rather than snapping back and replaying from the old start.
      from = current;
      startedAt = performance.now();
      clearTimeout(backstop);
      backstop = setTimeout(settle, DURATION + 120);
      if (!frame) frame = requestAnimationFrame(step);
    },
  };
}
