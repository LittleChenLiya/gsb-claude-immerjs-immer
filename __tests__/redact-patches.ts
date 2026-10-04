import {describe, test, expect} from "vitest"
import {
	produceWithPatches,
	applyPatches,
	enablePatches,
	redactPatches,
	Patch,
	PatchRedactionError
} from "../src/immer"

enablePatches()

const SECRET = "[REDACTED]"

describe("redactPatches - acceptance behavior", () => {
	test("/user/token value is replaced while /user/name is kept", () => {
		const patches: Patch[] = [
			{
				op: "replace",
				path: ["user", "token"],
				value: "super-secret-token"
			},
			{op: "replace", path: ["user", "name"], value: "alice"}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["user", "token"], replacement: SECRET}]
		})

		expect(audit).toEqual([
			{op: "replace", path: ["user", "token"], value: SECRET},
			{op: "replace", path: ["user", "name"], value: "alice"}
		])
		// the secret never leaks into the audit copy
		expect(JSON.stringify(audit)).not.toContain("super-secret-token")
	})

	test("parent rule /user masks the whole user value subtree", () => {
		const patches: Patch[] = [
			{
				op: "replace",
				path: ["user"],
				value: {
					name: "alice",
					token: "super-secret-token",
					profile: {email: "a@example.com"}
				}
			},
			{op: "replace", path: ["counter"], value: 1}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["user"], replacement: SECRET}]
		})

		expect(audit[0]).toEqual({op: "replace", path: ["user"], value: SECRET})
		expect(audit[1]).toEqual({op: "replace", path: ["counter"], value: 1})
		expect(JSON.stringify(audit)).not.toContain("super-secret-token")
		expect(JSON.stringify(audit)).not.toContain("a@example.com")
	})

	test("parent rule also masks patches nested below the rule path", () => {
		const patches: Patch[] = [
			{
				op: "replace",
				path: ["user", "profile", "email"],
				value: "a@example.com"
			}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["user"], replacement: SECRET}]
		})

		expect(audit).toEqual([
			{op: "replace", path: ["user", "profile", "email"], value: SECRET}
		])
	})

	test("most specific (longest prefix) rule wins", () => {
		const patches: Patch[] = [
			{op: "replace", path: ["user", "name"], value: "alice"},
			{op: "replace", path: ["user", "token"], value: "t0k3n"},
			{op: "replace", path: ["other"], value: {token: "t0k3n"}}
		]

		const audit = redactPatches(patches, {
			rules: [
				{path: ["user"], replacement: "USER-MASKED"},
				{path: ["user", "name"], replacement: "NAME-MASKED"}
			]
		})

		expect(audit[0].value).toBe("NAME-MASKED")
		expect(audit[1].value).toBe("USER-MASKED")
		// "other" is not under "user", even though it contains a token field
		expect(audit[2].value).toEqual({token: "t0k3n"})
	})
})

describe("redactPatches - array segments are not string fields", () => {
	test("numeric index segments match numerically only", () => {
		const patches: Patch[] = [
			{op: "replace", path: ["list", 0], value: "secret-at-index-0"},
			{op: "replace", path: ["list", 1], value: "visible-at-index-1"}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["list", 0], replacement: SECRET}]
		})

		expect(audit[0].value).toBe(SECRET)
		expect(audit[1].value).toBe("visible-at-index-1")
	})

	test("string segment '0' does not match numeric segment 0", () => {
		const patches: Patch[] = [
			{op: "replace", path: ["items", 0], value: "index-value"}
		]

		// rule with the *string* field "0" must not redact the array index
		const audit = redactPatches(patches, {
			rules: [{path: ["items", "0"], replacement: SECRET}]
		})

		expect(audit[0].value).toBe("index-value")
	})

	test("real immer array patches redact per index and remain valid otherwise", () => {
		const base = {list: ["a", "secret", "c"]}
		const [, patches] = produceWithPatches(base, draft => {
			draft.list[1] = "redacted-value"
		})

		const audit = redactPatches(patches, {
			rules: [{path: ["list", 1], replacement: SECRET}]
		})

		expect(audit).toEqual([{op: "replace", path: ["list", 1], value: SECRET}])
	})
})

describe("redactPatches - remove patches keep their original op", () => {
	test("remove patch (no value) is preserved untouched in shape", () => {
		const patches: Patch[] = [
			{op: "remove", path: ["user", "token"]},
			{op: "remove", path: ["user"]}
		]

		const audit = redactPatches(patches, {
			rules: [
				{path: ["user", "token"], replacement: SECRET},
				{path: ["user"], replacement: SECRET}
			]
		})

		expect(audit).toEqual([
			{op: "remove", path: ["user", "token"]},
			{op: "remove", path: ["user"]}
		])
		expect("value" in audit[0]).toBe(false)
		expect("value" in audit[1]).toBe(false)
	})

	test("add patches at masked paths get the marker", () => {
		const patches: Patch[] = [
			{op: "add", path: ["user", "token"], value: "fresh-token"}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["user", "token"], replacement: SECRET}]
		})

		expect(audit).toEqual([{op: "add", path: ["user", "token"], value: SECRET}])
	})

	test("ops and paths survive verbatim for all op kinds", () => {
		const patches: Patch[] = [
			{op: "add", path: ["user", "roles", 0], value: "admin"},
			{op: "replace", path: ["user", "name"], value: "alice"},
			{op: "remove", path: ["user", "oldField"]}
		]

		const audit = redactPatches(patches, {
			rules: [{path: ["nope"], replacement: SECRET}]
		})

		expect(audit.map(p => p.op)).toEqual(["add", "replace", "remove"])
		expect(audit.map(p => p.path)).toEqual(patches.map(p => p.path))
	})
})

describe("redactPatches - circular / accessor batches are rejected", () => {
	test("circular value rejects the whole batch", () => {
		const circular: any = {name: "alice"}
		circular.self = circular

		const patches: Patch[] = [
			{op: "replace", path: ["a"], value: 1},
			{op: "replace", path: ["b"], value: circular}
		]

		expect(() => redactPatches(patches, {rules: []})).toThrowError(
			PatchRedactionError
		)
	})

	test("nested circular value rejects the whole batch", () => {
		const inner: any = {}
		const patches: Patch[] = [
			{op: "replace", path: ["user"], value: {profile: inner}},
			{op: "replace", path: ["other"], value: "ok"}
		]
		inner.loop = inner

		expect(() => redactPatches(patches, {rules: []})).toThrowError(/circular/)
	})

	test("own accessor value rejects the whole batch", () => {
		const withGetter = {
			get secret() {
				return "should-never-be-read"
			}
		}
		const patches: Patch[] = [
			{op: "replace", path: ["a"], value: withGetter},
			{op: "replace", path: ["b"], value: "safe"}
		]

		expect(() => redactPatches(patches, {rules: []})).toThrowError(/accessor/)
	})

	test("inherited enumerable accessor rejects the whole batch", () => {
		const proto = Object.create(null)
		Object.defineProperty(proto, "token", {
			enumerable: true,
			get() {
				return "inherited-secret"
			}
		})
		const value = Object.create(proto)
		value.name = "alice"
		const patches: Patch[] = [{op: "replace", path: ["user"], value}]

		expect(() => redactPatches(patches, {rules: []})).toThrowError(/accessor/)
	})

	test("accessor inside a nested value rejects the whole batch", () => {
		const patches: Patch[] = [
			{
				op: "replace",
				path: ["user"],
				value: {
					profile: {
						get token() {
							return "x"
						}
					}
				}
			}
		]
		expect(() => redactPatches(patches, {rules: []})).toThrowError(
			PatchRedactionError
		)
	})

	test("circular replacement marker rejects the whole batch", () => {
		const marker: any = {}
		marker.self = marker
		const patches: Patch[] = [
			{op: "replace", path: ["user", "token"], value: "t"}
		]

		expect(() =>
			redactPatches(patches, {
				rules: [{path: ["user", "token"], replacement: marker}]
			})
		).toThrowError(/circular/)
	})

	test("DAG values (shared non-cyclic nodes) are accepted and detached", () => {
		const shared = {role: "admin"}
		const patches: Patch[] = [
			{op: "replace", path: ["a"], value: shared},
			{op: "replace", path: ["b"], value: shared}
		]

		const audit = redactPatches(patches, {rules: []}) as any
		expect(audit[0].value).toEqual(shared)
		expect(audit[1].value).toEqual(shared)
		expect(audit[0].value).not.toBe(shared)
		expect(audit[1].value).not.toBe(shared)
		expect(audit[0].value).not.toBe(audit[1].value)
	})
})

describe("redactPatches - no shared mutable state", () => {
	test("audit values are deep copies, not references to input values", () => {
		const secretObj = {token: "deep-secret", nested: {v: 1}}
		const patches: Patch[] = [
			{op: "replace", path: ["user"], value: secretObj},
			{op: "replace", path: ["list"], value: [{x: 1}]}
		]

		const audit = redactPatches(patches, {rules: []}) as any
		expect(audit[0].value).not.toBe(patches[0].value)
		expect(audit[0].value.nested).not.toBe(secretObj.nested)
		expect(audit[1].value).not.toBe(patches[1].value)
		expect(audit[1].value[0]).not.toBe((patches[1].value as any)[0])

		// mutating the audit copy cannot affect the original patch
		audit[0].value.token = "tampered"
		expect((patches[0].value as any).token).toBe("deep-secret")

		// mutating the original cannot affect the audit copy
		secretObj.nested.v = 42
		expect(audit[0].value.nested.v).toBe(1)
	})

	test("audit paths are copies, not the input path arrays", () => {
		const path = ["user", "token"]
		const patches: Patch[] = [{op: "replace", path, value: "t"}]

		const audit = redactPatches(patches, {
			rules: [{path: ["user", "token"], replacement: SECRET}]
		})

		expect(audit[0].path).not.toBe(path)
		expect(audit[0].path).toEqual(path)
		path.push("extra")
		expect(audit[0].path).toEqual(["user", "token"])
	})

	test("replacement marker is deep copied per redacted patch", () => {
		const marker = {masked: true}
		const patches: Patch[] = [
			{op: "replace", path: ["user", "token"], value: "t1"},
			{op: "replace", path: ["service", "token"], value: "t2"}
		]

		const audit = redactPatches(patches, {
			rules: [
				{path: ["user", "token"], replacement: marker},
				{path: ["service", "token"], replacement: marker}
			]
		}) as any

		expect(audit[0].value).toEqual(marker)
		expect(audit[1].value).toEqual(marker)
		expect(audit[0].value).not.toBe(marker)
		expect(audit[1].value).not.toBe(marker)
		expect(audit[0].value).not.toBe(audit[1].value)
	})
})

describe("redactPatches - original patches stay replayable and untouched", () => {
	test("produceWithPatches -> redact -> original patches still replay", () => {
		const base = {
			user: {
				name: "bob",
				token: "base-token",
				roles: ["reader"]
			},
			visible: 0
		}

		const [next, patches, inversePatches] = produceWithPatches(base, draft => {
			draft.user.name = "alice"
			draft.user.token = "rotated-token"
			draft.user.roles.push("admin")
			draft.visible = 1
		})

		const patchesSnapshot = JSON.stringify(patches)
		const inverseSnapshot = JSON.stringify(inversePatches)

		const audit = redactPatches(patches, {
			rules: [{path: ["user", "token"], replacement: SECRET}]
		})
		redactPatches(inversePatches, {
			rules: [{path: ["user", "token"], replacement: SECRET}]
		})

		// original patches are untouched (not masked, not mutated)
		expect(JSON.stringify(patches)).toBe(patchesSnapshot)
		expect(JSON.stringify(inversePatches)).toBe(inverseSnapshot)
		const tokenPatch = patches.find(p => p.path.join("/") === "user/token")
		expect(tokenPatch!.value).toBe("rotated-token")
		// audit copy hides it
		const auditedToken = audit.find(p => p.path.join("/") === "user/token")
		expect(auditedToken!.value).toBe(SECRET)

		// original patches still replay to the original next state
		expect(applyPatches(base, patches)).toEqual(next)
		// inverse patches still roll back to the base
		expect(applyPatches(next, inversePatches)).toEqual(base)
	})

	test("remove patches from a real recipe keep replaying after redaction", () => {
		const base: {user: {token?: string; name: string}} = {
			user: {token: "t", name: "a"}
		}
		const [, patches] = produceWithPatches(base, draft => {
			delete draft.user.token
		})

		const audit = redactPatches(patches, {
			rules: [{path: ["user"], replacement: SECRET}]
		})
		expect(audit).toEqual([{op: "remove", path: ["user", "token"]}])

		// the original remove patch still applies
		expect(applyPatches(base, patches)).toEqual({user: {name: "a"}})
	})
})

describe("redactPatches - input validation", () => {
	test("rule with empty path masks every patch", () => {
		const patches: Patch[] = [
			{op: "replace", path: ["a", "b"], value: 1},
			{op: "remove", path: ["c"]}
		]
		const audit = redactPatches(patches, {
			rules: [{path: [], replacement: SECRET}]
		})
		expect(audit[0].value).toBe(SECRET)
		expect("value" in audit[1]).toBe(false)
	})

	test("later rule with the same specificity wins", () => {
		const patches: Patch[] = [
			{op: "replace", path: ["user", "token"], value: "t"}
		]
		const audit = redactPatches(patches, {
			rules: [
				{path: ["user", "token"], replacement: "FIRST"},
				{path: ["user", "token"], replacement: "SECOND"}
			]
		})
		expect(audit[0].value).toBe("SECOND")
	})

	test("explicit undefined replacement is allowed and masks the value", () => {
		const patches: Patch[] = [{op: "replace", path: ["x"], value: "secret"}]
		const audit = redactPatches(patches, {
			rules: [{path: ["x"], replacement: undefined}]
		})
		expect(audit[0]).toEqual({
			op: "replace",
			path: ["x"],
			value: undefined
		})
	})

	test("empty rule list deep-copies values but masks nothing", () => {
		const patches: Patch[] = [{op: "replace", path: ["a"], value: {n: 1}}]
		const audit = redactPatches(patches, {rules: []}) as any
		expect(audit[0].value).toEqual({n: 1})
		expect(audit[0].value).not.toBe(patches[0].value)
	})

	test("rejecting a batch returns no partial copy and leaves input intact", () => {
		const goodValue = {kept: true}
		const goodPatch: Patch = {op: "replace", path: ["good"], value: goodValue}
		const circular: any = {}
		circular.self = circular
		const badPatch: Patch = {
			op: "replace",
			path: ["bad"],
			value: circular
		}

		expect(() =>
			redactPatches([goodPatch, badPatch], {rules: []})
		).toThrowError(PatchRedactionError)

		// inputs untouched
		expect(goodPatch.value).toBe(goodValue)
		expect((badPatch.value as any).self).toBe(circular)
	})

	test("copies preserve frozen plain values without throwing", () => {
		const frozen = Object.freeze({nested: Object.freeze({v: 1})})
		const patches: Patch[] = [{op: "replace", path: ["frozen"], value: frozen}]
		const audit = redactPatches(patches, {rules: []}) as any
		expect(audit[0].value).toEqual({nested: {v: 1}})
		expect(audit[0].value).not.toBe(frozen)
		// the copy is a fresh mutable object
		audit[0].value.nested.v = 2
		expect(frozen.nested.v).toBe(1)
	})

	test("Map and Set values are copied and detached", () => {
		const value = {m: new Map([["token", "secret"]]), s: new Set([{x: 1}])}
		const patches: Patch[] = [{op: "replace", path: ["col"], value}]

		const audit = redactPatches(patches, {rules: []}) as any
		expect(audit[0].value.m.get("token")).toBe("secret")
		expect(audit[0].value.m).toBeInstanceOf(Map)
		expect(audit[0].value.s).toBeInstanceOf(Set)
		expect(audit[0].value.m).not.toBe(value.m)
		expect(audit[0].value.s).not.toBe(value.s)

		audit[0].value.m.set("token", "tampered")
		expect(value.m.get("token")).toBe("secret")
	})

	test("a marker shared by several masked patches yields independent copies", () => {
		const marker = {reason: "secret"}
		const patches: Patch[] = [
			{op: "replace", path: ["user", "token"], value: "t1"},
			{op: "replace", path: ["service", "token"], value: "t2"}
		]
		const audit = redactPatches(patches, {
			rules: [
				{path: ["user", "token"], replacement: marker},
				{path: ["service", "token"], replacement: marker}
			]
		}) as any

		;(audit[0].value as any).reason = "changed on first"
		expect(audit[1].value.reason).toBe("secret")
	})
})
