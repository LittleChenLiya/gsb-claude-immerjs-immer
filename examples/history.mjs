// Example: undo/redo history powered by Immer patches.
//
// Run it against the built bundle:
//   npm run build
//   node examples/history.mjs
import {createHistory, enablePatches} from "../dist/immer.mjs"

enablePatches()

const history = createHistory(
	{
		title: "shopping",
		nested: {count: 0},
		todos: [{id: 1, done: false}]
	},
	{capacity: 10}
)

// Each commit runs the recipe once and stores forward + inverse patches.
history.commit(draft => {
	draft.todos.push({id: 2, done: false})
	draft.nested.count = 1
})
history.commit(draft => {
	draft.todos[0].done = true
})
console.log("after 2 commits:", JSON.stringify(history.state))

history.undo()
console.log("after undo:    ", JSON.stringify(history.state))

history.redo()
console.log("after redo:    ", JSON.stringify(history.state))

// Undo, then commit a new change: the old redo branch is discarded.
history.undo()
history.commit(draft => {
	draft.title = "branch"
})
console.log("after branch:  ", JSON.stringify(history.state))
console.log("canRedo:", history.canRedo, "undoDepth:", history.undoDepth)

