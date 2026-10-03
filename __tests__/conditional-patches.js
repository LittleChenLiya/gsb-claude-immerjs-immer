"use strict"
import {
	applyPatchesIf,
	enablePatches,
	enableMapSet,
	produce
} from "../src/immer"

enablePatches()
enableMapSet()

describe("applyPatchesIf", () => {
	it("accepts when the old value matches", () => {
		const base = {count: 2}
		const result = applyPatchesIf(
			base,
			[{op: "replace", path: ["count"], value: 3}],
			[{value: 2}]
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.result).toEqual({count: 3})
		}
	})

	it("rejects when the old value does not match and applies nothing", () => {
		const base = {count: 2, other: "keep"}
		const result = applyPatchesIf(
			base,
			[
				{op: "replace", path: ["count"], value: 3},
				{op: "replace", path: ["other"], value: "changed"}
			],
			[{value: 1}, {}]
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.path).toEqual(["count"])
			expect(result.reason).toBe("value-mismatch")
		}
		// The original base is untouched.
		expect(base).toEqual({count: 2, other: "keep"})
	})

	it("distinguishes a missing key from a key whose value is undefined", () => {
		const base = {present: undefined}

		// Key exists (value is undefined) -> exists: true passes.
		const ok = applyPatchesIf(
			base,
			[{op: "replace", path: ["present"], value: 1}],
			[{exists: true}]
		)
		expect(ok.ok).toBe(true)

		// Key exists (value is undefined) -> exists: false fails.
		const existsFail = applyPatchesIf(
			base,
			[{op: "replace", path: ["present"], value: 1}],
			[{exists: false}]
		)
		expect(existsFail.ok).toBe(false)
		if (!existsFail.ok) {
			expect(existsFail.reason).toBe("exists")
		}

		// Missing key -> exists: true fails.
		const missingFail = applyPatchesIf(
			base,
			[{op: "replace", path: ["absent"], value: 1}],
			[{exists: true}]
		)
		expect(missingFail.ok).toBe(false)
		if (!missingFail.ok) {
			expect(missingFail.reason).toBe("not-exists")
		}

		// Missing key -> exists: false passes.
		const missingOk = applyPatchesIf(
			base,
			[{op: "add", path: ["absent"], value: 1}],
			[{exists: false}]
		)
		expect(missingOk.ok).toBe(true)
	})

	it("checks array conditions against the original base, not intermediate results", () => {
		const base = {items: [10, 20, 30]}
		// First patch changes items[0] from 10 to 99.
		// Second patch's condition expects items[0] to still be 10 (original base).
		const result = applyPatchesIf(
			base,
			[
				{op: "replace", path: ["items", 0], value: 99},
				{op: "replace", path: ["items", 1], value: 98}
			],
			[{}, {path: ["items", 0], value: 10}]
		)
		// The second condition checks the original base (items[0] === 10),
		// so it passes even though the first patch would have changed it.
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.result.items).toEqual([99, 98, 30])
		}
	})

	it("rejects array conditions based on the original base", () => {
		const base = {items: [10, 20, 30]}
		const result = applyPatchesIf(
			base,
			[
				{op: "replace", path: ["items", 0], value: 99},
				{op: "replace", path: ["items", 1], value: 98}
			],
			[{}, {path: ["items", 0], value: 99}] // expects the already-changed value
		)
		// The original base has items[0] === 10, not 99, so it rejects.
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.path).toEqual(["items", 0])
			expect(result.reason).toBe("value-mismatch")
		}
	})

	it("works with Maps", () => {
		const base = new Map([["count", 2]])
		const result = applyPatchesIf(
			base,
			[{op: "replace", path: ["count"], value: 3}],
			[{value: 2}]
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.result.get("count")).toBe(3)
		}

		// Missing key in Map.
		const missing = applyPatchesIf(
			base,
			[{op: "replace", path: ["absent"], value: 1}],
			[{exists: true}]
		)
		expect(missing.ok).toBe(false)
		if (!missing.ok) {
			expect(missing.reason).toBe("not-exists")
		}
	})

	it("supports root replacement conditions", () => {
		const base = {count: 2}
		const result = applyPatchesIf(
			base,
			[{op: "replace", path: [], value: {count: 3}}],
			[{path: [], value: base}]
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.result).toEqual({count: 3})
		}

		// Root value mismatch.
		const wrong = applyPatchesIf(
			base,
			[{op: "replace", path: [], value: {count: 3}}],
			[{path: [], value: {count: 99}}]
		)
		expect(wrong.ok).toBe(false)
		if (!wrong.ok) {
			expect(wrong.reason).toBe("value-mismatch")
		}
	})

	it("rejects illegal paths without applying patches", () => {
		const base = {a: 1}
		const result = applyPatchesIf(
			base,
			[{op: "replace", path: ["b", "c"], value: 2}],
			[{}]
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.path).toEqual(["b", "c"])
			expect(result.reason).toBe("invalid-path")
		}
		expect(base).toEqual({a: 1})
	})

	it("does not invoke input getters during the condition check", () => {
		let getterCalls = 0
		const base = {
			count: 2,
			get sensitive() {
				getterCalls++
				return 999
			}
		}
		// Condition fails (count is 2, not 1), so no patches are applied.
		const result = applyPatchesIf(
			base,
			[{op: "replace", path: ["count"], value: 3}],
			[{value: 1}]
		)
		expect(result.ok).toBe(false)
		// The getter on `sensitive` was never called during the condition check.
		expect(getterCalls).toBe(0)
	})

	it("does not modify the original base", () => {
		const base = {count: 2, nested: {value: 1}}
		const snapshot = JSON.parse(JSON.stringify(base))
		applyPatchesIf(
			base,
			[
				{op: "replace", path: ["count"], value: 3},
				{op: "replace", path: ["nested", "value"], value: 2}
			],
			[{value: 2}, {path: ["nested", "value"], value: 1}]
		)
		expect(base).toEqual(snapshot)
	})

	it("returns the first failing condition location", () => {
		const base = {a: 1, b: 2, c: 3}
		const result = applyPatchesIf(
			base,
			[
				{op: "replace", path: ["a"], value: 10},
				{op: "replace", path: ["b"], value: 20},
				{op: "replace", path: ["c"], value: 30}
			],
			[{value: 1}, {value: 99}, {value: 3}]
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			// First condition passes (a === 1), second fails (b !== 99).
			expect(result.path).toEqual(["b"])
			expect(result.reason).toBe("value-mismatch")
		}
	})
})
