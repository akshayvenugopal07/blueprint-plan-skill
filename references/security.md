# Security design

This document is for the owner of the skill or anyone reviewing it. It states what the skill does to stay safe, how to check each claim, and what it cannot protect against.

## What runs

| Part | Files | Dependencies at run time |
| --- | --- | --- |
| CLI | `bin/blueprint.mjs` | Node built-ins only |
| Review server | `server/*.mjs` | Node built-ins only |
| Review page | `dist/index.html`, `dist/app.js`, `dist/app.css` | None; everything is bundled in these three files |

`node_modules/` is not needed to use the skill and is not shipped. The packages in `package.json` are build inputs only.

## No outbound communication

- There is no telemetry, update check, share feature, analytics or remote logging anywhere in the code.
- The server contains no client networking code at all, and the CLI contains no networking code of any kind. The agent's commands (`poll`, `reply`, `end`, `status`) exchange small JSON files with the server inside the plan's `review/` folder, so they work with networking switched off entirely.
- The review page is served with a Content-Security-Policy of `default-src 'none'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'self'; …`. The browser itself refuses any request to another origin, whatever the page content tries.
- Exported files carry an equivalent policy in a `<meta>` tag, with the script allowed only by its SHA-256 hash and no network destinations at all.
- The only process the skill starts, besides its own server, is the operating system's "open this URL in the default browser" helper, called without a shell.
- The single exception is `npm run update:deps`, which contacts the npm registry. It runs only when the owner types it.

Check: `npm test` includes a test that scans the runtime files for network, shell and eval primitives, and the browser tests record zero external requests.

## The local server

- Binds to `127.0.0.1` on a random free port. Address and port are hard-coded; no flag or environment variable changes them. No environment variable weakens any check.
- Every request must come from a loopback socket and carry a `Host` header of exactly `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- Requests marked cross-site by the browser (`Sec-Fetch-Site`) are refused, including reads.
- Browser access needs a session cookie (`HttpOnly`, `SameSite=Strict`) that is only issued in exchange for a random launch code. A launch code works once and expires after five minutes.
- State-changing browser requests additionally need a matching `Origin`, a custom header that cross-site forms cannot send, and a JSON content type.
- The agent side has no network endpoint at all. Its messages are files in `review/requests/` (owner-only folder permissions), processed only by the server that currently owns the plan. Request names are validated, sizes are capped, and only three request types exist: reply, end and shutdown.
- Launch codes are written by `open` as files named by their SHA-256; the server accepts each once, within five minutes.
- Only one server serves a plan. `open` takes a lock, retires an ended server before starting a new one, and any server that sees a newer one in its heartbeat file steps aside.
- The server can return only: the three bundled files (held in memory under fixed names), recorded drafts of the one plan it was started for, and images uploaded during this review, addressed by their SHA-256. There is no route that takes a file path.
- Request bodies are capped (512 KB JSON, 5 MB per image). Only `GET` and `POST` are accepted.
- It stops 30 minutes after the last browser or agent contact, and after a review ends.

## Plan content cannot execute

Lavish ran agent-written HTML and JavaScript in a sandboxed frame. Blueprint does not run agent-written code at all.

1. The plan is JSON, validated against a fixed schema with size limits before it is accepted as a draft.
2. Text is rendered by React, which escapes it. The Markdown renderer has no HTML pass-through.
3. `html` blocks and Mermaid's SVG output go through DOMPurify with scripts, styles, frames, forms, media, `<use>`, `<foreignObject>`, animation and all external references forbidden. Inline styles containing `url(`, `@import` or fixed positioning are dropped.
4. Mermaid runs with `securityLevel: "strict"`, HTML labels off, and its security-relevant settings locked against override from diagram text.
5. `html` and diagram blocks are CSS-contained so they cannot draw over the review controls.
6. If all of the above failed, the Content-Security-Policy still forbids inline script, `eval`, and every network destination.

Links are never rendered as `<a href>`. They are chips that show the real destination, warn about common disguises, and offer a copy button.

## Feedback cannot be forged or auto-sent

- Nothing in a plan can queue or send feedback. Only the user clicking **Send** posts a batch.
- The server keeps only known fields of each note, with length limits, and discards the rest.
- The agent receives feedback with a fixed handling note, and `SKILL.md` instructs it to confirm with the user before doing anything beyond editing the plan.

## Integrity

`CHECKSUMS.sha256` lists the SHA-256 of every file that is executed or served. `open` and `export` refuse to run if any of them differs, and `blueprint verify` reports which. After an intentional change, `npm run checksums` records the new values. Keep the folder in git so every change is visible in history.

## Dependencies

All are pinned to exact versions, and `package-lock.json` pins every transitive package with an integrity hash. `THIRD-PARTY.txt` lists them.

| Package | Purpose | In the shipped bundle |
| --- | --- | --- |
| react, react-dom | UI | yes |
| mermaid (and its dependencies) | Diagrams | yes |
| dompurify | HTML/SVG sanitising | yes |
| highlight.js | Code colouring | yes |
| tailwindcss, @tailwindcss/cli | Stylesheet generation | output only (`app.css`) |
| esbuild | Bundling | no |

Packages are installed with `--ignore-scripts`, so no package install script runs.

## What this cannot protect against

- **Someone with write access to this folder or your user account.** They can change the code and regenerate the checksums. The checksum file detects accidents and unsophisticated tampering, not a determined local attacker. Git history and file permissions are the control here.
- **Other software running as you.** A program under your account can write files into a plan's `review/` folder, and so could post a reply or read delivered feedback while a review is open.
- **The agent itself.** The skill tells the agent to treat sources and feedback as data and to ask before executing anything, but it cannot enforce what an agent does. Keep your agent's own permission prompts on.
- **Bugs in bundled packages.** A flaw in Mermaid or DOMPurify is contained by the Content-Security-Policy and the absence of any network path, but not ruled out. Update with `npm run update:deps -- <package>` when an advisory appears.
- **Links you choose to open.** Copying a link out and visiting it is outside the skill's control.
- **Plain HTTP on loopback.** Traffic between your browser and the server is unencrypted but never leaves the machine.
