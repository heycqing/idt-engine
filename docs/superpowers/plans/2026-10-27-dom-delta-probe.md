# DOM Delta Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-probed post-action DOM appearance evidence to IDT IR, generated specs, validation, verification, and CLI workflows.

**Architecture:** A pure snapshot diff computes deterministic appeared `(role, name)` candidates. A probe orchestrator validates an IR, replays to the shared trigger action, executes it, captures the next snapshot, and atomically persists only an unambiguous candidate. Emitter, validator, and verifier consume the optional evidence without changing legacy output.

**Tech Stack:** TypeScript ESM, Zod, Playwright, Commander, `node:test`.

## Global Constraints

- Implement only design section B; do not modify HTTP `serviceCalls` extraction.
- Use strict TDD and observe each new test failing before production edits.
- Do not execute git commands or touch `D:\jz-font-end`.
- Existing fixture output must remain byte-identical.

---

### Task 1: IR and pure DOM snapshot diff

**Files:**
- Create: `src/idt/core/dom-delta.ts`
- Modify: `src/idt/core/ir-schema.ts`
- Test: `tests/unit/core/dom-delta.test.ts`

**Interfaces:**
- Produces: `DomDeltaSchema`, `DomDeltaCandidate`, and `diffAriaSnapshots(before, after)`.

- [ ] Write seven focused tests covering appeared, unchanged, disappeared, duplicate, unnamed, empty-before, and order behavior.
- [ ] Run the focused test and confirm it fails because `dom-delta.ts` is missing.
- [ ] Add the optional schema field and implement set-based ordered diff using `parseAriaSnapshot`.
- [ ] Run the focused test and confirm it passes.

### Task 2: Shared trigger selection and probe orchestration

**Files:**
- Create: `src/idt/core/action-order.ts`
- Create: `src/idt/core/prober.ts`
- Modify: `src/idt/core/emitter.ts`
- Modify: `src/idt/core/replay.ts`
- Modify: `src/idt/core/healer.ts`
- Test: `tests/unit/core/prober.test.ts`

**Interfaces:**
- Produces: `findTriggerActionIndex(actions): number`, generic `launchChromiumReplay<T>`, `ProbeOptions`, `ProbeResult`, and `probe(options)`.

- [ ] Write probe tests for unique, multiple, zero, invalid schema, stage skipping, all-complete, and shared trigger selection.
- [ ] Run the focused test and confirm the missing probe fails.
- [ ] Extract trigger selection and reuse it in emitter, replay, healer, and prober.
- [ ] Implement schema-safe IR loading, replay/action/snapshot flow, and atomic IR/spec writes only for one candidate.
- [ ] Run probe and affected replay/healer tests and confirm they pass.

### Task 3: Emitter and evidence gates

**Files:**
- Modify: `src/idt/core/emitter.ts`
- Modify: `src/idt/core/validate-ir.ts`
- Modify: `src/idt/core/verify.ts`
- Test: `tests/unit/core/emitter.test.ts`
- Test: `tests/unit/core/validate-ir.test.ts`
- Test: `tests/unit/core/verify.test.ts`

**Interfaces:**
- Consumes: `stage.invariants.domDelta` and shared trigger selection.
- Produces: post-trigger visibility assertions and the network/navigation/domDelta three-way evidence rule.

- [ ] Add failing tests for role/text rendering, trigger-relative position, legacy byte stability, three validation paths, and verifier suppression.
- [ ] Run focused tests and confirm expected failures.
- [ ] Render `domDelta` immediately after trigger execution and before route guards.
- [ ] Tighten route evidence by comparing anchor-stripped target and stage route patterns; accept `domDelta` as hard evidence.
- [ ] Run focused tests and confirm they pass.

### Task 4: CLI, host linking, and documentation

**Files:**
- Modify: `scripts/idt/cli.ts`
- Modify: `scripts/idt/link-host.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Test: `tests/unit/link-host.test.ts`

**Interfaces:**
- Produces: `idt probe <ir> --project <name>`, `idt:probe`, and linked-host script propagation.

- [ ] Add a failing linked-host script assertion for `idt:probe`.
- [ ] Run the focused test and confirm it fails.
- [ ] Wire the probe command and scripts, reporting unique/multiple/zero outcomes clearly.
- [ ] Document local probing, IR persistence, and deterministic CI execution near `idt:verify`.
- [ ] Run focused tests and confirm they pass.

### Task 5: Full verification

**Files:** all files above.

- [ ] Run `pnpm test:idt` and require zero failures.
- [ ] Run `pnpm exec tsc --noEmit` and require exit code 0.
- [ ] Re-run fixture byte-identity tests and inspect final changed files without git commands.
