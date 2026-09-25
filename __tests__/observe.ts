import {vi} from "vitest"
import {createProduceObserver, ObservationEvent, freeze} from "../src/immer"

vi.setConfig({
	testTimeout: 1000
})

type Recorded = ObservationEvent & {tag: string}

function recorder(events: Recorded[], tag: string) {
	return (event: ObservationEvent) => {
		events.push({...event, tag})
	}
}

describe("createProduceObserver", () => {
	it("notifies exact path subscribers, but not unaffected subtree subscribers", () => {
		const observer = createProduceObserver()
		const base = {user: {name: "a", age: 1}, items: [1, 2, 3]}
		const events: Recorded[] = []
		observer.subscribe(["user", "name"], recorder(events, "name"))
		observer.subscribe(["items"], recorder(events, "items"))

		const result = observer.produce(base, draft => {
			draft.user.name = "b"
		})

		expect(result.state.user.name).toBe("b")
		expect(events.map(e => e.tag)).toEqual(["name"])
		expect(events[0].oldValue).toBe("a")
		expect(events[0].newValue).toBe("b")
		expect(events[0].patches).toEqual([
			{op: "replace", path: ["user", "name"], value: "b"}
		])
	})

	it("notifies subtree subscribers for nested changes", () => {
		const observer = createProduceObserver()
		const base = {items: [{id: 1}, {id: 2}]}
		const events: Recorded[] = []
		observer.subscribe(["items"], recorder(events, "items"))

		observer.produce(base, draft => {
			draft.items[1].id = 20
		})

		expect(events.length).toBe(1)
		expect(events[0].oldValue).toBe(base.items)
		expect(events[0].newValue).toEqual([{id: 1}, {id: 20}])
		expect(events[0].patches).toEqual([
			{op: "replace", path: ["items", 1, "id"], value: 20}
		])
	})

	it("handles array index shifts with real patch semantics", () => {
		const observer = createProduceObserver()
		const base = {items: ["a", "b"]}
		const events: Recorded[] = []
		observer.subscribe(["items", 0], recorder(events, "idx0"))
		observer.subscribe(["items", 1], recorder(events, "idx1"))
		observer.subscribe(["items", 2], recorder(events, "idx2"))

		observer.produce(base, draft => {
			draft.items.unshift("x")
		})

		expect(events.map(e => [e.tag, e.oldValue, e.newValue])).toEqual([
			["idx0", "a", "x"],
			["idx1", "b", "a"],
			["idx2", undefined, "b"]
		])
		// patch paths carry numeric indices
		for (const event of events) {
			for (const patch of event.patches) {
				expect(typeof patch.path[1]).toBe("number")
			}
		}
	})

	it("runs notifications in registration order after commit", () => {
		const observer = createProduceObserver()
		const base = {x: 1, y: 1}
		const order: string[] = []
		observer.subscribe(["x"], () => order.push("first"))
		observer.subscribe(["y"], () => order.push("second"))

		const result = observer.produce(base, draft => {
			draft.x = 2
			draft.y = 2
		})

		// state is already committed when notifications run
		expect(result.state).toEqual({x: 2, y: 2})
		expect(order).toEqual(["first", "second"])
	})

	it("queues re-entrant produce notifications until the round ends, in order", () => {
		const observer = createProduceObserver()
		const base = {x: 1, y: 1}
		const order: string[] = []
		let innerResult: any

		observer.subscribe(["x"], event => {
			order.push(`x:outer:${event.newValue}`)
			if (event.newValue === 2) {
				innerResult = observer.produce(event.state, draft => {
					draft.y = 3
				})
			}
		})
		observer.subscribe(["y"], event => {
			order.push(`y:${event.oldValue}->${event.newValue}`)
		})

		const result = observer.produce(base, draft => {
			draft.x = 2
			draft.y = 2
		})

		// outer round completes (registration order) before the queued
		// inner round is dispatched; no recursion disturbs the order
		expect(order).toEqual(["x:outer:2", "y:1->2", "y:2->3"])
		expect(innerResult.state.y).toBe(3)
		// the inner result's errors array is shared and drained by now
		expect(innerResult.errors).toEqual([])
	})

	it("aggregates listener errors without rolling back state or blocking others", () => {
		const observer = createProduceObserver()
		const base = {x: 1}
		const boom1 = new Error("boom1")
		const boom2 = new Error("boom2")
		const ran: string[] = []
		observer.subscribe(["x"], () => {
			ran.push("a")
			throw boom1
		})
		observer.subscribe(["x"], () => ran.push("b"))
		observer.subscribe(["x"], () => {
			ran.push("c")
			throw boom2
		})

		const result = observer.produce(base, draft => {
			draft.x = 2
		})

		expect(result.state.x).toBe(2)
		expect(ran).toEqual(["a", "b", "c"])
		expect(result.errors).toEqual([boom1, boom2])
	})

	it("does not notify when nothing changed", () => {
		const observer = createProduceObserver()
		const base = {x: 1}
		const listener = vi.fn()
		observer.subscribe(["x"], listener)
		observer.subscribe([], listener)

		const result = observer.produce(base, () => {})

		expect(result.state).toBe(base)
		expect(result.patches).toEqual([])
		expect(listener).not.toHaveBeenCalled()
	})

	it("applies unsubscription only after the current round ends", () => {
		const observer = createProduceObserver()
		const base = {x: 1}
		const seen: string[] = []
		const unsubB = observer.subscribe(["x"], () => seen.push("b"))
		observer.subscribe(["x"], () => {
			seen.push("a")
			unsubB()
		})

		observer.produce(base, draft => {
			draft.x = 2
		})
		// b was registered before a, and the removal only takes effect
		// after the round, so both still fire this round
		expect(seen).toEqual(["b", "a"])
		expect(observer.size).toBe(1)

		observer.produce(base, draft => {
			draft.x = 3
		})
		expect(seen).toEqual(["b", "a", "a"])
	})

	it("does not notify listeners subscribed during a round for that round", () => {
		const observer = createProduceObserver()
		const base = {x: 1}
		const seen: string[] = []
		observer.subscribe(["x"], () => {
			seen.push("a")
			observer.subscribe(["x"], () => seen.push("late"))
		})

		observer.produce(base, draft => {
			draft.x = 2
		})
		expect(seen).toEqual(["a"])

		observer.produce(base, draft => {
			draft.x = 3
		})
		expect(seen).toEqual(["a", "a", "late"])
	})

	it("matches Map keys by identity, including object keys", () => {
		const observer = createProduceObserver()
		const keyA = {id: "a"}
		const keyB = {id: "b"}
		const base = {
			map: new Map<any, number>([
				[keyA, 1],
				[keyB, 2]
			])
		}
		const events: Recorded[] = []
		observer.subscribe(["map", keyA], recorder(events, "a"))
		observer.subscribe(["map", keyB], recorder(events, "b"))

		observer.produce(base, draft => {
			draft.map.set(keyA, 10)
		})

		expect(events.map(e => e.tag)).toEqual(["a"])
		expect(events[0].oldValue).toBe(1)
		expect(events[0].newValue).toBe(10)
		// the patch path carries the actual key object
		expect(events[0].patches[0].path[0]).toBe("map")
		expect(events[0].patches[0].path[1]).toBe(keyA)
	})

	it("observes subtree replacements of Maps", () => {
		const observer = createProduceObserver()
		const key = {id: "k"}
		const base = {map: new Map<any, number>([[key, 1]])}
		const events: Recorded[] = []
		observer.subscribe(["map"], recorder(events, "map"))

		observer.produce(base, draft => {
			draft.map.delete(key)
		})

		expect(events.length).toBe(1)
		expect(events[0].oldValue).toBe(base.map)
		expect(events[0].newValue!.size).toBe(0)
	})

	it("works with frozen (auto-frozen) base and result states", () => {
		const observer = createProduceObserver()
		const base = freeze({user: {name: "a"}, items: [1]}, true)
		const events: Recorded[] = []
		observer.subscribe(["user", "name"], recorder(events, "name"))

		const result = observer.produce(base, draft => {
			draft.user.name = "b"
		})

		expect(Object.isFrozen(result.state)).toBe(true)
		expect(Object.isFrozen(result.state.user)).toBe(true)
		expect(events.length).toBe(1)
		expect(events[0].oldValue).toBe("a")
		expect(events[0].newValue).toBe("b")
	})

	it("demo: shows matching notifications and queued updates", () => {
		const observer = createProduceObserver()
		const base = {user: {name: "a"}, items: ["x", "y"]}
		const log: string[] = []

		observer.subscribe(["user", "name"], e => {
			log.push(`[match] user.name: ${e.oldValue} -> ${e.newValue}`)
			if (e.newValue === "b") {
				// re-entrant produce: its notifications are queued
				observer.produce(e.state, draft => {
					draft.items.unshift("z")
				})
			}
		})
		observer.subscribe(["items"], e => {
			log.push(
				`[match] items: ${JSON.stringify(e.oldValue)} -> ${JSON.stringify(
					e.newValue
				)}`
			)
		})
		observer.subscribe(["items", 0], e => {
			log.push(`[match] items[0]: ${e.oldValue} -> ${e.newValue}`)
		})

		const observerResult = observer.produce(base, draft => {
			draft.user.name = "b"
		})

		// eslint-disable-next-line no-console
		console.log(log.join("\n"))
		expect(log).toEqual([
			"[match] user.name: a -> b",
			'[match] items: ["x","y"] -> ["z","x","y"]',
			"[match] items[0]: x -> z"
		])
		expect(observerResult.errors).toEqual([])
	})
})
