import {isArray, isArrayIndex, isPlainObject, getPrototypeOf} from "../internal"

/**
 * The kind of read operation that was observed on the tracked state.
 *
 * - `"get"`: a property was read (e.g. `state.user.name`)
 * - `"has"`: a property was checked for existence (e.g. `"theme" in state`)
 * - `"ownKeys"`: the keys of an object were enumerated
 *   (e.g. `Object.keys(state)`, `for..in`, `{...state}`)
 * - `"length"`: the `length` of an array was read
 * - `"iterate"`: an array was iterated
 *   (e.g. `for..of`, spread, or an iterating array method like `map`)
 */
export type ReadAccessType = "get" | "has" | "ownKeys" | "length" | "iterate"

/**
 * A single observed read operation.
 *
 * `path` is the full key path from the root of the tracked state to the
 * value the operation was performed on. For `"get"` and `"has"` the
 * accessed key is the last element of the path. Keys are kept as-is, so
 * symbol keys appear as symbols in the path.
 */
export interface ReadAccess {
	type: ReadAccessType
	path: PropertyKey[]
}

export interface ReadAccessReport<R> {
	/** The value returned by the reader function */
	result: R
	/**
	 * The read operations performed by the reader, in order of first
	 * occurrence. Repeated identical accesses (same type, same path) are
	 * recorded only once.
	 */
	accesses: ReadAccess[]
}

// Array methods that iterate over (a subset of) the array elements
const ITERATING_ARRAY_METHODS = new Set<PropertyKey>([
	"forEach",
	"map",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"some",
	"every",
	"reduce",
	"reduceRight",
	"includes",
	"indexOf",
	"lastIndexOf",
	"flat",
	"flatMap",
	"join",
	"entries",
	"keys",
	"values"
])

interface TrackNode {
	base: any
	path: PropertyKey[]
	proxy: object
	revoke: () => void
	children: Map<PropertyKey, object>
}

function pathsEqual(a: PropertyKey[], b: PropertyKey[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (!Object.is(a[i], b[i])) return false
	}
	return true
}

/**
 * Runs a synchronous `reader` function against a read-only, tracked view of
 * `base` and reports exactly which parts of the state the reader accessed.
 *
 * The tracked view never modifies `base`: any attempt to write, delete or
 * redefine a property through it throws. All proxies handed to the reader
 * are revoked once the reader finishes, so state captured ("leaked") from
 * inside the reader cannot be used afterwards.
 *
 * @param base - the (draftable) state to observe
 * @param reader - synchronous function that reads from the tracked state
 * @returns the reader's return value plus the list of recorded accesses
 */
export function collectReads<T extends object, R>(
	base: T,
	reader: (tracked: T) => R
): ReadAccessReport<R> {
	const accesses: ReadAccess[] = []
	const nodes: TrackNode[] = []

	function record(type: ReadAccessType, path: PropertyKey[]) {
		if (!accesses.some(a => a.type === type && pathsEqual(a.path, path))) {
			accesses.push({type, path})
		}
	}

	function isTrackable(value: any): boolean {
		return isArray(value) || isPlainObject(value)
	}

	function wrap(value: any, path: PropertyKey[], parent?: TrackNode): any {
		if (!isTrackable(value)) return value
		if (parent) {
			const key = path[path.length - 1]
			const cached = parent.children.get(key)
			if (cached) return cached
		}
		const node = createNode(value, path)
		if (parent) parent.children.set(path[path.length - 1], node.proxy)
		return node.proxy
	}

	function createNode(target: any, path: PropertyKey[]): TrackNode {
		const node: TrackNode = {
			base: target,
			path,
			proxy: null as any,
			revoke: null as any,
			children: new Map()
		}
		const baseIsArray = isArray(target)

		function normalizeKey(prop: PropertyKey): PropertyKey {
			return baseIsArray && typeof prop === "string" && isArrayIndex(prop)
				? +prop
				: prop
		}

		const traps: ProxyHandler<object> = {
			get(_, prop, receiver) {
				if (baseIsArray && prop === "length") {
					record("length", path)
					return target.length
				}
				if (baseIsArray && prop === Symbol.iterator) {
					record("iterate", path)
					return function* (this: any) {
						for (let i = 0; i < target.length; i++) {
							yield wrap(target[i], [...path, i], node)
						}
					}
				}
				if (baseIsArray && ITERATING_ARRAY_METHODS.has(prop)) {
					record("iterate", path)
				} else {
					record("get", [...path, normalizeKey(prop)])
				}
				const value = Reflect.get(target, prop, receiver)
				return wrap(value, [...path, normalizeKey(prop)], node)
			},
			has(_, prop) {
				record("has", [...path, normalizeKey(prop)])
				return Reflect.has(target, prop)
			},
			ownKeys(_) {
				record("ownKeys", path)
				return Reflect.ownKeys(target)
			},
			getOwnPropertyDescriptor(_, prop) {
				return Reflect.getOwnPropertyDescriptor(target, prop)
			},
			getPrototypeOf(_) {
				return getPrototypeOf(target)
			},
			set() {
				throw new Error(
					"[Immer] collectReads: the tracked state is read-only, properties cannot be set"
				)
			},
			deleteProperty() {
				throw new Error(
					"[Immer] collectReads: the tracked state is read-only, properties cannot be deleted"
				)
			},
			defineProperty() {
				throw new Error(
					"[Immer] collectReads: the tracked state is read-only, properties cannot be defined"
				)
			},
			setPrototypeOf() {
				throw new Error(
					"[Immer] collectReads: the tracked state is read-only, the prototype cannot be changed"
				)
			}
		}

		const {proxy, revoke} = Proxy.revocable(target, traps)
		node.proxy = proxy
		node.revoke = revoke
		nodes.push(node)
		return node
	}

	const root = createNode(base, [])
	try {
		const result = reader(root.proxy as T)
		return {result, accesses}
	} finally {
		for (const node of nodes) {
			node.revoke()
		}
	}
}
