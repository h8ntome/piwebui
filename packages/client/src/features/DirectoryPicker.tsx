/** Folder picker: browses real server-side directories through /api/v1/browse. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../lib/icons";
import { useStore, type BrowseResult } from "../lib/store";
import { basename } from "../lib/format";

export function DirectoryPicker({ initialPath, title = "Select Workspace Directory", confirmLabel = "Open", onPick, onClose }: {
  initialPath?: string | null;
  title?: string;
  confirmLabel?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const browse = useStore((s) => s.browse);
  const [data, setData] = useState<BrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  const go = useCallback(async (p: string) => {
    const out = await browse(p);
    // A failed browse keeps the typed path and the field open, so a typo is fixable in place
    // instead of being thrown away (WS-02). The caller decides when to close the field.
    if (!out) { setPathError(`“${p || "home"}” could not be opened.`); return false; }
    setPathError(null);
    setData(out);
    setSelected(null);
    setPathDraft(out.path);
    return true;
  }, [browse]);

  useEffect(() => { void go(initialPath || ""); }, [go, initialPath]);

  const entries = (data?.entries ?? []).filter((e) => e.kind === "dir" && (showHidden || !e.name.startsWith(".")));
  // Breadcrumbs are the *absolute* path walked one segment at a time. Joining them onto `home`
  // (as this used to) made every folder outside $HOME unreachable: clicking `ws` in
  // /tmp/audit/ws/x tried to open /home/dev/tmp/audit/ws (BUG-010).
  const crumbs = useMemo(() => {
    if (!data) return [] as { label: string; path: string }[];
    if (data.path === data.home) return [];
    const underHome = data.path.startsWith(data.home === "/" ? "/" : data.home + "/");
    const base = underHome ? data.home : data.path.startsWith("/") ? "" : ".";
    const rest = underHome ? data.path.slice(base.length) : data.path;
    let acc = base;
    return rest.split("/").filter(Boolean).map((label) => {
      if (acc === "" || acc === ".") acc = data.path.startsWith("/") ? "/" + label : label;
      else acc = acc.endsWith("/") ? acc + label : `${acc}/${label}`;
      return { label, path: acc };
    });
  }, [data]);

  const jumpTo = (index: number) => {
    if (!data) return;
    const crumb = crumbs[index];
    void go(crumb ? crumb.path : data.home);
  };

  const chosen = selected ?? data?.path ?? null;

  const submitDraft = async () => {
    const p = pathDraft.trim();
    if (!p) { setEditing(false); return; }
    // Only close the field once the path actually opened; on failure it stays mounted with the
    // text intact, which is what the comment in `go` promises (BUG-011).
    const opened = await go(p);
    if (opened) setEditing(false);
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button className="pw-btn pw-btn--sm pw-btn--ghost" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)} style={{ marginRight: "auto", color: "var(--dsw-alias-label-secondary)" }}>
            {showHidden ? <Icon name="check-outline" size={13} /> : <span style={{ width: 13 }} />} Show hidden files
          </button>
          <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={onClose}>Cancel</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={!chosen} onClick={() => { if (chosen) onPick(chosen); }} title={chosen ?? undefined}>{confirmLabel}</button>
        </>
      }
    >
      <div className="pw-dirpick">
        <div className="pw-dirpick__bar">
          {editing ? (
            <>
              <input
                className="pw-input"
                style={{ height: 28, flex: 1 }}
                aria-label="Folder path"
                value={pathDraft}
                autoFocus
                onChange={(e) => { setPathDraft(e.target.value); setPathError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitDraft(); } if (e.key === "Escape") { setEditing(false); setPathError(null); } }}
              />
              <button className="pw-btn pw-btn--sm pw-btn--primary" onClick={() => void submitDraft()}>Go</button>
              <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => { setEditing(false); setPathError(null); if (data) setPathDraft(data.path); }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => data && void go(data.home)} title="Home directory" aria-label="Go to home directory">Home</button>
              {crumbs.map((c, i) => (
                <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "var(--dsw-alias-label-caption)" }}>/</span>
                  <button onClick={() => jumpTo(i)}>{c.label}</button>
                </span>
              ))}
              <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Type a path" title="Type a path" onClick={() => { setEditing(true); setPathDraft(data?.path ?? ""); }}><Icon name="edit-outline" size={13} /></button>
            </>
          )}
        </div>
        {pathError && <div className="pw-dirpick__error" role="alert"><Icon name="warning-outline" size={13} /> {pathError}</div>}
        <div className="pw-dirpick__list" role="listbox" aria-label="Directories">
          {data?.parent && (
            <button className="pw-dirpick__item" onClick={() => void go(data.parent!)}><Icon name="chevron-up-outline" size={14} /> ..</button>
          )}
          {entries.map((e) => {
            const full = `${data!.path.replace(/\/$/, "")}/${e.name}`;
            return (
              <button
                key={e.name}
                className={`pw-dirpick__item${selected === full ? " pw-dirpick__item--active" : ""}`}
                role="option"
                aria-selected={selected === full}
                onClick={() => setSelected(selected === full ? null : full)}
                onDoubleClick={() => onPick(full)}
              >
                <Icon name="folder-close" size={15} style={{ color: "var(--dsw-static-deepseek-500)" }} />
                {e.name}
              </button>
            );
          })}
          {!entries.length && <div className="pw-sessions__empty" style={{ marginTop: 24 }}>No folders here</div>}
        </div>
        <div className="pw-dirpick__chosen">
          {selected
            ? <span>Selected: <span className="pw-mono">{selected}</span></span>
            : <span>No folder clicked — the folder you are browsing will be used: <span className="pw-mono">{data?.path ?? "…"}</span></span>}
        </div>
        {data?.truncated && <div className="pw-row__desc" style={{ marginTop: 4 }}>This folder has more entries than the listing shows.</div>}
      </div>
    </Dialog>
  );
}

/** Rename / new-session-name prompt, reusing the same modal skin. */
export function PromptDialog({ title, label, initial, hint, placeholder, confirmLabel = "Save", onConfirm, onClose }: {
  title: string; label: string; initial: string; hint?: string | undefined; placeholder?: string | undefined; confirmLabel?: string;
  onConfirm: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const tooLong = trimmed.length > 120;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={onClose}>Cancel</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={!trimmed || tooLong} onClick={() => onConfirm(trimmed)}>{confirmLabel}</button>
        </>
      }
    >
      <div style={{ paddingBottom: 24 }}>
        <div className="pw-row__title" style={{ marginBottom: 6 }}>{label}</div>
        <input className="pw-input pw-input--big" value={value} data-autofocus maxLength={140}
          placeholder={placeholder}
          aria-describedby={hint ? "pw-prompt-hint" : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && trimmed && !tooLong) onConfirm(trimmed); }} />
        <div className="pw-row__desc" id="pw-prompt-hint" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{tooLong ? "Keep it under 120 characters." : (hint ?? "Up to 120 characters.")}</span>
          <span style={{ flex: "none", opacity: 0.7 }}>{trimmed.length}/120</span>
        </div>
      </div>
    </Dialog>
  );
}
