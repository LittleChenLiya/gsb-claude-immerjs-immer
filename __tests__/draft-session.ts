"use strict"
import {vi} from "vitest"
import {
	DraftSession,
	createDraft,
	finishDraft,
	isDraft,
	enableMapSet,
	enablePatches,
	produce,
	Immer
} from "../src/immer"

enablePatches()

const isProd = process.env.NODE_ENV === "production"

// In production the error message is minified, so only assert the full
// message in development; in production just assert that it throws.
function expectClosed(fn: () => any, state: string) {
	if (isProd) expect(fn).toThrow()
	else expect(fn).toThrow(new RegExp(`already '${state}'`))
}

describe("DraftSession", () => {
	it("starts in the open state with a draft", () => {
		const session = DraftSession.open({a: 1})
		expect(session.state).toBe("open")
		expect(isDraft(session.draft)).toBe(true)
	})

	it("commits nested changes: result and patches correspond, base is untouched", () => {
		const base = {a: {b: 1, c: 2}, list: [1, 2]}
		const baseSnapshot = JSON.parse(JSON.stringify(base))

		const session = DraftSession.open(base)
		session.draft.a.b = 10
		session.draft.list.push(3)

		const listener = vi.fn()
		const result = session.commit(listener)

		expect(session.state).toBe("committed")
		expect(result).toEqual({a: {b: 10, c: 2}, list: [1, 2, 3]})
		// The base state must not have been mutated.
		expect(base).toEqual(baseSnapshot)

		expect(listener).toHaveBeenCalledTimes(1)
		const [patches, inversePatches] = listener.mock.calls[0]
		// Forward patches describe the changes...
		expect(patches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({op: "replace", path: ["a", "b"], value: 10}),
				expect.objectContaining({op: "add", path: ["list", 2], value: 3})
			])
		)
		// ...and inverse patches undo them.
		expect(inversePatches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({op: "replace", path: ["a", "b"], value: 1}),
				expect.objectContaining({op: "remove", path: ["list", 2]})
			])
		)
	})

	it("committing without a listener returns the next state", () => {
		const session = DraftSession.open({a: 1})
		session.draft.a = 2
		expect(session.commit()).toEqual({a: 2})
		expect(session.state).toBe("committed")
	})

	it("aborts and revokes every draft the session held", () => {
		const base = {a: {b: 1}}
		const session = DraftSession.open(base)
		const draft = session.draft
		draft.a.b = 2

		session.abort()

		expect(session.state).toBe("aborted")
		// Abandoned changes are never merged back into the base.
		expect(base).toEqual({a: {b: 1}})
		// Holding the old draft and reading it must fail...
		expect(() => draft.a.b).toThrow()
		// ...and so must reaching for the draft through the session.
		expect(() => session.draft).toThrow()
	})

	it("aborting one session does not affect another session", () => {
		const base = {a: 1}
		const session1 = DraftSession.open(base)
		const session2 = DraftSession.open(base)
		session1.draft.a = 2
		session2.draft.a = 3

		session1.abort()

		expect(session1.state).toBe("aborted")
		expect(session2.state).toBe("open")
		expect(session2.commit()).toEqual({a: 3})
		expect(base).toEqual({a: 1})
	})

	it("rejects duplicate close: commit/commit, abort/abort, commit/abort", () => {
		const committed = DraftSession.open({a: 1})
		committed.commit()
		expectClosed(() => committed.commit(), "committed")
		expectClosed(() => committed.abort(), "committed")
		expectClosed(() => committed.draft, "committed")

		const aborted = DraftSession.open({a: 1})
		aborted.abort()
		expectClosed(() => aborted.abort(), "aborted")
		expectClosed(() => aborted.commit(), "aborted")
		expectClosed(() => aborted.draft, "aborted")
	})

	it("closes the session when the patch listener throws", () => {
		const base = {a: 1}
		const session = DraftSession.open(base)
		const draft = session.draft
		draft.a = 2

		const boom = new Error("boom")
		expect(() => session.commit(() => { throw boom })).toThrow(boom)

		// The session must be closed: no open, still-mutable session remains.
		expect(session.state).toBe("committed")
		expect(() => session.draft).toThrow()
		expect(() => draft.a).toThrow()
		// The base state must not have been mutated.
		expect(base).toEqual({a: 1})
	})

	// This test pokes the internal `callbacks_` hook, which is mangled in
	// the production build, so it only runs in development.
	;(!isProd ? it : it.skip)(
		"releases drafts when finalization fails before revoking",
		() => {
		// A patch listener that throws after the scope was revoked is one
		// thing; here finalization itself is forced to throw by a draft
		// finalization callback that throws.
		const base = {a: 1}
		const session = DraftSession.open(base)
		const draft = session.draft
		draft.a = 2

		// Force finalization to throw by registering a throwing callback
		// through the internal DRAFT_STATE hook.
		const state = (draft as any)[Symbol.for("immer-state")]
		const realCallbacks = state.callbacks_
		state.callbacks_ = [
			...realCallbacks,
			() => {
				throw new Error("finalize boom")
			}
		]

		expect(() => session.commit()).toThrow(/finalize boom/)
		expect(session.state).toBe("committed")
		// The drafts must have been released even though finalization threw.
		expect(() => draft.a).toThrow()
		expect(base).toEqual({a: 1})
	})

	it("supports Map and Set when the MapSet plugin is enabled", () => {
		enableMapSet()
		const base = {map: new Map([["a", 1]]), set: new Set([1])}
		const session = DraftSession.open(base)
		session.draft.map.set("a", 2)
		session.draft.map.set("b", 3)
		session.draft.set.add(2)

		const result = session.commit()

		expect(result.map).toEqual(
			new Map([
				["a", 2],
				["b", 3]
			])
		)
		expect(result.set).toEqual(new Set([1, 2]))
		expect(base.map).toEqual(new Map([["a", 1]]))
		expect(base.set).toEqual(new Set([1]))
	})

	it("preserves nested references inside the draft tree", () => {
		const shared = {x: 1}
		const base: {a: any; b: any} = {a: shared, b: null}
		const session = DraftSession.open(base)
		const draft = session.draft
		// The same draft appears twice in the tree...
		draft.b = draft.a
		draft.a.x = 2

		const result = session.commit()

		expect(result).toEqual({a: {x: 2}, b: {x: 2}})
		// ...and the reference is preserved in the result.
		expect(result.a).toBe(result.b)
		// The base is untouched.
		expect(base.a).toBe(shared)
		expect(shared).toEqual({x: 1})
	})

	it("keeps foreign drafts usable across sessions", () => {
		// A draft from session A nested into session B is not owned by B.
		const sessionA = DraftSession.open({a: 1})
		const sessionB = DraftSession.open({outer: null as any})
		sessionB.draft.outer = sessionA.draft
		sessionA.draft.a = 2

		const resultB = sessionB.commit()
		// The foreign draft is left as-is in B's result.
		expect(isDraft(resultB.outer)).toBe(true)

		const resultA = sessionA.commit()
		expect(resultA).toEqual({a: 2})
	})

	it("works with a custom Immer instance", () => {
		const immer = new Immer({autoFreeze: false})
		const session = DraftSession.open({a: 1}, immer)
		session.draft.a = 2
		const result = session.commit()
		expect(result).toEqual({a: 2})
		expect(Object.isFrozen(result)).toBe(false)
	})

	it("does not leak its scope into a surrounding produce call", () => {
		const session = DraftSession.open({a: 1})
		session.draft.a = 2
		const result = produce({b: 1}, draft => {
			draft.b = 2
		})
		expect(result).toEqual({b: 2})
		expect(session.commit()).toEqual({a: 2})
	})

	it("leaves the original createDraft/finishDraft API unchanged", () => {
		const base = {a: 1}
		const draft = createDraft(base)
		draft.a = 2
		expect(finishDraft(draft)).toEqual({a: 2})
		expect(base).toEqual({a: 1})
	})
})
