"use strict"
import {
	produce,
	produceWithPatches,
	applyPatches,
	compactPatches,
	enablePatches,
	enableMapSet,
	freeze
} from "../src/immer"

enablePatches()
enableMapSet()

// Applies the original patches and the compacted patches to `base` and
// verifies that both produce the same result, that the compacted inverse
// patches restore `base`, and that the restored state can be transformed
// into the result again by re-applying the compacted patches.
function expectCompacted(base, patches) {
	const expected = applyPatches(base, patches)
	const [compacted, inverse] = compactPatches(base, patches)

	const result = applyPatches(base, compacted)
	expect(result).toEqual(expected)

	const restored = applyPatches(result, inverse)
	expect(restored).toEqual(base)

	// verify the restore itself is reversible
	const reapplied = applyPatches(restored, compacted)
	expect(reapplied).toEqual(expected)

	return {compacted, inverse, result, restored, expected}
}

describe("compactPatches", () => {
	test("empty patch sequence", () => {
		expect(compactPatches({a: 1}, [])).toEqual([[], []])
	})

	test("merges consecutive writes to the same path", () => {
		const base = {x: 1}
		const patches = [
			{op: "replace", path: ["x"], value: 2},
			{op: "replace", path: ["x"], value: 3}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([{op: "replace", path: ["x"], value: 3}])
		expect(inverse).toEqual([{op: "replace", path: ["x"], value: 1}])
	})

	test("drops add-then-remove of a new key", () => {
		const base = {a: 1}
		const patches = [
			{op: "add", path: ["b"], value: 2},
			{op: "remove", path: ["b"]}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
	})

	test("drops remove-then-readd of an unchanged value", () => {
		const base = {a: 1, b: 2}
		const patches = [
			{op: "remove", path: ["b"]},
			{op: "add", path: ["b"], value: 2}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
	})

	test("merges writes into values added by earlier patches", () => {
		const base = {}
		const patches = [
			{op: "add", path: ["a"], value: {x: 1}},
			{op: "replace", path: ["a", "x"], value: 2}
		]
		const {compacted} = expectCompacted(base, patches)
		expect(compacted).toEqual([{op: "add", path: ["a"], value: {x: 2}}])
	})

	test("parent replacement absorbs earlier child writes", () => {
		const base = {a: {x: 1}, b: 1}
		const patches = [
			{op: "replace", path: ["a", "x"], value: 5},
			{op: "replace", path: ["a"], value: {y: 9}}
		]
		const {compacted} = expectCompacted(base, patches)
		expect(compacted).toEqual([{op: "replace", path: ["a"], value: {y: 9}}])
	})

	test("array remove followed by write keeps index drift semantics", () => {
		const base = [1, 2, 3]
		const patches = [
			{op: "remove", path: [0]},
			{op: "replace", path: [1], value: 9}
		]
		const {compacted, inverse, expected} = expectCompacted(base, patches)
		expect(expected).toEqual([2, 9])
		expect(compacted).toEqual([
			{op: "replace", path: [0], value: 2},
			{op: "replace", path: [1], value: 9},
			{op: "remove", path: [2]}
		])
		expect(inverse).toEqual([
			{op: "replace", path: [0], value: 1},
			{op: "replace", path: [1], value: 2},
			{op: "add", path: [2], value: 3}
		])
	})

	test("array insert then remove at the same index cancels out", () => {
		const base = [1, 2, 3]
		const patches = [
			{op: "add", path: [1], value: 9},
			{op: "remove", path: [1]}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
	})

	test("root replacement discards earlier patches", () => {
		const base = {a: 1}
		const patches = [
			{op: "replace", path: ["a"], value: 100},
			{op: "replace", path: [], value: {b: 2}},
			{op: "replace", path: ["b"], value: 3}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([
			{op: "replace", path: [], value: {b: 2}},
			{op: "replace", path: ["b"], value: 3}
		])
		expect(inverse).toEqual([
			{op: "replace", path: ["b"], value: 2},
			{op: "replace", path: [], value: {a: 1}}
		])
	})

	test("root replacement with a non-draftable value", () => {
		const base = {a: 1}
		const patches = [{op: "replace", path: [], value: 42}]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([{op: "replace", path: [], value: 42}])
		expect(inverse).toEqual([{op: "replace", path: [], value: {a: 1}}])
		expect(applyPatches(base, compacted)).toBe(42)
		expect(applyPatches(applyPatches(base, compacted), inverse)).toEqual(base)
	})

	test("handles empty string keys", () => {
		const base = {"": 1, a: {"": 2}}
		const patches = [
			{op: "replace", path: [""], value: 10},
			{op: "replace", path: ["a", ""], value: 20},
			{op: "replace", path: ["a", ""], value: 30}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([
			{op: "replace", path: ["a", ""], value: 30},
			{op: "replace", path: [""], value: 10}
		])
		expect(inverse).toEqual([
			{op: "replace", path: ["a", ""], value: 2},
			{op: "replace", path: [""], value: 1}
		])
	})

	test("merges Map writes with object keys", () => {
		const key = {id: 1}
		const base = new Map([[key, 1]])
		const patches = [
			{op: "replace", path: [key], value: 2},
			{op: "replace", path: [key], value: 3}
		]
		const {compacted, inverse, result, restored} = expectCompacted(
			base,
			patches
		)
		expect(compacted).toHaveLength(1)
		expect(compacted[0].op).toBe("replace")
		expect(compacted[0].path[0]).toBe(key)
		expect(compacted[0].value).toBe(3)
		expect(inverse).toHaveLength(1)
		expect(inverse[0].path[0]).toBe(key)
		expect(inverse[0].value).toBe(1)
		expect(result.get(key)).toBe(3)
		expect(restored.get(key)).toBe(1)
	})

	test("drops Map add-then-remove of a new key", () => {
		const key = {id: 2}
		const base = new Map()
		const patches = [
			{op: "add", path: [key], value: 1},
			{op: "remove", path: [key]}
		]
		const {compacted, inverse} = expectCompacted(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
	})

	test("Set patches cancel out and stay reversible", () => {
		const base = new Set([1, 2, 3])
		const patches = [
			{op: "remove", path: [1], value: 2},
			{op: "add", path: [3], value: 4},
			{op: "add", path: [4], value: 5},
			{op: "remove", path: [4], value: 5}
		]
		const {compacted, result, restored} = expectCompacted(base, patches)
		// the add/remove of 5 cancels out and must not show up at all
		expect(compacted.some(p => p.value === 5)).toBe(false)
		expect(result).toEqual(new Set([1, 3, 4]))
		expect(restored).toEqual(new Set([1, 2, 3]))
	})

	test("works with a frozen base", () => {
		const base = freeze({x: 1, arr: [1, 2, 3], nested: {y: 2}}, true)
		const patches = [
			{op: "replace", path: ["x"], value: 2},
			{op: "replace", path: ["x"], value: 3},
			{op: "remove", path: ["arr", 0]},
			{op: "replace", path: ["nested", "y"], value: 5}
		]
		const {compacted, result, restored} = expectCompacted(base, patches)
		expect(compacted).toEqual([
			{op: "replace", path: ["nested", "y"], value: 5},
			{op: "replace", path: ["arr", 0], value: 2},
			{op: "replace", path: ["arr", 1], value: 3},
			{op: "remove", path: ["arr", 2]},
			{op: "replace", path: ["x"], value: 3}
		])
		expect(result).toEqual({x: 3, arr: [2, 3], nested: {y: 5}})
		expect(restored).toEqual({x: 1, arr: [1, 2, 3], nested: {y: 2}})
	})

	test("compacts patches recorded from produceWithPatches", () => {
		const base = {x: 1, list: [1, 2]}
		const [, patches] = produceWithPatches(base, d => {
			d.x = 2
			d.x = 3
			d.list.push(4)
			d.list.shift()
			delete d.list[0]
			d.list.length = 0
		})
		const {compacted} = expectCompacted(base, patches)
		expect(compacted).toEqual([
			{op: "remove", path: ["list", 1]},
			{op: "remove", path: ["list", 0]},
			{op: "replace", path: ["x"], value: 3}
		])
	})

	describe("differential testing with random patch sequences", () => {
		// seeded PRNG (mulberry32) for reproducibility
		function createRng(seed) {
			let a = seed >>> 0
			return () => {
				a |= 0
				a = (a + 0x6d2b79f5) | 0
				let t = Math.imul(a ^ (a >>> 15), 1 | a)
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296
			}
		}

		function randomBase(rng) {
			const int = () => Math.floor(rng() * 10)
			return {
				a: int(),
				b: {c: [int(), int(), int()], d: "x" + int()},
				e: [{f: int()}, {f: int()}]
			}
		}

		function randomMutation(rng) {
			const int = () => Math.floor(rng() * 10)
			const pick = arr => arr[Math.floor(rng() * arr.length)]
			const mutations = [
				d => {
					d.a = int()
				},
				d => {
					d.b.c.push(int())
				},
				d => {
					if (d.b.c.length) d.b.c.splice(Math.floor(rng() * d.b.c.length), 1)
				},
				d => {
					d.b.c[Math.floor(rng() * d.b.c.length)] = int()
				},
				d => {
					d.b.d = "s" + int()
				},
				d => {
					d.e[Math.floor(rng() * d.e.length)].f = int()
				},
				d => {
					d.e.push({f: int()})
				},
				d => {
					if (d.e.length > 1) d.e.splice(Math.floor(rng() * d.e.length), 1)
				},
				d => {
					d["k" + (int() % 3)] = int()
				},
				d => {
					delete d["k" + (int() % 3)]
				},
				d => {
					d.b = {c: [int()], d: "r" + int()}
				}
			]
			return pick(mutations)
		}

		for (let seed = 1; seed <= 25; seed++) {
			test("random sequence, seed " + seed, () => {
				const rng = createRng(seed)
				const base = randomBase(rng)

				// build a patch sequence by recording several produce steps;
				// consecutive steps create redundant and drifting changes
				let state = base
				let patches = []
				const steps = 2 + Math.floor(rng() * 5)
				for (let i = 0; i < steps; i++) {
					const [next, stepPatches] = produceWithPatches(state, d => {
						const count = 1 + Math.floor(rng() * 3)
						for (let j = 0; j < count; j++) {
							randomMutation(rng)(d)
						}
					})
					patches.push(...stepPatches)
					state = next
				}

				const [compacted, inverse] = compactPatches(base, patches)
				const result = applyPatches(base, compacted)
				const restored = applyPatches(result, inverse)
				const reapplied = applyPatches(restored, compacted)

				expect(result).toEqual(state)
				expect(restored).toEqual(base)
				expect(reapplied).toEqual(state)
			})
		}
	})
})
