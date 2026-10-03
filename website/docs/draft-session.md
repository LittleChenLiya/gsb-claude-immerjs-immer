---
id: draft-session
title: Draft sessions
---

A draft session wraps the manual [`createDraft` / `finishDraft`](./async.mdx) pair and adds an explicit lifecycle to it. Use it when you need to hand out a mutable draft, let someone decide later whether to publish the changes, and otherwise discard everything deterministically.

## The three states

A session is always in one of three states:

| State | Meaning |
| --- | --- |
| `open` | The draft can be read and mutated. |
| `committed` | `commit()` was called; the session is closed. |
| `aborted` | `abort()` was called; the session is closed and all drafts it held were revoked. |

Once closed, a session can never be reopened. Reading `session.draft`, calling `commit()` or calling `abort()` again all throw a definite `[Immer] Draft session is already '...'` error.

## Opening and committing

`DraftSession.open(base)` creates a session around a draft of `base`. Mutate `session.draft` as usual, then call `commit()` to publish the next immutable state. `commit()` accepts an optional patch listener that receives the forward and inverse patches:

```js
import {DraftSession} from "immer"

const base = {user: {name: "Ada", age: 36}, tags: ["a"]}

const session = DraftSession.open(base)
session.draft.user.age = 37
session.draft.tags.push("b")

const result = session.commit((patches, inversePatches) => {
	// patches describe the transition from base to result
})

session.state // "committed"
result // {user: {name: "Ada", age: 37}, tags: ["a", "b"]}
base // untouched: {user: {name: "Ada", age: 36}, tags: ["a"]}
```

`commit()` can be called at most once. The session is marked `committed` *before* finalization runs, so an exception thrown while finalizing or by the patch listener cannot leave behind an open, still-mutable session. Any drafts the session still holds are released in that case.

## Aborting

Call `abort()` to discard every change made to the draft. The base state is never touched, and every draft the session created is revoked — so any draft reference still held by user code stops working:

```js
const session = DraftSession.open({a: {b: 1}})
const draft = session.draft
draft.a.b = 2

session.abort()

session.state // "aborted"
draft.a.b // throws: the proxy has been revoked
session.draft // throws: the session is closed
```

Aborting one session has no effect on other sessions, even if they were opened from the same base.

## Nested drafts and references

Drafts created through a session behave exactly like manual drafts: nested objects are drafted lazily, references between drafts are preserved on commit, and a draft from one session can be nested into another without being finalized by it.

## Custom Immer instance

`DraftSession.open(base, immer)` accepts an optional [`Immer`](./api.md#customizing-immer) instance whose settings (autoFreeze, strict copying, ...) the session uses. Without it, sessions use a private default instance.

## API

```ts
type DraftSessionState = "open" | "committed" | "aborted"

class DraftSession<T> {
	static open<T>(base: T, immer?: Immer): DraftSession<T>
	get state(): DraftSessionState
	get draft(): Draft<T>
	commit(patchListener?: PatchListener): T
	abort(): void
}
```

The underlying manual draft primitives (`createDraft` / `finishDraft`) are unchanged; `DraftSession` is an additional wrapper on top of them.
