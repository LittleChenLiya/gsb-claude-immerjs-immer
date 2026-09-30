import {
	enablePatches,
	enableMapSet,
	produceWithPatches,
	applyPatches,
	compactPatches,
	freeze
} from "../src/immer"

enablePatches()
enableMapSet()

// compares patch arrays regardless of order; application order correctness
// is verified separately by applying (inverse) patches
function expectPatches(actual, expected) {
	const sort = ps => ps.map(p => JSON.stringify(p)).sort()
	expect(sort(actual)).toEqual(sort(expected))
}

describe("compactPatches", () => {
	test("merges consecutive writes to the same path", () => {
		const base = {x: 1}
		const patches = [
			{op: "replace", path: ["x"], value: 2},
			{op: "replace", path: ["x"], value: 3}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([{op: "replace", path: ["x"], value: 3}])
		expect(inverse).toEqual([{op: "replace", path: ["x"], value: 1}])
		expect(applyPatches(base, compacted)).toEqual({x: 3})
	})

	test("drops add-then-delete no-op changes", () => {
		const base = {a: 1}
		const patches = [
			{op: "add", path: ["b"], value: 2},
			{op: "remove", path: ["b"]}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
		expect(applyPatches(base, compacted)).toEqual(base)
	})

	test("drops delete-then-re-add with original value", () => {
		const base = {a: 1}
		const patches = [
			{op: "remove", path: ["a"]},
			{op: "add", path: ["a"], value: 1}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
	})

	test("empty patch sequence", () => {
		expect(compactPatches({a: 1}, [])).toEqual([[], []])
	})

	test("array: remove index 0 then write index 1 stays consistent and reversible", () => {
		const base = ["a", "b", "c"]
		const patches = [
			{op: "remove", path: [0]},
			{op: "replace", path: [1], value: "X"}
		]
		const expected = applyPatches(base, patches)
		expect(expected).toEqual(["b", "X"])

		const [compacted, inverse] = compactPatches(base, patches)
		const result = applyPatches(base, compacted)
		expect(result).toEqual(expected)

		// inverse restores the base...
		const restored = applyPatches(result, inverse)
		expect(restored).toEqual(base)
		// ...and the restored state can be redone with the compacted patches
		expect(applyPatches(restored, compacted)).toEqual(expected)
	})

	test("array insert/remove index drift is handled semantically", () => {
		const base = [1, 2, 3]
		// insert at 0, then remove the inserted element again: a no-op
		const patches = [
			{op: "add", path: [0], value: 0},
			{op: "remove", path: [0]}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([])
		expect(inverse).toEqual([])
		expect(applyPatches(base, compacted)).toEqual(base)
	})

	test("parent path replacement subsumes earlier child writes", () => {
		const base = {a: {b: 1, c: 2}}
		const patches = [
			{op: "replace", path: ["a", "b"], value: 10},
			{op: "replace", path: ["a"], value: {d: 4}}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([{op: "replace", path: ["a"], value: {d: 4}}])
		expect(applyPatches(base, compacted)).toEqual({a: {d: 4}})
		expect(applyPatches(applyPatches(base, compacted), inverse)).toEqual(base)
	})

	test("root replacement", () => {
		const base = {a: 1}
		const patches = [
			{op: "replace", path: ["a"], value: 2},
			{op: "replace", path: [], value: {b: 1}},
			{op: "add", path: ["c"], value: 3}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([{op: "replace", path: [], value: {b: 1, c: 3}}])
		expect(inverse).toEqual([{op: "replace", path: [], value: {a: 1}}])
		const result = applyPatches(base, compacted)
		expect(result).toEqual({b: 1, c: 3})
		expect(applyPatches(result, inverse)).toEqual(base)
	})

	test("empty string keys", () => {
		const base = {"": 1, a: {"": 2}}
		const patches = [
			{op: "replace", path: [""], value: 2},
			{op: "replace", path: [""], value: 3},
			{op: "replace", path: ["a", ""], value: 5}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expectPatches(compacted, [
			{op: "replace", path: [""], value: 3},
			{op: "replace", path: ["a", ""], value: 5}
		])
		const result = applyPatches(base, compacted)
		expect(result).toEqual({"": 3, a: {"": 5}})
		expect(applyPatches(result, inverse)).toEqual(base)
	})

	test("Map with object keys", () => {
		const k1 = {id: 1}
		const k2 = {id: 2}
		const base = new Map([[k1, 1]])
		const patches = [
			{op: "replace", path: [k1], value: 2},
			{op: "replace", path: [k1], value: 3},
			{op: "add", path: [k2], value: 9},
			{op: "remove", path: [k2]}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expect(compacted).toEqual([{op: "replace", path: [k1], value: 3}])
		expect(inverse).toEqual([{op: "replace", path: [k1], value: 1}])

		const result = applyPatches(base, compacted)
		expect(result.get(k1)).toBe(3)
		expect(result.has(k2)).toBe(false)
		const restored = applyPatches(result, inverse)
		expect(restored).toEqual(base)
	})

	test("Set patches", () => {
		const base = new Set([1, 2])
		const patches = [
			{op: "remove", path: [0], value: 1},
			{op: "add", path: [1], value: 3},
			{op: "add", path: [2], value: 4},
			{op: "remove", path: [2], value: 4}
		]
		const expected = applyPatches(base, patches)
		const [compacted, inverse] = compactPatches(base, patches)
		const result = applyPatches(base, compacted)
		expect(result).toEqual(expected)
		expect(result).toEqual(new Set([2, 3]))
		expect(applyPatches(result, inverse)).toEqual(base)
	})

	test("frozen base state", () => {
		const base = freeze({x: 1, nested: {y: 2}, arr: [1, 2]}, true)
		const patches = [
			{op: "replace", path: ["x"], value: 2},
			{op: "replace", path: ["x"], value: 3},
			{op: "replace", path: ["nested", "y"], value: 4},
			{op: "add", path: ["arr", 2], value: 5}
		]
		const [compacted, inverse] = compactPatches(base, patches)
		expectPatches(compacted, [
			{op: "replace", path: ["x"], value: 3},
			{op: "replace", path: ["nested", "y"], value: 4},
			{op: "add", path: ["arr", 2], value: 5}
		])
		// base is untouched
		expect(base).toEqual({x: 1, nested: {y: 2}, arr: [1, 2]})
		const result = applyPatches(base, compacted)
		expect(result).toEqual({x: 3, nested: {y: 4}, arr: [1, 2, 5]})
		expect(applyPatches(result, inverse)).toEqual(base)
	})

	describe("differential testing with random patch sequences", () => {
		// deterministic PRNG so failures are reproducible
		function mulberry32(seed) {
			return function () {
				seed |= 0
				seed = (seed + 0x6d2b79f5) | 0
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296
			}
		}

		function randomValue(rnd) {
			return Math.floor(rnd() * 10)
		}

		function randomMutation(rnd) {
			return draft => {
				switch (Math.floor(rnd() * 8)) {
					case 0:
						draft.num = randomValue(rnd)
						break
					case 1:
						draft.obj.a = randomValue(rnd)
						break
					case 2:
						draft.obj = {a: randomValue(rnd), b: randomValue(rnd)}
						break
					case 3:
						draft.arr.push(randomValue(rnd))
						break
					case 4:
						if (draft.arr.length) {
							draft.arr.splice(Math.floor(rnd() * draft.arr.length), 1)
						}
						break
					case 5:
						if (draft.arr.length) {
							draft.arr[Math.floor(rnd() * draft.arr.length)] = randomValue(rnd)
						}
						break
					case 6:
						draft.map.set("k" + Math.floor(rnd() * 3), randomValue(rnd))
						break
					case 7:
						if (rnd() < 0.5) {
							draft.set.add(randomValue(rnd))
						} else {
							draft.set.delete(randomValue(rnd))
						}
						break
				}
			}
		}

		function freshBase(rnd) {
			return {
				num: randomValue(rnd),
				obj: {a: randomValue(rnd), b: randomValue(rnd)},
				arr: [randomValue(rnd), randomValue(rnd)],
				map: new Map([["k0", randomValue(rnd)]]),
				set: new Set([randomValue(rnd)])
			}
		}

		for (let seed = 1; seed <= 25; seed++) {
			test("random sequence #" + seed, () => {
				const rnd = mulberry32(seed)
				const base = freshBase(rnd)

				// build a short random patch sequence via produceWithPatches
				const patches = []
				let expected = base
				const steps = 1 + Math.floor(rnd() * 6)
				for (let i = 0; i < steps; i++) {
					const [next, stepPatches] = produceWithPatches(
						expected,
						rnd() < 0.1
							? () => freshBase(rnd) // occasional root replacement
							: randomMutation(rnd)
					)
					patches.push(...stepPatches)
					expected = next
				}

				// sanity: the sequence applied to base yields the expected state
				expect(applyPatches(base, patches)).toEqual(expected)

				const [compacted, inverse] = compactPatches(base, patches)

				// compacted patches produce the same result
				const result = applyPatches(base, compacted)
				expect(result).toEqual(expected)

				// inverse patches restore the base
				const restored = applyPatches(result, inverse)
				expect(restored).toEqual(base)

				// and the restored state can be advanced again
				expect(applyPatches(restored, compacted)).toEqual(expected)
			})
		}
	})
})
