import React from "react";
import { BlockBody, ReviewContext, TYPE_LABEL } from "./Blocks.jsx";
import { Inline, Markdown } from "./Markdown.jsx";
import { STATIC, api, compareDrafts, copyText, describeTarget, feedbackAsText, inspectLink, store, timeLabel } from "./lib.js";

const POLL_MS = 1200;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="var(--bp-accent-emphasis)" />
      <path d="M7 7h10M7 12h10M7 17h6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Link preview: links never navigate. They can be inspected and copied.
// ---------------------------------------------------------------------------
function LinkPreview({ link, onClose }) {
  const [copied, setCopied] = React.useState(false);
  const info = React.useMemo(() => inspectLink(link.url, link.text), [link]);
  const left = Math.max(8, Math.min(link.x, window.innerWidth - 428));
  const top = Math.max(8, Math.min(link.y + 6, window.innerHeight - 260));
  React.useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} data-bp-interactive>
      <div
        role="dialog"
        aria-label="Link preview"
        className="box fixed w-[420px] max-w-[calc(100vw-16px)] p-3 flex flex-col gap-2"
        style={{ left, top, boxShadow: "var(--bp-shadow)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold">Link preview</span>
          <span className="label">Will not open</span>
        </div>
        {info.parsed && (
          <div className="text-[13px]">
            <span className="text-muted">Goes to: </span>
            <span className="font-semibold">{info.parsed.hostname || info.parsed.protocol}</span>
          </div>
        )}
        <div className="font-mono text-[12px] bg-subtle border border-line rounded-md p-2 break-all max-h-28 overflow-auto select-all">
          {info.url}
        </div>
        {info.warnings.map((warning, i) => (
          <div key={i} className="text-[12px] text-attention border-l-4 border-attention pl-2">
            {warning}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-sm"
            autoFocus
            onClick={async () => {
              setCopied(await copyText(info.url));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" className="btn btn-sm btn-invisible" onClick={onClose}>
            Close
          </button>
          <span className="text-muted text-[12px] ml-auto">Paste it into your browser only if you trust it.</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
function useAttachments(initial = []) {
  const [files, setFiles] = React.useState(initial);
  const [error, setError] = React.useState("");
  const add = React.useCallback(async (list, limit) => {
    setError("");
    for (const file of list) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setError("Only PNG, JPEG and WebP images can be attached.");
        continue;
      }
      try {
        const saved = await api.upload(file);
        setFiles((current) => (current.length >= limit || current.some((f) => f.id === saved.id) ? current : [...current, { id: saved.id, name: file.name || "image" }]));
      } catch (uploadError) {
        setError(uploadError.message);
      }
    }
  }, []);
  const remove = (id) => setFiles((current) => current.filter((f) => f.id !== id));
  return { files, setFiles, add, remove, error };
}

function AttachmentRow({ attachments, limit, disabled }) {
  const input = React.useRef(null);
  if (STATIC) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {attachments.files.map((file) => (
        <span key={file.id} className="inline-flex items-center gap-1 border border-line rounded-md p-1 bg-subtle">
          <img src={`/api/attachment/${file.id}`} alt={file.name} className="w-8 h-8 object-cover rounded" />
          <button type="button" className="btn btn-sm btn-invisible !px-1" aria-label={`Remove ${file.name}`} onClick={() => attachments.remove(file.id)}>
            ×
          </button>
        </span>
      ))}
      <button type="button" className="btn btn-sm btn-invisible" disabled={disabled || attachments.files.length >= limit} onClick={() => input.current?.click()}>
        Attach image
      </button>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES.join(",")}
        multiple
        hidden
        onChange={(event) => {
          attachments.add(Array.from(event.target.files || []), limit);
          event.target.value = "";
        }}
      />
      {attachments.error && <span className="text-danger text-[12px]" role="alert">{attachments.error}</span>}
    </div>
  );
}

const pastedImages = (event) => Array.from(event.clipboardData?.files || []).filter((file) => IMAGE_TYPES.includes(file.type));

// ---------------------------------------------------------------------------
// Annotation card
// ---------------------------------------------------------------------------
function AnnotationCard({ card, limit, onQueue, onClose }) {
  const [text, setText] = React.useState(card.comment || "");
  const attachments = useAttachments(card.attachments || []);
  const left = Math.max(8, Math.min(card.x, window.innerWidth - 388));
  const top = Math.max(56, Math.min(card.y + 10, window.innerHeight - 330));
  const empty = text.trim() === "" && attachments.files.length === 0;
  const queue = () => {
    if (empty) return;
    onQueue({ key: card.key, comment: text.trim(), target: card.target, attachments: attachments.files });
  };
  return (
    <div
      role="dialog"
      aria-label="Add a note"
      data-bp-interactive
      className="box fixed z-40 w-[380px] max-w-[calc(100vw-16px)] p-3 flex flex-col gap-2"
      style={{ left, top, boxShadow: "var(--bp-shadow)" }}
    >
      <div className="text-[12px] font-semibold text-muted">{describeTarget(card.target)}</div>
      {card.target.quote && <div className="quote-line max-h-16 overflow-hidden">{card.target.quote.slice(0, 220)}</div>}
      <textarea
        className="field"
        rows={4}
        autoFocus
        placeholder="What should change here?"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const images = pastedImages(event);
          if (images.length) attachments.add(images, limit);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            queue();
          } else if (event.key === "Escape" && empty) onClose();
        }}
      />
      <AttachmentRow attachments={attachments} limit={limit} />
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" disabled={empty} onClick={queue}>
          {card.key ? "Save note" : "Queue note"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
        <span className="text-muted text-[11px] ml-auto">Enter queues · Shift+Enter new line</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation panel pieces
// ---------------------------------------------------------------------------
function ItemView({ item }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12px] font-semibold text-muted">{describeTarget(item.target)}</div>
      {item.target?.quote && <div className="quote-line max-h-10 overflow-hidden">{item.target.quote.slice(0, 160)}</div>}
      {item.answer?.choiceLabels?.length > 0 && (
        <div>
          <span className="font-semibold">Answer: </span>
          {item.answer.choiceLabels.join(", ")}
        </div>
      )}
      {item.answer?.text && <div className="whitespace-pre-wrap break-words"><span className="font-semibold">Answer: </span>{item.answer.text}</div>}
      {item.comment && <div className="whitespace-pre-wrap break-words">{item.comment}</div>}
      {item.attachments?.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {item.attachments.map((attachment) => {
            const id = typeof attachment === "string" ? attachment : attachment.id;
            return <img key={id} src={`/api/attachment/${id}`} alt="Attached image" className="w-12 h-12 object-cover rounded border border-line" />;
          })}
        </div>
      )}
    </div>
  );
}

function Receipt({ batch, agentListening }) {
  const steps = [
    ["Seen", batch.seenAt],
    ["Working", batch.workingAt],
    ["Done", batch.doneAt],
  ];
  return (
    <div className="flex items-center gap-1 flex-wrap text-[11px]">
      {steps.map(([name, at]) => (
        <span key={name} className={`label ${at ? "label-success" : ""}`} title={at ? `${name} ${timeLabel(at)}` : `${name}: not yet`} style={at ? undefined : { opacity: 0.55 }}>
          {at ? "✓ " : ""}
          {name}
        </span>
      ))}
      {!batch.seenAt && <span className="text-muted">{agentListening ? "Delivering…" : "Waiting for the agent to check in"}</span>}
    </div>
  );
}

function ChangeLog({ drafts, plans, latestPlan, viewing, onView, onJump }) {
  const entries = [...drafts].reverse();
  const notes = new Map((latestPlan?.changelog || []).map((entry) => [entry.draft, entry]));
  return (
    <div className="flex flex-col gap-3">
      {entries.map(({ n, at }) => {
        const note = notes.get(n);
        const current = plans.get(n);
        const previous = plans.get(n - 1);
        const diff = n > 1 && current && previous ? compareDrafts(previous, current) : null;
        return (
          <div key={n} className={`box ${viewing === n ? "!border-accent" : ""}`}>
            <div className="box-header flex items-center gap-2 !px-3">
              <span>Draft {n}</span>
              <span className="text-muted text-[12px] font-normal">{timeLabel(at)}</span>
              <button type="button" className="btn btn-sm btn-invisible ml-auto" onClick={() => onView(n)}>
                {viewing === n ? "Viewing" : "View"}
              </button>
            </div>
            <div className="p-3 flex flex-col gap-2 text-[13px]">
              {note ? (
                <>
                  <div><Inline text={note.summary} /></div>
                  {note.changes?.length > 0 && (
                    <ul className="list-disc pl-5 flex flex-col gap-1">
                      {note.changes.map((change, i) => (
                        <li key={i}><Inline text={change} /></li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <div className="text-muted">{n === 1 ? "First draft." : "The agent did not describe this draft."}</div>
              )}
              {diff && diff.added.length + diff.changed.length + diff.removed.length > 0 && (
                <div className="border-t border-line-muted pt-2 flex flex-col gap-1">
                  <div className="text-muted text-[11px] font-semibold uppercase tracking-wide">Detected automatically</div>
                  {[
                    ["Added", "label-success", diff.added],
                    ["Changed", "label-attention", diff.changed],
                    ["Removed", "label-danger", diff.removed],
                  ].map(([name, className, list]) =>
                    list.map((entry) => (
                      <div key={`${name}-${entry.id}`} className="flex items-center gap-2">
                        <span className={`label ${className}`}>{name}</span>
                        {name === "Removed" ? (
                          <span className="truncate">{entry.sectionTitle} › {TYPE_LABEL[entry.title] || entry.title}</span>
                        ) : (
                          <button type="button" className="text-accent text-left truncate hover:underline cursor-pointer bg-transparent border-0 p-0" onClick={() => onJump(n, entry.id)}>
                            {entry.sectionTitle} › {TYPE_LABEL[entry.title] || entry.title}
                          </button>
                        )}
                      </div>
                    )),
                  )}
                </div>
              )}
              {diff && diff.added.length + diff.changed.length + diff.removed.length === 0 && <div className="text-muted text-[12px]">Only the title, summary or change log changed.</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Target resolution for annotations
// ---------------------------------------------------------------------------
const SKIP = "[data-bp-interactive], [data-bp-link], button, input, textarea, select, label, summary";

function resolveTarget(origin) {
  if (!(origin instanceof Element) || origin.closest(SKIP)) return null;
  const blockEl = origin.closest("[data-block]");
  if (!blockEl) return null;
  const base = { sectionId: blockEl.dataset.section, blockId: blockEl.dataset.block };
  let el = null;
  let kind = "block";
  let part;
  let label = blockEl.dataset.title;
  const diagram = origin.closest(".bp-diagram");
  const html = origin.closest(".bp-html");
  if (diagram) {
    el = origin.closest("g.node, g.cluster, g.edgeLabel, g.actor, g.note, g.classGroup, g.statediagram-state, g[id]");
    if (el && diagram.contains(el) && el !== diagram.querySelector("svg > g")) {
      kind = "diagram";
      part = (el.getAttribute("id") || el.getAttribute("class") || "element").slice(0, 100);
      label = "Diagram element";
    } else el = null;
  } else if (html) {
    if (origin !== html) {
      el = origin;
      kind = "item";
      part = `${origin.tagName.toLowerCase()}:${Array.from(html.querySelectorAll(origin.tagName)).indexOf(origin) + 1}`;
      label = "Illustration element";
    }
  } else {
    el = origin.closest("[data-anno]");
    if (el && blockEl.contains(el)) {
      kind = el.dataset.annoKind || "block";
      part = el.dataset.anno;
      label = el.dataset.annoLabel || label;
    } else el = null;
  }
  const source = el || blockEl;
  const quote = (source.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { el: source, target: { ...base, kind, part, label, quote } };
}

function findTargetElement(target) {
  if (!target?.blockId) return null;
  const blockEl = document.querySelector(`[data-block="${CSS.escape(target.blockId)}"]`);
  if (!blockEl) return null;
  if (target.part && target.kind !== "diagram" && target.kind !== "text") {
    const part = blockEl.querySelector(`[data-anno="${CSS.escape(target.part)}"]`);
    if (part) return part;
  }
  return blockEl;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [server, setServer] = React.useState(
    STATIC ? { draft: STATIC.draft, drafts: STATIC.drafts, conversation: [], batches: [], planName: STATIC.planName, ended: false, agentListening: false } : null,
  );
  const [lost, setLost] = React.useState(false);
  const [plans, setPlans] = React.useState(() => new Map(STATIC ? Object.entries(STATIC.plans).map(([n, p]) => [Number(n), p]) : []));
  const [viewDraft, setViewDraft] = React.useState(null);
  const storageKey = `bp-queue:${server?.planName || ""}`;
  const [queue, setQueue] = React.useState([]);
  const [queueLoaded, setQueueLoaded] = React.useState(false);
  const [card, setCard] = React.useState(null);
  const [link, setLink] = React.useState(null);
  const [tab, setTab] = React.useState("conversation");
  const [annotate, setAnnotate] = React.useState(true);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [message, setMessage] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [slide, setSlide] = React.useState(0);
  const [copyFallback, setCopyFallback] = React.useState("");
  const [theme, setTheme] = React.useState(() => {
    try {
      const saved = window.localStorage.getItem("bp-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // ignore
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const composerAttachments = useAttachments();
  const planRef = React.useRef(null);
  const hoverRef = React.useRef(null);
  const logRef = React.useRef(null);

  // Theme
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("bp-theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Poll the local server
  React.useEffect(() => {
    if (STATIC) return undefined;
    let stopped = false;
    let failures = 0;
    let timer;
    const tick = async () => {
      try {
        const next = await api.state();
        failures = 0;
        if (!stopped) {
          setLost(false);
          setServer((current) => (current && current.version === next.version ? current : next));
        }
      } catch {
        failures += 1;
        if (failures >= 3 && !stopped) setLost(true);
      }
      if (!stopped) timer = window.setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  const latest = server?.draft || 0;
  const shown = viewDraft ?? latest;
  const plan = plans.get(shown) || null;
  const previousPlan = plans.get(shown - 1) || null;
  const latestPlan = plans.get(latest) || null;
  const readOnly = Boolean(server?.ended) || shown !== latest || lost;
  const limit = server?.limits?.attachmentsPerItem ?? 4;

  // Load drafts on demand
  React.useEffect(() => {
    if (STATIC || !server) return;
    const wanted = new Set([latest, shown, shown - 1]);
    if (tab === "changelog") for (const d of server.drafts.slice(-40)) wanted.add(d.n);
    for (const n of wanted) {
      if (n < 1 || plans.has(n) || !server.drafts.some((d) => d.n === n)) continue;
      api
        .draft(n)
        .then((loaded) => setPlans((current) => (current.has(n) ? current : new Map(current).set(n, loaded))))
        .catch(() => {});
    }
  }, [server, latest, shown, tab, plans]);

  // Queue persistence (per tab)
  React.useEffect(() => {
    if (!server?.planName || queueLoaded) return;
    setQueue(store.get(storageKey, []));
    setQueueLoaded(true);
  }, [server?.planName, queueLoaded, storageKey]);
  React.useEffect(() => {
    if (queueLoaded) store.set(storageKey, queue);
  }, [queue, queueLoaded, storageKey]);

  React.useEffect(() => {
    if (plan?.title) document.title = `${plan.title} · Draft ${shown} · Blueprint`;
  }, [plan?.title, shown]);

  // Link previews (from Markdown chips and from sanitised HTML)
  React.useEffect(() => {
    const onLink = (event) => setLink(event.detail);
    window.addEventListener("bp-link", onLink);
    return () => window.removeEventListener("bp-link", onLink);
  }, []);

  // Mark elements that have queued notes
  React.useEffect(() => {
    const root = planRef.current;
    if (!root) return;
    root.querySelectorAll(".bp-noted").forEach((el) => el.classList.remove("bp-noted"));
    if (shown !== latest) return;
    for (const item of queue) findTargetElement(item.target)?.classList.add("bp-noted");
  });

  React.useEffect(() => {
    if (tab === "conversation") logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [server?.conversation?.length, server?.batches?.length, queue.length, tab]);

  const changes = React.useMemo(() => (shown > 1 && plan && previousPlan ? compareDrafts(previousPlan, plan) : null), [plan, previousPlan, shown]);
  const changeKind = React.useMemo(() => {
    const map = new Map();
    if (changes) {
      changes.added.forEach((entry) => map.set(entry.id, "New"));
      changes.changed.forEach((entry) => map.set(entry.id, "Changed"));
    }
    return map;
  }, [changes]);

  const queueItem = React.useCallback((item, replaceKey) => {
    setQueue((current) => {
      const key = replaceKey || item.key || uid();
      const next = { ...item, key };
      return current.some((q) => q.key === key) ? current.map((q) => (q.key === key ? next : q)) : [...current, next];
    });
    setCard(null);
    setTab("conversation");
    setPanelOpen(true);
  }, []);

  const flash = (el) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("bp-flash");
    void el.offsetWidth;
    el.classList.add("bp-flash");
  };

  const jumpTo = (n, blockId) => {
    setViewDraft(n === latest ? null : n);
    if (plans.get(n)?.layout === "slides") {
      const index = plans.get(n).sections.findIndex((section) => section.blocks.some((b) => b.id === blockId));
      if (index >= 0) setSlide(index);
    }
    window.setTimeout(() => flash(document.querySelector(`[data-block="${CSS.escape(blockId)}"]`)), 120);
  };

  // ----- Annotation events on the plan surface -----
  const canAnnotate = annotate && !readOnly;
  const onPlanClick = (event) => {
    const chip = event.target instanceof Element ? event.target.closest("[data-bp-link]") : null;
    if (chip && !chip.hasAttribute("tabindex")) {
      // Chip created by the HTML sanitiser (React chips handle themselves).
      event.preventDefault();
      const rect = chip.getBoundingClientRect();
      setLink({ url: chip.getAttribute("data-bp-link"), text: chip.textContent || "", x: rect.left, y: rect.bottom });
      return;
    }
    if (!canAnnotate) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return; // handled on mouseup
    const resolved = resolveTarget(event.target);
    if (!resolved) return;
    const existing = queue.find(
      (item) => item.target.blockId === resolved.target.blockId && item.target.part === resolved.target.part && item.target.kind === resolved.target.kind && item.target.kind !== "text",
    );
    setCard({ x: event.clientX, y: event.clientY, target: resolved.target, key: existing?.key, comment: existing?.comment, attachments: existing?.attachments });
  };
  const onPlanMouseUp = (event) => {
    if (!canAnnotate) return;
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (!text) return;
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    if (!anchor || anchor.closest(SKIP)) return;
    const blockEl = anchor.closest("[data-block]");
    if (!blockEl || !planRef.current?.contains(blockEl)) return;
    const partEl = anchor.closest("[data-anno]");
    setCard({
      x: event.clientX,
      y: event.clientY,
      target: {
        kind: "text",
        sectionId: blockEl.dataset.section,
        blockId: blockEl.dataset.block,
        part: partEl && blockEl.contains(partEl) ? partEl.dataset.anno : undefined,
        label: `Selected text in ${blockEl.dataset.title}`,
        quote: text.slice(0, 1500),
      },
    });
  };
  const onPlanMouseOver = (event) => {
    if (hoverRef.current) hoverRef.current.classList.remove("bp-hover");
    hoverRef.current = null;
    if (!canAnnotate || card) return;
    const resolved = resolveTarget(event.target);
    if (resolved) {
      resolved.el.classList.add("bp-hover");
      hoverRef.current = resolved.el;
    }
  };

  // ----- Sending -----
  const pendingItems = () => {
    const items = queue.map(({ comment, target, answer, attachments }) => ({ comment, target, answer, attachments: (attachments || []).map((a) => a.id) }));
    if (message.trim() !== "" || composerAttachments.files.length > 0) {
      items.push({ comment: message.trim(), target: { kind: "general", label: "General" }, attachments: composerAttachments.files.map((a) => a.id) });
    }
    return items;
  };
  const pendingCount = queue.length + (message.trim() !== "" || composerAttachments.files.length > 0 ? 1 : 0);

  const send = async (end) => {
    const items = pendingItems();
    if (items.length === 0 && !end) {
      setNotice("Nothing queued yet. Click part of the plan to add a note, or write a message below.");
      return;
    }
    if (end && !window.confirm(items.length ? "Send these notes and end the review?" : "End the review? The agent will stop waiting for feedback.")) return;
    setSending(true);
    setNotice("");
    try {
      if (items.length === 0) await api.end();
      else await api.feedback({ items, draft: latest, end });
      setQueue([]);
      setMessage("");
      composerAttachments.setFiles([]);
      setCard(null);
    } catch (error) {
      setNotice(`Not sent: ${error.message}. Your notes are still queued.`);
    } finally {
      setSending(false);
    }
  };

  const copyFeedback = async () => {
    const text = feedbackAsText(plan?.title || "", shown, pendingItems());
    const ok = await copyText(text);
    setNotice(ok ? "Feedback copied. Paste it into your chat with the agent." : "Could not reach the clipboard. Copy the text below instead.");
    setCopyFallback(ok ? "" : text);
  };

  // ----- Rendering -----
  if (!server || (!plan && !server.planError && latest > 0)) {
    return <div className="h-full flex items-center justify-center text-muted">{lost ? "Cannot reach the local review server." : "Loading plan…"}</div>;
  }

  const slides = plan?.layout === "slides";
  const sections = plan ? (slides ? [plan.sections[Math.min(slide, plan.sections.length - 1)]] : plan.sections) : [];
  const timeline = [
    ...(server.batches || []).map((batch) => ({ kind: "batch", at: batch.at, batch })),
    ...(server.conversation || []).map((entry) => ({ kind: entry.role, at: entry.at, entry })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return (
    <ReviewContext.Provider value={{ queueItem, readOnly, theme, queued: queue }}>
      <div className="h-full flex flex-col" data-annotate={canAnnotate ? "on" : "off"}>
        {/* Header */}
        <header className="flex items-center gap-3 px-4 h-14 shrink-0 bg-subtle border-b border-line">
          <Mark />
          <div className="min-w-0 flex items-baseline gap-2">
            <span className="font-semibold truncate">{plan?.title || server.planName}</span>
            <span className="text-muted text-[12px] font-mono truncate hidden md:inline">{server.planName}</span>
          </div>
          <span className={`label ${shown === latest ? "label-accent" : "label-attention"}`}>Draft {shown}{shown !== latest ? ` of ${latest}` : ""}</span>
          {server.drafts.length > 1 && (
            <select
              className="field !w-auto !py-0.5 !px-2 text-[12px] h-7"
              aria-label="View a draft"
              value={shown}
              onChange={(event) => {
                const n = Number(event.target.value);
                setViewDraft(n === latest ? null : n);
                setCard(null);
              }}
            >
              {[...server.drafts].reverse().filter((d) => !STATIC || plans.has(d.n)).map((d) => (
                <option key={d.n} value={d.n}>
                  Draft {d.n}{d.n === latest ? " (latest)" : ""}{d.at ? ` · ${timeLabel(d.at)}` : ""}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn btn-sm" aria-pressed={annotate} disabled={readOnly} onClick={() => setAnnotate((value) => !value)} title="When on, clicking the plan adds a note. When off, you can click freely.">
              {annotate ? "Annotating" : "Annotate off"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setTheme((value) => (value === "dark" ? "light" : "dark"))}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button type="button" className="btn btn-sm" aria-pressed={panelOpen} onClick={() => setPanelOpen((value) => !value)}>
              Review{pendingCount > 0 ? ` (${pendingCount})` : ""}
            </button>
            {!STATIC && !server.ended && (
              <button type="button" className="btn btn-sm btn-danger" disabled={sending || lost} onClick={() => send(true)}>
                End session
              </button>
            )}
          </div>
        </header>

        {/* Banners */}
        {lost && <div className="px-4 py-2 bg-danger-subtle border-b border-line text-[13px]">Lost contact with the local review server. Your unsent notes are kept in this tab. Ask your agent to run <code className="inline-code">blueprint open</code> again, then reload.</div>}
        {server.ended && <div className="px-4 py-2 bg-done-subtle border-b border-line text-[13px]">This review has ended. The page is read-only and you can close this tab.</div>}
        {server.planError && (
          <div className="px-4 py-2 bg-attention-subtle border-b border-line text-[13px]">
            <span className="font-semibold">The agent's newest edit has errors, so you are still seeing draft {latest}.</span> The agent has been told:
            <ul className="list-disc pl-5 font-mono text-[12px]">
              {server.planError.errors.slice(0, 5).map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          </div>
        )}
        {shown !== latest && (
          <div className="px-4 py-2 bg-attention-subtle border-b border-line text-[13px] flex items-center gap-3">
            <span>You are viewing draft {shown}, an older version. Notes can only be added to the latest draft.</span>
            <button type="button" className="btn btn-sm" onClick={() => setViewDraft(null)}>
              Back to draft {latest}
            </button>
          </div>
        )}
        {STATIC && <div className="px-4 py-2 bg-accent-subtle border-b border-line text-[13px]">Standalone copy. Add notes, then use <span className="font-semibold">Copy feedback</span> and paste them into your chat with the agent. This file makes no network requests.</div>}

        <div className="flex-1 min-h-0 flex">
          {/* Contents */}
          {plan && !slides && (
            <nav className="hidden xl:block w-56 shrink-0 border-r border-line overflow-y-auto scroll-thin p-3" aria-label="Sections">
              <div className="text-[12px] font-semibold text-muted px-2 mb-1">Contents</div>
              {plan.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="block w-full text-left px-2 py-1 rounded-md hover:bg-subtle cursor-pointer text-[13px] truncate bg-transparent border-0"
                  onClick={() => document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {section.title}
                  {section.blocks.some((b) => changeKind.has(b.id)) && <span className="inline-block w-2 h-2 rounded-full bg-attention ml-2 align-middle" title="Changed in this draft" />}
                </button>
              ))}
            </nav>
          )}

          {/* Plan */}
          <main className="flex-1 min-w-0 overflow-y-auto" ref={planRef} onClick={onPlanClick} onMouseUp={onPlanMouseUp} onMouseOver={onPlanMouseOver} onMouseLeave={onPlanMouseOver}>
            {plan ? (
              <div className="bp-plan max-w-[980px] mx-auto px-6 py-6 flex flex-col gap-8">
                {(!slides || slide === 0) && (
                  <div className="border-b border-line pb-4" data-block="plan-header" data-section="" data-title="Title and summary">
                    <h1 className="text-[28px] font-semibold leading-tight" data-anno="title" data-anno-label="Plan title">{plan.title}</h1>
                    {plan.summary && <div className="mt-2 text-muted"><Markdown text={plan.summary} partPrefix="summary" /></div>}
                    {changes?.removed.length > 0 && (
                      <div className="mt-3 text-[13px] text-muted">
                        <span className="label label-danger mr-2">Removed in draft {shown}</span>
                        {changes.removed.map((entry) => `${entry.sectionTitle} › ${entry.title}`).join("; ")}
                      </div>
                    )}
                  </div>
                )}
                {sections.map((section) => (
                  <section key={section.id} id={`section-${section.id}`} className="flex flex-col gap-4 scroll-mt-4">
                    <h2 className="text-[20px] font-semibold border-b border-line-muted pb-2" data-block={section.id} data-section={section.id} data-title={`Section: ${section.title}`}>
                      <span data-anno="section-title" data-anno-label={`Section: ${section.title}`}>{section.title}</span>
                    </h2>
                    {section.blocks.map((block) => (
                      <article key={block.id} data-block={block.id} data-section={section.id} data-title={block.title || TYPE_LABEL[block.type]} className={`rounded-md ${changeKind.has(block.id) ? "pl-3 border-l-4 border-attention" : ""}`}>
                        {(block.title || changeKind.has(block.id)) && (
                          <div className="flex items-center gap-2 mb-2">
                            {block.title && <h3 className="font-semibold text-[16px]">{block.title}</h3>}
                            {changeKind.has(block.id) && <span className={`label ${changeKind.get(block.id) === "New" ? "label-success" : "label-attention"}`}>{changeKind.get(block.id)} in draft {shown}</span>}
                          </div>
                        )}
                        <BlockBody block={block} sectionId={section.id} />
                      </article>
                    ))}
                  </section>
                ))}
                {slides && (
                  <div className="flex items-center justify-center gap-3 pb-6" data-bp-interactive>
                    <button type="button" className="btn" disabled={slide === 0} onClick={() => setSlide((value) => Math.max(0, value - 1))}>Previous</button>
                    <span className="text-muted">{Math.min(slide, plan.sections.length - 1) + 1} / {plan.sections.length}</span>
                    <button type="button" className="btn" disabled={slide >= plan.sections.length - 1} onClick={() => setSlide((value) => Math.min(plan.sections.length - 1, value + 1))}>Next</button>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 text-muted">No valid draft yet. The agent is fixing the plan file.</div>
            )}
          </main>

          {/* Review panel */}
          {panelOpen && (
            <aside className="w-[400px] max-w-[92vw] shrink-0 border-l border-line flex flex-col bg-canvas" data-bp-interactive>
              <div className="flex border-b border-line px-2 pt-2 gap-1" role="tablist">
                {[
                  ["conversation", "Conversation"],
                  ["changelog", `Change log (${server.drafts.length})`],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={`px-3 py-2 text-[13px] cursor-pointer bg-transparent border-0 border-b-2 ${tab === id ? "border-[#fd8c73] font-semibold" : "border-transparent text-muted"}`}
                    onClick={() => setTab(id)}
                  >
                    {name}
                  </button>
                ))}
              </div>

              {tab === "changelog" ? (
                <div className="flex-1 overflow-y-auto scroll-thin p-3">
                  <ChangeLog drafts={server.drafts} plans={plans} latestPlan={latestPlan} viewing={shown} onView={(n) => setViewDraft(n === latest ? null : n)} onJump={jumpTo} />
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto scroll-thin p-3 flex flex-col gap-3" ref={logRef}>
                    {timeline.length === 0 && queue.length === 0 && (
                      <div className="text-muted text-[13px]">
                        <p className="font-semibold text-fg mb-1">How to review</p>
                        <ol className="list-decimal pl-5 flex flex-col gap-1">
                          <li>Click any part of the plan, or select some text, and write a note.</li>
                          <li>Notes collect here as a batch. Add as many as you like.</li>
                          <li>Press <span className="font-semibold">{STATIC ? "Copy feedback" : "Send to agent"}</span>. The agent revises the plan and a new draft appears.</li>
                          <li>Repeat until it is right, then end the session.</li>
                        </ol>
                      </div>
                    )}
                    {timeline.map((entry) =>
                      entry.kind === "batch" ? (
                        <div key={entry.batch.id} className="bubble p-3 flex flex-col gap-3 ml-6">
                          <div className="flex items-center justify-between text-[12px] text-muted">
                            <span className="font-semibold text-fg">You · {entry.batch.items.length} note{entry.batch.items.length === 1 ? "" : "s"} on draft {entry.batch.draft}</span>
                            <span>{timeLabel(entry.batch.at)}</span>
                          </div>
                          {entry.batch.items.map((item, i) => (
                            <div key={i} className={i > 0 ? "border-t border-line-muted pt-2" : ""}>
                              <ItemView item={item} />
                            </div>
                          ))}
                          <Receipt batch={entry.batch} agentListening={server.agentListening} />
                        </div>
                      ) : entry.kind === "agent" ? (
                        <div key={entry.entry.id} className="bubble p-3 mr-6 bg-subtle">
                          <div className="flex items-center justify-between text-[12px] text-muted mb-1">
                            <span className="font-semibold text-fg">Agent{entry.entry.draft ? ` · draft ${entry.entry.draft}` : ""}</span>
                            <span>{timeLabel(entry.entry.at)}</span>
                          </div>
                          <div className="text-[13px]"><Markdown text={entry.entry.text} /></div>
                        </div>
                      ) : (
                        <div key={entry.entry.id} className="text-center text-muted text-[12px]">{entry.entry.text}</div>
                      ),
                    )}
                    {queue.map((item) => (
                      <div key={item.key} className="bubble bubble-queued p-3 ml-6 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span className="label label-attention">Queued</span>
                          <button type="button" className="btn btn-sm btn-invisible ml-auto" onClick={() => flash(findTargetElement(item.target))}>Show</button>
                          {item.target.kind !== "decision" && (
                            <button type="button" className="btn btn-sm btn-invisible" onClick={() => setCard({ x: window.innerWidth - 820, y: 120, target: item.target, key: item.key, comment: item.comment, attachments: item.attachments })}>Edit</button>
                          )}
                          <button type="button" className="btn btn-sm btn-invisible" onClick={() => setQueue((current) => current.filter((q) => q.key !== item.key))}>Remove</button>
                        </div>
                        <ItemView item={item} />
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-line p-3 flex flex-col gap-2 bg-subtle">
                    {!STATIC && !server.ended && (
                      <div className="text-[12px] text-muted flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${server.agentListening ? "bg-success" : "bg-attention"}`} />
                        {server.agentListening ? "Agent is listening for your feedback" : "Agent is busy or not listening - notes are delivered when it next checks in"}
                      </div>
                    )}
                    <textarea
                      className="field"
                      rows={3}
                      placeholder="General message for the agent (optional)"
                      value={message}
                      disabled={Boolean(server.ended) || lost}
                      onChange={(event) => setMessage(event.target.value)}
                      onPaste={(event) => {
                        const images = pastedImages(event);
                        if (images.length && !STATIC) composerAttachments.add(images, limit);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !STATIC) send(false);
                      }}
                    />
                    <AttachmentRow attachments={composerAttachments} limit={limit} disabled={Boolean(server.ended) || lost} />
                    {notice && <div className="text-[12px] text-attention" role="status">{notice}</div>}
                    {copyFallback && <textarea className="field font-mono text-[12px]" rows={6} readOnly value={copyFallback} onFocus={(event) => event.target.select()} />}
                    <div className="flex items-center gap-2 justify-end">
                      {STATIC ? (
                        <button type="button" className="btn btn-primary" disabled={pendingCount === 0} onClick={copyFeedback}>
                          Copy feedback{pendingCount > 0 ? ` (${pendingCount})` : ""}
                        </button>
                      ) : (
                        <>
                          <button type="button" className="btn btn-danger" disabled={sending || Boolean(server.ended) || lost} onClick={() => send(true)}>
                            Send &amp; end
                          </button>
                          <button type="button" className="btn btn-primary" disabled={sending || Boolean(server.ended) || lost} onClick={() => send(false)}>
                            {sending ? "Sending…" : `Send to agent${pendingCount > 0 ? ` (${pendingCount})` : ""}`}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </aside>
          )}
        </div>

        {card && <AnnotationCard key={`${card.key || ""}:${card.target.blockId}:${card.target.part}:${card.x}`} card={card} limit={limit} onQueue={(item) => queueItem(item, item.key)} onClose={() => setCard(null)} />}
        {link && <LinkPreview link={link} onClose={() => setLink(null)} />}
      </div>
    </ReviewContext.Provider>
  );
}
