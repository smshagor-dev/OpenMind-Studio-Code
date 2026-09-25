import { Fragment, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import { inlineText, parseMarkdown, safeHref, type Block, type Inline } from "../services/markdown";

/** GitHub-style heading anchor: lower-case words joined by hyphens. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

interface PreviewProps {
  docId: string;
}

/**
 * The rendered Markdown of a document, updating live as it is edited. It is
 * built as React elements from the parser's tree — there is no HTML string and
 * no `dangerouslySetInnerHTML`, so a document can't inject markup or run a
 * script — and links are handed to the app instead of navigating the window.
 */
export function MarkdownPreview({ docId }: PreviewProps) {
  const text = useSyncExternalStore(
    (listener) => {
      try {
        return container.documents.onDidChangeContent(docId, listener);
      } catch {
        return () => undefined; // the document was just closed
      }
    },
    () => (container.documents.has(docId) ? container.documents.contentOf(docId) : ""),
  );
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const follow = (href: string) => {
    const target = safeHref(href);
    if (target?.kind === "anchor") {
      rootRef.current
        ?.querySelector(`[data-anchor="${CSS.escape(target.id.toLowerCase())}"]`)
        ?.scrollIntoView();
      return;
    }
    void container.markdown.followLink(docId, href);
  };

  return (
    <div className="markdown-preview" ref={rootRef} role="document" aria-label="Markdown preview">
      {blocks.length === 0 ? (
        <p className="markdown-preview__empty">There is nothing to preview yet.</p>
      ) : (
        <BlockList blocks={blocks} onLink={follow} />
      )}
    </div>
  );
}

interface LinkProps {
  onLink: (href: string) => void;
}

/**
 * Renders a Markdown string (e.g. an extension's README) the same safe way:
 * React elements only, raw HTML shown as text, images as their alt text.
 */
export function MarkdownText({ text, onLink }: { text: string } & LinkProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="markdown-preview markdown-preview--embedded">
      <BlockList blocks={blocks} onLink={onLink} />
    </div>
  );
}

function BlockList({ blocks, onLink }: { blocks: Block[] } & LinkProps) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} onLink={onLink} />
      ))}
    </>
  );
}

function BlockView({ block, onLink }: { block: Block } & LinkProps): ReactNode {
  switch (block.t) {
    case "heading": {
      const Tag = `h${String(block.level)}` as "h1";
      return <Tag data-anchor={slugify(inlineText(block.c))}>{renderInline(block.c, onLink)}</Tag>;
    }
    case "paragraph":
      return <p>{renderInline(block.c, onLink)}</p>;
    case "code":
      return (
        <pre>
          <code className={block.lang ? `language-${block.lang}` : undefined}>{block.v}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          <BlockList blocks={block.c} onLink={onLink} />
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.checked === null ? undefined : "markdown-preview__task"}>
          {item.checked === null ? null : (
            <input type="checkbox" checked={item.checked} disabled readOnly />
          )}
          <BlockList blocks={item.blocks} onLink={onLink} />
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {block.head.map((cell, index) => (
                <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                  {renderInline(cell, onLink)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                    {renderInline(cell, onLink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

function renderInline(nodes: Inline[], onLink: (href: string) => void): ReactNode {
  return nodes.map((node, index) => {
    switch (node.t) {
      case "text":
        return <Fragment key={index}>{node.v}</Fragment>;
      case "code":
        return <code key={index}>{node.v}</code>;
      case "em":
        return <em key={index}>{renderInline(node.c, onLink)}</em>;
      case "strong":
        return <strong key={index}>{renderInline(node.c, onLink)}</strong>;
      case "del":
        return <del key={index}>{renderInline(node.c, onLink)}</del>;
      case "image":
        return (
          <span
            key={index}
            className="markdown-preview__image"
            title="Images are not loaded in the preview"
          >
            [{node.alt}]
          </span>
        );
      case "br":
        return <br key={index} />;
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            title={node.href}
            onClick={(event) => {
              // Never let the webview navigate itself; the app decides what a link does.
              event.preventDefault();
              onLink(node.href);
            }}
          >
            {renderInline(node.c, onLink)}
          </a>
        );
    }
  });
}
