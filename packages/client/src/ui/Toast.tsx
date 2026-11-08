/** Toast host: same look as the reference toast, and real actions (retry, dismiss). */
import { create } from "zustand";
import { Portal } from "./Portal";
import { Icon } from "../lib/icons";

export interface ToastItem { id: number; text: string; kind: "info" | "success" | "warning" | "error"; action?: { label: string; run: () => void } | undefined }

interface ToastStore {
  items: ToastItem[];
  push: (t: Omit<ToastItem, "id">, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (t, ttlMs = 4200) => {
    const id = seq++;
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    if (ttlMs > 0) window.setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), ttlMs);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  info: (text: string, action?: ToastItem["action"]) => useToasts.getState().push({ text, kind: "info", action }),
  success: (text: string) => useToasts.getState().push({ text, kind: "success" }),
  warn: (text: string, action?: ToastItem["action"]) => useToasts.getState().push({ text, kind: "warning", action }),
  error: (text: string, action?: ToastItem["action"]) => useToasts.getState().push({ text, kind: "error", action }, 7000),
};

const ICONS: Record<ToastItem["kind"], string | null> = {
  info: null, success: "check-circle-fill", warning: "warning-outline", error: "warning-outline",
};

export function Toasts() {
  const { items, dismiss } = useToasts();
  if (!items.length) return null;
  return (
    <Portal>
      <div className="pw-toasts">
        {items.map((t) => (
          <div key={t.id} className="pw-toast" role="status">
            {ICONS[t.kind] && <span className={`pw-toast__icon${t.kind === "success" ? " pw-toast__icon--success" : ""}${t.kind === "error" ? " pw-toast__icon--error" : ""}`}><Icon name={ICONS[t.kind]!} /></span>}
            <span className="pw-toast__text">{t.text}</span>
            {t.action && <button className="pw-toast__action" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
            <button className="pw-toast__action" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="close-outline" size={12} /></button>
          </div>
        ))}
      </div>
    </Portal>
  );
}
