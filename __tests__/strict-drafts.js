"use strict"
import {
	Immer,
	enableMapSet,
	setUseStrictDrafts,
	createDraft,
	finishDraft
} from "../src/immer"

enableMapSet()

/**
 * Strict draft mode rejects assigning a live draft owned by another
 * `produce` / `createDraft` scope into the current draft. These tests cover
 * the acceptance criteria:
 *  - two manual drafts cross-assignment is rejected (with path + scope),
 *  - same-scope shared references are allowed,
 *  - a finalized plain result can be assigned,
 *  - after a rejected write the draft still accepts other legal edits,
 *  - Map and Set assignments follow the same gate,
 *  - default behavior (strict mode off) is unchanged.
 */

function createStrictImmer(options) {
	return new Immer({useStrictDrafts: true, ...options})
}

const isProd = process.env.NODE_ENV === "production"

// In production the error message is minified to a numeric code; in
// development it carries the full message including the write path and scope.
const CROSS_SCOPE_ERROR = isProd
	? /minified error nr: 16/
	: /Cross-scope draft assignment rejected/

describe("strict drafts", () => {
	it("rejects cross-scope assignment of two manual drafts", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft({a: 1})
		const d2 = immer.createDraft({b: 2})

		expect(() => {
			d1.a = d2
		}).toThrow(CROSS_SCOPE_ERROR)
	})

	it("reports the write path and the owning scope", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft({a: {b: 1}})
		const d2 = immer.createDraft({x: 2})

		try {
			d1.a.b = d2
			throw new Error("expected cross-scope assignment to throw")
		} catch (e) {
			expect(e.message).toMatch(CROSS_SCOPE_ERROR)
			if (!isProd) {
				expect(e.message).toMatch(/a\.b/)
				expect(e.message).toMatch(/produce scope #\d+/)
			}
		}
	})

	it("allows shared references within the same scope", () => {
		const immer = createStrictImmer()
		const base = {a: {x: 1}, b: {y: 2}}

		const result = immer.produce(base, draft => {
			const shared = draft.a
			draft.b = shared
			draft.c = shared
		})

		expect(result.b).toBe(result.a)
		expect(result.c).toBe(result.a)
		expect(result.a).toEqual({x: 1})
	})

	it("allows assigning a finalized plain result", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft({a: 1})
		d1.a = 10
		const plain = immer.finishDraft(d1)
		expect(plain).toEqual({a: 10})

		const d2 = immer.createDraft({b: 2})
		d2.b = plain
		const result = immer.finishDraft(d2)

		expect(result).toEqual({b: {a: 10}})
	})

	it("still accepts other legal edits after a rejected assignment", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft({a: 1, c: 3})
		const d2 = immer.createDraft({b: 2})

		expect(() => {
			d1.a = d2
		}).toThrow(CROSS_SCOPE_ERROR)

		// The rejected write must not have mutated the draft.
		expect(d1.a).toBe(1)

		// Other legal edits can still be committed.
		d1.c = 30
		d1.d = 4
		const result = immer.finishDraft(d1)

		expect(result).toEqual({a: 1, c: 30, d: 4})
	})

	it("covers Map assignments", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft(new Map([["a", 1]]))
		const d2 = immer.createDraft(new Map([["b", 2]]))

		expect(() => {
			d1.set("x", d2)
		}).toThrow(CROSS_SCOPE_ERROR)

		// The map draft is still usable after the rejected write.
		d1.set("a", 10)
		const result = immer.finishDraft(d1)
		expect(result.get("a")).toBe(10)
	})

	it("covers Set assignments", () => {
		const immer = createStrictImmer()
		const d1 = immer.createDraft(new Set([1]))
		const d2 = immer.createDraft(new Set([2]))

		expect(() => {
			d1.add(d2)
		}).toThrow(CROSS_SCOPE_ERROR)

		// The set draft is still usable after the rejected write.
		d1.add(3)
		const result = immer.finishDraft(d1)
		expect(result.has(1)).toBe(true)
		expect(result.has(3)).toBe(true)
		expect(result.has(d2)).toBe(false)
	})

	it("allows same-scope shared references inside a Map", () => {
		const immer = createStrictImmer()
		const result = immer.produce(new Map([["a", {x: 1}]]), draft => {
			const shared = draft.get("a")
			draft.set("b", shared)
		})

		expect(result.get("b")).toBe(result.get("a"))
		expect(result.get("a")).toEqual({x: 1})
	})

	it("rejects a cross-scope draft from a nested produce", () => {
		const immer = createStrictImmer()
		const outer = immer.createDraft({a: 1})

		expect(() => {
			immer.produce({b: 2}, inner => {
				inner.b = outer
			})
		}).toThrow(CROSS_SCOPE_ERROR)
	})

	it("leaves default behavior unchanged (strict mode off)", () => {
		const immer = new Immer()
		const d1 = immer.createDraft({a: 1})
		const d2 = immer.createDraft({b: 2})

		// Cross-scope assignment is allowed when strict mode is off.
		expect(() => {
			d1.a = d2
		}).not.toThrow()
	})

	it("can be toggled via the global setUseStrictDrafts", () => {
		const d1 = createDraft({a: 1})
		const d2 = createDraft({b: 2})

		setUseStrictDrafts(true)
		try {
			expect(() => {
				d1.a = d2
			}).toThrow(CROSS_SCOPE_ERROR)
		} finally {
			setUseStrictDrafts(false)
		}

		// Reset the drafts created above; they are still usable.
		expect(() => finishDraft(d1)).not.toThrow()
		expect(() => finishDraft(d2)).not.toThrow()
	})
})
