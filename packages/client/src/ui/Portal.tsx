import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Render children into document.body (menus, dialogs, toasts) so nothing in the app frame can
 * paint over them. Each overlay kind gets its own layer from the documented scale in tokens.css
 * (`--pw-z-scrim` … `--pw-z-toast`); the container is click-through and the overlay itself
 * re-enables pointer events. This is what keeps a dialog from rendering under the right panel.
 */
export type PortalLayer = "scrim" | "dialog" | "menu" | "tooltip" | "toast";

export function Portal({ children, layer = "dialog" }: { children: ReactNode; layer?: PortalLayer }) {
  const ref = useRef<HTMLDivElement | null>(null);
  if (!ref.current && typeof document !== "undefined") {
    ref.current = document.createElement("div");
    ref.current.setAttribute("data-pw-portal", layer);
    ref.current.className = `pw-portal pw-portal--${layer}`;
  }
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    document.body.appendChild(el);
    return () => { el.remove(); };
  }, []);
  return ref.current ? createPortal(children, ref.current) : null;
}
