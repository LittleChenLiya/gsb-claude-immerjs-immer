import type {Patch} from "./types/types-external"

/**
 * Classification of why two patches cannot be merged blindly.
 *
 * - {@link PatchConflictReason.SamePath}: both patches touch the exact same
 *   location, compared with strict equality (including segment type).
 * - {@link PatchConflictReason.AncestorOverride}: one patch replaces or
 *   removes an ancestor object (or the root, path `[]`) that contains the
 *   location of the other patch, so the other edit would be overwritten or
 *   shadowed.
 * - {@link PatchConflictReason.ArrayIndexShift}: one patch adds or removes an
 *   index of an array, and the other patch touches another index of that
 *   *same* array. Insertions and deletions shift subsequent indices, so such
 *   pairs are reported conservatively even if the concrete indices might
 *   happen to commute.
 *
 * Path segments are compared by strict equality, meaning the numeric segment
 * `2` is never treated as the same key as the string segment `"2"`. JSON
 * pointer style strings are not used: segments keep their original type.
 */
export const PatchConflictReason = {
	SamePath: "same-path",
	AncestorOverride: "ancestor-override",
	ArrayIndexShift: "array-index-shift"
} as const

export type PatchConflictReason =
	(typeof PatchConflictReason)[keyof typeof PatchConflictReason]

/**
 * Location of a single patch inside one of the two analyzed patch groups.
 */
export interface PatchLocation {
	/**
	 * Which group the patch belongs to: `"a"` for the first argument of
	 * {@link analyzePatchConflicts}, `"b"` for the second one.
	 */
	group: "a" | "b"
	/** Zero-based index of the patch inside its group patch array. */
	index: number
	/** The patch itself, as passed in by the caller (never modified). */
	patch: Patch
}

/**
 * A single conflict found between one patch of group `a` and one patch of
 * group `b`.
 */
export interface PatchConflict {
	reason: PatchConflictReason
	/** Human-readable, deterministic description of the conflict. */
	message: string
	a: PatchLocation
	b: PatchLocation
}

/**
 * Result of {@link analyzePatchConflicts}. The analysis does not apply the
 * patches to any state, does not mutate the input patches and does not read
 * any getters; it only inspects patch operations and paths.
 */
export interface PatchConflictReport {
	/** True when no conflicts were detected, i.e. merging is considered safe. */
	canMerge: boolean
	/** Every detected conflict, in deterministic order. */
	conflicts: PatchConflict[]
}

/**
 * Operations that insert or remove an array index and therefore shift the
 * indices around them.
 */
const STRUCTURAL_ARRAY_OPS: ReadonlySet<Patch["op"]> = new Set([
	"add",
	"remove"
])

function formatPath(path: ReadonlyArray<string | number>): string {
	return JSON.stringify(path)
}

/**
 * Return whether every segment of the shorter path equals the corresponding
 * segment of the longer path using strict equality. A numeric segment and a
 * string segment with the same textual value are therefore *not* considered
 * equal.
 */
function isTypeStrictPrefix(
	shorter: ReadonlyArray<string | number>,
	longer: ReadonlyArray<string | number>
): boolean {
	if (shorter.length >= longer.length) {
		return false
	}
	for (let i = 0; i < shorter.length; i++) {
		if (shorter[i] !== longer[i]) {
			return false
		}
	}
	return true
}

/**
 * Find the first index at which two paths differ, comparing segments with
 * strict equality. Returns the length of the shorter path when one is a
 * type-strict prefix of the other, or when they are identical.
 */
function firstDivergingSegment(
	pathA: ReadonlyArray<string | number>,
	pathB: ReadonlyArray<string | number>
): number {
	const limit = Math.min(pathA.length, pathB.length)
	for (let i = 0; i < limit; i++) {
		if (pathA[i] !== pathB[i]) {
			return i
		}
	}
	return limit
}

/**
 * Classify one pair of patches from different groups. Returns `null` when the
 * two patches touch disjoint locations and are treated as independent.
 */
function classifyPair(
	patchA: Patch,
	patchB: Patch
): PatchConflictReason | null {
	const pathA = patchA.path
	const pathB = patchB.path

	// Exact same path: both edits target one and the same location.
	if (
		pathA.length === pathB.length &&
		firstDivergingSegment(pathA, pathB) === pathA.length
	) {
		return PatchConflictReason.SamePath
	}

	// One path is a type-strict ancestor of the other. A replace/remove on
	// an ancestor (root included: path []) discards or shadows descendants.
	if (isTypeStrictPrefix(pathA, pathB) || isTypeStrictPrefix(pathB, pathA)) {
		return PatchConflictReason.AncestorOverride
	}

	// Sibling paths: locate their first diverging segment.
	const divergence = firstDivergingSegment(pathA, pathB)
	const divergingA = pathA[divergence]
	const divergingB = pathB[divergence]

	// Numeric and string segments are different keys, so e.g. ["list", "0"]
	// (object property named "0") and ["list", 0] (array index 0) are
	// disjoint; the same goes for diverging segment types below.
	if (typeof divergingA === "number" && typeof divergingB === "number") {
		// Conservative array rule: as soon as one patch structurally
		// adds/removes an index of this array (its path ends exactly at that
		// index), every other-group path reaching the same array through a
		// different numeric index is reported as a conflict — including deep
		// edits such as remove [items, 0] vs replace [items, 2, "name"],
		// which is how Immer records "modify element 2". Surrounding indices
		// may have shifted, so commutativity is never assumed. Two plain
		// element edits without an add/remove do not shift anything.
		const aStructural =
			STRUCTURAL_ARRAY_OPS.has(patchA.op) && pathA.length === divergence + 1
		const bStructural =
			STRUCTURAL_ARRAY_OPS.has(patchB.op) && pathB.length === divergence + 1
		if (aStructural || bStructural) {
			return PatchConflictReason.ArrayIndexShift
		}
	}

	// Disjoint object paths (or diverging segment types): independent.
	return null
}

function buildMessage(
	reason: PatchConflictReason,
	patchA: Patch,
	patchB: Patch
): string {
	const pathA = formatPath(patchA.path)
	const pathB = formatPath(patchB.path)
	switch (reason) {
		case PatchConflictReason.SamePath:
			return `both groups modify the same path ${pathA}`
		case PatchConflictReason.AncestorOverride:
			if (patchA.path.length === 0 || patchB.path.length === 0) {
				const rootPatch = patchA.path.length === 0 ? patchA : patchB
				const otherPath = patchA.path.length === 0 ? pathB : pathA
				return `root ${rootPatch.op} at [] conflicts with non-empty path ${otherPath}`
			}
			return `one patch overrides the ancestor path of the other: ${pathA} vs ${pathB}`
		case PatchConflictReason.ArrayIndexShift:
			return `array add/remove shifts indices of the same array: ${pathA} vs ${pathB}`
	}
}

/**
 * Analyze whether two independent groups of Immer patches can be safely merged
 * without applying them to the real state first.
 *
 * The analyzer distinguishes four situations:
 *
 * 1. **Disjoint object paths** — safe, no conflict is reported.
 * 2. **Ancestor override** — one patch replaces/removes an ancestor object
 *    (including the root via path `[]`) of the other patch path.
 * 3. **Same-path modification** — both patches target the exact same path.
 * 4. **Array index shift** — one patch adds/removes an array index while the
 *    other touches another index of the same array; these are reported
 *    conservatively, they are never assumed to commute.
 *
 * Rules:
 * - Numeric path segments and string path segments never share a key
 *   (`["a", 0]` and `["a", "0"]` are disjoint).
 * - A root `replace` (path `[]`) conflicts with every non-empty patch of the
 *   other group.
 * - Empty groups never produce conflicts.
 * - Only pairs *across* the two groups are analyzed; patches within one group
 *   are assumed to describe one coherent edit.
 * - The input patches are never mutated, and no getters or draft state are
 *   read; only `op` and `path` are inspected.
 *
 * @param patchesA patches produced by the first independent editor
 * @param patchesB patches produced by the second independent editor
 */
export function analyzePatchConflicts(
	patchesA: ReadonlyArray<Patch>,
	patchesB: ReadonlyArray<Patch>
): PatchConflictReport {
	const conflicts: PatchConflict[] = []
	for (let indexA = 0; indexA < patchesA.length; indexA++) {
		const patchA = patchesA[indexA]
		for (let indexB = 0; indexB < patchesB.length; indexB++) {
			const patchB = patchesB[indexB]
			const reason = classifyPair(patchA, patchB)
			if (reason !== null) {
				conflicts.push({
					reason,
					message: buildMessage(reason, patchA, patchB),
					a: {group: "a", index: indexA, patch: patchA},
					b: {group: "b", index: indexB, patch: patchB}
				})
			}
		}
	}
	return {
		canMerge: conflicts.length === 0,
		conflicts
	}
}

/**
 * Convenience predicate: returns true when two patch groups have no conflict
 * and can be merged safely.
 */
export function canMergePatches(
	patchesA: ReadonlyArray<Patch>,
	patchesB: ReadonlyArray<Patch>
): boolean {
	return analyzePatchConflicts(patchesA, patchesB).canMerge
}

/**
 * Render a conflict report as a printable list of lines, one conflict per
 * line, prefixed with the positions of both patches and the conflict reason.
 */
export function formatPatchConflicts(report: PatchConflictReport): string {
	if (report.conflicts.length === 0) {
		return "No patch conflicts detected; the groups can be merged safely."
	}
	return report.conflicts
		.map(conflict => {
			const a = conflict.a
			const b = conflict.b
			return (
				`[${conflict.reason}] ` +
				`a[${a.index}] ${a.patch.op} ${formatPath(a.patch.path)} ` +
				`<-> b[${b.index}] ${b.patch.op} ${formatPath(
					b.patch.path
				)}: ${conflict.message}`
			)
		})
		.join("\n")
}
