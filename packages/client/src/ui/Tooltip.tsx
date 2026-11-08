/** Hover tooltip with the reference bubble metrics (dark bubble, 3px/7px padding). */
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Portal } from "./Portal";

interface Place { top: number; left: number; side: "top" | "bottom"; }

/** How much room a bubble needs above/below the anchor before it would be clipped. */
const TIP_H = 30;
const EDGE = 6;

export function Tip({ label, side = "top", style, className, children }: {
  label: ReactNode; side?: "top" | "bottom"; style?: CSSProperties; className?: string; children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Header icons sit at the very top of the window: a "top" tooltip there used to land at
      // y = -21, i.e. completely off-screen. Flip to whichever side has room (SET-04).
      const fitsAbove = r.top - EDGE >= TIP_H;
      const fitsBelow = window.innerHeight - r.bottom - EDGE >= TIP_H;
      const flipped = side === "top" && !fitsAbove && fitsBelow;
      const chosen: "top" | "bottom" = flipped ? "bottom" : (side === "bottom" && !fitsBelow && fitsAbove ? "top" : side);
      setPlace({
        top: chosen === "top" ? r.top - 6 : r.bottom + 6,
        left: Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60),
        side: chosen,
      });
    }, 350);
  }, [side]);

  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setPlace(null);
  }, []);

  return (
    <span
      ref={anchor}
      className={className}
      style={{ display: "inline-flex", ...style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onPointerDown={hide}
    >
      {children}
      {place && (
        <Portal layer="tooltip">
          <span
            className="pw-tooltip"
            role="tooltip"
            style={{ top: place.top, left: place.left, transform: place.side === "top" ? "translate(-50%,-100%)" : "translate(-50%,0)" }}
          >
            {label}
          </span>
        </Portal>
      )}
    </span>
  );
}
