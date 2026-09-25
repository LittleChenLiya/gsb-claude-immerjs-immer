// Example: standalone undo/redo history built on Immer patches.
//
// Run with:
//   yarn build && node examples/history.mjs
//
// The history component is exported separately from the package and does
// not change the behavior of the default produce export.
import {createHistory} from "immer"

const history = createHistory(
	{
		todos: [{id: 1, title: "buy milk", done: false}],
		meta: {owner: "alice", settings: {theme: "light"}}
	},
	{capacity: 10} // caller-controlled history capacity
)

// Each commit runs the recipe once and stores its patches + inverse patches.
history.commit(draft => {
	draft.todos.push({id: 2, title: "write docs", done: false})
	draft.meta.settings.theme = "dark"
})
console.log("after commit #1:", history.state.meta.settings.theme) // "dark"

history.commit(draft => {
	draft.todos[0].done = true
})
console.log("after commit #2:", history.state.todos[0].done) // true

history.undo()
console.log("after undo:", history.state.todos[0].done) // false

history.redo()
console.log("after redo:", history.state.todos[0].done) // true

// Undo, then commit a diverging change: the old redo branch is discarded.
history.undo()
history.commit(draft => {
	draft.meta.owner = "bob"
})
console.log("canRedo after new branch:", history.canRedo) // false
console.log("final owner:", history.state.meta.owner) // "bob"
