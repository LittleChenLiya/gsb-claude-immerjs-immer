import {Patch} from "../types/types-external"

/**
 * A single RFC 6902 (JSON Patch) operation. Paths are JSON Pointers
 * (RFC 6901): segments are joined with `/`, `~` is escaped as `~0` and
 * `/` as `~1`. The empty string addresses the whole document.
 */
export interface JsonPatchOperation {
	op: "add" | "remove" | "replace"
	path: string
	value?: unknown
}

/**
 * Error thrown when Immer patches cannot be converted to RFC 6902.
 * Conversion is all-or-nothing: when this error is thrown, no (partial)
 * operation group is produced.
 */
export class JsonPatchConversionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "JsonPatchConversionError"
	}
}

/**
 * Converts a list of Immer patches into RFC 6902 JSON Patch operations.
 *
 * Supported scope (everything else is rejected with a
 * {@link JsonPatchConversionError}):
 *
 * - The base state must be a JSON document: only `null`, booleans, finite
 *   numbers, strings, plain arrays and plain objects. `Map`, `Set`, `Date`,
 *   class instances, functions, symbols, bigints and `undefined` are
 *   rejected, both in the base state and in patch values.
 * - Only the `add`, `remove` and `replace` patch operations are supported.
 * - Array appends (Immer `add` at the index equal to the array length, or
 *   the `-` segment) are emitted at the RFC 6901 append position `-`.
 * - A root replacement (empty Immer path) is emitted with the empty
 *   pointer `""`.
 *
 * Numeric path segments are *not* blindly treated as array indices: every
 * segment is resolved against a candidate document that is advanced
 * operation by operation, so an object key `"0"` stays the key `"0"` while
 * index `0` of an array stays an index.
 *
 * The conversion is atomic: either every patch converts and the full
 * operation group is returned, or an error is thrown and nothing is
 * returned. Neither `base` nor `patches` is mutated, and the returned
 * operations share no references with the inputs.
 *
 * @param base    The state the patches were generated from (the `base` of
 *                `produceWithPatches`).
 * @param patches The Immer patches to convert.
 * @returns       The equivalent RFC 6902 operation group.
 */
export function toJsonPatch(
	base: unknown,
	patches: readonly Patch[]
): JsonPatchOperation[] {
	assertJsonValue(base, "base state")
	// The candidate document tracks the result of the operations emitted so
	// far, so every step is validated against the state produced by the
	// previous steps. It is a private clone: `base` is never touched.
	let candidate = cloneJsonValue(base)
	const operations: JsonPatchOperation[] = []

	patches.forEach((patch, patchIndex) => {
		const where = `patch #${patchIndex} (${describePatch(patch)})`
		const operation = convertOne(patch, where)
		candidate = applyToCandidate(candidate, operation, where)
		operations.push(operation)
	})

	return operations
}

function describePatch(patch: Patch): string {
	if (!patch || typeof patch !== "object") return "invalid patch"
	return `${patch.op} /${Array.isArray(patch.path) ? patch.path.join("/") : "?"}`
}

function convertOne(patch: Patch, where: string): JsonPatchOperation {
	if (!patch || typeof patch !== "object") {
		throw new JsonPatchConversionError(`Invalid ${where}: not a patch object`)
	}
	const {op, path} = patch
	if (op !== "add" && op !== "remove" && op !== "replace") {
		throw new JsonPatchConversionError(
			`Unsupported operation in ${where}: ${String(op)}`
		)
	}
	if (!Array.isArray(path)) {
		throw new JsonPatchConversionError(`Invalid ${where}: path is not an array`)
	}
	for (const segment of path) {
		if (typeof segment !== "string" && typeof segment !== "number") {
			throw new JsonPatchConversionError(
				`Invalid ${where}: path segments must be strings or numbers, got ${typeof segment}`
			)
		}
	}
	if (op !== "remove") {
		assertJsonValue(patch.value, `value of ${where}`)
	}
	// The pointer itself is built while resolving against the candidate
	// document (see applyToCandidate), so the raw segments travel along in
	// an internal, non-enumerable slot until the path is finalized.
	const operation: JsonPatchOperation = {op, path: ""}
	if (op !== "remove") operation.value = cloneJsonValue(patch.value)
	Object.defineProperty(operation, SEGMENTS, {value: path.slice()})
	return operation
}

// Internal slot used to carry the raw Immer path segments from validation
// to candidate resolution, without exposing them on the public operation.
const SEGMENTS = Symbol("immer-rfc6902-segments")

function applyToCandidate(
	candidate: any,
	operation: JsonPatchOperation,
	where: string
): any {
	const segments: (string | number)[] = (operation as any)[SEGMENTS]

	if (segments.length === 0) {
		// Root pointer "". RFC 6902 allows add/replace of the whole document;
		// removing the root would leave no JSON document at all.
		if (operation.op === "remove") {
			throw new JsonPatchConversionError(
				`Cannot convert ${where}: removing the document root is not representable as a JSON document`
			)
		}
		operation.path = ""
		return cloneJsonValue(operation.value)
	}

	const pointer: string[] = []
	let container = candidate
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i]
		if (Array.isArray(container)) {
			const index = toArrayIndex(segment, container.length, false, where)
			pointer.push(String(index))
			container = container[index]
		} else if (isPlainObject(container)) {
			const key = String(segment)
			if (!Object.prototype.hasOwnProperty.call(container, key)) {
				throw new JsonPatchConversionError(
					`Cannot convert ${where}: key ${JSON.stringify(key)} does not exist in the candidate document`
				)
			}
			pointer.push(escapeSegment(key))
			container = container[key]
		} else if (isMapOrSet(container)) {
			throw new JsonPatchConversionError(
				`Cannot convert ${where}: Map/Set are not supported by RFC 6902`
			)
		} else {
			throw new JsonPatchConversionError(
				`Cannot convert ${where}: path does not resolve to an object or array in the candidate document`
			)
		}
	}

	const last = segments[segments.length - 1]
	if (Array.isArray(container)) {
		if (operation.op === "add") {
			if ((last as unknown) === "-") {
				pointer.push("-")
				container.push(operation.value)
			} else {
				const index = toArrayIndex(last, container.length, true, where)
				if (index === container.length) {
					// Append at the legal RFC 6901 append position.
					pointer.push("-")
					container.push(operation.value)
				} else {
					pointer.push(String(index))
					container.splice(index, 0, operation.value)
				}
			}
		} else {
			const index = toArrayIndex(last, container.length, false, where)
			pointer.push(String(index))
			if (operation.op === "replace") container[index] = operation.value
			else container.splice(index, 1)
		}
	} else if (isPlainObject(container)) {
		const key = String(last)
		if (
			operation.op !== "add" &&
			!Object.prototype.hasOwnProperty.call(container, key)
		) {
			throw new JsonPatchConversionError(
				`Cannot convert ${where}: key ${JSON.stringify(key)} does not exist in the candidate document`
			)
		}
		pointer.push(escapeSegment(key))
		if (operation.op === "remove") delete container[key]
		else container[key] = operation.value
	} else if (isMapOrSet(container)) {
		throw new JsonPatchConversionError(
			`Cannot convert ${where}: Map/Set are not supported by RFC 6902`
		)
	} else {
		throw new JsonPatchConversionError(
			`Cannot convert ${where}: path does not resolve to an object or array in the candidate document`
		)
	}

	operation.path = "/" + pointer.join("/")
	return candidate
}

function toArrayIndex(
	segment: string | number,
	length: number,
	allowEnd: boolean,
	where: string
): number {
	const index =
		typeof segment === "number"
			? segment
			: /^(0|[1-9][0-9]*)$/.test(segment)
				? Number(segment)
				: NaN
	const max = allowEnd ? length : length - 1
	if (!Number.isInteger(index) || index < 0 || index > max) {
		throw new JsonPatchConversionError(
			`Cannot convert ${where}: ${JSON.stringify(segment)} is not a valid array index (length ${length})`
		)
	}
	return index
}

function escapeSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function isMapOrSet(value: unknown): boolean {
	return value instanceof Map || value instanceof Set
}

/**
 * Rejects every value that cannot appear in an RFC 6902 JSON document:
 * Map, Set, undefined, functions, symbols, bigints, non-finite numbers,
 * class instances (Date, RegExp, ...) and cyclic structures.
 */
function assertJsonValue(
	value: unknown,
	what: string,
	seen?: Set<unknown>
): void {
	if (value === null) return
	switch (typeof value) {
		case "string":
		case "boolean":
			return
		case "number":
			if (!Number.isFinite(value)) {
				throw new JsonPatchConversionError(
					`Non-JSON value in ${what}: ${String(value)} is not a finite number`
				)
			}
			return
		case "object":
			break
		default:
			throw new JsonPatchConversionError(
				`Non-JSON value in ${what}: ${typeof value} is not representable in JSON`
			)
	}
	if (isMapOrSet(value)) {
		throw new JsonPatchConversionError(
			`Non-JSON value in ${what}: Map/Set are not supported by RFC 6902`
		)
	}
	if (!Array.isArray(value) && !isPlainObject(value)) {
		throw new JsonPatchConversionError(
			`Non-JSON value in ${what}: ${Object.prototype.toString.call(value)} is not a plain JSON object or array`
		)
	}
	const seenNow = seen ?? new Set()
	if (seenNow.has(value)) {
		throw new JsonPatchConversionError(
			`Non-JSON value in ${what}: cyclic structures are not representable in JSON`
		)
	}
	seenNow.add(value)
	if (Array.isArray(value)) {
		for (const item of value) assertJsonValue(item, what, seenNow)
	} else {
		for (const key of Object.keys(value as object)) {
			assertJsonValue((value as any)[key], what, seenNow)
		}
	}
	seenNow.delete(value)
}

function cloneJsonValue<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value
	if (Array.isArray(value)) {
		return value.map(cloneJsonValue) as unknown as T
	}
	const clone: Record<string, unknown> = {}
	for (const key of Object.keys(value as object)) {
		clone[key] = cloneJsonValue((value as any)[key])
	}
	return clone as unknown as T
}
