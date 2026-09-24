import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useRef } from "react"

/**
 * Press Scale — a Framer code component.
 *
 * Hold the mouse anywhere and the page eases away from you; release and it
 * springs back. Drop one anywhere on a page; it draws nothing.
 *
 * Three things decide how this is built, all of them learned the hard way:
 *
 * 1. It pivots on the cursor, not on the middle of the screen. Scaling about
 *    any other point slides the page under the pointer, so the element beneath
 *    pointerdown is not the element beneath pointerup — and a browser only
 *    fires `click` when both land on the same element. Pivoting on the cursor
 *    holds that one point still, so everything underneath stays clickable.
 *    It also ties the gesture to where you actually pressed.
 *
 * 2. It transforms each top-level section, never one wrapper around them all.
 *    A transform makes an element the containing block for its `fixed` and
 *    `sticky` descendants, which is why a pinned section jumped to the top of
 *    itself when the whole page was scaled. Transforming a sticky element
 *    *itself* leaves its stickiness intact — only an ancestor breaks it. Since
 *    every section scales by the same factor about the same document point,
 *    the result is identical to scaling the page, minus the breakage.
 *
 * 3. It runs on a spring rather than a CSS ease, and the gap it opens takes
 *    the colour of whatever you pressed on, so a full-bleed section does not
 *    appear to have been cropped against a bare white edge.
 *
 * Nested sticky is the one case still beyond reach: if a pinned element sits
 * inside a section rather than beside it, that section is its ancestor and the
 * containing-block rule applies again. Point Target at a container whose
 * direct children are the sections if the structure is nested.
 *
 * @framerIntrinsicWidth 1
 * @framerIntrinsicHeight 1
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 * @framerDisableUnlink
 */

/** The outermost wrapper still inside <body> that contains us. */
function pageRoot(from: HTMLElement): HTMLElement {
    let node: HTMLElement = from
    while (node.parentElement && node.parentElement !== document.body) {
        node = node.parentElement
    }
    return node
}

/** The nearest painted background behind a point — what the gap should be. */
function backdropAt(x: number, y: number): string {
    let el = document.elementFromPoint(x, y) as HTMLElement | null
    while (el) {
        const bg = getComputedStyle(el).backgroundColor
        if (bg && bg !== "transparent" && !bg.startsWith("rgba(0, 0, 0, 0)")) return bg
        el = el.parentElement
    }
    return ""
}

export default function PressScale(props) {
    const {
        enabled,
        scale,
        speed,
        bounce,
        radius,
        backdrop,
        matchBackdrop,
        selector,
        style,
    } = props
    const ref = useRef<HTMLDivElement>(null)

    // Never on the Framer canvas: the page root there is the editor's own DOM.
    const live = RenderTarget.current() !== RenderTarget.canvas

    useEffect(() => {
        if (!live || !enabled) return
        const here = ref.current
        if (!here) return

        let container: HTMLElement | null = null
        if (selector) {
            try {
                container = document.querySelector(selector)
            } catch {
                container = null
            }
        }
        // The page wrapper itself: its children are the sections. Taking its
        // parent instead would leave one wrapper to transform, which is the
        // arrangement that breaks pinned descendants.
        if (!container) container = pageRoot(here)
        if (!container) return

        const sections = () =>
            (Array.from(container!.children) as HTMLElement[]).filter(
                (el) => el !== here && el.nodeType === 1 && !el.contains(here)
            )

        const restore = new Map<HTMLElement, string>()
        const prevBodyBg = document.body.style.background

        let current = 1
        let velocity = 0
        let goal = 1
        let raf = 0
        let last = 0
        let held = false
        let painted: HTMLElement[] = []

        const applyOrigins = (docX: number, docY: number) => {
            painted = sections()
            for (const el of painted) {
                if (!restore.has(el)) restore.set(el, el.getAttribute("style") || "")
                const box = el.getBoundingClientRect()
                // The box is already transformed if a press is still settling,
                // so undo the current scale to recover the untransformed corner.
                const left = box.left + window.scrollX
                const top = box.top + window.scrollY
                el.style.transformOrigin = `${docX - left}px ${docY - top}px`
                el.style.willChange = "transform"
                if (radius > 0) {
                    el.style.borderRadius = `${radius}px`
                    el.style.overflow = "hidden"
                }
            }
        }

        const paint = () => {
            for (const el of painted) {
                el.style.transform = current < 0.9999 ? `scale(${current})` : ""
            }
        }

        const clear = () => {
            for (const [el, css] of restore) el.setAttribute("style", css)
            restore.clear()
            painted = []
            document.body.style.background = prevBodyBg
        }

        const tick = (now: number) => {
            const dt = Math.min(0.032, last ? (now - last) / 1000 : 0.016)
            last = now
            // Critically-ish damped spring; bounce trades damping for overshoot.
            const stiffness = 40 + speed * 260
            const damping = (2 * Math.sqrt(stiffness)) * (1.05 - bounce * 0.5)
            const accel = -stiffness * (current - goal) - damping * velocity
            velocity += accel * dt
            current += velocity * dt
            paint()

            const settled = Math.abs(current - goal) < 0.0005 && Math.abs(velocity) < 0.005
            if (settled) {
                current = goal
                velocity = 0
                paint()
                raf = 0
                last = 0
                if (!held && goal === 1) clear()
                return
            }
            raf = requestAnimationFrame(tick)
        }

        const run = () => {
            if (!raf) {
                last = 0
                raf = requestAnimationFrame(tick)
            }
        }

        const press = (e: PointerEvent) => {
            if (held) return
            held = true
            applyOrigins(e.pageX, e.pageY)
            if (matchBackdrop || backdrop) {
                const fill = backdrop || backdropAt(e.clientX, e.clientY)
                if (fill) document.body.style.background = fill
            }
            goal = scale
            run()
        }

        const release = () => {
            if (!held) return
            held = false
            goal = 1
            run()
        }

        // Capture phase, so a handler that stops propagation cannot swallow it.
        window.addEventListener("pointerdown", press, true)
        window.addEventListener("pointerup", release, true)
        window.addEventListener("pointercancel", release, true)
        window.addEventListener("blur", release)
        document.addEventListener("visibilitychange", release)

        return () => {
            window.removeEventListener("pointerdown", press, true)
            window.removeEventListener("pointerup", release, true)
            window.removeEventListener("pointercancel", release, true)
            window.removeEventListener("blur", release)
            document.removeEventListener("visibilitychange", release)
            if (raf) cancelAnimationFrame(raf)
            clear()
        }
    }, [live, enabled, scale, speed, bounce, radius, backdrop, matchBackdrop, selector])

    if (!live) {
        return (
            <div
                style={{
                    ...style,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    whiteSpace: "nowrap",
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: "rgba(13,16,19,0.86)",
                    color: "#e9eef0",
                    font: '600 9px/1.4 Inter, sans-serif',
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                }}
            >
                Press Scale
            </div>
        )
    }

    return <div ref={ref} aria-hidden style={{ ...style, width: 1, height: 1, opacity: 0 }} />
}

PressScale.displayName = "Press Scale"

addPropertyControls(PressScale, {
    enabled: { type: ControlType.Boolean, title: "Enabled", defaultValue: true },
    scale: {
        type: ControlType.Number,
        title: "Pressed",
        min: 0.8,
        max: 1,
        step: 0.005,
        defaultValue: 0.96,
        description: "How far the page eases back while the mouse is held down.",
    },
    speed: {
        type: ControlType.Number,
        title: "Speed",
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.45,
    },
    bounce: {
        type: ControlType.Number,
        title: "Bounce",
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.3,
        description: "How much it overshoots on the way back. 0 settles flat.",
    },
    radius: {
        type: ControlType.Number,
        title: "Corners",
        min: 0,
        max: 64,
        step: 1,
        defaultValue: 0,
        unit: "px",
    },
    matchBackdrop: {
        type: ControlType.Boolean,
        title: "Match gap",
        defaultValue: true,
        description:
            "Fills the gap with the colour of whatever you pressed on, so a full-bleed section does not look cropped.",
    },
    backdrop: {
        type: ControlType.Color,
        title: "Gap colour",
        defaultValue: "",
        description: "Overrides Match gap with one fixed colour.",
    },
    selector: {
        type: ControlType.String,
        title: "Target",
        placeholder: "auto",
        defaultValue: "",
        description:
            "The container whose direct children get scaled. Empty finds the page wrapper.",
    },
})
