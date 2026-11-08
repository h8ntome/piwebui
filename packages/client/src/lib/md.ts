/** Markdown + sanitize + highlight pipeline for transcript content. */
import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: false });

/**
 * highlight.js's common language set is the single biggest thing in the bundle, and it is a
 * progressive enhancement: prose and code read fine before it lands. Load it on demand so the
 * first paint of the hero does not wait for it (PERF-02).
 */
type Hljs = typeof import("highlight.js/lib/common").default;
let hljsPromise: Promise<Hljs> | null = null;
function loadHljs(): Promise<Hljs> {
  if (!hljsPromise) hljsPromise = import("highlight.js/lib/common").then((m) => m.default ?? (m as unknown as Hljs));
  return hljsPromise;
}

export function renderMarkdown(src: string): string {
  let html = "";
  try { html = marked.parse(src, { async: false }) as string; } catch { html = `<p>${escapeHtml(src)}</p>`; }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "code", "pre",
      "blockquote", "strong", "em", "del", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "span", "sup", "sub", "input"],
    // `type` has to survive or `- [ ]` sanitises into a plain text input you can type into (MD-01).
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "align", "checked", "disabled", "type"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Language declared by the fence's info string, or "" for a block that never named one. */
export function declaredLang(code: HTMLElement): string {
  const cls = Array.from(code.classList).find((c) => c.startsWith("language-"));
  if (cls) return cls.slice("language-".length).toLowerCase();
  const data = code.dataset.lang;
  return data ? data.toLowerCase() : "";
}

/**
 * Highlight only blocks whose fence declared a language. Auto-detection used to invent
 * "css"/"lua" for plain prose and indented blocks, then label and colour them wrongly (MD-02).
 */
export async function highlightWithin(el: HTMLElement | null): Promise<void> {
  if (!el) return;
  const targets = Array.from(el.querySelectorAll<HTMLElement>("pre > code:not([data-hljs])"));
  if (!targets.length) return;
  const wanted = targets
    .map((b) => ({ el: b, lang: declaredLang(b) }))
    .filter((t) => !!t.lang);
  targets.forEach((b) => { b.dataset.hljs = "1"; });
  if (!wanted.length) return;
  const hljs = await loadHljs();
  for (const { el: b, lang } of wanted) {
    if (!hljs.getLanguage(lang)) {
      // Keep the declared label (the header shows it) but render the text un-highlighted.
      b.dataset.lang = lang;
      b.classList.remove(`language-${lang}`);
      continue;
    }
    try {
      b.innerHTML = hljs.highlight(b.textContent ?? "", { language: lang, ignoreIllegals: true }).value;
      b.classList.add("hljs");
      b.dataset.lang = lang;
    } catch { /* leave the block as plain text */ }
  }
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
