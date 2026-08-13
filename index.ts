import { compileStringEx, type CompileStringExResult } from "squint-cljs";

type Language = "cljs";

type TypeBox = {
	Type: {
		Object(properties: Record<string, unknown>): unknown;
		String(options?: Record<string, unknown>): unknown;
		Number(options?: Record<string, unknown>): unknown;
		Boolean(options?: Record<string, unknown>): unknown;
		Literal(value: string): unknown;
		Optional(schema: unknown): unknown;
	};
};

type SessionManager = {
	getSessionFile?: () => string | undefined;
	getSessionId?: () => string | undefined;
};

type ToolContext = {
	invokeTool?: (
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
	) => Promise<unknown>;
	sessionManager?: SessionManager;
};

export type ToolApi = {
	typebox: TypeBox;
	registerTool(tool: Record<string, unknown>): void;
};

type CljsEvalParams = {
	language: Language;
	code: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
};

export type CompileCljsOptions = {
	compilerState?: unknown;
};

export type CompileCljsCell = {
	code: string;
	compilerState: unknown;
};

const CORE_IMPORT = "import * as squint_core from 'squint-cljs/core.js';\n";

export const ENV_HELPER_MESSAGE =
	"Host environment is not available through eval helpers. Do not dump environment from a cell.";

const PRELUDE = `const CLJS_PRINT_LENGTH = 32;
const CLJS_PRINT_DEPTH = 4;
function cljsPrint(value, depth, seen) {
	if (value === null || value === undefined) return "nil";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "##NaN";
		if (value === Infinity) return "##Inf";
		if (value === -Infinity) return "##-Inf";
		return String(value);
	}
	if (typeof value === "bigint") return String(value) + "N";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "function") return "#function";
	if (typeof value === "symbol") return String(value);
	if (depth <= 0) return "...";
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "#circular";
	seen.add(value);
	try {
		const ctor = value.constructor && value.constructor.name;
		if (value instanceof Set) {
			const xs = Array.from(value);
			const more = xs.length > CLJS_PRINT_LENGTH;
			const body = xs.slice(0, CLJS_PRINT_LENGTH).map((item) => cljsPrint(item, depth - 1, seen)).join(" ");
			return "#{" + body + (more ? " ..." : "") + "}";
		}
		const sequential = Array.isArray(value) || ctor === "List" || ctor === "LazySeq" || ctor === "Cons";
		if (sequential) {
			const xs = Array.from(value);
			const more = xs.length > CLJS_PRINT_LENGTH;
			const body = xs.slice(0, CLJS_PRINT_LENGTH).map((item) => cljsPrint(item, depth - 1, seen)).join(" ");
			const open = ctor === "List" || ctor === "LazySeq" || ctor === "Cons" ? "(" : "[";
			const close = open === "(" ? ")" : "]";
			return open + body + (more ? " ..." : "") + close;
		}
		const keys = Object.keys(value);
		const more = keys.length > CLJS_PRINT_LENGTH;
		const body = keys.slice(0, CLJS_PRINT_LENGTH).map((key) => {
			const ident = /^[A-Za-z*+!_'?<>=/][A-Za-z0-9*+!_'?<>=/-]*$/.test(key) || key.includes("/");
			const printedKey = ident ? ":" + key : JSON.stringify(key);
			return printedKey + " " + cljsPrint(value[key], depth - 1, seen);
		}).join(" ");
		return "{" + body + (more ? " ..." : "") + "}";
	} finally {
		seen.delete(value);
	}
}
function pr(...values) {
	const text = values.map((value) => cljsPrint(value, CLJS_PRINT_DEPTH, new Set())).join(" ");
	display(text);
	return values.length <= 1 ? values[0] : values[values.length - 1];
}
async function sh(cmd) {
	const args = typeof cmd === "string" ? { command: cmd } : cmd;
	return await tool["bash"](args);
}
function bash() {
	throw new Error("There is no js/bash helper. Use (js-await (sh \\"command\\")) or the native bash tool.");
}
function env() {
	throw new Error(${JSON.stringify(ENV_HELPER_MESSAGE)});
}
`;

export const MISSING_NATIVE_EVAL_MESSAGE =
	'CLJS eval is unavailable: this session has no native "eval" tool delegation context (Task/scout/isolated agents often omit the JS backend). Use read, grep, glob, or bash. Do not retry eval.';

export const AWAIT_IN_SYNC_DEFN_MESSAGE =
	"js-await/js/await belongs in a top-level form, let, or ^:async defn. A sync defn cannot contain await.";
function rewriteCompileError(message: string): string {
	if (message.includes("EOF while reading, expected )")) {
		return `CLJS reader error: ${message}. Check unmatched parentheses.`;
	}
	if (message.includes("EOF while reading, expected ]")) {
		return `CLJS reader error: ${message}. Check unmatched brackets.`;
	}
	if (message.includes("EOF while reading, expected }")) {
		return `CLJS reader error: ${message}. Check unmatched braces.`;
	}
	if (message.includes('EOF while reading, expected "')) {
		return `CLJS reader error: ${message}. Close the string.`;
	}
	if (message.includes("EOF while reading")) {
		return `CLJS reader error: ${message}. The form is incomplete.`;
	}
	if (message.startsWith("Unmatched delimiter:")) {
		return `CLJS reader error: ${message}. Remove the extra closer.`;
	}
	if (message.includes("Map literals must contain an even number of forms")) {
		return `CLJS reader error: ${message}. Map literals need key/value pairs.`;
	}
	if (message === "First argument to defn must be a symbol") {
		return "CLJS compile error: defn needs a name symbol, as in (defn foo [x] x).";
	}
	if (message === "Parameter declaration missing") {
		return "CLJS compile error: defn/fn needs a parameter vector, as in (defn foo [x] x).";
	}
	if (message.includes("is not ISeqable")) {
		return `CLJS compile error: ${message}. Expected a vector or sequential form (let bindings, require spec).`;
	}
	if (message.startsWith("Invalid symbol:")) {
		return `CLJS reader error: ${message || "invalid symbol"}. Check the reader token.`;
	}
	if (message.startsWith("Feature should be a keyword:")) {
		return `CLJS reader error: ${message}. Reader conditionals need a keyword feature, as in #?(:cljs ...).`;
	}
	return message;
}

export function applyCompilerStateResult(
	map: Map<string, unknown>,
	key: string,
	candidate: unknown,
	reset: boolean,
	result: unknown,
	threw = false,
): void {
	if (threw) {
		if (reset) map.delete(key);
		return;
	}
	const details =
		result && typeof result === "object" && "details" in result && result.details && typeof result.details === "object"
			? result.details
			: undefined;
	const isError = details !== undefined && "isError" in details && details.isError === true;
	if (reset) map.delete(key);
	if (!isError) map.set(key, candidate);
}


const CLJS_EXAMPLES = [
	{ caption: "Bare expression", code: "(+ 1 2)" },
	{ caption: "Define and display", code: "(def result (+ 1 2))\n(display result)" },
	{ caption: "Async read and JSON parse", code: '(js/JSON.parse (js-await (js/read "package.json")))' },
	{ caption: "Shell via sh", code: '(js-await (sh "git status --short"))' },
] as const;

const CLJS_BOUNDARIES = [
	"Prefer long-lived cljs cells over one-shot tools for multi-step work. Codemode is more effective long term than direct tools.",
	"Write direct Squint forms; do not wrap a cell in Vite or JavaScript module scaffolding.",
	"Every cell needs a final expression or display(...)/pr(...); a def alone has no visible output.",
	"Use display(...) or pr(...) for visible intermediate output and output(...) to inspect prior tool output.",
	"Top-level defs persist until reset: true; other cells can reuse them.",
	"Experimental compiler ns-state also persists until reset: true. It is best-effort and may not re-emit requires.",
	"Compiler aliases and project-local CLJS require resolution are unavailable; do not use Clojure require for project-local modules.",
	"Use js-await (or js/await). Bare await is not the special form. Keep it in a top-level form, let, or ^:async defn.",
	'Prefer (js-await (js/read "package.json")).',
	'(pr value) prints a truncated CLJS-shaped view and returns the value. (js-await (sh "git status")) calls the host bash tool via tool["bash"], not a child of the JS worker. There is no js/bash helper. There is no env helper.',
	'For names not valid CLJS identifiers, use (js-await ((aget tool "tool-name") {:arg "value"})).',
	"Multiple top-level forms execute in order; the final form supplies the cell result.",
	"If eval reports that the native backend is unavailable, stop. Do not retry eval. Use read, grep, glob, or bash.",
	"Do not use eval to discover cwd, env, or tool names, and do not write xd://report_issue from a cell.",
	"Do not expose host environment from a cell, including through delegated tools.",
] as const;

const compilerStateBySession = new Map<string, unknown>();

function sessionCompilerKey(ctx: ToolContext): string | undefined {
	const file = ctx.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) return `file:${file}`;
	const id = ctx.sessionManager?.getSessionId?.();
	if (typeof id === "string" && id.length > 0) return `id:${id}`;
	return undefined;
}

function splitLeadingImports(source: string): { header: string; rest: string } {
	const lines = source.split(/(?<=\n)/);
	let index = 0;
	let seenImport = false;
	while (index < lines.length) {
		const line = lines[index];
		if (/^\s*import\b/.test(line)) {
			seenImport = true;
			index += 1;
			continue;
		}
		if (seenImport && /^\s*$/.test(line)) {
			index += 1;
			continue;
		}
		break;
	}
	return { header: lines.slice(0, index).join(""), rest: lines.slice(index).join("") };
}

function rewriteCoreImport(compiled: CompileStringExResult): string {
	const imports = compiled.imports ?? "";
	const coreImportIndex = imports.indexOf(CORE_IMPORT);
	if (coreImportIndex < 0 || imports.indexOf(CORE_IMPORT, coreImportIndex + CORE_IMPORT.length) >= 0) {
		throw new Error("Squint compiler did not emit exactly one expected static core import");
	}
	const original = `${compiled.pragmas ?? ""}${imports}${compiled.body ?? ""}${compiled.exports ?? ""}`;
	if (original !== compiled.javascript) {
		throw new Error("Squint compiler returned an unsupported output layout");
	}
	const runtimeCoreImport = `import * as squint_core from ${JSON.stringify(import.meta.resolve("squint-cljs/core.js"))};\n`;
	const rewrittenImports =
		imports.slice(0, coreImportIndex) + runtimeCoreImport + imports.slice(coreImportIndex + CORE_IMPORT.length);
	return `${compiled.pragmas ?? ""}${rewrittenImports}${compiled.body ?? ""}${compiled.exports ?? ""}`;
}

function injectPrelude(javascript: string): string {
	const { header, rest } = splitLeadingImports(javascript);
	return `${header}${PRELUDE}${rest}`;
}

function skipJsString(javascript: string, start: number): number {
	const quote = javascript[start];
	let index = start + 1;
	while (index < javascript.length) {
		const char = javascript[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) return index + 1;
		index += 1;
	}
	return javascript.length;
}

function skipJsLineComment(javascript: string, start: number): number {
	const end = javascript.indexOf("\n", start);
	return end < 0 ? javascript.length : end + 1;
}

function skipJsBlockComment(javascript: string, start: number): number {
	const end = javascript.indexOf("*/", start + 2);
	return end < 0 ? javascript.length : end + 2;
}

function nextJsCodeIndex(javascript: string, start: number): number {
	const char = javascript[start];
	if (char === "'" || char === "\"" || char === "`") return skipJsString(javascript, start);
	if (char === "/" && javascript[start + 1] === "/") return skipJsLineComment(javascript, start);
	if (char === "/" && javascript[start + 1] === "*") return skipJsBlockComment(javascript, start);
	return start;
}

function isJsWordChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function findMatchingBrace(javascript: string, openIndex: number): number {
	let depth = 0;
	let index = openIndex;
	while (index < javascript.length) {
		const skipped = nextJsCodeIndex(javascript, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		const char = javascript[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
		index += 1;
	}
	return -1;
}

function isAsyncFunctionKeyword(javascript: string, functionIndex: number): boolean {
	let index = functionIndex;
	while (index > 0 && /\s/.test(javascript[index - 1] ?? "")) index -= 1;
	return index >= 5 && javascript.slice(index - 5, index) === "async" && !isJsWordChar(javascript[index - 6]);
}

function assertAwaitScope(javascript: string, start: number, end: number, asyncScope: boolean): void {
	let index = start;
	while (index < end) {
		const skipped = nextJsCodeIndex(javascript, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		if (javascript.startsWith("function", index) && !isJsWordChar(javascript[index - 1]) && !isJsWordChar(javascript[index + 8])) {
			const headerEnd = javascript.indexOf("{", index + 8);
			if (headerEnd < 0 || headerEnd >= end) return;
			const bodyEnd = findMatchingBrace(javascript, headerEnd);
			if (bodyEnd < 0 || bodyEnd > end) return;
			assertAwaitScope(javascript, headerEnd + 1, bodyEnd, isAsyncFunctionKeyword(javascript, index));
			index = bodyEnd + 1;
			continue;
		}
		if (
			javascript.startsWith("await", index) &&
			!isJsWordChar(javascript[index - 1]) &&
			!isJsWordChar(javascript[index + 5]) &&
			!asyncScope
		) {
			throw new Error(AWAIT_IN_SYNC_DEFN_MESSAGE);
		}
		index += 1;
	}
}

function assertNoAwaitInSyncFn(javascript: string): void {
	assertAwaitScope(javascript, 0, javascript.length, true);
}

function compileString(source: string, compilerState: unknown): CompileStringExResult {
	try {
		return compileStringEx(
			source,
			{
				context: "return",
				async: true,
				"elide-exports": true,
			},
			compilerState === undefined ? undefined : { "ns-state": compilerState },
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(rewriteCompileError(message));
	}
}

/**
 * Compile one complete cell through Squint's reader. Return context emits valid
 * statements for every form and returns only the effective final form, while
 * leaving top-level definitions in OMP's persistent JavaScript runtime.
 */
export function compileCljsCell(source: string, options: CompileCljsOptions = {}): CompileCljsCell {
	const compiled = compileString(source, options.compilerState);
	const rewritten = rewriteCoreImport(compiled);
	assertNoAwaitInSyncFn(rewritten);
	return { code: injectPrelude(rewritten), compilerState: compiled["ns-state"] };
}

export function compileCljs(source: string, options: CompileCljsOptions = {}): string {
	return compileCljsCell(source, options).code;
}

function languageSchema(typebox: TypeBox): unknown {
	return typebox.Type.Literal("cljs");
}

function renderExampleCode(code: string): string {
	return code.includes("\n") ? `\"\"\"${code}\"\"\"` : JSON.stringify(code);
}

function modelGuidance(): string {
	const examples = CLJS_EXAMPLES.map(example =>
		`# ${example.caption}\n<example>\neval(language="cljs", code=${renderExampleCode(example.code)})\n</example>`,
	).join("\n");
	return [
		"Run one step of code in a persistent codemode runtime.",
		'Only "cljs" is accepted. Squint ClojureScript is compiled to the hidden JavaScript eval runtime.',
		"The hidden JavaScript backend must already be present; this tool cannot create one.",
		"CLJS is compiled directly to JavaScript, so display(), read(), write(), output(), tool, and async/await remain available.",
		...CLJS_BOUNDARIES,
		"The final CLJS expression uses the same result and error contract as JavaScript eval.",
		`<examples>\n${examples}\n</examples>`,
	].join("\n");
}

export function createCljsEvalTool(pi: ToolApi): Record<string, unknown> {
	const Type = pi.typebox.Type;
	const parameters = Type.Object({
		language: languageSchema(pi.typebox),
		code: Type.String({ description: "Code to run in this eval call, verbatim." }),
		title: Type.Optional(Type.String({ description: "Short label shown in the transcript." })),
		timeout: Type.Optional(Type.Number({ description: "Timeout for this eval call in seconds; 0 disables the cell timeout." })),
		reset: Type.Optional(Type.Boolean({ description: "Reset the selected language runtime before running." })),
	});

	return {
		name: "eval",
		label: "Eval",
		description: modelGuidance(),
		parameters,
		loadMode: "essential",
		strict: true,
		concurrency: "exclusive",
		execute: async (
			_toolCallId: string,
			params: CljsEvalParams,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: ToolContext,
		) => {
			if (params.language !== "cljs") {
				throw new Error(`CLJS eval only supports language "cljs"; received ${JSON.stringify(params.language)}`);
			}
			if (!ctx.invokeTool) {
				throw new Error(MISSING_NATIVE_EVAL_MESSAGE);
			}
			const key = sessionCompilerKey(ctx);
			const priorState = key === undefined ? undefined : compilerStateBySession.get(key);
			const compiled = compileCljsCell(params.code, {
				compilerState: params.reset === true ? undefined : priorState,
			});
			try {
				const result = await ctx.invokeTool(
					{ ...params, language: "js", code: compiled.code },
					{ signal, onUpdate },
				);
				if (key !== undefined) {
					applyCompilerStateResult(compilerStateBySession, key, compiled.compilerState, params.reset === true, result);
				}
				return result;
			} catch (error) {
				if (key !== undefined) {
					applyCompilerStateResult(compilerStateBySession, key, compiled.compilerState, params.reset === true, undefined, true);
				}
				throw error;
			}
		},
	};
}

export default function cljsCodemodeExtension(pi: ToolApi): void {
	pi.registerTool(createCljsEvalTool(pi));
}
