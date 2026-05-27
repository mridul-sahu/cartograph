# Cartograph

Surfaces the Cartograph knowledge base inside the editor:

- **Gutter markers** on every line a bedrock / topic note / seam cites
- **Hover cards** with the note's discussion of the line
- **Status-bar banner** — how well-charted the open file is
- **Walkthrough tours** — step through a walkthrough; the editor jumps to
  each cited `file:line`, across repos
- **Ask Claude** (⌘⇧A) — explain a selection with the bedrock + topic
  notes as context
- **Cross-repo seams** navigation
- A **Cartograph** activity-bar panel with live insights for the active file

Talks to the Cartograph status server (default `http://localhost:47777`).
Activates only inside a tracked fork (`workspace/<repo>/`).

Local extension — not published. Built + installed by
`scripts/build-extension.sh`.
