import {describe, test, expect} from "vitest"
import {
	produceWithPatches,
	applyPatches,
	patchesToRFC6902,
	RFC6902ConversionError,
	enablePatches,
	enableMapSet,
	nothing
} from "../src/immer"
import {parsePointer} from "../src/utils/rfc6902"

enablePatches()
enableMapSet()

/**
 * Minimal RFC 6902 applier for test verification.
 * Applies operations immutably (structural sharing along the path).
 */
function applyRFC6902(state: any, operations: any[]): any {
	let result = state
	for (const op of operations) {
		if (op.path === "") {
			result = op.value
			continue
		}
		const segments = parsePointer(op.path)
		const clone = structuredClone(result)
		let current = clone
		for (let i = 0; i < segments.length - 1; i++) {
			current = current[segments[i]]
		}
		const last = segments[segments.length - 1]
		switch (op.op) {
			case "add":
				if (Array.isArray(current)) {
					if (last === "-") current.push(op.value)
					else current.splice(Number(last), 0, op.value)
				} else {
					current[last] = op.value
				}
				break
			case "replace":
				current[last] = op.value
				break
			case "remove":
				if (Array.isArray(current)) current.splice(Number(last), 1)
				else delete current[last]
				break
		}
		result = clone
	}
	return result
}

describe("patchesToRFC6902", () => {
	test("object key '0' and array index 0 produce distinct pointers", () => {
		const base = {
			obj: {"0": "obj-zero"},
			arr: ["arr-zero"]
		}
		const [, patches] = produceWithPatches(base, draft => {
			draft.obj["0"] = "obj-zero-updated"
			draft.arr[0] = "arr-zero-updated"
		})

		const operations = patchesToRFC6902(base, patches)

		// Immer generates patches in internal order; verify each operation
		// has the correct pointer type (object key "0" vs array index 0)
		const byPath = new Map(operations.map(op => [op.path, op]))
		expect(byPath.get("/obj/0")).toEqual({
			op: "replace",
			path: "/obj/0",
			value: "obj-zero-updated"
		})
		expect(byPath.get("/arr/0")).toEqual({
			op: "replace",
			path: "/arr/0",
			value: "arr-zero-updated"
		})

		// Verify the pointers resolve to the correct locations
		expect(parsePointer("/obj/0")).toEqual(["obj", "0"])
		expect(parsePointer("/arr/0")).toEqual(["arr", "0"])
	})

	test("slash key a/b is escaped to a~1b", () => {
		const base = {"a/b": 1}
		const [, patches] = produceWithPatches(base, draft => {
			draft["a/b"] = 2
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "replace", path: "/a~1b", value: 2}])
		expect(parsePointer(operations[0].path)).toEqual(["a/b"])
	})

	test("tilde key a~b is escaped to a~0b", () => {
		const base = {"a~b": 1}
		const [, patches] = produceWithPatches(base, draft => {
			draft["a~b"] = 2
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "replace", path: "/a~0b", value: 2}])
		expect(parsePointer(operations[0].path)).toEqual(["a~b"])
	})

	test("array append uses '-' pointer", () => {
		const base = {list: [1, 2, 3]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.list.push(4)
			draft.list.push(5)
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([
			{op: "add", path: "/list/-", value: 4},
			{op: "add", path: "/list/-", value: 5}
		])
	})

	test("root replacement uses empty pointer", () => {
		const base = {a: 1}
		const [, patches] = produceWithPatches(base, draft => {
			return {b: 2}
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "replace", path: "", value: {b: 2}}])
	})

	test("remove operation produces correct pointer", () => {
		const base = {a: {b: 1}}
		const [, patches] = produceWithPatches(base, draft => {
			delete draft.a.b
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "remove", path: "/a/b"}])
	})

	test("nested path with mixed object and array", () => {
		const base = {items: [{name: "first"}, {name: "second"}]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.items[1].name = "updated"
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([
			{op: "replace", path: "/items/1/name", value: "updated"}
		])
	})

	test("output executed via RFC 6902 equals Immer result", () => {
		const base = {
			obj: {"0": "obj-zero", "a/b": 1},
			arr: [1, 2, 3],
			nested: {x: 1}
		}
		const producer = (draft: any) => {
			draft.obj["0"] = "updated"
			draft.obj["a/b"] = 2
			draft.arr.push(4)
			draft.arr[0] = 10
			draft.nested.x = 100
			draft.newKey = "new"
		}

		const [immerResult, patches] = produceWithPatches(base, producer)
		const operations = patchesToRFC6902(base, patches)
		const rfcResult = applyRFC6902(base, operations)

		expect(rfcResult).toEqual(immerResult)
	})

	test("original state and patches are not mutated", () => {
		const base = {a: 1, list: [1, 2]}
		const baseSnapshot = structuredClone(base)
		const [, patches] = produceWithPatches(base, draft => {
			draft.a = 2
			draft.list.push(3)
		})
		const patchesSnapshot = structuredClone(patches)

		patchesToRFC6902(base, patches)

		expect(base).toEqual(baseSnapshot)
		expect(patches).toEqual(patchesSnapshot)
	})

	test("rejects Map values", () => {
		const base = {a: 1}
		const patches = [{op: "add", path: ["b"], value: new Map()}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects Set values", () => {
		const base = {a: 1}
		const patches = [{op: "add", path: ["b"], value: new Set()}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects Map in path", () => {
		const base = new Map([["a", 1]])
		const patches = [{op: "replace", path: ["a"], value: 2}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects Set in path", () => {
		const base = new Set([1])
		const patches = [{op: "add", path: [1], value: 2}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects function values", () => {
		const base = {a: 1}
		const patches = [{op: "add", path: ["b"], value: () => {}}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects non-plain object values", () => {
		const base = {a: 1}
		const patches = [{op: "add", path: ["b"], value: new Date()}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("rejects unsupported operations", () => {
		const base = {a: 1}
		const patches = [{op: "copy", from: "/a", path: "/b"}]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("failure returns no partial group", () => {
		const base = {a: 1, list: [1, 2]}
		// First patch is valid, second has a Map value (invalid)
		const patches = [
			{op: "replace", path: ["a"], value: 2},
			{op: "add", path: ["b"], value: new Map()}
		]

		expect(() => patchesToRFC6902(base, patches)).toThrow(
			RFC6902ConversionError
		)
	})

	test("step-by-step validation: array index shifts after remove", () => {
		const base = {list: [1, 2, 3]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.list.splice(0, 1) // remove index 0
			draft.list[0] = 20 // replace new index 0 (was index 1)
		})

		const operations = patchesToRFC6902(base, patches)

		// Immer generates: replace /list/0=20, replace /list/1=3, remove /list/2
		// Each patch is validated against the candidate state from the previous one
		expect(operations.length).toBe(3)
		expect(operations[0]).toEqual({op: "replace", path: "/list/0", value: 20})
		expect(operations[1]).toEqual({op: "replace", path: "/list/1", value: 3})
		expect(operations[2]).toEqual({op: "remove", path: "/list/2"})

		// Verify against Immer result
		const rfcResult = applyRFC6902(base, operations)
		expect(rfcResult).toEqual(applyPatches(base, patches))
	})

	test("step-by-step validation: array append then replace", () => {
		const base = {list: [1, 2]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.list.push(3) // append -> index 2
			draft.list[2] = 30 // replace index 2 (merged into add by Immer)
		})

		const operations = patchesToRFC6902(base, patches)

		// Immer merges push + replace into a single add with the final value
		expect(operations).toEqual([{op: "add", path: "/list/-", value: 30}])

		const rfcResult = applyRFC6902(base, operations)
		expect(rfcResult).toEqual(applyPatches(base, patches))
	})

	test("nothing produces root replacement with no value field", () => {
		const base = {a: 1}
		const [, patches] = produceWithPatches(base, draft => {
			return nothing
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "replace", path: ""}])
	})

	test("empty patches returns empty operations", () => {
		const base = {a: 1}
		const operations = patchesToRFC6902(base, [])
		expect(operations).toEqual([])
	})

	test("add new key to object", () => {
		const base = {a: 1}
		const [, patches] = produceWithPatches(base, draft => {
			draft.b = 2
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "add", path: "/b", value: 2}])
	})

	test("remove nested key", () => {
		const base = {a: {b: {c: 1}}}
		const [, patches] = produceWithPatches(base, draft => {
			delete draft.a.b.c
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "remove", path: "/a/b/c"}])
	})

	test("multiple operations in sequence", () => {
		const base = {a: 1, b: 2, list: [1, 2, 3]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.a = 10
			draft.b = 20
			draft.list.push(4)
			delete draft.list[0]
		})

		const operations = patchesToRFC6902(base, patches)

		// Immer generates array patches first, then object patches
		expect(operations.length).toBe(4)
		expect(operations[0]).toEqual({op: "replace", path: "/list/0"})
		expect(operations[1]).toEqual({op: "add", path: "/list/-", value: 4})
		expect(operations[2]).toEqual({op: "replace", path: "/a", value: 10})
		expect(operations[3]).toEqual({op: "replace", path: "/b", value: 20})

		const rfcResult = applyRFC6902(base, operations)
		expect(rfcResult).toEqual(applyPatches(base, patches))
	})

	test("numeric object key that looks like array index", () => {
		// Object with key "0" should produce /0 (string key), not array index
		const base = {"0": "zero", "1": "one"}
		const [, patches] = produceWithPatches(base, draft => {
			draft["0"] = "updated"
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([{op: "replace", path: "/0", value: "updated"}])
		expect(parsePointer(operations[0].path)).toEqual(["0"])
	})

	test("deeply nested path with multiple escapes", () => {
		const base = {
			"a/b": {
				"c~d": [1, 2]
			}
		}
		const [, patches] = produceWithPatches(base, draft => {
			draft["a/b"]["c~d"][0] = 10
		})

		const operations = patchesToRFC6902(base, patches)

		expect(operations).toEqual([
			{op: "replace", path: "/a~1b/c~0d/0", value: 10}
		])
		expect(parsePointer(operations[0].path)).toEqual(["a/b", "c~d", "0"])
	})
})
