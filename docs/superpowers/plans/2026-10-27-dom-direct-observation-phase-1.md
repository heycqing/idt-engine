# DOM Direct Observation Phase 1 Implementation Plan

**Goal:** Replace probe's primary ARIA-string observation with direct DOM observation while retaining ARIA as the failure fallback.

**Architecture:** A self-contained browser script collects validated element facts; Node-side parsing redacts text, and CSS-keyed differencing feeds tagged semantic or selector candidates into probe. Existing role/name IR emission remains byte-identical, while a strict selector variant is added alongside it.

**Constraints:** Do not run git commands, modify `D:\jz-font-end`, add runtime dependencies, weaken evidence gates, or implement `__idt_hit`.

## Tasks

- [ ] Add failing unit tests for parsing/redaction, observed differencing, strict IR variants, selector emission, replay observation, and probe priority/fallback behavior.
- [ ] Add failing real-Chromium coverage for direct text, unique bounded CSS paths, visibility, unstable-class filtering, ambiguity rejection, and image alt collection.
- [ ] Implement `secret-redaction.ts` and `dom-observe.ts`, then make the focused tests pass.
- [ ] Extend replay and DOM differencing, preserving the ARIA fallback unchanged.
- [ ] Extend the IR schema and emitter without changing role/name output bytes.
- [ ] Wire probe to DOM-first tagged candidates, route-first evidence, ARIA fallback, and candidate channel/kind output.
- [ ] Add `test:browser`, run focused tests, then run `pnpm test:idt`, `pnpm test:browser`, `pnpm exec tsc --noEmit`, and verify both golden MD5 values.
