# Changelog

## 0.1.0

- Extracted the rich Todo domain, tool, ANSI rendering, reminders and planning guard from omp-config into an independent OMP package.
- Preserved `todo` operations, snapshot/result protocol and title-based joins with native host edits and historical sessions.
- Preserved per-session list ownership and `task:*` tool restoration, including restricted child tool registries.
- Added a synchronous, read-only `omp-todo-more:read` wire projection for completion-review consumers without internal module imports.
- Unified tool mutations and latest-branch edit intents through one synchronous commit path, with explicit branch-acceptance and projection failure diagnostics.
- Added rich native tool cards and the session-bound `/todo-more` goal/explanation overlay using host Editor/FormField components, with visible keyboard action selection and current-list selection bounds.
- Added awaited, owner-CLI Tern stylesheet installation, preserving disabled state and rejecting linked-target conflicts without unlinking.
