/** Markdown renderer: marked -> sanitize -> highlight -> reference-style code cards. */
import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown, highlightWithin } from "../lib/md";
import { Icon } from "../lib/icons";
import { copyText } from "../lib/format";

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
      const lang = code ? Array.from(code.classList).find((c) => c.startsWith("language-"))?.slice(9) ?? "" : "";
      const card = document.createElement("div");
      card.className = "pw-codecard";
      const header = document.createElement("div");
      header.className = "pw-codecard__header";
      const left = document.createElement("span");
      left.className = "pw-codecard__lang";
      left.textContent = lang || "text";
      const btn = document.createElement("button");
      btn.className = "pw-codecard__copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-copy-outline-regular"/></svg>`;
      btn.addEventListener("click", () => { void copyText(pre.textContent ?? ""); btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-check-outline-regular"/></svg>`; window.setTimeout(() => { btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><use href="#dsw-icon-copy-outline-regular"/></svg>`; }, 1200); });
      header.append(left, btn);
      pre.replaceWith(card);
      card.append(header, pre);
      if (!lang) header.remove();
    });
    root.querySelectorAll("table").forEach((t) => {
      if (t.parentElement?.classList.contains("pw-md__tableScroll")) return;
      const wrap = document.createElement("div");
      wrap.className = "pw-md__tableScroll";
      t.replaceWith(wrap);
      wrap.append(t);
    });
  }, [html]);

  return <div ref={ref} className={`pw-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function InlineIcon({ name }: { name: string }) { return <Icon name={name} size={14} />; }
