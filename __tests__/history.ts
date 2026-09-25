import {describe, it, expect, vi} from "vitest"
import {createHistory, produce} from "../src/immer"

interface Todo {
	id: number
	title: string
	done: boolean
}

interface State {
	todos: Todo[]
	meta: {
		owner: string
		settings: {
			theme: string
		}
	}
}

function baseState(): State {
	return {
		todos: [
			{id: 1, title: "one", done: false},
			{id: 2, title: "two", done: false}
		],
		meta: {
			owner: "alice",
			settings: {
				theme: "light"
			}
		}
	}
}

describe("history", () => {
	it("commits, undoes and redoes changes on arrays and nested objects", () => {
		const history = createHistory(baseState())
		const s0 = history.state

		const s1 = history.commit(draft => {
			draft.todos.push({id: 3, title: "three", done: false})
			draft.meta.settings.theme = "dark"
		})
		expect(s1.todos).toHaveLength(3)
		expect(s1.meta.settings.theme).toBe("dark")
		expect(history.state).toBe(s1)
		expect(history.canUndo).toBe(true)
		expect(history.undoDepth).toBe(1)

		const s2 = history.commit(draft => {
			draft.todos[0].done = true
		})
		expect(s2.todos[0].done).toBe(true)
		expect(history.undoDepth).toBe(2)

		// undo one step: back to s1 values
		const u1 = history.undo()
		expect(u1.todos[0].done).toBe(false)
		expect(u1.todos).toHaveLength(3)
		expect(u1.meta.settings.theme).toBe("dark")
		expect(history.canRedo).toBe(true)
		expect(history.redoDepth).toBe(1)

		// undo to the very beginning
		const u0 = history.undo()
		expect(u0).toEqual(s0)
		expect(history.canUndo).toBe(false)

		// redo both steps
		const r1 = history.redo()
		expect(r1.todos).toHaveLength(3)
		expect(r1.meta.settings.theme).toBe("dark")
		const r2 = history.redo()
		expect(r2.todos[0].done).toBe(true)
		expect(r2).toEqual(s2)
		expect(history.canRedo).toBe(false)
	})

	it("discards the redo branch when committing from an undone state", () => {
		const history = createHistory(baseState())

		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		history.commit(draft => {
			draft.meta.owner = "carol"
		})
		expect(history.state.meta.owner).toBe("carol")

		history.undo()
		expect(history.state.meta.owner).toBe("bob")
		expect(history.canRedo).toBe(true)

		// commit a diverging branch: the "carol" redo branch is dropped
		history.commit(draft => {
			draft.meta.owner = "dave"
		})
		expect(history.state.meta.owner).toBe("dave")
		expect(history.canRedo).toBe(false)
		expect(history.redoDepth).toBe(0)

		// the new branch is a proper history entry: undo goes to "bob",
		// redo returns to "dave" (never to "carol")
		history.undo()
		expect(history.state.meta.owner).toBe("bob")
		history.redo()
		expect(history.state.meta.owner).toBe("dave")
		expect(history.canRedo).toBe(false)
	})

	it("evicts only the oldest undoable entry when capacity is exceeded", () => {
		const history = createHistory(baseState(), {capacity: 1})

		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		history.commit(draft => {
			draft.meta.owner = "carol"
		})
		expect(history.undoDepth).toBe(1)

		// only the newest commit can be undone
		history.undo()
		expect(history.state.meta.owner).toBe("bob")
		expect(history.canUndo).toBe(false)
		// the oldest entry ("alice" <- "bob") was evicted, undo is a no-op
		history.undo()
		expect(history.state.meta.owner).toBe("bob")

		history.redo()
		expect(history.state.meta.owner).toBe("carol")
	})

	it("rejects a capacity smaller than 1", () => {
		expect(() => createHistory(baseState(), {capacity: 0})).toThrow(
			/capacity of at least 1/
		)
	})

	it("does not consume a history entry for empty changes", () => {
		const history = createHistory(baseState())
		const before = history.state

		const result = history.commit(draft => {
			// no-op recipe
		})
		expect(result).toBe(before)
		expect(history.state).toBe(before)
		expect(history.canUndo).toBe(false)
		expect(history.undoDepth).toBe(0)

		// a real change afterwards is still the first entry
		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		expect(history.undoDepth).toBe(1)
	})

	it("supports replacing the entire root object", () => {
		const history = createHistory(baseState())
		const replacement: State = {
			todos: [],
			meta: {owner: "nobody", settings: {theme: "solarized"}}
		}

		history.commit(() => replacement)
		expect(history.state).toEqual(replacement)
		expect(history.state.todos).toHaveLength(0)

		history.undo()
		expect(history.state).toEqual(baseState())

		history.redo()
		expect(history.state).toEqual(replacement)
	})

	it("keeps state and both branches untouched when the recipe throws", () => {
		const history = createHistory(baseState())
		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		history.undo()
		// now: state.owner = "alice", undoDepth = 0, redoDepth = 1

		const stateBefore = history.state
		const recipe = vi.fn((draft: State) => {
			draft.meta.owner = "broken"
			throw new Error("boom")
		})
		expect(() => history.commit(recipe)).toThrow("boom")

		expect(recipe).toHaveBeenCalledTimes(1)
		expect(history.state).toBe(stateBefore)
		expect(history.state.meta.owner).toBe("alice")
		expect(history.undoDepth).toBe(0)
		expect(history.redoDepth).toBe(1)

		// redo still works, proving the redo branch survived
		history.redo()
		expect(history.state.meta.owner).toBe("bob")
	})

	it("runs each recipe exactly once per commit", () => {
		const history = createHistory(baseState())
		const recipe = vi.fn((draft: State) => {
			draft.meta.owner = "bob"
		})
		history.commit(recipe)
		expect(recipe).toHaveBeenCalledTimes(1)

		// empty changes are detected without re-running the recipe
		const noop = vi.fn((_draft: State) => {})
		history.commit(noop)
		expect(noop).toHaveBeenCalledTimes(1)
	})

	it("makes undo a no-op once the beginning of history is reached", () => {
		const history = createHistory(baseState())
		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		history.commit(draft => {
			draft.meta.owner = "carol"
		})

		history.undo()
		history.undo()
		expect(history.state.meta.owner).toBe("alice")
		expect(history.canUndo).toBe(false)

		// extra undos are no-ops and keep the redo branch intact
		const state = history.state
		expect(history.undo()).toBe(state)
		expect(history.state.meta.owner).toBe("alice")
		expect(history.redoDepth).toBe(2)

		history.redo()
		history.redo()
		expect(history.state.meta.owner).toBe("carol")
		expect(history.canRedo).toBe(false)
		expect(history.redo()).toBe(history.state)
	})

	it("preserves Immer's structural sharing across commit/undo/redo", () => {
		const history = createHistory(baseState())
		const s0 = history.state

		const s1 = history.commit(draft => {
			draft.todos[0].done = true
		})
		// untouched branches keep their identity
		expect(s1.meta).toBe(s0.meta)
		expect(s1.todos[1]).toBe(s0.todos[1])
		// changed branches are new objects
		expect(s1.todos).not.toBe(s0.todos)
		expect(s1.todos[0]).not.toBe(s0.todos[0])

		const u = history.undo()
		expect(u.meta).toBe(s0.meta)
		expect(u.todos[0].done).toBe(false)

		const r = history.redo()
		expect(r.meta).toBe(s0.meta)
		expect(r.todos[0].done).toBe(true)
		expect(r.todos[1]).toBe(s0.todos[1])
	})

	it("exposes a read-only view of the history", () => {
		const history = createHistory(baseState())
		expect(Object.isFrozen(history)).toBe(true)
		expect(() => {
			;(history as any).state = {}
		}).toThrow()
		expect(() => {
			;(history as any).undoDepth = 42
		}).toThrow()
		// the state itself is frozen by Immer's autoFreeze
		history.commit(draft => {
			draft.meta.owner = "bob"
		})
		expect(Object.isFrozen(history.state)).toBe(true)
		expect(Object.isFrozen(history.state.meta)).toBe(true)
	})

	it("does not change the default produce behavior", () => {
		// createHistory enables the patches plugin internally, but the
		// default produce export keeps working exactly as before
		const base = baseState()
		const next = produce(base, draft => {
			draft.meta.owner = "bob"
		})
		expect(next.meta.owner).toBe("bob")
		expect(base.meta.owner).toBe("alice")
		expect(next.meta).not.toBe(base.meta)
		expect(next.todos).toBe(base.todos)
	})
})
