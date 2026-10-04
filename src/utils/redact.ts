import {
	Patch,
	PatchPath,
	PatchSegment,
	isArray,
	isMap,
	isSet,
	getPrototypeOf
} from "../internal"

const O = Object
const ABSENT = Symbol("absent")

/**
 * Rule describing which patch paths must be hidden from audit logs.
 *
 * - `path` is matched segment by segment against a patch path; an empty path
 *   matches every patch.
 * - A rule whose path is a prefix of the patch path (a "parent" rule) masks
 *   the whole value subtree below it.
 * - Numeric array segments are never treated as string fields: the number
 *   segment `0` does not match the string segment `"0"`.
 * - `replacement` is the marker written into the redacted patch's `value`.
 *   It is always given explicitly by the caller (there is no default marker).
 */
export interface PatchRedactionRule {
	path: readonly PatchSegment[]
	replacement: unknown
}

export interface RedactPatchesOptions {
	rules: readonly PatchRedactionRule[]
}

/**
 * Error thrown by {@link redactPatches} when a batch cannot be redacted
 * safely. The whole batch is rejected: no partial audit copy is returned and
 * the input patches are never modified.
 */
export class PatchRedactionError extends Error {
	constructor(message: string) {
		super("[Immer] " + message)
		this.name = "PatchRedactionError"
	}
}

function fail(message: string): never {
	throw new PatchRedactionError(message)
}

function findDescriptor(
	obj: any,
	key: PropertyKey
): PropertyDescriptor | undefined {
	let current = obj
	while (current !== null) {
		const desc = O.getOwnPropertyDescriptor(current, key)
		if (desc) return desc
		current = getPrototypeOf(current)
	}
	return undefined
}

function assertNoAccessor(obj: any, key: PropertyKey): void {
	const desc = findDescriptor(obj, key)
	if (desc && (desc.get !== undefined || desc.set !== undefined))
		fail(
			"Cannot redact patches: values containing accessors (getters/setters) are not supported"
		)
}

/**
 * Return a deep, detached copy of `value` that can be written into an audit
 * patch without sharing any mutable object with the input patch.
 *
 * The whole batch is rejected when the traversal encounters:
 * - an accessor (getter/setter), own or inherited, since invoking it could
 *   trigger side effects, throw, or expose values that cannot be copied;
 * - a circular reference, which cannot be represented in a plain patch.
 *
 * DAGs (the same node reached through several branches) are supported: every
 * branch receives its own independent copy.
 */
function copyAuditValue(value: any, seen: Set<unknown>): any {
	if (value === null || typeof value !== "object") {
		// Primitives, functions and other non-draftable values carry no
		// mutable state of their own and are returned as-is, matching the
		// semantics of the patches plugin's `deepClonePatchValue`.
		return value
	}

	if (seen.has(value))
		fail(
			"Cannot redact patches: circular references in patch values are not supported"
		)

	if (isArray(value)) {
		seen.add(value)
		const copy: any[] = new Array(value.length)
		for (let i = 0; i < value.length; i++) {
			assertNoAccessor(value, "" + i)
			copy[i] = copyAuditValue(value[i], seen)
		}
		seen.delete(value)
		return copy
	}

	if (isMap(value)) {
		seen.add(value)
		const copy = new Map()
		value.forEach((v: any, k: any) => {
			copy.set(copyAuditValue(k, seen), copyAuditValue(v, seen))
		})
		seen.delete(value)
		return copy
	}

	if (isSet(value)) {
		seen.add(value)
		const copy = new Set()
		value.forEach((v: any) => {
			copy.add(copyAuditValue(v, seen))
		})
		seen.delete(value)
		return copy
	}

	seen.add(value)
	const copy = O.create(getPrototypeOf(value))
	// `for...in` walks the prototype chain, so inherited enumerable
	// accessors are rejected as well as own ones
	for (const key in value) {
		assertNoAccessor(value, key)
		copy[key] = copyAuditValue(value[key], seen)
	}
	// Reject own (possibly non-enumerable) string/symbol accessors, which
	// `for...in` would not visit
	for (const key of Reflect.ownKeys(value)) assertNoAccessor(value, key)
	seen.delete(value)
	return copy
}

/**
 * Find the most specific rule matching `path`. Rules match segment by
 * segment without type coercion, and match when their path is a prefix of
 * `path`. Among matching prefixes the longest wins; when several rules share
 * the longest path, the last one wins so callers can override earlier rules.
 */
function findMatchingRuleIndex(
	path: PatchPath,
	rules: readonly PatchRedactionRule[]
): number {
	let match = -1
	let matchLength = -1
	for (let r = 0; r < rules.length; r++) {
		const rulePath = rules[r].path
		if (rulePath.length > path.length) continue
		let matches = true
		for (let i = 0; i < rulePath.length; i++) {
			// SameValue equality: the number 0 does not match the string "0"
			if (!Object.is(rulePath[i], path[i])) {
				matches = false
				break
			}
		}
		if (matches && rulePath.length >= matchLength) {
			match = r
			matchLength = rulePath.length
		}
	}
	return match
}

/**
 * Create a redacted copy of `patches` suitable for audit logging.
 *
 * The returned patches keep the original `op` and `path` of every patch
 * (including `remove` patches, which carry no `value`), but the `value` of
 * patches whose path matches a redaction rule is replaced with that rule's
 * explicit `replacement` marker. Values that are not masked are deep copied,
 * so the returned patches never share a mutable object with the input.
 *
 * Rules use path-segment matching; a parent rule masks the entire value
 * subtree below it. Numeric array segments are never treated as string
 * fields.
 *
 * The input patches are never modified: after redaction they can still be
 * replayed with `applyPatches` to obtain the original result.
 *
 * If any patch value (or rule replacement marker) contains an accessor or a
 * circular reference, the whole batch is rejected with
 * {@link PatchRedactionError} and no partial result is returned.
 *
 * @example
 * const auditPatches = redactPatches(patches, {
 * 	rules: [{path: ["user", "token"], replacement: "[REDACTED]"}]
 * })
 */
export function redactPatches(
	patches: readonly Patch[],
	options: RedactPatchesOptions
): Patch[] {
	const {rules} = options
	if (!isArray(patches)) fail("Expected an array of patches")
	if (!isArray(rules)) fail("Expected `rules` to be an array")

	for (const rule of rules) {
		if (rule === null || typeof rule !== "object")
			fail("Each redaction rule must be an object")
		if (!isArray(rule.path))
			fail("Each redaction rule must define a `path` array of segments")
	}

	// First pass: validate and deep-copy every value and marker up front so
	// that an invalid batch is rejected atomically without leaking a partial
	// copy, and so output never shares mutable objects with the input.
	const copiedValues: unknown[] = new Array(patches.length)
	const seen = new Set<unknown>()
	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i]
		if (patch === null || typeof patch !== "object")
			fail("Each patch must be an object")
		if (!isArray(patch.path)) fail("Each patch must define a `path` array")
		copiedValues[i] =
			"value" in patch ? copyAuditValue(patch.value, seen) : ABSENT
	}
	const copiedMarkers = rules.map(rule =>
		copyAuditValue(rule.replacement, seen)
	)

	// Second pass: build the detached audit copy
	const result: Patch[] = []
	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i]
		const path: PatchPath = patch.path.slice()
		const redacted: Patch = {
			op: patch.op,
			path
		}
		const ruleIndex = findMatchingRuleIndex(path, rules)
		if (ruleIndex !== -1) {
			// Mask the whole value subtree, including patches nested below
			// the rule path. `remove` patches have no value to begin with;
			// their original op and path are preserved unchanged. Clone the
			// marker per patch so audit patches never share mutable state,
			// not even with each other.
			if (copiedValues[i] !== ABSENT)
				redacted.value = copyAuditValue(copiedMarkers[ruleIndex], seen)
		} else if (copiedValues[i] !== ABSENT) {
			redacted.value = copiedValues[i]
		}
		result.push(redacted)
	}
	return result
}
