import {
	ImmerState,
	ImmerScope,
	DRAFT_STATE,
	ArchType,
	isObjectish,
	die
} from "../internal"

/**
 * Strict draft mode rejects assigning a draft that is still alive and owned
 * by a different `produce` / `createDraft` scope into the current draft.
 *
 * Without this gate, a draft from an outer (or sibling) scope could be stored
 * inside a draft that outlives it. When the owning scope later finalizes, the
 * stored draft is revoked, leaving the current draft with a dangling reference
 * to a revoked proxy. Strict mode catches this at assignment time, before any
 * mutation happens, so the failed write leaves the current draft untouched and
 * other edits can still be committed.
 *
 * Same-scope drafts are always allowed (they are finalized together), as are
 * plain values, including the finalized result of another scope.
 */

/**
 * Returns the draft state if `value` is an Immer draft, `null` otherwise.
 *
 * Accessing DRAFT_STATE on a revoked proxy throws, so we treat that as "not a
 * live draft". A revoked draft is effectively a finalized value and must not
 * be reported.
 */
function getDraftState(value: any): ImmerState | null {
	if (!isObjectish(value)) return null
	try {
		return (value as {[DRAFT_STATE]: any})[DRAFT_STATE] ?? null
	} catch {
		return null
	}
}

/**
 * Computes a human-readable path from the root of the draft tree to the
 * property being written.
 */
function getWritePath(
	state: ImmerState,
	key: string | number | symbol
): string {
	const path: (string | number | symbol)[] = []
	// For sets, the "key" is the value being added, which is not a property
	// name, so we only report the path to the set itself.
	if (state.type_ !== ArchType.Set && key !== undefined) {
		path.push(key)
	}
	let current: ImmerState | undefined = state
	while (current) {
		if (current.key_ !== undefined) path.push(current.key_)
		current = current.parent_
	}
	path.reverse()
	return path.length ? path.map(formatPathSegment).join(".") : "<root>"
}

function formatPathSegment(segment: string | number | symbol): string {
	if (typeof segment === "symbol") return segment.toString()
	return String(segment)
}

/**
 * Throws if `value` is a live draft owned by a different scope than `target`.
 *
 * Must be called BEFORE the assignment is applied so that a rejected write
 * leaves the current draft in a pristine state.
 */
export function assertDraftScope(
	target: ImmerState,
	key: string | number | symbol,
	value: any
): void {
	const {scope_} = target
	if (!scope_.immer_.useStrictDrafts_) return

	const valueState = getDraftState(value)
	if (!valueState) return

	// A draft is only "alive" while its owning scope has not been finalized.
	// Map/Set drafts are not proxies, so they keep their state object after
	// finalization but are marked revoked.
	if ((valueState as any).revoked_) return

	if (valueState.scope_ === scope_) return

	die(16, getWritePath(target, key), describeScope(valueState.scope_))
}

function describeScope(scope: ImmerScope): string {
	return `produce scope #${scope.id_}`
}
