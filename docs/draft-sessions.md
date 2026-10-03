# Draft sessions

`createDraftSession(base)` is an explicit, inspectable wrapper around the manual [`createDraft`](https://immerjs.github.io/immer/api/immer#createDraft) / [`finishDraft`](https://immerjs.github.io/immer/api/immer#finishDraft) pair. It is meant for flows where a draft has to be reviewed (or approved) before anyone decides whether the changes may be published.

The manual draft API itself is unchanged; a session is a thin lifecycle wrapper on top of it.

```ts
import {createDraftSession, enablePatches} from "immer"

enablePatches() // optional, only needed when you want patches

const base = {user: {name: "ada", address: {city: "x"}}}

const session = createDraftSession(base)
session.status // "open"

session.draft.user.address.city = "y"

const {result, patches, inversePatches} = session.commit()
session.status // "committed"
// result.user.address.city === "y", base is untouched
// patches:         [{op: "replace", path: ["user", "address", "city"], value: "y"}]
// inversePatches:  [{op: "replace", path: ["user", "address", "city"], value: "x"}]
```

## Lifecycle

A session has exactly three states and can be closed at most once:

```
        commit()            abort()
"open" ────────► "committed"      "open" ────────► "aborted"
```

- **`session.draft`** — the modifiable draft. Only accessible while the session is `open`.
- **`session.commit(patchListener?)`** — finalizes the draft at most once and closes the session. Returns `{result, patches, inversePatches}`. `patches` and `inversePatches` are generated whenever the `Patches` plugin is enabled (`enablePatches()`); otherwise they are `undefined`. The optional `patchListener` receives the same patches.
- **`session.abort()`** — discards all changes and closes the session. Every draft reference handed out by the session (including nested drafts and Map/Set drafts) is revoked.

## Guarantees

- **Commit at most once.** A second `commit()` (or an `abort()` after a commit, or vice versa) throws a deterministic `The draft session is already closed (status: ...)` error.
- **Abort revokes everything.** After `abort()`, reading or writing any draft of the session — including references obtained earlier — throws Immer's `Cannot use a proxy that has been revoked` error. The base state is never mutated, and abandoned changes are never merged back into it.
- **Failure closes the session.** If `commit()` itself fails — for example because the patch listener throws — the session is closed too (its status becomes `"aborted"`) and all of its drafts are released. A failed commit can never leave a half-open, still-modifiable session behind.
- **Deterministic errors after close.** Once a session is closed, any read, write, commit or abort through the session or its drafts always fails with the same error for the same operation.

## Map and Set bases

Sessions work with `Map` and `Set` bases when the `MapSet` plugin is enabled (`enableMapSet()`), including patch generation when `enablePatches()` is also active.

## Demo

A short, runnable tour of the status transitions lives in [`examples/draft-session-status.mjs`](../examples/draft-session-status.mjs):

```sh
npm run build
node examples/draft-session-status.mjs
```

## Tests

The focused Vitest suite is [`__tests__/draft-session.js`](../__tests__/draft-session.js):

```sh
npx vitest run __tests__/draft-session.js
```
