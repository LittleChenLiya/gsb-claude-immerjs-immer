import {
	Patch,
	isArray,
	isMap,
	isSet,
	isObjectish,
	isDraftable,
	getPrototypeOf,
	has,
	DRAFTABLE
} from "../internal"

/**
 * Options for {@link maskPatches}.
 */
export interface PatchMaskOptions {
	/**
	 * Paths whose `value` must be replaced by the {@link PatchMaskOptions.replacement}
	 * marker in the returned audit copy.
	 *
	 * Rules are matched **segment by segment**: a rule matches a patch when the
	 * rule path is a prefix of (or equal to) the patch path. A rule on a parent
	 * path therefore covers the whole value subtree — masking `/user` also masks
	 * `/user/token`, `/user/name`, etc.
	 *
	 * Rules can be given as JSON-Pointer-like strings (`"/user/token"`) or as
	 * arrays of path segments (`["user", "token"]`). When a string rule is
	 * split, segments made of digits (e.g. `"0"`) are interpreted as **array
	 * indices** (numbers), never as string fields: `"/items/0"` matches the
	 * patch path `["items", 0]` but not `["items", "0"]`. Use the array form
	 * if you need to match a string key that looks like an array index.
	 *
	 * An empty string or empty array matches every patch.
	 */
	rules: readonly (string | readonly (string | number)[])[]

	/**
	 * The marker that replaces masked values, provided explicitly by the
	 * caller. It is used as-is (e.g. `"***"` or `null`).
	 */
	replacement: unknown
}

const REPLACE = "replace"
const ADD = "add"
const REMOVE = "remove"

/**
 * Produce an audit-safe copy of a batch of {@link Patch}es.
 *
 * Audit logs need to retain the patch operations and their paths, but some
 * values must not be written out in clear (e.g. a token at `/user/token`).
 * `maskPatches` returns a **new batch** — the original patches are never
 * mutated and can still be replayed with `applyPatches` to reproduce the
 * original result.
 *
 * Behavior:
 *
 * - Every patch is copied: `op` and `path` are preserved.
 * - The `value` of patches whose path matches a rule (see
 *   {@link PatchMaskOptions.rules}) is replaced by the caller-provided
 *   {@link PatchMaskOptions.replacement} marker.
 * - `remove` patches have no `value`, but the operation is still preserved
 *   in the copy.
 * - Values that are retained are deep-copied, so the audit copy never shares
 *   mutable objects with the original patches.
 * - The whole batch is validated before anything is returned: if any value
 *   contains accessor properties (getters/setters) or cyclic references, the
 *   entire batch is rejected (an error is thrown) and no copy is produced.
 *
 * @param patches The original patches. They are left untouched and remain
 *                replayable.
 * @param options Masking rules and the replacement marker.
 * @returns A new array of new patch objects, safe to log or serialize.
 *
 * @example
 * import {produceWithPatches, applyPatches, maskPatches} from "immer"
 *
 * const base = {user: {name: "Ada", token: "s3cr3t"}}
 * const [nextState, patches] = produceWithPatches(base, draft => {
 *   draft.user.name = "Ada Lovelace"
 *   draft.user.token = "new-token"
 * })
 *
 * const audit = maskPatches(patches, {
 *   rules: ["/user/token"],
 *   replacement: "***"
 * })
 * console.log(audit)
 * // [{op: "replace", path: ["user", "name"], value: "Ada Lovelace"},
 * //  {op: "replace", path: ["user", "token"], value: "***"}]
 *
 * // The original patches still replay to the original result:
 * applyPatches(base, patches) // => nextState
 */
export function maskPatches(
	patches: readonly Patch[],
	options: PatchMaskOptions
): Patch[] {
	if (!isArray(patches))
		throw new Error(
			"[Immer] maskPatches: the first argument must be an array of patches"
		)
	if (!options || !isArray(options.rules))
		throw new Error(
			"[Immer] maskPatches: `rules` must be an array of path strings or segment arrays"
		)

	const rules = options.rules.map(normalizeRule)

	// Validate the whole batch up front: a single bad value rejects everything.
	for (let i = 0; i < patches.length; i++) {
		validatePatch(patches[i], i)
	}

	const result: Patch[] = []
	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i]
		const {op, path} = patch
		const pathCopy = path.slice()

		if (op === REMOVE) {
			// remove carries no value, but the operation is still preserved.
			result.push({op: REMOVE, path: pathCopy})
			continue
		}

		if (rules.some(rule => ruleMatches(rule, path))) {
			result.push({op, path: pathCopy, value: options.replacement})
		} else {
			result.push({
				op,
				path: pathCopy,
				value: cloneValue(patch.value, new WeakMap())
			})
		}
	}
	return result
}

function normalizeRule(
	rule: string | readonly (string | number)[]
): (string | number)[] {
	if (typeof rule === "string") {
		const segments = rule.split("/")
		if (segments[0] === "") segments.shift() // leading "/"
		return segments.map(segment => {
			// A segment of digits is an array index (number), never a string field.
			if (/^(0|[1-9]\d*)$/.test(segment)) return Number(segment)
			return segment
		})
	}
	if (!isArray(rule))
		throw new Error(
			"[Immer] maskPatches: each rule must be a path string or an array of string/number segments"
		)
	const segments: (string | number)[] = []
	for (const segment of rule) {
		if (typeof segment !== "string" && typeof segment !== "number")
			throw new Error(
				"[Immer] maskPatches: rule path segments must be strings or numbers"
			)
		segments.push(segment)
	}
	return segments
}

function ruleMatches(
	rule: readonly (string | number)[],
	path: readonly (string | number)[]
): boolean {
	if (rule.length > path.length) return false
	for (let i = 0; i < rule.length; i++) {
		// Strict equality: a numeric array index never matches a string field.
		if (rule[i] !== path[i]) return false
	}
	return true
}

function validatePatch(patch: any, index: number): void {
	if (!isObjectish(patch) || isArray(patch))
		throw new Error(
			`[Immer] maskPatches: patch at index ${index} must be an object`
		)
	const {op, path} = patch
	if (op !== REPLACE && op !== ADD && op !== REMOVE)
		throw new Error(
			`[Immer] maskPatches: patch at index ${index} has unsupported operation '${op}'`
		)
	if (!isArray(path))
		throw new Error(
			`[Immer] maskPatches: patch at index ${index} has a non-array path`
		)
	for (let i = 0; i < path.length; i++) {
		if (typeof path[i] !== "string" && typeof path[i] !== "number")
			throw new Error(
				`[Immer] maskPatches: patch at index ${index} has a path segment that is not a string or number`
			)
	}
	if ("value" in patch) {
		validateValue(patch.value, new Set(), `patch[${index}].value`)
	}
}

function validateValue(value: any, ancestors: Set<object>, path: string): void {
	if (!isObjectish(value)) return
	if (ancestors.has(value))
		throw new Error(
			`[Immer] maskPatches: circular reference detected in patch value at '${path}'. Cyclic values are not supported by the audit copy; the whole batch is rejected.`
		)
	ancestors.add(value)
	try {
		if (isMap(value)) {
			value.forEach((v, k) => {
				validateValue(k, ancestors, `${path}.<key>`)
				validateValue(v, ancestors, `${path}.${stringifyKey(k)}`)
			})
		} else if (isSet(value)) {
			value.forEach(v => {
				validateValue(v, ancestors, `${path}.<set item>`)
			})
		} else {
			// Arrays and plain/other objects: inspect every own property.
			const keys = Reflect.ownKeys(value)
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key)
				if (descriptor && (descriptor.get || descriptor.set))
					throw new Error(
						`[Immer] maskPatches: accessor property '${stringifyKey(
							key
						)}' at '${path}' is not supported in audit patches; the whole batch is rejected.`
					)
				validateValue(value[key], ancestors, `${path}.${stringifyKey(key)}`)
			}
		}
	} finally {
		ancestors.delete(value)
	}
}

function stringifyKey(key: PropertyKey): string {
	return typeof key === "symbol" ? key.toString() : String(key)
}

function cloneValue(value: any, memo: WeakMap<object, any>): any {
	if (!isObjectish(value)) return value
	if (memo.has(value)) return memo.get(value)

	if (isArray(value)) {
		const copy: any[] = []
		memo.set(value, copy)
		for (let i = 0; i < value.length; i++) {
			copy[i] = cloneValue(value[i], memo)
		}
		return copy
	}
	if (isMap(value)) {
		const copy = new Map()
		memo.set(value, copy)
		value.forEach((v, k) => {
			copy.set(k, cloneValue(v, memo))
		})
		return copy
	}
	if (isSet(value)) {
		const copy = new Set()
		memo.set(value, copy)
		value.forEach(v => {
			copy.add(cloneValue(v, memo))
		})
		return copy
	}
	if (isDraftable(value)) {
		const copy = Object.create(getPrototypeOf(value))
		memo.set(value, copy)
		for (const key in value) {
			if (has(value, key)) copy[key] = cloneValue(value[key], memo)
		}
		if (has(value, DRAFTABLE)) copy[DRAFTABLE] = value[DRAFTABLE]
		return copy
	}
	// Non-draftable values (functions, Dates, RegExps, ...) are immutable
	// data and can be shared safely.
	return value
}
