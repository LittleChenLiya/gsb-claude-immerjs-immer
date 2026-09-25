import {Immer, Objectish, Patch, Producer} from "../internal"

/**
 * A single committed change, described by the patches that were generated
 * when it was committed, and the inverse patches that restore the previous
 * state.
 */
export interface HistoryEntry {
	readonly patches: readonly Patch[]
	readonly inversePatches: readonly Patch[]
}

/**
 * A standalone, read-only view over an ImmerHistory instance.
 * All arrays returned by the getters are snapshots; mutating them does not
 * affect the history itself.
 */
export interface History<T> {
	/** The current state. */
	readonly state: T
	/** Whether there is a change that can be undone. */
	readonly canUndo: boolean
	/** Whether there is a change that can be redone. */
	readonly canRedo: boolean
	/** Number of undoable changes currently retained. */
	readonly undoDepth: number
	/** Number of redoable changes currently retained. */
	readonly redoDepth: number
	/** Snapshot of the retained undoable entries, oldest first. */
	readonly undoHistory: readonly HistoryEntry[]
	/** Snapshot of the retained redoable entries, oldest first. */
	readonly redoHistory: readonly HistoryEntry[]
	/**
	 * Runs the recipe once against the current state. On success the resulting
	 * patches are stored as a new undoable entry and any retained redo branch
	 * is discarded. No-op recipes (no patches) are not recorded. If the recipe
	 * throws, the state and both histories are left untouched.
	 */
	commit(recipe: Producer<T>): T
	/** Reverts the most recent committed change. Returns the current state. */
	undo(): T
	/** Re-applies the most recently undone change. Returns the current state. */
	redo(): T
	/** Drops all retained undo and redo entries. */
	clear(): void
}

export interface HistoryOptions {
	/**
	 * Maximum number of undoable entries retained. When a commit exceeds the
	 * capacity, the oldest undoable entries are evicted. Defaults to
	 * Infinity (unbounded).
	 */
	capacity?: number
}

// The history helper uses its own Immer instance so it never interferes with
// the configuration (auto freeze, strict mode, ...) of the default produce
// export. Plugins are registered module-wide, so enablePatches() must have
// been called by the consumer before creating a history.
const immer = new Immer()
const produceWithPatches = immer.produceWithPatches.bind(immer)
const applyPatches = immer.applyPatches.bind(immer)

/**
 * Creates a small undo/redo history around an immutable state, powered by
 * Immer patches and inverse patches.
 *
 * Requires enablePatches() to have been called.
 */
export function createHistory<T>(
	initialState: T,
	options: HistoryOptions = {}
): History<T> {
	const capacity = options.capacity ?? Infinity
	if (!(capacity > 0)) {
		throw new Error("[immer] history capacity must be a positive number")
	}

	let state = initialState
	let undoStack: HistoryEntry[] = []
	let redoStack: HistoryEntry[] = []

	return {
		get state() {
			return state
		},
		get canUndo() {
			return undoStack.length > 0
		},
		get canRedo() {
			return redoStack.length > 0
		},
		get undoDepth() {
			return undoStack.length
		},
		get redoDepth() {
			return redoStack.length
		},
		get undoHistory() {
			return undoStack.slice()
		},
		get redoHistory() {
			return redoStack.slice()
		},
		commit(recipe: Producer<T>): T {
			// The recipe runs exactly once. If it throws, produceWithPatches
			// propagates the error before we touch any history bookkeeping.
			const [nextState, patches, inversePatches] = produceWithPatches(
				state,
				recipe
			)
			if (patches.length === 0) {
				// No-op commit: does not occupy a history slot and does not
				// discard the redo branch.
				return state
			}
			undoStack.push({patches, inversePatches})
			while (undoStack.length > capacity) {
				undoStack.shift()
			}
			// A new change invalidates the previously undone branch.
			redoStack = []
			state = nextState
			return nextState
		},
		undo(): T {
			const entry = undoStack.pop()
			if (!entry) return state
			state = applyPatches(state as Objectish, entry.inversePatches) as T
			redoStack.push(entry)
			return state
		},
		redo(): T {
			const entry = redoStack.pop()
			if (!entry) return state
			state = applyPatches(state as Objectish, entry.patches) as T
			undoStack.push(entry)
			return state
		},
		clear(): void {
			undoStack = []
			redoStack = []
		}
	}
}
