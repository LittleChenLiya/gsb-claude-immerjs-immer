import {Immer, Objectish, Patch, Producer} from "./internal"
import {enablePatches} from "./plugins/patches"

/**
 * A single committed change, expressed as the forward patches (used by
 * `redo`) and the inverse patches (used by `undo`) that Immer generated
 * when the change was committed.
 */
export interface HistoryEntry {
	readonly patches: readonly Patch[]
	readonly inversePatches: readonly Patch[]
}

export interface HistoryOptions {
	/**
	 * Maximum number of undoable entries kept in history. When a commit
	 * exceeds the capacity, only the oldest undoable entries are evicted.
	 * Defaults to `Infinity` (unbounded).
	 */
	readonly capacity?: number
}

/**
 * A standalone undo/redo history for Immer states, built on top of
 * `produceWithPatches` and `applyPatches`.
 *
 * All state exposed by a history is read-only: it can only be changed
 * through `commit`, `undo` and `redo`.
 */
export interface History<T extends Objectish> {
	/** The current state. Read-only; frozen when autoFreeze is enabled. */
	readonly state: T
	/** Whether `undo()` can move one step back. */
	readonly canUndo: boolean
	/** Whether `redo()` can move one step forward. */
	readonly canRedo: boolean
	/** Number of committed entries that can still be undone. */
	readonly undoDepth: number
	/** Number of undone entries that can still be redone. */
	readonly redoDepth: number
	/**
	 * Runs `recipe` exactly once against the current state. On success the
	 * generated patches / inverse patches are stored as a new history entry
	 * and any previously undone (redo) branch is discarded. Recipes that
	 * produce no changes do not consume a history entry. If `recipe` throws,
	 * the current state and both history branches are left untouched.
	 *
	 * Returns the new current state.
	 */
	commit(recipe: Producer<T>): T
	/**
	 * Reverts the most recent commit by applying its inverse patches.
	 * No-op when there is nothing to undo. Returns the current state.
	 */
	undo(): T
	/**
	 * Re-applies the most recently undone commit. No-op when there is
	 * nothing to redo. Returns the current state.
	 */
	redo(): T
}

const immer = new Immer()

/**
 * Creates a standalone, self-contained undo/redo history around an initial
 * state. Changes are recorded as Immer patches / inverse patches, so undo
 * and redo preserve Immer's structural sharing guarantees.
 *
 * Does not change the behavior of the default exported `produce`.
 */
export function createHistory<T extends Objectish>(
	initialState: T,
	options: HistoryOptions = {}
): History<T> {
	enablePatches()

	const capacity = options.capacity ?? Infinity
	if (!(capacity >= 1)) {
		throw new Error(
			`[Immer] 'createHistory' expects a capacity of at least 1, got: ${capacity}`
		)
	}

	let state = initialState
	let past: HistoryEntry[] = []
	let future: HistoryEntry[] = []

	const history: History<T> = {
		get state() {
			return state
		},
		get canUndo() {
			return past.length > 0
		},
		get canRedo() {
			return future.length > 0
		},
		get undoDepth() {
			return past.length
		},
		get redoDepth() {
			return future.length
		},
		commit(recipe: Producer<T>): T {
			// Runs the recipe exactly once. If it throws, `state`, `past`
			// and `future` are all left untouched.
			const [next, patches, inversePatches] = immer.produceWithPatches(
				state,
				recipe
			)
			if (patches.length === 0) {
				// Empty changes don't consume a history entry.
				return state
			}
			past.push({patches, inversePatches})
			while (past.length > capacity) {
				past.shift()
			}
			// Committing from an undone state discards the old redo branch.
			future = []
			state = next
			return next
		},
		undo(): T {
			const entry = past.pop()
			if (!entry) return state
			state = immer.applyPatches(state, entry.inversePatches)
			future.push(entry)
			return state
		},
		redo(): T {
			const entry = future.pop()
			if (!entry) return state
			state = immer.applyPatches(state, entry.patches)
			past.push(entry)
			return state
		}
	}

	return Object.freeze(history)
}
