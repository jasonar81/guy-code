// Plain text + clickable URLs.
//
// Used for USER messages where we don't want full markdown rendering (the
// user may paste error messages, code snippets, paths, etc. that contain
// markdown-special characters but are meant to be displayed verbatim).
// We just detect bare http(s) URLs and turn them into anchors. Whitespace
// is preserved by the parent's `whitespace-pre-wrap`.
//
// For assistant output we use RichText (full GFM markdown).

import type { ReactNode } from 'react';

// Match http(s) URLs; trim common trailing punctuation that's almost always
// sentence/phrase punctuation rather than part of the URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT = /[.,;:!?\]]+$/;

interface Props {
  text: string;
  className?: string;
}

export function LinkifyText({ text, className }: Props): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    let url = m[0];
    let trailing = '';
    const tm = url.match(TRAILING_PUNCT);
    if (tm) {
      trailing = tm[0];
      url = url.slice(0, url.length - trailing.length);
    }
    // Drop a closing paren only if there's no matching opener inside the URL.
    const opens = (url.match(/\(/g) || []).length;
    const closes = (url.match(/\)/g) || []).length;
    if (closes > opens && url.endsWith(')')) {
      trailing = ')' + trailing;
      url = url.slice(0, -1);
    }
    parts.push(
      <a
        key={`${m.index}-${url}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:underline break-all"
      >
        {url}
      </a>
    );
    if (trailing) parts.push(trailing);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className={className}>{parts}</span>;
}
