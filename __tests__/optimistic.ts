import {createOptimistic} from "../src/immer"

interface State {
	value: number
	nested: {
		count: number
	}
	items: string[]
}

const base: State = {
	value: 0,
	nested: {count: 0},
	items: ["a"]
}

/** A controllable promise used to deterministically order async recipes. */
function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return {promise, resolve, reject}
}

it("publishes a successful commit and notifies with immutable old/new state and version", async () => {
	const container = createOptimistic(base)
	const events: {next: State; prev: State; version: number}[] = []
	container.subscribe((next, prev, version) => {
		events.push({next, prev, version})
	})

	const result = await container.submit(0, draft => {
		draft.value = 1
	})

	expect(result.status).toBe("committed")
	expect(result.version).toBe(1)
	expect(result.expectedVersion).toBe(0)
	expect(container.version).toBe(1)
	expect(container.state.value).toBe(1)
	expect(events).toHaveLength(1)
	expect(events[0].next.value).toBe(1)
	expect(events[0].prev.value).toBe(0)
	expect(events[0].version).toBe(1)
	// both states handed to subscribers are immutable
	expect(Object.isFrozen(events[0].next)).toBe(true)
	expect(Object.isFrozen(events[0].prev)).toBe(true)
})

it("rejects a stale recipe after an async gap and keeps the newer state", async () => {
	const container = createOptimistic(base)
	const first = deferred<void>()
	const second = deferred<void>()

	const p1 = container.submit(0, async draft => {
		await first.promise
		draft.value = 1
	})
	const p2 = container.submit(0, async draft => {
		await second.promise
		draft.value = 2
	})

	// Let the second recipe finish first: it publishes version 1.
	second.resolve()
	const r2 = await p2
	expect(r2.status).toBe("committed")
	expect(r2.version).toBe(1)
	expect(container.version).toBe(1)
	expect(container.state.value).toBe(2)

	// Now let the first recipe finish: it must receive a version conflict.
	first.resolve()
	const r1 = await p1
	expect(r1.status).toBe("conflict")
	expect(r1.version).toBe(1)
	expect(r1.expectedVersion).toBe(0)
	// The state stays the second result, the stale draft never overwrites it.
	expect(container.version).toBe(1)
	expect(container.state.value).toBe(2)
})

it("rejects immediately when the expected version is already outdated", async () => {
	const container = createOptimistic(base)
	await container.submit(0, draft => {
		draft.value = 1
	})

	let recipeRan = false
	const result = await container.submit(0, draft => {
		recipeRan = true
		draft.value = 2
	})

	expect(recipeRan).toBe(false)
	expect(result.status).toBe("conflict")
	expect(result.version).toBe(1)
	expect(container.state.value).toBe(1)
})

it("does not bump the version or notify when a recipe throws", async () => {
	const container = createOptimistic(base)
	const events: number[] = []
	container.subscribe((_next, _prev, version) => events.push(version))

	const error = new Error("recipe failure")
	const p = container.submit(0, async draft => {
		draft.value = 99
		throw error
	})

	await expect(p).rejects.toBe(error)
	expect(container.version).toBe(0)
	expect(container.state.value).toBe(0)
	expect(events).toEqual([])
})

it("notifies subscribers only on successful commits with changes", async () => {
	const container = createOptimistic(base)
	const events: [number, number, number][] = []
	container.subscribe((next, prev, version) => {
		events.push([next.value, prev.value, version])
	})

	await container.submit(0, draft => {
		draft.value = 1
	})
	expect(events).toEqual([[1, 0, 1]])

	// A conflict does not notify.
	const stale = deferred<void>()
	const pStale = container.submit(1, async draft => {
		await stale.promise
		draft.value = 2
	})
	await container.submit(1, draft => {
		draft.value = 3
	})
	stale.resolve()
	const rStale = await pStale
	expect(rStale.status).toBe("conflict")
	expect(events).toEqual([
		[1, 0, 1],
		[3, 1, 2]
	])

	// A throwing recipe does not notify.
	const pThrow = container.submit(2, draft => {
		draft.value = 99
		throw new Error("boom")
	})
	await expect(pThrow).rejects.toThrow("boom")
	expect(events).toEqual([
		[1, 0, 1],
		[3, 1, 2]
	])
})

it("stops notifying after unsubscribe", async () => {
	const container = createOptimistic(base)
	const events: number[] = []
	const unsubscribe = container.subscribe((_next, _prev, version) => {
		events.push(version)
	})

	await container.submit(0, draft => {
		draft.value = 1
	})
	expect(events).toEqual([1])

	unsubscribe()
	await container.submit(1, draft => {
		draft.value = 2
	})
	expect(events).toEqual([1])
})

it("treats a no-change recipe as committed without bumping version or notifying", async () => {
	const container = createOptimistic(base)
	const events: number[] = []
	container.subscribe((_next, _prev, version) => events.push(version))

	const result = await container.submit(0, draft => {
		// Reads only, no mutations.
		void draft.value
	})

	expect(result.status).toBe("committed")
	expect(result.version).toBe(0)
	expect(container.version).toBe(0)
	expect(container.state).toBe(base)
	expect(events).toEqual([])
})

it("preserves structural sharing and freezing", async () => {
	const container = createOptimistic(base)

	// The initial state is already frozen for subscribers.
	expect(Object.isFrozen(container.state)).toBe(true)

	await container.submit(0, draft => {
		draft.value = 1
	})

	// The changed part is a new frozen copy.
	expect(container.state.value).toBe(1)
	expect(Object.isFrozen(container.state)).toBe(true)
	// Unchanged parts keep their reference and are frozen.
	expect(container.state.nested).toBe(base.nested)
	expect(container.state.items).toBe(base.items)
	expect(Object.isFrozen(container.state.nested)).toBe(true)
	expect(Object.isFrozen(container.state.items)).toBe(true)
})

it("keeps incrementing the version across multiple commits", async () => {
	const container = createOptimistic(base)
	const seen: number[] = []
	container.subscribe((_next, _prev, version) => seen.push(version))

	for (let i = 1; i <= 3; i++) {
		const result = await container.submit(container.version, draft => {
			draft.value = i
		})
		expect(result.status).toBe("committed")
		expect(result.version).toBe(i)
		expect(container.version).toBe(i)
	}

	expect(container.state.value).toBe(3)
	expect(seen).toEqual([1, 2, 3])
})

it("gives a conflict result carrying the newer state and version", async () => {
	const container = createOptimistic(base)
	await container.submit(0, draft => {
		draft.nested.count = 5
	})

	const result = await container.submit(0, draft => {
		draft.value = 99
	})

	expect(result.status).toBe("conflict")
	expect(result.version).toBe(1)
	expect(result.expectedVersion).toBe(0)
	expect(result.state).toBe(container.state)
	expect(result.state.nested.count).toBe(5)
})
