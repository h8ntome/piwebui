/** Composer: reference-shaped card with real Pi controls (model, thinking, delivery mode,
    queue, abort, image attachments, extension dialogs). */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type DialogRequest, type ModelInfo, type SessionView, type WireImage } from "../lib/store";
import { useSettings } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { ConfirmDialog } from "../ui/Dialog";
import { Tip } from "../ui/Tooltip";
import { basename, oneLine, tokens } from "../lib/format";
import { isReadOnlyMode } from "../lib/labels";
import { toast } from "../ui/Toast";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Base64 grows ~4/3, so the file limit is the encoded budget translated back to bytes. */
const MAX_IMAGE_FILE_BYTES = Math.floor(MAX_IMAGE_BYTES * 0.75);
const MAX_IMAGE_MB_LABEL = (MAX_IMAGE_FILE_BYTES / (1024 * 1024)).toFixed(1);

type Delivery = "start" | "steer" | "followUp";

function readImage(file: File): Promise<WireImage | null> {
  return new Promise((resolve) => {
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      // "max 5 MB encoded" meant nothing to a reader (CTL-01); talk about the file.
      toast.error(`${file.name} is too large — images must be under ${MAX_IMAGE_MB_LABEL} MB`);
      resolve(null);
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result ?? "");
      const b64 = s.slice(s.indexOf(",") + 1);
      const mime = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/gif" ? "image/gif" : file.type === "image/webp" ? "image/webp" : "image/png";
      resolve({ mimeType: mime, dataBase64: b64, name: file.name });
    };
    fr.onerror = () => { toast.error(`Could not read ${file.name}`); resolve(null); };
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
        <div style={{ padding: "4px 12px 8px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {/* The runtime only exposes "drop the whole queue"; say so instead of looking broken. */}
          {!v.status?.capabilities?.clearQueue && <span className="pw-dock__note">This runtime cannot remove single items.</span>}
          {v.status?.capabilities?.clearQueue && (
            <button className="pw-btn pw-btn--sm pw-btn--ghost" onClick={() => void command({ type: "clearQueue" })}>Clear queue</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hero placeholder chips: the catalogue belongs to a running pi, so these say so
    instead of pretending to have data — and they no longer open an empty menu (HERO-03). */
function PendingHint({ kind }: { kind: "model" | "thinking" }) {
  return (
    <span className="pw-composer__hintChip" aria-label={kind === "model" ? "Model chosen when the session starts" : "Thinking level chosen when the session starts"}>
      {kind === "model" ? "model: starts with the session" : "thinking: starts with the session"}
    </span>
  );
}

function ModelMenu({ v, keyName }: { v: SessionView; keyName: string }) {
  const command = useStore((s) => s.command);
  const loadCatalogue = useStore((s) => s.loadCatalogue);
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
        hint: m.contextWindow ? `${tokens(m.contextWindow)} ctx` : undefined,
        selected: cur?.provider === provider && cur.modelId === m.modelId,
        role: "menuitemradio",
        onSelect: () => { void command({ type: "setModel", provider, modelId: m.modelId }); setAnchor(null); },
      });
    }
  }
  if (!items.length) {
    items.push({
      kind: "item",
      label: v.status?.capabilities?.setModel ? "Loading the model list from the runtime…" : "This session has no model catalogue",
      disabled: true, onSelect: () => undefined,
    });
  }
  const enabled = !!v.status?.capabilities?.setModel;
  return (
    <>
      <button className="pw-composer__select" aria-label="Select model" aria-expanded={!!anchor} disabled={!enabled}
        title={enabled ? "Change the model" : "This session cannot change models"}
        onClick={(e) => {
          setAnchor(e.currentTarget);
          // The catalogue may not have existed when the session was opened (CTL-02).
          if (!v.models.length) void loadCatalogue(keyName);
        }}>
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
  // A model that cannot reason silently reverts any non-off level; say so instead of
  // letting the choice bounce back with no explanation (CTL-04).
  const cur = v.models.find((m) => m.provider === v.runtime?.model?.provider && m.modelId === v.runtime?.model?.modelId);
  const reasoningUnsupported = cur?.reasoning === false;
  const items: MenuItem[] = THINKING_LEVELS.map((l) => ({
    kind: "item",
    label: l === "off" ? "Off" : l,
    selected: level === l,
    role: "menuitemradio" as const,
    disabled: reasoningUnsupported && l !== "off",
    title: reasoningUnsupported && l !== "off" ? `${cur?.name ?? cur?.modelId ?? "This model"} does not support thinking levels` : undefined,
    onSelect: () => { void command({ type: "setThinking", level: l }); setAnchor(null); },
  }));
  const enabled = !!v.status?.capabilities?.setThinking;
  return (
    <>
      <button className="pw-composer__select pw-composer__select--plain" aria-label="Thinking level" aria-expanded={!!anchor}
        disabled={!enabled} title={reasoningUnsupported ? "The selected model does not support thinking levels" : "Change the thinking level"}
        onClick={(e) => setAnchor(e.currentTarget)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Icon name="think-outline" size={13} />
          {level === "off" ? "thinking off" : `think:${level}`}
        </span>
      </button>
      {anchor && <FloatingMenu anchor={anchor} align="end" width={196} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

export function Composer({ v, keyName, hero, pendingPick, onSendHero }: { v: SessionView | null; keyName?: string; hero: boolean; pendingPick?: boolean; onSendHero?: (text: string, images: WireImage[]) => void }) {
  const command = useStore((s) => s.command);
  const sendOnEnter = useSettings((s) => s.sendOnEnter);
  const [text, setText] = useState("");
  const [images, setImages] = useState<WireImage[]>([]);
  const [delivery, setDelivery] = useState<Delivery>("start");
  const [menu, setMenu] = useState<{ kind: "add"; anchor: HTMLElement } | null>(null);
  const [confirmCmd, setConfirmCmd] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const [dismissedNotes, setDismissedNotes] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const caps = v?.status?.capabilities ?? ({} as Record<string, boolean>);
  const busy = !!v?.runtime?.isStreaming || v?.runtime?.phase === "streaming" || v?.runtime?.phase === "tool";
  const canSend = v ? !!caps.promptStart : !!onSendHero;
  const readOnlySession = isReadOnlyMode(v?.status?.mode);
  const effDelivery: Delivery = busy ? (delivery === "start" ? "followUp" : delivery) : "start";
  const dialogs = (v?.dialogs ?? []).filter((d) => !d.observed);
  const notes = (v?.notes ?? []).filter((n) => !dismissedNotes.includes(n));

  // Auto-grow: re-measure on resize and on session change, not only when the text changes,
  // and reset the height first so a shrinking value is measured honestly (CTL-09).
  useEffect(() => {
    const grow = () => {
      const ta = taRef.current;
      if (!ta) return;
      const cap = window.innerWidth < 640 ? Math.round(window.innerHeight * 0.28) : 336;
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
    };
    grow();
    window.addEventListener("resize", grow);
    const t = window.setTimeout(grow, 120);
    return () => { window.removeEventListener("resize", grow); window.clearTimeout(t); };
  }, [text, keyName, v?.status?.runtime?.runtimeId, images.length]);

  const submit = async () => {
    const body = text.trim();
    if (!body && !images.length) return;
    if (!canSend) {
      toast.warn(v ? "This session is read-only: there is no running pi to send to." : "Choose a workspace folder first.");
      return;
    }
    if (!v) { onSendHero?.(body, images); return; }
    const ok = await command({ type: "prompt", text: body, delivery: effDelivery, ...(images.length ? { images } : {}) });
    // Keep the draft when the runtime refused it, so the words are not lost (ATT-01).
    if (ok) { setText(""); setImages([]); }
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
    // Both of these stop or rewrite the run: ask first, they used to fire instantly (CTL-11).
    if (caps.compact) cmds.push({ kind: "item", label: "Compact context", icon: "compact-outline", hint: "Summarise older history", disabled: busy, onSelect: () => { setMenu(null); setConfirmCmd({ title: "Compact the context now?", body: "pi will summarise the older history of this session. The full transcript on disk is not changed.", run: () => void command({ type: "compact", instructions: "" }) }); } });
    if (caps.clearQueue && ((v?.runtime?.queue?.count ?? 0) > 0)) cmds.push({ kind: "item", label: "Clear queue", icon: "queue-outline", hint: `${v?.runtime?.queue?.count} pending`, onSelect: () => { void command({ type: "clearQueue" }); setMenu(null); } });
    if (caps.stopForTerminal && v?.status?.mode === "managed") cmds.push({ kind: "item", label: "Return to terminal", icon: "right-up-outline", hint: "stop here, resume in a terminal", onSelect: () => { setMenu(null); setConfirmCmd({ title: "Return this run to a terminal?", body: "The current run is stopped so the same session can be resumed from a terminal pi.", run: () => void command({ type: "stopForTerminal", mode: "settle" }) }); } });
    for (const c of v?.commands ?? []) {
      cmds.push({ kind: "item", label: `/${c.name}`, hint: c.description, disabled: !canSend, onSelect: () => { setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}/${c.name} `); taRef.current?.focus(); setMenu(null); } });
    }
    if (cmds.length) out.push({ kind: "sep" }, { kind: "heading", label: "Commands" }, ...cmds);
    return out;
  }, [caps, busy, canSend, images.length, v?.commands, v?.runtime?.queue?.count, v?.status?.mode, command]);

  const placeholder = !canSend
    ? (readOnlySession ? "Read-only session" : !v ? "Choose a workspace folder to start" : "No controllable runtime")
    : busy
      ? (effDelivery === "steer" ? "Steer the current run…" : "Queue a follow-up…")
      : hero
        ? "Describe what you want to build"
        : "Send a message to pi";

  return (
    <div className={`pw-composer${hero ? " pw-composer--hero" : ""}`} data-readonly={readOnlySession ? "true" : undefined}>
      {notes.length > 0 && (
        <div className="pw-composer__notices" role="status" aria-live="polite">
          {notes.slice(-2).map((n) => (
            <div className="pw-composer__notice" key={n}>
              <span>{n}</span>
              <button className="pw-iconBtn" aria-label="Dismiss notice" onClick={() => setDismissedNotes((d) => [...d, n])}><Icon name="close-outline" size={11} /></button>
            </div>
          ))}
        </div>
      )}
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
      <div className={`pw-composer__card${pendingPick ? " pw-composer__card--pendingPick" : ""}`}>
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
            aria-disabled={!canSend || undefined}
            onChange={(e) => setText(e.target.value)}
            onPaste={async (e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              const loaded = (await Promise.all(files.slice(0, MAX_IMAGES - images.length).map(readImage))).filter(Boolean) as WireImage[];
              setImages((cur) => [...cur, ...loaded].slice(0, MAX_IMAGES));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && sendOnEnter) { e.preventDefault(); void submit(); }
              if (e.key === "Enter" && e.shiftKey && !sendOnEnter) { e.preventDefault(); void submit(); }
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
                  <Tip label={caps.promptSteer ? "Send now and interrupt the current run" : "This runtime cannot be steered"}>
                    <button className={`pw-pill pw-pill--interactive${effDelivery === "steer" ? " pw-pill--active" : ""}`} aria-label="Steer the current run" disabled={!caps.promptSteer} onClick={() => setDelivery("steer")}>Steer</button>
                  </Tip>
                  <Tip label={caps.promptFollowUp ? "Send after this turn finishes" : "This runtime cannot queue follow-ups"}>
                    <button className={`pw-pill pw-pill--interactive${effDelivery === "followUp" ? " pw-pill--active" : ""}`} aria-label="Queue a follow-up" disabled={!caps.promptFollowUp} onClick={() => setDelivery("followUp")}>Follow-up</button>
                  </Tip>
                </div>
              )}
          </div>
          <div className="pw-composer__trailing">
            {v ? <ThinkingMenu v={v} /> : <PendingHint kind="thinking" />}
            {v ? <ModelMenu v={v} keyName={keyName ?? ""} /> : <PendingHint kind="model" />}
            {busy && caps.abort ? (
              <button className="pw-composer__send" data-sending="true" aria-label="Stop the run" onClick={() => void command({ type: "abort" })}
                style={{ background: "var(--dsw-alias-button-primary-fill)" }}>
                <Icon name="stop-fill" size={13} />
              </button>
            ) : (
              <button className="pw-composer__send" aria-label="Send message" disabled={(!text.trim() && !images.length) || !canSend} onClick={() => void submit()}>
                <Icon name="send-outline" size={15} strokeWidth={1.6} />
              </button>
            )}
          </div>
        </div>
      </div>
      {menu?.kind === "add" && menu.anchor.isConnected && <FloatingMenu anchor={menu.anchor} items={addMenuItems} onClose={() => setMenu(null)} />}
      {confirmCmd && (
        <ConfirmDialog
          title={confirmCmd.title}
          body={confirmCmd.body}
          confirmLabel="Yes, do it"
          onConfirm={() => { confirmCmd.run(); setConfirmCmd(null); }}
          onCancel={() => setConfirmCmd(null)}
        />
      )}
    </div>
  );
}
