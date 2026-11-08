/** Anchored menu (dropdown + context menu) with the reference product's menu metrics. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";

export type MenuItem =
  | { kind: "item"; label: string; icon?: string | undefined; hint?: string | undefined;
      shortcut?: string[] | undefined; selected?: boolean | undefined; danger?: boolean | undefined;
      disabled?: boolean | undefined; title?: string | undefined; onSelect: () => void }
  | { kind: "heading"; label: string }
  | { kind: "sep" };

export function MenuItems({ items }: { items: MenuItem[] }) {
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "sep") return <div key={i} className="pw-menu__sep" role="separator" />;
        if (it.kind === "heading") return <div key={i} className="pw-menu__heading">{it.label}</div>;
        return (
          <button
            key={i}
            className={`pw-menu__item${it.selected ? " pw-menu__item--selected" : ""}${it.danger ? " pw-menu__item--danger" : ""}`}
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            disabled={it.disabled}
            title={it.title}
            onClick={() => { if (!it.disabled) it.onSelect(); }}
          >
            {it.icon && <span className="pw-menu__itemIcon"><Icon name={it.icon} /></span>}
            <span className="pw-menu__label pw-ellipsis">{it.label}</span>
            {it.hint && <span className="pw-menu__hint">{it.hint}</span>}
            {it.selected && <span className="pw-menu__check"><Icon name="check-outline" /></span>}
          </button>
        );
      })}
    </>
  );
}

export function MenuList({ items, footer }: { items: MenuItem[]; footer?: ReactNode | undefined }) {
  return (
    <div className="pw-menu__viewport" role="menu">
      <MenuItems items={items} />
      {footer && <div className="pw-menu__footer">{footer}</div>}
    </div>
  );
}

export interface MenuPosition { top: number; left: number; }

/** Place a menu next to an element, flipping at the viewport edges. */
export function anchorRect(rect: DOMRect, size: { w: number; h: number }, opts: { align?: "start" | "end" | "center"; side?: "top" | "bottom" } = {}): MenuPosition {
  const pad = 8;
  const align = opts.align ?? "start";
  const side = opts.side ?? "bottom";
  let left = align === "end" ? rect.right - size.w : align === "center" ? rect.left + rect.width / 2 - size.w / 2 : rect.left;
  left = Math.max(pad, Math.min(left, window.innerWidth - size.w - pad));
  let top = side === "top" ? rect.top - size.h - 4 : rect.bottom + 4;
  if (top + size.h > window.innerHeight - pad) top = Math.max(pad, rect.top - size.h - 4);
  if (top < pad) top = pad;
  return { top, left };
}

/** Floating menu rendered in a portal; closes on outside pointer, Escape, scroll or resize. */
export function FloatingMenu({ anchor, items, align = "start", side = "bottom", width, onClose, footer }: {
  anchor: HTMLElement | DOMRect | null;
  items: MenuItem[];
  align?: "start" | "end" | "center" | undefined;
  side?: "top" | "bottom" | undefined;
  width?: number | undefined;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const rect = anchor instanceof DOMRect ? anchor : anchor.getBoundingClientRect();
    const size = { w: width ?? el.offsetWidth, h: el.offsetHeight };
    setPos(anchorRect(rect, size, { align, side }));
  }, [anchor, align, side, width, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className="pw-menu"
      role="menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden", ...(width ? { width, minWidth: width } : null) }}
    >
      <MenuList items={items} footer={footer} />
    </div>,
    document.body,
  );
}

/** Button that opens a FloatingMenu anchored to itself. */
export function MenuTrigger({ render, children, align = "start", width }: {
  render: (api: { open: boolean; toggle: (e?: React.MouseEvent) => void; close: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  children: (close: () => void) => MenuItem[];
  align?: "start" | "end" | "center" | undefined;
  width?: number | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {render({
        open,
        ref,
        close: () => setOpen(false),
        toggle: (e) => { e?.preventDefault(); e?.stopPropagation(); setOpen((o) => !o); },
      })}
      {open && (
        <FloatingMenu
          anchor={ref.current}
          align={align}
          width={width}
          items={children(() => setOpen(false))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Right-click context menu. */
export function ContextMenu({ point, items, onClose }: { point: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  if (!point) return null;
  return <FloatingMenu anchor={new DOMRect(point.x, point.y, 0, 0)} items={items} onClose={onClose} />;
}
