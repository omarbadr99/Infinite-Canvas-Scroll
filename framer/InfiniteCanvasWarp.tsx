import * as THREE from "three"
import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useRef, useState } from "react"

/**
 * Infinite Canvas Warp — a Framer code component.
 *
 * An endless, procedurally tiled image field with a lens barrel ("globe")
 * distortion and a scroll-velocity warp: the plates bow and elongate along the
 * direction of travel while you scroll, then settle flat again.
 *
 * ── Feeding it the CMS ────────────────────────────────────────────────────
 * Framer has no CMS API for code components. Reading a collection out of
 * `props.children.props.query.from.data` used to work and is now explicitly
 * unsupported — those props are private and change without notice. The CMS API
 * that does exist is for *plugins*, not for components on a site.
 *
 * So the only supported route is the DOM: this component reads images and text
 * out of what Framer actually renders for a Collection List. The CMS stays the
 * source of truth and no private API is touched.
 *
 * ControlType.ComponentInstance does NOT list Collection Lists in its picker,
 * so the slot alone is not enough. "Source" therefore offers:
 *
 *   auto      find the biggest repeated run of images on the page — normally
 *             the Collection List — and read that. Needs no wiring.
 *   selector  a CSS selector for the list, e.g. [data-framer-name="Works"].
 *   slot      the ComponentInstance slot, for the cases where it can be filled.
 *   manual    ignore the page and use the Items array.
 *
 * With "Hide source" on, the list it reads from is parked full-screen,
 * transparent and inert behind the canvas: off the layout, but still inside
 * the viewport so its lazy images actually load.
 *
 * Card layout inside the Collection List:
 *   - one image per item
 *   - first text layer  → title       (shown above the plate on hover)
 *   - second text layer → description (shown below it)
 * Extra text layers are folded into the description.
 *
 * With no slot connected it falls back to the "Items" array, which is handy for
 * laying things out before the collection exists.
 *
 * ── Keeping the shader honest ─────────────────────────────────────────────
 * The GLSL below is a copy of `shared/postShader.js` in the source repo, which
 * is the source of truth. A Framer component has to be a single self-contained
 * file, so edit it there first and paste the change across.
 *
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 700
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */

const POST_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const POST_FS = /* glsl */ `
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

    d /= 1.0 + stretch * abs(warp);
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
`

/* ── deterministic placement ──────────────────────────────────────────────
   Same hash and shuffle as the original canvas, so a given chunk always lays
   out identically — panning away and back never reshuffles the field. */

function mulberry32(a: number) {
    return function () {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function hashChunk(cx: number, cy: number) {
    let h = 2166136261
    h = Math.imul(h ^ cx, 16777619)
    h = Math.imul(h ^ cy, 16777619)
    h = Math.imul(h ^ (cx * 374761393), 16777619)
    h = Math.imul(h ^ (cy * 668265263), 16777619)
    return h >>> 0
}

/* ── lens maths, mirroring the shader on the CPU ──────────────────────────
   The pass samples the scene at `lens(outputUv)`, so the pixel under the
   cursor shows the scene point at `lensForward(cursor)` — hit testing has to
   go through it or hover drifts badly at the edges once the barrel is strong.
   Placing a label runs the other way: `lensInverse` says where a scene point
   ends up on screen. Both are only used at rest, where the warp terms vanish
   and the map is purely radial. */

function lensForward(x: number, y: number, k1: number, k2: number) {
    const dx = x - 0.5
    const dy = y - 0.5
    const r2 = dx * dx + dy * dy
    const s = 1 / (1 + k1 * r2 + k2 * r2 * r2)
    return [0.5 + dx * s, 0.5 + dy * s]
}

function lensInverse(x: number, y: number, k1: number, k2: number) {
    const dx = x - 0.5
    const dy = y - 0.5
    const rp = Math.hypot(dx, dy)
    if (rp < 1e-6) return [x, y]
    // Newton on u/(1 + k1u² + k2u⁴) = rp. Converges in a couple of steps for
    // any barrel strength the controls allow.
    let u = rp
    for (let i = 0; i < 8; i++) {
        const u2 = u * u
        const D = 1 + k1 * u2 + k2 * u2 * u2
        const dD = 2 * k1 * u + 4 * k2 * u2 * u
        const f = u / D - rp
        const df = (D - u * dD) / (D * D)
        if (Math.abs(df) < 1e-9) break
        const next = u - f / df
        u = next > 0 ? next : rp
    }
    const s = u / rp
    return [0.5 + dx * s, 0.5 + dy * s]
}

type Plate = { src: string; title: string; description: string }

/* ── harvesting the Collection List ─────────────────────────────────────── */

/** Framer usually renders CMS images as <img>, but falls back to a CSS
    background on some image layers — cover both. */
function imageSources(root: HTMLElement): { node: HTMLElement; src: string }[] {
    const imgs = Array.from(root.querySelectorAll("img"))
    if (imgs.length) {
        return imgs.map((img) => {
            const el = img as HTMLImageElement
            if (el.loading === "lazy") el.loading = "eager"
            return { node: el, src: el.currentSrc || el.getAttribute("src") || "" }
        })
    }
    const out: { node: HTMLElement; src: string }[] = []
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage
        const m = bg && bg !== "none" ? bg.match(/url\(["']?(.*?)["']?\)/) : null
        if (m && m[1]) out.push({ node: el, src: m[1] })
    })
    return out
}

/** The nearest ancestor that holds real imagery besides our own.
    Framer lays every breakpoint out in the same document, so searching from
    <body> can pick up the Tablet frame's copy of the list. Climbing from the
    component keeps the search inside the frame it actually sits in. */
function searchScope(root: HTMLElement): HTMLElement {
    let node = root.parentElement
    while (node && node !== document.body) {
        const n = Array.from(node.querySelectorAll("img")).filter(
            (i) => !root.contains(i)
        ).length
        if (n >= 2) return node
        node = node.parentElement
    }
    return document.body
}

/** Locate the repeated run of images near the component — the Collection List. */
function findListOnPage(exclude: HTMLElement): HTMLElement | null {
    const scope = searchScope(exclude)
    const imgs = Array.from(scope.querySelectorAll("img")).filter(
        (i) => !exclude.contains(i)
    )
    const counts = new Map<HTMLElement, number>()
    for (const img of imgs) {
        let node: HTMLElement = img
        while (
            node.parentElement &&
            node.parentElement.querySelectorAll("img").length === 1
        ) {
            node = node.parentElement
        }
        const list = node.parentElement
        if (!list || list === document.body) continue
        if (exclude.contains(list)) continue
        counts.set(list, (counts.get(list) || 0) + 1)
    }
    let best: HTMLElement | null = null
    let bestN = 1 // a lone image is a logo, not a list
    for (const [el, n] of counts) {
        if (n > bestN) {
            best = el
            bestN = n
        }
    }
    return best
}

function readCards(root: HTMLElement): Plate[] {
    const found = imageSources(root)
    const out: Plate[] = []
    for (const { node: img, src } of found) {
        if (!src) continue

        // Climb to the item root: the tallest ancestor that still contains
        // only this one image. That is the repeated card, whatever Framer
        // wrapped it in.
        let node: HTMLElement = img
        while (
            node.parentElement &&
            node.parentElement !== root &&
            node.parentElement.querySelectorAll("img").length <= 1
        ) {
            node = node.parentElement
        }

        const seen: string[] = []
        node.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,li,div,a").forEach((el) => {
            if (el.children.length) return // leaf text only
            const t = (el.textContent || "").trim()
            if (t && !seen.includes(t)) seen.push(t)
        })

        out.push({ src, title: seen[0] || "", description: seen.slice(1).join(" ") })
    }
    return out
}

function samePlates(a: Plate[], b: Plate[]) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i].src !== b[i].src || a[i].title !== b[i].title || a[i].description !== b[i].description) {
            return false
        }
    }
    return true
}

export default function InfiniteCanvasWarp(props) {
    const {
        sourceMode,
        sourceSelector,
        hideSource,
        cmsSource,
        items,
        warp,
        lens,
        canvas,
        hover,
        previewOnCanvas,
        style,
    } = props

    const rootRef = useRef<HTMLDivElement>(null)
    const hostRef = useRef<HTMLDivElement>(null)
    const slotRef = useRef<HTMLDivElement>(null)
    const [harvested, setHarvested] = useState<Plate[]>([])
    const [sourceNote, setSourceNote] = useState("")
    const [label, setLabel] = useState<{
        title: string
        description: string
        x: number
        top: number
        bottom: number
    } | null>(null)

    const onFramerCanvas = RenderTarget.current() === RenderTarget.canvas
    const live = !onFramerCanvas || previewOnCanvas

    /* Find the Collection List and re-read whenever it renders or swaps a
       source. Framer streams items and images in, so one read is never enough. */
    useEffect(() => {
        if (sourceMode === "manual") {
            setHarvested([])
            setSourceNote("items array")
            return
        }
        const rootEl = rootRef.current
        if (!rootEl) return

        let raf = 0
        let parked: { el: HTMLElement; style: string } | null = null

        const restore = () => {
            if (parked) parked.el.setAttribute("style", parked.style)
            parked = null
        }

        const locate = (): [HTMLElement | null, string] => {
            if (sourceMode === "slot") return [slotRef.current, "slot"]
            if (sourceMode === "selector") {
                if (!sourceSelector) return [null, "no selector set"]
                let found: Element | null = null
                try {
                    found = document.querySelector(sourceSelector)
                } catch {
                    return [null, "invalid selector"]
                }
                if (!found || rootEl.contains(found)) return [null, "selector matched nothing"]
                return [found as HTMLElement, sourceSelector]
            }
            // auto: a filled slot wins, otherwise sniff the page
            if (slotRef.current?.querySelector("img")) return [slotRef.current, "slot"]
            const onPage = findListOnPage(rootEl)
            return [onPage, onPage ? "page list" : "nothing found on page"]
        }

        const read = () => {
            const [el, from] = locate()
            const next = el ? readCards(el) : []
            setHarvested((prev) => (samePlates(prev, next) ? prev : next))
            setSourceNote(next.length ? `${next.length} from ${from}` : from)

            // Park the list we read from: off the layout, but still inside the
            // viewport so its lazy images keep loading.
            if (live && hideSource && el && el !== slotRef.current) {
                if (parked?.el !== el) {
                    restore()
                    parked = { el, style: el.getAttribute("style") || "" }
                    Object.assign(el.style, {
                        position: "fixed",
                        top: "0",
                        left: "0",
                        width: "100vw",
                        height: "100vh",
                        overflow: "hidden",
                        opacity: "0",
                        pointerEvents: "none",
                        zIndex: "-1",
                    })
                }
            } else {
                restore()
            }
        }

        read()
        // style is deliberately absent from attributeFilter: parking the source
        // writes style, and observing it would loop.
        const mo = new MutationObserver(() => {
            cancelAnimationFrame(raf)
            raf = requestAnimationFrame(read)
        })
        mo.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src", "srcset"],
        })
        const settle = window.setTimeout(read, 900)
        return () => {
            mo.disconnect()
            cancelAnimationFrame(raf)
            window.clearTimeout(settle)
            restore()
        }
    }, [sourceMode, sourceSelector, hideSource, live, cmsSource])

    const manual: Plate[] = (items || [])
        .map((it) => ({
            src: typeof it?.image === "string" ? it.image : it?.image?.src || "",
            title: it?.title || "",
            description: it?.description || "",
        }))
        .filter((it) => it.src)

    const plates = harvested.length ? harvested : manual
    const platesKey = plates.map((p) => p.src).join("|")

    useEffect(() => {
        const host = hostRef.current
        if (!host || !live || !plates.length) return

        let disposed = false
        let W = host.clientWidth || 1200
        let H = host.clientHeight || 700

        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.setSize(W, H)
        renderer.setClearColor(canvas.background)
        host.appendChild(renderer.domElement)
        const cvs = renderer.domElement
        cvs.style.display = "block"
        cvs.style.cursor = "grab"

        let baseZoom = canvas.zoom
        let dragZoomMult = 1.0
        const getZoom = () => baseZoom * dragZoomMult

        const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.1, 10)
        camera.position.set(0, 0, 5)
        camera.lookAt(0, 0, 0)
        const scene = new THREE.Scene()

        function applyZoom() {
            const z = getZoom()
            camera.left = -W / 2 / z
            camera.right = W / 2 / z
            camera.top = H / 2 / z
            camera.bottom = -H / 2 / z
            camera.updateProjectionMatrix()
        }

        const dpr = Math.min(window.devicePixelRatio, 2)
        const renderTarget = new THREE.WebGLRenderTarget(W * dpr, H * dpr, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
        })

        const bgVec = () => {
            const c = new THREE.Color(canvas.background)
            return new THREE.Vector3(c.r, c.g, c.b)
        }

        const U = {
            tDiffuse: { value: renderTarget.texture },
            barrelStrength: { value: lens.barrel },
            barrelK2: { value: 0.0 },
            aspect: { value: W / H },
            cornerRadius: { value: lens.cornerRadius },
            vignette: { value: lens.vignette },
            bgColor: { value: bgVec() },
            enabled: { value: 1.0 },
            warp: { value: new THREE.Vector2(0, 0) },
            bend: { value: warp.bend },
            stretch: { value: warp.stretch },
            split: { value: warp.split },
        }

        const postMat = new THREE.ShaderMaterial({
            uniforms: U,
            vertexShader: POST_VS,
            fragmentShader: POST_FS,
            depthTest: false,
            depthWrite: false,
        })
        const qGeo = new THREE.PlaneGeometry(2, 2)
        const postScene = new THREE.Scene()
        postScene.add(new THREE.Mesh(qGeo, postMat))
        const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

        /* ── textures ── */
        let imageData: {
            w: number
            h: number
            texture: THREE.Texture | null
            title: string
            description: string
        }[] = []

        const loader = new THREE.TextureLoader()
        loader.setCrossOrigin("anonymous")

        const loadAll = Promise.all(
            plates.map(
                (p) =>
                    new Promise<any>((resolve) => {
                        const img = new Image()
                        img.crossOrigin = "anonymous"
                        img.onload = () => {
                            const tex = loader.load(p.src)
                            tex.minFilter = THREE.LinearFilter
                            tex.magFilter = THREE.LinearFilter
                            // Cap the long edge so an oversized CMS upload does
                            // not blow the layout apart; aspect is preserved.
                            const long = Math.max(img.naturalWidth, img.naturalHeight)
                            const k =
                                long * canvas.plateScale > canvas.maxPlate
                                    ? canvas.maxPlate / (long * canvas.plateScale)
                                    : 1
                            resolve({
                                w: img.naturalWidth * canvas.plateScale * k,
                                h: img.naturalHeight * canvas.plateScale * k,
                                texture: tex,
                                title: p.title,
                                description: p.description,
                            })
                        }
                        img.onerror = () =>
                            resolve({
                                w: 420,
                                h: 420,
                                texture: null,
                                title: p.title,
                                description: p.description,
                            })
                        img.src = p.src
                    })
            )
        )

        /* ── chunks ── */
        const activeChunks = new Map<string, THREE.Group>()
        const chunkImgCache = new Map<string, number[]>()
        let lastCx: number | null = null
        let lastCy: number | null = null

        function chunkImgs(cx: number, cy: number) {
            const key = `${cx},${cy}`
            const hit = chunkImgCache.get(key)
            if (hit) return hit
            const total = imageData.length
            const count = Math.min(canvas.perChunk, total)
            const li = (((cx * 7919 + cy * 104729) % 999983) + 999983) % 999983
            const off = (li * count) % total
            const rng = mulberry32(hashChunk(cx, cy))
            const pool = Array.from({ length: total }, (_, i) => i)
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1))
                ;[pool[i], pool[j]] = [pool[j], pool[i]]
            }
            const idx: number[] = []
            for (let i = 0; i < count; i++) idx.push(pool[(off + i) % total])
            chunkImgCache.set(key, idx)
            return idx
        }

        function mkChunk(cx: number, cy: number) {
            const g = new THREE.Group()
            const rng = mulberry32(hashChunk(cx, cy))
            const CS = canvas.chunkSize
            const ox = cx * CS
            const oy = cy * CS
            const placed: { px: number; py: number; w: number; h: number }[] = []

            for (const ii of chunkImgs(cx, cy)) {
                const img = imageData[ii]
                const { w, h } = img
                let px = 0
                let py = 0
                let ok = false
                for (let tries = 0; tries < 150; tries++) {
                    px = rng() * Math.max(1, CS - w)
                    py = rng() * Math.max(1, CS - h)
                    let overlap = false
                    for (const p of placed) {
                        if (
                            px - canvas.padding < p.px + p.w &&
                            px + w + canvas.padding > p.px &&
                            py - canvas.padding < p.py + p.h &&
                            py + h + canvas.padding > p.py
                        ) {
                            overlap = true
                            break
                        }
                    }
                    if (!overlap) {
                        ok = true
                        break
                    }
                }
                if (!ok) continue
                placed.push({ px, py, w, h })

                const mat = img.texture
                    ? new THREE.MeshBasicMaterial({ map: img.texture })
                    : new THREE.MeshBasicMaterial({ color: 0x1a1a1a })
                const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
                mesh.position.set(ox + px + w / 2, -(oy + py + h / 2), 0)
                mesh.userData = { title: img.title, description: img.description, h }
                g.add(mesh)
            }
            scene.add(g)
            return g
        }

        function rmChunk(g: THREE.Group) {
            g.children.forEach((m: any) => {
                m.geometry.dispose()
                m.material.dispose()
            })
            scene.remove(g)
        }

        function updChunks() {
            if (!imageData.length) return
            const ccx = Math.floor(camera.position.x / canvas.chunkSize)
            const ccy = Math.floor(-camera.position.y / canvas.chunkSize)
            const R = canvas.renderRadius
            const need = new Set<string>()
            for (let dx = -R; dx <= R; dx++)
                for (let dy = -R; dy <= R; dy++) need.add(`${ccx + dx},${ccy + dy}`)
            for (const [k, g] of activeChunks) {
                if (!need.has(k)) {
                    rmChunk(g)
                    activeChunks.delete(k)
                }
            }
            for (const k of need) {
                if (!activeChunks.has(k)) {
                    const [a, b] = k.split(",").map(Number)
                    activeChunks.set(k, mkChunk(a, b))
                }
            }
        }

        /* ── press: zoom out and bulge, exactly as before ── */
        const dz = { v: 1.0, from: 1.0, to: 1.0, t0: 0, dur: 0.001 }
        const bk = { v: 0.0, from: 0.0, to: 0.0, t0: 0, dur: 0.001 }
        const easeOutCirc = (t: number) => Math.sqrt(1 - (t - 1) * (t - 1))
        const easeOutPow2 = (t: number) => 1 - (1 - t) * (1 - t)
        let dzEase = easeOutCirc
        let bkEase = easeOutCirc

        function press(state, to: number, dur: number) {
            state.from = state.v
            state.to = to
            state.dur = Math.max(0.001, dur)
            state.t0 = performance.now()
        }
        function advance(state, ease, now: number) {
            const k = Math.min(1, (now - state.t0) / (state.dur * 1000))
            state.v = state.from + (state.to - state.from) * ease(k)
        }

        /* ── warp state ── */
        const warpS = { x: 0, y: 0 }
        function stepWarp(tx: number, ty: number) {
            const m = warp.max
            const gx = Math.max(-m, Math.min(m, tx * warp.gain))
            const gy = Math.max(-m, Math.min(m, ty * warp.gain))
            warpS.x +=
                (gx - warpS.x) * (Math.abs(gx) > Math.abs(warpS.x) ? warp.attack : warp.release)
            warpS.y +=
                (gy - warpS.y) * (Math.abs(gy) > Math.abs(warpS.y) ? warp.attack : warp.release)
            if (Math.abs(warpS.x) < 1e-4) warpS.x = 0
            if (Math.abs(warpS.y) < 1e-4) warpS.y = 0
            return Math.hypot(warpS.x, warpS.y)
        }

        /* ── input ── */
        const ray = new THREE.Raycaster()
        const nd = new THREE.Vector2()
        let isD = false
        let dAct = false
        const dS = { x: 0, y: 0 }
        const cS = { x: 0, y: 0 }
        const vel = { x: 0, y: 0 }
        const lP = { x: 0, y: 0 }
        let lT = 0
        let tX = 0
        let tY = 0
        let pointer: { x: number; y: number } | null = null

        const onDown = (e: PointerEvent) => {
            if (e.target !== cvs) return
            isD = true
            dAct = false
            cvs.style.cursor = "grabbing"
            setLabel(null)
            dS.x = e.clientX
            dS.y = e.clientY
            cS.x = camera.position.x
            cS.y = camera.position.y
            tX = camera.position.x
            tY = camera.position.y
            lP.x = e.clientX
            lP.y = e.clientY
            lT = performance.now()
            vel.x = 0
            vel.y = 0
            cvs.setPointerCapture(e.pointerId)
            dzEase = easeOutCirc
            bkEase = easeOutCirc
            press(dz, canvas.pressZoom, canvas.pressInDuration)
            press(bk, canvas.pressBulge, canvas.pressInDuration)
        }

        const onMove = (e: PointerEvent) => {
            const r = cvs.getBoundingClientRect()
            pointer = { x: e.clientX - r.left, y: e.clientY - r.top }
            if (!isD) return
            if (!dAct) {
                if (Math.hypot(e.clientX - dS.x, e.clientY - dS.y) < canvas.deadzone) return
                dAct = true
            }
            const now = performance.now()
            const dt = now - lT
            const z = getZoom()
            tX = cS.x - ((e.clientX - dS.x) / z) * canvas.panSensitivity
            tY = cS.y + ((e.clientY - dS.y) / z) * canvas.panSensitivity
            if (dt > 0) {
                vel.x = (e.clientX - lP.x) / dt
                vel.y = (e.clientY - lP.y) / dt
            }
            lP.x = e.clientX
            lP.y = e.clientY
            lT = now
        }

        const onUp = () => {
            if (!isD) return
            isD = false
            dAct = false
            cvs.style.cursor = "grab"
            dzEase = easeOutPow2
            bkEase = easeOutPow2
            press(dz, 1.0, canvas.pressOutDuration)
            press(bk, 0.0, canvas.pressOutDuration)
        }

        const onLeave = () => {
            pointer = null
            setLabel(null)
        }

        cvs.addEventListener("pointerdown", onDown)
        cvs.addEventListener("pointermove", onMove)
        cvs.addEventListener("pointerup", onUp)
        cvs.addEventListener("pointercancel", onUp)
        cvs.addEventListener("pointerleave", onLeave)

        let sTX = 0
        let sTY = 0
        let sCX = 0
        let sCY = 0
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const sp = canvas.scrollSpeed / getZoom()
            sTY -= e.deltaY * sp
            if (canvas.scrollHorizontal) sTX -= e.deltaX * sp
        }
        cvs.addEventListener("wheel", onWheel, { passive: false })

        let lpd = 0
        const onTS = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                lpd = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                )
            }
        }
        const onTM = (e: TouchEvent) => {
            if (e.touches.length !== 2) return
            e.preventDefault()
            const d = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            )
            baseZoom = Math.max(0.1, Math.min(3, baseZoom * (1 + (d - lpd) * 0.005)))
            applyZoom()
            lpd = d
        }
        cvs.addEventListener("touchstart", onTS, { passive: false })
        cvs.addEventListener("touchmove", onTM, { passive: false })

        const ro = new ResizeObserver(() => {
            W = host.clientWidth || W
            H = host.clientHeight || H
            renderer.setSize(W, H)
            renderTarget.setSize(W * dpr, H * dpr)
            U.aspect.value = W / H
            applyZoom()
        })
        ro.observe(host)

        /* ── loop ── */
        let raf = 0
        let labelKey = ""

        const tick = () => {
            raf = requestAnimationFrame(tick)
            const now = performance.now()
            advance(dz, dzEase, now)
            advance(bk, bkEase, now)
            dragZoomMult = dz.v
            applyZoom()
            const z = getZoom()

            const ss = canvas.scrollSmoothing
            const sdx = (sTX - sCX) * ss
            const sdy = (sTY - sCY) * ss
            if (Math.abs(sdx) > 0.01 || Math.abs(sdy) > 0.01) {
                sCX += sdx
                sCY += sdy
                camera.position.x += sdx
                camera.position.y += sdy
                tX += sdx
                tY += sdy
                cS.x += sdx
                cS.y += sdy
            }

            const mag = warp.enabled ? stepWarp(-(sdx * z) / W, -(sdy * z) / H) : stepWarp(0, 0)
            U.warp.value.set(warpS.x, warpS.y)
            U.barrelK2.value = bk.v + warp.k2 * mag
            U.barrelStrength.value = lens.barrel
            U.cornerRadius.value = lens.cornerRadius
            U.vignette.value = lens.vignette
            U.bend.value = warp.bend
            U.stretch.value = warp.stretch
            U.split.value = warp.split

            if (isD) {
                camera.position.x += (tX - camera.position.x) * canvas.panSmoothing
                camera.position.y += (tY - camera.position.y) * canvas.panSmoothing
            } else if (
                Math.abs(vel.x) > canvas.inertiaThreshold ||
                Math.abs(vel.y) > canvas.inertiaThreshold
            ) {
                camera.position.x -= (vel.x * canvas.inertiaScale) / z
                camera.position.y += (vel.y * canvas.inertiaScale) / z
                vel.x *= canvas.inertiaDamping
                vel.y *= canvas.inertiaDamping
            }

            const ccx = Math.floor(camera.position.x / canvas.chunkSize)
            const ccy = Math.floor(-camera.position.y / canvas.chunkSize)
            if (ccx !== lastCx || ccy !== lastCy) {
                lastCx = ccx
                lastCy = ccy
                updChunks()
            }

            /* Hover label. Only while the field is essentially at rest: mid-warp
               the plate is bent and a crisp caption pinned to it reads wrong. */
            const settled = mag < 0.02 && !isD
            if (hover.enabled && pointer && settled) {
                const k1 = lens.barrel
                const k2 = U.barrelK2.value
                const [fx, fy] = lensForward(pointer.x / W, 1 - pointer.y / H, k1, k2)
                nd.x = fx * 2 - 1
                nd.y = fy * 2 - 1
                ray.setFromCamera(nd, camera)
                const meshes: THREE.Object3D[] = []
                for (const [, g] of activeChunks) for (const c of g.children) meshes.push(c)
                const hit = ray.intersectObjects(meshes, false)[0]

                if (hit) {
                    const m: any = hit.object
                    const ph = m.userData.h as number
                    const project = (wy: number) => {
                        const v = new THREE.Vector3(m.position.x, wy, 0).project(camera)
                        const [ox, oy] = lensInverse((v.x + 1) / 2, (v.y + 1) / 2, k1, k2)
                        return { x: ox * W, y: (1 - oy) * H }
                    }
                    const top = project(m.position.y + ph / 2)
                    const bottom = project(m.position.y - ph / 2)
                    // Clamp so a caption stays readable when its plate runs
                    // past the top or bottom of the frame.
                    const next = {
                        title: m.userData.title || "",
                        description: m.userData.description || "",
                        x: (top.x + bottom.x) / 2,
                        top: Math.max(hover.gap + 24, top.y),
                        bottom: Math.min(H - hover.gap - 32, bottom.y),
                    }
                    const key = `${next.title}|${Math.round(next.x)}|${Math.round(next.top)}`
                    if (key !== labelKey) {
                        labelKey = key
                        setLabel(next)
                    }
                } else if (labelKey) {
                    labelKey = ""
                    setLabel(null)
                }
            } else if (labelKey) {
                labelKey = ""
                setLabel(null)
            }

            renderer.setRenderTarget(renderTarget)
            renderer.render(scene, camera)
            renderer.setRenderTarget(null)
            U.tDiffuse.value = renderTarget.texture
            renderer.render(postScene, postCam)
        }

        loadAll.then((data) => {
            if (disposed) return
            imageData = data
            applyZoom()
            updChunks()
            tick()
        })

        return () => {
            disposed = true
            cancelAnimationFrame(raf)
            ro.disconnect()
            cvs.removeEventListener("pointerdown", onDown)
            cvs.removeEventListener("pointermove", onMove)
            cvs.removeEventListener("pointerup", onUp)
            cvs.removeEventListener("pointercancel", onUp)
            cvs.removeEventListener("pointerleave", onLeave)
            cvs.removeEventListener("wheel", onWheel)
            cvs.removeEventListener("touchstart", onTS)
            cvs.removeEventListener("touchmove", onTM)
            for (const [, g] of activeChunks) rmChunk(g)
            activeChunks.clear()
            imageData.forEach((d) => d.texture && d.texture.dispose())
            renderTarget.dispose()
            postMat.dispose()
            qGeo.dispose()
            renderer.dispose()
            if (host.contains(cvs)) host.removeChild(cvs)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live, platesKey, JSON.stringify(canvas), JSON.stringify(lens), JSON.stringify(warp), hover.enabled])

    const empty = !plates.length

    return (
        <div
            ref={rootRef}
            style={{
                ...style,
                position: "relative",
                overflow: "hidden",
                background: canvas.background,
            }}
        >
            {/* The Collection List renders at full size so Framer lays it out
                and the browser treats its images as on-screen — inside a
                collapsed box a lazy image never fetches. Invisible and inert,
                sitting behind the canvas. */}
            <div
                ref={slotRef}
                aria-hidden
                style={{
                    position: "absolute",
                    inset: 0,
                    overflow: "hidden",
                    opacity: 0,
                    pointerEvents: "none",
                    zIndex: 0,
                }}
            >
                {cmsSource}
            </div>

            <div ref={hostRef} style={{ position: "absolute", inset: 0, zIndex: 1 }} />

            {label && (label.title || label.description) && (
                <div
                    style={{
                        position: "absolute",
                        left: label.x,
                        top: 0,
                        width: hover.width,
                        marginLeft: -hover.width / 2,
                        pointerEvents: "none",
                        zIndex: 3,
                    }}
                >
                    {label.title && (
                        <div
                            style={{
                                position: "absolute",
                                top: label.top - hover.gap,
                                width: "100%",
                                transform: "translateY(-100%)",
                                textAlign: "center",
                                ...hover.titleFont,
                                color: hover.titleColor,
                            }}
                        >
                            {label.title}
                        </div>
                    )}
                    {label.description && (
                        <div
                            style={{
                                position: "absolute",
                                top: label.bottom + hover.gap,
                                width: "100%",
                                textAlign: "center",
                                ...hover.descriptionFont,
                                color: hover.descriptionColor,
                            }}
                        >
                            {label.description}
                        </div>
                    )}
                </div>
            )}

            {(onFramerCanvas && !previewOnCanvas) || empty ? (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        alignItems: "center",
                        justifyContent: "center",
                        textAlign: "center",
                        padding: 24,
                        font: '600 12px/1.5 Inter, "Helvetica Neue", sans-serif',
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "#8b979e",
                    }}
                >
                    <div>Infinite Canvas Warp</div>
                    <div style={{ font: '400 11px/1.6 Inter, sans-serif', letterSpacing: 0, textTransform: "none" }}>
                        {empty
                            ? `No images found — ${sourceNote || "looking…"}. Put a Collection List on this page, or set Source to Manual.`
                            : `${plates.length} plates · ${sourceNote} · open Preview to run it`}
                    </div>
                </div>
            ) : null}
        </div>
    )
}

InfiniteCanvasWarp.displayName = "Infinite Canvas Warp"

addPropertyControls(InfiniteCanvasWarp, {
    sourceMode: {
        type: ControlType.Enum,
        title: "Source",
        options: ["auto", "selector", "slot", "manual"],
        optionTitles: ["Auto (page)", "CSS selector", "Slot", "Manual items"],
        defaultValue: "auto",
        description:
            "Auto reads the Collection List on this page. Card order: image, then title text, then description text.",
    },
    sourceSelector: {
        type: ControlType.String,
        title: "Selector",
        placeholder: '[data-framer-name="Works"]',
        defaultValue: "",
        hidden: (p) => p.sourceMode !== "selector",
    },
    hideSource: {
        type: ControlType.Boolean,
        title: "Hide source",
        defaultValue: true,
        description: "Hides the Collection List it reads from, so only the canvas shows.",
        hidden: (p) => p.sourceMode === "manual",
    },
    cmsSource: {
        type: ControlType.ComponentInstance,
        title: "Slot",
        hidden: (p) => p.sourceMode !== "slot",
    },
    items: {
        type: ControlType.Array,
        title: "Items",
        description: "Used when the source finds nothing, or when Source is Manual.",
        control: {
            type: ControlType.Object,
            controls: {
                image: { type: ControlType.ResponsiveImage, title: "Image" },
                title: { type: ControlType.String, title: "Title", defaultValue: "" },
                description: { type: ControlType.String, title: "Description", defaultValue: "" },
            },
        },
    },
    hover: {
        type: ControlType.Object,
        title: "Hover",
        controls: {
            enabled: { type: ControlType.Boolean, title: "Labels", defaultValue: true },
            width: { type: ControlType.Number, title: "Width", min: 80, max: 800, step: 10, defaultValue: 320, unit: "px" },
            gap: { type: ControlType.Number, title: "Gap", min: 0, max: 80, step: 1, defaultValue: 14, unit: "px" },
            titleFont: {
                type: ControlType.Font,
                title: "Title",
                controls: "extended",
                defaultFontType: "sans-serif",
                defaultValue: { fontSize: 18, lineHeight: 1.3, fontWeight: 500 },
            },
            titleColor: { type: ControlType.Color, title: "Title fill", defaultValue: "#111111" },
            descriptionFont: {
                type: ControlType.Font,
                title: "Description",
                controls: "extended",
                defaultFontType: "sans-serif",
                defaultValue: { fontSize: 13, lineHeight: 1.5, fontWeight: 400 },
            },
            descriptionColor: { type: ControlType.Color, title: "Desc. fill", defaultValue: "#6b7176" },
        },
    },
    warp: {
        type: ControlType.Object,
        title: "Scroll warp",
        controls: {
            enabled: { type: ControlType.Boolean, title: "Enabled", defaultValue: true },
            bend: { type: ControlType.Number, title: "Bend", min: 0, max: 3, step: 0.01, defaultValue: 1.7 },
            stretch: { type: ControlType.Number, title: "Stretch", min: 0, max: 2, step: 0.01, defaultValue: 1.5 },
            k2: { type: ControlType.Number, title: "Globe bulge", min: 0, max: 3, step: 0.05, defaultValue: 0.9 },
            split: { type: ControlType.Number, title: "Chromatic", min: 0, max: 0.05, step: 0.001, defaultValue: 0.003 },
            gain: { type: ControlType.Number, title: "Velocity gain", min: 0, max: 40, step: 0.5, defaultValue: 12 },
            max: { type: ControlType.Number, title: "Ceiling", min: 0.1, max: 2, step: 0.05, defaultValue: 1 },
            attack: { type: ControlType.Number, title: "Attack", min: 0.02, max: 1, step: 0.01, defaultValue: 0.25 },
            release: { type: ControlType.Number, title: "Release", min: 0.005, max: 0.5, step: 0.005, defaultValue: 0.08 },
        },
    },
    lens: {
        type: ControlType.Object,
        title: "Lens",
        controls: {
            barrel: { type: ControlType.Number, title: "Barrel", min: 0, max: 2, step: 0.01, defaultValue: 0.57 },
            vignette: { type: ControlType.Number, title: "Vignette", min: 0, max: 0.5, step: 0.01, defaultValue: 0 },
            cornerRadius: { type: ControlType.Number, title: "Corners", min: 0, max: 0.15, step: 0.005, defaultValue: 0 },
        },
    },
    canvas: {
        type: ControlType.Object,
        title: "Canvas",
        controls: {
            background: { type: ControlType.Color, title: "Background", defaultValue: "#ffffff" },
            zoom: { type: ControlType.Number, title: "Zoom", min: 0.2, max: 2, step: 0.01, defaultValue: 1.3 },
            plateScale: { type: ControlType.Number, title: "Plate scale", min: 0.05, max: 1.5, step: 0.01, defaultValue: 0.4 },
            maxPlate: { type: ControlType.Number, title: "Max plate", min: 200, max: 2000, step: 10, defaultValue: 900, unit: "px" },
            perChunk: { type: ControlType.Number, title: "Plates / chunk", min: 1, max: 30, step: 1, defaultValue: 20 },
            chunkSize: { type: ControlType.Number, title: "Chunk size", min: 800, max: 6000, step: 100, defaultValue: 1500 },
            padding: { type: ControlType.Number, title: "Padding", min: 0, max: 300, step: 5, defaultValue: 80, unit: "px" },
            renderRadius: { type: ControlType.Number, title: "Render radius", min: 1, max: 4, step: 1, defaultValue: 2 },
            scrollSpeed: { type: ControlType.Number, title: "Scroll speed", min: 0.1, max: 5, step: 0.1, defaultValue: 1.5 },
            scrollSmoothing: { type: ControlType.Number, title: "Scroll smoothing", min: 0.02, max: 1, step: 0.01, defaultValue: 0.17 },
            scrollHorizontal: { type: ControlType.Boolean, title: "Horizontal", defaultValue: true },
            pressZoom: { type: ControlType.Number, title: "Press zoom", min: 0.3, max: 1, step: 0.01, defaultValue: 0.7 },
            pressBulge: { type: ControlType.Number, title: "Press bulge", min: 0, max: 2, step: 0.05, defaultValue: 0.5 },
            pressInDuration: { type: ControlType.Number, title: "Press in", min: 0.05, max: 2, step: 0.05, defaultValue: 0.45, unit: "s" },
            pressOutDuration: { type: ControlType.Number, title: "Press out", min: 0.05, max: 2, step: 0.05, defaultValue: 0.85, unit: "s" },
            panSmoothing: { type: ControlType.Number, title: "Pan smoothing", min: 0.01, max: 1, step: 0.01, defaultValue: 0.15 },
            panSensitivity: { type: ControlType.Number, title: "Pan sensitivity", min: 0.1, max: 3, step: 0.05, defaultValue: 1 },
            deadzone: { type: ControlType.Number, title: "Deadzone", min: 0, max: 20, step: 1, defaultValue: 2, unit: "px" },
            inertiaDamping: { type: ControlType.Number, title: "Inertia damping", min: 0.7, max: 0.99, step: 0.005, defaultValue: 0.885 },
            inertiaScale: { type: ControlType.Number, title: "Inertia scale", min: 1, max: 40, step: 1, defaultValue: 20 },
            inertiaThreshold: { type: ControlType.Number, title: "Inertia cutoff", min: 0.0001, max: 0.01, step: 0.0001, defaultValue: 0.0035 },
        },
    },
    previewOnCanvas: {
        type: ControlType.Boolean,
        title: "Run on canvas",
        description: "Off by default — WebGL on the Framer canvas is heavy.",
        defaultValue: false,
    },
})
