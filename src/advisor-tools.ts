import type { Tool } from "@earendil-works/pi-ai";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import Value from "typebox/value";
import { isVerificationCommand, type RunToolEvent } from "./advisor-signals.ts";

export const ADVISOR_TOOL_NAMES = ["read", "grep", "find", "test_result"] as const;
export type AdvisorToolName = (typeof ADVISOR_TOOL_NAMES)[number];

export interface AdvisorToolsConfig {
	enabled: boolean;
	allowlist: AdvisorToolName[];
	maxCalls: number;
}

export interface AdvisorToolLedgerEntry {
	name: string;
	status: "ok" | "error" | "blocked" | "budget";
	durationMs: number;
	resultChars: number;
	error?: string;
}

export const DEFAULT_ADVISOR_TOOL_ALLOWLIST: AdvisorToolName[] = [...ADVISOR_TOOL_NAMES];
export const DEFAULT_ADVISOR_TOOL_CALLS = 2;
export const MAX_ADVISOR_TOOL_CALLS = 3;
export const DEFAULT_ADVISOR_TOOL_TIMEOUT_MS = 10_000;

const ADVISOR_TOOL_NAME_SET = new Set<string>(ADVISOR_TOOL_NAMES);

export function isAdvisorToolName(value: unknown): value is AdvisorToolName {
	return typeof value === "string" && ADVISOR_TOOL_NAME_SET.has(value);
}

function parseValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => parseValues(item));
	if (typeof value !== "string") return [];

	const text = value.trim();
	if (!text) return [];
	if (text.startsWith("[")) {
		try {
			return parseValues(JSON.parse(text));
		} catch {
			return [];
		}
	}
	return text.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseAdvisorToolAllowlist(value: unknown): AdvisorToolName[] {
	const seen = new Set<AdvisorToolName>();
	for (const item of parseValues(value)) {
		if (!isAdvisorToolName(item) || seen.has(item)) continue;
		seen.add(item);
	}
	return ADVISOR_TOOL_NAMES.filter((name) => seen.has(name));
}

export function normalizeAdvisorTools(value: unknown): AdvisorToolsConfig {
	const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const allowlist = parseAdvisorToolAllowlist(raw.allowlist);
	const maxCalls = typeof raw.maxCalls === "number" && Number.isInteger(raw.maxCalls) && raw.maxCalls >= 1 && raw.maxCalls <= MAX_ADVISOR_TOOL_CALLS
		? raw.maxCalls
		: DEFAULT_ADVISOR_TOOL_CALLS;

	return {
		enabled: raw.enabled === true,
		allowlist: allowlist.length > 0 ? allowlist : [...DEFAULT_ADVISOR_TOOL_ALLOWLIST],
		maxCalls,
	};
}

export function validateAdvisorToolArguments(definitions: readonly Tool[], name: string, args: unknown): string | undefined {
	const definition = definitions.find((tool) => tool.name === name);
	if (!definition) return "tool is not allowlisted";
	if (!Value.Check(definition.parameters, args)) return "tool arguments failed schema validation";
	return undefined;
}

export function advisorToolDefinitions(allowlist: readonly AdvisorToolName[]): Tool[] {
	const allowed = new Set(allowlist);
	const definitions: Tool[] = [];

	if (allowed.has("read")) {
		definitions.push({
			name: "read",
			description: "Read a bounded text file inside the current project. This is read-only; never use it to modify files.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				offset: Type.Optional(Type.Integer({ minimum: 1 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
			}),
		});
	}

	if (allowed.has("grep")) {
		definitions.push({
			name: "grep",
			description: "Search project text with a literal or regular-expression pattern. Return only evidence relevant to the current question.",
			parameters: Type.Object({
				pattern: Type.String({ minLength: 1 }),
				path: Type.Optional(Type.String()),
				glob: Type.Optional(Type.String()),
				ignoreCase: Type.Optional(Type.Boolean()),
				literal: Type.Optional(Type.Boolean()),
				context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
		});
	}

	if (allowed.has("find")) {
		definitions.push({
			name: "find",
			description: "Find project paths by name or glob. This is read-only and must stay inside the current project.",
			parameters: Type.Object({
				pattern: Type.String({ minLength: 1 }),
				path: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
		});
	}

	if (allowed.has("test_result")) {
		definitions.push({
			name: "test_result",
			description: "Query recent recorded test and verification results from the executor. This does not execute commands.",
			parameters: Type.Object({}),
		});
	}

	return definitions;
}

function isSensitivePath(pathValue: string): boolean {
	const normalized = pathValue.replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() ?? normalized;
	return basename === ".env"
		|| basename.startsWith(".env.")
		|| basename.endsWith(".pem")
		|| basename.endsWith(".key")
		|| basename.includes("id_rsa")
		|| basename.includes("credentials")
		|| basename.includes("secret");
}

/** Reject path arguments that escape the current project or target common secret files. */
export function validateAdvisorPath(cwd: string, pathValue: string | undefined): string | undefined {
	if (!pathValue || !pathValue.trim()) return undefined;
	if (isSensitivePath(pathValue)) return "path is protected from advisor access";

	const root = resolve(cwd);
	const target = resolve(root, pathValue);
	const rel = relative(root, target);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		return "path must stay inside the current project";
	}
	if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
		return "git metadata is protected from advisor access";
	}
	return undefined;
}

export function buildTestResultSummary(events: readonly RunToolEvent[]): string {
	const relevant = events.filter((event) => {
		if (event.toolName === "test_result") return true;
		if (isVerificationCommand(event.command)) return true;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return false;
		const text = `${event.summary} ${event.command ?? ""}`.toLowerCase();
		return /(?:^|[\s$])(?:test|tests|check|typecheck|lint|verify|build|compile)\b/.test(text);
	});

	if (relevant.length === 0) return "No recorded test or verification result is available. Do not claim that tests passed.";
	return relevant
		.slice(-8)
		.map((event) => `- ${event.summary}${event.isError ? " [failed]" : ""}`)
		.join("\n");
}

export function redactAdvisorToolText(text: string): string {
	return text
		.replace(/(api[-_ ]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted-token]")
		.replace(/\b(?:AIza|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted-token]");
}

export function clampAdvisorToolResult(text: string, maxChars = 6000): string {
	const normalized = redactAdvisorToolText(text.trim());
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}\n[advisor tool result truncated]`;
}
