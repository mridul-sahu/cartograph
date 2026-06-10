// MarkdownView — client-side markdown renderer for islands that receive
// raw note markdown at runtime (drift callouts, review panels). Build-side
// pages keep using ~/lib/markdown.ts (Code Hike highlighting); this is the
// lightweight client equivalent: `marked` only, code blocks as plain
// <pre><code>, clickable links, and YAML frontmatter stripped from the body
// and surfaced as a metadata chip row.

import { useMemo } from 'react';
import { Marked } from 'marked';

// Local instance — ~/lib/markdown.ts mutates the shared `marked` singleton
// with a build-side renderer; an isolated instance avoids ever colliding.
const md = new Marked({ gfm: true, breaks: false });

interface MetaField {
  key: string;
  value: string;
}

// Pull scalar `key: value` pairs out of a leading frontmatter block.
// Nested / list lines (indented or starting with `-`) are skipped — chips
// only make sense for scalars like date, repo, layer, last_revised.
function splitFrontmatter(markdown: string): { meta: MetaField[]; body: string } {
  const m = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { meta: [], body: markdown };
  const meta: MetaField[] = [];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].replace(/^["']|["']$/g, '').trim();
    if (!value || value === '~' || value === 'null' || value === '[]') continue;
    meta.push({ key: kv[1], value });
  }
  return { meta, body: markdown.slice(m[0].length) };
}

interface Props {
  markdown: string;
  /** Render frontmatter as a chip row above the body (default true). */
  showFrontmatter?: boolean;
  className?: string;
}

export default function MarkdownView({ markdown, showFrontmatter = true, className = '' }: Props) {
  const { meta, body } = useMemo(() => splitFrontmatter(markdown ?? ''), [markdown]);
  const html = useMemo(() => md.parse(body, { async: false }) as string, [body]);

  return (
    <div className={className}>
      {showFrontmatter && meta.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {meta.map((f) => (
            <span key={f.key} className="chip chip-sm">
              <span className="text-muted">{f.key}:</span> {f.value}
            </span>
          ))}
        </div>
      )}
      <div
        className="prose-cartograph text-sm"
        // Local trusted notes — same trust model as the build-side renderer.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
