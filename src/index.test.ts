import { describe, expect, test } from "bun:test";
import { applyFloor, autoActive, parseFloor, sentEffort } from "./index";

describe("applyFloor", () => {
	test("raises Anthropic effort below floor", () => {
		const payload = { output_config: { effort: "low" } };
		expect(applyFloor(payload, "medium")).toEqual({ from: "low", to: "medium" });
		expect(payload.output_config.effort).toBe("medium");
	});

	test("keeps effort at or above floor", () => {
		for (const effort of ["medium", "high", "max"]) {
			const payload = { output_config: { effort } };
			expect(applyFloor(payload, "medium")).toBeUndefined();
			expect(payload.output_config.effort).toBe(effort);
		}
	});

	test("never injects effort into a request that has none", () => {
		const payload: Record<string, unknown> = { thinking: { type: "adaptive" } };
		expect(applyFloor(payload, "high")).toBeUndefined();
		expect(payload).toEqual({ thinking: { type: "adaptive" } });
	});

	test("Anthropic minimal floor maps to low, not an invalid wire value", () => {
		const payload = { output_config: { effort: "low" } };
		expect(applyFloor(payload, "minimal")).toBeUndefined();
		expect(payload.output_config.effort).toBe("low");
	});

	test("raises OpenAI Responses and chat shapes", () => {
		const responses = { reasoning: { effort: "minimal" } };
		expect(applyFloor(responses, "medium")?.to).toBe("medium");
		expect(responses.reasoning.effort).toBe("medium");
		const chat = { reasoning_effort: "low" };
		applyFloor(chat, "high");
		expect(chat.reasoning_effort).toBe("high");
	});

	test("ignores unknown effort values", () => {
		const payload = { reasoning: { effort: "none" } };
		expect(applyFloor(payload, "medium")).toBeUndefined();
		expect(payload.reasoning.effort).toBe("none");
	});
});

describe("autoActive", () => {
	const branch = (...entries: object[]) => ({ getBranch: () => entries }) as never;

	test("latest thinking change decides", () => {
		const auto = { type: "thinking_level_change", thinkingLevel: "low", configured: "auto" };
		const pinned = { type: "thinking_level_change", thinkingLevel: "low", configured: "low" };
		expect(autoActive(branch(pinned, { type: "message" }, auto, { type: "message" }))).toBe(true);
		expect(autoActive(branch(auto, pinned))).toBe(false);
	});

	test("no thinking change or legacy entry without configured is not auto", () => {
		expect(autoActive(branch({ type: "message" }))).toBe(false);
		expect(autoActive(branch({ type: "thinking_level_change", thinkingLevel: "low" }))).toBe(false);
	});
});

test("parseFloor", () => {
	expect(parseFloor(undefined)).toBe("medium");
	expect(parseFloor(" HIGH ")).toBe("high");
	expect(parseFloor("off")).toBeUndefined();
	expect(parseFloor("bogus")).toBe("medium");
});

test("sentEffort reads each wire shape and ignores payloads without effort", () => {
	expect(sentEffort({ output_config: { effort: "medium" } })).toBe("medium");
	expect(sentEffort({ reasoning: { effort: "high" } })).toBe("high");
	expect(sentEffort({ reasoning_effort: "low" })).toBe("low");
	expect(sentEffort({ thinking: { type: "adaptive" } })).toBeUndefined();
	expect(sentEffort(undefined)).toBeUndefined();
});