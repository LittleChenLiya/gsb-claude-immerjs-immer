"use strict"
import {
	applyPatchesWithConditions,
	enablePatches,
	enableMapSet
} from "../src/immer"

enablePatches()
enableMapSet()

describe("applyPatchesWithConditions", () => {
	describe("atomic apply with old-value preconditions", () => {
		test("matching old value applies the patch", () => {
			const base = {count: 2, other: "x"}
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: ["count"], value: 2}]
			)
			expect(res).toEqual({applied: true, result: {count: 3, other: "x"}})
			// base is not modified
			expect(base).toEqual({count: 2, other: "x"})
		})

		test("stale old value rejects everything, no other path changes", () => {
			const base = {count: 2, other: "x"}
			const res = applyPatchesWithConditions(
				base,
				[
					{op: "replace", path: ["count"], value: 3},
					{op: "replace", path: ["other"], value: "y"}
				],
				[{path: ["count"], value: 1}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure).toEqual({
				conditionIndex: 0,
				path: ["count"],
				at: 0,
				reason: "value-mismatch",
				expected: 1,
				actual: 2
			})
			// nothing was applied anywhere
			expect(base).toEqual({count: 2, other: "x"})
		})

		test("first failing condition is reported with its index", () => {
			const base = {a: 1, b: 2}
			const res = applyPatchesWithConditions(
				base,
				[
					{op: "replace", path: ["a"], value: 10},
					{op: "replace", path: ["b"], value: 20}
				],
				[
					{path: ["a"], value: 1},
					{path: ["b"], value: 999}
				]
			)
			expect(res.applied).toBe(false)
			expect(res.failure.conditionIndex).toBe(1)
			expect(res.failure.path).toEqual(["b"])
			expect(res.failure.reason).toBe("value-mismatch")
			expect(base).toEqual({a: 1, b: 2})
		})
	})

	describe("missing keys vs keys holding undefined", () => {
		const base = {u: undefined}

		test("existing key with undefined value counts as existing", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["u"], value: 1}],
				[{path: ["u"]}]
			)
			expect(res).toEqual({applied: true, result: {u: 1}})
		})

		test("missing key fails the default existence condition", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "add", path: ["v"], value: 1}],
				[{path: ["v"]}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure.reason).toBe("missing")
			expect(base).toEqual({u: undefined})
		})

		test("value undefined matches existing undefined, not a missing key", () => {
			const ok = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["u"], value: 2}],
				[{path: ["u"], value: undefined}]
			)
			expect(ok.applied).toBe(true)

			const rejected = applyPatchesWithConditions(
				base,
				[{op: "add", path: ["nope"], value: 2}],
				[{path: ["nope"], value: undefined}]
			)
			expect(rejected.applied).toBe(false)
			expect(rejected.failure.reason).toBe("missing")
		})

		test("exists:false requires absence and rejects existing undefined", () => {
			const absent = applyPatchesWithConditions(
				base,
				[{op: "add", path: ["fresh"], value: 1}],
				[{path: ["fresh"], exists: false}]
			)
			expect(absent).toEqual({
				applied: true,
				result: {u: undefined, fresh: 1}
			})

			const present = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["u"], value: 1}],
				[{path: ["u"], exists: false}]
			)
			expect(present.applied).toBe(false)
			expect(present.failure.reason).toBe("exists")
		})
	})

	describe("array conditions share one baseline", () => {
		test("conditions see the original base, not earlier patch results", () => {
			const base = {list: [1, 2, 3]}
			const res = applyPatchesWithConditions(
				base,
				[
					{op: "replace", path: ["list", 0], value: 10},
					{op: "replace", path: ["list", 1], value: 20}
				],
				[
					// both checked against the same original base
					{path: ["list", 0], value: 1},
					{path: ["list", 1], value: 2}
				]
			)
			expect(res).toEqual({applied: true, result: {list: [10, 20, 3]}})
			expect(base).toEqual({list: [1, 2, 3]})
		})

		test("removing index 0 does not shift the baseline", () => {
			const base = {list: [1, 2, 3]}
			// After removing index 0, list[1] would be 3 — but conditions are
			// checked against the original base, where list[1] is 2.
			const res = applyPatchesWithConditions(
				base,
				[{op: "remove", path: ["list", 0]}],
				[{path: ["list", 1], value: 2}]
			)
			expect(res).toEqual({applied: true, result: {list: [2, 3]}})

			const stale = applyPatchesWithConditions(
				base,
				[{op: "remove", path: ["list", 0]}],
				[{path: ["list", 1], value: 3}]
			)
			expect(stale.applied).toBe(false)
			expect(stale.failure.reason).toBe("value-mismatch")
			expect(base).toEqual({list: [1, 2, 3]})
		})
	})

	describe("Map semantics", () => {
		test("conditions and patches address Map keys", () => {
			const base = {scores: new Map([["ann", 2]])}
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["scores", "ann"], value: 3}],
				[{path: ["scores", "ann"], value: 2}]
			)
			expect(res.applied).toBe(true)
			expect(res.result.scores.get("ann")).toBe(3)
			// base map untouched
			expect(base.scores.get("ann")).toBe(2)
		})

		test("missing Map key vs existing key with undefined value", () => {
			const base = {m: new Map([["k", undefined]])}
			const ok = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["m", "k"], value: 1}],
				[{path: ["m", "k"], value: undefined}]
			)
			expect(ok.applied).toBe(true)

			const missing = applyPatchesWithConditions(
				base,
				[{op: "add", path: ["m", "nope"], value: 1}],
				[{path: ["m", "nope"]}]
			)
			expect(missing.applied).toBe(false)
			expect(missing.failure).toMatchObject({
				path: ["m", "nope"],
				at: 1,
				reason: "missing"
			})
		})

		test("non-string Map keys are addressable", () => {
			const base = new Map([[1, "one"]])
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: [1], value: "uno"}],
				[{path: [1], value: "one"}]
			)
			expect(res.applied).toBe(true)
			expect(res.result.get(1)).toBe("uno")
			expect(base.get(1)).toBe("one")
		})
	})

	describe("root replacement", () => {
		test("root-level conditions guard a whole-state replace", () => {
			const base = {count: 2}
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: [], value: {count: 3}}],
				[{path: ["count"], value: 2}]
			)
			expect(res).toEqual({applied: true, result: {count: 3}})
			expect(base).toEqual({count: 2})
		})

		test("empty path addresses the base itself", () => {
			const base = {count: 2}
			const ok = applyPatchesWithConditions(base, [], [{path: []}])
			expect(ok).toEqual({applied: true, result: {count: 2}})

			const mismatch = applyPatchesWithConditions(
				base,
				[],
				[{path: [], value: {count: 2}}]
			)
			// Object.is on distinct object identities fails
			expect(mismatch.applied).toBe(false)
			expect(mismatch.failure.reason).toBe("value-mismatch")

			const sameRef = applyPatchesWithConditions(
				base,
				[],
				[{path: [], value: base}]
			)
			expect(sameRef.applied).toBe(true)
		})
	})

	describe("invalid paths", () => {
		const base = {count: 2, nested: {a: 1}}

		test("descending into a primitive is an invalid path", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: ["count", "x"]}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure).toMatchObject({
				conditionIndex: 0,
				path: ["count", "x"],
				at: 1,
				reason: "invalid-path"
			})
			expect(base).toEqual({count: 2, nested: {a: 1}})
		})

		test("non-string/number path segments are invalid", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: [Symbol("s")]}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure.reason).toBe("invalid-path")
			expect(res.failure.at).toBe(0)
		})

		test("a missing intermediate key reports the failing segment", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: ["ghost", "deep"], value: 1}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure).toMatchObject({
				path: ["ghost", "deep"],
				at: 0,
				reason: "missing"
			})
		})

		test("malformed condition paths are rejected without applying", () => {
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: "count"}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure.reason).toBe("invalid-path")
			expect(base.count).toBe(2)
		})
	})

	describe("input getters are never invoked", () => {
		function baseWithGetter() {
			let calls = 0
			const base = {count: 2}
			// Non-enumerable on purpose: immer's own copy phase reads
			// enumerable getters when applying patches (pre-existing immer
			// behavior); the precondition check itself must never invoke any
			// getter, enumerable or not.
			Object.defineProperty(base, "spied", {
				enumerable: false,
				get() {
					calls++
					return 42
				}
			})
			return {base, calls: () => calls}
		}

		test("checking unrelated paths does not touch getters", () => {
			const {base, calls} = baseWithGetter()
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: ["count"], value: 2}]
			)
			expect(res.applied).toBe(true)
			expect(calls()).toBe(0)
		})

		test("a condition on a getter path fails instead of invoking it", () => {
			const {base, calls} = baseWithGetter()
			const res = applyPatchesWithConditions(
				base,
				[{op: "replace", path: ["count"], value: 3}],
				[{path: ["spied"], value: 42}]
			)
			expect(res.applied).toBe(false)
			expect(res.failure).toMatchObject({
				path: ["spied"],
				at: 0,
				reason: "getter"
			})
			expect(calls()).toBe(0)
			expect(base.count).toBe(2)
		})
	})

	describe("result shape", () => {
		test("empty conditions apply unconditionally", () => {
			const res = applyPatchesWithConditions(
				{a: 1},
				[{op: "replace", path: ["a"], value: 2}],
				[]
			)
			expect(res).toEqual({applied: true, result: {a: 2}})
		})

		test("non-array conditions throw", () => {
			expect(() => applyPatchesWithConditions({a: 1}, [], undefined)).toThrow()
		})
	})
})
