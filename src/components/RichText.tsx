// Markdown-aware message renderer.
//
// Wraps react-markdown + remark-gfm so the model's output gets proper
// rendering of:
//   - tables (GFM)
//   - code blocks (with monospace + scroll for long lines)
//   - inline code, bold, italic, lists, blockquotes, headings
//   - bare URLs (linkified by remark-gfm's autolink-literal)
//   - [label](url) markdown links
//   - strikethrough, task lists
//
// All anchors render with target="_blank"; the main process's
// setWindowOpenHandler routes them to shell.openExternal so they open in
// the user's default browser instead of inside Electron.
//
// We deliberately keep block-level styles tight (no big margins) so the
// chat transcript doesn't look like a doc page. Tables and code blocks
// are the only elements with a visible "card" treatment.

import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { InlineImage } from './InlineImage';
import clsx from 'clsx';

interface Props {
  text: string;
  /**
   * Optional className applied to the wrapping container. The default
   * styling targets chat-message context: tight spacing, no big margins.
   */
  className?: string;
}

// Component overrides. We strip `node` from each props bag (react-markdown
// passes the AST node, but we don't want it leaking into the DOM).
const components = {
  // Anchors -> open in default browser. The main process's window-open
  // handler intercepts target="_blank" and routes to shell.openExternal.
  a: ({ node: _n, ...p }: any) => (
    <a
      {...p}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline break-all"
    />
  ),

  // Images -> render inline + clickable (lightbox with copy / save). This is
  // how the model shows a picture in the conversation: it emits
  // ![alt](url) with an http(s) URL, a file:// path, or a data: URL.
  img: ({ node: _n, src, alt }: any) =>
    src ? <InlineImage src={String(src)} alt={alt ? String(alt) : undefined} /> : null,

  // Paragraphs: tight spacing inside chat.
  p: ({ node: _n, ...p }: any) => (
    <p {...p} className="my-1 first:mt-0 last:mb-0 leading-snug" />
  ),

  // Headings: scaled-down because we're in chat, not a doc.
  h1: ({ node: _n, ...p }: any) => (
    <h1 {...p} className="text-[15px] font-semibold mt-2 mb-1 text-text" />
  ),
  h2: ({ node: _n, ...p }: any) => (
    <h2 {...p} className="text-[14px] font-semibold mt-2 mb-1 text-text" />
  ),
  h3: ({ node: _n, ...p }: any) => (
    <h3 {...p} className="text-[13px] font-semibold mt-1.5 mb-0.5 text-text" />
  ),
  h4: ({ node: _n, ...p }: any) => (
    <h4 {...p} className="text-[13px] font-semibold mt-1 mb-0.5 text-text-muted" />
  ),
  h5: ({ node: _n, ...p }: any) => (
    <h5 {...p} className="text-[12px] font-semibold mt-1 mb-0.5 text-text-muted" />
  ),
  h6: ({ node: _n, ...p }: any) => (
    <h6 {...p} className="text-[12px] font-semibold mt-1 mb-0.5 text-text-dim" />
  ),

  // Lists. `list-outside` keeps bullets aligned with the surrounding text.
  ul: ({ node: _n, ...p }: any) => (
    <ul {...p} className="list-disc list-outside ml-5 my-1 space-y-0.5" />
  ),
  ol: ({ node: _n, ...p }: any) => (
    <ol {...p} className="list-decimal list-outside ml-5 my-1 space-y-0.5" />
  ),
  li: ({ node: _n, ...p }: any) => (
    <li {...p} className="leading-snug" />
  ),

  // Blockquotes: subtle left border, dimmer text.
  blockquote: ({ node: _n, ...p }: any) => (
    <blockquote
      {...p}
      className="border-l-2 border-border pl-3 my-1 text-text-muted italic"
    />
  ),

  // Tables: legible even with many columns; horizontal scroll on overflow.
  table: ({ node: _n, ...p }: any) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table {...p} className="text-[12px] border-collapse w-full" />
    </div>
  ),
  thead: ({ node: _n, ...p }: any) => (
    <thead {...p} className="bg-bg-elevated" />
  ),
  tbody: ({ node: _n, ...p }: any) => <tbody {...p} />,
  tr: ({ node: _n, ...p }: any) => (
    <tr {...p} className="border-b border-border last:border-b-0" />
  ),
  th: ({ node: _n, ...p }: any) => (
    <th
      {...p}
      className="text-left font-semibold px-2.5 py-1.5 text-text border-r border-border last:border-r-0"
    />
  ),
  td: ({ node: _n, ...p }: any) => (
    <td
      {...p}
      className="align-top px-2.5 py-1.5 text-text border-r border-border last:border-r-0"
    />
  ),

  // Inline + fenced code. react-markdown v10 no longer passes an `inline`
  // prop, so we detect via two signals:
  //   1. A `language-*` className indicates a fenced block (set by
  //      ` ```ts ... ``` ` etc.)
  //   2. Children containing a newline means a multi-line block (set by
  //      indented code blocks or fences without a language tag)
  // Otherwise it's inline code (` `foo` ` in the source).
  code: ({ node: _n, className, children, ...rest }: any) => {
    const text = String(children ?? '').replace(/\n$/, '');
    const isBlock =
      (className && /\blanguage-/.test(className)) || text.includes('\n');
    if (!isBlock) {
      return (
        <code
          {...rest}
          className={clsx(
            'px-1 py-0.5 rounded bg-bg-elevated border border-border text-[12px] font-mono text-text break-words',
            className
          )}
        >
          {text}
        </code>
      );
    }
    return (
      <code
        {...rest}
        className={clsx('font-mono text-[12px] text-text whitespace-pre', className)}
      >
        {text}
      </code>
    );
  },
  pre: ({ node: _n, ...p }: any) => (
    <pre
      {...p}
      className="my-1.5 px-3 py-2 rounded-md bg-bg-elevated border border-border overflow-x-auto"
    />
  ),

  // Horizontal rule.
  hr: ({ node: _n, ...p }: any) => (
    <hr {...p} className="my-2 border-border" />
  ),

  // Strikethrough (GFM).
  del: ({ node: _n, ...p }: any) => (
    <del {...p} className="text-text-dim line-through" />
  ),
};

/**
 * Render `text` as GFM markdown (tables, autolinks, strikethrough, task
 * lists) with chat-friendly styling. URLs are clickable and open in the
 * user's default browser via the main process's setWindowOpenHandler.
 */
export function RichText({ text, className }: Props): ReactNode {
  if (!text) return null;
  return (
    <div className={clsx('break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Default behavior: raw HTML in markdown is treated as plain text
        // (react-markdown doesn't parse it unless we add rehype-raw). We
        // want this — no unsanitized HTML in chat output.
        components={components}
        // react-markdown's default urlTransform strips `data:` and `file:`
        // URLs as "unsafe". We need them for inline images: the model shows a
        // screenshot/generated picture via ![](data:image/png;base64,...) and
        // local files via ![](file://...). Allow http(s)/data/file/mailto/tel;
        // strip everything else (e.g. javascript:).
        urlTransform={(url) => {
          if (/^(https?:|data:image\/|file:|mailto:|tel:)/i.test(url)) return url;
          // Relative or anchor links pass through unchanged.
          if (/^(#|\/|\.)/.test(url)) return url;
          // Unknown/again-unsafe scheme -> drop.
          if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '';
          return url;
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
