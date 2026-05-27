---
layer: bedrock
repo: REPO_NAME
last_revised: TODAY_DATE
---

# REPO_NAME — architecture map

> Bedrock guide. Directory map: where things live. Stable over months.
> Upstream: UPSTREAM

## Top-level layout

```
REPO_NAME/
├── (fill in top-level dirs with one-line descriptions)
└── ...
```

## Where to find things

| Concept | Lives in | Canonical file(s) |
|---|---|---|
| (subsystem) | `path/to/dir/` | `file.py` |

## Build artifacts and generated trees (ignore these)

- (e.g., `bazel-out/`, `_generated/`, etc.)

## Files Claude should rarely need to read

(Things that exist for build/CI/legacy reasons and almost never matter for navigation.)
