---
id: strict-drafts
title: Strict draft mode
---

Strict draft mode prevents a subtle class of bugs where a draft from one `produce` (or `createDraft`) scope is stored inside a draft that outlives it.

## The problem

Every `produce` call and every `createDraft` call creates its own **scope**. Drafts belong to the scope that created them. When that scope finalizes (the producer returns, or `finishDraft` is called), all drafts it owned are revoked.

If you store a draft from scope _A_ inside a draft owned by scope _B_, and scope _A_ finalizes first, the stored reference becomes a revoked proxy. Reading it later throws `Cannot use a proxy that has been revoked`. This can happen with manual drafts, nested producers, or any code that lets drafts from different scopes cross paths.

## Enabling strict draft mode

Strict draft mode is **opt-in** and disabled by default. Enable it globally:

```js
import {setUseStrictDrafts} from "immer"

setUseStrictDrafts(true)
```

Or per `Immer` instance:

```js
import {Immer} from "immer"

const immer = new Immer({useStrictDrafts: true})
```

When enabled, assigning a live draft owned by a _different_ scope into the current draft is rejected with an error that reports the **write path** and the **owning scope**:

```js
import {Immer} from "immer"

const immer = new Immer({useStrictDrafts: true})

const d1 = immer.createDraft({a: {b: 1}})
const d2 = immer.createDraft({x: 2})

d1.a.b = d2
// Error: [Immer] Cross-scope draft assignment rejected: a draft from produce scope #2 cannot be written to "a.b" while its owning scope is still active. Finalize the source draft first or assign a plain (non-draft) value.
```

The check runs **before** the assignment is applied, so a rejected write leaves the current draft untouched and other edits can still be committed:

```js
d1.a.b = d2 // rejected
d1.c = 3 // still works
const result = immer.finishDraft(d1) // {a: {b: 1}, c: 3}
```

Map and Set assignments follow the same gate:

```js
const map = immer.createDraft(new Map())
const other = immer.createDraft(new Map())

map.set("x", other) // rejected
map.set("y", 1) // still works
```

## What is allowed

- **Same-scope shared references.** Assigning a draft to multiple locations within the same scope is always allowed. The references are finalized together.
- **Finalized plain values.** Once a scope has finalized, its result is a plain object (not a draft) and can be freely assigned.
- **Default behavior.** With strict mode off (the default), cross-scope assignments are allowed as before.

## Scope and limitations

Strict draft mode is a guardrail, not a complete isolation mechanism. Be aware of its limitations:

- **Only direct draft assignments are checked.** If you assign a plain object that _contains_ a cross-scope draft nested inside it (e.g. `draft.a = {nested: otherDraft}`), the nested draft is not detected at assignment time. The check inspects the assigned value itself, not its contents.
- **Revoked drafts are not reported.** A draft whose owning scope has already finalized is treated as a plain value. For object and array drafts the proxy is revoked and accessing its state throws; for Map and Set drafts the state is marked revoked. In both cases the assignment is allowed.
- **Same-scope drafts are not isolated.** Sharing a draft across locations within one scope is permitted by design, since they are finalized together. Strict mode does not prevent aliasing within a scope.
- **The scope identifier is diagnostic.** Scope numbers are monotonically increasing and intended for debugging only; they are not stable across runs and should not be parsed programmatically.

For most applications, keeping scopes short-lived and avoiding manual drafts that outlive their producer is sufficient. Strict draft mode is a safety net for the cases where that discipline is hard to maintain.
