/**
 * Patch-group conflict analysis example.
 *
 * Two independent editors hand back their patch arrays. Before applying
 * anything to the real state, `analyzePatchConflicts` tells us whether the
 * groups can be merged safely and lists every conflict with the position
 * (group + index) of both patches and a human-readable reason.
 *
 * Run directly with Node.js >= 24 (native TypeScript type stripping):
 *
 *   node examples/patch-conflicts.ts
 *
 * or with any TypeScript-aware runner.
 */
import {
	analyzePatchConflicts,
	formatPatchConflicts
} from "../src/patch-conflicts.ts"
import type {Patch} from "../src/types/types-external.ts"

const editorA: Patch[] = [
	// Edit nested object fields ...
	{op: "replace", path: ["profile", "name"], value: "Michel"},
	// ... and remove the first item of a list.
	{op: "remove", path: ["items", 0]}
]

const editorB: Patch[] = [
	// Disjoint object path: safe.
	{op: "replace", path: ["settings", "theme"], value: "dark"},
	// Different index of the same array: the removal shifts this index,
	// so the analyzer reports a conservative array-index-shift conflict.
	{op: "replace", path: ["items", 2], value: "third"},
	// Replacing the whole profile overrides editor A's nested name edit.
	{
		op: "replace",
		path: ["profile"],
		value: {name: "Sara", age: 33}
	}
]

const report = analyzePatchConflicts(editorA, editorB)

// The conflict list is directly printable:
console.log(formatPatchConflicts(report))

console.log("")
console.log("canMerge:", report.canMerge)
for (const conflict of report.conflicts) {
	console.log(
		`- reason=${conflict.reason}`,
		`a[${conflict.a.index}]`,
		JSON.stringify(conflict.a.patch.path),
		"<->",
		`b[${conflict.b.index}]`,
		JSON.stringify(conflict.b.patch.path),
		"::",
		conflict.message
	)
}
