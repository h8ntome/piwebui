/** Icon sprite loader + <Icon/>. The sprite is the reference product's own icon set
    (extracted from its MIT-licensed client bundle) served from /icons.svg. */
import { useSyncExternalStore } from "react";

let spritePromise: Promise<string | null> | null = null;
let ready = false;
const subs = new Set<() => void>();
const notify = () => { for (const f of subs) f(); };

function loadSprite(): Promise<string | null> {
  if (!spritePromise) {
    spritePromise = fetch("/icons.svg")
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (!text) { spritePromise = null; return null; }
        const host = document.createElement("div");
        host.innerHTML = text;
        const svg = host.querySelector("svg");
        if (svg) {
          svg.setAttribute("data-dsh-icon-sprite", "");
          svg.setAttribute("aria-hidden", "true");
          document.body.prepend(svg);
          ready = true;
          notify();
        }
        return text;
      })
      .catch(() => { spritePromise = null; return null; });
  }
  return spritePromise;
}

/** Kick off (or reuse) the sprite fetch. Called on module load and by <Icon/>. */
export function ensureIcons(): Promise<string | null> {
  if (!document.querySelector("[data-dsh-icon-sprite]")) void loadSprite();
  else ready = true;
  return spritePromise ?? Promise.resolve(null);
}

function subscribe(cb: () => void) {
  subs.add(cb);
  ensureIcons();
  return () => { subs.delete(cb); };
}
const getSnapshot = () => ready;

/** Sprite symbol ids carry a weight suffix ("…-regular"); resolve short names. */
export function symbolId(name: string): string {
  if (!name) return "";
  return /-(regular|medium|mask)$/.test(name) ? `-${name}` : `-${name}-regular`;
}

export function Icon({ name, size = 16, strokeWidth, className, style }: {
  name: string; size?: number; strokeWidth?: number; className?: string; style?: React.CSSProperties;
}) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.3}
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#dsw-icon${symbolId(name)}`} />
    </svg>
  );
}

/** Names available in the sprite (used by the shortcuts/about dialog and tests). */
export const ICON_NAMES = [
  "new-chat-outline", "plus-outline", "folder-open", "folder-close", "search-outline",
  "settings-outline", "send-outline", "paperclip-outline", "think-outline", "stop-fill",
  "compact-outline", "shield-outline", "queue-outline", "user-outline", "dark-outline",
  "light-outline", "followsystem-outline", "ellipsis-outline", "chevron-down-outline",
  "chevron-right-outline", "chevron-left-outline", "chevron-up-outline", "panel-left-outline",
  "close-outline", "check-outline", "copy-outline", "download-outline", "refresh-outline",
  "warning-outline", "code-outline", "branch-outline", "gauge-outline", "data-outline",
  "workspace-tree-outline", "inspect-outline", "plan-outline", "goal-outline", "play-outline",
  "loading-outline", "sparkle", "share-outline", "edit-outline", "trash-outline",
  "sliders-two-outline", "list-pen-outline", "clock-outline", "info-outline", "question-outline",
  "tree-corner", "triangle-right-fill", "apps-add-outline", "agent-preset-outline",
  "checklist-outline", "right-up-outline", "fullscreen-outline", "browse-outline",
] as const;
