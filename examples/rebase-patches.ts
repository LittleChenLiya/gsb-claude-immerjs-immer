/**
 * Demo for rebasePatches: rebases incoming patches (created from the same
 * base) onto the result of local patches, printing inputs, rebased patches
 * and conflict indices.
 *
 * Run with: npx vite-node examples/rebase-patches.ts
 */
import {
	applyPatches,
	enablePatches,
	rebasePatches,
	Patch
} from "../src/immer"

enablePatches()

function show(title: string, base: any, local: Patch[], incoming: Patch[]) {
	console.log("=== " + title + " ===")
	console.log("base:     ", JSON.stringify(base))
	console.log("local:    ", JSON.stringify(local))
	console.log("incoming: ", JSON.stringify(incoming))

	const {patches, inversePatches, conflicts} = rebasePatches(
		base,
		local,
		incoming
	)

	if (conflicts.length > 0) {
		console.log("conflicts:")
		for (const c of conflicts) {
			console.log(
				`  local[${c.localIndex}] vs incoming[${c.incomingIndex}] at /${c.path.join(
						"/"
					)}: ${c.reason}`
			)
		}
	} else {
		const localState = applyPatches(base, local)
		const merged = applyPatches(localState, patches)
		const restored = applyPatches(merged, inversePatches)
		console.log("rebased:  ", JSON.stringify(patches))
		console.log("inverse:  ", JSON.stringify(inversePatches))
		console.log("merged:   ", JSON.stringify(merged))
		console.log("restored: ", JSON.stringify(restored), "(back to local state)")
	}
	console.log()
}

// 1. Acceptance scenario: local deletes A, incoming replaces original B.
// The rebased patch targets index 0 and C is preserved.
show(
	"remove shifts incoming replace",
	{items: ["A", "B", "C"]},
	[{op: "remove", path: ["items", 0]}],
	[{op: "replace", path: ["items", 1], value: "B2"}]
)

// 2. Both sides insert into the same base gap: local elements come first.
show(
	"same-gap inserts keep local order",
	{items: ["A", "B"]},
	[
		{op: "add", path: ["items", 1], value: "L1"},
		{op: "add", path: ["items", 2], value: "L2"}
	],
	[
		{op: "add", path: ["items", 1], value: "I1"},
		{op: "add", path: ["items", 2], value: "I2"}
	]
)

// 3. Deleting original B conflicts with modifying original B.
show(
	"delete vs modify conflict",
	{items: ["A", "B", "C"]},
	[{op: "remove", path: ["items", 1]}],
	[{op: "replace", path: ["items", 1], value: "B2"}]
)

