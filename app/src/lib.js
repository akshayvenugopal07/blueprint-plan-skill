import DOMPurify from "dompurify";

// ---------------------------------------------------------------------------
// Mode: "live" (served by the local review server) or "static" (exported file)
// ---------------------------------------------------------------------------
const staticNode = document.getElementById("blueprint-static");
export const STATIC = staticNode ? JSON.parse(staticNode.textContent) : null;

const WRITE_HEADERS = { "X-Blueprint-Request": "1" };

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { ...WRITE_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
}

export const api = {
  state: () => getJson("/api/state"),
  draft: (n) => getJson(`/api/draft/${n}`),
  feedback: (payload) => postJson("/api/feedback", payload),
  end: () => postJson("/api/end", {}),
  async upload(file) {
    const res = await fetch("/api/attachment", {
      method: "POST",
      credentials: "same-origin",
      headers: { ...WRITE_HEADERS, "Content-Type": "application/octet-stream" },
      body: file,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Upload failed (${res.status})`);
    return json;
  },
};

// ---------------------------------------------------------------------------
// Storage: per-tab, best effort
// ---------------------------------------------------------------------------
export const store = {
  get(key, fallback) {
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage may be unavailable (static file previews); state stays in memory.
    }
  },
};

// ---------------------------------------------------------------------------
// Sanitising. Agent-supplied HTML/SVG is treated as hostile input.
//   Layer 1: DOMPurify with a strict allowlist (no scripts, forms, frames,
//            media, external references, event handlers).
//   Layer 2: links are converted into inert chips; nothing is navigable.
//   Layer 3: the page's Content-Security-Policy forbids inline script and any
//            network destination other than this server, so even a sanitiser
//            bypass could neither run code nor send data anywhere.
// ---------------------------------------------------------------------------
const purifier = DOMPurify(window);

const FORBID_TAGS = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "link", "meta", "base",
  "form", "input", "button", "textarea", "select", "option", "dialog", "audio", "video", "source", "track",
  "picture", "canvas", "noscript", "template", "slot", "portal", "foreignObject", "animate", "animateMotion",
  "animateTransform", "set", "use", "image", "feImage"
];
const FORBID_ATTR = [
  "srcset", "ping", "action", "formaction", "background", "poster", "srcdoc", "contenteditable", "autofocus",
  "tabindex", "accesskey", "is", "slot", "part", "popover", "popovertarget", "name", "target",
];

purifier.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  // Links become inert chips. The original URL is kept as data for the preview.
  for (const attr of ["href", "xlink:href"]) {
    if (!node.hasAttribute(attr)) continue;
    const value = node.getAttribute(attr) || "";
    node.removeAttribute(attr);
    if (node.tagName.toLowerCase() === "a" && value && !value.startsWith("#")) {
      node.setAttribute("data-bp-link", value.slice(0, 2000));
      node.classList.add("bp-link");
      node.setAttribute("role", "button");
    }
  }
  // Images may only be inline data images of plain raster types.
  if (node.tagName.toLowerCase() === "img") {
    const src = node.getAttribute("src") || "";
    if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) node.remove();
  }
  // Inline styles: no escaping the block, no external fetches, no legacy script hooks.
  if (node.hasAttribute("style")) {
    const style = node.getAttribute("style") || "";
    if (/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|position\s*:\s*(fixed|sticky)/i.test(style)) {
      node.removeAttribute("style");
    }
  }
  // SANITIZE_NAMED_PROPS renames every id to "user-content-<id>". Keep in-document SVG
  // references (gradients, arrow markers, clip paths) pointing at the renamed ids.
  for (const attr of Array.from(node.attributes)) {
    if (attr.name !== "style" && /url\(\s*#/.test(attr.value)) {
      node.setAttribute(attr.name, attr.value.replace(/url\(\s*#(?!user-content-)/g, "url(#user-content-"));
    }
  }
});

export function sanitizeHtml(html) {
  return purifier.sanitize(String(html), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    RETURN_TRUSTED_TYPE: false,
  });
}

// Mermaid's own output: SVG with an embedded <style>. Sanitised again here so a
// malicious diagram label cannot smuggle markup through the renderer.
const svgPurifier = DOMPurify(window);
svgPurifier.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element)) return;
  for (const attr of ["href", "xlink:href"]) {
    const value = node.getAttribute(attr);
    if (value !== null && !value.startsWith("#")) node.removeAttribute(attr);
  }
});
svgPurifier.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName === "style" && /url\s*\(|@import|expression\s*\(/i.test(node.textContent || "")) {
    node.textContent = (node.textContent || "").replace(/@import[^;]*;?/gi, "").replace(/url\s*\([^)]*\)/gi, "none");
  }
});

export function sanitizeDiagramSvg(svg) {
  return svgPurifier.sanitize(String(svg), {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "foreignObject", "iframe", "image", "use", "a", "animate", "set", "animateTransform", "animateMotion"],
    FORBID_ATTR: ["tabindex"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** highlight.js emits only <span class="hljs-..."> around escaped text; enforce exactly that. */
const codePurifier = DOMPurify(window);
export function sanitizeHighlighted(html) {
  return codePurifier.sanitize(String(html), { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] });
}

// ---------------------------------------------------------------------------
// Link inspection
// ---------------------------------------------------------------------------
export function inspectLink(raw, shownText = "") {
  const url = String(raw).trim();
  const warnings = [];
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    warnings.push("This is not a complete web address. It may be a relative path or a malformed link.");
  }
  if (parsed) {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "mailto:") {
      warnings.push(`Unusual link type "${parsed.protocol}" - this is not a normal web page link.`);
    }
    if (parsed.protocol === "http:") warnings.push("Not encrypted (http, not https).");
    if (parsed.username || parsed.password) warnings.push("Contains a username or password before the site name - a common trick to disguise the real site.");
    if (/(^|\.)xn--/i.test(parsed.hostname)) warnings.push("The site name uses special characters that can imitate other letters.");
    if (/^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes(":")) warnings.push("Points at a raw IP address rather than a named site.");
    const shown = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(shownText || "");
    if (shown && parsed.hostname && !parsed.hostname.toLowerCase().endsWith(shown[0].toLowerCase()) && shown[0].toLowerCase() !== parsed.hostname.toLowerCase()) {
      warnings.push(`The link text mentions "${shown[0]}" but the link really goes to "${parsed.hostname}".`);
    }
  }
  return { url, parsed, warnings };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.readOnly = true;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Draft comparison
// ---------------------------------------------------------------------------
export function flattenBlocks(plan) {
  const map = new Map();
  if (!plan) return map;
  for (const section of plan.sections || []) {
    for (const block of section.blocks || []) {
      map.set(block.id, {
        sectionId: section.id,
        sectionTitle: section.title,
        title: block.title || block.question || block.type,
        type: block.type,
        json: JSON.stringify(block),
      });
    }
  }
  return map;
}

export function compareDrafts(previous, current) {
  const before = flattenBlocks(previous);
  const after = flattenBlocks(current);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [id, info] of after) {
    if (!before.has(id)) added.push({ id, ...info });
    else if (before.get(id).json !== info.json) changed.push({ id, ...info });
  }
  for (const [id, info] of before) if (!after.has(id)) removed.push({ id, ...info });
  return { added, changed, removed };
}

// ---------------------------------------------------------------------------
// Line diff (longest common subsequence)
// ---------------------------------------------------------------------------
export function lineDiff(beforeText, afterText) {
  const a = String(beforeText).replace(/\n$/, "").split("\n");
  const b = String(afterText).replace(/\n$/, "").split("\n");
  if (beforeText === "") a.length = 0;
  if (afterText === "") b.length = 0;
  const rows = [];
  if (a.length * b.length > 4_000_000) {
    a.forEach((text, i) => rows.push({ kind: "del", text, left: i + 1 }));
    b.forEach((text, i) => rows.push({ kind: "add", text, right: i + 1 }));
    return rows;
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i], left: i + 1, right: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      rows.push({ kind: "del", text: a[i], left: i + 1 });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j], right: j + 1 });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ kind: "del", text: a[i], left: i + 1 });
  for (; j < b.length; j += 1) rows.push({ kind: "add", text: b[j], right: j + 1 });
  return rows;
}

// ---------------------------------------------------------------------------
// Feedback as plain text (used by the exported, server-less file)
// ---------------------------------------------------------------------------
export function describeTarget(target) {
  if (!target || target.kind === "general") return "General";
  const where = [target.blockId, target.part].filter(Boolean).join(" / ");
  return `${target.label || target.kind}${where ? ` [${where}]` : ""}`;
}

export function feedbackAsText(title, draft, items) {
  const lines = [`Blueprint feedback on "${title}" (draft ${draft})`, ""];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${describeTarget(item.target)}`);
    if (item.target?.quote) lines.push(`   Quote: "${item.target.quote.replace(/\s+/g, " ").slice(0, 300)}"`);
    if (item.answer?.choiceLabels?.length) lines.push(`   Answer: ${item.answer.choiceLabels.join(", ")}`);
    if (item.answer?.text) lines.push(`   Answer: ${item.answer.text}`);
    if (item.comment) lines.push(`   Note: ${item.comment}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function timeLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
