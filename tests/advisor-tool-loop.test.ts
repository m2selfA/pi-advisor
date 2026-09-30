import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { advisorToolDefinitions } from "../src/advisor-tools.ts";
import { completeAdvisorCandidate, type AdvisorCandidate } from "../index.ts";

function assistantResponse(content: unknown[], stopReason: "stop" | "toolUse" = "stop"): unknown {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

function makeContext(responses: unknown[], toolResult = { isError: false, content: [{ type: "text", text: "file evidence" }] }) {
	const requests: Array<{ tools?: unknown[]; messages: Message[] }> = [];
	let executeCount = 0;
	const ctx = {
		cwd: process.cwd(),
		tools: [{ name: "read" }],
		sessionManager: { getSessionId: () => "test-session" },
		executeTool: async () => {
			executeCount++;
			return {
				isError: toolResult.isError,
				result: toolResult,
			};
		},
		modelRegistry: {
			streamSimple: (_model: unknown, context: { tools?: unknown[]; messages: Message[] }) => {
				requests.push(context);
				return { result: async () => responses.shift() };
			},
		},
	} as any;
	return { ctx, requests, getExecuteCount: () => executeCount };
}

const candidate: AdvisorCandidate = {
	ref: { provider: "test", model: "test-model" },
	model: {} as NonNullable<ReturnType<any>>,
};

const initialMessages = [{ role: "user", content: "inspect the change", timestamp: 1 }] as Message[];

describe("advisor tool loop", () => {
	it("executes an allowlisted read and resumes with its result", async () => {
		const harness = makeContext([
			assistantResponse([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
			assistantResponse([{ type: "text", text: "The evidence supports the change." }]),
		]);
		const result = await completeAdvisorCandidate(
			harness.ctx,
			candidate,
			"advisor prompt",
			initialMessages,
			advisorToolDefinitions(["read"]),
			1,
			100,
			"minimal",
			[],
			undefined,
		);

		assert.equal(result.finalText, "The evidence supports the change.");
		assert.equal(harness.getExecuteCount(), 1);
		assert.deepEqual(result.toolCalls.map((call) => call.status), ["ok"]);
		assert.equal(harness.requests[0].tools?.length, 1);
		assert.match(JSON.stringify(harness.requests[1].messages), /file evidence/);
	});

	it("rejects malformed arguments before invoking the host tool", async () => {
		const harness = makeContext([
			assistantResponse([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], "toolUse"),
			assistantResponse([{ type: "text", text: "The request was malformed." }]),
		]);
		const result = await completeAdvisorCandidate(
			harness.ctx,
			candidate,
			"advisor prompt",
			initialMessages,
			advisorToolDefinitions(["read"]),
			1,
			100,
			"minimal",
			[],
			undefined,
		);

		assert.equal(harness.getExecuteCount(), 0);
		assert.equal(result.toolCalls[0]?.status, "blocked");
	});

	it("hard-denies edit, write, and shell tool calls", async () => {
		for (const name of ["edit", "write", "bash"] as const) {
			const harness = makeContext([
				assistantResponse([{ type: "toolCall", id: `call-${name}`, name, arguments: {} }], "toolUse"),
				assistantResponse([{ type: "text", text: `${name} denied.` }]),
			]);
			const result = await completeAdvisorCandidate(
				harness.ctx,
				candidate,
				"advisor prompt",
				initialMessages,
				advisorToolDefinitions(["read"]),
				1,
				100,
				"minimal",
				[],
				undefined,
			);

			assert.equal(harness.getExecuteCount(), 0);
			assert.equal(result.toolCalls[0]?.status, "blocked");
		}
	});

	it("records host tool failures and continues to the final assessment", async () => {
		const harness = makeContext(
			[
				assistantResponse([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
				assistantResponse([{ type: "text", text: "The host read failed; inspect the failure." }]),
			],
			{ isError: true, content: [{ type: "text", text: "permission denied" }] },
		);
		const result = await completeAdvisorCandidate(
			harness.ctx,
			candidate,
			"advisor prompt",
			initialMessages,
			advisorToolDefinitions(["read"]),
			1,
			100,
			"minimal",
			[],
			undefined,
		);

		assert.equal(harness.getExecuteCount(), 1);
		assert.equal(result.toolCalls[0]?.status, "error");
		assert.equal(result.finalText, "The host read failed; inspect the failure.");
	});

	it("times out a hung host tool and preserves the final assessment", async () => {
		const harness = makeContext([
			assistantResponse([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
			assistantResponse([{ type: "text", text: "The read timed out; continue with bounded evidence." }]),
		]);
		harness.ctx.executeTool = async (_name: string, _args: unknown, options: { signal?: AbortSignal }) => new Promise((resolve) => {
			options.signal?.addEventListener("abort", () => resolve({
				isError: true,
				result: { isError: true, content: [{ type: "text", text: "aborted" }] },
			}), { once: true });
		});
		const result = await completeAdvisorCandidate(
			harness.ctx,
			candidate,
			"advisor prompt",
			initialMessages,
			advisorToolDefinitions(["read"]),
			1,
			100,
			"minimal",
			[],
			undefined,
			5,
		);

		assert.equal(result.toolCalls[0]?.status, "error");
		assert.equal(result.finalText, "The read timed out; continue with bounded evidence.");
	});

	it("enforces the call budget and still requests a final assessment", async () => {
		const harness = makeContext([
			assistantResponse([
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/index.ts" } },
			], "toolUse"),
			assistantResponse([{ type: "text", text: "Budget respected." }]),
		]);
		const result = await completeAdvisorCandidate(
			harness.ctx,
			candidate,
			"advisor prompt",
			initialMessages,
			advisorToolDefinitions(["read"]),
			1,
			100,
			"minimal",
			[],
			undefined,
		);

		assert.equal(result.finalText, "Budget respected.");
		assert.equal(harness.getExecuteCount(), 1);
		assert.deepEqual(result.toolCalls.map((call) => call.status), ["ok", "budget"]);
		assert.equal(harness.requests[1].tools, undefined);
	});

	it("fails closed when the model continues requesting tools after the final request", async () => {
		const harness = makeContext([
			assistantResponse([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
			assistantResponse([{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
			assistantResponse([{ type: "toolCall", id: "call-3", name: "read", arguments: { path: "src/index.ts" } }], "toolUse"),
		]);

		await assert.rejects(
			completeAdvisorCandidate(
				harness.ctx,
				candidate,
				"advisor prompt",
				initialMessages,
				advisorToolDefinitions(["read"]),
				1,
				100,
				"minimal",
				[],
				undefined,
			),
			/tool loop exceeded/,
		);
	});
});
