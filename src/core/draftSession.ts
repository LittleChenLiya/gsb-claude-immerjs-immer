import {
	Draft,
	Drafted,
	Immer,
	Objectish,
	PatchListener,
	DRAFT_STATE,
	ImmerScope,
	ImmerState,
	revokeScope,
	getCurrentScope,
	leaveScope
} from "../internal"

/**
 * The lifecycle state of a {@link DraftSession}.
 *
 * - `open` — the draft can be read and mutated.
 * - `committed` — `commit()` was called; the session is closed.
 * - `aborted` — `abort()` was called; the session is closed and all
 *   drafts it held have been revoked.
 */
export type DraftSessionState = "open" | "committed" | "aborted"

// Sessions use their own Immer instance so their settings (autoFreeze,
// strict copying, ...) are independent from the global `produce` instance.
const defaultImmer = new Immer()

/**
 * A session wraps the manual `createDraft` / `finishDraft` pair and adds an
 * explicit lifecycle to it: a session is {@link DraftSession.open | opened},
 * during which its {@link DraftSession.draft | draft} can be mutated, and then
 * either {@link DraftSession.commit | committed} (exposing the next immutable
 * state, optionally with patches) or {@link DraftSession.abort | aborted}
 * (discarding every change made to the draft).
 *
 * Once closed (committed or aborted) the session can never be reopened:
 * reading {@link DraftSession.draft}, calling `commit()` or calling `abort()`
 * again all throw a definite error. Aborting revokes every draft the session
 * created, so any draft reference still held by user code stops working.
 *
 * The underlying manual draft primitives (`createDraft` / `finishDraft`) are
 * left untouched by this wrapper.
 */
export class DraftSession<T extends Objectish> {
	private state_: DraftSessionState = "open"
	private readonly immer_: Immer
	private readonly scope_: ImmerScope
	private readonly draft_: Drafted<T, ImmerState>

	private constructor(immer: Immer, base: T) {
		this.immer_ = immer
		this.draft_ = immer.createDraft(base) as any
		// Grab the scope while the draft is still alive; it is needed to
		// release the drafts even after the proxy has been revoked.
		this.scope_ = (this.draft_ as any)[DRAFT_STATE].scope_
		// createDraft enters a fresh scope; leave it so it cannot leak into
		// a surrounding produce call.
		if (getCurrentScope() === this.scope_) leaveScope(this.scope_)
	}

	/**
	 * Opens a new session around a draft of `base`. The returned session is
	 * `open` and its draft can be mutated until `commit()` or `abort()` is
	 * called.
	 *
	 * @param immer - optional Immer instance whose settings are used.
	 */
	static open<T extends Objectish>(base: T, immer?: Immer): DraftSession<T> {
		return new DraftSession(immer ?? defaultImmer, base)
	}

	/** The current lifecycle state of the session. */
	get state(): DraftSessionState {
		return this.state_
	}

	/**
	 * The mutable draft of the session.
	 *
	 * Throws if the session has already been committed or aborted. The same
	 * happens when a draft reference captured before closing is used after
	 * closing: aborting revokes the underlying proxy.
	 */
	get draft(): Draft<T> {
		this.assertOpen_()
		return this.draft_ as any
	}

	/**
	 * Finalizes the draft and returns the next immutable state.
	 *
	 * `commit()` can be called at most once. If a `patchListener` is given,
	 * it is invoked with the forward and inverse patches describing the
	 * transition from the base state to the result.
	 *
	 * The session is marked `committed` *before* finalization runs, so an
	 * exception thrown while finalizing or by the patch listener cannot leave
	 * behind an open, still-mutable session. Any drafts the session still
	 * holds are released in that case.
	 */
	commit(patchListener?: PatchListener): T {
		this.assertOpen_()
		// Close the session first: even if finalization or the patch
		// listener throws, the session must not remain open and mutable.
		this.state_ = "committed"
		try {
			return this.immer_.finishDraft(this.draft_ as any, patchListener) as T
		} catch (e) {
			// `finishDraft` normally revokes the scope itself; this covers
			// paths that throw before that (e.g. a missing patches plugin
			// or a throwing finalization callback). Never let abandoned
			// modifications leak back into the base.
			this.releaseDrafts_()
			throw e
		}
	}

	/**
	 * Discards all changes made to the draft and revokes every draft the
	 * session created. The base state is never touched.
	 *
	 * Throws if the session has already been closed.
	 */
	abort(): void {
		this.assertOpen_()
		this.state_ = "aborted"
		this.releaseDrafts_()
	}

	private assertOpen_() {
		if (this.state_ !== "open") {
			throw new Error(
				`[Immer] Draft session is already '${this.state_}'. A session can only be committed or aborted once, and its drafts cannot be read or written after closing.`
			)
		}
	}

	/** Idempotently revoke every draft owned by this session's scope. */
	private releaseDrafts_() {
		if (this.scope_.drafts_) {
			revokeScope(this.scope_)
		}
	}
}
