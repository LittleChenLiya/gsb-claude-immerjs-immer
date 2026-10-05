import {Patch} from "../types/types-external"
import {isArray, isMap, isSet, isObjectish} from "./common"

/**
 * An RFC 6902 (JSON Patch) operation.
 *
 * The `path` is a JSON Pointer string: `""` for the root, or
 * `"/a/b/c"` with `~` escaped as `~0` and `/` escaped as `~1`.
 */
export interface RFC6902Operation {
	op: "add" | "remove" | "replace"
	path: string
	value?: any
}

/**
 * Thrown when an Immer patch cannot be converted to an RFC 6902 operation.
 *
 * This error is all-or-nothing: if any patch in a group fails validation,
 * no partial operation group is returned.
 */
export class RFC6902ConversionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RFC6902ConversionError"
	}
}

const ROOT_POINTER = ""
const APPEND_POINTER = "-"

/**
 * Escape a single JSON Pointer reference token.
 * `~` -> `~0`, `/` -> `~1` (RFC 6901).
 */
function escapePointerToken(token: string): string {
	return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

/**
 * Unescape a single JSON Pointer reference token.
 * `~1` -> `/`, `~0` -> `~` (RFC 6901).
 * Order matters: `~1` must be decoded before `~0`.
 */
function unescapePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~")
}

/**
 * Build a JSON Pointer string from an array of path segments.
 * Returns `""` (root) for an empty path.
 */
function buildPointer(segments: (string | number)[]): string {
	if (segments.length === 0) return ROOT_POINTER
	return "/" + segments.map(s => escapePointerToken(String(s))).join("/")
}

/**
 * Parse a JSON Pointer string into unescaped path segments.
 * Returns `[]` for the root pointer `""`.
 */
export function parsePointer(pointer: string): string[] {
	if (pointer === ROOT_POINTER) return []
	if (pointer.charAt(0) !== "/") {
		throw new RFC6902ConversionError(`Invalid JSON Pointer: "${pointer}"`)
	}
	return pointer.slice(1).split("/").map(unescapePointerToken)
}

/**
 * Returns true if the value is a plain object (not a class instance,
 * not a Map/Set, not an array).
 */
function isPlainObjectValue(value: any): boolean {
	if (value === null || typeof value !== "object") return false
	if (isArray(value) || isMap(value) || isSet(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === null || proto === Object.prototype
}

/**
 * Recursively validate that a value is JSON-compatible.
 *
 * Rejects:
 * - Maps and Sets (Immer-specific collections)
 * - functions, symbols, bigints (non-JSON primitives)
 * - non-plain objects (class instances, Date, RegExp, etc.)
 *
 * Allows: null, undefined, strings, numbers, booleans, plain objects, arrays.
 *
 * @param value The value to validate
 * @param pointer The JSON Pointer path for error messages
 */
function assertJSONValue(value: any, pointer: string): void {
	if (value === null || value === undefined) return
	const type = typeof value
	if (type === "string" || type === "number" || type === "boolean") return
	if (type === "function" || type === "symbol" || type === "bigint") {
		throw new RFC6902ConversionError(
			`Non-JSON value at ${pointer || "root"}: ${type}`
		)
	}
	if (isMap(value) || isSet(value)) {
		throw new RFC6902ConversionError(
			`Map/Set values are not supported at ${pointer || "root"}`
		)
	}
	if (isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			assertJSONValue(value[i], `${pointer}/${i}`)
		}
		return
	}
	if (isPlainObjectValue(value)) {
		for (const key of Object.keys(value)) {
			assertJSONValue(value[key], `${pointer}/${escapePointerToken(key)}`)
		}
		return
	}
	throw new RFC6902ConversionError(
		`Non-JSON value at ${pointer || "root"}: ${type}`
	)
}

/**
 * Validate that a path segment is a legal array index for the given operation.
 *
 * @param segment The path segment (string or number)
 * @param arrayLength The current length of the array
 * @param forAdd Whether this is for an `add` operation (allows index == length)
 */
function isValidArrayIndex(
	segment: string | number,
	arrayLength: number,
	forAdd: boolean
): boolean {
	if (typeof segment === "number") {
		if (!Number.isInteger(segment) || segment < 0) return false
		if (forAdd) return segment <= arrayLength
		return segment < arrayLength
	}
	// String segment
	if (segment === APPEND_POINTER) return forAdd
	// Reject leading zeros ("01", "00") and non-numeric strings
	if (!/^(0|[1-9][0-9]*)$/.test(segment)) return false
	const n = Number(segment)
	if (forAdd) return n <= arrayLength
	return n < arrayLength
}

/**
 * Deep clone a JSON-compatible value. Used to ensure the original
 * state and patch values are never mutated during validation.
 */
function cloneJSONValue(value: any): any {
	if (value === null || value === undefined) return value
	if (isArray(value)) return value.map(cloneJSONValue)
	if (isPlainObjectValue(value)) {
		const clone: any = {}
		for (const key of Object.keys(value)) {
			clone[key] = cloneJSONValue(value[key])
		}
		return clone
	}
	return value
}

/**
 * Apply an RFC 6902 operation to a state immutably (structural sharing
 * along the path). Returns the new state; the input state is not mutated.
 *
 * This is used internally to advance the candidate state between patches
 * so that each patch is validated against the state produced by the
 * previous one.
 */
function applyRFC6902Operation(state: any, operation: RFC6902Operation): any {
	const {op, path, value} = operation

	if (path === ROOT_POINTER) {
		return cloneJSONValue(value)
	}

	const segments = parsePointer(path)
	const result = cloneJSONValue(state)

	// Navigate to the parent container, cloning along the path
	let current = result
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i]
		if (isArray(current)) {
			current = current[Number(segment)]
		} else {
			current = current[segment]
		}
	}

	const lastSegment = segments[segments.length - 1]

	switch (op) {
		case "add":
			if (isArray(current)) {
				if (lastSegment === APPEND_POINTER) {
					current.push(cloneJSONValue(value))
				} else {
					current.splice(Number(lastSegment), 0, cloneJSONValue(value))
				}
			} else {
				current[lastSegment] = cloneJSONValue(value)
			}
			break
		case "replace":
			if (isArray(current)) {
				current[Number(lastSegment)] = cloneJSONValue(value)
			} else {
				current[lastSegment] = cloneJSONValue(value)
			}
			break
		case "remove":
			if (isArray(current)) {
				current.splice(Number(lastSegment), 1)
			} else {
				delete current[lastSegment]
			}
			break
	}

	return result
}

/**
 * Convert an array of Immer patches to RFC 6902 (JSON Patch) operations.
 *
 * This is an explicit, step-by-step converter. Each patch is validated
 * against the candidate state produced by the previous patch. The entire
 * group is converted only if every patch passes validation; otherwise
 * an {@link RFC6902ConversionError} is thrown and no partial result is
 * returned.
 *
 * ## Conversion rules
 *
 * - **Path types**: Numeric path segments are only treated as array
 *   indices when the current container is an array. For plain objects,
 *   numeric-looking keys (e.g. `"0"`) are treated as string keys.
 * - **Array append**: An `add` operation at an index equal to the array
 *   length is converted to use the standard `-` (append) pointer.
 * - **Root replacement**: A patch with an empty path (`[]`) is converted
 *   to the empty JSON Pointer (`""`).
 * - **Pointer escaping**: `~` is escaped as `~0` and `/` as `~1`
 *   (e.g. key `a/b` becomes `a~1b`).
 * - **Rejected values**: Maps, Sets, functions, symbols, bigints, and
 *   non-plain objects are rejected.
 * - **Rejected containers**: Maps and Sets encountered along the path
 *   are rejected.
 *
 * ## Supported scope
 *
 * - Plain objects and arrays (JSON-compatible structures)
 * - Primitives: null, undefined, strings, numbers, booleans
 * - Operations: add, remove, replace
 *
 * ## Unsupported scope
 *
 * - Maps and Sets (Immer-specific collections)
 * - Non-JSON values: functions, symbols, bigints, class instances,
 *   Date, RegExp, etc.
 * - The `move`, `copy`, and `test` RFC 6902 operations (not produced
 *   by Immer)
 *
 * @param base The base state the patches apply to. Not mutated.
 * @param patches The Immer patches to convert. Not mutated.
 * @returns An array of RFC 6902 operations.
 * @throws {@link RFC6902ConversionError} if any patch cannot be converted.
 */
export function patchesToRFC6902(
	base: any,
	patches: readonly Patch[]
): RFC6902Operation[] {
	const operations: RFC6902Operation[] = []
	let candidate = cloneJSONValue(base)

	for (let i = 0; i < patches.length; i++) {
		const patch = patches[i]
		const {op, path, value} = patch

		if (op !== "add" && op !== "remove" && op !== "replace") {
			throw new RFC6902ConversionError(
				`Unsupported patch operation: "${op}" at index ${i}`
			)
		}

		// Root replacement: empty path -> empty JSON Pointer
		if (path.length === 0) {
			if (op !== "replace") {
				throw new RFC6902ConversionError(
					`Root path is only valid for "replace" operation at index ${i}`
				)
			}
			assertJSONValue(value, ROOT_POINTER)
			const operation: RFC6902Operation = {
				op: "replace",
				path: ROOT_POINTER
			}
			if (value !== undefined) {
				operation.value = value
			}
			operations.push(operation)
			candidate = applyRFC6902Operation(candidate, operation)
			continue
		}

		// Walk the path to find the parent container, validating each segment
		let container = candidate
		const pointerSegments: (string | number)[] = []

		for (let j = 0; j < path.length - 1; j++) {
			const segment = path[j]

			if (isMap(container) || isSet(container)) {
				throw new RFC6902ConversionError(
					`Map/Set in patch path at index ${i}, segment ${j}`
				)
			}

			if (container === null || container === undefined) {
				throw new RFC6902ConversionError(
					`Cannot traverse ${container} container at index ${i}, segment ${j}`
				)
			}

			if (isArray(container)) {
				if (!isValidArrayIndex(segment, container.length, false)) {
					throw new RFC6902ConversionError(
						`Invalid array index "${segment}" at index ${i}, segment ${j}`
					)
				}
				pointerSegments.push(segment)
				container = container[Number(segment)]
			} else if (isObjectish(container)) {
				const key = String(segment)
				if (!Object.prototype.hasOwnProperty.call(container, key)) {
					throw new RFC6902ConversionError(
						`Object key "${key}" not found at index ${i}, segment ${j}`
					)
				}
				pointerSegments.push(key)
				container = container[key]
			} else {
				throw new RFC6902ConversionError(
					`Cannot traverse non-object container at index ${i}, segment ${j}`
				)
			}
		}

		// Handle the last (target) segment
		const lastSegment = path[path.length - 1]

		if (isMap(container) || isSet(container)) {
			throw new RFC6902ConversionError(
				`Map/Set as target container at index ${i}`
			)
		}

		if (container === null || container === undefined) {
			throw new RFC6902ConversionError(
				`Cannot apply to ${container} container at index ${i}`
			)
		}

		let operation: RFC6902Operation

		if (isArray(container)) {
			const arrayLength = container.length
			const forAdd = op === "add"

			if (!isValidArrayIndex(lastSegment, arrayLength, forAdd)) {
				throw new RFC6902ConversionError(
					`Invalid array index "${lastSegment}" for ${op} at index ${i}`
				)
			}

			// For `add` at the append position (index == length), use "-"
			let pointerSegment: string | number
			if (
				forAdd &&
				(lastSegment === APPEND_POINTER || Number(lastSegment) === arrayLength)
			) {
				pointerSegment = APPEND_POINTER
			} else {
				pointerSegment = lastSegment
			}

			pointerSegments.push(pointerSegment)
			const pointerPath = buildPointer(pointerSegments)

			if (op === "remove") {
				operation = {op: "remove", path: pointerPath}
			} else {
				assertJSONValue(value, pointerPath)
				operation = {op, path: pointerPath}
				if (value !== undefined) {
					operation.value = value
				}
			}
		} else if (isObjectish(container)) {
			const key = String(lastSegment)
			pointerSegments.push(key)
			const pointerPath = buildPointer(pointerSegments)

			if (op === "remove") {
				operation = {op: "remove", path: pointerPath}
			} else {
				assertJSONValue(value, pointerPath)
				operation = {op, path: pointerPath}
				if (value !== undefined) {
					operation.value = value
				}
			}
		} else {
			throw new RFC6902ConversionError(
				`Cannot apply to non-object container at index ${i}`
			)
		}

		operations.push(operation)
		candidate = applyRFC6902Operation(candidate, operation)
	}

	return operations
}
