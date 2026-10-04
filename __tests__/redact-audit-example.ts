import {describe, test, expect} from "vitest"
import {
	runAuditRedactionExample,
	buildAuditEntry
} from "../examples/audit-redaction/print-audit-copy"

describe("audit redaction example", () => {
	test("prints a safe audit copy while originals still replay", () => {
		const {base, next, patches, auditEntry} = runAuditRedactionExample()

		// log the audit copy to the test reporter, demonstrating the example
		console.log("AUDIT COPY:\n" + JSON.stringify(auditEntry, null, 2))

		// /user/token is masked, /user/name is preserved
		const tokenEntry = auditEntry.patches.find(p => p.path === "/user/token")
		const nameEntry = auditEntry.patches.find(p => p.path === "/user/name")
		expect(tokenEntry?.value).toBe("[REDACTED]")
		expect(nameEntry?.value).toBe("alice")
		expect(JSON.stringify(auditEntry)).not.toContain("rotated-token")

		// original patches were not mutated
		const originalTokenPatch = patches.find(
			p => p.path.join("/") === "user/token"
		)
		expect(originalTokenPatch?.value).toBe("rotated-token")
		expect(JSON.stringify(patches)).toContain("rotated-token")
		void base
		void next
	})

	test("buildAuditEntry masks a parent subtree", () => {
		const entry = buildAuditEntry(null, [
			{
				op: "replace",
				path: ["credentials"],
				value: {password: "hunter2", token: "t"}
			}
		])
		expect(entry.patches[0]).toEqual({
			op: "replace",
			path: "/credentials",
			value: "[REDACTED]"
		})
		expect(JSON.stringify(entry)).not.toContain("hunter2")
	})
})
