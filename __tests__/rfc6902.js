"use strict"
import {
	produceWithPatches,
	enablePatches,
	enableMapSet,
	toJsonPatch,
	JsonPatchConversionError
} from "../src/immer"

enablePatches()
enableMapSet()

/**
 * Minimal, independent RFC 6902 (JSON Patch) executor used as the
 * reference for the acceptance checks. It implements add/remove/replace
 * over plain JSON documents with RFC 6901 pointer unescaping, the "-"
 * array append position and the empty root pointer.
 */
function applyJsonPatch(document, operations) {
	let root = deepClone(document)
	for (const operation of operations) {
		const segments = parsePointer(operation.path)
		if (segments.length === 0) {
			if (operation.op === "remove")
				throw new Error("cannot remove the document root")
			root = deepClone(operation.value)
			continue
		}
		let container = root
		for (const segment of segments.slice(0, -1)) {
			container = Array.isArray(container)
				? container[parseIndex(segment, container.length)]
				: container[segment]
			if (container === null || typeof container !== "object")
				throw new Error("path does not resolve: " + operation.path)
		}
		const last = segments[segments.length - 1]
		if (Array.isArray(container)) {
			if (operation.op === "add") {
				if (last === "-") container.push(deepClone(operation.value))
				else
					container.splice(
						parseIndex(last, container.length, true),
						0,
						deepClone(operation.value)
					)
			} else {
				const index = parseIndex(last, container.length)
				if (operation.op === "replace")
					container[index] = deepClone(operation.value)
				else container.splice(index, 1)
			}
		} else {
			if (operation.op === "add") container[last] = deepClone(operation.value)
			else if (operation.op === "replace") {
				if (!Object.prototype.hasOwnProperty.call(container, last))
					throw new Error("replace target missing: " + operation.path)
				container[last] = deepClone(operation.value)
			} else {
				if (!Object.prototype.hasOwnProperty.call(container, last))
					throw new Error("remove target missing: " + operation.path)
				delete container[last]
			}
		}
	}
	return root
}

function parsePointer(pointer) {
	if (pointer === "") return []
	if (!pointer.startsWith("/")) throw new Error("invalid pointer: " + pointer)
	return pointer
		.slice(1)
		.split("/")
		.map(segment => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function parseIndex(segment, length, allowEnd = false) {
	if (!/^(0|[1-9][0-9]*)$/.test(segment))
		throw new Error("invalid array index: " + segment)
	const index = Number(segment)
	if (index > length - (allowEnd ? 0 : 1))
		throw new Error("array index out of bounds: " + segment)
	return index
}

function deepClone(value) {
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(deepClone)
	const clone = {}
	for (const key of Object.keys(value)) clone[key] = deepClone(value[key])
	return clone
}

/** Runs a recipe and converts the resulting Immer patches to RFC 6902. */
function roundTrip(base, recipe) {
	const [result, patches] = produceWithPatches(base, recipe)
	const operations = toJsonPatch(base, patches)
	return {result, patches, operations, applied: applyJsonPatch(base, operations)}
}

describe("toJsonPatch: pointer generation", () => {
	test("object key '0' is a key, array index 0 is an index", () => {
		const objectBase = {"0": "a", "1": "b"}
		const [objectResult, objectPatches] = produceWithPatches(objectBase, d => {
			d["0"] = "z"
		})
		const objectOps = toJsonPatch(objectBase, objectPatches)
		expect(objectOps).toEqual([{op: "replace", path: "/0", value: "z"}])
		expect(applyJsonPatch(objectBase, objectOps)).toEqual(objectResult)

		const arrayBase = ["a", "b"]
		const [arrayResult, arrayPatches] = produceWithPatches(arrayBase, d => {
			d[0] = "z"
		})
		const arrayOps = toJsonPatch(arrayBase, arrayPatches)
		expect(arrayOps).toEqual([{op: "replace", path: "/0", value: "z"}])
		expect(applyJsonPatch(arrayBase, arrayOps)).toEqual(arrayResult)
	})

	test("numeric-looking keys stay keys inside objects nested in arrays", () => {
		const base = [{"0": "a"}]
		const [result, patches] = produceWithPatches(base, d => {
			d[0]["0"] = "z"
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([{op: "replace", path: "/0/0", value: "z"}])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("keys containing '/' and '~' are escaped per RFC 6901", () => {
		const base = {"a/b": 1, "a~b": 2, "~/": 3}
		const [result, patches] = produceWithPatches(base, d => {
			d["a/b"] = 10
			d["a~b"] = 20
			d["~/"] = 30
		})
		const operations = toJsonPatch(base, patches)
		expect(operations.map(o => o.path).sort()).toEqual([
			"/a~0b",
			"/a~1b",
			"/~0~1"
		])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("deeply nested mixed containers", () => {
		const base = {a: [{"b/c": [1, 2]}]}
		const [result, patches] = produceWithPatches(base, d => {
			d.a[0]["b/c"][1] = 42
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([
			{op: "replace", path: "/a/0/b~1c/1", value: 42}
		])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("root replacement uses the empty pointer", () => {
		const base = {a: 1}
		const [result, patches] = produceWithPatches(base, () => ({b: 2}))
		expect(patches).toEqual([{op: "replace", path: [], value: {b: 2}}])
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([{op: "replace", path: "", value: {b: 2}}])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})
})

describe("toJsonPatch: arrays", () => {
	test("append uses the legal '-' position", () => {
		const base = [1, 2]
		const [result, patches] = produceWithPatches(base, d => {
			d.push(3)
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([{op: "add", path: "/-", value: 3}])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("insert in the middle is expressed against the candidate state", () => {
		// Immer normalizes splice(1, 0, 2) on [1, 3] into a replace at index 1
		// plus an append of the shifted-out element.
		const base = [1, 3]
		const [result, patches] = produceWithPatches(base, d => {
			d.splice(1, 0, 2)
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([
			{op: "replace", path: "/1", value: 2},
			{op: "add", path: "/-", value: 3}
		])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("removal and shrink", () => {
		const base = [1, 2, 3]
		const [result, patches] = produceWithPatches(base, d => {
			d.pop()
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([{op: "remove", path: "/2"}])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})

	test("sequential steps see the candidate state of previous steps", () => {
		// Index 2 of the add is only legal *after* the remove shifted the
		// array, and the final replace targets the shifted element: every step
		// must be judged against the candidate state of the previous steps.
		const base = {list: ["a", "b", "c"]}
		const patches = [
			{op: "remove", path: ["list", 0]},
			{op: "add", path: ["list", 2], value: "d"},
			{op: "replace", path: ["list", 0], value: "B"}
		]
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([
			{op: "remove", path: "/list/0"},
			{op: "add", path: "/list/-", value: "d"},
			{op: "replace", path: "/list/0", value: "B"}
		])
		expect(applyJsonPatch(base, operations)).toEqual({list: ["B", "c", "d"]})
	})
})

describe("toJsonPatch: object operations", () => {
	test("add, replace and remove of plain keys", () => {
		const base = {keep: 1, drop: 2}
		const [result, patches] = produceWithPatches(base, d => {
			d.keep = 10
			d.added = 3
			delete d.drop
		})
		const operations = toJsonPatch(base, patches)
		expect(operations).toEqual([
			{op: "replace", path: "/keep", value: 10},
			{op: "add", path: "/added", value: 3},
			{op: "remove", path: "/drop"}
		])
		expect(applyJsonPatch(base, operations)).toEqual(result)
	})
})

describe("toJsonPatch: explicit rejection", () => {
	test("rejects Map in the base state", () => {
		const base = {m: new Map([["a", 1]])}
		const [, patches] = produceWithPatches(base, d => {
			d.m.set("a", 2)
		})
		expect(() => toJsonPatch(base, patches)).toThrow(JsonPatchConversionError)
		expect(() => toJsonPatch(base, patches)).toThrow(/Map/)
	})

	test("rejects Set in the base state", () => {
		const base = {s: new Set([1])}
		const [, patches] = produceWithPatches(base, d => {
			d.s.add(2)
		})
		expect(() => toJsonPatch(base, patches)).toThrow(JsonPatchConversionError)
		expect(() => toJsonPatch(base, patches)).toThrow(/Set/)
	})

	test("rejects non-JSON patch values", () => {
		const base = {a: 1}
		const [, patches] = produceWithPatches(base, d => {
			d.a = undefined
		})
		expect(() => toJsonPatch(base, patches)).toThrow(JsonPatchConversionError)
		expect(() => toJsonPatch(base, patches)).toThrow(/Non-JSON/)

		const [, datePatches] = produceWithPatches({d: null}, d => {
			d.d = new Date(0)
		})
		expect(() => toJsonPatch({d: null}, datePatches)).toThrow(
			JsonPatchConversionError
		)
	})

	test("rejects unsupported operations and unresolvable paths", () => {
		expect(() =>
			toJsonPatch({a: 1}, [{op: "move", path: ["a"]}])
		).toThrow(/Unsupported operation/)
		expect(() =>
			toJsonPatch({a: 1}, [{op: "replace", path: ["missing"], value: 1}])
		).toThrow(/does not exist/)
		expect(() =>
			toJsonPatch([1], [{op: "replace", path: [5], value: 1}])
		).toThrow(/not a valid array index/)
		expect(() => toJsonPatch({a: 1}, [{op: "remove", path: []}])).toThrow(
			/document root/
		)
	})

	test("failure is atomic: no partial operation group is returned", () => {
		const base = {a: 1, b: 2}
		const patches = [
			{op: "replace", path: ["a"], value: 10},
			{op: "replace", path: ["missing"], value: 20}
		]
		let returned = "nothing returned"
		try {
			returned = toJsonPatch(base, patches)
		} catch (error) {
			expect(error).toBeInstanceOf(JsonPatchConversionError)
		}
		expect(returned).toBe("nothing returned")
	})
})

describe("toJsonPatch: input immutability", () => {
	test("neither the base state nor the patches are mutated", () => {
		const base = {list: [1, 2], obj: {"a/b": 1}}
		const [result, patches] = produceWithPatches(base, d => {
			d.list.push(3)
			d.obj["a/b"] = 2
		})
		const baseSnapshot = JSON.stringify(base)
		const patchSnapshot = JSON.stringify(patches)
		const operations = toJsonPatch(base, patches)
		expect(JSON.stringify(base)).toBe(baseSnapshot)
		expect(JSON.stringify(patches)).toBe(patchSnapshot)
		// The returned operations share no references with the inputs.
		operations.forEach(operation => {
			if ("value" in operation) operation.value = "mutated"
		})
		expect(JSON.stringify(base)).toBe(baseSnapshot)
		expect(JSON.stringify(patches)).toBe(patchSnapshot)
		expect(applyJsonPatch(base, toJsonPatch(base, patches))).toEqual(result)
	})

	test("failed conversion does not mutate inputs either", () => {
		const base = {a: 1}
		const patches = [{op: "replace", path: ["missing"], value: 2}]
		const baseSnapshot = JSON.stringify(base)
		const patchSnapshot = JSON.stringify(patches)
		expect(() => toJsonPatch(base, patches)).toThrow(JsonPatchConversionError)
		expect(JSON.stringify(base)).toBe(baseSnapshot)
		expect(JSON.stringify(patches)).toBe(patchSnapshot)
	})
})

describe("toJsonPatch: equivalence with Immer results", () => {
	const scenarios = [
		["nested object update", {a: {b: {c: 1}}}, d => void (d.a.b.c = 2)],
		["add and remove keys", {x: 1}, d => {
			d.y = 2
			delete d.x
		}],
		["array push/splice/pop", [1, 2, 3], d => {
			d.push(4)
			d.splice(0, 1)
			d[0] = 20
		}],
		["array of objects", [{id: 1}], d => {
			d.push({id: 2})
			d[0].id = 10
		}],
		["root replace with array", {a: 1}, () => [1, 2]],
		["escaped keys", {"a/b": {"~x": [0]}}, d => {
			d["a/b"]["~x"][0] = 99
		}],
		["numeric object keys", {"0": "a", 1: "b"}, d => {
			d["0"] = "A"
			d[2] = "c"
		}],
		["empty patch list", {a: 1}, () => {}]
	]
	test.each(scenarios)("%s", (name, base, recipe) => {
		const {result, operations, applied} = roundTrip(base, recipe)
		expect(applied).toEqual(result)
		// Every emitted pointer is a valid RFC 6901 pointer.
		for (const operation of operations) {
			expect(operation.path === "" || operation.path.startsWith("/")).toBe(true)
		}
	})
})
