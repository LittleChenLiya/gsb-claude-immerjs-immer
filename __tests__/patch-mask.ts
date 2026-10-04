import {
	produceWithPatches,
	applyPatches,
	maskPatches,
	enablePatches,
	enableMapSet,
	Patch
} from "../src/immer"

enablePatches()
enableMapSet()

describe("maskPatches", () => {
	test("marks the matched value and keeps the others", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [, patches] = produceWithPatches(base, draft => {
			draft.user.name = "Ada Lovelace"
			draft.user.token = "new-token"
		})

		const audit = maskPatches(patches, {
			rules: ["/user/token"],
			replacement: "***"
		})

		expect(audit).toEqual([
			{op: "replace", path: ["user", "name"], value: "Ada Lovelace"},
			{op: "replace", path: ["user", "token"], value: "***"}
		])
	})

	test("a parent rule masks the whole value subtree", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [, patches] = produceWithPatches(base, draft => {
			draft.user.name = "Ada Lovelace"
			draft.user.token = "new-token"
		})

		const audit = maskPatches(patches, {
			rules: ["/user"],
			replacement: "***"
		})

		expect(audit).toEqual([
			{op: "replace", path: ["user", "name"], value: "***"},
			{op: "replace", path: ["user", "token"], value: "***"}
		])
		// No secret leaks out of the audit copy.
		const printed = JSON.stringify(audit)
		expect(printed).not.toContain("s3cr3t")
		expect(printed).not.toContain("new-token")
	})

	test("the original patches are untouched and still replay to the original result", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [nextState, patches] = produceWithPatches(base, draft => {
			draft.user.name = "Ada Lovelace"
			draft.user.token = "new-token"
		})
		const patchesSnapshot = JSON.stringify(patches)

		const audit = maskPatches(patches, {
			rules: ["/user/token"],
			replacement: "***"
		})

		// The audit copy is a separate batch.
		expect(audit).not.toBe(patches)
		expect(JSON.stringify(patches)).toBe(patchesSnapshot)
		// The original patches still replay to the exact original result.
		expect(applyPatches(base, patches)).toEqual(nextState)
	})

	test("the audit copy does not share mutable objects with the original patches", () => {
		const base = {
			user: {name: "Ada", token: "s3cr3t"},
			meta: {nested: {count: 1}}
		}
		const [, patches] = produceWithPatches(base, draft => {
			draft.meta.nested = {count: 2}
		})

		expect(patches[0].value).toEqual({count: 2})
		const audit = maskPatches(patches, {
			rules: ["/user/token"],
			replacement: "***"
		})

		// Values are cloned, paths are copied.
		expect(audit[0].value).not.toBe(patches[0].value)
		expect(audit[0].path).not.toBe(patches[0].path)

		// Mutating the audit copy must not affect the original patches.
		;(audit[0].value as any).count = 999
		audit[0].path.push("extra")
		expect((patches[0].value as any).count).toBe(2)
		expect(patches[0].path).toEqual(["meta", "nested"])
	})

	test("numeric array segments match array indices, not string fields", () => {
		const base = {
			users: [
				{name: "A", token: "t0"},
				{name: "B", token: "t1"}
			]
		}
		const [, patches] = produceWithPatches(base, draft => {
			draft.users[0].token = "nt0"
			draft.users[1].name = "B2"
		})

		// String rule: the digit segment is interpreted as an array index.
		const audit = maskPatches(patches, {
			rules: ["/users/0/token"],
			replacement: "***"
		})
		expect(audit.find(p => p.path.join("/") === "users/0/token")!.value).toBe(
			"***"
		)
		expect(audit.find(p => p.path.join("/") === "users/1/name")!.value).toBe(
			"B2"
		)

		// Array rule with a numeric segment works as well.
		const auditNumeric = maskPatches(patches, {
			rules: [["users", 0, "token"]],
			replacement: "***"
		})
		expect(
			auditNumeric.find(p => p.path.join("/") === "users/0/token")!.value
		).toBe("***")

		// A string segment "0" must NOT match the numeric array index 0.
		const auditStringField = maskPatches(patches, {
			rules: [["users", "0", "token"]],
			replacement: "***"
		})
		expect(
			auditStringField.find(p => p.path.join("/") === "users/0/token")!.value
		).toBe("nt0")
	})

	test("remove operations are preserved without a value", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [, patches] = produceWithPatches(base, draft => {
			delete draft.user.token
		})
		expect(patches).toEqual([{op: "remove", path: ["user", "token"]}])

		const audit = maskPatches(patches, {
			rules: ["/user"],
			replacement: "***"
		})
		expect(audit).toEqual([{op: "remove", path: ["user", "token"]}])
		expect("value" in audit[0]).toBe(false)

		// Array index removals are preserved as well.
		const listBase = {items: ["a", "b", "c"]}
		const [, listPatches] = produceWithPatches(listBase, draft => {
			draft.items.pop()
		})
		const listAudit = maskPatches(listPatches, {
			rules: ["/items"],
			replacement: "***"
		})
		expect(listAudit[0]).toEqual({op: "remove", path: ["items", 2]})
	})

	test("the replacement marker is used exactly as given", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [, patches] = produceWithPatches(base, draft => {
			draft.user.token = "new-token"
		})

		const audit = maskPatches(patches, {
			rules: ["/user/token"],
			replacement: null
		})
		expect(audit[0].value).toBeNull()
	})

	test("rules match whole path segments, not string prefixes", () => {
		const base = {user: {token: "a"}, userX: {token: "b"}}
		const [, patches] = produceWithPatches(base, draft => {
			draft.user.token = "aa"
			draft.userX.token = "bb"
		})

		const audit = maskPatches(patches, {
			rules: ["/user"],
			replacement: "***"
		})
		expect(audit.find(p => p.path.join("/") === "user/token")!.value).toBe(
			"***"
		)
		expect(audit.find(p => p.path.join("/") === "userX/token")!.value).toBe(
			"bb"
		)
	})

	test("cyclic values reject the whole batch", () => {
		const cyclic: any = {name: "Ada"}
		cyclic.self = cyclic
		const patches: Patch[] = [
			{op: "add", path: ["user"], value: cyclic},
			{op: "replace", path: ["user", "name"], value: "Ada"}
		]

		expect(() => maskPatches(patches, {rules: [], replacement: "***"})).toThrow(
			/circular/
		)

		const cyclicArray: any[] = [1]
		cyclicArray.push(cyclicArray)
		expect(() =>
			maskPatches([{op: "add", path: ["x"], value: cyclicArray}], {
				rules: [],
				replacement: "***"
			})
		).toThrow(/circular/)
	})

	test("accessor properties reject the whole batch", () => {
		const value = {}
		Object.defineProperty(value, "secret", {
			get: () => "s3cr3t",
			enumerable: true
		})

		expect(() =>
			maskPatches([{op: "add", path: ["user"], value}], {
				rules: [],
				replacement: "***"
			})
		).toThrow(/accessor/)
	})

	test("the audit copy is JSON-serializable and keeps Map values copied", () => {
		const base = {map: new Map([["a", 1]])}
		const [, patches] = produceWithPatches(base, draft => {
			draft.map = new Map([["b", 2]])
		})

		const audit = maskPatches(patches, {rules: [], replacement: "***"})
		expect(audit[0].value).not.toBe(patches[0].value)
		expect((audit[0].value as Map<string, number>).get("b")).toBe(2)

		// The audit copy can be printed / serialized without blowing up.
		const printed = JSON.stringify(audit)
		expect(printed).toContain("replace")
	})

	test("prints the audit copy for inspection", () => {
		const base = {user: {name: "Ada", token: "s3cr3t"}}
		const [, patches] = produceWithPatches(base, draft => {
			draft.user.name = "Ada Lovelace"
			draft.user.token = "new-token"
		})

		const audit = maskPatches(patches, {
			rules: ["/user/token"],
			replacement: "***"
		})

		// Example of printing the audit copy:
		console.log("audit copy:", JSON.stringify(audit, null, 2))

		expect(audit).toHaveLength(2)
		expect(audit[1].value).toBe("***")
	})
})
