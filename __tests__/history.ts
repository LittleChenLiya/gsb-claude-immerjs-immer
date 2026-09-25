import {vi} from "vitest"
import {produce, createHistory, enablePatches} from "../src/immer"

enablePatches()

vi.setConfig({
	testTimeout: 1000
})

type Todo = {id: number; done: boolean}
type State = {
	title: string
	nested: {count: number; tags: string[]}
	todos: Todo[]
}

function createBaseState(): State {
	return {
		title: "initial",
		nested: {count: 0, tags: ["a"]},
		todos: [{id: 1, done: false}]
	}
}

describe("history: commit / undo / redo / branching", () => {
	it("commits twice, undoes, redoes, then branches from the undone point", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)
		expect(history.state).toBe(base)

		// two commits touching an array and a nested object
		const s1 = history.commit(draft => {
			draft.todos.push({id: 2, done: false})
			draft.nested.count = 1
		})
		const s2 = history.commit(draft => {
			draft.todos[0].done = true
			draft.nested.tags.push("b")
		})

		expect(s2.todos).toEqual([
			{id: 1, done: true},
			{id: 2, done: false}
		])
		expect(s2.nested).toEqual({count: 1, tags: ["a", "b"]})
		expect(history.undoDepth).toBe(2)
		expect(history.canUndo).toBe(true)
		expect(history.canRedo).toBe(false)

		// undo the second commit: values match s1
		const u1 = history.undo()
		expect(u1).toEqual(s1)
		expect(history.state).toBe(u1)
		expect(history.canRedo).toBe(true)
		expect(history.redoDepth).toBe(1)

		// redo restores the second commit
		const r1 = history.redo()
		expect(r1).toEqual(s2)
		expect(history.canRedo).toBe(false)
		expect(history.undoDepth).toBe(2)

		// undo again and start a new branch: the old redo branch is dropped
		const u2 = history.undo()
		expect(u2).toEqual(s1)
		const branch = history.commit(draft => {
			draft.title = "branch"
		})
		expect(branch.title).toBe("branch")
		expect(branch.todos).toEqual(s1.todos)
		expect(history.canRedo).toBe(false)
		expect(history.redoDepth).toBe(0)
		expect(history.undoDepth).toBe(2)

		// the branch knows where it goes: undo all the way, redo all the way
		// ends up at the branch state, not at the discarded s2
		expect(history.undo()).toEqual(s1)
		expect(history.undo()).toEqual(base)
		expect(history.canUndo).toBe(false)
		expect(history.redo()).toEqual(s1)
		expect(history.redo()).toEqual(branch)
		expect(history.state.title).toBe("branch")
		expect(history.state.nested.tags).toEqual(["a"])
	})

	it("keeps Immer structural sharing for values and references", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)

		const s1 = history.commit(draft => {
			draft.nested.count = 1
		})
		// untouched parts are shared with the base state
		expect(s1.todos).toBe(base.todos)
		expect(s1.nested.tags).toBe(base.nested.tags)
		expect(s1.nested).not.toBe(base.nested)

		const s2 = history.commit(draft => {
			draft.todos.push({id: 2, done: true})
		})
		expect(s2.nested).toBe(s1.nested)
		expect(s2.todos[0]).toBe(s1.todos[0])

		// undo restores values; untouched references keep being shared
		const u1 = history.undo()
		expect(u1).toEqual(s1)
		expect(u1.nested).toBe(s2.nested)
		expect(u1.todos[0]).toBe(s1.todos[0])

		const u0 = history.undo()
		expect(u0).toEqual(base)
		expect(u0.todos).toBe(u1.todos)
	})
})

describe("history: capacity", () => {
	it("evicts only the oldest undoable entries beyond capacity", () => {
		const base = createBaseState()
		const history = createHistory<State>(base, {capacity: 1})

		history.commit(draft => {
			draft.nested.count = 1
		})
		history.commit(draft => {
			draft.nested.count = 2
		})
		expect(history.undoDepth).toBe(1)

		// only the newest change can be undone
		const u = history.undo()
		expect(u.nested.count).toBe(1)
		expect(history.canUndo).toBe(false)
		// the first commit (back to base) was evicted
		expect(history.undo().nested.count).toBe(1)
	})

	it("rejects a non-positive capacity", () => {
		expect(() => createHistory(createBaseState(), {capacity: 0})).toThrow()
	})
})

describe("history: no-op commits", () => {
	it("does not record empty modifications and runs the recipe only once", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)

		history.commit(draft => {
			draft.nested.count = 1
		})
		history.undo()
		expect(history.canRedo).toBe(true)
		const atHead = history.state

		let runs = 0
		const result = history.commit(draft => {
			runs++
			// no modifications
		})
		expect(runs).toBe(1)
		expect(result).toBe(atHead)
		expect(history.undoDepth).toBe(0)
		// a no-op commit does not discard the redo branch either
		expect(history.canRedo).toBe(true)
		expect(history.redo().nested.count).toBe(1)
	})

	it("runs every recipe exactly once, even when it changes nothing", () => {
		const history = createHistory<State>(createBaseState())
		const recipe = vi.fn((draft: State) => {
			draft.title = "x"
		})
		history.commit(recipe)
		expect(recipe).toHaveBeenCalledTimes(1)
	})
})

describe("history: root replacement", () => {
	it("supports recipes that replace the entire root object", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)

		const replacement: State = {
			title: "replaced",
			nested: {count: 42, tags: []},
			todos: []
		}
		const s1 = history.commit(() => replacement)
		expect(s1).toEqual(replacement)
		expect(history.undoDepth).toBe(1)

		const u = history.undo()
		expect(u).toEqual(base)
		expect(u.nested).toEqual(base.nested)

		const r = history.redo()
		expect(r).toEqual(replacement)
	})
})

describe("history: recipe errors", () => {
	it("leaves state and both histories untouched when the recipe throws", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)

		history.commit(draft => {
			draft.nested.count = 1
		})
		const before = history.state
		history.undo()
		const atBase = history.state
		expect(history.canRedo).toBe(true)

		expect(() =>
			history.commit(draft => {
				draft.nested.count = 99
				throw new Error("boom")
			})
		).toThrow("boom")

		// current state and both stacks are exactly as before the failure
		expect(history.state).toBe(atBase)
		expect(history.undoDepth).toBe(0)
		expect(history.redoDepth).toBe(1)
		expect(history.redo()).toEqual(before)
	})
})

describe("history: undo / redo boundaries", () => {
	it("undoing past the beginning is a no-op", () => {
		const base = createBaseState()
		const history = createHistory<State>(base)

		history.commit(draft => {
			draft.nested.count = 1
		})
		history.undo()
		expect(history.canUndo).toBe(false)
		// consecutive undos at the head keep returning the same state
		const atBase = history.state
		expect(atBase).toEqual(base)
		expect(history.undo()).toBe(atBase)
		expect(history.undo()).toBe(atBase)
		expect(history.redoDepth).toBe(1)
	})

	it("redoing past the end is a no-op", () => {
		const history = createHistory<State>(createBaseState())
		expect(history.canRedo).toBe(false)
		const state = history.state
		expect(history.redo()).toBe(state)
	})
})

describe("history: read-only view", () => {
	it("exposes snapshots that cannot mutate the internal history", () => {
		const history = createHistory<State>(createBaseState())
		history.commit(draft => {
			draft.nested.count = 1
		})
		history.commit(draft => {
			draft.nested.count = 2
		})
		history.undo()

		const undoEntries = history.undoHistory
		const redoEntries = history.redoHistory
		expect(undoEntries).toHaveLength(1)
		expect(redoEntries).toHaveLength(1)
		expect(undoEntries[0].patches).toEqual([
			{op: "replace", path: ["nested", "count"], value: 1}
		])
		expect(redoEntries[0].inversePatches).toEqual([
			{op: "replace", path: ["nested", "count"], value: 1}
		])

		// mutating the returned snapshots does not leak into the history
		;(undoEntries as unknown as unknown[]).pop()
		;(redoEntries as unknown as unknown[]).pop()
		expect(history.undoDepth).toBe(1)
		expect(history.redoDepth).toBe(1)
	})
})

describe("history: does not change default produce behavior", () => {
	it("produce still works standalone and records nothing", () => {
		const base = createBaseState()
		const next = produce(base, draft => {
			draft.nested.count = 5
		})
		expect(next.nested.count).toBe(5)
		expect(base.nested.count).toBe(0)
	})
})
