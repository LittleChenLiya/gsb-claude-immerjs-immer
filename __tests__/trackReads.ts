import {trackReads} from "../src/immer"

describe("trackReads", () => {
	const createBase = () => ({
		user: {name: "Ada", age: 36},
		theme: "dark",
		items: [1, 2, 3]
	})

	it("distinguishes get / has / enumerate / iterate / length", () => {
		const {result, accesses} = trackReads(createBase(), state => {
			const name = state.user.name
			const hasTheme = "theme" in state
			const keys = Object.keys(state.user)
			let sum = 0
			for (const item of state.items) sum += item
			const len = state.items.length
			return {name, hasTheme, keys, sum, len}
		})

		expect(result).toEqual({
			name: "Ada",
			hasTheme: true,
			keys: ["name", "age"],
			sum: 6,
			len: 3
		})

		// plain property reads
		expect(accesses).toContainEqual({type: "get", path: ["user"]})
		expect(accesses).toContainEqual({type: "get", path: ["user", "name"]})
		// existence check
		expect(accesses).toContainEqual({type: "has", path: ["theme"]})
		// key enumeration
		expect(accesses).toContainEqual({type: "enumerate", path: ["user"]})
		// iteration
		expect(accesses).toContainEqual({type: "iterate", path: ["items"]})
		// array length reads
		expect(accesses).toContainEqual({type: "length", path: ["items"]})
		// iterated indices show up as plain reads
		expect(accesses).toContainEqual({type: "get", path: ["items", "0"]})
		expect(accesses).toContainEqual({type: "get", path: ["items", "2"]})
	})

	it("records repeated reads of the same path once per occurrence", () => {
		const {result, accesses} = trackReads(createBase(), state => {
			return state.user.name + " " + state.user.name
		})
		expect(result).toBe("Ada Ada")
		const nameReads = accesses.filter(
			access => access.type === "get" && access.path.join(".") === "user.name"
		)
		expect(nameReads).toHaveLength(2)
	})

	it("tracks symbol keys in get and has records", () => {
		const sym = Symbol("secret")
		const base = {[sym]: 42, plain: 1}
		const {result, accesses} = trackReads(base, state => {
			const value = (state as any)[sym]
			const exists = sym in state
			return {value, exists}
		})
		expect(result).toEqual({value: 42, exists: true})
		expect(accesses).toContainEqual({type: "get", path: [sym]})
		expect(accesses).toContainEqual({type: "has", path: [sym]})
	})

	it("records the access and propagates errors from throwing getters", () => {
		const base = {
			get boom(): string {
				throw new Error("boom")
			},
			safe: 1
		}
		const {result, accesses} = trackReads(base, state => {
			let caught
			try {
				void state.boom
			} catch (error) {
				caught = error
			}
			return {caught, safe: state.safe}
		})
		expect((result.caught as Error).message).toBe("boom")
		expect(result.safe).toBe(1)
		expect(accesses).toContainEqual({type: "get", path: ["boom"]})
		expect(accesses).toContainEqual({type: "get", path: ["safe"]})

		// uncaught getter errors propagate out of trackReads
		expect(() => trackReads(base, state => state.boom)).toThrow("boom")
	})

	it("does not record reads in branches that were not taken", () => {
		const {result, accesses} = trackReads(createBase(), state => {
			let value: unknown = "fallback"
			if (state.theme === "light") {
				value = state.user.name
			}
			if (state.items.length > 10) {
				value = state.user.age
			}
			return value
		})
		expect(result).toBe("fallback")
		// the conditions themselves were read
		expect(accesses).toContainEqual({type: "get", path: ["theme"]})
		expect(accesses).toContainEqual({type: "length", path: ["items"]})
		// but the branches behind them were never executed
		expect(accesses.some(a => a.path.join(".") === "user.name")).toBe(false)
		expect(accesses.some(a => a.path.join(".") === "user.age")).toBe(false)
	})

	it("records 'has' checks for missing keys without recording a get", () => {
		const {result, accesses} = trackReads(createBase(), state => {
			return "missing" in state
		})
		expect(result).toBe(false)
		expect(accesses).toEqual([{type: "has", path: ["missing"]}])
	})

	it("throws on any mutation attempt and leaves the base untouched", () => {
		const base = createBase()
		expect(() =>
			trackReads(base, state => {
				;(state as any).theme = "light"
			})
		).toThrow(/read-only/)
		expect(() =>
			trackReads(base, state => {
				delete (state as any).theme
			})
		).toThrow(/read-only/)
		expect(() =>
			trackReads(base, state => {
				state.items.push(4)
			})
		).toThrow(/read-only/)
		expect(() =>
			trackReads(base, state => {
				state.user.name = "Grace"
			})
		).toThrow(/read-only/)
		expect(base).toEqual(createBase())
	})

	it("revokes proxies that leak out of the reader", () => {
		let leaked: any
		trackReads(createBase(), state => {
			leaked = state.user
		})
		expect(() => leaked.name).toThrow(/cannot be used after/)
		expect(() => Object.keys(leaked)).toThrow(/cannot be used after/)
		expect(() => {
			"name" in leaked
		}).toThrow(/cannot be used after/)

		const {result} = trackReads(createBase(), state => state.items)
		expect(() => result.length).toThrow(/cannot be used after/)
	})

	it("returns the reader result and never mutates the base state", () => {
		const base = createBase()
		const snapshot = JSON.parse(JSON.stringify(base))
		const {result, accesses} = trackReads(base, state => state.user.name)
		expect(result).toBe("Ada")
		expect(accesses).toEqual([
			{type: "get", path: ["user"]},
			{type: "get", path: ["user", "name"]}
		])
		expect(base).toEqual(snapshot)
	})

	it("handles non-object base states without tracking", () => {
		const {result, accesses} = trackReads(41, state => state + 1)
		expect(result).toBe(42)
		expect(accesses).toEqual([])
	})
})
