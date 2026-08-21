# Extending cartograph

Cartograph is opinionated but not rigid. Most extensions are small: a new
slash command, a new hook handler, a new MCP tool, or a new content
layer. This doc walks through each, with concrete examples.

> If you're new to cartograph, read [`getting-started.md`](getting-started.md)
> first. That covers the user-shaped view. This doc covers the
> contributor-shaped view — what's where, how the pieces fit, how to
> add to them.

---

## Repo layout

```
cartograph/
├── scripts/                 ← all hooks, slash backings, the FastAPI server, MCP
│   ├── lib/                 ← sourceable helpers (load-config, notify-server)
│   ├── templates/           ← per-fork CLAUDE.md + git hooks, bedrock stubs
│   ├── serve.py             ← FastAPI on :47777 (71 endpoints, web UI backend)
│   ├── mcp_server.py        ← MCP stdio server (5 tools; user-scope = machine-wide)
│   ├── inject-context.sh    ← UserPromptSubmit hook (the orientation injection)
│   ├── doctor.sh            ← `just doctor` / `/doctor`
│   └── (~40 more)
├── web/                     ← Astro + React UI (built into web/dist/)
├── .claude/
│   ├── commands/            ← 27 slash command prompts
│   └── settings.json        ← hook registration (5 lifecycle events)
├── docs/                    ← framework docs (this file lives here)
├── design-system/           ← brand spec referenced by web/
├── extensions/cartograph/   ← VS Code / code-server extension (TypeScript)
├── tests/                   ← smoke tests (`just test`)
├── publish/                 ← personal-only: publish manifest, public-only files
├── guides/<repo>/           ← bedrock + topic notes (per tracked repo)
├── episodes/                ← per-session worknotes
├── research/<repo>/         ← external research per repo
├── workspace/<repo>/        ← tracked-repo checkouts (your forks)
└── cartograph.env           ← local identity config (gitignored)
```

---

## Adding a slash command

Slash commands are prompt files. The harness reads them when the user
types `/<name>` and feeds the body to the agent.

```bash
# 1. Create the prompt file.
cat > .claude/commands/myslash.md <<'EOF'
---
description: One-sentence description (shown in /help)
allowed-tools: Bash, Read, Edit
---

The user wants to do X.

Step 1: …

Step 2: …
EOF

# 2. (Optional) Add a backing script for heavy lifting.
cat > scripts/myslash.sh <<'EOF'
#!/usr/bin/env bash
# scripts/myslash.sh — backing for the /myslash command.
set -uo pipefail
source "$(dirname "$0")/lib/load-config.sh"

# … your logic …
EOF
chmod +x scripts/myslash.sh

# 3. Test it.
just test    # smoke tests pick up the new script's syntax
```

**Conventions:**

- The `description:` frontmatter is what `/help` and the orientation
  injection surface — write it well.
- `allowed-tools:` restricts what the slash command can do. Read-only
  surfaces (orientation, search) need only `Bash, Read, Grep, Glob`.
  Authoring surfaces add `Edit, Write`.
- `$ARGUMENTS` is the user's input. `$CLAUDE_PROJECT_DIR` is the
  cartograph root (set by Claude Code automatically).
- Use `${CARTOGRAPH_ROOT:-$CLAUDE_PROJECT_DIR}/scripts/<script>.sh`
  when invoking backing scripts so the command works regardless of cwd.
- Backing scripts go in `scripts/`; source `lib/load-config.sh` if
  they need identity config; source `lib/notify-server.sh` if they
  need to talk to the FastAPI server (graceful degradation built in).

---

## Adding a hook handler

Cartograph wires into Claude Code's hook system via
`.claude/settings.json`. Five lifecycle events are available:

| Event | Fires when | Typical uses |
|---|---|---|
| `SessionStart` | New session opens | Cheap per-session state only; heavy refresh lives in the serve daemon |
| `UserPromptSubmit` | Every user prompt | Inject context (the orientation hook) |
| `PreToolUse` | Before any tool call | Augment context for `Read`/`Edit` of specific files |
| `PostToolUse` | After any tool call | Capture what changed; normalize/lint |
| `Stop` | Session ends | Discipline scorecard + reminders, audit chassis usage |

To add a handler:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash $CLAUDE_PROJECT_DIR/scripts/my-post-edit.sh"
          }
        ]
      }
    ]
  }
}
```

Then write the handler:

```bash
#!/usr/bin/env bash
# scripts/my-post-edit.sh — PostToolUse hook.
#
# Reads the tool-use payload from stdin (JSON), does something with it,
# exits 0. Never block the session — log issues, don't error out.

set -uo pipefail
payload="$(cat 2>/dev/null || echo '{}')"

# Pull the file path out of the payload.
file_path="$(echo "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[[ -z "$file_path" ]] && exit 0

# … your logic …

exit 0
```

**Important:**

- Hooks run in the order they're registered. Earlier hooks in an event
  get the unmodified payload; later ones may see modifications.
- A hook that returns non-zero will BLOCK the tool call. Most cartograph
  hooks exit 0 unconditionally and write warnings to stderr instead.
- The `PostToolUse:Write|Edit|NotebookEdit` filter is implicit when you
  use those tool names — see `inject-context.sh` for how to scope by
  event subtype.
- Read the payload from stdin via `jq`; never parse JSON by hand.

**For reference, the existing handlers:**

| Script | Event | What it does |
|---|---|---|
| `session-log.sh` | SessionStart, PostToolUse, Stop | Append-only session worknote |
| `upstream-sync.sh` | serve daemon (6h loop) | Fetch upstream, write drift reports |
| `digest.sh` | serve daemon (content watch) | Precompute /promote candidates for the SessionStart cache |
| `build-file-index.py` | serve daemon (content watch) | Rebuild reverse file index |
| `build-search-index.py` | serve daemon (content watch) | Rebuild BM25 search index |
| `anchor-coverage.py` | serve daemon (daily pass) | Audit topic-note citation density |
| `diary.sh` | serve daemon (daily pass) | Daily auto-committed digest |
| `inject-context.sh` | UserPromptSubmit | The orientation injection (this is the one to read first) |
| `pre-read-augment.sh` | PreToolUse:Read | Inject notes citing the file being Read |
| `pre-edit-augment.sh` | PreToolUse:Edit | Same, for files about to be Edited |
| `token-check.sh` | PostToolUse:Edit/Write | Soft-warn on forbidden tokens |
| `post-edit-topic-mark.sh` | PostToolUse:Edit/Write | Mark topics for re-review when cited files change |
| `normalize-note-frontmatter.sh` | PostToolUse:Edit/Write | Backfill missing review-queue fields |
| `session-stop.sh` | Stop | Dispatcher: episode reminder, usage audit, note-usage attribution, session-log stop |
| `distill-signal.sh` | PostToolUse:Edit/Write | Binding distillation contract when an episode's tag crosses threshold |
| `post-edit.sh` | PostToolUse:Edit/Write | Dispatcher for the five rows above it |
| `usage-audit.sh` | Stop | Chassis-utilization audit appended to session log |

---

## Adding an MCP tool

The cartograph MCP server (`scripts/mcp_server.py`) exposes augmenting
tools the agent can call mid-conversation. To add one:

```python
# scripts/mcp_server.py

@mcp.tool()
def cartograph_my_tool(query: str, repo: str | None = None) -> dict[str, Any]:
    """**Call this when …** [doc the model will see].

    Use whenever:
      - <trigger condition 1>
      - <trigger condition 2>

    Returns ``{...}``.
    """
    # … your logic — read indexes from .cartograph/index/ if you can ...
    return {"hits": [...], "generated_at": ...}
```

**Design rules** (`claude-designs/cartograph/mcp-surface/` is the source):

- **Augment, don't wrap.** Don't make a tool that just runs `Grep`. The
  three existing tools (search, notes_for_file, drift) exist because
  they provide something `Grep`/`Read`/`Glob` can't.
- **Writes go through one schema-correct door.** `cartograph_capture`
  is the only mutation: full frontmatter, review-queue entry,
  provenance, index rebuild. Everything else stays read-only; in-repo
  authoring still uses the slash commands.
- **The docstring is the model's prompt.** It will read the docstring
  to decide whether to call the tool. Write it like a prompt — lead
  with `**Call this when …**`, list trigger conditions explicitly,
  show the return shape.
- **Lazy-import heavy deps.** The server cold-starts on every Claude
  Code session; expensive imports go inside the function body.

To wire it in:

```jsonc
// .mcp.json  (in cartograph root)
{
  "mcpServers": {
    "cartograph": {
      "command": "python3",
      "args": ["${HOME}/cartograph/scripts/mcp_server.py"]
    }
  }
}
```

Restart Claude Code; the new tool is available.

---

## Adding a content layer

Cartograph has five built-in layers (bedrock, topics, episodes,
research, seams). To add a sixth:

1. **Pick a directory.** Conventionally `<layer>/<repo>/<slug>.md` or
   `<layer>/<YYYY-MM>/<slug>.md` depending on whether it's repo-scoped
   or session-scoped.
2. **Define frontmatter.** Every layer's frontmatter includes:
   - `layer: <name>`
   - `repo: <repo>` (or null for cross-repo)
   - `date:` or `last_revised:`
   - `auto_drafted:`, `reviewed_by_human:`, `rejected:` — load-bearing
     for the review queue
3. **Update `inject-context.sh`** to include your layer in the
   orientation injection. The existing pattern: read all files under
   `<layer>/<repo>/`, score by keyword overlap with the prompt, inject
   top-3.
4. **Update `scripts/build-search-index.py`** so BM25 retrieval covers
   your layer. The `LAYERS` dict is the registration point.
5. **Update `scripts/build-file-index.py`** so the reverse index
   includes citations from your layer.
6. **Update `scripts/normalize-note-frontmatter.sh`** if your layer
   has unique frontmatter fields that need defaults.
7. **(Optional) Add a slash command** for authoring.
8. **(Optional) Add a UI surface** under `web/src/pages/<layer>/`.

The bar for adding a new layer is HIGH. The five existing layers cover
~all of "what's worth remembering between sessions." Before adding,
ask: could this be a new *tag* or a new *frontmatter field* on an
existing layer instead?

---

## Local dev iteration

```bash
# Watch loops:
just dev           # Astro dev (4321) + FastAPI w/ reload (47777) + code-server (47780)

# Single layers:
just serve         # FastAPI only (uses pre-built web/dist/)
just build         # Rebuild static site (web/dist/)

# Tests:
just test          # smoke suite — runs in ~3s

# After changing scripts/:
# FastAPI auto-reloads when CARTOGRAPH_RELOAD=1 (default in `just dev`).
# After changing web/:
# `just build` (or trust the Astro dev server in `just dev`).
# After changing .claude/commands/ or .claude/settings.json:
# Restart Claude Code — hooks load at session start.
```

**Editing CLAUDE.md or the per-fork template.** The per-fork CLAUDE.md
template at `scripts/templates/CLAUDE.md` uses `__GITHUB_USER__` /
`__GIT_EMAIL__` / `__SSH_HOST_ALIAS__` placeholders that
`fork-setup.sh` substitutes at install time. Same for the
`commit-msg` / `pre-push` hook templates. Don't hardcode identity in
templates — use placeholders, let `fork-setup.sh` render them per
operator's `cartograph.env`.

**Adding a forbidden token.** If you discover a string that should
never appear in published content, add it to your own
`CARTOGRAPH_FORBIDDEN_EXTRAS`. The framework defaults (`cartograph`,
`anthropic`, `claude code/opus/sonnet/haiku`) are baked into
`scripts/lint-content.sh`, `scripts/token-check.sh`,
and `scripts/templates/hooks/{commit-msg,pre-push}`. Changing the
defaults requires a PR.

---

## Conventions

- **Bash scripts:** `set -uo pipefail`, source `lib/load-config.sh`
  for config, source `lib/notify-server.sh` for HTTP calls to
  `:47777`. Bash 3.2 compat (no associative arrays, no `mapfile`).
- **Python:** 3.11+. Use stdlib where possible (no new deps without
  good reason). Server endpoints in `scripts/serve.py`; long-form
  logic in their own module.
- **No commits from the chassis without an obvious "why."** Auto-commit
  messages are conventional commits (`content(episode): …`,
  `chore(bedrock): …`).
- **Tests are smoke-tests by default.** A 3-second `just test` that
  catches the top 80% of breakage is more valuable than a 5-minute
  suite that runs occasionally.

---

## Where to ask

- File path / hook ordering / slash patterns: read `inject-context.sh`
  and `episode-prompt.sh` — they're the reference implementations.
- The chassis design rationale lives in personal designs notes (not
  shipped publicly). PR with a question and the maintainer will
  point at the relevant background.
- Edge cases around `cartograph.env` precedence: see
  `scripts/lib/load-config.sh` — the source of truth.
