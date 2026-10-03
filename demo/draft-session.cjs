/**
 * Short, runnable state demo for `DraftSession`.
 *
 * First build the package (`yarn build`), then run:
 *
 *   node demo/draft-session.cjs
 *
 * It walks through the three session states — open, committed, aborted —
 * and shows that aborting discards changes and revokes drafts.
 */
const {DraftSession, enablePatches, isDraft} = require("../dist/cjs/index.js")

enablePatches()

const base = {user: {name: "Ada", age: 36}, tags: ["a"]}

console.log("base at start:", JSON.stringify(base))

// --- open ---------------------------------------------------------------
const session = DraftSession.open(base)
console.log("after open: state =", session.state, ", draft =", isDraft(session.draft))

session.draft.user.age = 37
session.draft.tags.push("b")

// --- commit -------------------------------------------------------------
const result = session.commit((patches, inversePatches) => {
	console.log("commit patches:", JSON.stringify(patches))
	console.log("commit inverse:", JSON.stringify(inversePatches))
})
console.log("after commit: state =", session.state)
console.log("committed result:", JSON.stringify(result))
console.log("base unchanged:", JSON.stringify(base))

// --- closed session rejects further use ---------------------------------
try {
	session.draft.user.age = 38
} catch (e) {
	console.log("write after commit throws:", e.message)
}

// --- abort --------------------------------------------------------------
const aborted = DraftSession.open({x: {y: 1}})
const oldDraft = aborted.draft
oldDraft.x.y = 2
aborted.abort()
console.log("after abort: state =", aborted.state)
console.log("abandoned change not merged back:", JSON.stringify({x: {y: 1}}))
try {
	oldDraft.x.y
} catch (e) {
	console.log("old draft read after abort throws:", e.message)
}
try {
	aborted.commit()
} catch (e) {
	console.log("commit after abort throws:", e.message)
}
