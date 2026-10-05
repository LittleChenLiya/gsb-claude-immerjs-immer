"use strict"
import {
	Immer,
	createDraft,
	finishDraft,
	setUseStrictDraftScope,
	enableMapSet,
	enableArrayMethods
} from "../src/immer"

enableMapSet()
enableArrayMethods()

const strictImmer = () => new Immer({useStrictDraftScope: true})

const isProd = process.env.NODE_ENV === "production"
// In production builds error messages are minified to their error number
const strictScopeError = isProd
	? /minified error nr: 16/
	: /Strict draft scope mode/

describe("strict draft scope mode", () => {
	describe("manual drafts", () => {
		it("rejects assigning a draft from another open scope, reporting write path and source scope", () => {
			const immer = strictImmer()
			const d1 = immer.createDraft({x: 1})
			const d2 = immer.createDraft({ref: null})

			let err
			try {
				d2.ref = d1
			} catch (e) {
				err = e
			}
			expect(err).toBeInstanceOf(Error)
			expect(err.message).toMatch(strictScopeError)
			if (!isProd) {
				// reports the write path ...
				expect(err.message).toMatch(/'draft\.ref'/)
				// ... and the source scope
				expect(err.message).toMatch(/scope #\d+ \(createDraft\)/)
			}

			immer.finishDraft(d1)
			immer.finishDraft(d2)
		})

		it("reports the full write path for nested drafts", () => {
			const immer = strictImmer()
			const d1 = immer.createDraft({x: 1})
			const d2 = immer.createDraft({nested: {list: [null]}})

			let err
			try {
				d2.nested.list[0] = d1
			} catch (e) {
				err = e
			}
			expect(err.message).toMatch(strictScopeError)
			if (!isProd) {
				expect(err.message).toMatch(/'draft\.nested\.list\[0\]'/)
			}

			immer.finishDraft(d1)
			immer.finishDraft(d2)
		})

		it("allows sharing a draft within the same scope", () => {
			const immer = strictImmer()
			const d = immer.createDraft({a: {v: 1}, b: null})
			d.b = d.a
			const result = immer.finishDraft(d)
			expect(result.b).toEqual({v: 1})
			expect(result.b).toBe(result.a)
		})

		it("allows assigning a finalized plain result", () => {
			const immer = strictImmer()
			const d1 = immer.createDraft({x: 1})
			d1.x = 2
			const finalized = immer.finishDraft(d1)

			const d2 = immer.createDraft({ref: null})
			// `finalized` is a plain value now, not a draft: must not be rejected
			d2.ref = finalized
			const result = immer.finishDraft(d2)
			expect(result.ref).toEqual({x: 2})
		})

		it("keeps the current draft usable after a rejected assignment", () => {
			const immer = new Immer()
			immer.setUseStrictDraftScope(true)
			const d1 = immer.createDraft({x: 1})
			const d2 = immer.createDraft({ok: 0, ref: null})

			expect(() => {
				d2.ref = d1
			}).toThrow(strictScopeError)

			// other legal edits still go through and can be committed
			d2.ok = 42
			const result = immer.finishDraft(d2)
			expect(result).toEqual({ok: 42, ref: null})

			immer.finishDraft(d1)
		})
	})

	describe("Map/Set plugin", () => {
		it("rejects foreign drafts in Map.set and Set.add, then accepts legal edits", () => {
			const immer = strictImmer()
			const d1 = immer.createDraft({v: 1})

			const dm = immer.createDraft(new Map())
			expect(() => dm.set("k", d1)).toThrow(strictScopeError)
			dm.set("k", {plain: true})
			expect(immer.finishDraft(dm).get("k")).toEqual({plain: true})

			const ds = immer.createDraft(new Set())
			expect(() => ds.add(d1)).toThrow(strictScopeError)
			ds.add("ok")
			expect([...immer.finishDraft(ds)]).toEqual(["ok"])

			immer.finishDraft(d1)
		})

		it("allows same-scope shared values in Maps and Sets", () => {
			const immer = strictImmer()
			const res = immer.produce(
				{m: new Map(), s: new Set(), shared: {v: 1}},
				draft => {
					draft.m.set("s", draft.shared)
					draft.s.add(draft.shared)
				}
			)
			expect(res.m.get("s")).toBe(res.shared)
			expect([...res.s][0]).toBe(res.shared)
		})
	})

	describe("arrays", () => {
		it("rejects foreign drafts via push/unshift/splice and stays editable", () => {
			const immer = strictImmer()
			const d1 = immer.createDraft({v: 1})
			const d2 = immer.createDraft([1, 2])

			let err
			try {
				d2.push(d1)
			} catch (e) {
				err = e
			}
			expect(err.message).toMatch(strictScopeError)
			if (!isProd) {
				expect(err.message).toMatch(/'draft\[2\]'/)
			}
			expect(() => d2.unshift(d1)).toThrow(strictScopeError)
			expect(() => d2.splice(1, 0, d1)).toThrow(strictScopeError)

			d2.push(3)
			expect(immer.finishDraft(d2)).toEqual([1, 2, 3])

			immer.finishDraft(d1)
		})
	})

	describe("produce", () => {
		it("allows sharing drafts within one produce scope", () => {
			const immer = strictImmer()
			const res = immer.produce({a: {v: 1}, b: null}, draft => {
				draft.b = draft.a
			})
			expect(res.b).toBe(res.a)
		})

		it("rejects drafts from a nested produce scope", () => {
			const immer = strictImmer()
			expect(() =>
				immer.produce({items: []}, outer => {
					immer.produce({v: 1}, inner => {
						outer.items.push(inner)
					})
				})
			).toThrow(strictScopeError)
		})
	})

	describe("default behavior", () => {
		it("does not reject cross-scope assignment when strict mode is disabled", () => {
			const immer = new Immer()
			const d1 = immer.createDraft({x: 1})
			const d2 = immer.createDraft({ref: null})
			expect(() => {
				d2.ref = d1
			}).not.toThrow()
			// undo the cross-scope assignment before finishing
			d2.ref = null
			immer.finishDraft(d1)
			expect(immer.finishDraft(d2)).toEqual({ref: null})
		})

		it("can be toggled on the default exported instance", () => {
			setUseStrictDraftScope(true)
			try {
				const d1 = createDraft({x: 1})
				const d2 = createDraft({ref: null})
				expect(() => {
					d2.ref = d1
				}).toThrow(strictScopeError)
				finishDraft(d1)
				finishDraft(d2)
			} finally {
				setUseStrictDraftScope(false)
			}
		})
	})
})
