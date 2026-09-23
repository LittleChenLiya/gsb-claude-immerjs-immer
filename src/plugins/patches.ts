import {immerable} from "../immer"
import {
	ImmerState,
	Patch,
	RebasePatchConflict,
	RebasePatchesResult,
	SetState,
	ProxyArrayState,
	MapState,
	ProxyObjectState,
	PatchPath,
	get,
	each,
	has,
	getArchtype,
	getPrototypeOf,
	isSet,
	isMap,
	loadPlugin,
	ArchType,
	die,
	isDraft,
	isDraftable,
	NOTHING,
	errors,
	DRAFT_STATE,
	getProxyDraft,
	ImmerScope,
	isObjectish,
	isFunction,
	CONSTRUCTOR,
	PluginPatches,
	isArray,
	PROTOTYPE
} from "../internal"

export function enablePatches() {
	const errorOffset = 16
	if (process.env.NODE_ENV !== "production") {
		errors.push(
			'Sets cannot have "replace" patches.',
			function (op: string) {
				return "Unsupported patch operation: " + op
			},
			function (path: string) {
				return "Cannot apply patch, path doesn't resolve: " + path
			},
			"Patching reserved attributes like __proto__, prototype and constructor is not allowed"
		)
	}

	function getPath(state: ImmerState, path: PatchPath = []): PatchPath | null {
		// Step 1: Check if state has a stored key
		if (state.key_ !== undefined) {
			// Step 2: Validate the key is still valid in parent

			const parentCopy = state.parent_!.copy_ ?? state.parent_!.base_
			const proxyDraft = getProxyDraft(get(parentCopy, state.key_!))
			const valueAtKey = get(parentCopy, state.key_!)

			if (valueAtKey === undefined) {
				return null
			}

			// Check if the value at the key is still related to this draft
			// It should be either the draft itself, the base, or the copy
			if (
				valueAtKey !== state.draft_ &&
				valueAtKey !== state.base_ &&
				valueAtKey !== state.copy_
			) {
				return null // Value was replaced with something else
			}
			if (proxyDraft != null && proxyDraft.base_ !== state.base_) {
				return null // Different draft
			}

			// Step 3: Handle Set case specially
			const isSet = state.parent_!.type_ === ArchType.Set
			let key: string | number

			if (isSet) {
				// For Sets, find the index in the drafts_ map
				const setParent = state.parent_ as SetState
				key = Array.from(setParent.drafts_.keys()).indexOf(state.key_)
			} else {
				key = state.key_ as string | number
			}

			// Step 4: Validate key still exists in parent
			if (!((isSet && parentCopy.size > key) || has(parentCopy, key))) {
				return null // Key deleted
			}

			// Step 5: Add key to path
			path.push(key)
		}

		// Step 6: Recurse to parent if exists
		if (state.parent_) {
			return getPath(state.parent_, path)
		}

		// Step 7: At root - reverse path and validate
		path.reverse()

		try {
			// Validate path can be resolved from ROOT
			resolvePath(state.copy_, path)
		} catch (e) {
			return null // Path invalid
		}

		return path
	}

	// NEW: Add resolvePath helper function
	function resolvePath(base: any, path: PatchPath): any {
		let current = base
		for (let i = 0; i < path.length - 1; i++) {
			const key = path[i]
			current = get(current, key)
			if (!isObjectish(current) || current === null) {
				throw new Error(`Cannot resolve path at '${path.join("/")}'`)
			}
		}
		return current
	}

	const REPLACE = "replace"
	const ADD = "add"
	const REMOVE = "remove"

	function generatePatches_(
		state: ImmerState,
		basePath: PatchPath,
		scope: ImmerScope
	): void {
		if (state.scope_.processedForPatches_.has(state)) {
			return
		}

		state.scope_.processedForPatches_.add(state)

		const {patches_, inversePatches_} = scope

		switch (state.type_) {
			case ArchType.Object:
			case ArchType.Map:
				return generatePatchesFromAssigned(
					state,
					basePath,
					patches_!,
					inversePatches_!
				)
			case ArchType.Array:
				return generateArrayPatches(
					state,
					basePath,
					patches_!,
					inversePatches_!
				)
			case ArchType.Set:
				return generateSetPatches(
					state as any as SetState,
					basePath,
					patches_!,
					inversePatches_!
				)
		}
	}

	function generateArrayPatches(
		state: ProxyArrayState,
		basePath: PatchPath,
		patches: Patch[],
		inversePatches: Patch[]
	) {
		let {base_, assigned_} = state
		let copy_ = state.copy_!

		// Reduce complexity by ensuring `base` is never longer.
		if (copy_.length < base_.length) {
			// @ts-ignore
			;[base_, copy_] = [copy_, base_]
			;[patches, inversePatches] = [inversePatches, patches]
		}

		const allReassigned = state.allIndicesReassigned_ === true

		// Process replaced indices.
		for (let i = 0; i < base_.length; i++) {
			const copiedItem = copy_[i]
			const baseItem = base_[i]

			const isAssigned = allReassigned || assigned_?.get(i.toString())
			if (isAssigned && copiedItem !== baseItem) {
				const childState = copiedItem?.[DRAFT_STATE]
				if (childState && childState.modified_) {
					// Skip - let the child generate its own patches
					continue
				}
				const path = basePath.concat([i])
				patches.push({
					op: REPLACE,
					path,
					// Need to maybe clone it, as it can in fact be the original value
					// due to the base/copy inversion at the start of this function
					value: clonePatchValueIfNeeded(copiedItem)
				})
				inversePatches.push({
					op: REPLACE,
					path,
					value: clonePatchValueIfNeeded(baseItem)
				})
			}
		}

		// Process added indices.
		for (let i = base_.length; i < copy_.length; i++) {
			const path = basePath.concat([i])
			patches.push({
				op: ADD,
				path,
				// Need to maybe clone it, as it can in fact be the original value
				// due to the base/copy inversion at the start of this function
				value: clonePatchValueIfNeeded(copy_[i])
			})
		}
		for (let i = copy_.length - 1; base_.length <= i; --i) {
			const path = basePath.concat([i])
			inversePatches.push({
				op: REMOVE,
				path
			})
		}
	}

	// This is used for both Map objects and normal objects.
	function generatePatchesFromAssigned(
		state: MapState | ProxyObjectState,
		basePath: PatchPath,
		patches: Patch[],
		inversePatches: Patch[]
	) {
		const {base_, copy_, type_} = state
		each(state.assigned_!, (key, assignedValue) => {
			const origValue = get(base_, key, type_)
			const value = get(copy_!, key, type_)
			const op = !assignedValue ? REMOVE : has(base_, key) ? REPLACE : ADD
			if (origValue === value && op === REPLACE) return
			const path = basePath.concat(key as any)
			patches.push(
				op === REMOVE
					? {op, path}
					: {op, path, value: clonePatchValueIfNeeded(value)}
			)
			inversePatches.push(
				op === ADD
					? {op: REMOVE, path}
					: op === REMOVE
						? {op: ADD, path, value: clonePatchValueIfNeeded(origValue)}
						: {op: REPLACE, path, value: clonePatchValueIfNeeded(origValue)}
			)
		})
	}

	function generateSetPatches(
		state: SetState,
		basePath: PatchPath,
		patches: Patch[],
		inversePatches: Patch[]
	) {
		let {base_, copy_} = state

		let i = 0
		base_.forEach((value: any) => {
			if (!copy_!.has(value)) {
				const path = basePath.concat([i])
				patches.push({
					op: REMOVE,
					path,
					value
				})
				inversePatches.unshift({
					op: ADD,
					path,
					value
				})
			}
			i++
		})
		i = 0
		copy_!.forEach((value: any) => {
			if (!base_.has(value)) {
				const path = basePath.concat([i])
				patches.push({
					op: ADD,
					path,
					value
				})
				inversePatches.unshift({
					op: REMOVE,
					path,
					value
				})
			}
			i++
		})
	}

	function generateReplacementPatches_(
		baseValue: any,
		replacement: any,
		scope: ImmerScope
	): void {
		const {patches_, inversePatches_} = scope
		patches_!.push({
			op: REPLACE,
			path: [],
			value: replacement === NOTHING ? undefined : replacement
		})
		inversePatches_!.push({
			op: REPLACE,
			path: [],
			value: baseValue
		})
	}

	function applyPatches_<T>(draft: T, patches: readonly Patch[]): T {
		patches.forEach(patch => {
			const {path, op} = patch

			let base: any = draft
			for (let i = 0; i < path.length - 1; i++) {
				const parentType = getArchtype(base)
				let p = path[i]
				if (typeof p !== "string" && typeof p !== "number") {
					p = "" + p
				}

				// See #738, avoid prototype pollution
				if (
					(parentType === ArchType.Object || parentType === ArchType.Array) &&
					(p === "__proto__" || p === CONSTRUCTOR)
				)
					die(errorOffset + 3)
				if (isFunction(base) && p === PROTOTYPE) die(errorOffset + 3)
				base = get(base, p)
				if (base === null || !isObjectish(base))
					die(errorOffset + 2, path.join("/"))
			}

			const type = getArchtype(base)
			const value = deepClonePatchValue(patch.value) // used to clone patch to ensure original patch is not modified, see #411
			const key = path[path.length - 1]
			switch (op) {
				case REPLACE:
					switch (type) {
						case ArchType.Map:
							return base.set(key, value)
						/* istanbul ignore next */
						case ArchType.Set:
							die(errorOffset)
						default:
							// if value is an object, then it's assigned by reference
							// in the following add or remove ops, the value field inside the patch will also be modifyed
							// so we use value from the cloned patch
							// @ts-ignore
							return (base[key] = value)
					}
				case ADD:
					switch (type) {
						case ArchType.Array:
							return key === "-"
								? base.push(value)
								: base.splice(key as any, 0, value)
						case ArchType.Map:
							return base.set(key, value)
						case ArchType.Set:
							return base.add(value)
						default:
							return (base[key] = value)
					}
				case REMOVE:
					switch (type) {
						case ArchType.Array:
							return base.splice(key as any, 1)
						case ArchType.Map:
							return base.delete(key)
						case ArchType.Set:
							return base.delete(patch.value)
						default:
							return delete base[key]
					}
				default:
					die(errorOffset + 1, op)
			}
		})

		return draft
	}

	// optimize: this is quite a performance hit, can we detect intelligently when it is needed?
	// E.g. auto-draft when new objects from outside are assigned and modified?
	// (See failing test when deepClone just returns obj)
	function deepClonePatchValue<T>(obj: T): T
	function deepClonePatchValue(obj: any) {
		if (!isDraftable(obj)) return obj
		if (isArray(obj)) return obj.map(deepClonePatchValue)
		if (isMap(obj))
			return new Map(
				Array.from(obj.entries()).map(([k, v]) => [k, deepClonePatchValue(v)])
			)
		if (isSet(obj)) return new Set(Array.from(obj).map(deepClonePatchValue))
		const cloned = Object.create(getPrototypeOf(obj))
		for (const key in obj) cloned[key] = deepClonePatchValue(obj[key])
		if (has(obj, immerable)) cloned[immerable] = obj[immerable]
		return cloned
	}

	function clonePatchValueIfNeeded<T>(obj: T): T {
		if (isDraft(obj)) {
			return deepClonePatchValue(obj)
		} else return obj
	}

	loadPlugin(PluginPatches, {
		applyPatches_,
		generatePatches_,
		generateReplacementPatches_,
		getPath
	})
}

type ArrayToken =
	| {kind: "base"; id: number}
	| {kind: "insert"; side: 0 | 1; seq: number; gap: number; ord: number}

type NormSegment = string | number | ArrayToken

interface NormOp {
	index: number
	op: "replace" | "add" | "remove"
	path: NormSegment[]
	value: any
	dup: boolean
}

interface ArraySim {
	tokens: ArrayToken[]
	baseTokens: ArrayToken[]
	baseLength: number
}

function dieRebaseMapSet(): never {
	throw new Error("rebasePatches does not support Map/Set patches")
}

function assertNoMapSetPatches(base: any, patches: readonly Patch[]): void {
	if (isMap(base) || isSet(base)) dieRebaseMapSet()
	for (const patch of patches) {
		if (isMap(patch.value) || isSet(patch.value)) dieRebaseMapSet()
		let cur = base
		for (const seg of patch.path) {
			if (cur === null || cur === undefined) break
			cur = cur[seg as any]
			if (isMap(cur) || isSet(cur)) dieRebaseMapSet()
		}
	}
}

function cloneRebaseValue<T>(value: T): T {
	if (!isDraftable(value)) return value
	if (isArray(value)) return value.map(cloneRebaseValue) as any
	const cloned = Object.create(getPrototypeOf(value))
	for (const key in value) cloned[key] = cloneRebaseValue((value as any)[key])
	return cloned
}

function rebaseValuesEqual(a: any, b: any): boolean {
	if (a === b) return true
	if (!isObjectish(a) || !isObjectish(b)) return false
	if (isArray(a) !== isArray(b)) return false
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)
	if (aKeys.length !== bKeys.length) return false
	for (const key of aKeys) {
		if (!has(b, key) || !rebaseValuesEqual(a[key], b[key])) return false
	}
	return true
}

function isTokenSegment(seg: NormSegment): seg is ArrayToken {
	return typeof seg === "object"
}

function segmentsEqual(a: NormSegment, b: NormSegment): boolean {
	const aIsToken = isTokenSegment(a)
	const bIsToken = isTokenSegment(b)
	if (aIsToken !== bIsToken) return false
	if (!aIsToken || !bIsToken) return "" + a === "" + (b as any)
	if (a.kind !== b.kind) return false
	if (a.kind === "base" && b.kind === "base") return a.id === b.id
	return a === b
}

function tokensEqual(a: ArrayToken, b: ArrayToken): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === "base" && b.kind === "base") return a.id === b.id
	return a === b
}

// Sort order inside a merged array: base elements by id; inserts sort before
// the base element at their gap, local inserts before incoming inserts.
function compareTokens(a: ArrayToken, b: ArrayToken): number {
	const ka: [number, number, number] =
		a.kind === "base" ? [a.id, 2, 0] : [a.gap, a.side, a.ord]
	const kb: [number, number, number] =
		b.kind === "base" ? [b.id, 2, 0] : [b.gap, b.side, b.ord]
	for (let i = 0; i < 3; i++) {
		if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
	}
	return 0
}

function arrayKeyOf(path: NormSegment[]): string {
	return JSON.stringify(
		path.map(seg =>
			isTokenSegment(seg)
				? seg.kind === "base"
					? ["b", seg.id]
					: ["i", seg.side, seg.seq]
				: ["k", "" + seg]
		)
	)
}

function plainPath(path: NormSegment[]): PatchPath {
	return path.map(seg =>
		isTokenSegment(seg) ? (seg.kind === "base" ? seg.id : seg.gap) : seg
	)
}

function normalizeRebaseOps(
	base: any,
	patches: readonly Patch[],
	side: 0 | 1,
	sims: Map<string, ArraySim>
): NormOp[] {
	let seq = 0
	const ops: NormOp[] = []
	for (let index = 0; index < patches.length; index++) {
		const patch = patches[index]
		const normPath: NormSegment[] = []
		let cur = base
		for (let i = 0; i < patch.path.length; i++) {
			const isLast = i === patch.path.length - 1
			if (isArray(cur)) {
				const key = arrayKeyOf(normPath)
				let sim = sims.get(key)
				if (!sim) {
					const baseTokens: ArrayToken[] = []
					for (let id = 0; id < cur.length; id++) {
						baseTokens.push({kind: "base", id})
					}
					sim = {
						tokens: baseTokens.slice(),
						baseTokens,
						baseLength: cur.length
					}
					sims.set(key, sim)
				}
				const rawSeg = patch.path[i]
				const idx = rawSeg === "-" ? sim.tokens.length : Number(rawSeg)
				if (isLast && patch.op === "add") {
					let gap = sim.baseLength
					if (idx < sim.tokens.length) {
						const next = sim.tokens[idx]
						gap = next.kind === "base" ? next.id : next.gap
					}
					const token: ArrayToken = {kind: "insert", side, seq: seq++, gap, ord: 0}
					sim.tokens.splice(idx, 0, token)
					normPath.push(token)
				} else {
					const token = sim.tokens[idx]
					if (token === undefined) {
						normPath.push(rawSeg)
						cur = undefined
						continue
					}
					normPath.push(token)
					if (isLast && patch.op === "remove") sim.tokens.splice(idx, 1)
					cur = token.kind === "base" ? cur[token.id] : undefined
				}
			} else {
				const seg = patch.path[i]
				normPath.push(seg)
				cur = cur === null || cur === undefined ? undefined : cur[seg as any]
			}
		}
		ops.push({index, op: patch.op, path: normPath, value: patch.value, dup: false})
	}
	// Record final per-side order of insert tokens for stable merge ordering
	sims.forEach(sim => {
		sim.tokens.forEach((token, i) => {
			if (token.kind === "insert") token.ord = i
		})
	})
	return ops
}

type PathRelation = "equal" | "ancestor" | "descendant" | "disjoint"

function relatePaths(a: NormSegment[], b: NormSegment[]): PathRelation {
	const len = Math.min(a.length, b.length)
	for (let i = 0; i < len; i++) {
		if (!segmentsEqual(a[i], b[i])) return "disjoint"
	}
	if (a.length === b.length) return "equal"
	return a.length < b.length ? "ancestor" : "descendant"
}

function applyToShadow(root: any, patch: Patch): any {
	const value = cloneRebaseValue(patch.value)
	if (patch.path.length === 0) {
		return patch.op === "remove" ? undefined : value
	}
	let cur = root
	for (let i = 0; i < patch.path.length - 1; i++) {
		cur = cur[patch.path[i] as any]
	}
	const key = patch.path[patch.path.length - 1]
	if (isArray(cur)) {
		if (patch.op === "add") {
			cur.splice((key as any) === "-" ? cur.length : Number(key), 0, value)
		} else if (patch.op === "remove") {
			cur.splice(Number(key), 1)
		} else {
			cur[key as any] = value
		}
	} else {
		if (patch.op === "remove") delete cur[key]
		else cur[key] = value
	}
	return root
}

function resolveShadowValue(root: any, path: (string | number)[]): any {
	let cur = root
	for (const seg of path) cur = cur[seg as any]
	return cur
}

/**
 * Rebases `incomingPatches` (produced from `base`) so they can be applied on
 * top of the result of applying `localPatches` to `base`.
 *
 * Only plain object and array patches are supported; patches touching Maps or
 * Sets are rejected. Neither `base` nor the passed patch lists are modified.
 *
 * When conflicts are found, no applicable patches are returned and every
 * conflict reports the indices of the conflicting operations on both sides
 * plus the conflicting path in base-state coordinates.
 */
export function rebasePatches(
	base: any,
	localPatches: readonly Patch[],
	incomingPatches: readonly Patch[]
): RebasePatchesResult {
	assertNoMapSetPatches(base, localPatches)
	assertNoMapSetPatches(base, incomingPatches)

	const localSims = new Map<string, ArraySim>()
	const incomingSims = new Map<string, ArraySim>()
	const localOps = normalizeRebaseOps(base, localPatches, 0, localSims)
	const incomingOps = normalizeRebaseOps(base, incomingPatches, 1, incomingSims)

	const conflicts: RebasePatchConflict[] = []
	const addConflict = (
		lop: NormOp,
		iop: NormOp,
		path: NormSegment[],
		reason: string
	) => {
		conflicts.push({
			localIndex: lop.index,
			incomingIndex: iop.index,
			path: plainPath(path),
			reason
		})
	}

	for (const iop of incomingOps) {
		for (const lop of localOps) {
			const relation = relatePaths(iop.path, lop.path)
			if (relation === "disjoint") continue
			if (relation === "equal") {
				if (lop.op === "remove" && iop.op === "remove") {
					iop.dup = true
				} else if (lop.op === "remove" || iop.op === "remove") {
					addConflict(
						lop,
						iop,
						iop.path,
						"one side removed this value while the other side modified it"
					)
				} else if (rebaseValuesEqual(lop.value, iop.value)) {
					iop.dup = true
				} else {
					addConflict(
						lop,
						iop,
						iop.path,
						"both sides set the same path to different values"
					)
				}
			} else {
				const ancestor = relation === "ancestor" ? iop : lop
				// An "add" of a container recreated identically on both sides is
				// compatible with descendant modifications; the equal-path add
				// pair itself is deduplicated or reported as conflict above.
				if (ancestor.op === "add") continue
				addConflict(
					lop,
					iop,
					ancestor.path,
					ancestor.op === "remove"
						? "one side removed an ancestor while the other side modified a descendant"
						: "one side replaced an ancestor while the other side modified a descendant"
				)
			}
		}
	}

	if (conflicts.length > 0) {
		return {patches: [], inversePatches: [], conflicts}
	}

	// Current merged token list per array: local result, then incoming ops
	// are woven in one by one.
	const currentLists = new Map<string, ArrayToken[]>()
	localSims.forEach((sim, key) => currentLists.set(key, sim.tokens.slice()))
	incomingSims.forEach((sim, key) => {
		if (!currentLists.has(key)) currentLists.set(key, sim.baseTokens.slice())
	})

	// Shadow copy of base + local patches, used to compute exact inverse values
	let shadow = cloneRebaseValue(base)
	for (const patch of localPatches) {
		shadow = applyToShadow(shadow, patch)
	}

	const patches: Patch[] = []
	const inversePatches: Patch[] = []
	for (const iop of incomingOps) {
		if (iop.dup) continue
		const emittedPath: (string | number)[] = []
		for (let i = 0; i < iop.path.length; i++) {
			const seg = iop.path[i]
			if (!isTokenSegment(seg)) {
				emittedPath.push(seg)
				continue
			}
			const isLast = i === iop.path.length - 1
			const list = currentLists.get(arrayKeyOf(iop.path.slice(0, i)))!
			if (isLast && iop.op === "add") {
				const pos = list.findIndex(token => compareTokens(token, seg) > 0)
				const idx = pos === -1 ? list.length : pos
				list.splice(idx, 0, seg)
				emittedPath.push(idx)
			} else {
				const idx = list.findIndex(token => tokensEqual(token, seg))
				if (idx === -1) {
					// Defensive: cannot happen for valid, conflict-free input
					conflicts.push({
						localIndex: -1,
						incomingIndex: iop.index,
						path: plainPath(iop.path),
						reason: "target element no longer exists after local patches"
					})
					break
				}
				if (isLast && iop.op === "remove") list.splice(idx, 1)
				emittedPath.push(idx)
			}
		}
		if (conflicts.length > 0) break
		const emitted: Patch =
			iop.op === "remove"
				? {op: "remove", path: emittedPath}
				: {op: iop.op, path: emittedPath, value: cloneRebaseValue(iop.value)}
		patches.push(emitted)
		if (iop.op === "add") {
			inversePatches.unshift({op: "remove", path: emittedPath.slice()})
		} else {
			const before = resolveShadowValue(shadow, emittedPath)
			inversePatches.unshift(
				iop.op === "remove"
					? {
							op: "add",
							path: emittedPath.slice(),
							value: cloneRebaseValue(before)
						}
					: {
							op: "replace",
							path: emittedPath.slice(),
							value: cloneRebaseValue(before)
						}
			)
		}
		shadow = applyToShadow(shadow, emitted)
	}

	if (conflicts.length > 0) {
		return {patches: [], inversePatches: [], conflicts}
	}
	return {patches, inversePatches, conflicts}
}
