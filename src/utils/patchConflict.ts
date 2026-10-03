import {Patch, PatchPath} from "../internal"

/**
 * The reason why two patches produced by two independent editors cannot be
 * safely merged into a single patch group.
 *
 * - `root-replace`: one group replaces the whole root state (path `[]`)
 *   while the other group touches a non-empty path. Applying both would
 *   discard the other group's changes.
 * - `ancestor-replace`: one patch replaces or removes an ancestor of the
 *   path the other patch modifies (e.g. one group replaces `profile`
 *   while the other modifies `profile.name`).
 * - `same-path`: both groups modify the exact same path.
 * - `array-index-shift`: an array add/remove in one group shifts the
 *   indices of the same array the other group modifies. Immer never
 *   assumes array mutations commute, so any add/remove on an array
 *   conservatively conflicts with every other index operation on that
 *   array.
 */
export type PatchConflictReason =
	| "root-replace"
	| "ancestor-replace"
	| "same-path"
	| "array-index-shift"

/**
 * A single conflict between two patches from two independently produced
 * patch groups. `aIndex` / `bIndex` are the positions of the conflicting
 * patches in the first / second group, so callers can trace the conflict
 * back to the exact patch.
 *
 * The analyzer never mutates the patches it inspects: the `aPath` /
 * `bPath` fields are copies of the patch paths, and patch `value` fields
 * are never read (they may be arbitrary values).
 */
export interface PatchConflict {
	/** Position of the conflicting patch in the first group */
	aIndex: number
	/** Position of the conflicting patch in the second group */
	bIndex: number
	reason: PatchConflictReason
	aOp: Patch["op"]
	bOp: Patch["op"]
	/** Copy of the path of the patch in the first group */
	aPath: PatchPath
	/** Copy of the path of the patch in the second group */
	bPath: PatchPath
}

const MUTATING_OPS: ReadonlySet<Patch["op"]> = new Set([
	"add",
	"remove",
	"replace"
])

const REASON_DESCRIPTIONS: Record<PatchConflictReason, string> = {
	"root-replace":
		"根节点被整组替换，与另一组的非空路径冲突 (root replace conflicts with a non-empty path of the other group)",
	"ancestor-replace":
		"祖先路径被替换或删除，子孙路径的修改不再可达 (ancestor replaced or removed, descendant path is unreachable)",
	"same-path": "同一路径被双方修改 (the same path is modified by both groups)",
	"array-index-shift":
		"数组增删导致下标位移，同数组的其他下标操作不再安全 (array add/remove shifts indices, other operations on the same array are not safe)"
}

/**
 * Compares two path segments without collapsing their types: a numeric
 * segment and a string segment must never be treated as the same key,
 * i.e. `0 !== "0"`.
 */
function sameSegment(x: PatchPath[number], y: PatchPath[number]): boolean {
	return typeof x === typeof y && x === y
}

function samePath(a: PatchPath, b: PatchPath): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (!sameSegment(a[i], b[i])) return false
	}
	return true
}

/** Returns true if `prefix` is a strict path prefix of `path`. */
function isStrictPrefix(prefix: PatchPath, path: PatchPath): boolean {
	if (prefix.length >= path.length) return false
	for (let i = 0; i < prefix.length; i++) {
		if (!sameSegment(prefix[i], path[i])) return false
	}
	return true
}

/**
 * Array indices are numeric segments (and the JSON-Patch `-` marker that
 * appends to an array). String segments such as `"0"` are object keys,
 * not array indices.
 */
function isArrayIndexSegment(segment: PatchPath[number]): boolean {
	return typeof segment === "number" || segment === "-"
}

function parentOf(path: PatchPath): PatchPath {
	return path.slice(0, -1)
}

function classifyPatchPair(a: Patch, b: Patch): PatchConflictReason | null {
	const aIsRoot = a.path.length === 0
	const bIsRoot = b.path.length === 0

	// Root replace: one group replaces the whole root state while the
	// other group touches anything below the root.
	if (aIsRoot || bIsRoot) {
		return aIsRoot && bIsRoot ? "same-path" : "root-replace"
	}

	// Exact same path: both editors modify the very same location.
	if (samePath(a.path, b.path)) return "same-path"

	// Ancestor coverage: one patch replaces/removes/adds an ancestor of
	// the path the other patch modifies.
	if (isStrictPrefix(a.path, b.path) && MUTATING_OPS.has(a.op)) {
		return "ancestor-replace"
	}
	if (isStrictPrefix(b.path, a.path) && MUTATING_OPS.has(b.op)) {
		return "ancestor-replace"
	}

	// Array index shift: an add/remove on an array conservatively
	// conflicts with every other index operation on the same array,
	// because index-based patches never commute.
	if (
		a.path.length > 0 &&
		b.path.length > 0 &&
		isArrayIndexSegment(a.path[a.path.length - 1]) &&
		isArrayIndexSegment(b.path[b.path.length - 1]) &&
		samePath(parentOf(a.path), parentOf(b.path)) &&
		(a.op === "add" || a.op === "remove" || b.op === "add" || b.op === "remove")
	) {
		return "array-index-shift"
	}

	// Disjoint paths: the two patches touch independent locations.
	return null
}

/**
 * Analyzes two patch groups produced by two independent editors (e.g. two
 * `produceWithPatches` calls) and returns every pair of patches that cannot
 * be safely merged into a single group, without applying anything to the
 * real state.
 *
 * The analysis is purely structural: it only inspects patch ops and paths.
 * It never reads the base state, never invokes getters, and never mutates
 * the passed-in patches.
 *
 * @example
 * ```ts
 * import {produceWithPatches, analyzePatchConflicts, formatPatchConflicts} from "immer"
 *
 * const base = {profile: {name: "Ada"}, settings: {theme: "light"}}
 *
 * // Two independent editors return their own patch groups:
 * const [, patchesA] = produceWithPatches(base, draft => {
 *   draft.profile.name = "Grace"
 * })
 * const [, patchesB] = produceWithPatches(base, draft => {
 *   draft.settings.theme = "dark"
 * })
 *
 * // Check whether the two groups can be merged before applying them:
 * const conflicts = analyzePatchConflicts(patchesA, patchesB)
 * if (conflicts.length > 0) {
 *   console.log(formatPatchConflicts(conflicts))
 * }
 * ```
 */
export function analyzePatchConflicts(
	groupA: readonly Patch[],
	groupB: readonly Patch[]
): PatchConflict[] {
	const conflicts: PatchConflict[] = []
	for (let i = 0; i < groupA.length; i++) {
		const patchA = groupA[i]
		for (let j = 0; j < groupB.length; j++) {
			const patchB = groupB[j]
			const reason = classifyPatchPair(patchA, patchB)
			if (reason !== null) {
				conflicts.push({
					aIndex: i,
					bIndex: j,
					reason,
					aOp: patchA.op,
					bOp: patchB.op,
					// Copy the paths so the caller can print them without the
					// analyzer ever mutating the original patches.
					aPath: patchA.path.slice(),
					bPath: patchB.path.slice()
				})
			}
		}
	}
	return conflicts
}

/**
 * Returns `true` if the two patch groups can safely be merged: none of the
 * patches in the first group conflicts with any patch in the second group.
 */
export function canMergePatchGroups(
	groupA: readonly Patch[],
	groupB: readonly Patch[]
): boolean {
	return analyzePatchConflicts(groupA, groupB).length === 0
}

/**
 * Renders a patch path for human consumption. The root path is rendered as
 * `[]`; string segments are quoted so that numeric `0` and string `"0"`
 * can never be confused.
 */
export function formatPatchPath(path: PatchPath): string {
	if (path.length === 0) return "[]"
	return (
		"/" +
		path
			.map(segment =>
				typeof segment === "number" ? String(segment) : JSON.stringify(segment)
			)
			.join("/")
	)
}

/**
 * Renders a list of patch conflicts as a printable, multi-line report.
 * Each conflict shows the positions of the two patches in their respective
 * groups, their ops, their paths, and the reason why they conflict.
 *
 * @example
 * ```ts
 * import {analyzePatchConflicts, formatPatchConflicts} from "immer"
 *
 * const conflicts = analyzePatchConflicts(editorAPatches, editorBPatches)
 * console.log(formatPatchConflicts(conflicts))
 * // 检测到 1 处补丁冲突，不能直接合并：
 * // (1 patch conflict(s) detected, the groups cannot be merged safely.)
 * //
 * //   [1] ancestor-replace — 祖先路径被替换或删除，子孙路径的修改不再可达
 * //       A 组 #0  replace  /"profile"
 * //       B 组 #0  replace  /"profile"/"name"
 * ```
 */
export function formatPatchConflicts(
	conflicts: readonly PatchConflict[]
): string {
	if (conflicts.length === 0) {
		return "未检测到补丁冲突，可以安全合并。(no patch conflicts detected, the groups can be merged safely.)"
	}
	const lines = [
		`检测到 ${conflicts.length} 处补丁冲突，不能直接合并：`,
		`(${conflicts.length} patch conflict(s) detected, the groups cannot be merged safely.)`,
		""
	]
	conflicts.forEach((conflict, index) => {
		lines.push(
			`  [${index + 1}] ${conflict.reason} — ${REASON_DESCRIPTIONS[conflict.reason]}`
		)
		lines.push(
			`      A 组 #${conflict.aIndex}  ${conflict.aOp}  ${formatPatchPath(conflict.aPath)}`
		)
		lines.push(
			`      B 组 #${conflict.bIndex}  ${conflict.bOp}  ${formatPatchPath(conflict.bPath)}`
		)
		lines.push("")
	})
	return lines.join("\n")
}
