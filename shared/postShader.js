/**
 * Post-processing pass for the infinite canvas.
 *
 * Two distortions share one lens function:
 *
 *   1. Barrel  — the radial "globe" bulge, always on. Governed by the
 *      classic Brown–Conrady radial terms k1 (r²) and k2 (r⁴).
 *   2. Scroll warp — a signed, velocity-driven bend applied *before* the
 *      barrel, so the canvas curves and elongates along the direction of
 *      travel and settles flat again once scrolling stops.
 *
 * Plain ESM with no bundler-specific syntax: `app/page.js` imports it
 * through Next, and `demo/warp-viewer.html` imports the same file
 * straight from the browser, so the GLSL can never drift between them.
 */

export const POST_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const POST_FS = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tDiffuse;
  uniform float barrelStrength;
  uniform float barrelK2;
  uniform float aspect;
  uniform float cornerRadius;
  uniform float vignette;
  uniform vec3 bgColor;
  uniform float enabled;

  // ── scroll warp ──
  // warp   : signed travel speed as a fraction of the viewport, per axis.
  //          (0, 0) when at rest, so every term below vanishes.
  // bend   : how hard the canvas bows across the axis of travel.
  // stretch: elongation along the axis of travel.
  // split  : chromatic separation, scaled by travel speed.
  uniform vec2 warp;
  uniform float bend;
  uniform float stretch;
  uniform float split;

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) - r;
  }

  vec2 lens(vec2 uv) {
    vec2 center = vec2(0.5);
    vec2 d = uv - center;

    // Elongate along the travel axis: sampling closer to the centre on
    // that axis stretches the image out in the direction of movement.
    d /= 1.0 + stretch * abs(warp);

    // Trailing bend. Displacement along the travel axis grows with the
    // square of the distance across it, so the centre leads and the far
    // edges lag — the canvas reads as a sheet bowing under the motion.
    d += bend * warp * vec2(d.y * d.y, d.x * d.x);

    if (enabled > 0.5) {
      float r2 = dot(d, d);
      float r4 = r2 * r2;
      d /= 1.0 + barrelStrength * r2 + barrelK2 * r4;
    }

    return center + d;
  }

  void main() {
    vec2 uv = lens(vUv);

    vec4 color;
    float ca = split * length(warp);
    if (ca > 0.0001) {
      vec2 o = warp * ca;
      color = vec4(
        texture2D(tDiffuse, clamp(uv + o, 0.0, 1.0)).r,
        texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).g,
        texture2D(tDiffuse, clamp(uv - o, 0.0, 1.0)).b,
        1.0
      );
    } else {
      color = texture2D(tDiffuse, clamp(uv, 0.0, 1.0));
    }

    if (vignette > 0.0) {
      vec2 vc = vUv - 0.5;
      vc.x *= aspect;
      float vr = dot(vc, vc);
      color.rgb *= 1.0 - vignette * smoothstep(0.15, 0.6, vr);
    }

    if (cornerRadius > 0.001) {
      vec2 p = vUv - 0.5;
      vec2 halfSize = vec2(0.5);
      float dist = roundedBoxSDF(p, halfSize, cornerRadius);
      float mask = 1.0 - smoothstep(-0.003, 0.003, dist);
      color = mix(vec4(bgColor, 1.0), color, mask);
    }

    gl_FragColor = color;
  }
`;

/** Tunables for the scroll warp, shared by the app and the demo viewer. */
export const WARP_DEFAULTS = {
  scrollWarpEnabled: true,
  /** Travel speed is a tiny fraction of the viewport, so scale it up. */
  warpGain: 12.0,
  /** Ceiling on the signed warp, per axis. */
  warpMax: 1.0,
  warpBend: 1.7,
  warpStretch: 1.5,
  warpSplit: 0.003,
  /** Extra r⁴ barrel mixed in with speed — the globe bulges as you scroll. */
  warpK2: 0.9,
  /** Rise is quick so the bend snaps in; fall is slow so it settles. */
  warpAttack: 0.25,
  warpRelease: 0.08,
};

/**
 * Advance the warp state one frame.
 *
 * @param {{x:number,y:number}} state  mutated in place
 * @param {number} tx  signed target on x, viewport fractions this frame
 * @param {number} ty  signed target on y
 * @param {typeof WARP_DEFAULTS} p
 */
export function stepWarp(state, tx, ty, p) {
  const max = p.warpMax;
  const gx = Math.max(-max, Math.min(max, tx * p.warpGain));
  const gy = Math.max(-max, Math.min(max, ty * p.warpGain));
  state.x += (gx - state.x) * (Math.abs(gx) > Math.abs(state.x) ? p.warpAttack : p.warpRelease);
  state.y += (gy - state.y) * (Math.abs(gy) > Math.abs(state.y) ? p.warpAttack : p.warpRelease);
  // Park exactly at rest so the shader's warp terms drop out completely.
  if (Math.abs(state.x) < 1e-4) state.x = 0;
  if (Math.abs(state.y) < 1e-4) state.y = 0;
  return Math.hypot(state.x, state.y);
}
