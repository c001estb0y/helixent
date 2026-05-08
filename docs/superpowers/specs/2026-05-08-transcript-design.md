# Transcript: Session Persistence & Resume

**Date:** 2026-05-08
**Status:** Draft
**Approach:** Middleware-based (方案A)

---

## Goal

Record all conversation messages to disk (JSONL) and support resuming a previous session via `--resume`.

## Storage

```
~/.helixent/projects/<sanitized-cwd>/<session-id>.jsonl
```

- `sanitized-cwd`: path with `/\:` replaced by `-`
- `session-id`: UUID v4, generated at startup
- File permission: `0o600`

### JSONL entry format

```jsonl
{"type":"user","timestamp":"...","message":{...}}
{"type":"assistant","timestamp":"...","message":{...}}
{"type":"tool","timestamp":"...","message":{...}}
```

No UUID chain, no branching (v1).

## Implementation

### New files

```
src/agent/transcript/
├── transcript-middleware.ts
├── transcript-storage.ts
└── index.ts
```

### Middleware hooks

| Hook | Action |
|------|--------|
| `beforeAgentRun` | Generate sessionId, create file, write existing messages |
| `afterAgentStep` | Append new messages (incremental via lastWrittenIndex) |

### Resume

CLI adds `--resume [sessionId]`:
- No arg → resume latest session for current project
- With ID → resume specific session

Resume reads JSONL → injects as `messages` param to `createCodingAgent`. No Agent core changes needed.

### Modified files

| File | Change |
|------|--------|
| `src/agent/transcript/` (3 files) | New |
| `src/coding/agents/lead-agent.ts` | Register middleware (+3 lines) |
| `src/cli/index.ts` | Add --resume option (+15 lines) |
| `src/cli/tui/app.tsx` | Pass resume messages (+5 lines) |

**Total:** ~150 lines new + ~25 lines modified

## Out of scope (v1)

- UUID chain / parentUuid
- Session branching
- Session compaction
- sessions.json index
- Session list UI
- Auto-cleanup of old sessions

## Key decisions

1. **Sync write** (`appendFileSync`) — no data loss on exit
2. **Incremental** — only write new messages per step
3. **Middleware-only** — zero changes to Agent core
4. **File permission 0o600** — conversations may contain secrets
