/** Markdown + sanitize + highlight pipeline for transcript content. */
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

const marked = new Marked({ gfm: true, breaks: false });

export function renderMarkdown(src: string): string {
  let html = "";
  try { html = marked.parse(src, { async: false }) as string; } catch { html = `<p>${escapeHtml(src)}</p>`; }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "code", "pre",
      "blockquote", "strong", "em", "del", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "span", "sup", "sub", "input"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "align", "checked", "disabled"],
    ALLOW_DATA_ATTR: false,
  });
}

/** call after inserting html to highlight fenced code blocks */
export function highlightWithin(el: HTMLElement | null) {
  if (!el) return;
  el.querySelectorAll<HTMLElement>("pre code:not([data-hljs])").forEach((b) => {
    b.dataset.hljs = "1";
    try { hljs.highlightElement(b); } catch { /* ignore */ }
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function setLinkPolicy() {
  // open links in new tabs, never same-frame navigation hijacks
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a");
    if (a && a.href && !a.target) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  });
}
