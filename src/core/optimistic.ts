import {
	Draft,
	Immutable,
	Objectish,
	DRAFT_STATE,
	revokeScope,
	Immer
} from "../internal"

/**
 * A recipe that mutates a draft of the container state. Recipes are allowed
 * to be async: the draft stays valid across `await` points, and the version
 * is re-checked after the recipe settles, so a stale recipe can never
 * overwrite a state that was published in the meantime.
 */
export type OptimisticRecipe<T> = (draft: Draft<T>) => void | Promise<void>

/**
 * The outcome of a {@link OptimisticContainer.submit} call.
 *
 * - `"committed"`: the recipe was based on the current version and its
 *   changes (if any) were published. A recipe that produced no changes is
 *   still committed, but the version is not bumped and subscribers are not
 *   notified.
 * - `"conflict"`: the recipe was based on an outdated version (either at
 *   call time or after an async gap) and was discarded. The container state
 *   and version are untouched and subscribers are not notified.
 */
export type OptimisticCommitStatus = "committed" | "conflict"

export interface OptimisticCommitResult<T> {
	status: OptimisticCommitStatus
	/** The current immutable state. On conflict this is the newer state. */
	state: Immutable<T>
	/** The current version. On conflict this is the newer version. */
	version: number
	/** The version the caller attempted to commit from. */
	expectedVersion: number
}

/**
 * Called after a successful commit with the new state, the previous state and
 * the new version. Both states are immutable (frozen).
 */
export interface OptimisticListener<T> {
	(nextState: Immutable<T>, prevState: Immutable<T>, version: number): void
}

/**
 * An immutable, versioned state container with optimistic concurrency
 * control. Callers read the current {@link OptimisticContainer.state} and
 * {@link OptimisticContainer.version}, then submit a recipe together with the
 * version it was based on. The version is checked before the recipe runs and
 * again after it settles, so only a recipe based on the latest state can
 * ever commit.
 *
 * Structural sharing and freezing are inherited from Immer: unchanged parts
 * of the state keep their reference, changed parts are copied, and the
 * resulting state is deeply frozen.
 */
export interface OptimisticContainer<T> {
	/** The current immutable state. */
	readonly state: Immutable<T>
	/** The current version, starting at 0. Only successful commits bump it. */
	readonly version: number
	/**
	 * Submit a recipe against the version it was based on.
	 *
	 * The version is checked synchronously at call time and again after the
	 * recipe settles. A mismatch yields a `"conflict"` result: the recipe is
	 * discarded, the container state and version stay as-is, and subscribers
	 * are not notified. A throwing recipe propagates the error without
	 * bumping the version or notifying subscribers.
	 */
	submit(
		expectedVersion: number,
		recipe: OptimisticRecipe<T>
	): Promise<OptimisticCommitResult<T>>
	/**
	 * Subscribe to successful commits. The listener receives the new state,
	 * the previous state and the new version, all immutable. Returns an
	 * unsubscribe function.
	 */
	subscribe(listener: OptimisticListener<T>): () => void
}

/**
 * Create an {@link OptimisticContainer} bound to the given Immer instance.
 *
 * The initial state is finalized through Immer (and frozen when
 * auto-freezing is enabled), so subscribers always receive immutable states.
 */
export function createOptimistic<T extends Objectish>(
	immer: Immer,
	initialState: T
): OptimisticContainer<T> {
	// Finalize the initial state through Immer: this deep-freezes it (when
	// auto-freezing is on) while keeping structural sharing.
	let state: Immutable<T> = immer.produce(initialState, () => {}) as Immutable<T>
	let version = 0
	const listeners = new Set<OptimisticListener<T>>()

	function discardDraft(draft: Draft<T>): void {
		const scope = (draft as any)[DRAFT_STATE]?.scope_
		if (scope) revokeScope(scope)
	}

	async function submit(
		expectedVersion: number,
		recipe: OptimisticRecipe<T>
	): Promise<OptimisticCommitResult<T>> {
		// Optimistic concurrency check #1: at call time. A recipe based on an
		// already outdated version is never even started.
		if (expectedVersion !== version) {
			return {status: "conflict", state, version, expectedVersion}
		}

		// A manual draft stays valid across `await` points.
		const draft = immer.createDraft(state as T)
		try {
			await recipe(draft)
		} catch (error) {
			// A failed recipe must not bump the version or notify anyone.
			discardDraft(draft)
			throw error
		}

		// Optimistic concurrency check #2: after the async gap. Another commit
		// may have landed while the recipe was waiting.
		if (expectedVersion !== version) {
			discardDraft(draft)
			return {status: "conflict", state, version, expectedVersion}
		}

		const next = immer.finishDraft(draft) as Immutable<T>

		// No-change convention: a recipe that produced no changes is committed
		// successfully, but since the state is identical there is nothing to
		// publish - the version stays and subscribers are not notified.
		if (next === state) {
			return {status: "committed", state, version, expectedVersion}
		}

		const prev = state
		state = next
		version++
		// Snapshot so listeners added/removed during notification don't affect
		// this round of notifications.
		;[...listeners].forEach(listener => listener(state, prev, version))
		return {status: "committed", state, version, expectedVersion}
	}

	return {
		get state() {
			return state
		},
		get version() {
			return version
		},
		submit,
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		}
	}
}
