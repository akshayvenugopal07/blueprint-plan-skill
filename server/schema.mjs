// Plan schema validation. Shared by the CLI and the server.
// Node built-ins only. A plan is DATA: nothing in it is ever executed.

export const SCHEMA_VERSION = 1;
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LIMITS = {
  title: 200,
  short: 500,
  text: 100_000,
  html: 200_000,
  sections: 100,
  blocksPerSection: 200,
  items: 200,
  columns: 30,
  rows: 1000,
  changelog: 500,
};

const TONES = ["note", "tip", "important", "warning", "caution"];
const LEVELS = ["low", "medium", "high"];
const STEP_STATUS = ["todo", "doing", "done", "blocked"];
const DECISION_KINDS = ["single", "multi", "text"];

export const BLOCK_TYPES = [
  "markdown",
  "callout",
  "table",
  "comparison",
  "decision",
  "diagram",
  "code",
  "diff",
  "steps",
  "risks",
  "questions",
  "html",
];

/**
 * @param {unknown} plan
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePlan(plan) {
  const errors = [];
  const err = (path, message) => {
    if (errors.length < 50) errors.push(`${path}: ${message}`);
  };
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v, path, max, { required = true, allowEmpty = false } = {}) => {
    if (v === undefined || v === null) {
      if (required) err(path, "is required");
      return;
    }
    if (typeof v !== "string") return err(path, "must be a string");
    if (!allowEmpty && required && v.trim() === "") return err(path, "must not be empty");
    if (v.length > max) err(path, `is longer than ${max} characters`);
  };
  const arr = (v, path, max, { required = true, min = 0 } = {}) => {
    if (v === undefined || v === null) {
      if (required) err(path, "is required");
      return false;
    }
    if (!Array.isArray(v)) {
      err(path, "must be an array");
      return false;
    }
    if (v.length > max) err(path, `has more than ${max} entries`);
    if (v.length < min) err(path, `needs at least ${min} entr${min === 1 ? "y" : "ies"}`);
    return true;
  };
  const oneOf = (v, path, values, { required = false } = {}) => {
    if (v === undefined || v === null) {
      if (required) err(path, `is required (one of ${values.join(", ")})`);
      return;
    }
    if (!values.includes(v)) err(path, `must be one of ${values.join(", ")}`);
  };
  const seenIds = new Set();
  const id = (v, path) => {
    if (typeof v !== "string" || !ID_RE.test(v)) {
      return err(path, "must be a lowercase id like \"rollout-steps\" (a-z, 0-9, hyphen; max 64)");
    }
    if (seenIds.has(v)) return err(path, `duplicate id "${v}" - every id in a plan must be unique`);
    seenIds.add(v);
  };
  const strList = (v, path, { required = false } = {}) => {
    if (!arr(v, path, LIMITS.items, { required })) return;
    v.slice(0, LIMITS.items).forEach((s, i) => str(s, `${path}[${i}]`, LIMITS.text));
  };

  if (!isObj(plan)) return { ok: false, errors: ["plan: must be a JSON object"] };
  if (plan.blueprint !== SCHEMA_VERSION) err("blueprint", `must be the number ${SCHEMA_VERSION}`);
  str(plan.title, "title", LIMITS.title);
  str(plan.summary, "summary", LIMITS.text, { required: false });
  oneOf(plan.layout, "layout", ["page", "slides"]);

  if (plan.changelog !== undefined && arr(plan.changelog, "changelog", LIMITS.changelog)) {
    plan.changelog.slice(0, LIMITS.changelog).forEach((entry, i) => {
      const p = `changelog[${i}]`;
      if (!isObj(entry)) return err(p, "must be an object");
      if (!Number.isInteger(entry.draft) || entry.draft < 1) err(`${p}.draft`, "must be a whole number, 1 or higher");
      str(entry.summary, `${p}.summary`, LIMITS.text);
      if (entry.changes !== undefined) strList(entry.changes, `${p}.changes`);
    });
  }

  if (arr(plan.sections, "sections", LIMITS.sections, { min: 1 })) {
    plan.sections.slice(0, LIMITS.sections).forEach((section, si) => {
      const sp = `sections[${si}]`;
      if (!isObj(section)) return err(sp, "must be an object");
      id(section.id, `${sp}.id`);
      str(section.title, `${sp}.title`, LIMITS.title);
      if (!arr(section.blocks, `${sp}.blocks`, LIMITS.blocksPerSection)) return;
      section.blocks.slice(0, LIMITS.blocksPerSection).forEach((block, bi) => {
        validateBlock(block, `${sp}.blocks[${bi}]`);
      });
    });
  }

  function validateBlock(block, p) {
    if (!isObj(block)) return err(p, "must be an object");
    id(block.id, `${p}.id`);
    if (!BLOCK_TYPES.includes(block.type)) {
      return err(`${p}.type`, `must be one of ${BLOCK_TYPES.join(", ")}`);
    }
    str(block.title, `${p}.title`, LIMITS.title, { required: false });
    switch (block.type) {
      case "markdown":
        str(block.text, `${p}.text`, LIMITS.text);
        break;
      case "callout":
        oneOf(block.tone, `${p}.tone`, TONES);
        str(block.text, `${p}.text`, LIMITS.text);
        break;
      case "table":
        if (arr(block.columns, `${p}.columns`, LIMITS.columns, { min: 1 })) {
          block.columns.forEach((c, i) => str(c, `${p}.columns[${i}]`, LIMITS.short));
        }
        if (arr(block.rows, `${p}.rows`, LIMITS.rows)) {
          block.rows.slice(0, LIMITS.rows).forEach((row, ri) => {
            if (!Array.isArray(row)) return err(`${p}.rows[${ri}]`, "must be an array of cell strings");
            if (Array.isArray(block.columns) && row.length !== block.columns.length) {
              err(`${p}.rows[${ri}]`, `has ${row.length} cells but there are ${block.columns.length} columns`);
            }
            row.slice(0, LIMITS.columns).forEach((cell, ci) =>
              str(cell, `${p}.rows[${ri}][${ci}]`, LIMITS.text, { allowEmpty: true, required: true }),
            );
          });
        }
        break;
      case "comparison":
        if (arr(block.options, `${p}.options`, 12, { min: 2 })) {
          block.options.forEach((opt, i) => {
            const op = `${p}.options[${i}]`;
            if (!isObj(opt)) return err(op, "must be an object");
            id(opt.id, `${op}.id`);
            str(opt.title, `${op}.title`, LIMITS.title);
            str(opt.summary, `${op}.summary`, LIMITS.text, { required: false });
            if (opt.pros !== undefined) strList(opt.pros, `${op}.pros`);
            if (opt.cons !== undefined) strList(opt.cons, `${op}.cons`);
            str(opt.cost, `${op}.cost`, LIMITS.text, { required: false });
            if (opt.recommended !== undefined && typeof opt.recommended !== "boolean") {
              err(`${op}.recommended`, "must be true or false");
            }
          });
        }
        break;
      case "decision":
        str(block.question, `${p}.question`, LIMITS.text);
        oneOf(block.kind, `${p}.kind`, DECISION_KINDS, { required: true });
        str(block.context, `${p}.context`, LIMITS.text, { required: false });
        if (block.kind !== "text") {
          if (arr(block.options, `${p}.options`, 20, { min: 2 })) {
            block.options.forEach((opt, i) => {
              const op = `${p}.options[${i}]`;
              if (!isObj(opt)) return err(op, "must be an object");
              id(opt.id, `${op}.id`);
              str(opt.label, `${op}.label`, LIMITS.short);
              str(opt.detail, `${op}.detail`, LIMITS.text, { required: false });
              if (opt.recommended !== undefined && typeof opt.recommended !== "boolean") {
                err(`${op}.recommended`, "must be true or false");
              }
            });
          }
        }
        break;
      case "diagram":
        str(block.mermaid, `${p}.mermaid`, 50_000);
        str(block.caption, `${p}.caption`, LIMITS.text, { required: false });
        break;
      case "code":
        str(block.code, `${p}.code`, LIMITS.text, { allowEmpty: true });
        str(block.language, `${p}.language`, 40, { required: false });
        str(block.filename, `${p}.filename`, LIMITS.short, { required: false });
        break;
      case "diff":
        str(block.before, `${p}.before`, LIMITS.text, { allowEmpty: true });
        str(block.after, `${p}.after`, LIMITS.text, { allowEmpty: true });
        str(block.language, `${p}.language`, 40, { required: false });
        str(block.filename, `${p}.filename`, LIMITS.short, { required: false });
        break;
      case "steps":
        if (arr(block.items, `${p}.items`, LIMITS.items, { min: 1 })) {
          block.items.forEach((item, i) => {
            const ip = `${p}.items[${i}]`;
            if (!isObj(item)) return err(ip, "must be an object");
            id(item.id, `${ip}.id`);
            str(item.title, `${ip}.title`, LIMITS.short);
            str(item.detail, `${ip}.detail`, LIMITS.text, { required: false });
            oneOf(item.status, `${ip}.status`, STEP_STATUS);
          });
        }
        break;
      case "risks":
        if (arr(block.items, `${p}.items`, LIMITS.items, { min: 1 })) {
          block.items.forEach((item, i) => {
            const ip = `${p}.items[${i}]`;
            if (!isObj(item)) return err(ip, "must be an object");
            id(item.id, `${ip}.id`);
            str(item.risk, `${ip}.risk`, LIMITS.text);
            oneOf(item.likelihood, `${ip}.likelihood`, LEVELS);
            oneOf(item.impact, `${ip}.impact`, LEVELS);
            str(item.mitigation, `${ip}.mitigation`, LIMITS.text, { required: false });
          });
        }
        break;
      case "questions":
        if (arr(block.items, `${p}.items`, LIMITS.items, { min: 1 })) {
          block.items.forEach((item, i) => {
            const ip = `${p}.items[${i}]`;
            if (!isObj(item)) return err(ip, "must be an object");
            id(item.id, `${ip}.id`);
            str(item.question, `${ip}.question`, LIMITS.text);
            str(item.context, `${ip}.context`, LIMITS.text, { required: false });
          });
        }
        break;
      case "html":
        str(block.html, `${p}.html`, LIMITS.html);
        str(block.caption, `${p}.caption`, LIMITS.text, { required: false });
        break;
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Parse and validate raw plan bytes.
 * @param {Buffer} buffer
 * @returns {{ ok: true, plan: any } | { ok: false, errors: string[] }}
 */
export function parsePlan(buffer) {
  if (buffer.length > MAX_PLAN_BYTES) {
    return { ok: false, errors: [`plan file is larger than ${MAX_PLAN_BYTES / 1024 / 1024} MB`] };
  }
  let plan;
  try {
    plan = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    return { ok: false, errors: [`plan file is not valid JSON: ${error.message}`] };
  }
  const result = validatePlan(plan);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, plan };
}
