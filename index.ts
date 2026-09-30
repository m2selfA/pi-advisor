/**
 * Advisor Extension
 *
 * Registers an LLM-callable tool named `advisor` that allows the executor model
 * to consult a stronger "advisor" model for strategic guidance on complex decisions.
 *
 * Design follows the advisor tool pattern: the executor keeps doing the work and
 * only calls the advisor when it needs strategic guidance — not for syntax-level
 * questions or routine implementation steps.
 *
 * The advisor:
 * - Sees a curated transcript plus the executor's current system prompt
 * - Returns strategic guidance (plan, correction, or stop signal)
 * - May use a small, explicit, host-controlled read-only tool allowlist when enabled
 * - Is invoked at the executor's discretion
 *
 * Commands:
 * - /advisor on [provider/model,...] — Enable advisor tool with ordered fallbacks (persists to config)
 * - /advisor off                 — Disable advisor tool (persists to config)
 * - /advisor config [key=value]  — Show/edit advisor configuration
 * - /advisor                     — Show status or manually trigger consultation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
	type Message,
	type TextContent,
	type ThinkingContent,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getAgentDir, keyHint, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { buildAdvisorMessages } from "./src/advisor-messages.ts";
import {
	buildExecutorSignals,
	detectStage,
	shouldNudge,
	summarizeToolResult,
	type AdvisorStage,
	type AdvisorStageInfo,
	type RunToolEvent,
} from "./src/advisor-signals.ts";
import {
	formatAdvisorModel,
	normalizeAdvisorModels,
	parseAdvisorModelList,
	runWithAdvisorFallback,
	type AdvisorModelRef,
} from "./src/advisor-models.ts";
import {
	advisorToolDefinitions,
	buildTestResultSummary,
	DEFAULT_ADVISOR_TOOL_TIMEOUT_MS,
	clampAdvisorToolResult,
	isAdvisorToolName,
	normalizeAdvisorTools,
	parseAdvisorToolAllowlist,
	validateAdvisorPath,
	validateAdvisorToolArguments,
	type AdvisorToolLedgerEntry,
	type AdvisorToolName,
	type AdvisorToolsConfig,
} from "./src/advisor-tools.ts";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AdvisorConfig {
	enabled: boolean;
	models: AdvisorModelRef[];
	tools: AdvisorToolsConfig;
	maxUsesPerRun: number;
	maxTokens: number;
	reasoning: ThinkingLevel;
	maxContextMessages: number;
}

interface AdvisorUsage {
	inputTokens?: number;
	outputTokens?: number;
	model: string;
}

interface AdvisorDetails {
	usage?: AdvisorUsage;
	callNumber: number;
	stage?: AdvisorStage;
	attemptedModels?: string[];
	toolCalls?: AdvisorToolLedgerEntry[];
	error?: string;
	message?: string;
}

const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: false,
	models: [{ provider: "anthropic", model: "claude-fable-5" }],
	tools: normalizeAdvisorTools(undefined),
	maxUsesPerRun: 3,
	// Adaptive-thinking models count thinking tokens against the output cap;
	// 8k left too little room for the actual advice at reasoning=high.
	maxTokens: 16384,
	reasoning: "high",
	maxContextMessages: 18,
};

const MAX_SYSTEM_PROMPT_CHARS = 12000;
const RECENT_TOOL_SUMMARY_COUNT = 8;

const VALID_REASONING_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

type RegistryStreamSimple = ExtensionContext["modelRegistry"]["streamSimple"];
type RegistryStreamArgs = Parameters<RegistryStreamSimple>;
type RegistryAssistantMessage = Awaited<ReturnType<ReturnType<RegistryStreamSimple>["result"]>>;

/**
 * Route advisor calls through Pi's provider-neutral nested-call API.
 *
 * Pi's ModelRegistry resolves request-time authentication and dispatches
 * extension providers here, including custom APIs such as `anyrouter-messages`.
 */
async function completeThroughRegistry(
	ctx: ExtensionContext,
	...args: RegistryStreamArgs
): Promise<RegistryAssistantMessage> {
	return ctx.modelRegistry.streamSimple(...args).result();
}

const ADVISOR_SYSTEM_PROMPT = `You are a senior engineering advisor. The executor model is doing the work; you observe the transcript and provide strategic guidance when consulted.

Your role:
- You see a curated subset of the executor's context: a truncated transcript, tool activity summaries (not full outputs), and its system prompt
- If the evidence is too thin to judge, say so — never fill gaps with guesses
- You cannot modify files, execute shell commands, or produce user-facing output; when an explicit read-only allowlist is present, use those investigative tools sparingly
- Your advice directly shapes the executor's next actions

What you provide depends on the stage:
1. PLAN — when the executor is still exploring: shortest viable approach, main risk to avoid, first concrete steps (here the verdict judges the exploration direction so far)
2. CORRECTION — when trajectory is weak: what to stop doing, why, and the corrected path
3. VERIFICATION — when implementation appears done: missing evidence, unmet requirements, or explicit sign-off

Output format:
- Lead with a one-sentence verdict: "On track", "Course-correct", or "Not done yet"
- Follow with numbered action items (max 5) the executor should take next
- If the transcript lacks the evidence to settle a point, make your FIRST action item the exact command or file read that would settle it (e.g. "run npm test and re-consult"), instead of guessing
- Reference specific files, commands, or error signals from the transcript
- If you disagree with evidence the executor gathered, state the conflict explicitly — don't silently override

Keep it short. The executor will read your advice and immediately act on it.`;

function configPath(): string {
	return join(getAgentDir(), "advisor.json");
}

function defaultConfig(): AdvisorConfig {
	return {
		...DEFAULT_CONFIG,
		models: DEFAULT_CONFIG.models.map((model) => ({ ...model })),
		tools: {
			enabled: DEFAULT_CONFIG.tools.enabled,
			allowlist: [...DEFAULT_CONFIG.tools.allowlist],
			maxCalls: DEFAULT_CONFIG.tools.maxCalls,
		},
	};
}

function loadConfig(): AdvisorConfig {
	const path = configPath();
	if (!existsSync(path)) return defaultConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const models = normalizeAdvisorModels(raw.models, raw.provider, raw.model);
		const fallback = defaultConfig();
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
			models: models.length > 0 ? models : fallback.models,
			tools: normalizeAdvisorTools(raw.tools),
			maxUsesPerRun: typeof raw.maxUsesPerRun === "number" ? raw.maxUsesPerRun : fallback.maxUsesPerRun,
			maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : fallback.maxTokens,
			reasoning: VALID_REASONING_LEVELS.includes(raw.reasoning) ? raw.reasoning : fallback.reasoning,
			maxContextMessages: typeof raw.maxContextMessages === "number" ? raw.maxContextMessages : fallback.maxContextMessages,
		};
	} catch {
		return defaultConfig();
	}
}

function saveConfig(config: AdvisorConfig): void {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

const STAGE_LABELS: Record<AdvisorStage, string> = {
	"initial": "initial",
	"recovery": "recovery",
	"final-check": "final check",
};

function stageLabel(stage: AdvisorStage): string {
	return STAGE_LABELS[stage];
}

const STAGE_DIRECTIVES: Record<AdvisorStage, string> = {
	"initial": "Executor is still exploring. Provide: (1) the shortest viable approach, (2) the main risk to avoid, (3) 2-3 concrete first steps.",
	"recovery": "Executor hit friction or is off-track. Provide: (1) what went wrong, (2) what to stop doing, (3) corrected path forward.",
	"final-check": "Implementation appears done. Verify: (1) re-read the original user request at the top of the transcript — are all of ITS requirements met, including explicit constraints? (2) is verification evidence sufficient? (3) any missing edge cases? Give explicit sign-off or list what's missing.",
};

function stageDirective(stage: AdvisorStage): string {
	return STAGE_DIRECTIVES[stage];
}

function squeezeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function buildActiveToolsSummary(pi: ExtensionAPI): string {
	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== "advisor"));
	const activeTools = pi
		.getAllTools()
		.filter((tool) => activeToolNames.has(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (activeTools.length === 0) return "- No active tools recorded";

	return activeTools
		.map((tool) => `- ${tool.name}: ${squeezeWhitespace(tool.description).slice(0, 160)}`)
		.join("\n");
}

function buildRecentToolActivity(events: RunToolEvent[]): string {
	if (events.length === 0) return "";
	return events
		.slice(-RECENT_TOOL_SUMMARY_COUNT)
		.map((event) => `- ${event.summary}`)
		.join("\n");
}

// Stage specifics live in the final context message next to the freshest
// evidence (see buildAdvisorMessages); the system prompt stays stage-agnostic.
function buildAdvisorPrompt(
	executorSystemPrompt: string,
	activeToolsSummary: string,
	advisorToolNames: readonly AdvisorToolName[] = [],
	maxAdvisorToolCalls = 0,
): string {
	const trimmedSystemPrompt = executorSystemPrompt.trim();
	const boundedSystemPrompt = trimmedSystemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
		? `${trimmedSystemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS).trimEnd()}\n[executor system prompt truncated for advisor context]`
		: trimmedSystemPrompt;

	return `${ADVISOR_SYSTEM_PROMPT}

Executor system prompt:
<<<SYSTEM_PROMPT
${boundedSystemPrompt}
SYSTEM_PROMPT>>>

Active tools available to the executor:
${activeToolsSummary}

${advisorToolNames.length > 0
		? `Advisor investigative tools available (read-only, host-controlled, max ${maxAdvisorToolCalls} calls):\n- ${advisorToolNames.join("\n- ")}\nUse them only when the transcript and recent evidence are insufficient. Never modify files, execute commands, or claim a test passed without recorded evidence.`
		: "Advisor investigative tools are disabled for this consultation."}`;
}

function buildPreview(text: string, lines: number): { preview: string; truncated: boolean } {
	const split = text.split("\n");
	if (split.length <= lines) return { preview: text, truncated: false };
	return { preview: `${split.slice(0, lines).join("\n")}\n…`, truncated: true };
}

type NotifyLevel = "info" | "warning" | "error";

function setAdvisorStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (ctx.hasUI) ctx.ui.setStatus("advisor-nudge", text);
}

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function themedStatus(ctx: ExtensionContext, color: "success" | "dim", text: string): string {
	return ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
}

function configuredModelsText(config: AdvisorConfig): string {
	return config.models.map(formatAdvisorModel).join(", ");
}

function redactAdvisorError(message: string): string {
	return message
		.replace(/(api[-_ ]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted-token]")
		.replace(/\b(?:AIza|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted-token]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

function summarizeFallbackFailures(failures: Array<{ candidate: { ref: AdvisorModelRef }; message: string }>): string {
	return failures
		.map(({ candidate, message }) => `${formatAdvisorModel(candidate.ref)}: ${redactAdvisorError(message)}`)
		.join("; ");
}

type AdvisorToolExecution = {
	text: string;
	ledger: AdvisorToolLedgerEntry;
};

function toolResultText(content: Array<{ type?: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

function availableAdvisorToolNames(ctx: ExtensionToolContext, tools: AdvisorToolsConfig): AdvisorToolName[] {
	const hostTools = new Set(ctx.tools.map((tool) => tool.name));
	return tools.allowlist.filter((name) => name === "test_result" || hostTools.has(name));
}

async function executeAdvisorToolCall(
	ctx: ExtensionToolContext,
	call: ToolCall,
	advisorTools: readonly Tool[],
	runToolEvents: readonly RunToolEvent[],
	signal: AbortSignal | undefined,
	timeoutMs = DEFAULT_ADVISOR_TOOL_TIMEOUT_MS,
): Promise<AdvisorToolExecution> {
	const startedAt = Date.now();
	const name = call.name;
	const makeLedger = (status: AdvisorToolLedgerEntry["status"], text: string, error?: string): AdvisorToolExecution => ({
		text: clampAdvisorToolResult(text),
		ledger: {
			name,
			status,
			durationMs: Date.now() - startedAt,
			resultChars: text.length,
			error: error ? redactAdvisorError(error) : undefined,
		},
	});

	if (!isAdvisorToolName(name)) return makeLedger("blocked", `Tool ${name} is not allowed for advisor access.`, "tool not allowlisted");
	const argumentError = validateAdvisorToolArguments(advisorTools, name, call.arguments);
	if (argumentError) return makeLedger("blocked", `Advisor rejected ${name}: ${argumentError}.`, argumentError);
	if (name === "test_result") return makeLedger("ok", buildTestResultSummary(runToolEvents));

	const args = call.arguments as Record<string, unknown>;
	const pathValues = [
		typeof args.path === "string" ? args.path : undefined,
		name === "grep" && typeof args.glob === "string" ? args.glob : undefined,
		name === "find" && typeof args.pattern === "string" ? args.pattern : undefined,
	].filter((value): value is string => Boolean(value));
	for (const pathValue of pathValues) {
		const pathError = validateAdvisorPath(ctx.cwd, pathValue);
		if (pathError) return makeLedger("blocked", `Advisor access blocked: ${pathError}.`, pathError);
	}
	if (!ctx.tools.some((tool) => tool.name === name)) {
		return makeLedger("error", `Host tool ${name} is unavailable in this session.`, "host tool unavailable");
	}

	const controller = new AbortController();
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let removeParentAbort: (() => void) | undefined;
	const parentAbortPromise = signal
		? new Promise<never>((_, reject) => {
			const onAbort = () => {
				controller.abort();
				reject(new Error("Advisor call aborted"));
			};
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				removeParentAbort = () => signal.removeEventListener("abort", onAbort);
			}
		})
		: undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new Error(`host tool timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		const executionPromise = ctx.executeTool(name, args, { signal: controller.signal });
		const outcome = parentAbortPromise
			? await Promise.race([executionPromise, timeoutPromise, parentAbortPromise])
			: await Promise.race([executionPromise, timeoutPromise]);
		const text = toolResultText(outcome.result.content);
		const error = outcome.isError || outcome.result.isError;
		return makeLedger(error ? "error" : "ok", text || (error ? "Host tool returned an error without details." : "Host tool returned no text."), error ? "host tool execution failed" : undefined);
	} catch (error) {
		const message = timedOut ? `host tool timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error);
		return makeLedger("error", `Host tool ${name} failed: ${redactAdvisorError(message)}`, message);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		removeParentAbort?.();
	}
}

export type AdvisorCandidate = {
	ref: AdvisorModelRef;
	model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
};

type AdvisorCallResult = {
	response: RegistryAssistantMessage;
	finalText: string;
	usage: AdvisorUsage;
	toolCalls: AdvisorToolLedgerEntry[];
};

export async function completeAdvisorCandidate(
	ctx: ExtensionToolContext,
	candidate: AdvisorCandidate,
	advisorPrompt: string,
	initialMessages: Message[],
	advisorTools: Tool[],
	maxToolCalls: number,
	maxTokens: number,
	reasoning: ThinkingLevel,
	runToolEvents: readonly RunToolEvent[],
	signal: AbortSignal | undefined,
	toolTimeoutMs = DEFAULT_ADVISOR_TOOL_TIMEOUT_MS,
): Promise<AdvisorCallResult> {
	const messages = [...initialMessages];
	const ledger: AdvisorToolLedgerEntry[] = [];
	let remainingToolCalls = maxToolCalls;
	let forcedFinalRequest = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let inputUsageKnown = true;
	let outputUsageKnown = true;

	for (let requestNumber = 0; requestNumber <= maxToolCalls + 1; requestNumber++) {
		if (signal?.aborted) throw new Error("Advisor call aborted");

		const toolsForRequest = remainingToolCalls > 0 ? advisorTools : [];
		const response = await completeThroughRegistry(
			ctx,
			candidate.model,
			{
				systemPrompt: advisorPrompt,
				messages,
				...(toolsForRequest.length > 0 ? { tools: toolsForRequest } : {}),
			},
			{
				maxTokens,
				signal,
				reasoning,
				sessionId: `${ctx.sessionManager.getSessionId()}:advisor:${encodeURIComponent(formatAdvisorModel(candidate.ref))}`,
				...(toolsForRequest.length > 0 ? { toolChoice: "auto" as const } : {}),
			},
		);

		if (typeof response.usage?.input === "number") inputTokens += response.usage.input;
		else inputUsageKnown = false;
		if (typeof response.usage?.output === "number") outputTokens += response.usage.output;
		else outputUsageKnown = false;
		if (response.errorMessage) throw new Error(`model error: ${response.errorMessage}`);

		const toolCalls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
		const textBlocks = response.content.filter((block): block is TextContent => block.type === "text");
		const thinkingBlocks = response.content.filter((block): block is ThinkingContent => block.type === "thinking");
		const adviceText = textBlocks.map((block) => block.text).join("\n").trim();
		const thinkingText = thinkingBlocks.map((block) => block.thinking).join("\n").trim();
		const finalText = adviceText || (thinkingText ? `(thinking)\n${thinkingText}` : "");

		if (toolCalls.length === 0) {
			if (!finalText) throw new Error(`empty response (stop: ${response.stopReason})`);
			return {
				response,
				finalText,
				usage: {
					inputTokens: inputUsageKnown ? inputTokens : undefined,
					outputTokens: outputUsageKnown ? outputTokens : undefined,
					model: formatAdvisorModel(candidate.ref),
				},
				toolCalls: ledger,
			};
		}

		if (forcedFinalRequest) throw new Error("advisor tool loop exceeded its final-response budget");
		messages.push(response);
		if (remainingToolCalls === 0) forcedFinalRequest = true;

		for (const call of toolCalls) {
			let resultText: string;
			let isError = false;
			if (remainingToolCalls <= 0) {
				resultText = "Advisor tool-call budget exhausted. Provide the final assessment without requesting more tools.";
				isError = true;
				ledger.push({
					name: call.name,
					status: "budget",
					durationMs: 0,
					resultChars: resultText.length,
					error: "tool-call budget exhausted",
				});
			} else {
				remainingToolCalls--;
				const execution = await executeAdvisorToolCall(ctx, call, advisorTools, runToolEvents, signal, toolTimeoutMs);
				resultText = execution.text;
				isError = execution.ledger.status !== "ok";
				ledger.push(execution.ledger);
			}
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: resultText }],
				isError,
				timestamp: Date.now(),
			};
			messages.push(toolResult);
		}
	}

	throw new Error("advisor tool loop exceeded its request budget");
}

export default function advisorExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let usesThisRun = 0;
	let runToolEvents: RunToolEvent[] = [];

	pi.on("agent_start", async (_, ctx) => {
		usesThisRun = 0;
		runToolEvents = [];
		setAdvisorStatus(ctx, undefined);
	});

	// tool_result carries the tool input and typed details directly, so no
	// tool_execution_start/end bookkeeping is needed.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "advisor" || event.parentToolCallId) return;
		runToolEvents.push(summarizeToolResult(event));

		const hint = shouldNudge(runToolEvents, usesThisRun, config.enabled, config.maxUsesPerRun);
		setAdvisorStatus(ctx, hint ?? undefined);
	});

	pi.on("session_start", async () => {
		config = loadConfig();
		updateToolRegistration();
	});

	function updateToolRegistration() {
		const activeTools = pi.getActiveTools();
		if (config.enabled) {
			if (!activeTools.includes("advisor")) {
				pi.setActiveTools([...activeTools, "advisor"]);
			}
			return;
		}
		if (activeTools.includes("advisor")) {
			pi.setActiveTools(activeTools.filter((tool) => tool !== "advisor"));
		}
	}

	pi.registerTool({
		name: "advisor",
		label: "Consult advisor",
		description: `Consult a stronger model for strategic guidance. Returns a verdict (On track / Course-correct / Not done yet) plus numbered action items.
The advisor sees the conversation transcript, your system prompt, and recent tool activity. Read-only investigative tools are opt-in via advisor.json and are host-controlled.`,
		promptSnippet: "advisor({ stage? }): consult stronger model (ordered model fallbacks) for strategic guidance → verdict + action items",
		promptGuidelines: [
			"Call advisor({ stage: 'initial' }) for non-trivial tasks after 2-3 reads, before committing to an approach",
			"Call advisor({ stage: 'recovery' }) when stuck, confused, or after a failed attempt",
			"Call advisor({ stage: 'final-check' }) after implementation + verification, before declaring complete",
			"Call advisor() with no args to auto-detect the stage",
			"Do not call advisor for syntax questions, API lookups, routine steps, tasks completable in <5 tool calls, or when your current plan is working",
			"You remain executor: advisor only advises. Execute returned action items unless evidence contradicts — then state the conflict explicitly instead of silently ignoring",
		],
		parameters: Type.Object({
			stage: Type.Optional(Type.Union([Type.Literal("initial"), Type.Literal("recovery"), Type.Literal("final-check")])),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			config = loadConfig();
			setAdvisorStatus(ctx, undefined);

			if (usesThisRun >= config.maxUsesPerRun) {
				return {
					content: [{ type: "text", text: `Advisor usage limit reached (${config.maxUsesPerRun} per run). Continue without advisor guidance.` }],
					details: { error: "max_uses_exceeded", callNumber: usesThisRun } as AdvisorDetails,
				};
			}

			const configuredCandidates = config.models.map((ref) => ({
				ref,
				model: ctx.modelRegistry.find(ref.provider, ref.model),
			}));
			const availableCandidates = configuredCandidates.filter(
				(candidate): candidate is AdvisorCandidate => Boolean(candidate.model),
			);
			if (availableCandidates.length === 0) {
				return {
					content: [{ type: "text", text: `None of the configured advisor models are available: ${configuredModelsText(config)}. Continue without advice.` }],
					details: {
						error: "model_not_found",
						callNumber: usesThisRun,
						attemptedModels: config.models.map(formatAdvisorModel),
					} as AdvisorDetails,
					isError: true,
				};
			}

			const stageInfo: AdvisorStageInfo = params.stage
				? { stage: params.stage, reason: "Executor explicitly signaled this stage." }
				: detectStage(runToolEvents, usesThisRun + 1);
			const recentToolActivity = buildRecentToolActivity(runToolEvents);
			const branch = ctx.sessionManager.getBranch();
			const signals = buildExecutorSignals(runToolEvents);
			const advisorMessages = buildAdvisorMessages(
				branch,
				{ ...stageInfo, directive: stageDirective(stageInfo.stage) },
				recentToolActivity,
				config.maxContextMessages,
				signals,
			);
			if (advisorMessages.length === 0) {
				return {
					content: [{ type: "text", text: "No conversation context available for advisor. Continue without advice." }],
					details: { error: "no_context", callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
					isError: true,
				};
			}

			const executorSystemPrompt = ctx.getSystemPrompt();
			const advisorToolNames = config.tools.enabled ? availableAdvisorToolNames(ctx, config.tools) : [];
			const advisorTools = config.tools.enabled ? advisorToolDefinitions(advisorToolNames) : [];
			const advisorPrompt = buildAdvisorPrompt(
				executorSystemPrompt,
				buildActiveToolsSummary(pi),
				advisorToolNames,
				config.tools.maxCalls,
			);

			// Count one advisor consultation, not one count per fallback candidate.
			usesThisRun++;

			let fallbackResult: Awaited<ReturnType<typeof runWithAdvisorFallback<AdvisorCandidate, AdvisorCallResult>>>;
			try {
				fallbackResult = await runWithAdvisorFallback<AdvisorCandidate, AdvisorCallResult>(availableCandidates, async (candidate) => {
					if (signal?.aborted) {
						const abortError = new Error("Advisor call aborted");
						abortError.name = "AbortError";
						throw abortError;
					}

					try {
						const value = await completeAdvisorCandidate(
							ctx,
							candidate,
							advisorPrompt,
							advisorMessages as Message[],
							advisorTools,
							config.tools.enabled ? config.tools.maxCalls : 0,
							config.maxTokens,
							config.reasoning,
							runToolEvents,
							signal,
						);
						return { ok: true, value };
					} catch (err) {
						// Only the executor's cancellation signal stops fallback; provider-side
						// AbortError/timeout/tool incompatibility failures remain eligible for the next model.
						if (signal?.aborted) throw err;
						const msg = err instanceof Error ? err.message : String(err);
						return { ok: false, message: msg };
					}
				}, {
					shouldRethrow: () => Boolean(signal?.aborted),
				});
			} catch (err) {
				const msg = redactAdvisorError(err instanceof Error ? err.message : String(err));
				return {
					content: [{ type: "text", text: `Advisor call failed: ${msg}. Continue without advice.` }],
					details: { error: "execution_failed", message: msg, callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
					isError: true,
				};
			}

			if (!fallbackResult.ok) {
				const unavailable = configuredCandidates
					.filter((candidate) => !candidate.model)
					.map((candidate) => ({ candidate, message: "model not found" }));
				const failures = [
					...unavailable,
					...fallbackResult.failures,
				];
				const failureSummary = summarizeFallbackFailures(failures);
				return {
					content: [{ type: "text", text: `Advisor unavailable after trying ${configuredModelsText(config)}${failureSummary ? `: ${failureSummary}` : ""}. Continue without advice.` }],
					details: {
						error: "all_models_failed",
						message: failureSummary,
						callNumber: usesThisRun,
						stage: stageInfo.stage,
						attemptedModels: fallbackResult.attempted.map((candidate) => formatAdvisorModel(candidate.ref)),
					} as AdvisorDetails,
					isError: true,
				};
			}

			const { response, finalText, usage, toolCalls } = fallbackResult.value;
			pi.appendEntry("advisor-usage", usage);

			return {
				content: [{ type: "text", text: finalText }],
				details: {
					usage,
					callNumber: usesThisRun,
					stage: stageInfo.stage,
					attemptedModels: fallbackResult.attempted.map((candidate) => formatAdvisorModel(candidate.ref)),
					toolCalls,
				} as AdvisorDetails,
				usage: response.usage,
				isError: false,
			};
		},

		renderCall() {
			return new Container();
		},

		renderResult(result, options: ToolRenderResultOptions, theme, _context) {
			const details = result.details as AdvisorDetails | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no advice)";

			if (options.isPartial) {
				return new Text(theme.fg("muted", "Advisor…"), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", "Advisor unavailable: ") + theme.fg("dim", text), 0, 0);
			}

			const container = new Container();
			let header = theme.fg("toolTitle", theme.bold("Advisor"));
			if (details?.stage) header += " " + theme.fg("muted", stageLabel(details.stage));
			if (details?.callNumber) header += theme.fg("dim", ` #${details.callNumber}/${config.maxUsesPerRun}`);
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Spacer(1));

			if (options.expanded) {
				container.addChild(new Text(text, 0, 0));
			} else {
				const preview = buildPreview(text, 6);
				container.addChild(new Text(preview.preview, 0, 0));
				if (preview.truncated) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
				}
			}

			if (details?.toolCalls && details.toolCalls.length > 0) {
				container.addChild(new Spacer(1));
				const toolSummary = details.toolCalls
					.map((call) => `${call.name}:${call.status}`)
					.join(", ");
				container.addChild(new Text(theme.fg("dim", `Advisor tools (${details.toolCalls.length}): ${toolSummary}`), 0, 0));
			}

			if (details?.usage) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("dim", `↑${details.usage.inputTokens === undefined ? "unknown" : formatTokens(details.usage.inputTokens)} ↓${details.usage.outputTokens === undefined ? "unknown" : formatTokens(details.usage.outputTokens)} ${details.usage.model}`),
						0,
						0,
					),
				);
			}

			return container;
		},
	});

	pi.registerCommand("advisor", {
		description: "Manage advisor tool: on, off, config, ask",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["on", "off", "config", "ask"];
			const trimmed = prefix.trim();
			if (!trimmed.includes(" ")) {
				const matches = subcommands.filter((s) => s.startsWith(trimmed));
				return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
			}

			const parts = trimmed.split(/\s+/);
			if (parts[0] === "config" && parts.length <= 2) {
				const keys = ["models=", "provider=", "model=", "tools.enabled=", "tools.allowlist=", "tools.maxCalls=", "maxUsesPerRun=", "maxTokens=", "reasoning=", "maxContextMessages="];
				const lastPart = parts[parts.length - 1] ?? "";
				const matches = keys.filter((k) => k.startsWith(lastPart));
				return matches.length > 0 ? matches.map((k) => ({ value: `config ${k}`, label: k })) : null;
			}

			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "on": {
					const models = rest ? parseAdvisorModelList(rest) : config.models;
					if (models.length === 0) {
						notify(ctx, "Invalid format. Use: /advisor on provider/model[,provider/model...]", "warning");
						return;
					}

					const available = models.filter((model) => Boolean(ctx.modelRegistry.find(model.provider, model.model)));
					if (available.length === 0) {
						notify(ctx, `None of the configured advisor models are available: ${models.map(formatAdvisorModel).join(", ")}`, "error");
						return;
					}

					config.models = models;
					config.enabled = true;
					saveConfig(config);
					updateToolRegistration();
					const unavailable = models.filter((model) => !available.some((candidate) => formatAdvisorModel(candidate) === formatAdvisorModel(model)));
					const suffix = unavailable.length > 0 ? ` (unavailable now: ${unavailable.map(formatAdvisorModel).join(", ")}; will be skipped)` : "";
					notify(ctx, `Advisor enabled: ${configuredModelsText(config)}${suffix}`, unavailable.length > 0 ? "warning" : "info");
					break;
				}

				case "off": {
					config.enabled = false;
					saveConfig(config);
					updateToolRegistration();
					notify(ctx, "Advisor disabled", "info");
					break;
				}

				case "config": {
					if (!rest) {
						const status = themedStatus(ctx, config.enabled ? "success" : "dim", config.enabled ? "enabled" : "disabled");
						const lines = [
							"Advisor Configuration",
							"",
							`  Status:       ${status}`,
							`  Models:       ${configuredModelsText(config)}`,
							`  Tools:        ${config.tools.enabled ? "enabled" : "disabled"} (${config.tools.allowlist.join(", ")}; max ${config.tools.maxCalls} calls)`,
							`  Max uses/run: ${config.maxUsesPerRun}`,
							`  Max tokens:   ${config.maxTokens}`,
							`  Reasoning:    ${config.reasoning}`,
							`  Context msgs: ${config.maxContextMessages}`,
							"",
							"Usage:",
							"  /advisor on [provider/model,...]  Enable advisor with ordered fallbacks",
							"  /advisor off                    Disable advisor",
							"  /advisor config key=value       Set config value",
							"  /advisor ask                    Trigger consultation",
							"",
							"Config keys: models, provider, model, tools.enabled, tools.allowlist, tools.maxCalls, maxUsesPerRun, maxTokens, reasoning, maxContextMessages; tools are read-only and disabled by default.",
							`Reasoning levels: ${VALID_REASONING_LEVELS.join(", ")}`,
						];
						notify(ctx, lines.join("\n"), "info");
						return;
					}

					const match = rest.match(/^([A-Za-z][A-Za-z0-9_.-]*)=(.+)$/);
					if (!match) {
						notify(ctx, "Invalid format. Use: /advisor config key=value", "warning");
						return;
					}

					const [, key, value] = match;
					switch (key) {
						case "models": {
							const models = parseAdvisorModelList(value);
							if (models.length === 0) {
								notify(ctx, "models must be a comma-separated provider/model list or a JSON array", "warning");
								return;
							}
							config.models = models;
							break;
						}
						case "provider": {
							const first = config.models[0] ?? DEFAULT_CONFIG.models[0];
							config.models = [{ provider: value.trim(), model: first.model }, ...config.models.slice(1)];
							break;
						}
						case "model": {
							const first = config.models[0] ?? DEFAULT_CONFIG.models[0];
							config.models = [{ provider: first.provider, model: value.trim() }, ...config.models.slice(1)];
							break;
						}
						case "tools.enabled": {
							if (value !== "true" && value !== "false") {
								notify(ctx, "tools.enabled must be true or false", "warning");
								return;
							}
							config.tools.enabled = value === "true";
							break;
						}
						case "tools.allowlist": {
							const allowlist = parseAdvisorToolAllowlist(value);
							if (allowlist.length === 0) {
								notify(ctx, "tools.allowlist must contain read, grep, find, or test_result", "warning");
								return;
							}
							config.tools.allowlist = allowlist;
							break;
						}
						case "tools.maxCalls": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 1 || num > 3) {
								notify(ctx, "tools.maxCalls must be an integer from 1 to 3", "warning");
								return;
							}
							config.tools.maxCalls = num;
							break;
						}
						case "maxUsesPerRun": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 1) {
								notify(ctx, "maxUsesPerRun must be a positive integer", "warning");
								return;
							}
							config.maxUsesPerRun = num;
							break;
						}
						case "maxTokens": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 100) {
								notify(ctx, "maxTokens must be at least 100", "warning");
								return;
							}
							config.maxTokens = num;
							break;
						}
						case "reasoning": {
							if (!VALID_REASONING_LEVELS.includes(value as ThinkingLevel)) {
								notify(ctx, "reasoning must be one of: minimal, low, medium, high, xhigh", "warning");
								return;
							}
							config.reasoning = value as ThinkingLevel;
							break;
						}
						case "maxContextMessages": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 4) {
								notify(ctx, "maxContextMessages must be at least 4", "warning");
								return;
							}
							config.maxContextMessages = num;
							break;
						}
						default:
							notify(ctx, "Unknown config key. Valid keys: models, provider, model, tools.enabled, tools.allowlist, tools.maxCalls, maxUsesPerRun, maxTokens, reasoning, maxContextMessages", "warning");
							return;
					}

					saveConfig(config);
					notify(ctx, `Set ${key}=${value}`, "info");
					break;
				}

				case "ask": {
					if (!config.enabled) {
						notify(ctx, "Advisor is disabled. Use /advisor on to enable.", "warning");
						return;
					}
					const prompt = "Consult the advisor now using the current stage and recent evidence before proceeding.";
					if (ctx.isIdle()) {
						pi.sendUserMessage(prompt);
					} else {
						pi.sendUserMessage(prompt, { deliverAs: "steer" });
					}
					break;
				}

				default: {
					const status = themedStatus(ctx, config.enabled ? "success" : "dim", config.enabled ? "enabled" : "disabled");
					const lines = [
						`Advisor: ${status}`,
						`Models:    ${configuredModelsText(config)}`,
						`Tools:     ${config.tools.enabled ? "enabled" : "disabled"} (${config.tools.allowlist.join(", ")}; max ${config.tools.maxCalls})`,
						`Reasoning: ${config.reasoning}`,
						"",
						"Commands:",
						"  /advisor on [provider/model,...]  Enable advisor with ordered fallbacks",
						"  /advisor off                     Disable advisor",
						"  /advisor config                  Show full configuration",
						"  /advisor ask                     Trigger consultation",
					];
					notify(ctx, lines.join("\n"), "info");
				}
			}
		},
	});
}
