import {
	produceWithPatches,
	applyPatches,
	enablePatches,
	analyzePatchConflicts,
	canMergePatchGroups,
	formatPatchConflicts,
	formatPatchPath,
	PatchConflict
} from "../src/immer"

enablePatches()

describe("analyzePatchConflicts", () => {
	test("disjoint object paths do not conflict", () => {
		// Editor A modifies profile.name, editor B modifies settings.theme:
		// these are independent locations and can be merged safely.
		const groupA = [{op: "replace", path: ["profile", "name"], value: "Grace"}]
		const groupB = [{op: "replace", path: ["settings", "theme"], value: "dark"}]

		expect(canMergePatchGroups(groupA, groupB)).toBe(true)
		expect(analyzePatchConflicts(groupA, groupB)).toEqual([])
	})

	test("replacing an ancestor conflicts with modifying a descendant", () => {
		// Editor A replaces the whole `profile` object while editor B only
		// modifies `profile.name`.
		const groupA = [{op: "replace", path: ["profile"], value: {name: "Grace"}}]
		const groupB = [{op: "replace", path: ["profile", "name"], value: "Ada"}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]).toMatchObject({
			aIndex: 0,
			bIndex: 0,
			reason: "ancestor-replace",
			aOp: "replace",
			bOp: "replace",
			aPath: ["profile"],
			bPath: ["profile", "name"]
		})
		expect(canMergePatchGroups(groupA, groupB)).toBe(false)
	})

	test("removing an ancestor conflicts with modifying a descendant", () => {
		const groupA = [{op: "remove", path: ["profile"]}]
		const groupB = [{op: "replace", path: ["profile", "name"], value: "Ada"}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].reason).toBe("ancestor-replace")
	})

	test("same path modifications conflict", () => {
		const groupA = [{op: "replace", path: ["profile", "name"], value: "Grace"}]
		const groupB = [{op: "replace", path: ["profile", "name"], value: "Ada"}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].reason).toBe("same-path")
	})
})

describe("analyzePatchConflicts: arrays", () => {
	test("array remove at index 0 conflicts with modifying index 2", () => {
		// Removing list[0] shifts every later index, so the patch at list[2]
		// would hit the wrong element.
		const groupA = [{op: "remove", path: ["list", 0]}]
		const groupB = [{op: "replace", path: ["list", 2], value: 99}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]).toMatchObject({
			aIndex: 0,
			bIndex: 0,
			reason: "array-index-shift",
			aPath: ["list", 0],
			bPath: ["list", 2]
		})
	})

	test("array add at one index conflicts with modifications at other indices", () => {
		const groupA = [{op: "add", path: ["list", 0], value: 0}]
		const groupB = [{op: "replace", path: ["list", 2], value: 99}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].reason).toBe("array-index-shift")
	})

	test("array remove at two different indices conflicts conservatively", () => {
		// Even removing two different indices is order-dependent; the analyzer
		// never assumes array mutations commute.
		const groupA = [{op: "remove", path: ["list", 0]}]
		const groupB = [{op: "remove", path: ["list", 1]}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].reason).toBe("array-index-shift")
	})

	test("replacing two different array indices does not conflict", () => {
		const groupA = [{op: "replace", path: ["list", 0], value: 1}]
		const groupB = [{op: "replace", path: ["list", 2], value: 3}]

		expect(canMergePatchGroups(groupA, groupB)).toBe(true)
	})

	test("numeric and string path segments never collapse into the same key", () => {
		// `arr[0]` (array index) and `arr["0"]` (object key) are different
		// paths and must not be reported as the same key.
		const groupA = [{op: "replace", path: ["arr", 0], value: 1}]
		const groupB = [{op: "replace", path: ["arr", "0"], value: 2}]

		expect(analyzePatchConflicts(groupA, groupB)).toEqual([])
		expect(canMergePatchGroups(groupA, groupB)).toBe(true)

		// Same type and value still means the same path.
		const groupC = [{op: "replace", path: ["arr", 0], value: 1}]
		const groupD = [{op: "replace", path: ["arr", 0], value: 2}]
		expect(analyzePatchConflicts(groupC, groupD)[0].reason).toBe("same-path")
	})
})

describe("analyzePatchConflicts: root path and empty groups", () => {
	test("root replace conflicts with any non-empty other group", () => {
		const groupA = [{op: "replace", path: [], value: {foo: 1}}]
		const groupB = [{op: "replace", path: ["profile", "name"], value: "Ada"}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]).toMatchObject({
			aIndex: 0,
			bIndex: 0,
			reason: "root-replace",
			aPath: [],
			bPath: ["profile", "name"]
		})
	})

	test("two root replacements conflict on the same path", () => {
		const groupA = [{op: "replace", path: [], value: {foo: 1}}]
		const groupB = [{op: "replace", path: [], value: {bar: 2}}]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].reason).toBe("same-path")
	})

	test("an empty group never conflicts", () => {
		const nonEmpty = [{op: "replace", path: ["a"], value: 1}]

		expect(analyzePatchConflicts([], nonEmpty)).toEqual([])
		expect(analyzePatchConflicts(nonEmpty, [])).toEqual([])
		expect(analyzePatchConflicts([], [])).toEqual([])
		expect(canMergePatchGroups([], nonEmpty)).toBe(true)
		expect(canMergePatchGroups(nonEmpty, [])).toBe(true)
	})
})

describe("analyzePatchConflicts: positions and reporting", () => {
	test("reports the exact positions of conflicting patches", () => {
		const groupA = [
			{op: "replace", path: ["a"], value: 1},
			{op: "replace", path: ["b"], value: 2},
			{op: "replace", path: ["c"], value: 3}
		]
		const groupB = [
			{op: "replace", path: ["x"], value: 9},
			{op: "replace", path: ["b"], value: 8},
			{op: "replace", path: ["z"], value: 7}
		]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].aIndex).toBe(1)
		expect(conflicts[0].bIndex).toBe(1)
		expect(conflicts[0].reason).toBe("same-path")
	})

	test("a single patch can conflict with several patches of the other group", () => {
		const groupA = [{op: "replace", path: ["profile"], value: {}}]
		const groupB = [
			{op: "replace", path: ["profile", "name"], value: "Ada"},
			{op: "replace", path: ["profile", "age"], value: 42},
			{op: "replace", path: ["settings", "theme"], value: "dark"}
		]

		const conflicts = analyzePatchConflicts(groupA, groupB)
		expect(conflicts).toHaveLength(2)
		expect(conflicts.map(c => c.bIndex)).toEqual([0, 1])
		expect(conflicts.every(c => c.aIndex === 0)).toBe(true)
		expect(conflicts.every(c => c.reason === "ancestor-replace")).toBe(true)
	})

	test("does not mutate the passed-in patches", () => {
		const groupA = [
			{op: "remove", path: ["list", 0]},
			{op: "replace", path: ["profile", "name"], value: "Grace"}
		]
		const groupB = [
			{op: "replace", path: ["list", 2], value: 99},
			{op: "replace", path: ["profile"], value: {}}
		]
		const snapshotA = JSON.parse(JSON.stringify(groupA))
		const snapshotB = JSON.parse(JSON.stringify(groupB))

		const conflicts = analyzePatchConflicts(groupA, groupB)

		expect(conflicts.length).toBeGreaterThan(0)
		expect(groupA).toEqual(snapshotA)
		expect(groupB).toEqual(snapshotB)
		// Returned paths are copies, not references into the input patches.
		expect(conflicts[0].aPath).not.toBe(groupA[0].path)
	})
})

describe("formatPatchPath", () => {
	test("renders the root path as []", () => {
		expect(formatPatchPath([])).toBe("[]")
	})

	test("renders string segments quoted and numbers unquoted", () => {
		expect(formatPatchPath(["profile", "name"])).toBe('/"profile"/"name"')
		expect(formatPatchPath(["list", 2])).toBe('/"list"/2')
	})
})

describe("formatPatchConflicts", () => {
	test("returns a printable report with positions and reasons", () => {
		const conflicts: PatchConflict[] = analyzePatchConflicts(
			[{op: "replace", path: ["profile"], value: {}}],
			[{op: "replace", path: ["profile", "name"], value: "Ada"}]
		)

		const report = formatPatchConflicts(conflicts)
		// The report is a printable, multi-line string.
		expect(typeof report).toBe("string")
		expect(report).toContain("ancestor-replace")
		expect(report).toContain("A 组 #0")
		expect(report).toContain("B 组 #0")
		expect(report).toContain('"profile"')
		expect(report.split("\n").length).toBeGreaterThanOrEqual(4)
	})

	test("reports a mergeable pair as safe", () => {
		const report = formatPatchConflicts(
			analyzePatchConflicts(
				[{op: "replace", path: ["profile", "name"], value: "Grace"}] as any,
				[{op: "replace", path: ["settings", "theme"], value: "dark"}] as any
			)
		)
		expect(report).toContain("可以安全合并")
	})
})

describe("analyzePatchConflicts integration with produceWithPatches", () => {
	test("mergeable object edits commute when applied in any order", () => {
		const base = {profile: {name: "Ada", age: 36}, settings: {theme: "light"}}

		const [, patchesA] = produceWithPatches(base, draft => {
			draft.profile.name = "Grace"
		})
		const [, patchesB] = produceWithPatches(base, draft => {
			draft.settings.theme = "dark"
		})

		// The analyzer says the two groups are mergeable...
		expect(canMergePatchGroups(patchesA, patchesB)).toBe(true)

		// ...and applying them in either order yields the same state.
		const merged = applyPatches(applyPatches(base, patchesA), patchesB)
		const swapped = applyPatches(applyPatches(base, patchesB), patchesA)
		expect(merged).toEqual(swapped)
		expect(merged).toEqual({
			profile: {name: "Grace", age: 36},
			settings: {theme: "dark"}
		})
	})

	test("ancestor replacement is flagged and does not commute", () => {
		const base = {profile: {name: "Ada", age: 36}}

		const [, patchesA] = produceWithPatches(base, draft => {
			;(draft as any).profile = {name: "Grace"}
		})
		const [, patchesB] = produceWithPatches(base, draft => {
			draft.profile.name = "Ada Lovelace"
		})

		const conflicts = analyzePatchConflicts(patchesA, patchesB)
		expect(conflicts.length).toBeGreaterThan(0)
		expect(conflicts[0].reason).toBe("ancestor-replace")

		// Applying in different orders yields different states, which is
		// exactly why the analyzer refuses to call this mergeable.
		const merged = applyPatches(applyPatches(base, patchesA), patchesB)
		const swapped = applyPatches(applyPatches(base, patchesB), patchesA)
		expect(merged).not.toEqual(swapped)
	})
})
