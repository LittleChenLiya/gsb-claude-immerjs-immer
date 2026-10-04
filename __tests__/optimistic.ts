import {
	createOptimisticContainer,
	VersionConflictError,
	OptimisticNotification
} from "../src/immer"

interface Todo {
	id: number
	title: string
	done: boolean
}

interface State {
	todos: Todo[]
	meta: {updatedBy: string | null}
}

const baseState = (): State => ({
	todos: [
		{id: 1, title: "one", done: false},
		{id: 2, title: "two", done: false}
	],
	meta: {updatedBy: null}
})

/** A promise whose resolution is controlled by the test. */
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: any) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return {promise, resolve, reject}
}

describe("createOptimisticContainer", () => {
	it("rejects a stale recipe once a concurrent commit has published a newer version", async () => {
		const container = createOptimisticContainer(baseState())
		const notifications: OptimisticNotification<State>[] = []
		container.subscribe(n => notifications.push(n))

		expect(container.getState().version).toBe(0)

		const gateFirst = deferred()
		const gateSecond = deferred()

		// Both recipes start from version 0.
		const first = container.commit(0, async draft => {
			await gateFirst.promise
			draft.meta.updatedBy = "first"
		})
		const second = container.commit(0, async draft => {
			await gateSecond.promise
			draft.meta.updatedBy = "second"
		})

		// The second recipe completes first and publishes version 1.
		gateSecond.resolve()
		const published = await second
		expect(published.version).toBe(1)
		expect(published.state.meta.updatedBy).toBe("second")
		expect(container.getState().version).toBe(1)

		// The first (now stale) recipe completes afterwards and must be
		// rejected with a version conflict.
		gateFirst.resolve()
		await expect(first).rejects.toBeInstanceOf(VersionConflictError)
		await expect(first).rejects.toMatchObject({
			expectedVersion: 0,
			actualVersion: 1
		})

		// The old draft must not overwrite the newer state.
		expect(container.getState().version).toBe(1)
		expect(container.getState().state.meta.updatedBy).toBe("second")

		// Only the successful commit notified subscribers.
		expect(notifications).toHaveLength(1)
		expect(notifications[0].version).toBe(1)
		expect(notifications[0].previousVersion).toBe(0)
		expect(notifications[0].state.meta.updatedBy).toBe("second")
		expect(notifications[0].previousState.meta.updatedBy).toBeNull()
	})

	it("does not bump the version or notify when a recipe throws", async () => {
		const container = createOptimisticContainer(baseState())
		let calls = 0
		container.subscribe(() => calls++)

		const boom = new Error("boom")
		await expect(
			container.commit(0, draft => {
				draft.meta.updatedBy = "broken"
				throw boom
			})
		).rejects.toBe(boom)

		expect(container.getState().version).toBe(0)
		expect(container.getState().state.meta.updatedBy).toBeNull()
		expect(calls).toBe(0)

		// The container stays usable at the same version.
		const next = await container.commit(0, draft => {
			draft.meta.updatedBy = "recovered"
		})
		expect(next.version).toBe(1)
		expect(calls).toBe(1)
	})

	it("does not bump the version or notify when an async recipe rejects", async () => {
		const container = createOptimisticContainer(baseState())
		let calls = 0
		container.subscribe(() => calls++)

		const gate = deferred()
		const boom = new Error("async boom")
		const pending = container.commit(0, async draft => {
			draft.meta.updatedBy = "broken"
			await gate.promise
			throw boom
		})
		// Attach the rejection expectation before releasing the gate.
		const assertion = expect(pending).rejects.toBe(boom)
		gate.resolve()
		await assertion

		expect(container.getState().version).toBe(0)
		expect(container.getState().state.meta.updatedBy).toBeNull()
		expect(calls).toBe(0)
	})

	it("treats a no-change commit as a successful no-op", async () => {
		const container = createOptimisticContainer(baseState())
		let calls = 0
		container.subscribe(() => calls++)

		const before = container.getState()
		const result = await container.commit(0, draft => {
			// Assign the values the state already has: no effective change.
			draft.meta.updatedBy = null
			draft.todos[0].done = false
		})

		// Convention: success, but no version bump, no notification and the
		// very same (structurally shared) state reference.
		expect(result.version).toBe(0)
		expect(result.state).toBe(before.state)
		expect(container.getState().version).toBe(0)
		expect(calls).toBe(0)
	})

	it("preserves structural sharing between committed versions", async () => {
		const container = createOptimisticContainer(baseState())
		const v0 = container.getState().state

		const {state: v1} = await container.commit(0, draft => {
			draft.todos[0].done = true
		})

		expect(v1).not.toBe(v0)
		expect(v1.todos).not.toBe(v0.todos)
		expect(v1.todos[0]).not.toBe(v0.todos[0])
		// Untouched branches keep their identity.
		expect(v1.todos[1]).toBe(v0.todos[1])
		expect(v1.meta).toBe(v0.meta)
	})

	it("exposes frozen, immutable states to subscribers and readers", async () => {
		const container = createOptimisticContainer(baseState())

		// The initial state is frozen from version 0 on.
		expect(Object.isFrozen(container.getState().state)).toBe(true)
		expect(Object.isFrozen(container.getState().state.todos)).toBe(true)

		let seen: OptimisticNotification<State> | undefined
		container.subscribe(n => {
			seen = n
		})
		await container.commit(0, draft => {
			draft.todos.push({id: 3, title: "three", done: false})
		})

		expect(seen).toBeDefined()
		expect(Object.isFrozen(seen!.state)).toBe(true)
		expect(Object.isFrozen(seen!.state.todos)).toBe(true)
		expect(Object.isFrozen(seen!.state.todos[2])).toBe(true)
		expect(Object.isFrozen(seen!.previousState)).toBe(true)
		expect(Object.isFrozen(seen!.previousState.todos)).toBe(true)
		// ES modules run in strict mode: mutating frozen state throws.
		expect(() => {
			;(seen!.state.meta as any).updatedBy = "nope"
		}).toThrow()
	})

	it("rejects immediately when the expected version is already stale", async () => {
		const container = createOptimisticContainer(baseState())
		let calls = 0
		container.subscribe(() => calls++)

		await container.commit(0, draft => {
			draft.meta.updatedBy = "a"
		})

		await expect(container.commit(0, () => {})).rejects.toBeInstanceOf(
			VersionConflictError
		)
		await expect(container.commit(5, () => {})).rejects.toMatchObject({
			expectedVersion: 5,
			actualVersion: 1
		})
		expect(container.getState().version).toBe(1)
		expect(calls).toBe(1)
	})

	it("notifies each subscriber exactly once per successful commit and supports unsubscribe", async () => {
		const container = createOptimisticContainer(baseState())
		const a: OptimisticNotification<State>[] = []
		const b: OptimisticNotification<State>[] = []
		const unsubscribeA = container.subscribe(n => a.push(n))
		container.subscribe(n => b.push(n))

		await container.commit(0, draft => {
			draft.meta.updatedBy = "one"
		})
		unsubscribeA()
		await container.commit(1, draft => {
			draft.meta.updatedBy = "two"
		})

		expect(a).toHaveLength(1)
		expect(b).toHaveLength(2)
		expect(b[0].version).toBe(1)
		expect(b[1].version).toBe(2)
		expect(b[1].previousVersion).toBe(1)
		expect(b[1].previousState.meta.updatedBy).toBe("one")
		expect(b[1].state.meta.updatedBy).toBe("two")
		// The versions form a gapless sequence: only successes increment.
		expect(container.getState().version).toBe(2)
	})
})
