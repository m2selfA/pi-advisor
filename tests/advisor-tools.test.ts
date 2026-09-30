import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	advisorToolDefinitions,
	buildTestResultSummary,
	clampAdvisorToolResult,
	normalizeAdvisorTools,
	parseAdvisorToolAllowlist,
	validateAdvisorPath,
} from "../src/advisor-tools.ts";

describe("advisor tool configuration", () => {
	it("is disabled by default with a conservative call budget", () => {
		assert.deepEqual(normalizeAdvisorTools(undefined), {
			enabled: false,
			allowlist: ["read", "grep", "find", "test_result"],
			maxCalls: 2,
		});
	});

	it("parses and deduplicates the explicit allowlist", () => {
		assert.deepEqual(parseAdvisorToolAllowlist("grep,read,grep,test_result,unknown"), [
			"read",
			"grep",
			"test_result",
		]);
		assert.deepEqual(parseAdvisorToolAllowlist('["find", "read"]'), ["read", "find"]);
	});

	it("clamps invalid maxCalls and accepts valid enabled config", () => {
		assert.deepEqual(normalizeAdvisorTools({ enabled: true, allowlist: ["read"], maxCalls: 99 }), {
			enabled: true,
			allowlist: ["read"],
			maxCalls: 2,
		});
		assert.deepEqual(normalizeAdvisorTools({ enabled: true, allowlist: "read,test_result", maxCalls: 3 }), {
			enabled: true,
			allowlist: ["read", "test_result"],
			maxCalls: 3,
		});
	});

	it("only declares tools in the allowlist", () => {
		assert.deepEqual(advisorToolDefinitions(["read", "test_result"]).map((tool) => tool.name), ["read", "test_result"]);
	});
});

describe("advisor tool safety and evidence", () => {
	it("keeps tool paths inside the project and protects common secrets", () => {
		const cwd = "C:/workspace/project";
		assert.equal(validateAdvisorPath(cwd, "src/index.ts"), undefined);
		assert.match(validateAdvisorPath(cwd, "../outside.txt") ?? "", /inside the current project/);
		assert.match(validateAdvisorPath(cwd, ".env") ?? "", /protected/);
		assert.match(validateAdvisorPath(cwd, ".git/config") ?? "", /protected/);
		assert.match(validateAdvisorPath(cwd, "../outside/*.ts") ?? "", /inside the current project/);
	});

	it("reports only recorded test-like evidence and warns when none exists", () => {
		const noResults = buildTestResultSummary([
			{ toolName: "bash", summary: "$ git status", command: "git status", isError: false, timestamp: 1 },
		]);
		assert.match(noResults, /No recorded test/);

		const summary = buildTestResultSummary([
			{ toolName: "bash", summary: "$ git status", command: "git status", isError: false, timestamp: 1 },
			{ toolName: "bash", summary: "$ npm test (exit 1)", command: "npm test", isError: true, timestamp: 2 },
		]);
		assert.match(summary, /npm test/);
		assert.match(summary, /failed/);
		assert.doesNotMatch(summary, /git status/);
	});

	it("redacts and bounds tool output", () => {
		const result = clampAdvisorToolResult("api_key=secret-value\n" + "x".repeat(20), 30);
		assert.match(result, /api_key=\[redacted\]/);
		assert.match(result, /truncated/);
	});
});
