import {collectReads, ReadAccess} from "../src/immer"

function findAccess(
	accesses: ReadAccess[],
	type: ReadAccess["type"],
	path: PropertyKey[]
) {
	return accesses.find(
		a =>
			a.type === type &&
			a.path.length === path.length &&
			a.path.every((key, i) => Object.is(key, path[i]))
	)
}

describe("collectReads", () => {
	const base = {
		user: {name: "Alice", age: 30},
		items: [{id: 1}, {id: 2}],
		settings: {dark: true}
	}

	it("distinguishes get / has / ownKeys / length / iterate", () => {
		const {result, accesses} = collectReads(base, state => {
			const name = state.user.name // get
			const hasTheme = "theme" in state // has
			const keys = Object.keys(state.settings) // ownKeys
			const count = state.items.length // length
			const ids: number[] = []
			for (const item of state.items) {
				// iterate
				ids.push(item.id)
			}
			return {name, hasTheme, keys, count, ids}
		})

		expect(result).toEqual({
			name: "Alice",
			hasTheme: false,
			keys: ["dark"],
			count: 2,
			ids: [1, 2]
		})

		// property reads
		expect(findAccess(accesses, "get", ["user"])).toBeTruthy()
		expect(findAccess(accesses, "get", ["user", "name"])).toBeTruthy()
		// has check
		expect(findAccess(accesses, "has", ["theme"])).toBeTruthy()
		// key enumeration
		expect(findAccess(accesses, "ownKeys", ["settings"])).toBeTruthy()
		// array length
		expect(findAccess(accesses, "length", ["items"])).toBeTruthy()
		// array iteration
		expect(findAccess(accesses, "iterate", ["items"])).toBeTruthy()
		// nested reads during iteration
		expect(findAccess(accesses, "get", ["items", 0, "id"])).toBeTruthy()
		expect(findAccess(accesses, "get", ["items", 1, "id"])).toBeTruthy()

		// the distinct operation kinds must not be conflated
		expect(findAccess(accesses, "get", ["items", "length"])).toBeFalsy()
		expect(findAccess(accesses, "get", ["theme"])).toBeFalsy()
		expect(findAccess(accesses, "get", ["settings"])).toBeTruthy() // read to enumerate
		expect(findAccess(accesses, "ownKeys", ["items"])).toBeFalsy()
	})

	it("records repeated reads of the same path only once", () => {
		const {accesses} = collectReads(base, state => {
			const a = state.user.name
			const b = state.user.name
			return a + b
		})
		const nameReads = accesses.filter(
			a => a.type === "get" && a.path.join(".") === "user.name"
		)
		expect(nameReads).toHaveLength(1)
	})

	it("tracks symbol keys", () => {
		const sym = Symbol("secret")
		const symBase = {[sym]: {deep: 1}, plain: 2}
		const {result, accesses} = collectReads(symBase, state => {
			return state[sym].deep
		})
		expect(result).toBe(1)
		expect(findAccess(accesses, "get", [sym])).toBeTruthy()
		expect(findAccess(accesses, "get", [sym, "deep"])).toBeTruthy()
		expect(findAccess(accesses, "get", ["plain"])).toBeFalsy()
	})

	it("propagates errors thrown by getters", () => {
		const throwingBase = {
			ok: 1,
			get boom(): number {
				throw new Error("getter exploded")
			}
		}
		expect(() =>
			collectReads(throwingBase, state => state.boom)
		).toThrowError("getter exploded")
	})

	it("does not record branches that were not executed", () => {
		const {accesses} = collectReads(base, state => {
			if (false as boolean) {
				return state.user.age
			}
			return state.user.name
		})
		expect(findAccess(accesses, "get", ["user", "age"])).toBeFalsy()
		expect(findAccess(accesses, "get", ["user", "name"])).toBeTruthy()
	})

	it("throws when the tracked state is modified", () => {
		expect(() =>
			collectReads(base, state => {
				;(state.user as any).name = "Bob"
			})
		).toThrowError(/read-only/)
		expect(() =>
			collectReads(base, state => {
				delete (state as any).settings
			})
		).toThrowError(/read-only/)
		// base state is untouched
		expect(base.user.name).toBe("Alice")
		expect(base.settings).toEqual({dark: true})
	})

	it("revokes proxies leaked from the reader", () => {
		const leaked: any[] = []
		collectReads(base, state => {
			leaked.push(state.user)
			leaked.push(state.items)
		})
		expect(() => leaked[0].name).toThrow()
		expect(() => leaked[1].length).toThrow()

		// returning a tracked value leaks it as well
		const {result} = collectReads(base, state => state.user)
		expect(() => (result as any).name).toThrow()
	})

	it("records iterating array methods as iteration", () => {
		const {result, accesses} = collectReads(base, state =>
			state.items.map(item => item.id)
		)
		expect(result).toEqual([1, 2])
		expect(findAccess(accesses, "iterate", ["items"])).toBeTruthy()
		expect(findAccess(accesses, "get", ["items", 0, "id"])).toBeTruthy()
	})

	it("returns the reader result for primitive results", () => {
		const {result, accesses} = collectReads(base, state => state.items.length)
		expect(result).toBe(2)
		expect(accesses).toEqual([
			{type: "get", path: ["items"]},
			{type: "length", path: ["items"]}
		])
	})
})
