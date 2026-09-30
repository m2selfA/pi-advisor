import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildExecutorSignals,
	countPatchChanges,
	detectStage,
	extractBashExitCode,
	isVerificationCommand,
	shouldNudge,
	summarizeToolResult,
	type RunToolEvent,
} from "../src/advisor-signals.ts";

describe("extractBashExitCode", () => {
	it("parses pi's 'Command exited with code N' format", () => {
		assert.equal(extractBashExitCode("Command exited with code 3"), 3);
	});

	it("parses plain 'exit code: N' format", () => {
		assert.equal(extractBashExitCode("exit code: 1"), 1);
	});

	it("returns undefined when no exit code present", () => {
		assert.equal(extractBashExitCode("all good"), undefined);
	});
});

describe("countPatchChanges", () => {
	it("counts added and removed lines, ignoring file headers", () => {
		const patch = ["--- a/f.ts", "+++ b/f.ts", "+one", "+two", "-old", "context"].join("\n");
		assert.deepEqual(countPatchChanges(patch), { added: 2, removed: 1 });
	});
});

describe("summarizeToolResult", () => {
	it("summarizes read with path", () => {
		const event = summarizeToolResult({ toolName: "read", input: { path: "src/x.ts" }, content: [], isError: false });
		assert.equal(event.summary, "read src/x.ts");
		assert.equal(event.isError, false);
	});

	it("summarizes edit with patch stats from details", () => {
		const event = summarizeToolResult({
			toolName: "edit",
			input: { path: "src/y.ts" },
			content: [],
			isError: false,
			details: { patch: "--- a\n+++ b\n+a\n-b\n-b" },
		});
		assert.equal(event.summary, "edit src/y.ts (+1/-2)");
	});

	it("flags non-zero bash exit codes as errors", () => {
		const event = summarizeToolResult({
			toolName: "bash",
			input: { command: "npm test" },
			content: [{ type: "text", text: "Command exited with code 2" }],
			isError: false,
		});
		assert.equal(event.isError, true);
		assert.equal(event.command, "npm test");
		assert.ok(event.summary.includes("exit 2"));
	});
});

describe("isVerificationCommand", () => {
	it("matches common verification runners", () => {
		for (const cmd of ["npm test", "npx vitest run", "cargo test --all", "node --test tests/"]) {
			assert.equal(isVerificationCommand(cmd), true, cmd);
		}
	});

	it("does not match paths that merely contain test words", () => {
		assert.equal(isVerificationCommand("cat tests/foo.test.ts"), false);
	});

	it("matches a verification segment inside a pipeline", () => {
		assert.equal(isVerificationCommand("npm run build && npm test"), true);
	});
});

function evt(partial: Partial<RunToolEvent>): RunToolEvent {
	return { toolName: "read", summary: "read", isError: false, timestamp: 0, ...partial };
}

describe("detectStage", () => {
	it("returns final-check after mutation plus verification", () => {
		const events = [evt({ toolName: "edit" }), evt({ toolName: "bash", command: "npm test" })];
		assert.equal(detectStage(events, 2).stage, "final-check");
	});

	it("returns recovery after a recent failure", () => {
		const events = [evt({ toolName: "bash", isError: true, summary: "$ npm test (exit 1)", command: "npm test" })];
		const stage = detectStage(events, 2);
		assert.equal(stage.stage, "recovery");
		assert.ok(stage.reason.includes("npm test"));
	});

	it("returns initial during early exploration", () => {
		const events = [evt({ toolName: "read" }), evt({ toolName: "bash" })];
		assert.equal(detectStage(events, 1).stage, "initial");
	});
});

describe("buildExecutorSignals", () => {
	it("derives phase and verification commands", () => {
		const signals = buildExecutorSignals([
			evt({ toolName: "write" }),
			evt({ toolName: "bash", command: "npm test", summary: "$ npm test" }),
		]);
		assert.equal(signals.phase, "verifying");
		assert.equal(signals.mutationsCount, 1);
		assert.deepEqual(signals.verificationCommands, ["npm test"]);
		assert.deepEqual(signals.recentFailures, []);
	});

	it("marks stuck phase when only failures exist", () => {
		const signals = buildExecutorSignals([evt({ toolName: "bash", isError: true, summary: "$ boom", command: "boom" })]);
		assert.equal(signals.phase, "stuck");
		assert.deepEqual(signals.recentFailures, ["$ boom"]);
	});
});

describe("shouldNudge", () => {
	it("nudges when code changed without verification", () => {
		const hint = shouldNudge([evt({ toolName: "edit" })], 0, true, 3);
		assert.ok(hint?.includes("final-check"));
	});

	it("stays quiet when verification already ran", () => {
		const hint = shouldNudge([evt({ toolName: "edit" }), evt({ toolName: "bash", command: "npm test" })], 0, true, 3);
		assert.equal(hint, null);
	});

	it("stays quiet when disabled or exhausted", () => {
		assert.equal(shouldNudge([evt({ toolName: "edit" })], 0, false, 3), null);
		assert.equal(shouldNudge([evt({ toolName: "edit" })], 3, true, 3), null);
	});
});
