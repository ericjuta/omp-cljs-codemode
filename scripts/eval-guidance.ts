import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CASES = join(ROOT, "evals", "cases.json");
const DEFAULT_BASELINE = join(ROOT, "evals", "baseline-v0.1.1.json");
const DEFAULT_EXTENSION = join(ROOT, "index.ts");
const RESULTS_ROOT = join(ROOT, "evals", "results");
const PACKAGE_NAME = "@ericjuta/omp-cljs-codemode";
const MAX_CASE_TIME_MS = 120_000;
const MAX_JSONL_LINE_CHARS = 2_000_000;

type JsonRecord = Record<string, unknown>;

type EvalCallCount = {
	exact: number;
	min: number;
	max: number;
};

type GuidanceCase = {
	id: string;
	description: string;
	holdout: boolean;
	prompt: string;
	maxTimeMs: number;
	expectedFinalRegex: string;
	expectedEvalResultRegexes: string[];
	expectedEvalCodeRegexes: string[];
	expectedReset: Array<boolean | null>;
	evalCallCount: EvalCallCount;
	maxEvalErrors: number;
	allowedTools: string[];
	expectedLanguage: "cljs";
};

type GuidanceSuite = {
	schemaVersion: number;
	suite: string;
	cases: GuidanceCase[];
};

type BaselineCase = {
	id: string;
	prompt: string;
	promptSha256: string;
	finalText: string;
	evalCallCount: number;
	evalErrorCount: number;
};

type Baseline = {
	version: string;
	model: string;
	cases: BaselineCase[];
};

type EvalArgs = {
	language?: string;
	code?: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
};

type MutableEvalCall = {
	args: EvalArgs;
	resultText?: string;
	isError?: boolean;
};

type SanitizedEvalCall = {
	args: EvalArgs;
	resultText: string;
	isError: boolean;
};

type Collector = {
	evalCalls: MutableEvalCall[];
	completedEvalCalls: Set<number>;
	pendingEvalCalls: Map<string, number>;
	toolNames: Set<string>;
	finalResponse: string;
	finalResponseSeen: boolean;
	parseErrors: number;
};

type CaseResult = {
	id: string;
	promptSha256: string;
	holdout: boolean;
	evalCalls: SanitizedEvalCall[];
	evalCallCount: number;
	evalErrorCount: number;
	finalResponse: string;
	exitStatus: number | null;
	durationMs: number;
	timedOut: boolean;
	passed: boolean;
	failures: string[];
	recordable: boolean;
};

type CliOptions = {
	model?: string;
	casesPath: string;
	baselinePath: string;
	extensionPath: string;
	outputPath?: string;
	recordBaselineVersion?: string;
	help: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireText(record: JsonRecord, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`${context}.${key} must be a string`);
	return value;
}

function requireString(record: JsonRecord, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${context}.${key} must be a non-empty string`);
	return value;
}

function requireInteger(record: JsonRecord, key: string, context: string): number {
	const value = record[key];
	if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${context}.${key} must be a non-negative integer`);
	return value as number;
}

function assertValidRegex(pattern: string, context: string): void {
	try {
		new RegExp(pattern, "u");
	} catch (error) {
		throw new Error(`${context} is invalid: ${String(error)}`);
	}
}

function requireRegexArray(record: JsonRecord, key: string, context: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || !value.every(pattern => typeof pattern === "string")) {
		throw new Error(`${context}.${key} must be a string array`);
	}
	const patterns = value as string[];
	for (const [index, pattern] of patterns.entries()) assertValidRegex(pattern, `${context}.${key}[${index}]`);
	return [...patterns];
}

function requireResetArray(record: JsonRecord, key: string, context: string): Array<boolean | null> {
	const value = record[key];
	if (!Array.isArray(value) || !value.every(reset => typeof reset === "boolean" || reset === null)) {
		throw new Error(`${context}.${key} must be an array of booleans or null`);
	}
	return [...value] as Array<boolean | null>;
}

function parseSuite(value: unknown): GuidanceSuite {
	if (!isRecord(value) || !Array.isArray(value.cases)) throw new Error("cases file must contain a cases array");
	const ids = new Set<string>();
	const cases = value.cases.map((entry, index): GuidanceCase => {
		const context = `cases[${index}]`;
		if (!isRecord(entry)) throw new Error(`${context} must be an object`);
		const id = requireString(entry, "id", context);
		if (ids.has(id)) throw new Error(`duplicate case id: ${id}`);
		ids.add(id);
		if (!isRecord(entry.evalCallCount)) throw new Error(`${context}.evalCallCount must be an object`);
		const evalCallCount = {
			exact: requireInteger(entry.evalCallCount, "exact", `${context}.evalCallCount`),
			min: requireInteger(entry.evalCallCount, "min", `${context}.evalCallCount`),
			max: requireInteger(entry.evalCallCount, "max", `${context}.evalCallCount`),
		};
		if (evalCallCount.min > evalCallCount.exact || evalCallCount.exact > evalCallCount.max) {
			throw new Error(`${context}.evalCallCount must satisfy min <= exact <= max`);
		}
		const maxTimeMs = requireInteger(entry, "maxTimeMs", context);
		if (maxTimeMs === 0 || maxTimeMs > MAX_CASE_TIME_MS) {
			throw new Error(`${context}.maxTimeMs must be between 1 and ${MAX_CASE_TIME_MS}`);
		}
		if (!Array.isArray(entry.allowedTools) || !entry.allowedTools.every(tool => typeof tool === "string")) {
			throw new Error(`${context}.allowedTools must be a string array`);
		}
		if (entry.expectedLanguage !== "cljs") throw new Error(`${context}.expectedLanguage must be "cljs"`);
		const expectedEvalResultRegexes = requireRegexArray(entry, "expectedEvalResultRegexes", context);
		const expectedEvalCodeRegexes = requireRegexArray(entry, "expectedEvalCodeRegexes", context);
		const expectedReset = requireResetArray(entry, "expectedReset", context);
		if (expectedEvalResultRegexes.length !== evalCallCount.exact) {
			throw new Error(`${context}.expectedEvalResultRegexes length must equal evalCallCount.exact (${evalCallCount.exact})`);
		}
		if (expectedEvalCodeRegexes.length !== evalCallCount.exact) {
			throw new Error(`${context}.expectedEvalCodeRegexes length must equal evalCallCount.exact (${evalCallCount.exact})`);
		}
		if (expectedReset.length !== evalCallCount.exact) {
			throw new Error(`${context}.expectedReset length must equal evalCallCount.exact (${evalCallCount.exact})`);
		}
		const expectedFinalRegex = requireString(entry, "expectedFinalRegex", context);
		assertValidRegex(expectedFinalRegex, `${context}.expectedFinalRegex`);
		return {
			id,
			description: requireString(entry, "description", context),
			holdout: entry.holdout === true,
			prompt: requireString(entry, "prompt", context),
			maxTimeMs,
			expectedFinalRegex,
			expectedEvalResultRegexes,
			expectedEvalCodeRegexes,
			expectedReset,
			evalCallCount,
			maxEvalErrors: requireInteger(entry, "maxEvalErrors", context),
			allowedTools: [...entry.allowedTools] as string[],
			expectedLanguage: "cljs",
		};
	});
	return {
		schemaVersion: requireInteger(value, "schemaVersion", "suite"),
		suite: requireString(value, "suite", "suite"),
		cases,
	};
}

function parseBaseline(value: unknown): Baseline {
	if (!isRecord(value) || !Array.isArray(value.cases) || value.cases.length === 0) {
		throw new Error("baseline must contain at least one case");
	}
	const ids = new Set<string>();
	const cases = value.cases.map((entry, index): BaselineCase => {
		const context = `baseline.cases[${index}]`;
		if (!isRecord(entry)) throw new Error(`${context} must be an object`);
		const id = requireString(entry, "id", context);
		if (ids.has(id)) throw new Error(`duplicate baseline case id: ${id}`);
		ids.add(id);
		const prompt = requireString(entry, "prompt", context);
		const promptSha256 = requireString(entry, "promptSha256", context);
		if (!/^[0-9a-f]{64}$/u.test(promptSha256)) {
			throw new Error(`${context}.promptSha256 must be a lowercase SHA-256 digest`);
		}
		if (sha256(prompt) !== promptSha256) {
			throw new Error(`${context}.promptSha256 does not match ${context}.prompt`);
		}
		return {
			id,
			prompt,
			promptSha256,
			finalText: requireText(entry, "finalText", context),
			evalCallCount: requireInteger(entry, "evalCallCount", context),
			evalErrorCount: requireInteger(entry, "evalErrorCount", context),
		};
	});
	return {
		version: requireString(value, "version", "baseline"),
		model: requireString(value, "model", "baseline"),
		cases,
	};
}

function readOption(argv: string[], index: number, name: string): { value: string; next: number } | undefined {
	const arg = argv[index];
	if (arg === name) {
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
		return { value, next: index + 1 };
	}
	const prefix = `${name}=`;
	if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), next: index };
	return undefined;
}

function resolveInputPath(path: string): string {
	return resolve(ROOT, path);
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveOutputPath(path: string): string {
	const absolute = resolve(ROOT, path);
	if (isWithin(ROOT, absolute) && !isWithin(RESULTS_ROOT, absolute)) {
		throw new Error("--output may not overwrite repository source; use evals/results/ or a path outside the repository");
	}
	return absolute;
}

function parseCli(argv: string[]): CliOptions {
	const options: CliOptions = {
		casesPath: DEFAULT_CASES,
		baselinePath: DEFAULT_BASELINE,
		extensionPath: DEFAULT_EXTENSION,
		help: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		let parsed = readOption(argv, index, "--model");
		if (parsed) {
			options.model = parsed.value;
			index = parsed.next;
			continue;
		}
		parsed = readOption(argv, index, "--cases");
		if (parsed) {
			options.casesPath = resolveInputPath(parsed.value);
			index = parsed.next;
			continue;
		}
		parsed = readOption(argv, index, "--baseline");
		if (parsed) {
			options.baselinePath = resolveInputPath(parsed.value);
			index = parsed.next;
			continue;
		}
		parsed = readOption(argv, index, "--extension");
		if (parsed) {
			options.extensionPath = resolveInputPath(parsed.value);
			index = parsed.next;
			continue;
		}
		parsed = readOption(argv, index, "--output");
		if (parsed) {
			options.outputPath = resolveOutputPath(parsed.value);
			index = parsed.next;
			continue;
		}
		parsed = readOption(argv, index, "--record-baseline");
		if (parsed) {
			const version = parsed.value.trim();
			if (version.length === 0) throw new Error("--record-baseline requires a non-empty version");
			options.recordBaselineVersion = version;
			index = parsed.next;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	if (!options.help && options.recordBaselineVersion !== undefined && !options.outputPath) {
		throw new Error("--record-baseline requires --output");
	}
	return options;
}

function printUsage(): void {
	console.log(`Usage: bun scripts/eval-guidance.ts --model <provider/model> [options]

Options:
  --model <model>             Required unless CLJS_CODEMODE_EVAL_MODEL is set
  --cases <path>              Case file (default: evals/cases.json)
  --baseline <path>           Sanitized baseline (default: evals/baseline-v0.1.1.json)
  --extension <path>          Extension entry point (default: index.ts)
  --output <path>             Write sanitized results (repository paths must be under evals/results/)
  --record-baseline <version> Write a complete baseline to --output without comparing a prior baseline
  -h, --help                  Show this help`);
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await Bun.file(path).text());
}

function sanitizeEvalArgs(value: unknown): EvalArgs {
	if (!isRecord(value)) return {};
	const args: EvalArgs = {};
	if (typeof value.language === "string") args.language = value.language;
	if (typeof value.code === "string") args.code = value.code;
	if (typeof value.title === "string") args.title = value.title;
	if (typeof value.timeout === "number" && Number.isFinite(value.timeout)) args.timeout = value.timeout;
	if (typeof value.reset === "boolean") args.reset = value.reset;
	return args;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	if (typeof value.content === "string") return value.content;
	if (!Array.isArray(value.content)) return "";
	return value.content
		.filter(block => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map(block => (block as JsonRecord).text as string)
		.join("");
}

function assistantHasToolCall(message: JsonRecord): boolean {
	return Array.isArray(message.content) && message.content.some(block => isRecord(block) && block.type === "toolCall");
}

function observeFinalAssistant(message: JsonRecord, collector: Collector): boolean {
	if (message.role !== "assistant" || assistantHasToolCall(message)) return false;
	const response = textContent(message);
	if (response.trim().length > 0 || !collector.finalResponseSeen) collector.finalResponse = response;
	collector.finalResponseSeen = true;
	return response.trim().length > 0;
}

function createCollector(): Collector {
	return {
		evalCalls: [],
		completedEvalCalls: new Set(),
		pendingEvalCalls: new Map(),
		toolNames: new Set(),
		finalResponse: "",
		finalResponseSeen: false,
		parseErrors: 0,
	};
}

function observeEvent(value: unknown, collector: Collector): void {
	if (!isRecord(value) || typeof value.type !== "string") return;
	if (value.type === "tool_execution_start") {
		if (typeof value.toolName !== "string") return;
		collector.toolNames.add(value.toolName);
		if (value.toolName !== "eval") return;
		const index = collector.evalCalls.push({ args: sanitizeEvalArgs(value.args) }) - 1;
		if (typeof value.toolCallId === "string") collector.pendingEvalCalls.set(value.toolCallId, index);
		return;
	}
	if (value.type === "tool_execution_end" && value.toolName === "eval") {
		if (typeof value.toolCallId !== "string") return;
		const index = collector.pendingEvalCalls.get(value.toolCallId);
		if (index === undefined) return;
		const call = collector.evalCalls[index];
		const result = isRecord(value.result) ? value.result : undefined;
		const details = result && isRecord(result.details) ? result.details : undefined;
		call.resultText = textContent(value.result);
		call.isError = value.isError === true || result?.isError === true || details?.isError === true;
		collector.completedEvalCalls.add(index);
		collector.pendingEvalCalls.delete(value.toolCallId);
		return;
	}
	if (value.type === "message_end" && isRecord(value.message)) {
		observeFinalAssistant(value.message, collector);
		return;
	}
	if (value.type === "agent_end" && Array.isArray(value.messages)) {
		for (let index = value.messages.length - 1; index >= 0; index--) {
			const message = value.messages[index];
			if (isRecord(message) && observeFinalAssistant(message, collector)) return;
		}
	}
}

function parseJsonLine(line: string, collector: Collector): void {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	try {
		observeEvent(JSON.parse(trimmed), collector);
	} catch {
		collector.parseErrors++;
	}
}

function feedJsonl(text: string, collector: Collector, state: { buffer: string; dropping: boolean }, final: boolean): void {
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\n") continue;
		const segment = text.slice(start, index).replace(/\r$/, "");
		if (state.dropping) {
			state.dropping = false;
			state.buffer = "";
		} else if (state.buffer.length + segment.length > MAX_JSONL_LINE_CHARS) {
			collector.parseErrors++;
			state.buffer = "";
		} else {
			parseJsonLine(state.buffer + segment, collector);
			state.buffer = "";
		}
		start = index + 1;
	}
	const rest = text.slice(start);
	if (!state.dropping) {
		if (state.buffer.length + rest.length > MAX_JSONL_LINE_CHARS) {
			collector.parseErrors++;
			state.buffer = "";
			state.dropping = true;
		} else {
			state.buffer += rest;
		}
	}
	if (final && !state.dropping && state.buffer.length > 0) parseJsonLine(state.buffer, collector);
}

async function collectJsonl(stream: ReadableStream<Uint8Array>, collector: Collector): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const state = { buffer: "", dropping: false };
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			feedJsonl(decoder.decode(value, { stream: true }), collector, state, false);
		}
		feedJsonl(decoder.decode(), collector, state, true);
	} catch (error) {
		collector.parseErrors++;
		throw error;
	} finally {
		reader.releaseLock();
	}
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (!(await reader.read()).done) {
			// Deliberately discard stderr; it can contain provider internals.
		}
	} finally {
		reader.releaseLock();
	}
}

function sanitizeCalls(collector: Collector): SanitizedEvalCall[] {
	return collector.evalCalls.map(call => ({
		args: call.args,
		resultText: call.resultText ?? "",
		isError: call.isError ?? true,
	}));
}

function gradeCase(
	testCase: GuidanceCase,
	collector: Collector,
	exitStatus: number | null,
	timedOut: boolean,
	runtimeFailures: string[],
): { passed: boolean; failures: string[]; calls: SanitizedEvalCall[] } {
	const failures = [...runtimeFailures];
	const calls = sanitizeCalls(collector);
	if (timedOut) failures.push(`exceeded ${testCase.maxTimeMs}ms case limit`);
	if (exitStatus !== 0) failures.push(`omp exit status was ${String(exitStatus)}`);
	if (collector.parseErrors > 0) failures.push(`${collector.parseErrors} JSONL record(s) were invalid or oversized`);
	if (!collector.finalResponseSeen) failures.push("no terminal assistant response was observed");
	if (!new RegExp(testCase.expectedFinalRegex, "u").test(collector.finalResponse.trim())) {
		failures.push(`final response did not match /${testCase.expectedFinalRegex}/u`);
	}
	const count = calls.length;
	const expected = testCase.evalCallCount;
	if (count !== expected.exact || count < expected.min || count > expected.max) {
		failures.push(`eval call count ${count}; expected exact ${expected.exact} within [${expected.min}, ${expected.max}]`);
	}
	for (const [index, call] of calls.entries()) {
		const resultPattern = testCase.expectedEvalResultRegexes[index];
		if (resultPattern !== undefined && !new RegExp(resultPattern, "u").test(call.resultText.trim())) {
			failures.push(`eval call ${index + 1} result did not match /${resultPattern}/u`);
		}
		const codePattern = testCase.expectedEvalCodeRegexes[index];
		if (codePattern !== undefined && !new RegExp(codePattern, "u").test(call.args.code ?? "")) {
			failures.push(`eval call ${index + 1} source code did not match /${codePattern}/u`);
		}
		const expectedReset = testCase.expectedReset[index];
		const effectiveReset = call.args.reset ?? false;
		if (expectedReset !== undefined && expectedReset !== null && effectiveReset !== expectedReset) {
			failures.push(`eval call ${index + 1} effective reset was ${effectiveReset}; expected ${expectedReset}`);
		}
	}
	const evalErrorCount = calls.filter(call => call.isError).length;
	if (evalErrorCount > testCase.maxEvalErrors) {
		failures.push(`eval error count ${evalErrorCount}; maximum ${testCase.maxEvalErrors}`);
	}
	if (collector.completedEvalCalls.size !== calls.length) failures.push("one or more eval calls had no result");
	if (calls.some(call => call.args.language !== testCase.expectedLanguage)) {
		failures.push(`every eval call must use language ${testCase.expectedLanguage}`);
	}
	if ([...collector.toolNames].some(tool => !testCase.allowedTools.includes(tool))) {
		failures.push("a disallowed top-level tool was called");
	}
	return { passed: failures.length === 0, failures, calls };
}

async function runCase(testCase: GuidanceCase, model: string, extensionPath: string): Promise<CaseResult> {
	const fixture = await mkdtemp(join(tmpdir(), "omp-cljs-guidance-"));
	const started = performance.now();
	try {
		await Bun.write(join(fixture, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME }, null, 2)}\n`);
		const collector = createCollector();
		const runtimeFailures: string[] = [];
		let exitStatus: number | null = null;
		let timedOut = false;
		try {
			const child = Bun.spawn(
				[
					"omp",
					"--no-session",
					"--mode",
					"json",
					"--auto-approve",
					"--no-extensions",
					"-e",
					extensionPath,
					"--tools",
					"eval",
					"--model",
					model,
					"--max-time",
					String(Math.ceil(testCase.maxTimeMs / 1000)),
					testCase.prompt,
				],
				{ cwd: fixture, stdout: "pipe", stderr: "pipe" },
			);
			let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
			let terminationPromise: Promise<number> | undefined;
			const terminateAndReap = (): Promise<number> => {
				if (terminationPromise) return terminationPromise;
				terminationPromise = (async () => {
					try {
						child.kill(15);
					} catch {}
					hardKillTimer = setTimeout(() => {
						try {
							child.kill(9);
						} catch {}
					}, 1_000);
					try {
						return await child.exited;
					} finally {
						if (hardKillTimer) {
							clearTimeout(hardKillTimer);
							hardKillTimer = undefined;
						}
					}
				})();
				return terminationPromise;
			};
			const timeoutTimer = setTimeout(() => {
				timedOut = true;
				void terminateAndReap().catch(() => {});
			}, testCase.maxTimeMs);
			const stdoutPromise = collectJsonl(child.stdout, collector);
			const stderrPromise = drain(child.stderr);
			try {
				const [status] = await Promise.all([child.exited, stdoutPromise, stderrPromise]);
				exitStatus = status;
			} catch (error) {
				runtimeFailures.push(`omp stream or process failure: ${error instanceof Error ? error.message : String(error)}`);
				try {
					exitStatus = await terminateAndReap();
				} catch (terminationError) {
					runtimeFailures.push(`failed to reap omp: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`);
				}
				await Promise.allSettled([stdoutPromise, stderrPromise]);
			} finally {
				clearTimeout(timeoutTimer);
				if (terminationPromise) {
					try {
						exitStatus ??= await terminationPromise;
					} catch (terminationError) {
						runtimeFailures.push(`failed to reap omp: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`);
					}
				}
			}
		} catch (error) {
			runtimeFailures.push(`failed to invoke omp: ${error instanceof Error ? error.message : String(error)}`);
		}
		const grade = gradeCase(testCase, collector, exitStatus, timedOut, runtimeFailures);
		const recordable =
			runtimeFailures.length === 0 &&
			!timedOut &&
			exitStatus === 0 &&
			collector.parseErrors === 0 &&
			collector.finalResponseSeen &&
			collector.completedEvalCalls.size === collector.evalCalls.length;
		return {
			id: testCase.id,
			promptSha256: sha256(testCase.prompt),
			holdout: testCase.holdout,
			evalCalls: grade.calls,
			evalCallCount: grade.calls.length,
			evalErrorCount: grade.calls.filter(call => call.isError).length,
			finalResponse: collector.finalResponse,
			exitStatus,
			durationMs: Math.round(performance.now() - started),
			timedOut,
			passed: grade.passed,
			failures: grade.failures,
			recordable,
		};
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}

function assertBaselineCompatible(baseline: Baseline, suite: GuidanceSuite, model: string): void {
	if (baseline.model !== model) {
		throw new Error(`baseline model mismatch: expected ${baseline.model}, current model is ${model}`);
	}
	const suiteById = new Map(suite.cases.map(testCase => [testCase.id, testCase]));
	const missing = baseline.cases.filter(entry => !suiteById.has(entry.id)).map(entry => entry.id);
	if (missing.length > 0) throw new Error(`baseline cases missing from suite: ${missing.join(", ")}`);
	const baselineIds = new Set(baseline.cases.map(entry => entry.id));
	const unbaselined = suite.cases.filter(testCase => !baselineIds.has(testCase.id)).map(testCase => testCase.id);
	if (unbaselined.length > 0) throw new Error(`suite cases missing from baseline: ${unbaselined.join(", ")}`);
	for (const entry of baseline.cases) {
		const testCase = suiteById.get(entry.id);
		if (!testCase) continue;
		if (entry.prompt !== testCase.prompt || entry.promptSha256 !== sha256(testCase.prompt)) {
			throw new Error(`baseline prompt/hash drift for case ${entry.id}`);
		}
	}
}

function buildRecordedBaseline(version: string, model: string, suite: GuidanceSuite, results: CaseResult[]): Baseline {
	const byId = new Map(results.map(result => [result.id, result]));
	return {
		version,
		model,
		cases: suite.cases.map(testCase => {
			const result = byId.get(testCase.id);
			if (!result) throw new Error(`missing result for case ${testCase.id}`);
			return {
				id: testCase.id,
				prompt: testCase.prompt,
				promptSha256: result.promptSha256,
				finalText: result.finalResponse,
				evalCallCount: result.evalCallCount,
				evalErrorCount: result.evalErrorCount,
			};
		}),
	};
}

function printBaselineComparison(baseline: Baseline, results: CaseResult[]): number {
	const byId = new Map(results.map(result => [result.id, result]));
	const overlap = baseline.cases.flatMap(entry => {
		const current = byId.get(entry.id);
		return current ? [{ entry, current }] : [];
	});
	if (overlap.length !== baseline.cases.length) {
		const missing = baseline.cases.filter(entry => !byId.has(entry.id)).map(entry => entry.id);
		throw new Error(`baseline cases missing from suite: ${missing.join(", ")}`);
	}
	const beforeCalls = overlap.reduce((sum, item) => sum + item.entry.evalCallCount, 0);
	const afterCalls = overlap.reduce((sum, item) => sum + item.current.evalCallCount, 0);
	const beforeErrors = overlap.reduce((sum, item) => sum + item.entry.evalErrorCount, 0);
	const afterErrors = overlap.reduce((sum, item) => sum + item.current.evalErrorCount, 0);
	const equalFinals = overlap.filter(item => item.entry.finalText.trim() === item.current.finalResponse.trim()).length;
	console.log(
		`baseline v${baseline.version} (${baseline.model}): overlap=${overlap.length} calls=${beforeCalls}->${afterCalls} errors=${beforeErrors}->${afterErrors} exact-final=${equalFinals}/${overlap.length}`,
	);
	for (const { entry, current } of overlap) {
		console.log(
			`  ${entry.id}: calls ${entry.evalCallCount}->${current.evalCallCount}, errors ${entry.evalErrorCount}->${current.evalErrorCount}, final ${entry.finalText.trim() === current.finalResponse.trim() ? "same" : "changed"}`,
		);
	}
	return overlap.length;
}

async function main(): Promise<void> {
	const options = parseCli(Bun.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}
	const model = (options.model ?? Bun.env.CLJS_CODEMODE_EVAL_MODEL)?.trim();
	if (!model) throw new Error("an explicit model is required via --model or CLJS_CODEMODE_EVAL_MODEL");
	const extensionStat = await stat(options.extensionPath).catch(() => undefined);
	if (!extensionStat?.isFile()) throw new Error(`extension entry point is not a file: ${options.extensionPath}`);
	const suite = await readJson(options.casesPath).then(parseSuite);
	const baseline = options.recordBaselineVersion === undefined
		? await readJson(options.baselinePath).then(parseBaseline)
		: undefined;
	if (baseline) assertBaselineCompatible(baseline, suite, model);
	const results: CaseResult[] = [];
	console.log(`model ${model}; suite ${suite.suite}`);
	for (const testCase of suite.cases) {
		const result = await runCase(testCase, model, options.extensionPath);
		results.push(result);
		console.log(
			`${result.passed ? "PASS" : "FAIL"} ${result.id}${result.holdout ? " [holdout]" : ""} eval=${result.evalCallCount} errors=${result.evalErrorCount} time=${result.durationMs}ms`,
		);
		if (!result.passed) console.log(`  ${result.failures.join("; ")}`);
	}
	const passed = results.filter(result => result.passed).length;
	console.log(`summary ${passed}/${results.length} passed`);
	if (options.recordBaselineVersion !== undefined) {
		if (!options.outputPath) throw new Error("--record-baseline requires --output");
		const unrecordable = results.filter(result => !result.recordable).map(result => result.id);
		if (unrecordable.length > 0) {
			throw new Error(`cannot record baseline after incomplete collection: ${unrecordable.join(", ")}`);
		}
		const artifact = buildRecordedBaseline(options.recordBaselineVersion, model, suite, results);
		await mkdir(dirname(options.outputPath), { recursive: true });
		await Bun.write(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
		console.log(`wrote ${options.outputPath}`);
	} else {
		if (!baseline) throw new Error("baseline is required outside record mode");
		const baselineOverlap = printBaselineComparison(baseline, results);
		if (options.outputPath) {
			await mkdir(dirname(options.outputPath), { recursive: true });
			const artifact = {
				schemaVersion: 1,
				suite: suite.suite,
				model,
				baseline: { version: baseline.version, model: baseline.model, overlap: baselineOverlap },
				summary: { total: results.length, passed, failed: results.length - passed },
				cases: results,
			};
			await Bun.write(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
			console.log(`wrote ${options.outputPath}`);
		}
	}
	if (options.recordBaselineVersion === undefined && passed !== results.length) process.exitCode = 1;
}

await main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
