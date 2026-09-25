---
id: produce-observer
title: Observing produce
---

# Produce observer contract

`createProduceObserver` builds a reusable observation adapter around `produce`. Subscribers register for an **exact path** or a **subtree** and are notified only when a committed produce actually affects their path.

```ts
import {createProduceObserver} from "immer"

const observer = createProduceObserver()

const unsubscribe = observer.subscribe(["user", "name"], event => {
	console.log(event.oldValue, "->", event.newValue, event.patches)
})

const result = observer.produce(baseState, draft => {
	draft.user.name = "Michel"
})

result.state // committed next state
result.patches // all generated patches
result.inversePatches // all generated inverse patches
result.errors // aggregated listener errors (see below)
```

The adapter enables the `Patches` and `MapSet` plugins automatically. It wraps a dedicated `Immer` instance unless one is passed to `createProduceObserver(immerInstance)`.

## Subscriptions

- `subscribe(path, listener)` registers a listener and returns an **unsubscribe** function. `observer.size` reports the number of active subscriptions.
- A path segment is a string (object property), a number (array index) or an arbitrary value (`Map` key). Segments follow real patch semantics: array indices are matched numerically (`0` and `"0"` are equivalent) and `Map` keys — including object keys — are matched **by identity**, exactly as they appear in Immer patch paths.
- A subscription is _affected_ by a produce call when its path and at least one generated patch path overlap (one is a prefix of the other). An exact path subscription like `["user", "name"]` therefore does not fire when only an unrelated subtree such as `["items"]` changes, and vice versa.
- Array index shifts are resolved against the real states: after `items.unshift(x)`, a subscriber of `["items", 1]` observes the shifted old and new values, matching the generated replace/add patches.

## Notification semantics

- Notifications run **after the state commit**, once per produce call, in **registration order**.
- Each notification receives an event with:
  - `path` — the subscribed path.
  - `oldValue` / `newValue` — the value at `path` in the base state and in the committed state.
  - `state` — the committed root state (usable as the base of a follow-up produce).
  - `patches` — the subset of generated patches affecting this subscription, as root-relative Immer patches.
- **No change, no notification**: when a produce call generates no patches, no listener runs.
- **Errors are aggregated, never fatal**: a throwing listener does not roll back the committed state and does not prevent other listeners from running. All thrown errors are collected in notification order into the `errors` array of the `produce` result.

## Re-entrancy and list mutation

- Calling `observer.produce` from inside a notification executes the recipe immediately, but its notifications are **queued** and dispatched only after the current notification round has fully ended. Queued rounds are drained strictly FIFO, so recursion can never reorder notifications. The `errors` array returned by a queued produce is shared and is populated once the enclosing round has drained.
- **Unsubscribing takes effect after the current round ends**: a listener removed during a round still receives that round's notifications.
- Listeners **subscribed during a round** are not notified for that round; they participate from the next produce call onwards.

## Demo

Run the focused test file (a few seconds) to see matching notifications and queued updates in action:

```bash
npx vitest run __tests__/observe.ts
```
