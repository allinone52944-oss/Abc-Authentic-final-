# BDRIS Engine Rewrite — Architecture Design
# Date: 2026-10-17
# Branch: engine-rewrite-permanent
# Status: DESIGN PHASE

## Current Problems (Root Causes)

### 1. Fragile State Sync
- Frontend (user browser) and engine browser try to stay in sync via `geoMirror`
- Two separate DOMs, two separate states — inevitable drift
- Race conditions when mirror and fetch run concurrently
- Fix attempts: sequential mirror→fetch, dedicated endpoint — still fragile

### 2. Session Management Complexity
- `sessionOwner` tracks socket.id + userId
- BUSY logic, ownership transfer, timeout handling — all intertwined
- Edge cases: abrupt disconnect, stale locks, multi-tab

### 3. Inconsistent Error Handling
- Some operations timeout silently
- Some leave UI in "loading" state forever
- No unified error recovery strategy

### 4. Mixed Concerns
- Browser automation mixed with business logic
- Socket.IO handlers mixed with Playwright code
- Hard to test, hard to reason about

## New Architecture Principles

### P1: Engine as Single Source of Truth
- Engine owns ALL browser state
- Frontend NEVER tries to mirror or sync
- Frontend sends commands, receives results
- Example: `GET_ADDRESS_OPTIONS` (already implemented) — frontend asks, engine answers

### P2: Command Pattern
Every operation is a command with:
- Unique ID (for deduplication)
- Clear inputs
- Guaranteed response (success or error, never hangs)
- Timeout with defined fallback

### P3: Explicit State Machine
Engine states:
- `IDLE` — no browser, ready to start
- `STARTING` — browser launching
- `READY` — browser on BDRIS form, ready for commands
- `BUSY` — executing a command
- `ERROR` — failed, needs recovery
- `STOPPING` — shutting down

Transitions are explicit and logged. No ambiguous states.

### P4: Session Isolation
- Each user session gets isolated browser context
- No shared state between users
- Session lifecycle: create → use → destroy
- Automatic cleanup on disconnect/timeout

### P5: Realtime by Design
- Progress events for long operations
- Heartbeat for connection health
- Immediate error propagation (no silent failures)

## Component Design

### 1. BrowserManager
- Owns Playwright browser instance
- Methods: `launch()`, `newContext()`, `close()`
- Handles crashes, restarts
- Health checks

### 2. SessionManager
- Tracks active sessions
- Methods: `create(userId)`, `get(sessionId)`, `destroy(sessionId)`
- Timeout handling
- Cleanup on disconnect

### 3. CommandExecutor
- Receives commands from Socket.IO
- Routes to appropriate handler
- Enforces timeouts
- Returns structured responses

### 4. BdrisNavigator
- Knows BDRIS site structure
- Methods: `gotoForm()`, `fillStep1()`, `fillStep2()`, etc.
- Selectors centralized, not scattered
- Handles site-specific quirks

### 5. AddressService
- Dedicated to address cascade
- Methods: `getOptions(level, parents, form)`
- Caches static data, fetches dynamic from site
- No frontend mirroring needed

## Data Flow

```
Frontend                    Engine
   |                           |
   |-- SUBMIT_S1 (command) -->|
   |                           |-- Validate
   |                           |-- Execute (BrowserManager)
   |<-- PROGRESS events -------|
   |<-- STEP_CHANGE_ACK -------|
   |                           |
```

## Error Handling Strategy

Every command:
1. Validates inputs → returns `INVALID_INPUT` if bad
2. Executes with timeout → returns `TIMEOUT` if exceeds
3. Catches exceptions → returns `ERROR` with message
4. Never hangs — guaranteed response within timeout

UI:
- Shows progress for long operations
- Shows clear error messages
- Offers retry for transient failures
- Never stuck on "loading"

## Testing Strategy

1. Unit tests for each component
2. Integration tests for command flows
3. Mock BDRIS site for deterministic tests
4. Load tests for concurrent sessions
5. Chaos tests (kill browser mid-operation, etc.)

## Migration Plan

1. Build new engine alongside old (separate files)
2. Test thoroughly with mock site
3. Test with real BDRIS (read-only operations)
4. When 100% sure: single push + deploy
5. Monitor for 24h before declaring success

## Success Criteria

- [ ] Zero "stuck on loading" incidents
- [ ] Zero session lock false positives
- [ ] Address cascade works 100% of time
- [ ] Clear error messages for all failures
- [ ] < 5s for common operations
- [ ] Handles 10 concurrent users
- [ ] Survives browser crashes gracefully
