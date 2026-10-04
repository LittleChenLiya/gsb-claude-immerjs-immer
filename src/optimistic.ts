import {createDraft, finishDraft, freeze} from "./immer"
import {Draft, Objectish} from "./internal"

/**
 * An immutable snapshot of an {@link OptimisticContainer}: the current state
 * plus the version that produced it. Versions start at `0` and are only ever
 * incremented by a successful commit.
 */
export interface OptimisticSnapshot<S> {
	readonly state: S
	readonly version: number
}

/**
 * The payload delivered to subscribers after a successful commit. Both states
 * are deeply frozen (when auto-freeze is enabled) and share structure with
 * each other, exactly like successive `produce` results do.
 */
export interface OptimisticNotification<S> {
	readonly state: S
	readonly previousState: S
	readonly version: number
	readonly previousVersion: number
}

export type OptimisticListener<S> = (
	notification: OptimisticNotification<S>
) => void

/**
 * A recipe mutates a draft of the current state, exactly like a `produce`
 * recipe. Unlike `produce`, the recipe may be asynchronous: it can `await`
 * while holding the draft. The draft is only finalized once the recipe has
 * completed *and* the container is still at the expected version. Return
 * values are ignored; mutate the draft instead.
 */
export type OptimisticRecipe<S> = (draft: Draft<S>) => void | Promise<void>

/**
 * Thrown (as a promise rejection) when a commit's expected version no longer
 * matches the container's current version. A rejected commit never changes
 * the state, never bumps the version and never notifies subscribers.
 */
export class VersionConflictError extends Error {
	readonly expectedVersion: number
	readonly actualVersion: number

	constructor(expectedVersion: number, actualVersion: number) {
		super(
			`Optimistic commit rejected: expected version ${expectedVersion}, but the container is at version ${actualVersion}`
		)
		this.name = "VersionConflictError"
		this.expectedVersion = expectedVersion
		this.actualVersion = actualVersion
	}
}

export interface OptimisticContainer<S> {
	/**
	 * Returns the current immutable snapshot: `{state, version}`.
	 */
	getState(): OptimisticSnapshot<S>

	/**
	 * Runs `recipe` against a draft of the current state and publishes the
	 * result, but only if `expectedVersion` still equals the container's
	 * version once the recipe has completed.
	 *
	 * The version is checked twice: when `commit` is called (fail fast) and
	 * again after the recipe has finished (the recipe may have awaited in
	 * between). If another commit landed meanwhile, the stale draft is
	 * discarded and the returned promise rejects with a
	 * {@link VersionConflictError} — the old draft can never overwrite the
	 * newer state.
	 *
	 * Only a successful commit increments the version (by exactly one) and
	 * notifies subscribers. A recipe that throws or rejects discards its
	 * draft: no version bump, no notification.
	 *
	 * No-change convention: if the recipe leaves the state unmodified, the
	 * commit is a successful no-op — it resolves with the current snapshot
	 * (identical state reference), the version is *not* bumped and
	 * subscribers are *not* notified.
	 */
	commit(
		expectedVersion: number,
		recipe: OptimisticRecipe<S>
	): Promise<OptimisticSnapshot<S>>

	/**
	 * Registers a listener that is called synchronously after every
	 * successful commit with the frozen previous/next state and both
	 * versions. Returns an unsubscribe function. Rejected and no-change
	 * commits never notify.
	 */
	subscribe(listener: OptimisticListener<S>): () => void
}

/**
 * Creates an optimistic-update container on top of Immer's `produce`
 * machinery (`createDraft` / `finishDraft`, so recipes may be async).
 *
 * Every read and every resolved commit yields a `{state, version}` snapshot;
 * callers submit recipes together with the version they based their work on,
 * and the container guarantees that only one commit per version can win.
 */
export function createOptimisticContainer<S extends Objectish>(
	initialState: S
): OptimisticContainer<S> {
	let state: S = freeze(initialState, true)
	let version = 0
	const listeners = new Set<OptimisticListener<S>>()

	function snapshot(): OptimisticSnapshot<S> {
		return {state, version}
	}

	function assertVersion(expectedVersion: number) {
		if (expectedVersion !== version) {
			throw new VersionConflictError(expectedVersion, version)
		}
	}

	async function commit(
		expectedVersion: number,
		recipe: OptimisticRecipe<S>
	): Promise<OptimisticSnapshot<S>> {
		// Fail fast if the caller's expected version is already stale.
		assertVersion(expectedVersion)

		// Use a manual draft so the recipe may await between mutations.
		const draft = createDraft(state)
		// A throwing/rejecting recipe discards its draft right here:
		// no version bump, no notification.
		await recipe(draft)

		// Re-check the version at commit time: another update may have
		// landed while this recipe was in flight. The stale draft is
		// discarded and can never overwrite the newer state.
		assertVersion(expectedVersion)

		const next = finishDraft(draft) as S

		// No-change convention: an unmodified state is a successful no-op.
		// Immer returns the identical (frozen) base reference, so the
		// version stays put and subscribers are not notified.
		if (next === state) {
			return snapshot()
		}

		const previousState = state
		const previousVersion = version
		state = next
		version = previousVersion + 1

		const notification: OptimisticNotification<S> = {
			state,
			previousState,
			version,
			previousVersion
		}
		// Notify only after the commit has fully landed. Listeners run
		// synchronously in subscription order.
		for (const listener of Array.from(listeners)) {
			listener(notification)
		}
		return snapshot()
	}

	function subscribe(listener: OptimisticListener<S>): () => void {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	return {getState: snapshot, commit, subscribe}
}
