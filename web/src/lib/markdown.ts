// Markdown -> HTML rendering. Code blocks go through Code Hike's `highlight()`
// (from `codehike/code`, backed by `@code-hike/lighter`) and are rendered via
// React's static markup so we get the same token output as Code Hike's MDX
// pipeline without forcing every walkthrough to be MDX. Mermaid blocks emit
// a `<pre data-mermaid>` placeholder the client island rehydrates. Everything
// else is plain markdown via `marked`.
//
// Why not the `remarkCodeHike` MDX plugin? It transforms code blocks into
// JSX nodes that only the MDX compiler can resolve. Our walkthroughs / ramp-
// ups / drafts are plain `.md` files routed through `marked`, so we drive
// Code Hike's highlighter directly and render the resulting tokens to a
// static HTML string here. When we promote a walkthrough to MDX (R3+), the
// remark plugin path becomes available — same tokens, plus annotations.
import { marked } from 'marked';
import { highlight, Pre } from 'codehike/code';
import type { HighlightedCode } from 'codehike/code';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Map common fence aliases to Code Hike / lighter language names.
// `txt` is lighter's no-grammar baseline — used as the canonical fallback for
// anything Code Hike doesn't ship a grammar for (mlir, custom IRs, plain text).
// The empty-string key handles fences with no language at all (``` ... ```).
const LANG_ALIASES: Record<string, string> = {
  '': 'txt',
  py: 'python',
  python3: 'python',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  json5: 'json',
  md: 'markdown',
  'c++': 'cpp',
  cxx: 'cpp',
  golang: 'go',
  rs: 'rust',
  htm: 'html',
  text: 'txt',
  plain: 'txt',
  plaintext: 'txt',
  txt: 'txt',
  mlir: 'txt',
  hlo: 'txt',
  stablehlo: 'txt',
  proto: 'txt',
  log: 'txt',
  d2: 'txt',
  mermaid: 'txt',
};

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Code Hike returns tokens that paint inline `style` attributes on every span.
// We render twice — once with `github-light`, once with `github-dark` — and
// stitch them together so theme switching is a CSS variable away.
export async function renderCodeBlock(code: string, lang: string): Promise<string> {
  const key = (lang ?? '').trim().toLowerCase();
  const normLang = LANG_ALIASES[key] ?? key ?? 'txt';
  const raw = { value: code, lang: normLang || 'txt', meta: '' };

  let lightHl: HighlightedCode;
  let darkHl: HighlightedCode;
  try {
    [lightHl, darkHl] = await Promise.all([
      highlight(raw, 'github-light'),
      highlight(raw, 'github-dark'),
    ]);
  } catch {
    // Unknown language → fall back to `txt` (lighter's no-grammar baseline)
    // so the build never breaks on an unexpected fence.
    const safe = { ...raw, lang: 'txt' };
    [lightHl, darkHl] = await Promise.all([
      highlight(safe, 'github-light'),
      highlight(safe, 'github-dark'),
    ]);
  }

  const lightHtml = renderToStaticMarkup(
    createElement(Pre, { code: lightHl, className: 'ch-pre ch-light' })
  );
  const darkHtml = renderToStaticMarkup(
    createElement(Pre, { code: darkHl, className: 'ch-pre ch-dark' })
  );

  return `<div class="ch-codeblock" data-lang="${normLang}">${lightHtml}${darkHtml}</div>\n`;
}

// Content-authored markdown links point at repo files (`guides/<r>/topics/x.md`,
// `./sibling.md`); the site serves routes. Map the known content shapes to
// their routes so cross-references work in the browser exactly as they do for
// a session reading the files. Unknown shapes pass through untouched.
export function rewriteContentHref(href: string): string {
  if (!href || /^(https?:|mailto:|data:|#|\/)/.test(href)) return href;
  if (!href.endsWith('.md')) return href;
  // Strip any ./ and ../ prefixes; content cross-refs are repo-relative in
  // spirit even when written relative to the note's own directory.
  const stripped = href.replace(/^(\.\.?\/)+/, '');
  let m = /^guides\/([^/]+)\/topics\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/repo/${m[1]}/topics/${m[2]}/`;
  m = /^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/.exec(stripped);
  if (m) return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if (stripped === 'guides/seams.md' || stripped === 'seams.md') return '/seams/';
  m = /^([a-z0-9_-]+)\/topics\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/repo/${m[1]}/topics/${m[2]}/`;
  m = /^episodes\/\d{4}-\d{2}\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/episodes/${m[1]}/`;
  m = /^research\/([^/]+)\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/research/${m[1]}/${m[2]}/`;
  m = /^papers\/([^/]+)\/([^/]+)\/notes\.md$/.exec(stripped);
  if (m) return `/papers/${m[1]}/${m[2]}/`;
  m = /^(?:learn\/)?walkthroughs\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/walkthroughs/${m[1]}/`;
  m = /^(?:learn\/)?ramp-up\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/ramp-up/${m[1]}/`;
  m = /^(?:learn\/)?drafts\/([^/]+)\.md$/.exec(stripped);
  if (m) return `/drafts/${m[1]}/`;
  // Bare same-directory sibling (`x.md`, `./x.md` after stripping): pages are
  // directory-index routes, so the sibling lives one level up.
  m = /^([^/]+)\.md$/.exec(stripped);
  if (m) return `../${m[1]}/`;
  return href;
}

export async function renderMarkdown(body: string): Promise<RenderResult> {
  const headings: Heading[] = [];
  const usedIds = new Set<string>();

  // marked's renderer doesn't support async per-token returns; we pre-extract
  // code blocks, render them async, then splice the resulting HTML back in.
  // Each placeholder is a unique sentinel that survives marked's HTML pass.
  type Slot = { token: string; html: string };
  const slots: Slot[] = [];
  let blockCounter = 0;

  const renderer = new marked.Renderer();

  renderer.link = function (this: InstanceType<typeof marked.Renderer>, { href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const target = rewriteContentHref(href || '');
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${target}"${titleAttr}>${text}</a>`;
  };

  renderer.heading = ({ tokens, depth }) => {
    const text = marked.parseInline(
      tokens.map((t) => ('raw' in t ? t.raw : '')).join(''),
      { async: false }
    ) as string;
    const plain = tokens
      .map((t) => ('text' in t ? (t.text as string) : 'raw' in t ? t.raw : ''))
      .join('');
    let id = slugify(plain);
    let suffix = 1;
    while (usedIds.has(id)) id = `${slugify(plain)}-${++suffix}`;
    usedIds.add(id);
    headings.push({ depth, text: plain, id });
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };

  renderer.code = ({ text, lang }) => {
    const language = (lang || '').trim().toLowerCase();
    if (language === 'mermaid') {
      const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre class="mermaid" data-mermaid>${esc}</pre>\n`;
    }
    const token = `__CH_BLOCK_${blockCounter++}__`;
    slots.push({ token, html: '' });
    // marked is synchronous so we emit a placeholder and resolve below.
    // The async work is queued into `slots`.
    slots[slots.length - 1].html = '';
    slots[slots.length - 1].token = token;
    // Stash the language + text on the slot via closure; we re-walk after.
    (slots[slots.length - 1] as Slot & { text: string; language: string }).text = text;
    (slots[slots.length - 1] as Slot & { text: string; language: string }).language = language;
    return token;
  };

  renderer.codespan = ({ text }) => {
    return `<code class="ch-inline">${text}</code>`;
  };

  marked.use({ renderer, gfm: true, breaks: false });
  let html = marked.parse(body, { async: false }) as string;

  // Render code blocks in parallel, then splice into the HTML.
  await Promise.all(
    slots.map(async (slot) => {
      const s = slot as Slot & { text: string; language: string };
      s.html = await renderCodeBlock(s.text, s.language);
    })
  );
  for (const slot of slots) {
    html = html.replace(slot.token, slot.html);
  }

  return { html, headings };
}
