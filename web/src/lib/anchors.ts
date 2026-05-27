// Post-process rendered markdown to make `path/to/file.ext:NNN` citation
// anchors clickable — open the file at that line in the embedded code-server
// (workspace mounted on :47780 by `scripts/serve-code-server.sh`).
//
// Closes L5 from the UI audit. Pure string rewrite — runs after marked +
// Code Hike, so syntax-highlighted code blocks (where the file path is
// split into highlighted spans) are intentionally left alone. We only
// linkify `path:NNN` in inline <code> elements outside of code blocks.

const CODE_EXTS = '(?:py|pyi|cc|cpp|h|hh|hpp|c|ts|tsx|js|go|rs|bzl|md)';
// Match an inline <code> whose text content is exactly `path:NNN`. We
// constrain to <code> elements that look unstyled (no class attribute)
// to avoid stomping shiki / Code Hike highlighted blocks.
// Code Hike emits `<code class="ch-inline">` for inline backtick code; raw
// marked output uses bare `<code>`. Match both, preserve any classes on the
// rewritten tag so styling stays consistent.
const ANCHOR_RE = new RegExp(
  `<code(\\s+class="[^"]*")?>([a-zA-Z0-9_./-]+\\.${CODE_EXTS}):(\\d+)</code>`,
  'g',
);

const CODE_SERVER = 'http://127.0.0.1:47780';
const WORKSPACE_ROOT = '<cartograph-root>/workspace';

/**
 * Build the code-server URL that opens a file at a specific line. Uses
 * the `payload=[["gotoLine","<file>:<line>"]]` query parameter that
 * code-server forwards to the IDE on load.
 */
function codeServerHref(repo: string, file: string, line: string): string {
  const folder = `${WORKSPACE_ROOT}/${repo}`;
  const payload = encodeURIComponent(JSON.stringify([['gotoLine', `${file}:${line}`]]));
  return `${CODE_SERVER}/?folder=${encodeURIComponent(folder)}&payload=${payload}`;
}

export function linkifyCodeAnchors(html: string, repo: string): string {
  return html.replace(ANCHOR_RE, (_match, classAttr, file, line) => {
    const href = codeServerHref(repo, file, line);
    const cls = classAttr ?? '';
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="anchor-link"><code${cls}>${file}:${line}</code></a>`;
  });
}
