import React from "react";

// A deliberately small Markdown renderer that produces React elements only.
// There is no HTML pass-through: any markup in the source is shown as text.

export function LinkChip({ url, children }) {
  const open = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent("bp-link", { detail: { url, text: event.currentTarget.textContent || "", x: rect.left, y: rect.bottom } }),
    );
  };
  return (
    <span
      className="bp-link"
      role="button"
      tabIndex={0}
      data-bp-link={url}
      title="Preview link (it will not open)"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      }}
    >
      {children}
    </span>
  );
}

const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n][\s\S]*?)\*\*|~~([^~\n]+)~~|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function Inline({ text }) {
  const source = String(text ?? "");
  const nodes = [];
  let last = 0;
  let key = 0;
  for (const match of source.matchAll(INLINE_RE)) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    key += 1;
    if (match[2] !== undefined) nodes.push(<code key={key}>{match[2]}</code>);
    else if (match[3] !== undefined) nodes.push(<LinkChip key={key} url={match[4]}><Inline text={match[3]} /></LinkChip>);
    else if (match[5] !== undefined) nodes.push(<strong key={key}><Inline text={match[5]} /></strong>);
    else if (match[6] !== undefined) nodes.push(<del key={key}><Inline text={match[6]} /></del>);
    else if (match[7] !== undefined) nodes.push(<em key={key}><Inline text={match[7]} /></em>);
    else if (match[8] !== undefined) nodes.push(<em key={key}><Inline text={match[8]} /></em>);
    else if (match[9] !== undefined) nodes.push(<LinkChip key={key} url={match[9]}>{match[9]}</LinkChip>);
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return <>{nodes.map((node, i) => (typeof node === "string" ? withBreaks(node, i) : node))}</>;
}

function withBreaks(text, key) {
  const parts = text.split("\n");
  if (parts.length === 1) return text;
  return (
    <React.Fragment key={`t${key}`}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <br />}
          {part}
        </React.Fragment>
      ))}
    </React.Fragment>
  );
}

function parseBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const isListLine = (line) => /^\s{0,3}([-*+]|\d{1,3}[.)])\s+/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", language: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    if (isListLine(line)) {
      const ordered = /^\s{0,3}\d/.test(line);
      const items = [];
      while (i < lines.length && (isListLine(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length > 0))) {
        if (isListLine(lines[i]) && /^\s{0,3}\S/.test(lines[i])) {
          items.push(lines[i].replace(/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/, ""));
        } else {
          items[items.length - 1] += `\n${lines[i].trim().replace(/^([-*+]|\d{1,3}[.)])\s+/, "- ")}`;
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const body = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s{0,3}(#{1,6}\s|```|~~~|>)/.test(lines[i]) &&
      !isListLine(lines[i])
    ) {
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

function ListItem({ text }) {
  const [first, ...rest] = text.split("\n");
  const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
  return (
    <>
      {task ? (
        <>
          <span aria-hidden="true" className="font-mono mr-1">{task[1] === " " ? "☐" : "☑"}</span>
          <Inline text={task[2]} />
        </>
      ) : (
        <Inline text={first} />
      )}
      {rest.length > 0 && (
        <ul>
          {rest.map((sub, i) => (
            <li key={i}>
              <Inline text={sub.replace(/^- /, "")} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Each top-level piece is an annotation target ("part"). */
export function Markdown({ text, partPrefix = "p" }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="prose-bp">
      {blocks.map((block, index) => {
        const part = `${partPrefix}${index + 1}`;
        switch (block.type) {
          case "heading": {
            const Tag = block.level <= 2 ? "h3" : block.level === 3 ? "h4" : "h5";
            return (
              <Tag key={index} data-anno={part} data-anno-label="Heading">
                <Inline text={block.text} />
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={index} className="code-pre !rounded-md border border-line" data-anno={part} data-anno-label="Code">
                <code>{block.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={index} />;
          case "quote":
            return (
              <blockquote key={index} data-anno={part} data-anno-label="Quote">
                <Inline text={block.text} />
              </blockquote>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} data-anno={`${part}.${itemIndex + 1}`} data-anno-label="List item">
                    <ListItem text={item} />
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p key={index} data-anno={part} data-anno-label="Paragraph">
                <Inline text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
