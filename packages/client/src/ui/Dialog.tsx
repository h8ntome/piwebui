/** Modal dialog with the reference panel metrics (28px radius, mask, header/body/footer). */
import { useEffect, useRef, type ReactNode } from "react";
import { Portal } from "./Portal";
import { Icon } from "../lib/icons";

export function Dialog({ title, description, children, footer, size = "sm", onClose }: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "medium" | "wide";
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    const t = window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("[data-autofocus],input,textarea,button");
      el?.focus();
    }, 30);
    return () => { window.removeEventListener("keydown", onKey, true); window.clearTimeout(t); };
  }, [onClose]);

  return (
    <Portal>
      <div className="pw-modalRoot" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="pw-modalRoot__mask" onPointerDown={onClose} />
        <div ref={ref} className={`pw-dialog${size === "wide" ? " pw-dialog--wide" : size === "medium" ? " pw-dialog--medium" : ""}`} tabIndex={-1}>
          <div className="pw-dialog__header">
            <h2 className="pw-dialog__title">{title}</h2>
            <button className="pw-dialog__close" aria-label="Close" onClick={onClose}><Icon name="close-outline" /></button>
          </div>
          {description && <p className="pw-dialog__desc">{description}</p>}
          {children && <div className="pw-dialog__body">{children}</div>}
          {footer && <div className="pw-dialog__footer">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}
