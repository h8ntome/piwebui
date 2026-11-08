/** Toast host: same look as the reference toast, and real actions (retry, dismiss). */
import { create } from "zustand";
import { Portal } from "./Portal";
import { Icon } from "../lib/icons";

export interface ToastItem { id: number; text: string; kind: "info" | "success" | "warning" | "error"; count: number; action?: { label: string; run: () => void } | undefined }

interface ToastStore {
  items: ToastItem[];
  push: (t: Omit<ToastItem, "id" | "count">, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (t, ttlMs = 4200) => {
    const id = seq++;
    set((s) => {
      // Repeats of the same message collapse into one row with a counter (SET-03): a burst of
      // identical failures used to bury the corner.
      const dup = s.items.find((x) => x.text === t.text && x.kind === t.kind);
      if (dup) return { items: s.items.map((x) => (x.id === dup.id ? { ...x, count: x.count + 1 } : x)) };
      return { items: [...s.items.slice(-3), { ...t, id, count: 1 }] };
    });
    if (ttlMs > 0) window.setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), ttlMs);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  info: (text: string, action?: Omit<ToastItem, "id" | "count">["action"]) => useToasts.getState().push({ text, kind: "info", action }),
  success: (text: string) => useToasts.getState().push({ text, kind: "success" }),
  warn: (text: string, action?: Omit<ToastItem, "id" | "count">["action"]) => useToasts.getState().push({ text, kind: "warning", action }),
  error: (text: string, action?: Omit<ToastItem, "id" | "count">["action"]) => useToasts.getState().push({ text, kind: "error", action }, 7000),
};

const ICONS: Record<ToastItem["kind"], string | null> = {
  info: null, success: "check-circle-fill", warning: "warning-outline", error: "warning-outline",
};

export function Toasts() {
  const { items, dismiss } = useToasts();
  return (
    <Portal layer="toast">
      {/* One polite live region, kept mounted so the first message is announced too (A11Y-05). */}
      <div className="pw-toasts" role="region" aria-label="Notifications" aria-live="polite" data-empty={items.length ? undefined : "true"}>
        {items.map((t) => (
          <div key={t.id} className="pw-toast" role={t.kind === "error" ? "alert" : "status"}>
            {ICONS[t.kind] && <span className={`pw-toast__icon${t.kind === "success" ? " pw-toast__icon--success" : ""}${t.kind === "error" ? " pw-toast__icon--error" : ""}`}><Icon name={ICONS[t.kind]!} /></span>}
            <span className="pw-toast__text">{t.text}{t.count > 1 ? <span className="pw-toast__count"> ×{t.count}</span> : null}</span>
            {t.action && <button className="pw-toast__action" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
            <button className="pw-toast__action" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="close-outline" size={12} /></button>
          </div>
        ))}
      </div>
    </Portal>
  );
}
