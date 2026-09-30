/** Model configuration and ordered fallback helpers for advisor calls. */

export interface AdvisorModelRef {
	provider: string;
	model: string;
}

export type AdvisorAttempt<T> =
	| { ok: true; value: T }
	| { ok: false; message: string };

export type AdvisorFallbackResult<C, T> =
	| {
			ok: true;
			candidate: C;
			value: T;
			attempted: C[];
			failures: Array<{ candidate: C; message: string }>;
		}
	| {
			ok: false;
			attempted: C[];
			failures: Array<{ candidate: C; message: string }>;
		};

export interface AdvisorFallbackOptions {
	/** Abort/cancellation errors should stop rather than fall through. */
	shouldRethrow?: (error: unknown) => boolean;
	/** Keep provider error summaries bounded and redactable at the caller boundary. */
	formatError?: (error: unknown) => string;
}

export function formatAdvisorModel(model: AdvisorModelRef): string {
	return `${model.provider}/${model.model}`;
}

/** Parse provider/model, splitting only on the first slash because model IDs may contain slashes. */
export function parseAdvisorModelRef(value: unknown): AdvisorModelRef | undefined {
	if (typeof value === "string") {
		const text = value.trim();
		const slash = text.indexOf("/");
		if (slash <= 0 || slash === text.length - 1) return undefined;
		const provider = text.slice(0, slash).trim();
		const model = text.slice(slash + 1).trim();
		return provider && model ? { provider, model } : undefined;
	}

	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.model !== "string") return undefined;
	const provider = record.provider.trim();
	const model = record.model.trim();
	return provider && model ? { provider, model } : undefined;
}

function parseModelValues(value: unknown): AdvisorModelRef[] {
	if (Array.isArray(value)) return value.flatMap((item) => parseModelValues(item));

	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return [];

		// Permit a JSON array in advisor.json or /advisor config models=[...].
		if (text.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(text);
				return parseModelValues(parsed);
			} catch {
				return [];
			}
		}

		return text.split(",").flatMap((item) => {
			const model = parseAdvisorModelRef(item);
			return model ? [model] : [];
		});
	}

	const model = parseAdvisorModelRef(value);
	return model ? [model] : [];
}

function dedupeModels(models: AdvisorModelRef[]): AdvisorModelRef[] {
	const seen = new Set<string>();
	return models.filter((model) => {
		const key = formatAdvisorModel(model);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Parse a user-provided comma-separated or JSON model list. */
export function parseAdvisorModelList(value: string): AdvisorModelRef[] {
	return dedupeModels(parseModelValues(value));
}

/**
 * Normalize the new `models` setting and migrate the legacy provider/model pair.
 * Invalid entries are ignored; callers can reject an empty result when enabling.
 */
export function normalizeAdvisorModels(
	modelsValue: unknown,
	legacyProvider?: unknown,
	legacyModel?: unknown,
): AdvisorModelRef[] {
	const models = dedupeModels(parseModelValues(modelsValue));
	if (models.length > 0) return models;

	const legacy = parseAdvisorModelRef({ provider: legacyProvider, model: legacyModel });
	return legacy ? [legacy] : [];
}

/** Run candidates in order until one returns a successful result. */
export async function runWithAdvisorFallback<C, T>(
	candidates: readonly C[],
	attempt: (candidate: C) => Promise<AdvisorAttempt<T>>,
	options: AdvisorFallbackOptions = {},
): Promise<AdvisorFallbackResult<C, T>> {
	const attempted: C[] = [];
	const failures: Array<{ candidate: C; message: string }> = [];

	for (const candidate of candidates) {
		attempted.push(candidate);
		let result: AdvisorAttempt<T>;
		try {
			result = await attempt(candidate);
		} catch (error) {
			if (options.shouldRethrow?.(error)) throw error;
			const message = options.formatError?.(error) ?? (error instanceof Error ? error.message : String(error));
			failures.push({ candidate, message });
			continue;
		}
		if (result.ok) {
			return { ok: true, candidate, value: result.value, attempted, failures };
		}
		failures.push({ candidate, message: result.message });
	}

	return { ok: false, attempted, failures };
}
