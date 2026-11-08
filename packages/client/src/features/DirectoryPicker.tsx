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

  const go = useCallback(async (p: string) => {
    const out = await browse(p);
    if (!out) return;
    setData(out);
    setSelected(null);
    setPathDraft(out.path);
  }, [browse]);

  useEffect(() => { void go(initialPath || ""); }, [go, initialPath]);

  const entries = (data?.entries ?? []).filter((e) => e.kind === "dir" && (showHidden || !e.name.startsWith(".")));
  const rel = data ? data.path.replace(data.home, "~").replace(/^\/$/, "~") : "";
  const segs = data ? rel.split("/").filter(Boolean) : [];

  const jumpTo = (index: number) => {
    if (!data) return;
    if (index < 0) { void go(data.home); return; }
    const target = segs.slice(0, index + 1).map((s) => (s === "~" ? data.home : s)).join("/");
    void go(target.startsWith("/") || target.startsWith("~") ? (target.startsWith("~") ? data.home + target.slice(1) : target) : `/${target}`);
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="medium"
      footer={
        <>
          <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => setShowHidden((v) => !v)} style={{ marginRight: "auto", color: "var(--dsw-alias-label-secondary)" }}>
            {showHidden ? <Icon name="check-outline" size={13} /> : <span style={{ width: 13 }} />} Show hidden files
          </button>
          <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={onClose}>Cancel</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={!data} onClick={() => { if (data) onPick(selected ?? data.path); }}>{confirmLabel}</button>
        </>
      }
    >
      <div className="pw-dirpick">
        <div className="pw-dirpick__bar">
          {editing ? (
            <input
              className="pw-input"
              style={{ height: 28 }}
              value={pathDraft}
              autoFocus
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(pathDraft); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
              onBlur={() => setEditing(false)}
            />
          ) : (
            <>
              <button onClick={() => data && void go(data.home)} title="Home">Home</button>
              {segs.map((s, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ color: "var(--dsw-alias-label-caption)" }}>/</span>
                  <button onClick={() => jumpTo(i)}>{s}</button>
                </span>
              ))}
              <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Edit path" onClick={() => setEditing(true)}><Icon name="edit-outline" size={13} /></button>
            </>
          )}
        </div>
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
        {selected && <div style={{ marginTop: 8, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>Selected: {basename(selected)}</div>}
      </div>
    </Dialog>
  );
}

/** Rename / new-session-name prompt, reusing the same modal skin. */
export function PromptDialog({ title, label, initial, confirmLabel = "Save", onConfirm, onClose }: {
  title: string; label: string; initial: string; confirmLabel?: string;
  onConfirm: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={onClose}>Cancel</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={!value.trim()} onClick={() => onConfirm(value.trim())}>{confirmLabel}</button>
        </>
      }
    >
      <div style={{ paddingBottom: 24 }}>
        <div className="pw-row__title" style={{ marginBottom: 6 }}>{label}</div>
        <input className="pw-input pw-input--big" value={value} data-autofocus onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onConfirm(value.trim()); }} />
      </div>
    </Dialog>
  );
}

