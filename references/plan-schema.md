# Plan file format

A plan is one JSON file, at most 2 MB, named `<something>.plan.json`. Check it with `blueprint validate <file>`.

```json
{
  "blueprint": 1,
  "title": "Move checkout to a queued payment flow",
  "summary": "One or two sentences. Markdown allowed.",
  "layout": "page",
  "changelog": [
    { "draft": 1, "summary": "First draft." },
    { "draft": 2, "summary": "Applied the first review batch.", "changes": ["Named the queue", "Added rollback step"] }
  ],
  "sections": [
    { "id": "goal", "title": "Goal and current state", "blocks": [ { "id": "goal-text", "type": "markdown", "text": "…" } ] }
  ]
}
```

- `blueprint` must be `1`. `layout` is `"page"` (default) or `"slides"`.
- Every section, block, option and item needs an `id`: lowercase letters, digits and hyphens, unique across the whole file. **Keep ids stable between drafts**; the review page uses them to mark what is new or changed.
- Any block may have a `title`.
- The draft number is counted by the tool each time the file changes. Do not store it anywhere except in `changelog[].draft`, using the number the `poll` output gives you.

## Text formatting

Fields marked *markdown* accept: paragraphs, `#` headings, `-` and `1.` lists, `- [ ]` task items, `> quotes`, fenced code, `---`, and inline `code`, `**bold**`, `*italic*`, `~~strike~~`, `[text](url)` and bare `https://` links. Raw HTML in markdown is shown as text. Links are never clickable: the reader gets a preview and a copy button.

Fields marked *inline* accept only the inline subset.

## Block types

### markdown

```json
{ "id": "background", "type": "markdown", "text": "Today `POST /checkout` waits for the provider.\n\n- p95 is **4.2s**" }
```

### callout

`tone`: `note`, `tip`, `important`, `warning`, `caution`. `text` is markdown.

```json
{ "id": "refund-warning", "type": "callout", "tone": "warning", "text": "Refunds share this code path." }
```

### table

Every row must have as many cells as there are columns. Cells are inline text.

```json
{ "id": "endpoints", "type": "table", "title": "Endpoints touched",
  "columns": ["Endpoint", "Change", "Risk"],
  "rows": [["`POST /checkout`", "Returns 202", "medium"]] }
```

### comparison

Two to twelve options. `summary`, `pros[]`, `cons[]`, `cost` are inline text; `recommended` is true or false.

```json
{ "id": "queue-options", "type": "comparison", "options": [
  { "id": "opt-managed", "title": "Managed queue", "summary": "Use the queue we already run.",
    "pros": ["No new infrastructure"], "cons": ["At-least-once delivery"], "cost": "About 2 days", "recommended": true },
  { "id": "opt-table", "title": "Database table", "pros": ["Transactional"], "cons": ["Polling load"], "cost": "About 4 days" } ] }
```

### decision

Asks the user to choose. `kind`: `single`, `multi` or `text` (`text` has no options). `context` is markdown.

```json
{ "id": "pick-queue", "type": "decision", "kind": "single", "question": "Which queue should we use?",
  "context": "This fixes the retry behaviour for everything below.",
  "options": [ { "id": "pick-managed", "label": "Managed queue", "detail": "Fastest to ship", "recommended": true },
               { "id": "pick-table", "label": "Database table" } ] }
```

The answer arrives in the feedback batch as `answer.choices` (option ids), `answer.choiceLabels`, and an optional `comment`.

### diagram

Mermaid source. Rendered in strict mode: no `click`, no HTML labels, no `%%{init}%%` overrides. Supported well: `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `gantt`, `timeline`, `mindmap`, `pie`, `quadrantChart`.

```json
{ "id": "request-flow", "type": "diagram", "title": "New request flow",
  "mermaid": "flowchart LR\n  A[Browser] --> B[API]\n  B --> C[(Queue)]\n  C --> D[Worker]",
  "caption": "The API returns as soon as the job is queued." }
```

### code

```json
{ "id": "worker-code", "type": "code", "filename": "worker.ts", "language": "typescript", "code": "export async function handle(job) {\n  …\n}" }
```

### diff

Give the old and new text; the page computes the line diff.

```json
{ "id": "checkout-diff", "type": "diff", "filename": "src/checkout.ts", "language": "typescript",
  "before": "const result = await provider.charge(order);\n", "after": "await queue.enqueue({ orderId: order.id });\n" }
```

### steps

`status` (optional): `todo`, `doing`, `done`, `blocked`. `detail` is markdown.

```json
{ "id": "rollout", "type": "steps", "items": [
  { "id": "step-keys", "title": "Add idempotency keys", "detail": "Required before any retry.", "status": "todo" } ] }
```

### risks

`likelihood` and `impact`: `low`, `medium`, `high`.

```json
{ "id": "risk-list", "type": "risks", "items": [
  { "id": "risk-double", "risk": "Double charge on retry", "likelihood": "medium", "impact": "high", "mitigation": "Idempotency keys (step 1)." } ] }
```

### questions

Open questions the user can click and answer in a note.

```json
{ "id": "open", "type": "questions", "items": [ { "id": "q-refunds", "question": "Do refunds move to the queue too?", "context": "They share the charge code." } ] }
```

### html

For custom illustrations and static UI mock-ups. The content is sanitised and cannot run code.

- Allowed: ordinary HTML layout and text elements, tables, inline SVG (shapes, paths, text, gradients, markers, filters), inline `style` attributes, and `<img>` with a `data:image/png|jpeg|gif|webp;base64,…` source.
- Removed: `<script>`, `<style>`, event handlers, iframes, forms and form controls, audio/video, `<use>`, `<foreignObject>`, SVG animation, remote images, any `url(...)` inside a `style` attribute, and `position: fixed/sticky`.
- Links (`<a href>`) become preview-and-copy chips.
- Colours: use these CSS variables so the block follows light and dark themes: `var(--fg)`, `var(--muted)`, `var(--canvas)`, `var(--subtle)`, `var(--border)`, `var(--accent)`, `var(--success)`, `var(--attention)`, `var(--danger)`. In SVG, prefer `currentColor`.
- Size SVG with `viewBox` and a width; keep everything inside the viewBox. Give SVG ids names unique to the block.

```json
{ "id": "pending-mock", "type": "html", "title": "Pending state",
  "html": "<div style=\"border:1px solid var(--border);border-radius:8px;padding:16px;max-width:320px\"><b>Payment pending</b><p style=\"color:var(--muted)\">We will email you when it completes.</p></div>",
  "caption": "Shown after the order is accepted." }
```

## Feedback batches

`poll` returns:

```json
{ "status": "feedback", "current_draft": 1, "session_ended": false,
  "handling": "…how to treat these notes…",
  "batches": [ { "batch": "…", "viewing_draft": 1, "items": [
    { "n": 1, "comment": "Should this be 201?",
      "target": { "kind": "cell", "sectionId": "approach", "blockId": "endpoints", "part": "r1c2", "label": "Row 1 (…) / Change", "quote": "Returns 202" } },
    { "n": 2, "comment": "", "answer": { "choices": ["pick-managed"], "choiceLabels": ["Managed queue"] },
      "target": { "kind": "decision", "blockId": "pick-queue" } },
    { "n": 3, "comment": "See screenshot", "attachments": ["/abs/path/.blueprint/…/attachments/….png"], "target": { "kind": "general" } } ] } ],
  "next_step": "…includes the draft number to use in your changelog entry…" }
```

`target.kind` is one of `general`, `block`, `text` (a text selection; see `quote`), `cell`, `item`, `diagram`, `decision`. `blockId` and `part` say where; `quote` is what the user was pointing at. Attachment paths are local image files you may read; they are deleted when the review ends.
