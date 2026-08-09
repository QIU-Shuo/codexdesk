import { createContext, useContext, useMemo } from "react";

/**
 * How a `[label](path:line)` click opens a file.
 *
 * A context rather than a prop because `Markdown` is rendered from a dozen
 * places (agent messages, work disclosures, plans, tool output) and only one
 * of them — the transcript — sits inside a workbench that has anywhere to put
 * a file. Threading a callback through every call site would mean changing
 * all of them to serve one; an unset context simply renders the label as
 * plain text, which is the correct behaviour everywhere else.
 */
export type OpenFileRef = (path: string, line?: number) => void;

const FileRefContext = createContext<OpenFileRef | null>(null);

export function FileRefProvider({
  onOpenFile,
  children,
}: {
  onOpenFile: OpenFileRef;
  children: React.ReactNode;
}) {
  return (
    <FileRefContext.Provider value={onOpenFile}>
      {children}
    </FileRefContext.Provider>
  );
}

/**
 * Minimal Markdown rendering for agent messages.
 *
 * A review described the transcript as reading "like a protocol debugger":
 * identical bordered cards, raw backticks, no hierarchy. Agent output is
 * Markdown, so rendering it is most of the difference between a debug view
 * and something readable.
 *
 * Hand-rolled rather than pulling in a parser: the input is trusted-ish
 * (model output, already in our process) but we still never use
 * `dangerouslySetInnerHTML` — every node below is a real React element, so
 * there is no HTML-injection path at all. Scope is deliberately narrow —
 * headings, lists, fenced code, inline code, bold/italic, links. Anything
 * unrecognized falls through as text rather than being silently eaten.
 */
type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  /** Nested blockquotes recurse: the body is parsed as markdown in turn. */
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { kind: "hr" };

/**
 * One list item: its own inline text plus any sub-list beneath it.
 *
 * Previously an item was a bare string and every bullet in a run was
 * collected at one level, so indentation was silently discarded — measured at
 * **187 indented bullets** across 2033 real agent messages. A flattened plan
 * or checklist does not merely look wrong, it says something different from
 * what the agent wrote.
 */
export type ListItem = {
  text: string;
  children?: Extract<Block, { kind: "ul" | "ol" }>;
};

export type Align = "left" | "center" | "right" | null;

/** Indent width of a line, tabs counted as two columns. */
function indentOf(line: string): number {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
  return ws.replace(/\t/g, "  ").length;
}

const BULLET = /^[ \t]*([-*+])\s+/;
const ORDERED = /^[ \t]*(\d+)[.)]\s+/;

/** A `|---|:--:|` delimiter row, which is what makes the block a table. */
function parseAlignRow(line: string): Align[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !/^\|?[\s:|-]+\|?$/.test(trimmed)) return null;
  const cells = splitRow(trimmed);
  if (cells.length === 0) return null;
  const align: Align[] = [];
  for (const cell of cells) {
    // Every cell must be a run of dashes, optionally colon-anchored. A row of
    // prose containing a stray dash is not a table delimiter.
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    align.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return align;
}

/**
 * Split one table row into cells.
 *
 * Leading and trailing pipes are optional in GFM. Escaped pipes (`\|`) are
 * content — they appear whenever an agent puts a shell pipeline or a union
 * type in a cell, which is often in this codebase's own transcripts.
 */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  const body = line.trim();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  // Drop the empty cells created by the optional outer pipes.
  if (cells.length && cells[0] === "" && body.startsWith("|")) cells.shift();
  if (cells.length && cells[cells.length - 1] === "" && body.endsWith("|")) {
    cells.pop();
  }
  return cells;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code. An unterminated fence runs to the end rather than
    // swallowing the rest of the message into nothing.
    const fence = /^\s*(?:```|~~~)(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "h",
        level: heading[1]!.length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }

    // Table: a header row followed by a `|---|` delimiter. The delimiter is
    // what identifies it — a lone pipe line is prose, and treating it as a
    // table would eat ordinary text containing a vertical bar.
    if (line.includes("|")) {
      const align = parseAlignRow(lines[i + 1] ?? "");
      if (align) {
        const head = splitRow(line);
        i += 2;
        const rows: string[][] = [];
        while (
          i < lines.length &&
          (lines[i] ?? "").includes("|") &&
          !/^\s*$/.test(lines[i] ?? "")
        ) {
          const cells = splitRow(lines[i]!);
          // Ragged rows are normalized to the header width: a short row
          // renders blank cells rather than shifting later columns left.
          while (cells.length < head.length) cells.push("");
          rows.push(cells.slice(0, Math.max(head.length, 1)));
          i++;
        }
        blocks.push({ kind: "table", head, align, rows });
        continue;
      }
    }

    // Indented code: four spaces, and only where a list is not in play —
    // an indented bullet is a nested list item, not a code block.
    if (/^ {4}\S/.test(line) && !BULLET.test(line) && !ORDERED.test(line)) {
      const body: string[] = [];
      while (
        i < lines.length &&
        (/^ {4}/.test(lines[i] ?? "") || /^\s*$/.test(lines[i] ?? ""))
      ) {
        // Stop at a blank line that ends the block rather than absorbing the
        // gap before the next paragraph.
        if (/^\s*$/.test(lines[i] ?? "")) {
          const next = lines[i + 1] ?? "";
          if (!/^ {4}\S/.test(next)) break;
          body.push("");
          i++;
          continue;
        }
        body.push((lines[i] ?? "").slice(4));
        i++;
      }
      blocks.push({ kind: "code", lang: "", text: body.join("\n") });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      // Recurse, so a nested quote nests and a list inside a quote is a list.
      // Previously the inner `>` survived as literal text.
      blocks.push({ kind: "quote", blocks: parseMarkdown(body.join("\n")) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] ?? "") &&
      !/^\s*(?:```|~~~)/.test(lines[i] ?? "") &&
      !/^(#{1,6})\s/.test(lines[i] ?? "") &&
      !BULLET.test(lines[i] ?? "") &&
      !ORDERED.test(lines[i] ?? "") &&
      !/^\s*>\s?/.test(lines[i] ?? "") &&
      !((lines[i] ?? "").includes("|") && parseAlignRow(lines[i + 1] ?? ""))
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
  }

  return blocks;
}

/**
 * Parse one list, recursing into deeper indentation.
 *
 * Returns the list and the index of the first line after it. Nesting is by
 * indent column: a line indented further than the item that opened the list
 * belongs to that item's sub-list. A *less*-indented line ends this list and
 * returns control to the caller, which is what makes multiple levels unwind
 * correctly rather than collapsing into one.
 */
function parseList(
  lines: string[],
  start: number,
): [Extract<Block, { kind: "ul" | "ol" }>, number] {
  const first = lines[start] ?? "";
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const baseIndent = indentOf(first);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*$/.test(line)) {
      // A blank line inside a list is only a separator if the list continues.
      const next = lines[i + 1] ?? "";
      if (!BULLET.test(next) && !ORDERED.test(next)) break;
      i++;
      continue;
    }
    const isItem = BULLET.test(line) || ORDERED.test(line);
    if (!isItem) break;

    const indent = indentOf(line);
    if (indent < baseIndent) break; // belongs to an outer list
    if (indent > baseIndent) {
      // Deeper: attach to the previous item, or start one if there is none.
      const [child, next] = parseList(lines, i);
      const prev = items[items.length - 1];
      if (prev) prev.children = child;
      else items.push({ text: "", children: child });
      i = next;
      continue;
    }

    // A marker change at the same indent starts a new list (ul -> ol).
    const lineOrdered = ORDERED.test(line) && !BULLET.test(line);
    if (lineOrdered !== ordered) break;

    items.push({
      text: line.replace(ordered ? ORDERED : BULLET, ""),
    });
    i++;
  }

  return [{ kind: ordered ? "ol" : "ul", items }, i];
}

/** Inline spans: `code`, **bold**, *italic*, and links. */
export function Inline({ text }: { text: string }) {
  const parts = useMemo(() => splitInline(text), [text]);
  const openFile = useContext(FileRefContext);
  return (
    <>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "code":
            return <code key={i}>{p.text}</code>;
          case "strong":
            return <strong key={i}>{p.text}</strong>;
          case "em":
            return <em key={i}>{p.text}</em>;
          case "link":
            return (
              <a key={i} href={p.href} target="_blank" rel="noreferrer">
                {p.text}
              </a>
            );
          case "file":
            // Without a workbench to open into, the citation is still
            // information — show the label rather than a dead control.
            if (!openFile) return <span key={i}>{p.text}</span>;
            return (
              <button
                key={i}
                type="button"
                className="fileref"
                title={p.line ? `${p.path}:${p.line}` : p.path}
                onClick={() => openFile(p.path, p.line)}
              >
                {p.text}
                {p.line !== undefined && (
                  <span className="fileref-line"> ({p.line})</span>
                )}
              </button>
            );
          case "image":
            // Only `data:` and `http(s)`. A local path would need a main-process
            // read to become renderable, and a bare `file://` src is the same
            // escape hatch the `file` span exists to avoid.
            return /^(https?:|data:image\/)/i.test(p.src) ? (
              <img key={i} className="md-image" src={p.src} alt={p.alt} />
            ) : (
              <span key={i} className="md-image-alt">
                {p.alt || p.src}
              </span>
            );
          case "text":
            return <span key={i}>{p.text}</span>;
          default:
            return null;
        }
      })}
    </>
  );
}

type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string }
  /**
   * A link to a file in the workspace, optionally at a line.
   *
   * Agents cite their evidence as `[agents.py](/abs/path/agents.py:345)`, and
   * treating that as "not http, so print the raw markdown" made the most
   * useful thing in a reply the least readable. These open in the workbench's
   * file panel rather than in a browser or an external editor.
   *
   * Kept as a distinct span rather than an `<a href="file://…">` so there is
   * no navigable URL anywhere in the DOM: the click is a React handler that
   * hands a path to the workbench, and the main process still confines every
   * read to the workspace roots. A `file://` href would be a real escape
   * hatch — Electron will happily follow one.
   */
  | { kind: "file"; text: string; path: string; line?: number }
  /**
   * `![alt](src)`. Previously unmatched, so the `!` printed as stray text and
   * the `[alt](src)` behind it became a *file link* — a control that opens a
   * viewer for something that is not a file. Rare (2 of 2033 messages) but
   * wrong in kind, not just in degree.
   */
  | { kind: "image"; alt: string; src: string };

/**
 * Split a link target into a path and an optional line.
 *
 * Accepts `path:345` and `path#L345`, both of which agents emit. Windows
 * drive letters (`C:\src\a.ts`) are why the line group requires digits to the
 * end — otherwise `C:` parses as a line number and the path loses its drive.
 */
export function parseFileTarget(
  href: string,
): { path: string; line?: number } | null {
  // Markdown allows the target to be wrapped in angle brackets, and agents do
  // it whenever a path might contain spaces. Verified in the running app: the
  // brackets survived into the path, so the line never parsed and the viewer
  // reported "this file no longer exists" for a file that was right there.
  let raw = href.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
  // An optional title — `[a](path "why")` — is documentation, not the target.
  raw = raw.replace(/\s+["'(].*$/, "");

  // Only absolute POSIX paths and workspace-relative ones. A bare word like
  // `README` is more likely prose than a path, and guessing wrong turns
  // ordinary text into a dead link.
  const m = /^(.*?)(?::(\d+)|#L(\d+))?$/.exec(raw);
  if (!m) return null;
  const path = m[1] ?? "";
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  // Require something that looks like a path, not a bare identifier.
  if (!path.startsWith("/") && !path.startsWith("./") && !path.includes("/")) {
    return null;
  }
  const digits = m[2] ?? m[3];
  const line = digits ? Number(digits) : undefined;
  return line !== undefined ? { path, line } : { path };
}

export function splitInline(text: string): Span[] {
  const spans: Span[] = [];
  // Inline code first: its contents must not be re-parsed for emphasis.
  // Order matters: images before links (an image is a link with a `!`), and
  // `**` before `*` so bold wins over emphasis. The bold alternative is
  // `(?:[^*]|\*(?!\*))+` rather than `[^*]+` so `**a * b**` stays one bold
  // span — with the old pattern the inner `*` matched the emphasis rule first
  // and the text came out mangled.
  // Link targets allow one level of balanced parens: `[fn](/a/b(1).ts:12)`
  // used to truncate at the first `)`, losing both the path tail and the line.
  const pattern =
    /(`[^`]+`)|(!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\))|(\*\*(?:[^*]|\*(?!\*))+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:[^()]|\([^()]*\))*\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text))) {
    if (m.index > last) {
      spans.push({ kind: "text", text: text.slice(last, m.index) });
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      spans.push({ kind: "code", text: tok.slice(1, -1) });
    } else if (tok.startsWith("![")) {
      const img = /^!\[([^\]]*)\]\((.*)\)$/s.exec(tok);
      const src = (img?.[2] ?? "").trim();
      spans.push(
        src ? { kind: "image", alt: img?.[1] ?? "", src } : { kind: "text", text: tok },
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      spans.push({ kind: "strong", text: tok.slice(2, -2) });
    } else if (tok.startsWith("*")) {
      spans.push({ kind: "em", text: tok.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\((.*)\)$/s.exec(tok);
      if (link) {
        // Only http(s); a `javascript:` href would be a real hazard.
        const href = link[2] ?? "";
        const label = link[1] ?? "";
        if (/^https?:\/\//i.test(href)) {
          spans.push({ kind: "link", text: label, href });
        } else {
          // A workspace path opens in the file panel; anything else stays
          // literal text rather than becoming a link we cannot honour.
          const target = parseFileTarget(href);
          spans.push(
            target
              ? { kind: "file", text: label, ...target }
              : { kind: "text", text: tok },
          );
        }
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    spans.push({ kind: "text", text: text.slice(last) });
  }
  return spans;
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      <Blocks blocks={blocks} />
    </div>
  );
}

/**
 * Render a block list.
 *
 * Split out of `Markdown` so blockquotes can recurse into it — a quote now
 * holds parsed blocks rather than raw text, which is what makes a nested
 * quote nest instead of leaking a literal `>` into the prose.
 */
function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as "h3";
            return (
              <Tag key={i}>
                <Inline text={b.text} />
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={i} className="codeblock" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
          case "ol":
            return <List key={i} block={b} />;
          case "quote":
            // Recursive: a quote holds blocks, so a nested quote nests and a
            // list inside a quote is a list.
            return (
              <blockquote key={i}>
                <Blocks blocks={b.blocks} />
              </blockquote>
            );
          case "table":
            return <Table key={i} block={b} />;
          case "hr":
            return <hr key={i} />;
          default:
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            );
        }
      })}
    </>
  );
}

/** A list, recursing into each item's sub-list. */
function List({ block }: { block: Extract<Block, { kind: "ul" | "ol" }> }) {
  const Tag = block.kind === "ol" ? "ol" : "ul";
  return (
    <Tag>
      {block.items.map((item, i) => (
        <li key={i}>
          <Inline text={item.text} />
          {item.children && <List block={item.children} />}
        </li>
      ))}
    </Tag>
  );
}

/**
 * A GFM table.
 *
 * The gap that prompted this: `parseMarkdown` had no table kind at all, so
 * pipe rows fell through to the paragraph branch and printed verbatim —
 * measured at **520 raw lines across 56 of 2033 real agent messages**,
 * averaging 9 lines each, and appearing mostly in final answers where they
 * matter most.
 *
 * Column alignment comes from the delimiter row (`:--`, `:-:`, `--:`) and is
 * applied inline rather than through per-column classes, since the count is
 * unbounded.
 */
function Table({ block }: { block: Extract<Block, { kind: "table" }> }) {
  const style = (col: number) => {
    const a = block.align[col];
    return a ? { textAlign: a } : undefined;
  };
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {block.head.map((cell, i) => (
              <th key={i} style={style(i)}>
                <Inline text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={style(c)}>
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
