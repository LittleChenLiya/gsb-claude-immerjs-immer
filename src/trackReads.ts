import {isPlainObject} from "./internal"

/**
 * The kind of read operation that was observed on the tracked state:
 *
 * - "get": a property was read (e.g. state.user.name). The path includes
 *   the property key that was read.
 * - "has": a property existence check was performed (e.g. "theme" in state).
 *   The path includes the property key that was checked.
 * - "enumerate": the own keys of an object were enumerated (e.g.
 *   Object.keys(state.user), for...in, object spread). The path points
 *   at the object whose keys were enumerated.
 * - "iterate": an object was iterated via its iterator protocol (e.g.
 *   for...of state.items, array spread). The path points at the iterated
 *   object. Note that iterating an array also reads its length and
 *   indices, which are recorded separately.
 * - "length": the length property of an array was read. The path points
 *   at the array itself.
 */
export type ReadAccessType = "get" | "has" | "enumerate" | "iterate" | "length"

/**
 * A single recorded read operation. path is the list of keys (string,
 * number or symbol) leading from the base state to the accessed location.
 */
export interface ReadAccess {
	type: ReadAccessType
	path: PropertyKey[]
}

export interface TrackReadsResult<R> {
	/** The value returned by the reader function */
	result: R
	/** Every read operation performed by the reader, in order of occurrence */
	accesses: ReadAccess[]
}

function isTrackable(value: any): boolean {
	return isPlainObject(value) || Array.isArray(value)
}

function readOnlyError(operation: string): Error {
	return new Error(
		"[immer] trackReads: the tracked state is read-only, cannot perform '" +
			operation +
			"'"
	)
}

/**
 * Runs a synchronous reader function against a read-only, lazily-proxied
 * view of base (using the same proxy approach as Immer drafts, but
 * tracking reads instead of writes) and reports exactly which parts of the
 * state the reader actually depended on.
 *
 * Every property read, in-check, key enumeration, array length read and
 * iteration is recorded as a distinct ReadAccess. Reads are recorded per
 * occurrence, so reading the same path twice yields two records. Reads that
 * never happen (e.g. inside branches that were not taken) are not recorded.
 *
 * The tracked state is strictly read-only: any attempt to mutate it throws.
 * The proxies are revoked as soon as trackReads returns, so leaking a
 * (nested) proxy out of the reader and using it later throws as well.
 *
 * @param base - the state to observe; it is never modified
 * @param reader - synchronous function that reads from the tracked state
 * @returns the reader's return value and the list of recorded read accesses
 */
export function trackReads<T, R>(
	base: T,
	reader: (state: T) => R
): TrackReadsResult<R> {
	const accesses: ReadAccess[] = []
	const proxies = new WeakMap<object, any>()
	let active = true

	function assertActive() {
		if (!active) {
			throw new Error(
				"[immer] trackReads: tracked state cannot be used after trackReads has returned"
			)
		}
	}

	function wrap(value: any, path: PropertyKey[]): any {
		if (!isTrackable(value)) return value
		const cached = proxies.get(value)
		if (cached !== undefined) return cached
		const isArray = Array.isArray(value)
		const proxy = new Proxy(value, {
			get(target, key, receiver) {
				assertActive()
				if (key === Symbol.iterator) {
					accesses.push({type: "iterate", path: path.slice()})
				} else if (isArray && key === "length") {
					accesses.push({type: "length", path: path.slice()})
				} else {
					accesses.push({type: "get", path: path.concat(key)})
				}
				// Use the receiver so that getters see the proxy as 'this' and
				// nested reads through 'this' are tracked as well. If the getter
				// throws, the access has already been recorded and the error
				// propagates to the reader.
				return wrap(Reflect.get(target, key, receiver), path.concat(key))
			},
			has(target, key) {
				assertActive()
				accesses.push({type: "has", path: path.concat(key)})
				return Reflect.has(target, key)
			},
			ownKeys(target) {
				assertActive()
				accesses.push({type: "enumerate", path: path.slice()})
				return Reflect.ownKeys(target)
			},
			getOwnPropertyDescriptor(target, key) {
				assertActive()
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
			set() {
				throw readOnlyError("set")
			},
			deleteProperty() {
				throw readOnlyError("deleteProperty")
			},
			defineProperty() {
				throw readOnlyError("defineProperty")
			},
			setPrototypeOf() {
				throw readOnlyError("setPrototypeOf")
			}
		})
		proxies.set(value, proxy)
		return proxy
	}

	let result: R
	try {
		result = reader(wrap(base, []))
	} finally {
		active = false
	}
	return {result, accesses}
}
