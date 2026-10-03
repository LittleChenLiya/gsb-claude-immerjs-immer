"use strict"
import {vi} from "vitest"
import {
	createDraftSession,
	createDraft,
	finishDraft,
	applyPatches,
	enablePatches,
	enableMapSet
} from "../src/immer"

enablePatches()
enableMapSet()

// In production builds Immer minifies its error messages; the numeric code
// is the deterministic part there.
const isProd = process.env.NODE_ENV === "production"
const CLOSED_RE = isProd
	? /minified error nr: 16/
	: /draft session is already closed/
const REVOKED_RE = isProd ? /minified error nr: 3|revoked/ : /revoked/
const COMMIT_ARG_RE = isProd
	? /minified error nr: 17/
	: /argument to `commit` must be a function/

describe("draft session", () => {
	it("commits nested changes and returns matching forward/inverse patches", () => {
		const base = {
			user: {name: "ada", address: {city: "x"}},
			tags: ["one"],
			meta: {version: 1}
		}

		const session = createDraftSession(base)
		expect(session.status).toBe("open")

		session.draft.user.address.city = "y"
		session.draft.tags.push("two")

		const {result, patches, inversePatches} = session.commit()

		expect(session.status).toBe("committed")
		expect(result).toEqual({
			user: {name: "ada", address: {city: "y"}},
			tags: ["one", "two"],
			meta: {version: 1}
		})
		// structural sharing: untouched branches are reused
		expect(result.meta).toBe(base.meta)

		// the base state is never mutated
		expect(base).toEqual({
			user: {name: "ada", address: {city: "x"}},
			tags: ["one"],
			meta: {version: 1}
		})

		// the result corresponds exactly to the patches, in both directions
		expect(patches).toEqual([
			{op: "add", path: ["tags", 1], value: "two"},
			{op: "replace", path: ["user", "address", "city"], value: "y"}
		])
		expect(inversePatches).toEqual([
			{op: "remove", path: ["tags", 1]},
			{op: "replace", path: ["user", "address", "city"], value: "x"}
		])
		expect(applyPatches(base, patches)).toEqual(result)
		expect(applyPatches(result, inversePatches)).toEqual(base)
	})

	it("forwards patches to an optional commit listener", () => {
		const session = createDraftSession({n: 1})
		session.draft.n = 2
		const listener = vi.fn()
		const {result, patches, inversePatches} = session.commit(listener)
		expect(result).toEqual({n: 2})
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith(patches, inversePatches)
		expect(patches).toEqual([{op: "replace", path: ["n"], value: 2}])
	})

	it("returns the base state itself when nothing was modified", () => {
		const base = {a: 1}
		const session = createDraftSession(base)
		const {result, patches, inversePatches} = session.commit()
		expect(result).toBe(base)
		expect(patches).toEqual([])
		expect(inversePatches).toEqual([])
	})

	it("commits at most once; any later interaction fails deterministically", () => {
		const session = createDraftSession({a: 1})
		const draft = session.draft
		draft.a = 2
		expect(session.commit().result).toEqual({a: 2})

		expect(() => session.commit()).toThrow(CLOSED_RE)
		expect(() => session.abort()).toThrow(CLOSED_RE)
		expect(() => session.draft).toThrow(CLOSED_RE)
		expect(() => draft.a).toThrow(REVOKED_RE)
		expect(() => {
			draft.a = 3
		}).toThrow(REVOKED_RE)

		// deterministic: the same operation fails with the same error every time
		let first, second
		try {
			session.commit()
		} catch (e) {
			first = e
		}
		try {
			session.commit()
		} catch (e) {
			second = e
		}
		expect(first.message).toBe(second.message)
	})

	it("abort revokes every draft reference and never touches the base", () => {
		const base = {nested: {count: 1}, list: [1, 2]}
		const session = createDraftSession(base)
		const draft = session.draft
		const nestedDraft = draft.nested // nested draft reference handed out early
		draft.nested.count = 42
		draft.list.push(3)

		session.abort()
		expect(session.status).toBe("aborted")

		// abandoned changes are not merged back into the base
		expect(base).toEqual({nested: {count: 1}, list: [1, 2]})

		// all draft references of the session are revoked
		expect(() => draft.nested).toThrow(REVOKED_RE)
		expect(() => nestedDraft.count).toThrow(REVOKED_RE)
		expect(() => {
			nestedDraft.count = 5
		}).toThrow(REVOKED_RE)

		// repeated close and any further use fail deterministically
		expect(() => session.abort()).toThrow(CLOSED_RE)
		expect(() => session.commit()).toThrow(CLOSED_RE)
		expect(() => session.draft).toThrow(CLOSED_RE)
	})

	it("closes the session when the commit patch listener throws", () => {
		const base = {n: 1}
		const session = createDraftSession(base)
		const draft = session.draft
		draft.n = 2

		const boom = new Error("listener boom")
		let caught
		try {
			session.commit(() => {
				throw boom
			})
		} catch (e) {
			caught = e
		}
		expect(caught).toBe(boom)

		// the session is closed and no longer modifiable
		expect(session.status).toBe("aborted")
		expect(() => {
			draft.n = 3
		}).toThrow(REVOKED_RE)
		expect(() => session.commit()).toThrow(CLOSED_RE)
		expect(() => session.abort()).toThrow(CLOSED_RE)

		// the abandoned change never reached the base
		expect(base).toEqual({n: 1})
	})

	it("rejects a non-function commit argument and stays open", () => {
		const session = createDraftSession({a: 1})
		expect(() => session.commit(42)).toThrow(COMMIT_ARG_RE)
		expect(session.status).toBe("open")
		session.abort()
	})

	it("keeps sessions on the same base independent", () => {
		const base = {x: 1}
		const s1 = createDraftSession(base)
		const s2 = createDraftSession(base)
		const s2Draft = s2.draft

		s1.draft.x = 10
		s2Draft.x = 20

		s2.abort()
		// holding an old draft of the aborted session fails on access
		expect(() => s2Draft.x).toThrow(REVOKED_RE)
		expect(() => {
			s2Draft.x = 30
		}).toThrow(REVOKED_RE)

		// the other session is unaffected
		expect(s1.commit().result).toEqual({x: 10})
		expect(base).toEqual({x: 1})
	})

	it("supports nested cross references inside a session", () => {
		const base = {a: {v: 1}, b: null}
		const session = createDraftSession(base)
		const draft = session.draft

		draft.b = draft.a // reference the same nested draft twice
		draft.a.v = 2

		const {result, patches} = session.commit()
		expect(result.a).toEqual({v: 2})
		expect(result.b).toEqual({v: 2})
		expect(result.b).toBe(result.a)
		expect(base).toEqual({a: {v: 1}, b: null})
		expect(patches).toEqual([
			{op: "replace", path: ["a", "v"], value: 2},
			{op: "replace", path: ["b"], value: {v: 2}}
		])
	})

	it("supports Map bases when the MapSet plugin is enabled", () => {
		const base = new Map([["a", 1]])
		const session = createDraftSession(base)
		session.draft.set("b", 2)
		session.draft.set("a", 10)

		const {result, patches, inversePatches} = session.commit()
		expect(result).toEqual(
			new Map([
				["a", 10],
				["b", 2]
			])
		)
		expect(base).toEqual(new Map([["a", 1]]))
		expect(applyPatches(base, patches)).toEqual(result)
		expect(applyPatches(result, inversePatches)).toEqual(base)
	})

	it("supports Set bases and revokes them on abort", () => {
		const base = new Set([1])
		const session = createDraftSession(base)
		const draft = session.draft
		draft.add(2)

		session.abort()
		expect([...base]).toEqual([1])
		expect(() => draft.has(2)).toThrow(REVOKED_RE)
		expect(() => draft.add(3)).toThrow(REVOKED_RE)
	})

	it("commits Set changes with matching patches", () => {
		const base = new Set([1, 2])
		const session = createDraftSession(base)
		session.draft.delete(1)
		session.draft.add(3)

		const {result, patches, inversePatches} = session.commit()
		expect([...result].sort()).toEqual([2, 3])
		expect([...base].sort()).toEqual([1, 2])
		expect(applyPatches(base, patches)).toEqual(result)
		expect(applyPatches(result, inversePatches)).toEqual(base)
	})

	it("leaves the original manual draft API unchanged", () => {
		const base = {a: 1}
		const draft = createDraft(base)
		draft.a = 2
		expect(finishDraft(draft)).toEqual({a: 2})
		expect(() => finishDraft(draft)).toThrow()

		// a session and a manual draft can be used side by side
		const other = {b: 1}
		const manual = createDraft(other)
		const session = createDraftSession(other)
		manual.b = 2
		session.draft.b = 3
		expect(finishDraft(manual)).toEqual({b: 2})
		expect(session.commit().result).toEqual({b: 3})
		expect(other).toEqual({b: 1})
	})
})
