import {describe, expect, it} from "vitest"
import {produceWithPatches, enablePatches} from "../src/immer"
import type {Patch} from "../src/immer"
import {
	analyzePatchConflicts,
	canMergePatches,
	formatPatchConflicts,
	PatchConflictReason
} from "../src/patch-conflicts"

enablePatches()

function patch(
	op: Patch["op"],
	path: (string | number)[],
	value?: unknown
): Patch {
	const p: Patch = {op, path}
	if (value !== undefined) {
		p.value = value
	}
	return p
}

describe("analyzePatchConflicts", () => {
	it("accepts disjoint object paths (profile.name vs settings.theme)", () => {
		const a = [patch("replace", ["profile", "name"], "Michel")]
		const b = [patch("replace", ["settings", "theme"], "dark")]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(true)
		expect(report.conflicts).toEqual([])
		expect(canMergePatches(a, b)).toBe(true)
	})

	it("flags replacing profile together with editing profile.name", () => {
		const a = [patch("replace", ["profile"], {name: "X"})]
		const b = [patch("replace", ["profile", "name"], "Y")]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(false)
		expect(report.conflicts).toHaveLength(1)
		const conflict = report.conflicts[0]
		expect(conflict.reason).toBe(PatchConflictReason.AncestorOverride)
		expect(conflict.a.group).toBe("a")
		expect(conflict.a.index).toBe(0)
		expect(conflict.b.group).toBe("b")
		expect(conflict.b.index).toBe(0)
		expect(conflict.a.patch.path).toEqual(["profile"])
		expect(conflict.b.patch.path).toEqual(["profile", "name"])
		expect(conflict.message).toContain("ancestor")
	})

	it("reports ancestor override in both group orders", () => {
		const a = [patch("replace", ["profile", "name"], "Y")]
		const b = [patch("replace", ["profile"], {name: "X"})]
		const report = analyzePatchConflicts(a, b)
		expect(report.conflicts[0].reason).toBe(
			PatchConflictReason.AncestorOverride
		)
	})

	it("flags same-path modifications", () => {
		const a = [patch("replace", ["profile", "name"], "Michel")]
		const b = [patch("replace", ["profile", "name"], "Sara")]
		const conflict = analyzePatchConflicts(a, b).conflicts[0]
		expect(conflict.reason).toBe(PatchConflictReason.SamePath)
		expect(conflict.a.index).toBe(0)
		expect(conflict.b.index).toBe(0)
		expect(conflict.message).toContain("same path")
		expect(conflict.message).toContain('["profile","name"]')
	})

	it("conservatively conflicts array index 0 removal with index 2 edit", () => {
		const a = [patch("remove", ["items", 0])]
		const b = [patch("replace", ["items", 2], "v")]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(false)
		const conflict = report.conflicts[0]
		expect(conflict.reason).toBe(PatchConflictReason.ArrayIndexShift)
		expect(conflict.a.patch.op).toBe("remove")
		expect(conflict.b.patch.op).toBe("replace")
		expect(conflict.message).toContain("array")
	})

	it("treats array insertion at 1 and edit of index 2 as a shift conflict", () => {
		const a = [patch("add", ["items", 1], "new")]
		const b = [patch("replace", ["items", 2], "v")]
		expect(analyzePatchConflicts(a, b).conflicts[0].reason).toBe(
			PatchConflictReason.ArrayIndexShift
		)
	})

	it("treats edits strictly below distinct array indices as disjoint", () => {
		const a = [patch("replace", ["items", 0, "name"], "a")]
		const b = [patch("replace", ["items", 2, "name"], "b")]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(true)
	})

	it("conservatively conflicts index 0 removal with a deep edit under index 2", () => {
		const a = [patch("remove", ["items", 0])]
		const b = [patch("replace", ["items", 2, "name"], "b")]
		expect(analyzePatchConflicts(a, b).conflicts[0].reason).toBe(
			PatchConflictReason.ArrayIndexShift
		)
	})

	it("flags two structural array edits regardless of index distance", () => {
		const a = [patch("remove", ["items", 0])]
		const b = [patch("remove", ["items", 5])]
		expect(analyzePatchConflicts(a, b).conflicts[0].reason).toBe(
			PatchConflictReason.ArrayIndexShift
		)
	})

	it("does not pretend add and remove at the same index commute", () => {
		const a = [patch("add", ["items", 0], "x")]
		const b = [patch("remove", ["items", 0])]
		expect(analyzePatchConflicts(a, b).conflicts[0].reason).toBe(
			PatchConflictReason.SamePath
		)
	})

	it("never conflates numeric segments with string segments", () => {
		const a = [patch("replace", ["items", 0], "array-index")]
		const b = [patch("replace", ["items", "0"], "object-key")]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(true)
		expect(report.conflicts).toEqual([])
	})

	it("keeps numeric vs string segments distinct for ancestor checks", () => {
		const a = [patch("replace", ["items", 0, "name"], "x")]
		const b = [patch("replace", ["items", "0"], {name: "y"})]
		expect(analyzePatchConflicts(a, b).canMerge).toBe(true)
	})

	it("conflicts a root replace with every non-empty patch of the other group", () => {
		const a = [patch("replace", [], {profile: {name: "root"}})]
		const b = [
			patch("replace", ["profile", "name"], "Y"),
			patch("replace", ["settings", "theme"], "dark")
		]
		const report = analyzePatchConflicts(a, b)
		expect(report.canMerge).toBe(false)
		expect(report.conflicts).toHaveLength(2)
		for (const conflict of report.conflicts) {
			expect(conflict.reason).toBe(PatchConflictReason.AncestorOverride)
			expect(conflict.a.index).toBe(0)
			expect(conflict.a.patch.path).toEqual([])
			expect(conflict.b.patch.path.length).toBeGreaterThan(0)
			expect(conflict.message.toLowerCase()).toContain("root")
		}
	})

	it("flags root replace vs root replace as same-path", () => {
		const a = [patch("replace", [], 1)]
		const b = [patch("replace", [], 2)]
		const conflict = analyzePatchConflicts(a, b).conflicts[0]
		expect(conflict.reason).toBe(PatchConflictReason.SamePath)
	})

	it("treats empty groups as always mergeable", () => {
		expect(analyzePatchConflicts([], []).canMerge).toBe(true)
		expect(
			analyzePatchConflicts([], [patch("replace", ["a"], 1)]).canMerge
		).toBe(true)
		expect(
			analyzePatchConflicts([patch("replace", ["a"], 1)], []).canMerge
		).toBe(true)
	})

	it("does not mutate input patches or read getters", () => {
		const a = [patch("replace", ["profile", "name"], "a")]
		const b = [patch("replace", ["profile"], {name: "b"})]
		const snapshotA = JSON.parse(JSON.stringify(a))
		const snapshotB = JSON.parse(JSON.stringify(b))
		analyzePatchConflicts(a, b)
		expect(a).toEqual(snapshotA)
		expect(b).toEqual(snapshotB)

		// Patches with accessor-defined properties: the analyzer only needs
		// op and path, it must never touch the value getter.
		let valueGetterReads = 0
		const patchWithValueGetter: Patch = {
			op: "replace",
			path: ["profile", "name"]
		}
		Object.defineProperty(patchWithValueGetter, "value", {
			get() {
				valueGetterReads++
				throw new Error("value getter must not be read")
			},
			configurable: true
		})
		analyzePatchConflicts(
			[patchWithValueGetter],
			[patch("replace", ["profile", "age"], 1)]
		)
		expect(valueGetterReads).toBe(0)

		// Frozen patches must be analyzed without any write attempt.
		const frozen = Object.freeze([
			Object.freeze(patch("replace", ["a"], 1))
		]) as Patch[]
		expect(() =>
			analyzePatchConflicts(frozen, [patch("replace", ["b"], 2)])
		).not.toThrow()
	})

	it("works with patches produced by produceWithPatches", () => {
		const base = {
			profile: {name: "Michel", age: 34},
			settings: {theme: "light"}
		}
		const [, patchesA] = produceWithPatches(base, draft => {
			draft.profile.name = "Sara"
		})
		const [, patchesB] = produceWithPatches(base, draft => {
			draft.settings.theme = "dark"
		})
		expect(analyzePatchConflicts(patchesA, patchesB).canMerge).toBe(true)

		const [, patchesC] = produceWithPatches(base, draft => {
			draft.profile = {name: "Root", age: 0}
		})
		const report = analyzePatchConflicts(patchesA, patchesC)
		expect(report.canMerge).toBe(false)
		expect(report.conflicts[0].reason).toBe(
			PatchConflictReason.AncestorOverride
		)
	})

	it("prints positions, ops, paths and reasons for every conflict", () => {
		const a = [
			patch("remove", ["items", 0]),
			patch("replace", ["profile", "name"], "x")
		]
		const b = [
			patch("replace", ["items", 2], "v"),
			patch("replace", ["profile", "name"], "y")
		]
		const report = analyzePatchConflicts(a, b)
		const printed = formatPatchConflicts(report)
		expect(printed.split("\n")).toHaveLength(2)
		expect(printed).toContain(PatchConflictReason.ArrayIndexShift)
		expect(printed).toContain(PatchConflictReason.SamePath)
		expect(printed).toContain("a[0]")
		expect(printed).toContain("b[0]")
		expect(printed).toContain("a[1]")
		expect(printed).toContain("b[1]")
		expect(printed).toContain("remove")
		expect(printed).toContain('["items",0]')
	})

	it("prints an all-clear message when there are no conflicts", () => {
		expect(
			formatPatchConflicts(
				analyzePatchConflicts(
					[patch("replace", ["a"], 1)],
					[patch("replace", ["b"], 2)]
				)
			)
		).toMatch(/no patch conflicts/i)
	})
})
