/**
 * Example: print a safe audit copy of Immer patches.
 *
 * Run it with (no extra bundler needed):
 *
 *   npx vitest run __tests__/redact-audit-example.ts
 *
 * or execute directly with a TypeScript runner, e.g.:
 *
 *   npx tsx examples/audit-redaction/print-audit-copy.ts
 *
 * `redactPatches` returns a *detached copy* of the patches: the original
 * patches are not touched and can still be replayed with `applyPatches`,
 * while sensitive values in the copy are replaced with an explicit marker.
 */
import {
	produceWithPatches,
	applyPatches,
	redactPatches,
	enablePatches,
	Patch
} from "../../src/immer"

enablePatches()

// The rule set is application defined. Rules match path *segments*; a parent
// rule masks the whole value subtree below it.
const REDACTION_RULES = [
	{path: ["user", "token"], replacement: "[REDACTED]"},
	{path: ["credentials"], replacement: "[REDACTED]"}
] as const

export function buildAuditEntry(base: unknown, patches: readonly Patch[]) {
	const safePatches = redactPatches(patches, {rules: REDACTION_RULES})
	return {
		at: new Date(0).toISOString(),
		action: "update-user",
		// stringify is safe here: secrets are masked in the copy
		patches: safePatches.map(patch => ({
			op: patch.op,
			path: "/" + patch.path.join("/"),
			value: (patch as {value?: unknown}).value
		}))
	}
}

export function runAuditRedactionExample() {
	const base = {
		user: {name: "bob", token: "base-token"},
		visible: 1
	}

	const [next, patches] = produceWithPatches(base, draft => {
		draft.user.name = "alice"
		draft.user.token = "rotated-token"
		draft.visible = 2
	})

	const auditEntry = buildAuditEntry(base, patches)

	console.log("== audit log (safe to persist) ==")
	console.log(JSON.stringify(auditEntry, null, 2))

	// The masked value never appears in the audit copy...
	if (JSON.stringify(auditEntry).includes("rotated-token"))
		throw new Error("secret leaked into the audit copy")

	// ...but the original patches are untouched and still replay.
	if (JSON.stringify(applyPatches(base, patches)) !== JSON.stringify(next))
		throw new Error("original patches no longer replay to the next state")

	return {base, next, patches, auditEntry}
}
