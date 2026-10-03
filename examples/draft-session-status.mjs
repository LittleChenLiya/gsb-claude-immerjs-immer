// Short status demo for draft sessions.
// Run after building:  npm run build && node examples/draft-session-status.mjs
import {createDraftSession, enablePatches} from "../dist/immer.mjs"

enablePatches()

const show = (label, value) => console.log(label.padEnd(28), value)

// 1. open -> committed
const base = {user: {name: "ada", address: {city: "x"}}}
const session = createDraftSession(base)
show("fresh session:", session.status)

session.draft.user.address.city = "y"
const {result, patches, inversePatches} = session.commit()
show("after commit:", session.status)
show("result city:", result.user.address.city)
show("base city (untouched):", base.user.address.city)
show("patches:", JSON.stringify(patches))
show("inversePatches:", JSON.stringify(inversePatches))

try {
	session.commit()
} catch (e) {
	show("second commit:", e.message)
}

// 2. open -> aborted
const session2 = createDraftSession({count: 1})
const staleDraft = session2.draft
staleDraft.count = 99
session2.abort()
show("after abort:", session2.status)
try {
	staleDraft.count
} catch (e) {
	show("stale draft read:", e.message)
}

// 3. a throwing commit callback still closes the session
const session3 = createDraftSession({n: 1})
session3.draft.n = 2
try {
	session3.commit(() => {
		throw new Error("listener boom")
	})
} catch (e) {
	show("commit listener threw:", e.message)
}
show("session after failure:", session3.status)
