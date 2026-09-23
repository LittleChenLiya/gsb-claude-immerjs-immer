import {immerable} from "../immer"
import {
	ImmerState,
	Patch,
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
	RebaseResult,
	RebaseConflict,
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
		getPath,
		rebasePatches_
	})

	// -----------------------------------------------------------------
	// rebasePatches (first version): plain objects and arrays only.
	// Map/Set patches, and Map/Set values anywhere in base or in patch
	// values, are explicitly rejected.
	// -----------------------------------------------------------------

	type RebaseMirrorNode = {
		// Base index within the parent array; -1 for inserted elements.
		orig: number
		type: "object" | "array" | "leaf"
		children?: Map<string | number, RebaseMirrorNode>
		slots?: RebaseMirrorNode[]
		// incoming-mirror node -> corresponding merged-mirror node
		ref?: RebaseMirrorNode
		// Net local effect on this node: 0 = none, 1 = replaced/added,
		// 2 = removed.
		localEffect: 0 | 1 | 2
		localEffectValue?: any
		localEffectIndex: number
		// A local patch operates strictly below this node.
		localDesc: boolean
		localDescIndex: number
		// Array node: base element orig -> local patch index that removed it.
		deletedByLocal?: Map<number, number>
	}

	function isRebaseObject(value: any): boolean {
		if (!isObjectish(value)) return false
		const proto = getPrototypeOf(value)
		return proto === Object.prototype || proto === null
	}

	function throwRebaseMapSet(): never {
		throw new Error(
			"rebasePatches: Map/Set patches are not supported, only plain objects and arrays"
		)
	}

	function throwRebasePath(path: PatchPath): never {
		throw new Error(
			"rebasePatches: patch path doesn't resolve against base: " +
				path.join("/")
		)
	}

	// Sentinel marking a replaced subtree that local patches modified
	// afterwards, so same-value duplicate detection no longer applies.
	const rebaseDirtyValue: any = {}

	function assertRebasableValue(value: any): void {
		if (isMap(value) || isSet(value)) throwRebaseMapSet()
		if (isArray(value)) {
			for (let i = 0; i < value.length; i++) assertRebasableValue(value[i])
		} else if (isRebaseObject(value)) {
			for (const key in value) assertRebasableValue(value[key])
		}
	}

	function assertRebasablePath(path: PatchPath): void {
		for (const seg of path) {
			if (seg === "__proto__")
				throw new Error(
					"Patching reserved attributes like __proto__, prototype and constructor is not allowed"
				)
		}
	}

	function createMirrorNode(value: any, orig: number): RebaseMirrorNode {
		assertRebasableValue(value)
		const node: RebaseMirrorNode = {
			orig,
			type: "leaf",
			localEffect: 0,
			localEffectIndex: -1,
			localDesc: false,
			localDescIndex: -1
		}
		if (isArray(value)) {
			node.type = "array"
			node.slots = value.map((item, i) => createMirrorNode(item, i))
		} else if (isRebaseObject(value)) {
			node.type = "object"
			node.children = new Map()
			for (const key in value)
				node.children.set(key, createMirrorNode(value[key], -1))
		}
		return node
	}

	function rebaseArraySegment(seg: string | number): number {
		if (seg === "-") return -1
		return typeof seg === "string" ? parseInt(seg, 10) : seg
	}

	function rebaseDeepEqual(a: any, b: any): boolean {
		if (Object.is(a, b)) return true
		if (isArray(a) && isArray(b))
			return (
				a.length === b.length &&
				a.every((item: any, i: number) => rebaseDeepEqual(item, b[i]))
			)
		if (isRebaseObject(a) && isRebaseObject(b)) {
			const aKeys = Object.keys(a)
			return (
				aKeys.length === Object.keys(b).length &&
				aKeys.every(
					key =>
						Object.prototype.hasOwnProperty.call(b, key) &&
						rebaseDeepEqual(a[key], b[key])
				)
			)
		}
		return false
	}

	// Link incoming-mirror nodes of an inserted subtree to their
	// merged-mirror counterparts, so positions of incoming-inserted
	// elements stay trackable.
	function linkMirrorRefs(
		merged: RebaseMirrorNode,
		incoming: RebaseMirrorNode
	): void {
		if (merged.type === "array" && incoming.type === "array") {
			for (let i = 0; i < incoming.slots!.length; i++) {
				incoming.slots![i].ref = merged.slots![i]
				linkMirrorRefs(merged.slots![i], incoming.slots![i])
			}
		} else if (merged.type === "object" && incoming.type === "object") {
			incoming.children!.forEach((incChild, key) => {
				const mergedChild = merged.children!.get(key)
				if (mergedChild) linkMirrorRefs(mergedChild, incChild)
			})
		}
	}

	// Simulate the local patch sequence against base. The resulting
	// mirror doubles as the merged mirror, into which incoming
	// insertions are spliced.
	function simulateLocalPatch(
		root: RebaseMirrorNode,
		patch: Patch,
		index: number
	): void {
		const {path, op} = patch
		let node = root
		for (let i = 0; i < path.length; i++) {
			if (!node.localDesc) {
				node.localDesc = true
				node.localDescIndex = index
			}
			if (node.localEffect === 1) node.localEffectValue = rebaseDirtyValue
			const seg = path[i]
			const isLast = i === path.length - 1
			if (node.type === "array") {
				const slots = node.slots!
				if (isLast) {
					if (op === "add") {
						const at = rebaseArraySegment(seg)
						slots.splice(
							at === -1 ? slots.length : at,
							0,
							createMirrorNode(patch.value, -1)
						)
					} else if (op === "remove") {
						const idx = rebaseArraySegment(seg)
						const target = slots[idx]
						if (!target) throwRebasePath(path)
						if (target.orig !== -1) {
							if (!node.deletedByLocal) node.deletedByLocal = new Map()
							node.deletedByLocal.set(target.orig, index)
						}
						slots.splice(idx, 1)
					} else {
						const idx = rebaseArraySegment(seg)
						const target = slots[idx]
						if (!target) throwRebasePath(path)
						const fresh = createMirrorNode(patch.value, target.orig)
						fresh.localEffect = 1
						fresh.localEffectValue = patch.value
						fresh.localEffectIndex = index
						slots[idx] = fresh
					}
					return
				}
				const next = slots[rebaseArraySegment(seg)]
				if (!next) throwRebasePath(path)
				node = next
			} else if (node.type === "object") {
				const children = node.children!
				if (isLast) {
					if (op === "remove") {
						const target = children.get(seg)
						if (!target) throwRebasePath(path)
						target.localEffect = 2
						target.localEffectIndex = index
					} else {
						const existing = children.get(seg)
						const fresh = createMirrorNode(
							patch.value,
							existing ? existing.orig : -1
						)
						fresh.localEffect = 1
						fresh.localEffectValue = patch.value
						fresh.localEffectIndex = index
						children.set(seg, fresh)
					}
					return
				}
				const next = children.get(seg)
				if (!next) throwRebasePath(path)
				node = next
			} else {
				throwRebasePath(path)
			}
		}
		// Root-level patch (path.length === 0)
		if (op === "remove") {
			root.localEffect = 2
			root.localEffectIndex = index
		} else {
			root.localEffect = 1
			root.localEffectValue = patch.value
			root.localEffectIndex = index
		}
	}

	function rebasePatches_(
		base: any,
		localState: any,
		localPatches: readonly Patch[],
		incomingPatches: readonly Patch[]
	): RebaseResult {
		for (const p of localPatches) {
			assertRebasablePath(p.path)
			assertRebasableValue(p.value)
		}
		for (const p of incomingPatches) {
			assertRebasablePath(p.path)
			assertRebasableValue(p.value)
		}

		const localRoot = createMirrorNode(base, -1)
		const incomingRoot = createMirrorNode(base, -1)
		localPatches.forEach((patch, index) =>
			simulateLocalPatch(localRoot, patch, index)
		)

		const rebased: Patch[] = []
		const conflicts: RebaseConflict[] = []

		const addConflict = (
			localIndex: number,
			incomingIndex: number,
			path: PatchPath,
			reason: string
		): void => {
			conflicts.push({localIndex, incomingIndex, path, reason})
		}

		const emit = (op: Patch["op"], path: PatchPath, value?: any): void => {
			const patch: Patch = {op, path: path.slice()}
			if (value !== undefined) patch.value = deepClonePatchValue(value)
			rebased.push(patch)
		}

		// Rebuild a subtree in both mirrors after an incoming add/replace,
		// keeping incoming-inserted nodes linked to merged nodes.
		const rebuildMirrors = (
			value: any
		): [RebaseMirrorNode, RebaseMirrorNode] => {
			const mergedFresh = createMirrorNode(value, -1)
			const incFresh = createMirrorNode(value, -1)
			linkMirrorRefs(mergedFresh, incFresh)
			incFresh.ref = mergedFresh
			return [mergedFresh, incFresh]
		}

		const handleObjectFinal = (
			merged: RebaseMirrorNode,
			inc: RebaseMirrorNode,
			seg: string | number,
			patch: Patch,
			emitPath: PatchPath,
			basePath: PatchPath,
			incomingIndex: number
		): void => {
			const child = merged.children!.get(seg)
			const conflictPath = basePath.concat(seg)
			if (patch.op === REMOVE) {
				if (child) {
					if (child.localEffect === 2) return // duplicate removal
					if (child.localEffect === 1)
						return addConflict(
							child.localEffectIndex,
							incomingIndex,
							conflictPath,
							"delete-vs-modify"
						)
					if (child.localDesc)
						return addConflict(
							child.localDescIndex,
							incomingIndex,
							conflictPath,
							"delete-ancestor-vs-modify-descendant"
						)
				} else if (!inc.children!.has(seg)) throwRebasePath(patch.path)
				emit(REMOVE, emitPath.concat(seg))
				merged.children!.delete(seg)
				inc.children!.delete(seg)
				return
			}
			// replace or add
			if (child) {
				if (child.localEffect === 2)
					return addConflict(
						child.localEffectIndex,
						incomingIndex,
						conflictPath,
						"modify-vs-delete"
					)
				if (child.localEffect === 1) {
					if (rebaseDeepEqual(patch.value, child.localEffectValue)) return // duplicate: same replacement
					return addConflict(
						child.localEffectIndex,
						incomingIndex,
						conflictPath,
						"replace-vs-replace"
					)
				}
				if (child.localDesc)
					return addConflict(
						child.localDescIndex,
						incomingIndex,
						conflictPath,
						"replace-ancestor-vs-modify-descendant"
					)
			}
			emit(patch.op, emitPath.concat(seg), patch.value)
			const [mergedFresh, incFresh] = rebuildMirrors(patch.value)
			merged.children!.set(seg, mergedFresh)
			inc.children!.set(seg, incFresh)
		}

		const handleArrayFinal = (
			merged: RebaseMirrorNode,
			inc: RebaseMirrorNode,
			seg: string | number,
			patch: Patch,
			emitPath: PatchPath,
			basePath: PatchPath,
			incomingIndex: number
		): void => {
			const mslots = merged.slots!
			const islots = inc.slots!
			if (patch.op === ADD) {
				const at = rebaseArraySegment(seg)
				const insertAt = at === -1 ? islots.length : at
				let pos: number
				if (insertAt >= islots.length) {
					pos = mslots.length
				} else {
					const target = islots[insertAt]
					if (target.orig === -1) {
						pos = mslots.indexOf(target.ref!)
					} else {
						// Same-gap insertions: local elements stay first, so
						// insert before the first surviving base element with
						// orig >= target.orig.
						pos = mslots.length
						for (let j = 0; j < mslots.length; j++) {
							const o = mslots[j].orig
							if (o !== -1 && o >= target.orig) {
								pos = j
								break
							}
						}
					}
				}
				const [mergedFresh, incFresh] = rebuildMirrors(patch.value)
				mslots.splice(pos, 0, mergedFresh)
				islots.splice(insertAt, 0, incFresh)
				emit(ADD, emitPath.concat(pos), patch.value)
				return
			}
			const idx = rebaseArraySegment(seg)
			const target = islots[idx]
			if (!target) throwRebasePath(patch.path)
			if (target.orig === -1) {
				// Incoming's own inserted element: no local interaction.
				const mnode = target.ref!
				const pos = mslots.indexOf(mnode)
				if (patch.op === REMOVE) {
					emit(REMOVE, emitPath.concat(pos))
					mslots.splice(pos, 1)
					islots.splice(idx, 1)
				} else {
					emit(REPLACE, emitPath.concat(pos), patch.value)
					const [mergedFresh, incFresh] = rebuildMirrors(patch.value)
					mslots[pos] = mergedFresh
					islots[idx] = incFresh
				}
				return
			}
			const orig = target.orig
			const conflictPath = basePath.concat(orig)
			const mnode = mslots.find(s => s.orig === orig)
			if (!mnode) {
				if (patch.op === REMOVE) {
					// Both sides removed the same base element.
					islots.splice(idx, 1)
					return
				}
				return addConflict(
					merged.deletedByLocal?.get(orig) ?? -1,
					incomingIndex,
					conflictPath,
					"modify-deleted-element"
				)
			}
			if (patch.op === REMOVE) {
				if (mnode.localEffect === 1)
					return addConflict(
						mnode.localEffectIndex,
						incomingIndex,
						conflictPath,
						"delete-vs-modify"
					)
				if (mnode.localDesc)
					return addConflict(
						mnode.localDescIndex,
						incomingIndex,
						conflictPath,
						"delete-ancestor-vs-modify-descendant"
					)
				const pos = mslots.indexOf(mnode)
				emit(REMOVE, emitPath.concat(pos))
				mslots.splice(pos, 1)
				islots.splice(idx, 1)
				return
			}
			// replace
			if (mnode.localEffect === 1) {
				if (rebaseDeepEqual(patch.value, mnode.localEffectValue)) return // duplicate: same replacement
				return addConflict(
					mnode.localEffectIndex,
					incomingIndex,
					conflictPath,
					"replace-vs-replace"
				)
			}
			if (mnode.localDesc)
				return addConflict(
					mnode.localDescIndex,
					incomingIndex,
					conflictPath,
					"replace-ancestor-vs-modify-descendant"
				)
			const pos = mslots.indexOf(mnode)
			emit(REPLACE, emitPath.concat(pos), patch.value)
			const [mergedFresh, incFresh] = rebuildMirrors(patch.value)
			mslots[pos] = mergedFresh
			islots[idx] = incFresh
		}

		const routeIncoming = (patch: Patch, incomingIndex: number): void => {
			const {path, op} = patch
			let merged = localRoot
			let inc = incomingRoot
			const emitPath: PatchPath = []
			const basePath: PatchPath = []
			for (let i = 0; i < path.length; i++) {
				if (merged.localEffect !== 0) {
					// Local replaced/removed this ancestor; incoming
					// touches a descendant.
					const conflictSeg =
						merged.type === "array"
							? inc.slots![rebaseArraySegment(path[i])].orig
							: path[i]
					return addConflict(
						merged.localEffectIndex,
						incomingIndex,
						basePath.concat(conflictSeg),
						merged.localEffect === 2
							? "delete-ancestor-vs-modify-descendant"
							: "replace-ancestor-vs-modify-descendant"
					)
				}
				const seg = path[i]
				const isLast = i === path.length - 1
				if (merged.type === "array") {
					if (isLast)
						return handleArrayFinal(
							merged,
							inc,
							seg,
							patch,
							emitPath,
							basePath,
							incomingIndex
						)
					const target = inc.slots![rebaseArraySegment(seg)]
					if (!target) throwRebasePath(path)
					let next: RebaseMirrorNode | undefined
					if (target.orig === -1) {
						next = target.ref
						if (!next) throwRebasePath(path)
						basePath.push(seg)
					} else {
						next = merged.slots!.find(s => s.orig === target.orig)
						if (!next) {
							return addConflict(
								merged.deletedByLocal?.get(target.orig) ?? -1,
								incomingIndex,
								basePath.concat(target.orig),
								"modify-descendant-of-deleted-element"
							)
						}
						basePath.push(target.orig)
					}
					emitPath.push(merged.slots!.indexOf(next))
					merged = next
					inc = target
				} else if (merged.type === "object") {
					if (isLast)
						return handleObjectFinal(
							merged,
							inc,
							seg,
							patch,
							emitPath,
							basePath,
							incomingIndex
						)
					const next = merged.children!.get(seg)
					const incNext = inc.children!.get(seg)
					if (!next || !incNext) throwRebasePath(path)
					emitPath.push(seg)
					basePath.push(seg)
					merged = next
					inc = incNext
				} else {
					throwRebasePath(path)
				}
			}
			// Root-level patch (path.length === 0)
			if (localRoot.localEffect === 2)
				return addConflict(
					localRoot.localEffectIndex,
					incomingIndex,
					[],
					"modify-vs-delete"
				)
			if (localRoot.localEffect === 1) {
				if (
					op !== REMOVE &&
					rebaseDeepEqual(patch.value, localRoot.localEffectValue)
				)
					return // duplicate: same replacement
				return addConflict(
					localRoot.localEffectIndex,
					incomingIndex,
					[],
					"replace-vs-replace"
				)
			}
			if (localRoot.localDesc)
				return addConflict(
					localRoot.localDescIndex,
					incomingIndex,
					[],
					"replace-ancestor-vs-modify-descendant"
				)
			emit(op === REMOVE ? REMOVE : REPLACE, [], patch.value)
			if (op !== REMOVE) {
				const [mergedFresh, incFresh] = rebuildMirrors(patch.value)
				Object.assign(localRoot, mergedFresh)
				Object.assign(incomingRoot, incFresh)
			}
		}

		incomingPatches.forEach((patch, index) => {
			const before = conflicts.length
			try {
				routeIncoming(patch, index)
			} catch (e) {
				// Once a conflict was recorded for this patch, its path may
				// no longer resolve in the evolving mirrors; that is fine.
				if (conflicts.length === before) throw e
			}
		})

		if (conflicts.length > 0)
			return {patches: [], inversePatches: [], conflicts}

		// Compute exact inverse patches by replaying the rebased patches
		// on a plain clone of the local state.
		let sim = deepClonePatchValue(localState)
		const inversePatches: Patch[] = []
		for (const p of rebased) {
			inversePatches.unshift(invertRebasedPatch(sim, p))
			sim = applyPlainPatch(sim, p)
		}
		return {patches: rebased, inversePatches, conflicts: []}
	}

	function invertRebasedPatch(sim: any, p: Patch): Patch {
		const {path, op} = p
		if (path.length === 0)
			return {op: REPLACE, path: [], value: deepClonePatchValue(sim)}
		let parent = sim
		for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]]
		const key = path[path.length - 1]
		const exists =
			!isArray(parent) && Object.prototype.hasOwnProperty.call(parent, key)
		if (op === ADD) {
			if (isArray(parent)) return {op: REMOVE, path: path.slice()}
			if (exists)
				return {
					op: REPLACE,
					path: path.slice(),
					value: deepClonePatchValue(parent[key])
				}
			return {op: REMOVE, path: path.slice()}
		}
		if (op === REMOVE)
			return {
				op: ADD,
				path: path.slice(),
				value: deepClonePatchValue(parent[key as number])
			}
		if (!exists && !isArray(parent)) return {op: REMOVE, path: path.slice()}
		return {
			op: REPLACE,
			path: path.slice(),
			value: deepClonePatchValue(parent[key])
		}
	}

	function applyPlainPatch(sim: any, p: Patch): any {
		const {path, op} = p
		if (path.length === 0)
			return op === REMOVE ? undefined : deepClonePatchValue(p.value)
		let parent = sim
		for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]]
		const key = path[path.length - 1]
		if (op === ADD) {
			if (isArray(parent))
				parent.splice(
					key === "-" ? parent.length : (key as number),
					0,
					deepClonePatchValue(p.value)
				)
			else parent[key] = deepClonePatchValue(p.value)
		} else if (op === REMOVE) {
			if (isArray(parent)) parent.splice(key as number, 1)
			else delete parent[key]
		} else {
			parent[key] = deepClonePatchValue(p.value)
		}
		return sim
	}
}
