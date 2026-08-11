// Build-time markdown loader. We read straight from cartograph/guides and
// cartograph/learn instead of going through Astro content collections — the
// content lives outside web/ and the constraints forbid moving it. Loaders
// here run only inside getStaticPaths / Astro frontmatter, never client-side.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import matter from 'gray-matter';
import { REPOS } from './repos';

const PROJECT_ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', '..', '..');
const GUIDES = join(PROJECT_ROOT, 'guides');
const LEARN = join(PROJECT_ROOT, 'learn');
const RESEARCH = join(PROJECT_ROOT, 'research');
const PAPERS = join(PROJECT_ROOT, 'papers');
const RESEARCH_PAPERS = join(PROJECT_ROOT, 'research_papers');
const SETUPS = join(PROJECT_ROOT, 'setups');
const DESIGNS = join(PROJECT_ROOT, 'designs');
const PROPOSALS = join(PROJECT_ROOT, 'proposals');
const DRIFT = join(PROJECT_ROOT, '.drift-reports');

export interface MarkdownDoc {
  slug: string;
  path: string;
  data: Record<string, unknown>;
  body: string;
  wordCount: number;
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

function loadFile(path: string): MarkdownDoc | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = matter(raw);
    const body = parsed.content;
    return {
      slug: basename(path, '.md'),
      path,
      data: parsed.data as Record<string, unknown>,
      body,
      wordCount: body.split(/\s+/).filter(Boolean).length,
    };
  } catch {
    return null;
  }
}

export function loadBedrock(repo: string): {
  overview: MarkdownDoc | null;
  architecture: MarkdownDoc | null;
  conventions: MarkdownDoc | null;
} {
  const repoDir = join(GUIDES, repo);
  return {
    overview: loadFile(join(repoDir, 'overview.md')),
    architecture: loadFile(join(repoDir, 'architecture.md')),
    conventions: loadFile(join(repoDir, 'conventions.md')),
  };
}

export function loadTopics(repo: string): MarkdownDoc[] {
  const dir = join(GUIDES, repo, 'topics');
  return listMarkdown(dir)
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function loadTopic(repo: string, topic: string): MarkdownDoc | null {
  return loadFile(join(GUIDES, repo, 'topics', `${topic}.md`));
}

export function loadSeams(): MarkdownDoc | null {
  return loadFile(join(GUIDES, 'seams.md'));
}

export function loadRampUp(repo: string): MarkdownDoc | null {
  return loadFile(join(LEARN, 'ramp-up', `${repo}.md`));
}

// The cross-cutting `learn/ramp-up/README.md` — rendered as the preamble of
// the `/ramp-up` index. Returned through the same `MarkdownDoc` shape so the
// renderer doesn't need a special case.
export function loadRampUpIndex(): MarkdownDoc | null {
  return loadFile(join(LEARN, 'ramp-up', 'README.md'));
}

export function loadAllRampUps(): MarkdownDoc[] {
  return listMarkdown(join(LEARN, 'ramp-up'))
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null);
}

export function loadAllWalkthroughs(): MarkdownDoc[] {
  return listMarkdown(join(LEARN, 'walkthroughs'))
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null);
}

export function loadWalkthroughsForRepo(repo: string): MarkdownDoc[] {
  return loadAllWalkthroughs().filter((d) => d.data.repo === repo);
}

export function loadAllDrafts(): MarkdownDoc[] {
  return listMarkdown(join(LEARN, 'drafts'))
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null);
}

export interface PaperDoc extends MarkdownDoc {
  repo: string;
  hasPdf: boolean;
}

function loadPaperDir(repo: string, dir: string): PaperDoc | null {
  const notes = join(dir, 'notes.md');
  if (!existsSync(notes)) return null;
  const doc = loadFile(notes);
  if (!doc) return null;
  const pdfRel = typeof doc.data.pdf === 'string' ? doc.data.pdf : 'paper.pdf';
  const pdfPath = join(dir, pdfRel);
  return {
    ...doc,
    slug: basename(dir),
    repo,
    hasPdf: existsSync(pdfPath),
  };
}

export function loadPapers(repo: string): PaperDoc[] {
  const repoDir = join(PAPERS, repo);
  if (!existsSync(repoDir)) return [];
  const out: PaperDoc[] = [];
  for (const entry of readdirSync(repoDir)) {
    const dir = join(repoDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const paper = loadPaperDir(repo, dir);
    if (paper) out.push(paper);
  }
  return out.sort((a, b) =>
    String(b.data.last_revised ?? '').localeCompare(
      String(a.data.last_revised ?? ''),
    ),
  );
}

export function loadPaper(repo: string, slug: string): PaperDoc | null {
  const dir = join(PAPERS, repo, slug);
  if (!existsSync(dir)) return null;
  return loadPaperDir(repo, dir);
}

// ── research_papers — repo-agnostic captured paper notes
// (research_papers/<slug>/notes.md). Flat, not repo-scoped: a single paper
// can touch many repos via its code_refs.

export interface ResearchPaperDoc extends MarkdownDoc {
  hasPdf: boolean;
}

function loadResearchPaperDir(dir: string): ResearchPaperDoc | null {
  const notes = join(dir, 'notes.md');
  if (!existsSync(notes)) return null;
  const doc = loadFile(notes);
  if (!doc) return null;
  const pdfRel = typeof doc.data.pdf === 'string' ? doc.data.pdf : 'paper.pdf';
  return { ...doc, slug: basename(dir), hasPdf: existsSync(join(dir, pdfRel)) };
}

export function loadAllResearchPapers(): ResearchPaperDoc[] {
  if (!existsSync(RESEARCH_PAPERS)) return [];
  const out: ResearchPaperDoc[] = [];
  for (const entry of readdirSync(RESEARCH_PAPERS)) {
    const dir = join(RESEARCH_PAPERS, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const p = loadResearchPaperDir(dir);
    if (p) out.push(p);
  }
  return out.sort((a, b) =>
    String(b.data.last_revised ?? b.data.date ?? '').localeCompare(
      String(a.data.last_revised ?? a.data.date ?? ''),
    ),
  );
}

export function loadResearchPaper(slug: string): ResearchPaperDoc | null {
  const dir = join(RESEARCH_PAPERS, slug);
  if (!existsSync(dir)) return null;
  return loadResearchPaperDir(dir);
}

// ── setups — runnable harnesses per repo (setups/<repo>/) ────────────────

export interface SetupFile {
  name: string; // run-multi-host.sh
  content: string; // raw file content
  lang: string; // bash | dockerfile | python | yaml | json | toml | text
}

export interface SetupDoc {
  repo: string;
  dir: string; // absolute path — for the "open in VS Code" link
  readme: MarkdownDoc | null;
  files: SetupFile[]; // every non-README file in the dir
}

function setupLang(name: string): string {
  if (name.endsWith('.sh') || name.endsWith('.bash')) return 'bash';
  if (name === 'Dockerfile' || name.startsWith('Dockerfile')) return 'dockerfile';
  if (name.endsWith('.py')) return 'python';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.toml')) return 'toml';
  return 'text';
}

export function loadSetup(repo: string): SetupDoc | null {
  const dir = join(SETUPS, repo);
  if (!existsSync(dir)) return null;
  const readmePath = join(dir, 'README.md');
  const readme = existsSync(readmePath) ? loadFile(readmePath) : null;
  const files: SetupFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    // Skip the README (rendered separately), dotfiles, and the
    // .code-workspace (IDE config, not part of the harness).
    if (
      name === 'README.md' ||
      name.startsWith('.') ||
      name.endsWith('.code-workspace')
    ) {
      continue;
    }
    const fp = join(dir, name);
    try {
      if (!statSync(fp).isFile()) continue;
    } catch {
      continue;
    }
    files.push({ name, content: readFileSync(fp, 'utf8'), lang: setupLang(name) });
  }
  if (!readme && files.length === 0) return null;
  return { repo, dir, readme, files };
}

export function loadAllSetups(): SetupDoc[] {
  if (!existsSync(SETUPS)) return [];
  const out: SetupDoc[] = [];
  for (const entry of readdirSync(SETUPS).sort()) {
    try {
      if (!statSync(join(SETUPS, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    const s = loadSetup(entry);
    if (s) out.push(s);
  }
  return out;
}

// ── designs — per-repo design docs (designs/<repo>/<slug>/) ──────────────
//
// Each design folder ships a README.md (overview + rebuild instructions),
// a build script (build.mjs / build.sh / …) that emits a deliverable
// (design.docx / design.pdf / …), and whatever sources the build uses
// (diagrams/, output/, vendor data, …). The UI only surfaces the README
// and the deliverable — the rest is implementation detail for the design
// author and lives on disk where Claude can read it directly. The .docx
// itself is meant for Google Drive, not in-browser preview.

const DESIGN_DELIVERABLE_EXTS = new Set(['.docx', '.pdf', '.pptx', '.xlsx']);

export interface DesignDeliverable {
  name: string;        // design.docx
  size: number;
  ext: string;         // .docx
  url: string;         // /api/design-docx/<repo>/<slug>/<name>
}

export interface DesignDoc {
  repo: string;
  slug: string;
  dir: string;                       // absolute path — for the "open in IDE" link
  title: string;                     // README title or first H1, fallback slug
  readme: MarkdownDoc | null;        // README.md (with optional frontmatter)
  deliverables: DesignDeliverable[]; // design.docx etc — for the download button
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/`/g, '') : null;
}

export function loadDesign(repo: string, slug: string): DesignDoc | null {
  const dir = join(DESIGNS, repo, slug);
  if (!existsSync(dir)) return null;
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) return null;

  const readmePath = join(dir, 'README.md');
  const readme = existsSync(readmePath) ? loadFile(readmePath) : null;

  // Scan the top-level only for deliverables — diagrams/ and output/ stay
  // on disk for the build script's eyes; the UI shouldn't crawl them.
  const deliverables: DesignDeliverable[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.')) continue;
    const fp = join(dir, entry);
    let isFile = false;
    let size = 0;
    try {
      const st = statSync(fp);
      isFile = st.isFile();
      size = st.size;
    } catch { continue; }
    if (!isFile) continue;

    const dot = entry.lastIndexOf('.');
    const ext = dot > 0 ? entry.slice(dot).toLowerCase() : '';
    if (!DESIGN_DELIVERABLE_EXTS.has(ext)) continue;
    deliverables.push({
      name: entry,
      size,
      ext,
      url: `/api/design-docx/${repo}/${slug}/${entry}`,
    });
  }

  // Skip empty design folders — a node_modules-only checkout shouldn't surface.
  if (!readme && deliverables.length === 0) {
    return null;
  }

  const title =
    (readme && typeof readme.data.title === 'string' && readme.data.title) ||
    (readme && firstHeading(readme.body)) ||
    slug;

  return { repo, slug, dir, title, readme, deliverables };
}

export function loadDesignsForRepo(repo: string): DesignDoc[] {
  const repoDir = join(DESIGNS, repo);
  if (!existsSync(repoDir)) return [];
  const out: DesignDoc[] = [];
  for (const entry of readdirSync(repoDir).sort()) {
    if (entry.startsWith('.')) continue;
    const fp = join(repoDir, entry);
    try { if (!statSync(fp).isDirectory()) continue; } catch { continue; }
    const doc = loadDesign(repo, entry);
    if (doc) out.push(doc);
  }
  return out;
}

export function loadAllDesigns(): DesignDoc[] {
  if (!existsSync(DESIGNS)) return [];
  const out: DesignDoc[] = [];
  for (const repo of readdirSync(DESIGNS).sort()) {
    if (repo.startsWith('.')) continue;
    const fp = join(DESIGNS, repo);
    try { if (!statSync(fp).isDirectory()) continue; } catch { continue; }
    out.push(...loadDesignsForRepo(repo));
  }
  return out;
}

// An artifact a session produced — a cartograph content file the session
// created or revised. `url` is the rendered page; null if not routable.
export interface SessionArtifact {
  kind: string; // episode | research | paper | topic | bedrock | walkthrough | ramp-up | draft | seam
  path: string; // cartograph-relative path
  url: string | null;
}

export interface SessionDoc extends MarkdownDoc {
  scope: string;
  startedAt: string | null;
  endedAt: string | null;
  edits: number;
  episodeWritten: string | null;
  artifacts: SessionArtifact[];
}

// Map a cartograph-relative content path to its rendered page URL.
export function artifactUrl(path: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^episodes\/[^/]+\/([^/]+)\.md$/.exec(path))) return `/episodes/${m[1]}/`;
  if ((m = /^research\/([^/]+)\/([^/]+)\.md$/.exec(path))) return `/research/${m[1]}/${m[2]}/`;
  if ((m = /^proposals\/([^/]+)\/([^/]+)\.md$/.exec(path))) return `/proposals/${m[1]}/${m[2]}/`;
  if ((m = /^papers\/([^/]+)\/([^/]+)\/notes\.md$/.exec(path))) return `/papers/${m[1]}/${m[2]}/`;
  if ((m = /^research_papers\/([^/]+)\/notes\.md$/.exec(path))) return `/research-papers/${m[1]}/`;
  if ((m = /^guides\/([^/]+)\/topics\/([^/]+)\.md$/.exec(path))) return `/repo/${m[1]}/topics/${m[2]}/`;
  if ((m = /^guides\/([^/]+)\/(overview|architecture|conventions)\.md$/.exec(path)))
    return `/repo/${m[1]}/bedrock/${m[2]}/`;
  if (/^guides\/seams\.md$/.test(path)) return '/seams/';
  if ((m = /^learn\/walkthroughs\/([^/]+)\.md$/.exec(path))) return `/walkthroughs/${m[1]}/`;
  if ((m = /^learn\/ramp-up\/([^/]+)\.md$/.exec(path))) return `/ramp-up/${m[1]}/`;
  if ((m = /^learn\/drafts\/([^/]+)\.md$/.exec(path))) return `/drafts/${m[1]}/`;
  return null;
}

export function loadAllSessions(): SessionDoc[] {
  const dir = join(PROJECT_ROOT, 'sessions');
  if (!existsSync(dir)) return [];
  const out: SessionDoc[] = [];
  for (const month of readdirSync(dir)) {
    if (month.startsWith('.')) continue;
    const monthDir = join(dir, month);
    try {
      if (!statSync(monthDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(monthDir)) {
      if (!f.endsWith('.md')) continue;
      const doc = loadFile(join(monthDir, f));
      if (!doc) continue;
      const edits = (doc.body.match(/^- [0-9:]+ {2}(Edit|Write|NotebookEdit)/gm) ?? [])
        .length;
      // Parse the "## artifacts produced" section: lines "- <kind>: <path>".
      const artifacts: SessionArtifact[] = [];
      const artSection = /## artifacts produced\s*\n([\s\S]*?)(?:\n## |\s*$)/.exec(
        doc.body,
      );
      if (artSection) {
        for (const line of artSection[1].split('\n')) {
          const lm = /^- ([a-z-]+):\s*(.+\.md)\s*$/.exec(line.trim());
          if (lm) {
            artifacts.push({
              kind: lm[1],
              path: lm[2],
              url: artifactUrl(lm[2]),
            });
          }
        }
      }
      out.push({
        ...doc,
        scope: typeof doc.data.scope === 'string' ? doc.data.scope : 'cartograph',
        startedAt: typeof doc.data.started_at === 'string' ? doc.data.started_at : null,
        endedAt:
          typeof doc.data.ended_at === 'string' && doc.data.ended_at !== '~'
            ? doc.data.ended_at
            : null,
        edits,
        episodeWritten:
          typeof doc.data.episode_written === 'string' &&
          doc.data.episode_written !== '~'
            ? doc.data.episode_written
            : null,
        artifacts,
      });
    }
  }
  return out.sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  );
}

export function loadAllPapers(): PaperDoc[] {
  if (!existsSync(PAPERS)) return [];
  const out: PaperDoc[] = [];
  for (const repo of readdirSync(PAPERS)) {
    const repoDir = join(PAPERS, repo);
    try {
      if (!statSync(repoDir).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(...loadPapers(repo));
  }
  return out;
}

export function loadResearch(repo: string): MarkdownDoc[] {
  return listMarkdown(join(RESEARCH, repo))
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null)
    .sort((a, b) =>
      String(b.data.last_revised ?? '').localeCompare(
        String(a.data.last_revised ?? ''),
      ),
    );
}

export function loadResearchNote(repo: string, slug: string): MarkdownDoc | null {
  return loadFile(join(RESEARCH, repo, `${slug}.md`));
}

export function loadAllResearch(): MarkdownDoc[] {
  if (!existsSync(RESEARCH)) return [];
  const out: MarkdownDoc[] = [];
  for (const repo of readdirSync(RESEARCH)) {
    const repoDir = join(RESEARCH, repo);
    try {
      if (!statSync(repoDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(repoDir)) {
      if (!file.endsWith('.md')) continue;
      const doc = loadFile(join(repoDir, file));
      if (doc) {
        // Backfill the repo from the directory name if the frontmatter
        // doesn't carry it.
        if (!doc.data.repo) doc.data.repo = repo;
        out.push(doc);
      }
    }
  }
  return out.sort((a, b) =>
    String(b.data.last_revised ?? '').localeCompare(
      String(a.data.last_revised ?? ''),
    ),
  );
}

// ── proposals — ambitious, investment-cased build plans ──────────────────
//
// proposals/<repo|_new>/<slug>.md — the strategic layer above designs.
// `_new` is the pseudo-repo for proposals that warrant a brand-new repo.

export interface ProposalDoc extends MarkdownDoc {
  repo: string;          // real repo, or "_new"
  status: string;        // gap-analysis|deep-dive|final|discarded|proposal-docx|design-docx|implementing|superseded
  title: string;         // first H1, fallback slug
  pitch: string;         // first paragraph under the "## Pitch" heading
  hasDocx: boolean;      // a built proposal.docx sits next to the note
  parent: string | null; // slug of the umbrella proposal this is a sub-proposal of (same repo); null = top-level
}

// A node in the proposal tree: an uber/umbrella proposal can have sub-proposals
// (children) we might or might not do — each child's `status` says how committed
// we are (gap-analysis/deep-dive = candidate, final/implementing = building,
// discarded = won't). Built per-repo from the flat `parent:` edges.
export interface ProposalTreeNode {
  proposal: ProposalDoc;
  children: ProposalTreeNode[];
}

// Build the parent/child forest from a flat proposal list (one repo). A proposal
// with `parent: <slug>` nests under that slug; an absent/unknown/self parent →
// top-level root. Order within a level follows the input order (by last_revised).
export function buildProposalTree(items: ProposalDoc[]): ProposalTreeNode[] {
  const nodes = new Map<string, ProposalTreeNode>(
    items.map((p) => [p.slug, { proposal: p, children: [] as ProposalTreeNode[] }]),
  );
  const roots: ProposalTreeNode[] = [];
  for (const p of items) {
    const node = nodes.get(p.slug)!;
    const parent = p.parent && p.parent !== p.slug ? nodes.get(p.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// The actionable "## Next action" section, parsed for the UI: copyable slash
// commands (inline-code spans starting with `/`) and any URLs.
export interface NextAction {
  commands: string[];
  links: string[];
  text: string;
}

// Capture a "## <heading>" section body, up to the next "## " heading or EOF.
// We prefix a newline so a heading at the very start still matches, and avoid
// the `m`-flag `$` (which matches every line end) by anchoring on `\n##`.
function sectionBody(body: string, heading: string): string {
  const re = new RegExp(`\\n##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = re.exec('\n' + body);
  return m ? m[1] : '';
}

export function extractNextAction(body: string): NextAction | null {
  const section = sectionBody(body, 'Next action');
  if (!section) return null;
  // Collapse soft line-breaks inside the backtick span — a wrapped command must
  // copy as one clean line.
  const commands = Array.from(section.matchAll(/`(\/[^`]+)`/g)).map((x) => x[1].replace(/\s+/g, ' ').trim());
  const links = Array.from(section.matchAll(/https?:\/\/[^\s)`>"']+/g)).map((x) => x[0]);
  const text = section.trim();
  if (!commands.length && !links.length && !text) return null;
  return { commands, links, text };
}

function firstSection(body: string, heading: string): string {
  return sectionBody(body, heading)
    .split(/\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

function toProposalDoc(doc: MarkdownDoc, repo: string): ProposalDoc {
  return {
    ...doc,
    repo: typeof doc.data.repo === 'string' ? doc.data.repo : repo,
    status: typeof doc.data.status === 'string' ? doc.data.status : 'gap-analysis',
    title: firstHeading(doc.body) ?? doc.slug,
    pitch: firstSection(doc.body, 'Pitch'),
    hasDocx: existsSync(doc.path.replace(/\.md$/, '.docx')),
    parent: typeof doc.data.parent === 'string' && doc.data.parent.trim() ? doc.data.parent.trim() : null,
  };
}

// The proposal "repos" are the subdirectories of proposals/ (real repos + _new),
// excluding the top-level README.
export function loadProposalRepos(): string[] {
  if (!existsSync(PROPOSALS)) return [];
  return readdirSync(PROPOSALS)
    .filter((entry) => {
      if (entry.startsWith('.')) return false;
      try { return statSync(join(PROPOSALS, entry)).isDirectory(); } catch { return false; }
    })
    .sort();
}

export function loadProposals(repo: string): ProposalDoc[] {
  // README.md is the per-repo portfolio overview and *.final-draft.md are
  // docx-builder inputs — neither is a proposal note.
  return listMarkdown(join(PROPOSALS, repo))
    .filter((p) => basename(p) !== 'README.md' && !p.endsWith('.final-draft.md'))
    .map(loadFile)
    .filter((d): d is MarkdownDoc => d !== null)
    .map((d) => toProposalDoc(d, repo))
    .sort((a, b) =>
      String(b.data.last_revised ?? '').localeCompare(String(a.data.last_revised ?? '')),
    );
}

export function loadProposalNote(repo: string, slug: string): ProposalDoc | null {
  const doc = loadFile(join(PROPOSALS, repo, `${slug}.md`));
  return doc ? toProposalDoc(doc, repo) : null;
}

export function loadAllProposals(): ProposalDoc[] {
  return loadProposalRepos()
    .flatMap((repo) => loadProposals(repo))
    .sort((a, b) =>
      String(b.data.last_revised ?? '').localeCompare(String(a.data.last_revised ?? '')),
    );
}

export function loadDriftReport(repo: string): string | null {
  const path = join(DRIFT, `${repo}.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function countAll() {
  return {
    topics: [...REPOS]
      .map((r) => loadTopics(r).length)
      .reduce((a, b) => a + b, 0),
    walkthroughs: loadAllWalkthroughs().length,
    rampUps: loadAllRampUps().length,
    drafts: loadAllDrafts().length,
    episodes: countEpisodes(),
  };
}

function countEpisodes(): number {
  const dir = join(PROJECT_ROOT, 'episodes');
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const month of readdirSync(dir)) {
    const monthDir = join(dir, month);
    try {
      if (statSync(monthDir).isDirectory()) {
        n += readdirSync(monthDir).filter((f) => f.endsWith('.md')).length;
      }
    } catch { /* ignore */ }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface EpisodeDoc extends MarkdownDoc {
  month: string;            // YYYY-MM bucket name from the directory
  title: string;            // first H1 in the body, or slug as fallback
  excerpt: string;          // first two non-empty body lines (post-frontmatter)
  tags: string[];           // parsed from frontmatter `tags:` list/scalar
  repo: string | null;
}

function extractTitleAndExcerpt(body: string, fallback: string): { title: string; excerpt: string } {
  const stripped = body.replace(/^#\s+.+?\r?\n+/, '');
  const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].replace(/`/g, '') : fallback;
  const lines = stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---'));
  const excerpt = lines.slice(0, 2).join(' ');
  return { title, excerpt };
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((t) => String(t)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return [];
}

export interface EpisodeAggregates {
  total: number;
  autoDrafted: number;
  pendingReview: number;
  rejected: number;
  withTopic: number;
}

export function aggregateEpisodes(eps: EpisodeDoc[]): EpisodeAggregates {
  const out: EpisodeAggregates = {
    total: eps.length,
    autoDrafted: 0,
    pendingReview: 0,
    rejected: 0,
    withTopic: 0,
  };
  for (const e of eps) {
    if (e.data.auto_drafted === true) out.autoDrafted++;
    if (e.data.rejected === true) out.rejected++;
    const reviewed =
      typeof e.data.reviewed_by_human === 'string' &&
      e.data.reviewed_by_human.trim() &&
      e.data.reviewed_by_human !== '~';
    const distilled =
      typeof e.data.distilled_into === 'string' &&
      e.data.distilled_into.trim() &&
      e.data.distilled_into !== '~';
    if (distilled) out.withTopic++;
    if (!reviewed && !(e.data.rejected === true)) out.pendingReview++;
  }
  return out;
}

export function loadEpisodes(): EpisodeDoc[] {
  const dir = join(PROJECT_ROOT, 'episodes');
  if (!existsSync(dir)) return [];
  const out: EpisodeDoc[] = [];
  for (const month of readdirSync(dir)) {
    const monthDir = join(dir, month);
    try {
      if (!statSync(monthDir).isDirectory()) continue;
    } catch { continue; }
    for (const f of readdirSync(monthDir)) {
      if (!f.endsWith('.md')) continue;
      const doc = loadFile(join(monthDir, f));
      if (!doc) continue;
      const { title, excerpt } = extractTitleAndExcerpt(doc.body, doc.slug);
      out.push({
        ...doc,
        month,
        title,
        excerpt,
        tags: normalizeTags(doc.data.tags),
        repo: typeof doc.data.repo === 'string' ? doc.data.repo : null,
      });
    }
  }
  // Sort by date desc — fall back to slug if no date frontmatter.
  out.sort((a, b) => {
    const ad = String(a.data.date ?? a.slug);
    const bd = String(b.data.date ?? b.slug);
    return bd.localeCompare(ad);
  });
  return out;
}

// Promote candidates — mirror scripts/digest.sh: tags appearing on >= 3
// episodes whose `distilled_into` frontmatter is unset.
export interface PromoteCandidate {
  tag: string;
  count: number;
  repos: string[];
}

export function loadPromoteCandidates(threshold = 3): PromoteCandidate[] {
  const eps = loadEpisodes().filter((e) => {
    const d = e.data.distilled_into;
    return d == null || d === '' || d === '~';
  });
  const byTag = new Map<string, { count: number; repos: Set<string> }>();
  for (const e of eps) {
    for (const t of e.tags) {
      const slot = byTag.get(t) ?? { count: 0, repos: new Set() };
      slot.count += 1;
      if (e.repo) slot.repos.add(e.repo);
      byTag.set(t, slot);
    }
  }
  return Array.from(byTag.entries())
    .filter(([, v]) => v.count >= threshold)
    .map(([tag, v]) => ({ tag, count: v.count, repos: Array.from(v.repos).sort() }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Cross-repo citations
// ---------------------------------------------------------------------------

// A path string mentioned in a topic note that belongs to a *different* repo
// (e.g. a `tunix` topic that cites `jax/_src/...`). We grep the topic body for
// `<repo>/<...>` tokens and emit one row per (srcRepo, dstRepo, path) tuple.
export interface CrossRef {
  srcRepo: string;
  srcTopic: string;
  srcTopicSlug: string;
  dstRepo: string;
  path: string;
}

const KNOWN_REPOS = REPOS;

export function loadCrossRefs(): CrossRef[] {
  const refs: CrossRef[] = [];
  // Match `<repo>/<path>` where path looks like a real file/dir reference.
  // We keep matches conservative — must contain a `/` after the repo name, and
  // path must look like code (alnum, _, -, /, ., :, digits for line refs).
  const repoAlt = KNOWN_REPOS.join('|');
  const pathRe = new RegExp(`\\b(${repoAlt})/([a-zA-Z0-9_./:-]{2,}?)(?=[\\s)\`'",.;]|$)`, 'g');
  for (const repo of KNOWN_REPOS) {
    for (const topic of loadTopics(repo)) {
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = pathRe.exec(topic.body)) !== null) {
        const dstRepo = m[1];
        if (dstRepo === repo) continue; // self-citations don't count
        // Strip trailing line-number anchors (`:123`) for de-dup.
        const path = `${dstRepo}/${m[2]}`.replace(/:\d+(-\d+)?$/, '');
        const key = `${dstRepo}|${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({
          srcRepo: repo,
          srcTopic: topic.slug,
          srcTopicSlug: topic.slug,
          dstRepo,
          path,
        });
      }
    }
  }
  return refs;
}

export const paths = { PROJECT_ROOT, GUIDES, LEARN, DRIFT };
