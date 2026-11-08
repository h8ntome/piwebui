/** Folder picker: browses real server-side directories through /api/v1/browse. */
import { useCallback, useEffect, useState } from "react";
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
    // instead of being thrown away (WS-02).
    if (!out) { setPathError(`“${p || "home"}” could not be opened.`); return; }
    setPathError(null);
    setData(out);
    setSelected(null);
    setPathDraft(out.path);
  }, [browse]);

  useEffect(() => { void go(initialPath || ""); }, [go, initialPath]);

  const entries = (data?.entries ?? []).filter((e) => e.kind === "dir" && (showHidden || !e.name.startsWith(".")));
  // One home crumb, then the path below it: the old render showed "Home / ~" for the same
  // directory twice and unlabelled segments.
  const rel = data ? (data.path === data.home ? "" : data.path.startsWith(data.home + "/") ? data.path.slice(data.home.length + 1) : data.path.replace(/^\/+/, "")) : "";
  const segs = rel ? rel.split("/").filter(Boolean) : [];

  const jumpTo = (index: number) => {
    if (!data) return;
    if (index < 0) { void go(data.home); return; }
    const target = segs.slice(0, index + 1).join("/");
    void go(`${data.home === "/" ? "" : data.home}/${target}`);
  };

  const chosen = selected ?? data?.path ?? null;

  const submitDraft = () => {
    const p = pathDraft.trim();
    if (!p) { setEditing(false); return; }
    void go(p);
    setEditing(false);
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
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitDraft(); } if (e.key === "Escape") { setEditing(false); setPathError(null); } }}
              />
              <button className="pw-btn pw-btn--sm pw-btn--primary" onClick={submitDraft}>Go</button>
              <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => { setEditing(false); setPathError(null); if (data) setPathDraft(data.path); }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => data && void go(data.home)} title="Home directory" aria-label="Go to home directory">Home</button>
              {segs.map((s, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "var(--dsw-alias-label-caption)" }}>/</span>
                  <button onClick={() => jumpTo(i)}>{s}</button>
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
