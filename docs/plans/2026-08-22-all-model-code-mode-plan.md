---
title: All-Model CLJS Code Mode Plan
author: Eric Juta <ericjohnjuta@gmail.com>
date: 2026-08-22
---

# All-Model CLJS Code Mode Plan

## Status

Selected for implementation. This document records the agreed cross-repository plan. It does not authorize a merge, release, or deployment.

## Purpose

Prepare the next `omp-cljs-codemode` release after v0.1.17 for production-ready all-model Code Mode. The work covers dynamic tool guidance, supported-host compatibility, JavaScript interop ergonomics, and ambient provider proof.

This file is the canonical plan. The plugin repository owns the user-facing wrapper and this plan. OMP core owns the bridge declarations, transport behavior, provider-independent activation support, and its contract tests. OMP core documents should link here rather than copy the plan.

## Current State

`omp-cljs-codemode` v0.1.17 requests all-model Code Mode and reports transport availability only when the host exposes a same-name native `eval` tool. OMP 18 checks that native target again before hiding direct tools.

The remaining gaps are outside that transport guard:

- OMP native `eval` renders live hidden-tool declarations, but replacement eval descriptions receive only the plugin's static CLJS guidance.
- The static guidance prefers direct host tools even when Code Mode hides them.
- The eval-local `read` helper and bridged `tool.read` have different path and directory behavior, but the guidance does not distinguish them.
- OMP 17.2.12-style ambient sessions have failed to resolve non-core Squint imports such as `clojure.string`, while a fresh OMP 18 smoke succeeds.
- A recent bridged `Promise.all` result loop failed on unsupported `array-seq` and recovered with indexed `aget` access.
- Recent v0.1.17 ambient evidence covers Codex but not a non-Codex provider.

## Requirements

### Live Bridge Declarations

Move or expose live Code Mode bridge declarations so replacement eval tools receive the current hidden tool schemas. Do not hardcode OMP tool contracts in `omp-cljs-codemode`.

Preserve both existing safety boundaries:

- The replacement must continue to delegate through a same-name native `eval` whose JavaScript Code Mode transport is currently available.
- Native eval behavior and its own Code Mode description must remain correct.

### Code Mode-Aware CLJS Guidance

Render guidance according to the active tool surface:

- Use direct host tools when they are exposed.
- When Code Mode hides direct tools, use the live bridge through CLJS `tool.*` calls.
- Keep the invocation examples in valid Squint CLJS syntax.
- Distinguish bridged `tool.read` from the eval-local regular-file `read` helper.
- State that the eval-local helper does not expand `~` and does not support directory reads.

### Supported Host Compatibility

Reproduce the documented OMP 17.2.12 `clojure.string` module-resolution failure in an isolated ambient smoke.

The isolated OMP 17.2.12 ambient smoke reproduced the non-core Squint import failure while OMP 18 succeeded. The supported minimum is therefore OMP 18. Do not add a brittle compatibility shim or use plugin-side non-core import rewriting.

### Bridged Result Interop

Add behavior-level coverage for `Promise.all` bridged results. Supported JavaScript-array handling includes:

- `vec`
- `aget`
- an indexed `range`

Do not normalize `array-seq` as supported behavior.

### All-Model Ambient Proof

Add an end-to-end all-model Code Mode case that exercises hidden bridged `read` and `edit` schemas. Run a fresh ambient smoke on OMP 18 with Codex and at least one non-Codex provider.

The proof must use the installed plugin in a new OMP process. Checkout tests alone are not ambient proof.

## Implementation Sequence

1. Update OMP's Code Mode extension contract so a replacement eval can receive or render live bridge declarations without duplicating tool schemas.
2. Keep native eval on the same declaration source and preserve the same-name native transport gate.
3. Update the plugin to render CLJS-specific Code Mode guidance from the host-provided live declarations.
4. Clarify direct-tool, bridged-tool, and eval-local helper behavior without exposing native JavaScript as a selectable language.
5. Run the isolated OMP 17.2.12 import smoke and either prove support or raise the documented minimum to OMP 18 under the compatibility rule above.
6. Add focused behavior coverage for bridged `Promise.all` results and supported JS-array iteration.
7. Add provider-agnostic OMP contract coverage and an ambient hidden `read` and `edit` case.
8. Run the complete verification and independent review loops before publication of any pull request updates.

## Non-Goals

- Do not hardcode live OMP tool schemas in `omp-cljs-codemode`.
- Do not weaken Code Mode transport guards.
- Do not expose native JavaScript as a model-selectable language.
- Do not merge, release, deploy, or change repository policy as part of this work.

## Acceptance Criteria

- Replacement eval guidance contains current hidden bridge schemas without a plugin-owned copy of OMP tool contracts.
- Native eval retains its existing behavior and Code Mode guidance.
- Direct tools remain hidden only when a working same-name native eval bridge with JavaScript transport is currently available.
- CLJS guidance correctly distinguishes direct, bridged, and eval-local tool access.
- The declared minimum OMP host passes a fresh ambient `clojure.string` require smoke.
- Bridged `Promise.all` results work with `vec`, `aget`, or indexed iteration, and tests do not treat `array-seq` as supported.
- A fresh OMP 18 ambient run completes hidden bridged `read` and `edit` work on Codex and one non-Codex provider.
- Independent review reports no P0 or P1 findings.
- Relevant CI is green without merging, releasing, or deploying.

## Verification

Run and record:

- Plugin unit tests and the guidance eval suite.
- OMP provider-agnostic Code Mode contract tests.
- A fresh ambient CLJS require smoke on the declared minimum OMP host.
- Fresh ambient Code Mode `read` and `edit` smokes on Codex and one non-Codex provider.
- Full relevant plugin and OMP test suites.
- `pi-reviewer` against each changed repository's base branch, repeating after fixes until no P0 or P1 findings remain.
- Relevant repository CI for each pushed head.

Do not claim ambient, provider, review, or CI proof from source inspection alone.
