# Playbooks: what makes a plan worth reviewing

A plan usually combines several of these. Check each "use when" line and apply every playbook that matches before writing the plan file.

## Always

- Write for a reader who was not in the conversation. Define terms at first use. Say what exists today before saying what changes.
- Lead with the answer or the decision, then the reasoning, then the evidence.
- Verify every factual claim against the code, data or documents you can see. Cite the file path, command or source beside the claim. Mark anything you inferred as an assumption or put it in an open question.
- Make each claim, step and option its own block or list item so the reader can comment on exactly that piece.
- Use the right block for the content instead of long prose: `comparison` for options, `table` for records with the same fields, `steps` for sequence, `risks` for what could go wrong, `decision` when you need the user to choose, `diagram` for flows and structure.
- Keep it as short as it can be while still letting another developer carry it out without asking you anything.

## Plan (use when: proposing a feature, change, migration or project before doing it)

Structure, in this order:

1. **Goal**: the outcome wanted and how success will be recognised.
2. **Current state**: what exists today and why it falls short, with evidence.
3. **Proposed approach**: the main decisions first, then how the pieces fit. Show user-facing changes as a mock-up (`html` block) rather than describing them.
4. **Rollout** (`steps`): ordered, each step small enough to verify. Include migration, backwards compatibility and how to undo it.
5. **Risks** (`risks`): likelihood, impact and a concrete mitigation for each. Include failure modes, not only schedule risk.
6. **Open questions and decisions** (`questions`, `decision`): only things that are really undecided. Offer options with a recommendation where you have one.

Avoid:

- Listing only the uncertain parts and leaving out the actual proposal.
- Leaving a question in the plan after it has been answered. Rewrite the affected sections and remove it.
- Vague steps such as "update the backend". Name the files, endpoints, tables or commands.
- Skipping what happens when it fails or has to be rolled back.

## Comparison (use when: there are options, trade-offs, or a before and after)

- Name the decision being made at the top.
- Describe each option by what concretely happens under it, not by adjectives.
- Keep the same aspects in the same order across options so differences line up.
- Show the cost of every option as clearly as its benefit. Fill in `cost`.
- Mark one option `recommended` only when the evidence supports it, and say what assumption would change the recommendation.
- If the user must choose, follow the comparison with a `decision` block.

## Diagram (use when: explaining a flow, sequence, architecture, state or data model)

- One idea per diagram. Several small diagrams beat one dense one.
- State the question the diagram answers in its title or caption.
- First diagram: the core relationship only. Put detail in a table or text underneath.
- Keep node labels to a few words; explain in the caption or surrounding text.
- Use Mermaid `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram` or `classDiagram`. Do not use `click` directives, HTML in labels, or `%%{init}%%` configuration; they are disabled.
- If a relationship is uncertain, label the edge as a question so the user can settle it.
- For a custom illustration or a UI mock-up, use an `html` block with inline SVG (see the schema reference).

## Table (use when: several items share the same fields)

- Put a one-sentence takeaway above the table in a `markdown` block.
- Order columns as: what it is, the evidence, the status, the action.
- First column should identify the row; it is used to label feedback on any cell.
- Do not rely on colour alone to show status; write the word.

## Code (use when: showing source, a patch, or before and after)

- Use `code` for one snippet and `diff` for a change. Always set `filename` and `language`.
- Say just above the block why the reader should look at it.
- Show the focused lines that matter, not whole files.
- Keep each claim next to the lines that support it.

## Decision input (use when: you need the user to choose or answer)

- One `decision` block per question. Phrase it so the answer is unambiguous.
- `single` for one choice, `multi` for several, `text` for a free answer.
- Explain what each option leads to in `detail`. Mark your recommendation.
- Do not ask for decisions you could make yourself from the evidence.

## Explanation (use when: the goal is understanding something that already exists)

- Open with the one-sentence answer to the question the reader actually has.
- Show only the slice that matters, not the whole system.
- Keep evidence subordinate: cite paths and commands rather than pasting logs.
- Separate what you verified from what you inferred.
- End with what you deliberately left out and where to look next.

## Slides (use when: the user asks for a deck or a paced walkthrough)

- Set `"layout": "slides"`; each section becomes one slide.
- One idea per slide, sparse text, a diagram or comparison doing the work.
- Open with the point, build the case, close with the decision or next step.
- Do not use slides for reference material or detailed review.

## Handling a feedback batch

- Make a list of every item in the batch and account for each one: done, done differently (say how), or declined (say why).
- Change the plan itself; do not append a "responses to feedback" section.
- Keep block ids stable so the page can mark exactly what changed.
- Write the `changelog` entry for the reader: what changed and why, in their terms.
- If two notes conflict, do not guess. Add a `decision` block that puts the conflict to the user.
- Re-check that the plan still reads correctly from top to bottom after the edits.
