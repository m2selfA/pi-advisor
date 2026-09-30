import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatAdvisorModel,
	normalizeAdvisorModels,
	parseAdvisorModelList,
	runWithAdvisorFallback,
} from "../src/advisor-models.ts";

describe("advisor model configuration", () => {
	it("parses comma-separated models and preserves slashes in model IDs", () => {
		const models = parseAdvisorModelList("anthropic/claude-fable-5, openrouter/z-ai/glm-5");
		assert.deepEqual(models, [
			{ provider: "anthropic", model: "claude-fable-5" },
			{ provider: "openrouter", model: "z-ai/glm-5" },
		]);
		assert.equal(formatAdvisorModel(models[1]), "openrouter/z-ai/glm-5");
	});

	it("deduplicates models while preserving order", () => {
		assert.deepEqual(parseAdvisorModelList("a/one,a/one,b/two"), [
			{ provider: "a", model: "one" },
			{ provider: "b", model: "two" },
		]);
	});

	it("accepts a JSON model list", () => {
		assert.deepEqual(parseAdvisorModelList('["a/one", {"provider":"b","model":"two"}]'), [
			{ provider: "a", model: "one" },
			{ provider: "b", model: "two" },
		]);
	});

	it("rejects empty or malformed model lists", () => {
		assert.deepEqual(parseAdvisorModelList(""), []);
		assert.deepEqual(parseAdvisorModelList("not-a-provider-model"), []);
		assert.deepEqual(parseAdvisorModelList("[]"), []);
	});

	it("migrates the legacy provider/model pair", () => {
		assert.deepEqual(normalizeAdvisorModels(undefined, "anthropic", "claude-fable-5"), [
			{ provider: "anthropic", model: "claude-fable-5" },
		]);
	});

	it("accepts object entries and prefers the new models setting", () => {
		assert.deepEqual(normalizeAdvisorModels([
			{ provider: "a", model: "one" },
			"b/two",
		], "legacy", "ignored"), [
			{ provider: "a", model: "one" },
			{ provider: "b", model: "two" },
		]);
	});
});

describe("runWithAdvisorFallback", () => {
	it("tries provider/model candidates in order and stops after the first success", async () => {
		const candidates = [
			{ provider: "provider-a", model: "model-one" },
			{ provider: "provider-b", model: "model-two" },
			{ provider: "provider-c", model: "model-three" },
		];
		const calls: string[] = [];
		const result = await runWithAdvisorFallback(candidates, async (candidate) => {
			calls.push(formatAdvisorModel(candidate));
			return candidate.provider === "provider-b"
				? { ok: true, value: "advice" }
				: { ok: false, message: "unavailable" };
		});

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.candidate, candidates[1]);
			assert.equal(result.value, "advice");
			assert.deepEqual(result.attempted, candidates.slice(0, 2));
			assert.equal(result.failures.length, 1);
		}
		assert.deepEqual(calls, ["provider-a/model-one", "provider-b/model-two"]);
	});

	it("falls through after a thrown provider failure", async () => {
		const result = await runWithAdvisorFallback(["first", "second"], async (candidate) => {
			if (candidate === "first") throw new Error("quota exhausted");
			return { ok: true, value: "advice" };
		});

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.candidate, "second");
			assert.deepEqual(result.attempted, ["first", "second"]);
			assert.deepEqual(result.failures.map((failure) => failure.message), ["quota exhausted"]);
		}
	});

	it("rethrows terminal cancellation failures", async () => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runWithAdvisorFallback(["first", "second"], async () => {
				throw new Error("cancelled");
			}, { shouldRethrow: () => controller.signal.aborted }),
			/cancelled/,
		);
	});

	it("reports all failures when no candidate succeeds", async () => {
		const result = await runWithAdvisorFallback(["first", "second"], async (candidate) => ({
			ok: false as const,
			message: `${candidate} failed`,
		}));

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.deepEqual(result.attempted, ["first", "second"]);
			assert.deepEqual(result.failures.map((failure) => failure.message), ["first failed", "second failed"]);
		}
	});
});
