---
id: patch-conflicts
title: Patch group conflicts
---

When two independent editors (for example two collaborators, or two async producers) each return an array of patches, you often want to know **whether they can be safely merged before applying anything to the real state**. Immer ships a pure conflict analyzer for that: `analyzePatchConflicts`.

```js
import {analyzePatchConflicts} from "immer"

const report = analyzePatchConflicts(patchesFromEditorA, patchesFromEditorB)
if (!report.canMerge) {
	for (const conflict of report.conflicts) {
		// conflict.reason, conflict.message and the positions of both patches
	}
}
```

The analyzer never applies the patches, never mutates them, and does not read any getters or draft state — it only inspects each patch `op` and `path`.

## What is detected

Four situations are distinguished:

1. **Disjoint object paths** — no conflict, the groups are independent.
2. **Ancestor override** — one patch replaces or removes an ancestor object of the other patch path, so the nested edit would be overwritten.
3. **Same-path modification** — both patches target the exact same path.
4. **Array index shift** — one patch adds or removes an array index while the other group touches another index of the same array. Because an add/remove shifts the surrounding indices, these pairs are reported **conservatively**; the analyzer never assumes that two array edits commute.

For example:

```js
// Safe: profile.name and settings.theme are disjoint
analyzePatchConflicts(
	[{op: "replace", path: ["profile", "name"]}],
	[{op: "replace", path: ["settings", "theme"]}]
).canMerge // true

// Conflict: replacing `profile` overrides the nested `profile.name` edit
analyzePatchConflicts(
	[{op: "replace", path: ["profile"]}],
	[{op: "replace", path: ["profile", "name"]}]
).conflicts[0].reason // "ancestor-override"

// Conflict: deleting index 0 shifts index 2
analyzePatchConflicts(
	[{op: "remove", path: ["items", 0]}],
	[{op: "replace", path: ["items", 2]}]
).conflicts[0].reason // "array-index-shift"
```

## Rules

- **Path segment types matter.** The numeric segment `2` and the string segment `"2"` are different keys: `["items", 2]` (array index) and `["items", "2"]` (object property) are treated as disjoint.
- **Root replaces always conflict.** A patch with an empty path (`[]`) replaces the whole state, so it conflicts with every non-empty patch of the other group (and two root patches conflict with each other).
- **Empty groups are safe.** Analyzing against `[]` always reports `canMerge: true`.
- Only pairs **across** the two groups are analyzed; patches inside one group are assumed to describe a single coherent edit.

## Conflict reports

Every entry in `report.conflicts` contains:

- `reason`: one of `"same-path"`, `"ancestor-override"`, `"array-index-shift"`
- `message`: a deterministic, human-readable description
- `a` / `b`: the position of each patch — `group` (`"a"` or `"b"`), its zero-based `index` inside the group, and the original `patch`

Use `formatPatchConflicts(report)` to get a printable list, one conflict per line, with both positions and the reason. A complete runnable example lives in [`examples/patch-conflicts.ts`](https://github.com/immerjs/immer/blob/main/examples/patch-conflicts.ts).
