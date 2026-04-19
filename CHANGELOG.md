# WhiteOwl v1.0.1

Patch release focused on stability, cleaner chat input behavior, quieter background systems, and a simpler GMGN/Twitter setup flow.

## Highlights

### Chat and skill input fixes
- Replaced the old chat textarea with a richer inline editor that supports embedded `#skill` mentions.
- Fixed caret preservation so Backspace and Delete remove inline skill tokens in the expected direction.
- Stopped unnecessary input rerenders that were causing selection drift while typing.
- Switched the skill browser expansion flow to a popup so the grid stays compact and easier to scan.

### GMGN and Twitter panel cleanup
- Reworked the GMGN connect card into a cleaner, more compact setup flow.
- Replaced the separate Chrome CDP connect step with a simple inline Settings prompt when CDP is not ready.
- Kept manual WebSocket paste as a secondary path without letting it crowd the main flow.
- Stopped the fallback GMGN WebSocket loop from retrying forever after a rejected 403 response.

### Browser and Axiom reliability
- Expanded CDP auto-detection to Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, and Chromium.
- Added dynamic port probing so remote debugging works even when the browser does not use the default port.
- Reduced forced tab creation during Axiom session checks and cookie capture.
- Moved multiple Axiom data paths to direct API-backed flows for faster, quieter lookups.

### Backend quality fixes
- Added stronger guards so one-time prompts do not accidentally spawn background jobs.
- Cleaned up LLM failover errors so users see a readable local-model message instead of raw provider noise.
- Removed extra internal error detail from daily report fallback logging.
- Filtered weak token feed entries and enriched sparse token profiles with DexScreener fallback data.

### Release housekeeping
- Aligned package metadata to `v1.0.1`.
- Removed remaining Cyrillic from release-bound code paths.
- Removed comment residue and comment-like placeholders found during the release audit.

## Updated files

- `public/index.html`
- `src/api/server.ts`
- `src/core/agent-runner.ts`
- `src/core/browser.ts`
- `src/core/decision-engine.ts`
- `src/llm/index.ts`
- `src/skills/background-jobs.ts`
- `src/skills/web-intel.ts`

## Release note body

WhiteOwl `v1.0.1` is a small patch release focused on bug fixes, cleaner setup flows, quieter logs, and more stable chat behavior. The update improves inline skill mentions, simplifies the GMGN Twitter connect flow, hardens browser and Axiom detection paths, and removes several sources of avoidable background noise.
