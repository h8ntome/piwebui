/** Markdown renderer: marked -> sanitize -> highlight -> reference-style code cards. */
import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown, highlightWithin, declaredLang } from "../lib/md";
import { Icon } from "../lib/icons";
import { copyText } from "../lib/format";

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-copy-outline-regular"/></svg>`;
const DONE_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-check-outline-regular"/></svg>`;
const WRAP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-wrap-lines-outline-regular"/></svg>`;

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    highlightWithin(root);
    // Upgrade each fenced block into the reference code card (banner + language + copy).
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains("pw-codecard")) return;
      const code = pre.querySelector("code");
      // Read the language the fence declared, before highlighting could invent one (MD-02).
      const lang = code ? declaredLang(code) : "";
      const card = document.createElement("div");
      card.className = "pw-codecard";
      const header = document.createElement("div");
      header.className = "pw-codecard__header";
      const left = document.createElement("span");
      left.className = "pw-codecard__lang";
      left.textContent = lang;
      const btn = document.createElement("button");
      btn.className = "pw-codecard__copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = COPY_ICON;
      btn.addEventListener("click", () => {
        void copyText(pre.textContent ?? "").then((ok) => {
          btn.innerHTML = ok ? DONE_ICON : COPY_ICON;
          window.setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1200);
        });
      });
      header.append(left, btn);
      // An unlabelled block gets no header at all; long lines get a wrap control (MD-02, MD-06).
      if (pre.scrollWidth > pre.clientWidth || text.length > 200) {
        const wrapBtn = document.createElement("button");
        wrapBtn.className = "pw-codecard__copy";
        wrapBtn.setAttribute("aria-label", "Toggle word wrap");
        wrapBtn.setAttribute("aria-pressed", "false");
        wrapBtn.title = "Toggle word wrap";
        wrapBtn.innerHTML = WRAP_ICON;
        wrapBtn.addEventListener("click", () => {
          const on = card.classList.toggle("pw-codecard--wrap");
          wrapBtn.setAttribute("aria-pressed", on ? "true" : "false");
        });
        header.append(wrapBtn);
      }
      pre.replaceWith(card);
      card.append(header, pre);
      if (!lang) header.remove();
      // Overflow hint so clipped output is at least discoverable (MD-06).
      if (pre.scrollWidth > pre.clientWidth + 2) card.dataset.scrollable = "true";
    });
    root.querySelectorAll("table").forEach((t) => {
      if (t.parentElement?.classList.contains("pw-md__tableScroll")) return;
      const wrap = document.createElement("div");
      wrap.className = "pw-md__tableScroll";
      t.replaceWith(wrap);
      wrap.append(t);
    });
  }, [html, text]);

  return <div ref={ref} className={`pw-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function InlineIcon({ name }: { name: string }) { return <Icon name={name} size={14} />; }
