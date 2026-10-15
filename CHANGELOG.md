# Changelog

## Unreleased

- Replaced Tern's native bottom Todo display with a compact Todo More progress card and a full, upward-opening popover, without modifying OMP or discarding its Todo projection.
- Unified native tool results, progress details and reminder snapshots around goal fields and the native checklist, preserving explanations alongside blockers and keeping real task counts.
- Routed Tern's `/todo` and `/todo edit` to the rich editor and `/todo expand` / `/todo collapse` to the replacement card, while retaining task-management subcommands and the ANSI HUD.
- Followed the host composer's live viewed-agent lineage for child/nested-session progress and edits; commits append through the target session's own manager rather than an extension-bound main-session writer.
- Shared the domain snapshot schema directly across persisted, tool-result and reminder boundaries so packaged extensions load on the managed OMP runtime without schema introspection.
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
