/** Composer: reference-shaped card with real Pi controls (model, thinking, delivery mode,
    queue, abort, image attachments, extension dialogs). */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type DialogRequest, type ModelInfo, type SessionView, type WireImage } from "../lib/store";
import { useSettings } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { basename, oneLine } from "../lib/format";
import { toast } from "../ui/Toast";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type Delivery = "start" | "steer" | "followUp";

function readImage(file: File): Promise<WireImage | null> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result ?? "");
      const b64 = s.slice(s.indexOf(",") + 1);
      if (b64.length > MAX_IMAGE_BYTES) { toast.error(`${file.name} is too large (max 5 MB encoded)`); resolve(null); return; }
      const mime = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/gif" ? "image/gif" : file.type === "image/webp" ? "image/webp" : "image/png";
      resolve({ mimeType: mime, dataBase64: b64, name: file.name });
    };
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(file);
  });
}

function ApprovalCard({ d }: { d: DialogRequest }) {
  const answer = useStore((s) => s.answerDialog);
  const [text, setText] = useState(d.prefill ?? "");
  const [cancelled] = useState(false);
  return (
    <div className="pw-approval" role="group" aria-label="Runtime request">
      <div className="pw-approval__head">
        <span className="pw-approval__title">{d.title}</span>
        <span className="pw-approval__kind">{d.kind} · from the pi runtime{d.expiresAt ? " · expires" : ""}</span>
      </div>
      {d.message && <div className="pw-approval__body"><span style={{ whiteSpace: "pre-wrap" }}>{d.message}</span></div>}
      {d.kind === "confirm" && (
        <div className="pw-approval__row">
          <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => void answer(d, false)}>Deny</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" data-autofocus onClick={() => void answer(d, true)}>Allow</button>
        </div>
      )}
      {d.kind === "select" && (
        <div className="pw-approval__options">
          {(d.options ?? []).map((o, i) => (
            <button key={i} className="pw-approval__option" onClick={() => void answer(d, i)}>{o}</button>
          ))}
          <button className="pw-approval__option" style={{ color: "var(--dsw-alias-label-tertiary)" }} onClick={() => void answer(d, null, true)}>Cancel</button>
        </div>
      )}
      {(d.kind === "input" || d.kind === "editor") && (
        <>
          {d.kind === "editor"
            ? <textarea className="pw-input" style={{ height: 140, fontFamily: "var(--ds-font-family-code)", fontSize: 12 }} value={text} placeholder={d.placeholder} onChange={(e) => setText(e.target.value)} />
            : <input className="pw-input" value={text} placeholder={d.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void answer(d, text); } }} data-autofocus />}
          <div className="pw-approval__row">
            <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => void answer(d, null, true)}>Cancel</button>
            <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={cancelled} onClick={() => void answer(d, text)}>Submit</button>
          </div>
        </>
      )}
    </div>
  );
}

function QueueDock({ v }: { v: SessionView }) {
  const [open, setOpen] = useState(true);
  const command = useStore((s) => s.command);
  const q = v.runtime?.queue;
  const items = q?.items ?? [];
  const count = q?.count ?? items.length;
  if (!q?.hasPending && !count) return null;
  return (
    <div className="pw-dock">
      <div className="pw-dock__panel">
        <button className="pw-dock__header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="queue-outline" size={14} />
          <span className="pw-dock__count">{count} queued</span>
          <span className="pw-dock__chevron"><Icon name={open ? "chevron-up-outline" : "chevron-down-outline"} size={13} /></span>
        </button>
        {open && items.length > 0 && (
          <ul className="pw-dock__list">
            {items.map((it, i) => (
              <li key={i} className="pw-dock__row">
                <span className="pw-dock__status">{it.kind === "steer" ? "steer" : "follow-up"}</span>
                <span className="pw-dock__preview">{oneLine(it.text, 120)}</span>
              </li>
            ))}
          </ul>
        )}
        {v.status?.capabilities?.clearQueue && (
          <div style={{ padding: "4px 12px 8px", display: "flex", justifyContent: "flex-end" }}>
            <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => void command({ type: "clearQueue" })}>Clear queue</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Hero placeholder chips: the catalogue belongs to a running pi, so these say so
    instead of pretending to have data. */
function PendingChip({ kind }: { kind: "model" | "thinking" }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [{
    kind: "item",
    label: kind === "model" ? "No model until the session starts" : "No thinking level until the session starts",
    disabled: true, onSelect: () => undefined,
  }];
  return (
    <>
      <button className="pw-composer__select pw-composer__select--plain" aria-label={kind === "model" ? "Select model" : "Thinking level"}
        aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}>
        {kind === "model" ? "Select model" : "thinking off"}
      </button>
      {anchor && <FloatingMenu anchor={anchor} align="end" width={240} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

function ModelMenu({ v }: { v: SessionView }) {
  const command = useStore((s) => s.command);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const cur = v.runtime?.model;
  const models = v.models.filter((m) => m.available !== false);
  const items: MenuItem[] = [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  for (const [provider, list] of byProvider) {
    items.push({ kind: "heading", label: provider });
    for (const m of list) {
      items.push({
        kind: "item",
        label: m.name ?? m.modelId,
        icon: m.reasoning ? "think-outline" : undefined,
        hint: m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k ctx` : undefined,
        selected: cur?.provider === provider && cur.modelId === m.modelId,
        onSelect: () => { void command({ type: "setModel", provider, modelId: m.modelId }); setAnchor(null); },
      });
    }
  }
  if (!items.length) items.push({ kind: "item", label: "No model catalogue (no owning runtime)", disabled: true, onSelect: () => undefined });
  return (
    <>
      <button className="pw-composer__select" aria-label="Select model" aria-expanded={!!anchor} disabled={!v.status?.capabilities?.setModel}
        onClick={(e) => setAnchor(e.currentTarget)}>
        {cur ? (cur.name ?? `${cur.provider}/${cur.modelId}`) : "Select model"}
      </button>
      {anchor && <FloatingMenu anchor={anchor} align="end" width={280} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

function ThinkingMenu({ v }: { v: SessionView }) {
  const command = useStore((s) => s.command);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const level = v.runtime?.thinkingLevel ?? "off";
  const items: MenuItem[] = THINKING_LEVELS.map((l) => ({
    kind: "item",
    label: l === "off" ? "Off" : l,
    selected: level === l,
    onSelect: () => { void command({ type: "setThinking", level: l }); setAnchor(null); },
  }));
  return (
    <>
      <button className="pw-composer__select pw-composer__select--plain" aria-label="Thinking level" aria-expanded={!!anchor}
        disabled={!v.status?.capabilities?.setThinking} onClick={(e) => setAnchor(e.currentTarget)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Icon name="think-outline" size={13} />
          {level === "off" ? "thinking off" : `think:${level}`}
        </span>
      </button>
      {anchor && <FloatingMenu anchor={anchor} align="end" width={156} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

export function Composer({ v, hero, onSendHero }: { v: SessionView | null; hero: boolean; onSendHero?: (text: string, images: WireImage[]) => void }) {
  const command = useStore((s) => s.command);
  const sendOnEnter = useSettings((s) => s.sendOnEnter);
  const [text, setText] = useState("");
  const [images, setImages] = useState<WireImage[]>([]);
  const [delivery, setDelivery] = useState<Delivery>("start");
  const [menu, setMenu] = useState<{ kind: "add"; anchor: HTMLElement } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const caps = v?.status?.capabilities ?? ({} as Record<string, boolean>);
  const busy = !!v?.runtime?.isStreaming || v?.runtime?.phase === "streaming" || v?.runtime?.phase === "tool";
  const canSend = v ? !!caps.promptStart : !!onSendHero;
  const effDelivery: Delivery = busy ? (delivery === "start" ? "followUp" : delivery) : "start";
  const dialogs = (v?.dialogs ?? []).filter((d) => !d.observed);

  // auto-grow
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 336)}px`;
  }, [text]);

  const submit = () => {
    const body = text.trim();
    if (!body && !images.length) return;
    if (!canSend) {
      toast.warn(v ? "This session has no controllable runtime; it is a read-only view of the log." : "Choose a workspace folder first.");
      return;
    }
    if (v) void command({ type: "prompt", text: body, delivery: effDelivery, ...(images.length ? { images } : {}) });
    else onSendHero?.(body, images);
    setText("");
    setImages([]);
  };

  const addMenuItems = useMemo<MenuItem[]>(() => {
    const out: MenuItem[] = [{
      kind: "heading", label: "Add",
    }, {
      kind: "item", label: "Image", icon: "paperclip-outline", hint: "png, jpg, gif, webp",
      disabled: !canSend || images.length >= MAX_IMAGES,
      onSelect: () => { fileRef.current?.click(); setMenu(null); },
    }];
    const cmds: MenuItem[] = [];
    if (caps.compact) cmds.push({ kind: "item", label: "Compact", icon: "compact-outline", hint: "Summarise older history", disabled: busy, onSelect: () => { void command({ type: "compact", instructions: "" }); setMenu(null); } });
    if (caps.clearQueue && ((v?.runtime?.queue?.count ?? 0) > 0)) cmds.push({ kind: "item", label: "Clear queue", icon: "queue-outline", hint: `${v?.runtime?.queue?.count} pending`, onSelect: () => { void command({ type: "clearQueue" }); setMenu(null); } });
    if (caps.stopForTerminal && v?.status?.mode === "managed") cmds.push({ kind: "item", label: "Return to terminal", icon: "right-up-outline", hint: "stop here, resume in a terminal", onSelect: () => { void command({ type: "stopForTerminal", mode: "settle" }); setMenu(null); } });
    for (const c of v?.commands ?? []) {
      cmds.push({ kind: "item", label: `/${c.name}`, hint: c.description, disabled: !canSend, onSelect: () => { setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}/${c.name} `); taRef.current?.focus(); setMenu(null); } });
    }
    if (cmds.length) out.push({ kind: "sep" }, { kind: "heading", label: "Commands" }, ...cmds);
    return out;
  }, [caps, busy, canSend, images.length, v?.commands, v?.runtime?.queue?.count, v?.status?.mode, command]);

  const placeholder = !canSend
    ? (v && (v.status?.mode === "mirror" || v.status?.mode === "history")
      ? "Read-only view — this session has no running pi to control"
      : !v ? "Choose a workspace folder to start"
      : "No controllable runtime")
    : busy
      ? (effDelivery === "steer" ? "Steer the current run…" : "Queue a follow-up…")
      : hero
        ? "Describe what you want to build"
        : "Send a message to pi";

  return (
    <div className={`pw-composer${hero ? " pw-composer--hero" : ""}`}>
      {v?.notes?.length ? <div className="pw-composer__notice">{v.notes[v.notes.length - 1]}</div> : null}
      {v && v.status?.capabilities?.queue === "none" && busy ? <div className="pw-composer__notice">Queue contents are not exposed by this runtime.</div> : null}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []).slice(0, MAX_IMAGES - images.length);
          const loaded = (await Promise.all(files.map(readImage))).filter(Boolean) as WireImage[];
          setImages((cur) => [...cur, ...loaded].slice(0, MAX_IMAGES));
          e.target.value = "";
        }}
      />
      {dialogs.length > 0 && <ApprovalCard d={dialogs[0]!} />}
      {v && <QueueDock v={v} />}
      <div className={`pw-composer__card${!v ? " pw-composer__card--pendingPick" : ""}`}>
        {images.length > 0 && (
          <div className="pw-composer__accessory">
            {images.map((im, i) => (
              <span className="pw-attachment" key={i}>
                <img className="pw-attachment__img" src={`data:${im.mimeType};base64,${im.dataBase64}`} alt="" />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span className="pw-attachment__name">{basename(im.name ?? "image")}</span>
                  <span className="pw-attachment__meta">{im.mimeType.replace("image/", "")}</span>
                </span>
                <button className="pw-iconBtn pw-attachment__x" aria-label="Remove attachment" onClick={() => setImages((x) => x.filter((_, j) => j !== i))}><Icon name="close-outline" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="pw-composer__scroll">
          <textarea
            ref={taRef}
            className="pw-composer__input"
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={!canSend && !busy}
            onChange={(e) => setText(e.target.value)}
            onPaste={async (e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              const loaded = (await Promise.all(files.slice(0, MAX_IMAGES - images.length).map(readImage))).filter(Boolean) as WireImage[];
              setImages((cur) => [...cur, ...loaded].slice(0, MAX_IMAGES));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && sendOnEnter) { e.preventDefault(); submit(); }
              if (e.key === "Enter" && e.shiftKey && !sendOnEnter) { e.preventDefault(); submit(); }
              if (e.key === "Escape" && dialogs.length) e.stopPropagation();
            }}
          />
        </div>
        <div className="pw-composer__row">
          <div className="pw-composer__tools">
              <button className="pw-composer__add" aria-label="Add files or run commands" aria-expanded={menu?.kind === "add"}
                onClick={(e) => setMenu({ kind: "add", anchor: e.currentTarget })}>
                <Icon name="plus-outline" size={15} />
              </button>
              {busy && (
                <div className="pw-composer__modes">
                  <button className={`pw-pill pw-pill--interactive${effDelivery === "steer" ? " pw-pill--active" : ""}`} aria-label="Steer the current run" disabled={!caps.promptSteer} onClick={() => setDelivery("steer")}>Steer</button>
                  <button className={`pw-pill pw-pill--interactive${effDelivery === "followUp" ? " pw-pill--active" : ""}`} aria-label="Queue a follow-up" disabled={!caps.promptFollowUp} onClick={() => setDelivery("followUp")}>Follow-up</button>
                </div>
              )}
          </div>
          <div className="pw-composer__trailing">
            {v ? <ThinkingMenu v={v} /> : <PendingChip kind="thinking" />}
            {v ? <ModelMenu v={v} /> : <PendingChip kind="model" />}
            {busy && caps.abort ? (
              <button className="pw-composer__send" data-sending="true" aria-label="Stop the run" onClick={() => void command({ type: "abort" })}
                style={{ background: "var(--dsw-alias-button-primary-fill)" }}>
                <Icon name="stop-fill" size={13} />
              </button>
            ) : (
              <button className="pw-composer__send" aria-label="Send message" disabled={(!text.trim() && !images.length) || !canSend} onClick={submit}>
                <Icon name="send-outline" size={15} strokeWidth={1.6} />
              </button>
            )}
          </div>
        </div>
      </div>
      {menu?.kind === "add" && menu.anchor.isConnected && <FloatingMenu anchor={menu.anchor} items={addMenuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
