import {
	applyPatches,
	enableMapSet,
	enablePatches,
	freeze,
	produceWithPatches,
	rebasePatches,
	Patch
} from "../src/immer"

enablePatches()
enableMapSet()

function merge(base: any, local: Patch[], incoming: Patch[]) {
	const localState = applyPatches(base, local)
	const result = rebasePatches(base, local, incoming)
	const merged =
		result.conflicts.length > 0
			? undefined
			: applyPatches(localState, result.patches)
	const restored =
		merged === undefined
			? undefined
			: applyPatches(merged, result.inversePatches)
	return {localState, merged, restored, ...result}
}

describe("rebasePatches", () => {
	test("acceptance: local removes A, incoming replaces original B", () => {
		const base = {items: ["A", "B", "C"]}
		const local: Patch[] = [{op: "remove", path: ["items", 0]}]
		const incoming: Patch[] = [{op: "replace", path: ["items", 1], value: "B2"}]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		// original B now lives at index 0 after A was removed
		expect(r.patches).toEqual([{op: "replace", path: ["items", 0], value: "B2"}])
		expect(r.merged).toEqual({items: ["B2", "C"]}) // C is preserved
		expect(r.restored).toEqual({items: ["B", "C"]}) // exact local state
	})

	test("same-gap inserts: local elements come first", () => {
		const base = {items: ["A", "B"]}
		const local: Patch[] = [
			{op: "add", path: ["items", 1], value: "L1"},
			{op: "add", path: ["items", 2], value: "L2"}
		]
		const incoming: Patch[] = [
			{op: "add", path: ["items", 1], value: "I1"},
			{op: "add", path: ["items", 2], value: "I2"}
		]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual([
			{op: "add", path: ["items", 3], value: "I1"},
			{op: "add", path: ["items", 4], value: "I2"}
		])
		expect(r.merged).toEqual({items: ["A", "L1", "L2", "I1", "I2", "B"]})
		expect(r.restored).toEqual({items: ["A", "L1", "L2", "B"]})
	})

	test("delete original B vs modify original B conflicts", () => {
		const base = {items: ["A", "B", "C"]}
		const local: Patch[] = [{op: "remove", path: ["items", 1]}]
		const incoming: Patch[] = [{op: "replace", path: ["items", 1], value: "B2"}]

		const r = rebasePatches(base, local, incoming)
		expect(r.patches).toEqual([])
		expect(r.inversePatches).toEqual([])
		expect(r.conflicts).toHaveLength(1)
		expect(r.conflicts[0].localIndex).toBe(0)
		expect(r.conflicts[0].incomingIndex).toBe(0)
		expect(r.conflicts[0].path).toEqual(["items", 1])
	})

	test("different object properties merge independently", () => {
		const base = {a: 1, b: 2}
		const local: Patch[] = [{op: "replace", path: ["a"], value: 10}]
		const incoming: Patch[] = [{op: "replace", path: ["b"], value: 20}]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual(incoming)
		expect(r.merged).toEqual({a: 10, b: 20})
		expect(r.restored).toEqual({a: 10, b: 2})
	})

	test("same-path replace with same value is a duplicate", () => {
		const base = {a: 1}
		const local: Patch[] = [{op: "replace", path: ["a"], value: 10}]
		const incoming: Patch[] = [{op: "replace", path: ["a"], value: 10}]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual([]) // dropped as duplicate
		expect(r.merged).toEqual({a: 10})
		expect(r.restored).toEqual({a: 10})
	})

	test("same-path replace with different values conflicts", () => {
		const base = {a: 1}
		const local: Patch[] = [{op: "replace", path: ["a"], value: 10}]
		const incoming: Patch[] = [{op: "replace", path: ["a"], value: 20}]

		const r = rebasePatches(base, local, incoming)
		expect(r.patches).toEqual([])
		expect(r.conflicts).toHaveLength(1)
		expect(r.conflicts[0].path).toEqual(["a"])
	})

	test("remove vs modify on the same object key conflicts", () => {
		const base = {a: 1}
		const local: Patch[] = [{op: "remove", path: ["a"]}]
		const incoming: Patch[] = [{op: "replace", path: ["a"], value: 2}]

		const r = rebasePatches(base, local, incoming)
		expect(r.conflicts).toHaveLength(1)
		expect(r.conflicts[0].path).toEqual(["a"])
	})

	test("replace ancestor vs modify descendant conflicts, both directions", () => {
		const base = {obj: {x: 1, y: 2}}

		const r1 = rebasePatches(
			base,
			[{op: "replace", path: ["obj"], value: {z: 3}}],
			[{op: "replace", path: ["obj", "x"], value: 10}]
		)
		expect(r1.conflicts).toHaveLength(1)
		expect(r1.conflicts[0].path).toEqual(["obj"])

		const r2 = rebasePatches(
			base,
			[{op: "replace", path: ["obj", "x"], value: 10}],
			[{op: "replace", path: ["obj"], value: {z: 3}}]
		)
		expect(r2.conflicts).toHaveLength(1)
		expect(r2.conflicts[0].path).toEqual(["obj"])
	})

	test("remove ancestor vs modify descendant conflicts", () => {
		const base = {obj: {x: 1}}
		const r = rebasePatches(
			base,
			[{op: "remove", path: ["obj"]}],
			[{op: "replace", path: ["obj", "x"], value: 10}]
		)
		expect(r.conflicts).toHaveLength(1)
		expect(r.conflicts[0].path).toEqual(["obj"])
	})

	test("nested arrays with multiple index shifts", () => {
		const base = {
			rows: [
				{id: "r0", cells: [1, 2, 3]},
				{id: "r1", cells: [4, 5, 6]},
				{id: "r2", cells: [7, 8, 9]}
			]
		}
		const local: Patch[] = [{op: "remove", path: ["rows", 0]}] // drop r0
		const incoming: Patch[] = [
			{op: "remove", path: ["rows", 2, "cells", 0]}, // r2: drop 7
			{op: "replace", path: ["rows", 2, "cells", 0], value: 70} // r2: 8 -> 70
		]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual([
			{op: "remove", path: ["rows", 1, "cells", 0]},
			{op: "replace", path: ["rows", 1, "cells", 0], value: 70}
		])
		expect(r.merged).toEqual({
			rows: [
				{id: "r1", cells: [4, 5, 6]},
				{id: "r2", cells: [70, 9]}
			]
		})
		expect(r.restored).toEqual(r.localState)
	})

	test("multiple index shifts across remove, insert and replace", () => {
		const base = {items: ["A", "B", "C", "D"]}
		const local: Patch[] = [
			{op: "remove", path: ["items", 0]}, // drop A
			{op: "add", path: ["items", 1], value: "L"} // [B, L, C, D]
		]
		const incoming: Patch[] = [
			{op: "replace", path: ["items", 3], value: "D2"}, // original D
			{op: "remove", path: ["items", 1]} // original B
		]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual([
			{op: "replace", path: ["items", 3], value: "D2"},
			{op: "remove", path: ["items", 0]}
		])
		expect(r.merged).toEqual({items: ["L", "C", "D2"]})
		expect(r.restored).toEqual({items: ["B", "L", "C", "D"]})
	})

	test("both sides remove the same element: duplicate, not a conflict", () => {
		const base = {items: ["A", "B", "C"]}
		const local: Patch[] = [{op: "remove", path: ["items", 1]}]
		const incoming: Patch[] = [
			{op: "replace", path: ["items", 2], value: "C2"},
			{op: "remove", path: ["items", 1]}
		]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		// duplicate remove dropped; C moved to index 1
		expect(r.patches).toEqual([{op: "replace", path: ["items", 1], value: "C2"}])
		expect(r.merged).toEqual({items: ["A", "C2"]})
		expect(r.restored).toEqual({items: ["A", "C"]})
	})

	test("object keys containing slashes", () => {
		const base = {"a/b": {"c/d": 1}}
		const local: Patch[] = [{op: "replace", path: ["a/b", "c/d"], value: 2}]
		const incoming: Patch[] = [{op: "add", path: ["a/b", "e/f"], value: 3}]

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.merged).toEqual({"a/b": {"c/d": 2, "e/f": 3}})
		expect(r.restored).toEqual({"a/b": {"c/d": 2}})

		// same slash key, same value -> duplicate
		const dup = rebasePatches(
			base,
			[{op: "replace", path: ["a/b", "c/d"], value: 9}],
			[{op: "replace", path: ["a/b", "c/d"], value: 9}]
		)
		expect(dup.conflicts).toEqual([])
		expect(dup.patches).toEqual([])
	})

	test("frozen base and frozen patch lists are not modified", () => {
		const base = freeze({items: ["A", "B", "C"], obj: {x: 1}}, true)
		const local = freeze([{op: "remove", path: ["items", 0]}], true)
		const incoming = freeze(
			[{op: "replace", path: ["items", 1], value: "B2"}],
			true
		)

		const r = rebasePatches(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.patches).toEqual([{op: "replace", path: ["items", 0], value: "B2"}])
		expect(base).toEqual({items: ["A", "B", "C"], obj: {x: 1}})
		expect(local).toEqual([{op: "remove", path: ["items", 0]}])
		expect(incoming).toEqual([{op: "replace", path: ["items", 1], value: "B2"}])
	})

	test("works with patches generated by produceWithPatches", () => {
		const base = {items: ["A", "B", "C"], n: 1}
		const [, local] = produceWithPatches(base, (d: any) => {
			d.items.splice(0, 1) // delete A
			d.n = 2
		})
		const [, incoming] = produceWithPatches(base, (d: any) => {
			d.items.push("D")
		})

		const r = merge(base, local, incoming)
		expect(r.conflicts).toEqual([])
		expect(r.merged).toEqual({items: ["B", "C", "D"], n: 2})
		expect(r.restored).toEqual({items: ["B", "C"], n: 2})
	})

	test("Map/Set patches are explicitly rejected", () => {
		expect(() => rebasePatches(new Map(), [], [])).toThrow(/Map\/Set/)
		expect(() =>
			rebasePatches({m: new Map([["a", 1]])}, [], [
				{op: "replace", path: ["m", "a"], value: 2}
			])
		).toThrow(/Map\/Set/)
		expect(() =>
			rebasePatches({}, [], [{op: "add", path: ["s"], value: new Set([1])}])
		).toThrow(/Map\/Set/)
		expect(() =>
			rebasePatches({s: new Set([1])}, [{op: "add", path: ["s", 0], value: 2}], [])
		).toThrow(/Map\/Set/)
	})

	test("empty incoming patches rebase to nothing", () => {
		const r = rebasePatches({a: 1}, [{op: "replace", path: ["a"], value: 2}], [])
		expect(r).toEqual({patches: [], inversePatches: [], conflicts: []})
	})
})
