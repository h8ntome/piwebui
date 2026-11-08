import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Render children into document.body (menus, dialogs, toasts). */
export function Portal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  if (!ref.current && typeof document !== "undefined") {
    ref.current = document.createElement("div");
    ref.current.setAttribute("data-pw-portal", "");
  }
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    document.body.appendChild(el);
    return () => { el.remove(); };
  }, []);
  return ref.current ? createPortal(children, ref.current) : null;
}
