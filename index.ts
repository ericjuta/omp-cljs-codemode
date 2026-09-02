import { parse } from "@babel/parser";
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

export type CodeModeBridge = {
	getDeclarations(): string | undefined;
};

type ToolContext = {
	invokeTool?: (
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
	) => Promise<unknown>;
};

export type ToolApi = {
	typebox: TypeBox;
	hasNativeTool?(name: string): boolean;
	registerTool(tool: Record<string, unknown>): void;
};

type CljsEvalParams = {
	language: Language;
	code: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
};

const CORE_IMPORT = "import * as squint_core from 'squint-cljs/core.js';\n";
const SQUINT_PACKAGE_PREFIX = "squint-cljs/";
const SQUINT_NAMESPACE_IMPORTS = {
	"clojure.string": "squint-cljs/src/squint/string.js",
	"clojure.set": "squint-cljs/src/squint/set.js",
} as const;

export const ENV_HELPER_MESSAGE =
	"Host environment is not available through eval helpers. Do not dump environment from a cell.";

export const MISSING_BASH_MESSAGE =
	'sh needs the host "bash" tool, but this session does not expose bash. Do not retry.';

const PRELUDE = `const CLJS_PRINT_LENGTH = 32;
const CLJS_PRINT_DEPTH = 4;
const cljs$$nodeUtilTypesIsPromise = process.getBuiltinModule("node:util").types.isPromise;
function cljsTake(value, limit) {
	const xs = [];
	if (Array.isArray(value) && value.constructor === Array) {
		return { xs: value.slice(0, limit), more: value.length > limit };
	}
	const iterator = value && typeof value[Symbol.iterator] === "function" ? value[Symbol.iterator]() : null;
	if (!iterator || typeof iterator.next !== "function") return { xs, more: false };
	try {
		while (xs.length < limit) {
			const step = iterator.next();
			if (!step || step.done) return { xs, more: false };
			xs.push(step.value);
		}
		const extra = iterator.next();
		return { xs, more: Boolean(extra) && extra.done !== true };
	} finally {
		if (typeof iterator.return === "function") {
			try { iterator.return(); } catch (ignored) {}
		}
	}
}
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
	if (value instanceof Date) return '#inst "' + value.toISOString() + '"';
	if (value instanceof RegExp) return "#" + String(value);
	if (typeof value !== "object") return String(value);
	if (depth <= 0) return "...";
	if (seen.has(value)) return "#circular";
	seen.add(value);
	try {
		if (cljs$$nodeUtilTypesIsPromise(value)) return "#js/Promise";
		const ctor = value.constructor && value.constructor.name;
		if (ctor === "Atom") {
			return "#atom " + cljsPrint(value.val, depth - 1, seen);
		}
		if (ctor === "Reduced") {
			return "#reduced " + cljsPrint(value.value, depth - 1, seen);
		}
		if (ctor === "ExceptionInfo" || value instanceof Error) {
			const parts = [":message " + JSON.stringify(value.message || "")];
			if (value._data !== undefined) parts.push(":data " + cljsPrint(value._data, depth - 1, seen));
			if (value._cause !== undefined && value._cause !== null) parts.push(":cause " + cljsPrint(value._cause, depth - 1, seen));
			return "#error {" + parts.join(" ") + "}";
		}
		if (value instanceof Map) {
			const taken = cljsTake(value, CLJS_PRINT_LENGTH);
			const body = taken.xs.map((entry) => {
				const pair = Array.isArray(entry) ? entry : [undefined, undefined];
				return cljsPrint(pair[0], depth - 1, seen) + " " + cljsPrint(pair[1], depth - 1, seen);
			}).join(", ");
			return "#js/Map {" + body + (taken.more ? " ..." : "") + "}";
		}
		if (ArrayBuffer.isView(value)) {
			const bytes = Array.prototype.slice.call(value, 0, CLJS_PRINT_LENGTH);
			const more = value.length > CLJS_PRINT_LENGTH;
			const tag = value.constructor && value.constructor.name ? value.constructor.name : "TypedArray";
			return "#" + tag + " [" + bytes.join(" ") + (more ? " ..." : "") + "]";
		}
		if (value instanceof Set) {
			const taken = cljsTake(value, CLJS_PRINT_LENGTH);
			const body = taken.xs.map((item) => cljsPrint(item, depth - 1, seen)).join(" ");
			return "#{" + body + (taken.more ? " ..." : "") + "}";
		}
		const listLike = ctor === "List" || ctor === "LazySeq" || ctor === "Cons" || ctor === "LazyIterable";
		const trueArray = Array.isArray(value) && value.constructor === Array;
		const iterableSeq = typeof value[Symbol.iterator] === "function" && ctor !== "Object" && !(value instanceof Map);
		const sequential = trueArray || listLike || iterableSeq;
		if (sequential) {
			const taken = cljsTake(value, CLJS_PRINT_LENGTH);
			const body = taken.xs.map((item) => cljsPrint(item, depth - 1, seen)).join(" ");
			const open = trueArray ? "[" : "(";
			const close = open === "(" ? ")" : "]";
			return open + body + (taken.more ? " ..." : "") + close;
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
	if (typeof tool === "undefined" || !tool) {
		throw new Error(${JSON.stringify(MISSING_BASH_MESSAGE)});
	}
	const call = tool["bash"];
	if (typeof call !== "function") {
		throw new Error(${JSON.stringify(MISSING_BASH_MESSAGE)});
	}
	try {
		const args = typeof cmd === "string" ? { command: cmd } : cmd;
		return await call(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Unknown tool from js runtime: bash")) {
			throw new Error(${JSON.stringify(MISSING_BASH_MESSAGE)});
		}
		throw error;
	}
}
function bash() {
	throw new Error("There is no js/bash helper. Use (js-await (sh \\"command\\")) or the native bash tool.");
}
function env() {
	throw new Error(${JSON.stringify(ENV_HELPER_MESSAGE)});
}
`;

export const MISSING_NATIVE_EVAL_MESSAGE =
	'CLJS eval is unavailable: this session has no native "eval" tool delegation context (Task/scout/isolated agents often omit the JS backend). Do not retry eval. Use an available direct tool such as read, grep, or glob instead.';

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
	if (message.includes("cond requires an even number of forms")) {
		return "CLJS compile error: cond requires an even number of forms (test/expression pairs).";
	}
	if (message.startsWith("Unsupported binding form:")) {
		return `CLJS compile error: ${message}. Check the binding vector syntax.`;
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

const CLJS_EXAMPLES = [
	{ caption: "Bare expression", code: "(+ 1 2)" },
	{ caption: "Define and display", code: "(def result (+ 1 2))\n(display result)" },
	{ caption: "js-await a promise", code: "(js-await (js/Promise.resolve 3))" },
	{ caption: "Shell via sh", code: '(js-await (sh "git status --short"))' },
	{ caption: "CLJS-shaped print", code: "(pr (atom {:n 1}))" },
] as const;

const CLJS_BOUNDARIES = [
	"Use cljs for retained cells, in-cell transforms, and JavaScript interop. Use host read, grep, and bash directly when they are exposed. If a direct tool returns empty or fails, a cljs cell with JavaScript interop is a fallback.",
	"Write direct Squint forms; do not wrap a cell in Vite or JavaScript module scaffolding.",
	"Every cell needs a final expression or display(...)/pr(...); a def alone has no visible output.",
	"Use display(...) or pr(...) for visible intermediate output and output(...) to inspect prior tool output.",
	"display(...) uses the native formatter while pr(...) renders CLJS shapes; reach for pr(...) when CLJS-shaped output matters.",
	"Top-level defs persist until reset: true; other cells can reuse them.",
	"Prefer str/replace after :as str. Do not :refer replace and call it bare.",
	"Project-local CLJS require and path resolution are unavailable; do not use Clojure require for project-local modules. Session :as aliases from a prior cell may persist until reset: true.",
	"Use js-await (or js/await). Bare await is not the special form. Keep it in a top-level form, let, or ^:async defn.",
	"Squint has no js->clj; clj->js works. Shape JavaScript values into CLJS with vec, aget, and js-keys.",
	"The eval-local read(path, offset?, limit?) helper reads regular files only. It does not expand ~ and does not support directory reads. Use direct host read when exposed, or bridged tool.read in Code Mode, for host read semantics.",
	'(pr value) prints a truncated CLJS-shaped view and returns the value. (js-await (sh "git status")) calls the host bash tool via tool["bash"], not a child of the JS worker. sh calls tool["bash"] only when bash is exposed and fails closed otherwise. There is no js/bash helper. There is no env helper.',
	'For bridged tools, use (js-await ((aget tool "tool-name") (clj->js {:arg "value"}))).',
	"Multiple top-level forms execute in order; the final form supplies the cell result.",
	"If eval reports that the native backend is unavailable, stop. Do not retry eval. Use an available direct tool such as read, grep, or glob instead.",
	"Do not use eval to discover cwd, env, or tool names, and do not write xd://report_issue from a cell.",
	"Do not expose host environment from a cell, including through delegated tools.",
] as const;

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

type JavaScriptNode = {
	type: string;
	start: number;
	end: number;
};

type StringModuleSpecifierNode = JavaScriptNode & {
	type: "Literal";
	value: string;
};

type GeneratedJavaScriptAnalysis = {
	moduleSpecifiers: StringModuleSpecifierNode[];
};

type BabelParseFailure = SyntaxError & {
	reasonCode?: string;
	pos?: number;
};

const GENERATED_JAVASCRIPT_PARSE_OPTIONS = {
	sourceType: "module" as const,
	allowReturnOutsideFunction: true,
	allowAwaitOutsideFunction: true,
	allowImportExportEverywhere: true,
	allowNewTargetOutsideFunction: true,
	allowSuperOutsideMethod: true,
	allowUndeclaredExports: true,
	errorRecovery: true,
	createImportExpressions: true,
	plugins: ["typescript", "estree", "explicitResourceManagement"] as [
		"typescript",
		"estree",
		"explicitResourceManagement",
	],
};

function isJavaScriptNode(value: unknown): value is JavaScriptNode {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<JavaScriptNode>;
	return typeof candidate.type === "string" && typeof candidate.start === "number" && typeof candidate.end === "number";
}

/**
 * Whether `await` is allowed inside `node[field]`. Only a function body opens an
 * async context; parameter defaults, class field values (including private
 * fields), and static blocks never do, while computed class keys evaluate in
 * the surrounding context.
 */
function childAsyncScope(node: JavaScriptNode, field: string, asyncScope: boolean): boolean {
	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
			return field === "body" && (node as JavaScriptNode & { async: boolean }).async;
		case "PropertyDefinition":
		case "ClassProperty":
		case "ClassPrivateProperty":
			return field === "key" && asyncScope;
		case "StaticBlock":
			return false;
		default:
			return asyncScope;
	}
}

function walkGeneratedJavaScript(
	node: JavaScriptNode,
	asyncScope: boolean,
	visit: (node: JavaScriptNode, asyncScope: boolean) => void,
): void {
	visit(node, asyncScope);
	const fields = node as unknown as Record<string, unknown>;
	for (const key in fields) {
		if (!Object.hasOwn(fields, key)) continue;
		const value = fields[key];
		if (Array.isArray(value)) {
			const scope = childAsyncScope(node, key, asyncScope);
			for (const child of value) {
				if (isJavaScriptNode(child)) walkGeneratedJavaScript(child, scope, visit);
			}
		} else if (isJavaScriptNode(value)) {
			walkGeneratedJavaScript(value, childAsyncScope(node, key, asyncScope), visit);
		}
	}
}

/**
 * After stripping a fatal `await`, the owning `for` is the ForOfStatement whose
 * header span covers that token. Trivia between `for` and `await` (comments or
 * whitespace) stays inside `[node.start, left.start)`.
 */
function asyncScopeOfPatchedForOf(program: JavaScriptNode, awaitPos: number): boolean | undefined {
	let found: boolean | undefined;
	walkGeneratedJavaScript(program, true, (node, asyncScope) => {
		if (found !== undefined || node.type !== "ForOfStatement") return;
		const left = (node as JavaScriptNode & { left?: unknown }).left;
		if (!isJavaScriptNode(left)) return;
		if (node.start <= awaitPos && awaitPos + 5 <= left.start) found = asyncScope;
	});
	return found;
}

/**
 * Babel throws on sync `for await` instead of recovering an Await/ForOf node.
 * Relabel only when the patched `for` is a ForOfStatement in a non-async scope.
 * Malformed `for await` (including `for await (;;)`) keeps Babel's parse error.
 */
function isFatalSyncForAwait(error: unknown, javascript: string): error is BabelParseFailure {
	if (!(error instanceof SyntaxError)) return false;
	const failure = error as BabelParseFailure;
	if (failure.reasonCode !== "UnexpectedToken" || typeof failure.pos !== "number") return false;
	if (!javascript.startsWith("await", failure.pos)) return false;
	const patched = `${javascript.slice(0, failure.pos)}     ${javascript.slice(failure.pos + 5)}`;
	let program: JavaScriptNode;
	try {
		program = parse(patched, GENERATED_JAVASCRIPT_PARSE_OPTIONS).program as JavaScriptNode;
	} catch {
		return false;
	}
	return asyncScopeOfPatchedForOf(program, failure.pos) === false;
}

function moduleSpecifierNode(node: JavaScriptNode): StringModuleSpecifierNode | undefined {
	if (
		node.type !== "ImportDeclaration" &&
		node.type !== "ImportExpression" &&
		node.type !== "ExportNamedDeclaration" &&
		node.type !== "ExportAllDeclaration"
	) {
		return undefined;
	}
	const source = (node as JavaScriptNode & { source: unknown }).source;
	if (!isJavaScriptNode(source) || source.type !== "Literal") return undefined;
	const literal = source as JavaScriptNode & { type: "Literal"; value?: unknown };
	return typeof literal.value === "string" ? (literal as StringModuleSpecifierNode) : undefined;
}

function traverseGeneratedJavaScript(
	node: JavaScriptNode,
	asyncScope: boolean,
	analysis: GeneratedJavaScriptAnalysis,
): void {
	walkGeneratedJavaScript(node, asyncScope, (current, scope) => {
		const containsAwaitSyntax =
			current.type === "AwaitExpression" ||
			(current.type === "ForOfStatement" && (current as JavaScriptNode & { await: boolean }).await) ||
			(current.type === "VariableDeclaration" && (current as JavaScriptNode & { kind: string }).kind === "await using");
		if (containsAwaitSyntax && !scope) {
			throw new Error(AWAIT_IN_SYNC_DEFN_MESSAGE);
		}
		const specifier = moduleSpecifierNode(current);
		if (specifier !== undefined) analysis.moduleSpecifiers.push(specifier);
	});
}

function analyzeGeneratedJavaScript(javascript: string): GeneratedJavaScriptAnalysis {
	let program: JavaScriptNode;
	try {
		program = parse(javascript, GENERATED_JAVASCRIPT_PARSE_OPTIONS).program as JavaScriptNode;
	} catch (error) {
		if (isFatalSyncForAwait(error, javascript)) {
			throw new Error(AWAIT_IN_SYNC_DEFN_MESSAGE);
		}
		throw error;
	}
	const analysis: GeneratedJavaScriptAnalysis = { moduleSpecifiers: [] };
	traverseGeneratedJavaScript(program, true, analysis);
	analysis.moduleSpecifiers.sort((left, right) => left.start - right.start);
	return analysis;
}

function rewriteSquintModuleSpecifiers(
	javascript: string,
	moduleSpecifiers: readonly StringModuleSpecifierNode[],
): string {
	let rewritten = "";
	let copiedThrough = 0;
	for (const node of moduleSpecifiers) {
		const specifier = node.value;
		const target = specifier.startsWith(SQUINT_PACKAGE_PREFIX)
			? specifier
			: Object.hasOwn(SQUINT_NAMESPACE_IMPORTS, specifier)
				? SQUINT_NAMESPACE_IMPORTS[specifier as keyof typeof SQUINT_NAMESPACE_IMPORTS]
				: undefined;
		if (target === undefined) continue;
		rewritten += javascript.slice(copiedThrough, node.start);
		rewritten += JSON.stringify(import.meta.resolve(target));
		copiedThrough = node.end;
	}
	return copiedThrough === 0 ? javascript : rewritten + javascript.slice(copiedThrough);
}

function rewriteSquintImports(compiled: CompileStringExResult): string {
	const imports = compiled.imports ?? "";
	const coreImportIndex = imports.indexOf(CORE_IMPORT);
	if (coreImportIndex < 0 || imports.indexOf(CORE_IMPORT, coreImportIndex + CORE_IMPORT.length) >= 0) {
		throw new Error("Squint compiler did not emit exactly one expected static core import");
	}
	const original = `${compiled.pragmas ?? ""}${imports}${compiled.body ?? ""}${compiled.exports ?? ""}`;
	if (original !== compiled.javascript) {
		throw new Error("Squint compiler returned an unsupported output layout");
	}
	const analysis = analyzeGeneratedJavaScript(original);
	return rewriteSquintModuleSpecifiers(original, analysis.moduleSpecifiers);
}

function injectPrelude(javascript: string): string {
	const { header, rest } = splitLeadingImports(javascript);
	return `${header}${PRELUDE}${rest}`;
}

function compileString(source: string): CompileStringExResult {
	try {
		return compileStringEx(source, {
			context: "return",
			async: true,
			"elide-exports": true,
		});
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
export function compileCljs(source: string): string {
	const compiled = compileString(source);
	const rewritten = rewriteSquintImports(compiled);
	return injectPrelude(rewritten);
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

function codeModeGuidance(baseDescription: string, declarations: string): string {
	return [
		baseDescription,
		"",
		"Code Mode is active: this eval tool is the primary work surface and the direct tool surface is restricted.",
		"Tools declared below are hidden from direct calls. Invoke them from CLJS through the live tool bridge, not through raw filesystem or process APIs.",
		'Call one bridged tool with (js-await ((aget tool "read") (clj->js {:path "package.json"}))).',
		'For independent calls, pass their promises to js/Promise.all, for example #js [((aget tool "read") (clj->js {:path "a.txt"})) ((aget tool "read") (clj->js {:path "b.txt"}))].',
		"Promise.all returns a JavaScript array. Access it with vec, aget, or (range (.-length results)) plus indexed aget. Do not use array-seq.",
		"The eval-local read(path, offset?, limit?) helper remains regular-file-only, does not expand ~, and cannot read directories. Bridged tool.read follows the live host schema below.",
		"Reserve separate cells for steps that must inspect earlier results.",
		"",
		"Live bridged tool declarations:",
		"```ts",
		"declare const tool: {",
		declarations,
		"};",
		"```",
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
	let codeModeBridge: CodeModeBridge | undefined;

	return {
		name: "eval",
		label: "Eval",
		get description() {
			const baseDescription = modelGuidance();
			const declarations = codeModeBridge?.getDeclarations();
			return declarations === undefined ? baseDescription : codeModeGuidance(baseDescription, declarations);
		},
		parameters,
		loadMode: "essential",
		strict: true,
		codeModeActivation: "all-models",
		setCodeModeBridge: (bridge: CodeModeBridge) => {
			codeModeBridge = bridge;
		},
		supportsCodeModeTransport: () => codeModeBridge !== undefined,
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
			const code = compileCljs(params.code);
			return await ctx.invokeTool({ ...params, language: "js", code }, { signal, onUpdate });
		},
	};
}

export default function cljsCodemodeExtension(pi: ToolApi): void {
	pi.registerTool(createCljsEvalTool(pi));
}
