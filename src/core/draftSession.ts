import {
	Draft,
	Drafted,
	Immer,
	ImmerScope,
	ImmerState,
	Objectish,
	Patch,
	PatchListener,
	DRAFT_STATE,
	PluginPatches,
	die,
	isFunction,
	isPluginLoaded,
	revokeScope
} from "../internal"

/**
 * The lifecycle status of a `DraftSession`:
 *
 * - `"open"`: the session's draft can be read, modified, committed or aborted.
 * - `"committed"`: the session was committed exactly once and is closed.
 * - `"aborted"`: the session was aborted (or its commit failed) and is closed.
 *
 * A session is closable exactly once. After it is closed, every interaction
 * with the session or with drafts it handed out fails with a deterministic
 * error.
 */
export type DraftSessionStatus = "open" | "committed" | "aborted"

/** The outcome of a successful `DraftSession.commit()` call. */
export interface DraftSessionCommit<T> {
	/**
	 * The finalized state. This is the original base state when nothing was
	 * modified, otherwise a structurally shared copy.
	 */
	result: T
	/**
	 * The forward patches describing the committed changes. Only present when
	 * the `Patches` plugin is enabled (`enablePatches()`), `undefined` otherwise.
	 */
	patches: Patch[] | undefined
	/**
	 * The inverse patches that undo the committed changes. Only present when
	 * the `Patches` plugin is enabled, `undefined` otherwise.
	 */
	inversePatches: Patch[] | undefined
}

/**
 * An explicit, inspectable wrapper around the manual `createDraft` /
 * `finishDraft` pair for flows that need to review a draft before deciding
 * whether to publish it.
 *
 * A session has exactly three states (`open` -> `committed` or `open` ->
 * `aborted`) and can be closed at most once:
 *
 * - `commit()` finalizes the draft at most once and returns the resulting
 *   state plus (when the Patches plugin is enabled) the forward and inverse
 *   patches.
 * - `abort()` revokes every draft reference handed out by the session,
 *   discarding all changes. The base state is never mutated.
 * - If `commit()` itself fails (for example because the patch listener
 *   throws), the session is closed as well and all of its drafts are
 *   released, so abandoned changes can never leak into the base state.
 *
 * After a session is closed, reading `session.draft`, committing, or
 * aborting again throws a deterministic "session is already closed" error,
 * and any previously obtained draft proxy throws Immer's "proxy has been
 * revoked" error on read or write.
 */
export class DraftSession<T extends Objectish = any> {
	private immer_: Immer
	private status_: DraftSessionStatus = "open"
	private draft_: Draft<T> | null = null
	private scope_: ImmerScope | null = null

	constructor(immer: Immer, base: T) {
		this.immer_ = immer
		// Reuses the unchanged manual draft API. `createDraft` validates that
		// `base` is draftable and snapshots drafts via `current`.
		const draft = immer.createDraft(base)
		this.draft_ = draft
		this.scope_ = (draft as Drafted<any, ImmerState>)[DRAFT_STATE].scope_
	}

	/** The current lifecycle status of this session. Always readable. */
	get status(): DraftSessionStatus {
		return this.status_
	}

	/**
	 * The draft of this session. Only accessible while the session is open;
	 * throws a deterministic error once the session is closed.
	 */
	get draft(): Draft<T> {
		this.assertOpen_()
		return this.draft_!
	}

	/**
	 * Finalizes the draft and closes the session. Can be called at most once.
	 *
	 * Returns the resulting state and, when the Patches plugin is enabled,
	 * the forward and inverse patches describing the changes. An optional
	 * `patchListener` receives the same patches (requires `enablePatches()`).
	 *
	 * If finalization or the patch listener throws, the session is closed
	 * (status becomes `"aborted"`) and all of its drafts are revoked, so the
	 * abandoned changes are never merged into the base state.
	 */
	commit(patchListener?: PatchListener): DraftSessionCommit<T> {
		this.assertOpen_()
		if (patchListener !== undefined && !isFunction(patchListener)) die(17)

		// Generate patches whenever the plugin is available so the caller can
		// always inspect what is about to be published.
		const collectPatches = isPluginLoaded(PluginPatches)
		let patches: Patch[] | undefined
		let inversePatches: Patch[] | undefined
		const listener: PatchListener | undefined =
			collectPatches || patchListener
				? (p, ip) => {
						patches = p
						inversePatches = ip
						if (patchListener) patchListener(p, ip)
					}
				: undefined

		try {
			const result = this.immer_.finishDraft(this.draft_!, listener)
			this.status_ = "committed"
			return {result: result as T, patches, inversePatches}
		} catch (error) {
			// A failed commit must not leave a modifiable session behind:
			// close the session and release every draft it holds. The changes
			// live only in the session's (now revoked) copies, so the base
			// state is guaranteed to stay untouched.
			this.release_()
			this.status_ = "aborted"
			throw error
		} finally {
			this.draft_ = null
			this.scope_ = null
		}
	}

	/**
	 * Discards all changes and closes the session. Every draft reference
	 * handed out by this session (including nested drafts) is revoked, so
	 * using one afterwards throws Immer's "proxy has been revoked" error.
	 * The base state is never mutated.
	 */
	abort(): void {
		this.assertOpen_()
		this.release_()
		this.status_ = "aborted"
		this.draft_ = null
		this.scope_ = null
	}

	private assertOpen_() {
		if (this.status_ !== "open") die(16, this.status_)
	}

	private release_() {
		const scope = this.scope_
		// `finishDraft` already revokes the scope on success; guard against
		// double revocation on failure paths.
		if (scope && scope.drafts_) {
			revokeScope(scope)
		}
	}
}
