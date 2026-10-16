# Changelog

## Unreleased

- Wire the stop-reminder decider gate: `shouldSendStopReminder` was exported and imported but never called, so every stop reminder spent a turn ungated. It now runs behind `gatedCompletion` at `session_stop`, the cut-off timer and the subagent `agent_end`, after the free deterministic guards; the cut-off timer rechecks idle after the judge, which takes seconds.

- Add edit-style single-document Todo initialization and batch editing, with readonly streaming previews and one final commit.
- Preserve explicit minute estimates, active clocks and deadline warnings in batches; return ordered accepted changes for history consumers.

- Require a model-provided positive integer `estimatedMinutes` for every new Todo item, reject fractions without rounding, and add `estimate` to supply or revise budgets without erasing elapsed work.
- Persist active wall-clock intervals through status changes, native edits and session reloads; explicitly mark historical/native items as unestimated.
- Schedule overtime injection with a single nearest-deadline timeout re-armed by relevant journal writes and session/branch changes, without periodic polling or end-hook deadline checks. Each budget gets one warning preserving outcome and quality, asking agents to investigate, reconsider their approach, continue and consult subagents or their parent; idle delivery does not start a turn.
- Show estimates in ANSI/native tool cards and the Todo overlay, and update eager/planning guidance to require estimates.

## 0.1.0

- Extracted the rich Todo domain, tool, ANSI rendering, reminders and planning guard from omp-config into an independent OMP package.
- Preserved `todo` operations, snapshot/result protocol and title-based joins with native host edits and historical sessions.
- Preserved per-session list ownership and `task:*` tool restoration, including restricted child tool registries.
- Added a synchronous, read-only `omp-todo-more:read` wire projection for completion-review consumers without internal module imports.
- Unified tool mutations and latest-branch edit intents through one synchronous commit path, with explicit branch-acceptance and projection failure diagnostics.
- Added rich native tool cards and the session-bound `/todo-more` goal/explanation overlay using host Editor/FormField components, with visible keyboard action selection and current-list selection bounds.
- Added awaited, owner-CLI Tern stylesheet installation, preserving disabled state and rejecting linked-target conflicts without unlinking.
