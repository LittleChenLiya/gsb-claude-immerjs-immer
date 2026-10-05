---
id: strict-draft-scope
title: Strict draft scope
---

Immer normally lets you store a draft that belongs to another, still-open
`produce` / `createDraft` scope inside the current draft. That is almost always
a bug: the foreign draft is finalized (and revoked) by its own scope, so the
reference stored in the current draft can never be finalized correctly.

**Strict draft scope mode** is an explicit opt-in that turns this situation
into an immediate, descriptive error at the moment of assignment.

## Enabling

Strict draft scope mode is configured per `Immer` instance and is **disabled
by default** (existing behavior is unchanged):

```ts
import {Immer} from "immer"

const immer = new Immer({useStrictDraftScope: true})
// or later:
immer.setUseStrictDraftScope(true)
```

It can also be toggled on the default instance used by the top-level exports:

```ts
import {setUseStrictDraftScope} from "immer"

setUseStrictDraftScope(true)
```

## The scope restriction

Every draft is owned by exactly one scope: the `produce` call or the
`createDraft` call that created it. With strict draft scope mode enabled:

- **Rejected**: assigning a draft owned by a *different, still-open* scope
  into the current draft. The thrown error reports the write path and the
  source scope, e.g.

  ```
  [Immer] Cannot assign a draft owned by scope #3 (createDraft) into the
  current draft at 'draft.nested.list[0]'. Strict draft scope mode forbids
  storing a draft from another produce/createDraft scope while that scope is
  still open. Finalize the other draft first (e.g. with 'finishDraft') and
  assign its plain result instead, or keep shared references within a single
  scope.
  ```

- **Allowed**: sharing a draft *within* the same scope
  (`draft.b = draft.a`), and assigning *finalized plain values* — a value
  returned by `finishDraft` / `produce` is no longer a draft, so it is never
  rejected.

The gate is checked **before** any mutation happens, so a rejected assignment
leaves the current draft untouched: you can catch the error and still commit
other legal edits with `finishDraft`.

The same gate applies uniformly to object/array property assignment, to the
Map/Set plugin (`Map#set`, `Set#add`), and to insertions through the array
methods plugin (`push`, `unshift`, `splice`).

```ts
const immer = new Immer({useStrictDraftScope: true})

const d1 = immer.createDraft({x: 1})
const d2 = immer.createDraft({ref: null, ok: 0})

d2.ref = d1 // throws: foreign draft from a still-open scope

// recovery: the draft is untouched, other edits still commit
d2.ok = 42
immer.finishDraft(d2) // {ref: null, ok: 42}

// finalize first, then assign the plain result
const done = immer.finishDraft(d1)
const d3 = immer.createDraft({ref: null})
d3.ref = done // fine: `done` is a plain value
immer.finishDraft(d3)
```

## Running the tests

The feature is covered by `__tests__/strict-draft-scope.js`. To run just that
file locally (from the repository root):

```bash
npx vitest run __tests__/strict-draft-scope.js
```
