import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAdvisorMessages, summarizeAssistantContent } from "../src/advisor-messages.ts";

function entry(role: "user" | "assistant", content: unknown) {
	return { type: "message", message: { role, content, timestamp: 1 } };
}

describe("summarizeAssistantContent", () => {
	it("keeps only text blocks and clamps long text", () => {
		const blocks = summarizeAssistantContent([
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "1", name: "read" },
			{ type: "text", text: "x".repeat(3000) },
		]);
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0].text, "hello");
		assert.ok(blocks[1].text.endsWith("[truncated for advisor context]"));
	});
});

describe("buildAdvisorMessages", () => {
	it("returns empty when the transcript has no usable messages", () => {
		const out = buildAdvisorMessages([{ type: "message", message: { role: "toolResult", content: [] } }], { stage: "initial", reason: "r" }, "", 18);
		assert.deepEqual(out, []);
	});

	it("strips toolResult entries and appends a closing context message", () => {
		const branch = [
			entry("user", "please fix the bug"),
			entry("assistant", [{ type: "text", text: "on it" }]),
			{ type: "message", message: { role: "toolResult", content: [] } },
		];
		const out = buildAdvisorMessages(branch, { stage: "recovery", reason: "why", directive: "do X" }, "Recent: edit src/a.ts", 18);
		assert.equal(out.length, 3);
		assert.equal(out[0].role, "user");
		assert.equal(out[1].role, "assistant");
		const closing = out[2];
		assert.equal(closing.role, "user");
		const text = typeof closing.content === "string" ? closing.content : "";
		assert.ok(text.includes("Current advisory stage: recovery"));
		assert.ok(text.includes("Stage objective: do X"));
		assert.ok(text.includes("Recent: edit src/a.ts"));
	});

	it("keeps head and tail when truncating, with an omission marker", () => {
		const branch = [entry("user", "original task")];
		for (let i = 0; i < 30; i++) branch.push(entry("assistant", [{ type: "text", text: `msg ${i}` }]));
		const out = buildAdvisorMessages(branch, { stage: "initial", reason: "r" }, "", 8);
		// keepFirst(2) + omission marker + keepLast + closing
		assert.equal(out.length, 8);
		const marker = out.find((m) => typeof m.content === "string" && m.content.includes("earlier transcript messages omitted"));
		assert.ok(marker, "expected omission marker message");
		const first = typeof out[0].content === "string" ? out[0].content : "";
		assert.ok(first.includes("original task"), "task framing should be retained");
	});
});
