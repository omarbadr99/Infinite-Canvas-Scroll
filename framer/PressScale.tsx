import { addPropertyControls, ControlType, RenderTarget } from "framer"
import { useEffect, useRef } from "react"

/**
 * Press Scale — a Framer code component.
 *
 * The press gesture from the infinite canvas, applied to an ordinary Framer
 * page: hold the mouse down anywhere and the whole page eases down a few
 * percent, release and it springs back.
 *
 * Drop one anywhere on a page. It draws nothing — it listens on the window and
 * transforms the page wrapper, so a press counts wherever it lands, including
 * on links, buttons and anything else that would normally swallow the event.
 *
 * The wrapper it scales is found by climbing from this component to the
 * outermost element still inside <body>, which is the page root whatever
 * Framer happens to call it that week. A selector can override that.
 *
 * Note: transforming an element makes it the containing block for any
 * `position: fixed` descendant. A fixed header inside the scaled wrapper will
 * scale and move with the page rather than staying pinned to the viewport —
 * usually what you want here, since the whole page is meant to shrink, but it
 * is the one thing that changes behaviour elsewhere on the site.
 *
 * @framerIntrinsicWidth 1
 * @framerIntrinsicHeight 1
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 * @framerDisableUnlink
 */

/** Approximations of the canvas's easings, so the two gestures feel alike. */
const EASE_IN = "cubic-bezier(0.075, 0.82, 0.165, 1)" // circ.out — quick bite
const EASE_OUT = "cubic-bezier(0.25, 0.46, 0.45, 0.94)" // power2.out — soft return

/** The outermost wrapper still inside <body> that contains us. */
function pageRoot(from: HTMLElement): HTMLElement {
    let node: HTMLElement = from
    while (node.parentElement && node.parentElement !== document.body) {
        node = node.parentElement
    }
    return node
}

export default function PressScale(props) {
    const { enabled, scale, pressIn, pressOut, selector, style } = props
    const ref = useRef<HTMLDivElement>(null)

    // Never on the Framer canvas: the page root there is the editor's own DOM,
    // and scaling that would squash the editor rather than the design.
    const live = RenderTarget.current() !== RenderTarget.canvas

    useEffect(() => {
        if (!live || !enabled) return
        const here = ref.current
        if (!here) return

        let target: HTMLElement | null = null
        if (selector) {
            try {
                target = document.querySelector(selector)
            } catch {
                target = null
            }
        }
        if (!target) target = pageRoot(here)
        if (!target) return

        const previous = target.getAttribute("style") || ""
        target.style.transformOrigin = "50% 50%"
        target.style.willChange = "transform"

        let held = false
        const press = () => {
            if (held) return
            held = true
            target!.style.transition = `transform ${pressIn}s ${EASE_IN}`
            target!.style.transform = `scale(${scale})`
        }
        const release = () => {
            if (!held) return
            held = false
            target!.style.transition = `transform ${pressOut}s ${EASE_OUT}`
            target!.style.transform = "scale(1)"
        }

        // Capture phase, so a handler that stops propagation cannot swallow it.
        window.addEventListener("pointerdown", press, true)
        window.addEventListener("pointerup", release, true)
        window.addEventListener("pointercancel", release, true)
        // A press that ends off-window, or while switching tabs, still has to
        // let go — otherwise the page stays shrunk.
        window.addEventListener("blur", release)
        document.addEventListener("visibilitychange", release)

        return () => {
            window.removeEventListener("pointerdown", press, true)
            window.removeEventListener("pointerup", release, true)
            window.removeEventListener("pointercancel", release, true)
            window.removeEventListener("blur", release)
            document.removeEventListener("visibilitychange", release)
            target!.setAttribute("style", previous)
        }
    }, [live, enabled, scale, pressIn, pressOut, selector])

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
        description: "How far the page shrinks while the mouse is held down.",
    },
    pressIn: {
        type: ControlType.Number,
        title: "Down",
        min: 0.05,
        max: 2,
        step: 0.05,
        defaultValue: 0.45,
        unit: "s",
    },
    pressOut: {
        type: ControlType.Number,
        title: "Up",
        min: 0.05,
        max: 2,
        step: 0.05,
        defaultValue: 0.85,
        unit: "s",
    },
    selector: {
        type: ControlType.String,
        title: "Target",
        placeholder: "auto",
        defaultValue: "",
        description:
            "Leave empty to scale the whole page. A CSS selector scales just that element instead.",
    },
})
