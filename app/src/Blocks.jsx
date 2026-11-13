import React from "react";
import hljs from "highlight.js/lib/common";
import { Inline, Markdown } from "./Markdown.jsx";
import { lineDiff, sanitizeDiagramSvg, sanitizeHighlighted, sanitizeHtml } from "./lib.js";

export const ReviewContext = React.createContext({ queueItem: () => {}, readOnly: false, theme: "light", queued: [] });

const TONE = {
  note: { label: "Note", className: "border-accent", text: "text-accent" },
  tip: { label: "Tip", className: "border-success", text: "text-success" },
  important: { label: "Important", className: "border-done", text: "text-done" },
  warning: { label: "Warning", className: "border-attention", text: "text-attention" },
  caution: { label: "Caution", className: "border-danger", text: "text-danger" },
};

function Callout({ block }) {
  const tone = TONE[block.tone] || TONE.note;
  return (
    <div className={`border-l-4 pl-4 py-1 ${tone.className}`} data-anno="callout" data-anno-label={tone.label}>
      <div className={`font-semibold mb-1 ${tone.text}`}>{tone.label}</div>
      <Markdown text={block.text} />
    </div>
  );
}

function Table({ block }) {
  return (
    <div className="overflow-x-auto border border-line rounded-md">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="bg-subtle">
            {block.columns.map((column, i) => (
              <th key={i} scope="col" className="text-left font-semibold px-3 py-2 border-b border-line">
                <Inline text={column} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-line-muted first:border-t-0">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-3 py-2 align-top"
                  data-anno={`r${r + 1}c${c + 1}`}
                  data-anno-kind="cell"
                  data-anno-label={`Row ${r + 1} (${String(row[0]).slice(0, 60)}) / ${block.columns[c]}`}
                >
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Comparison({ block }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(240px, 1fr))` }}>
      {block.options.map((option) => (
        <div
          key={option.id}
          className={`box p-4 flex flex-col gap-3 ${option.recommended ? "!border-success" : ""}`}
          data-anno={option.id}
          data-anno-kind="item"
          data-anno-label={`Option: ${option.title}`}
        >
          <div className="flex items-start justify-between gap-2">
            <h4 className="font-semibold text-[15px]">{option.title}</h4>
            {option.recommended && <span className="label label-success">Recommended</span>}
          </div>
          {option.summary && <div className="text-muted"><Inline text={option.summary} /></div>}
          {option.pros?.length > 0 && (
            <ul className="flex flex-col gap-1">
              {option.pros.map((pro, i) => (
                <li key={i} className="flex gap-2" data-anno={`${option.id}.pro${i + 1}`} data-anno-kind="item" data-anno-label={`${option.title} / benefit`}>
                  <span className="text-success font-bold" aria-label="Benefit">+</span>
                  <span><Inline text={pro} /></span>
                </li>
              ))}
            </ul>
          )}
          {option.cons?.length > 0 && (
            <ul className="flex flex-col gap-1">
              {option.cons.map((con, i) => (
                <li key={i} className="flex gap-2" data-anno={`${option.id}.con${i + 1}`} data-anno-kind="item" data-anno-label={`${option.title} / drawback`}>
                  <span className="text-danger font-bold" aria-label="Drawback">−</span>
                  <span><Inline text={con} /></span>
                </li>
              ))}
            </ul>
          )}
          {option.cost && (
            <div className="mt-auto pt-2 border-t border-line-muted text-[13px]" data-anno={`${option.id}.cost`} data-anno-kind="item" data-anno-label={`${option.title} / cost`}>
              <span className="font-semibold">Cost: </span>
              <Inline text={option.cost} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Decision({ block, sectionId }) {
  const { queueItem, readOnly, queued } = React.useContext(ReviewContext);
  const existing = queued.find((item) => item.key === `decision:${block.id}`);
  const [choices, setChoices] = React.useState(existing?.answer?.choices || []);
  const [text, setText] = React.useState(existing?.answer?.text || existing?.comment || "");
  const multi = block.kind === "multi";
  const toggle = (id) => {
    if (multi) setChoices((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
    else setChoices([id]);
  };
  const canQueue = block.kind === "text" ? text.trim() !== "" : choices.length > 0;
  const submit = () => {
    const labels = (block.options || []).filter((o) => choices.includes(o.id)).map((o) => o.label);
    queueItem(
      {
        comment: block.kind === "text" ? "" : text.trim(),
        answer: block.kind === "text" ? { text: text.trim() } : { choices, choiceLabels: labels },
        target: { kind: "decision", sectionId, blockId: block.id, label: `Decision: ${block.question.slice(0, 200)}` },
      },
      `decision:${block.id}`,
    );
  };
  return (
    <div className="box" data-bp-interactive>
      <div className="box-header flex items-center gap-2">
        <span className="label label-attention">Decision needed</span>
        <span className="font-semibold"><Inline text={block.question} /></span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        {block.context && <div className="text-muted"><Markdown text={block.context} /></div>}
        {block.kind !== "text" && (
          <div className="flex flex-col gap-2" role={multi ? "group" : "radiogroup"}>
            {block.options.map((option) => (
              <label key={option.id} className={`flex gap-3 p-3 border rounded-md cursor-pointer ${choices.includes(option.id) ? "border-accent bg-accent-subtle" : "border-line"}`}>
                <input
                  type={multi ? "checkbox" : "radio"}
                  name={`decision-${block.id}`}
                  className="mt-1"
                  checked={choices.includes(option.id)}
                  disabled={readOnly}
                  onChange={() => toggle(option.id)}
                />
                <span>
                  <span className="font-semibold">{option.label}</span>
                  {option.recommended && <span className="label label-success ml-2">Recommended</span>}
                  {option.detail && <span className="block text-muted text-[13px]"><Inline text={option.detail} /></span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <textarea
          className="field"
          rows={block.kind === "text" ? 3 : 2}
          placeholder={block.kind === "text" ? "Your answer" : "Optional: why, or any conditions"}
          value={text}
          disabled={readOnly}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-sm" disabled={readOnly || !canQueue} onClick={submit}>
            {existing ? "Update queued answer" : "Queue answer"}
          </button>
          <span className="text-muted text-[12px]" role="status">
            {existing ? "Queued - not sent yet. It goes to the agent when you press Send." : "Nothing is sent until you press Send."}
          </span>
        </div>
      </div>
    </div>
  );
}

let mermaidPromise = null;
let diagramCounter = 0;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

function Diagram({ block }) {
  const { theme } = React.useContext(ReviewContext);
  const [result, setResult] = React.useState({ svg: "", error: "" });
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict", // labels are encoded, click handlers and scripts are disabled
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: theme === "dark" ? "dark" : "default",
          suppressErrorRendering: true,
          maxTextSize: 50000,
          maxEdges: 500,
          deterministicIds: true,
          // Diagram source may not override any of these with %%{init}%% directives.
          secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "flowchart", "themeCSS", "fontFamily", "altFontFamily"],
        });
        diagramCounter += 1;
        const { svg } = await mermaid.render(`bp-diagram-${diagramCounter}`, block.mermaid);
        if (!cancelled) setResult({ svg: sanitizeDiagramSvg(svg), error: "" });
      } catch (error) {
        if (!cancelled) setResult({ svg: "", error: String(error?.message || error).slice(0, 600) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [block.mermaid, theme]);

  return (
    <figure className="m-0">
      {result.error ? (
        <div className="border border-danger rounded-md p-3" data-anno="diagram-error" data-anno-label="Diagram error">
          <div className="font-semibold text-danger mb-1">This diagram could not be drawn</div>
          <pre className="whitespace-pre-wrap text-[12px] text-muted font-mono m-0">{result.error}</pre>
          <pre className="code-pre !rounded-md mt-2">{block.mermaid}</pre>
        </div>
      ) : (
        <div className="bp-diagram border border-line rounded-md p-4 bg-canvas" dangerouslySetInnerHTML={{ __html: result.svg }} />
      )}
      {block.caption && (
        <figcaption className="text-muted text-[13px] mt-2" data-anno="caption" data-anno-label="Caption">
          <Inline text={block.caption} />
        </figcaption>
      )}
    </figure>
  );
}

function highlight(code, language) {
  try {
    if (language && hljs.getLanguage(language)) return sanitizeHighlighted(hljs.highlight(code, { language, ignoreIllegals: true }).value);
  } catch {
    // fall through to plain text
  }
  return null;
}

function FileHeader({ filename, language, extra }) {
  if (!filename && !language && !extra) return null;
  return (
    <div className="box-header flex items-center gap-2 !py-1.5 !px-3 text-[12px] font-mono font-normal">
      <span className="font-semibold">{filename || language}</span>
      {extra}
    </div>
  );
}

function Code({ block }) {
  const html = React.useMemo(() => highlight(block.code, block.language), [block.code, block.language]);
  return (
    <div className="box overflow-hidden" data-anno="code" data-anno-label={`Code${block.filename ? `: ${block.filename}` : ""}`}>
      <FileHeader filename={block.filename} language={block.language} />
      <pre className="code-pre">
        {html === null ? <code>{block.code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
    </div>
  );
}

function Diff({ block }) {
  const rows = React.useMemo(() => lineDiff(block.before, block.after), [block.before, block.after]);
  const added = rows.filter((row) => row.kind === "add").length;
  const removed = rows.filter((row) => row.kind === "del").length;
  return (
    <div className="box overflow-hidden">
      <FileHeader
        filename={block.filename}
        language={block.language}
        extra={
          <span className="ml-auto flex gap-2 font-semibold">
            <span className="text-success">+{added}</span>
            <span className="text-danger">−{removed}</span>
          </span>
        }
      />
      <div className="overflow-x-auto">
        <table className="diff-table">
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className={row.kind === "add" ? "diff-add" : row.kind === "del" ? "diff-del" : ""}
                data-anno={`line${i + 1}`}
                data-anno-kind="item"
                data-anno-label={`${block.filename || "Diff"} ${row.kind === "add" ? `new line ${row.right}` : row.kind === "del" ? `old line ${row.left}` : `line ${row.right}`}`}
              >
                <td className="num">{row.left ?? ""}</td>
                <td className="num">{row.right ?? ""}</td>
                <td className="num !text-center !min-w-0">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</td>
                <td>{row.text || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS = {
  todo: { label: "To do", className: "" },
  doing: { label: "In progress", className: "label-attention" },
  done: { label: "Done", className: "label-done" },
  blocked: { label: "Blocked", className: "label-danger" },
};

function Steps({ block }) {
  return (
    <ol className="flex flex-col">
      {block.items.map((item, index) => (
        <li key={item.id} className="flex gap-3" data-anno={item.id} data-anno-kind="item" data-anno-label={`Step ${index + 1}: ${item.title}`}>
          <div className="flex flex-col items-center">
            <span className="flex items-center justify-center w-7 h-7 rounded-full bg-subtle border border-line text-[12px] font-semibold">{index + 1}</span>
            {index < block.items.length - 1 && <span className="w-px flex-1 bg-line" />}
          </div>
          <div className="pb-5 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{item.title}</span>
              {item.status && <span className={`label ${STATUS[item.status].className}`}>{STATUS[item.status].label}</span>}
            </div>
            {item.detail && <div className="text-muted mt-1"><Markdown text={item.detail} partPrefix={`${item.id}.p`} /></div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const LEVEL = { low: "label-success", medium: "label-attention", high: "label-danger" };

function Risks({ block }) {
  return (
    <div className="flex flex-col gap-2">
      {block.items.map((item) => (
        <div key={item.id} className="box p-3" data-anno={item.id} data-anno-kind="item" data-anno-label={`Risk: ${item.risk.slice(0, 120)}`}>
          <div className="flex items-start gap-2 flex-wrap">
            <span className="font-semibold flex-1 min-w-[200px]"><Inline text={item.risk} /></span>
            {item.likelihood && <span className={`label ${LEVEL[item.likelihood]}`}>Likelihood: {item.likelihood}</span>}
            {item.impact && <span className={`label ${LEVEL[item.impact]}`}>Impact: {item.impact}</span>}
          </div>
          {item.mitigation && (
            <div className="text-muted mt-2 text-[13px]">
              <span className="font-semibold text-fg">Mitigation: </span>
              <Inline text={item.mitigation} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Questions({ block }) {
  return (
    <ul className="flex flex-col gap-2">
      {block.items.map((item) => (
        <li key={item.id} className="box p-3 flex gap-3" data-anno={item.id} data-anno-kind="item" data-anno-label={`Open question: ${item.question.slice(0, 120)}`}>
          <span className="label label-done shrink-0">Open</span>
          <div className="min-w-0">
            <div className="font-semibold"><Inline text={item.question} /></div>
            {item.context && <div className="text-muted text-[13px] mt-1"><Inline text={item.context} /></div>}
            <div className="text-muted text-[12px] mt-1">Click this card to answer it.</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Html({ block }) {
  const html = React.useMemo(() => sanitizeHtml(block.html), [block.html]);
  return (
    <figure className="m-0">
      <div className="bp-html border border-line rounded-md p-4" dangerouslySetInnerHTML={{ __html: html }} />
      {block.caption && (
        <figcaption className="text-muted text-[13px] mt-2" data-anno="caption" data-anno-label="Caption">
          <Inline text={block.caption} />
        </figcaption>
      )}
    </figure>
  );
}

export const TYPE_LABEL = {
  markdown: "Text",
  callout: "Callout",
  table: "Table",
  comparison: "Comparison",
  decision: "Decision",
  diagram: "Diagram",
  code: "Code",
  diff: "Diff",
  steps: "Steps",
  risks: "Risks",
  questions: "Open questions",
  html: "Illustration",
};

export function BlockBody({ block, sectionId }) {
  switch (block.type) {
    case "markdown":
      return <Markdown text={block.text} />;
    case "callout":
      return <Callout block={block} />;
    case "table":
      return <Table block={block} />;
    case "comparison":
      return <Comparison block={block} />;
    case "decision":
      return <Decision block={block} sectionId={sectionId} />;
    case "diagram":
      return <Diagram block={block} />;
    case "code":
      return <Code block={block} />;
    case "diff":
      return <Diff block={block} />;
    case "steps":
      return <Steps block={block} />;
    case "risks":
      return <Risks block={block} />;
    case "questions":
      return <Questions block={block} />;
    case "html":
      return <Html block={block} />;
    default:
      return <div className="text-muted">Unsupported block type.</div>;
  }
}
