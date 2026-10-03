import {
	ArchType,
	getArchtype,
	is,
	isObjectish,
	PatchCondition,
	PatchConditionFailure
} from "../internal"

const hasOwn = Object.prototype.hasOwnProperty

/**
 * Checks `container[key]` existence with object / array / Map semantics.
 * For plain objects and arrays only own properties count; for Maps the
 * Map's own key set is used. Never walks the prototype chain.
 */
function ownHas(container: any, key: string | number, type: ArchType): boolean {
	return type === ArchType.Map
		? container.has(key)
		: hasOwn.call(container, key)
}

/**
 * Reads an own value from `container` without ever invoking accessors
 * (getters) defined on the input. Returns `undefined` when the value cannot
 * be obtained without calling a getter.
 */
function readOwnValue(
	container: any,
	key: string | number,
	type: ArchType
): {readable: boolean; value?: unknown} {
	if (type === ArchType.Map) {
		return {readable: true, value: container.get(key)}
	}
	const descriptor = Object.getOwnPropertyDescriptor(container, key)
	if (descriptor && "value" in descriptor) {
		return {readable: true, value: descriptor.value}
	}
	return {readable: false}
}

function checkCondition(
	base: any,
	condition: PatchCondition,
	conditionIndex: number
): PatchConditionFailure | null {
	const fail = (
		reason: PatchConditionFailure["reason"],
		at: number,
		extra?: {expected?: unknown; actual?: unknown}
	): PatchConditionFailure => ({
		conditionIndex,
		path: Array.isArray(condition?.path) ? condition.path : [],
		at,
		reason,
		...extra
	})

	if (!condition || !Array.isArray(condition.path)) {
		return fail("invalid-path", -1)
	}
	const {path} = condition
	const expectExists = condition.exists !== false
	// The value check is opt-in via the mere presence of the `value` key, so
	// that `{path, value: undefined}` is distinguishable from "no value check".
	const checkValue = hasOwn.call(condition, "value")
	const expected = condition.value

	// The empty path addresses the base (root) itself, which always exists.
	if (path.length === 0) {
		if (!expectExists) return fail("exists", 0)
		if (checkValue && !is(base, expected)) {
			return fail("value-mismatch", 0, {expected, actual: base})
		}
		return null
	}

	let current = base
	for (let at = 0; at < path.length; at++) {
		const key = path[at]
		if (typeof key !== "string" && typeof key !== "number") {
			return fail("invalid-path", at)
		}
		const last = at === path.length - 1

		if (current === null || !isObjectish(current)) {
			// Cannot descend any further: the path does not resolve.
			return expectExists || checkValue ? fail("invalid-path", at) : null
		}

		const type = getArchtype(current)
		if (type === ArchType.Set) {
			// Conditions use key-based addressing, which Sets don't have.
			return expectExists || checkValue ? fail("invalid-path", at) : null
		}

		if (!ownHas(current, key, type)) {
			// A missing key is never the same as an existing key whose value
			// is `undefined`: absence fails existence and value expectations.
			return expectExists || checkValue ? fail("missing", at) : null
		}
		if (!expectExists) return fail("exists", at)

		const read = readOwnValue(current, key, type)
		if (!read.readable) {
			// Would require invoking a getter on the input; never do that.
			return fail("getter", at)
		}

		if (last) {
			if (checkValue && !is(read.value, expected)) {
				return fail("value-mismatch", at, {expected, actual: read.value})
			}
			return null
		}
		current = read.value
	}
	return null
}

/**
 * Checks every condition against the same, unmodified `base` state. Nothing
 * is applied here; this only verifies preconditions. Returns `null` when all
 * conditions hold, or the first failure (with its exact location) otherwise.
 *
 * The base is only inspected through own-property descriptors and Map key
 * lookups: no getters on the input are invoked and the base is never mutated.
 */
export function checkPatchConditions(
	base: any,
	conditions: readonly PatchCondition[]
): PatchConditionFailure | null {
	for (let i = 0; i < conditions.length; i++) {
		const failure = checkCondition(base, conditions[i], i)
		if (failure) return failure
	}
	return null
}
