/**
 * System prompt construction with pre-LLM file discovery and style detection.
 * Optimized for SN66 Ninja diff-overlap scoring.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

// ─── Keyword extraction helpers ────────────────────────────────────────

const NOISE = new Set([
	"the", "and", "for", "with", "that", "this", "from", "should", "must", "when",
	"each", "into", "also", "have", "been", "will", "they", "them", "their", "there",
	"which", "what", "where", "while", "would", "could", "these", "those", "then",
	"than", "some", "more", "other", "only", "just", "like", "such", "make", "made",
	"does", "doing", "being", "about", "after", "before", "between", "through",
	"during", "without", "within", "along", "above", "below",
]);

function extractKeywords(text: string): string[] {
	const kw = new Set<string>();
	// backtick contents
	for (const m of text.matchAll(/`([^`]{2,80})`/g)) kw.add(m[1].trim());
	// camelCase
	for (const m of text.matchAll(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g)) kw.add(m[0]);
	// snake_case
	for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) kw.add(m[0]);
	// kebab-case
	for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g)) kw.add(m[0]);
	// SCREAMING_CASE
	for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) kw.add(m[0]);
	return [...kw].filter(k => k.length >= 3 && k.length <= 80 && !NOISE.has(k.toLowerCase())).slice(0, 25);
}

function extractFilePaths(text: string): string[] {
	const paths = new Set<string>();
	// path-like patterns
	for (const m of text.matchAll(/(?:^|[\s"'`(\[])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/gm)) {
		paths.add(m[1].trim().replace(/^\.\//, ""));
	}
	// backtick file references
	for (const m of text.matchAll(/`([^`]+)`/g)) {
		const inner = m[1].trim();
		if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) {
			paths.add(inner.replace(/^\.\//, ""));
		}
	}
	return [...paths];
}

// ─── Acceptance criteria counter ───────────────────────────────────────

function countCriteria(text: string): number {
	const section = text.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (section) {
		const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return bullets ? bullets.length : 0;
	}
	const allBullets = text.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return allBullets ? Math.min(allBullets.length, 20) : 0;
}

// ─── Style detection ───────────────────────────────────────────────────

function detectStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 50);
		if (lines.length === 0) return null;

		let tabs = 0, spaces = 0;
		const widths = new Map<number, number>();
		for (const ln of lines) {
			if (/^\t/.test(ln)) tabs++;
			else if (/^ +/.test(ln)) {
				spaces++;
				const m = ln.match(/^( +)/);
				if (m) {
					const w = m[1].length;
					if (w === 2 || w === 4 || w === 8) widths.set(w, (widths.get(w) || 0) + 1);
				}
			}
		}
		let indent = "unknown";
		if (tabs > spaces) indent = "tabs";
		else if (spaces > 0) {
			let best = 2, bestN = 0;
			for (const [w, n] of widths) { if (n > bestN) { bestN = n; best = w; } }
			indent = `${best}-space`;
		}

		const sq = (content.match(/'/g) || []).length;
		const dq = (content.match(/"/g) || []).length;
		const quotes = sq > dq * 1.5 ? "single" : dq > sq * 1.5 ? "double" : "mixed";

		let codeLn = 0, semiLn = 0;
		for (const ln of lines) {
			const t = ln.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLn++;
			if (t.endsWith(";")) semiLn++;
		}
		const semis = codeLn === 0 ? "unknown" : semiLn / codeLn > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";

		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch { return null; }
}

// ─── Shell helper ──────────────────────────────────────────────────────

function esc(s: string): string { return s.replace(/[\\"`$]/g, "\\$&"); }

// ─── Pre-LLM file discovery ───────────────────────────────────────────

const SOURCE_GLOBS =
	'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md" --include="*.scala" --include="*.dart" --include="*.sh"';

const DIR_EXCLUDES = "grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/'";

function discoverFiles(taskText: string, cwd: string): string {
	try {
		const keywords = extractKeywords(taskText);
		const explicitPaths = extractFilePaths(taskText);

		if (keywords.length === 0 && explicitPaths.length === 0) return "";

		// Grep each keyword to find relevant files
		const hits = new Map<string, Set<string>>();
		for (const kw of keywords) {
			try {
				const out = execSync(
					`grep -rlF "${esc(kw)}" ${SOURCE_GLOBS} . 2>/dev/null | ${DIR_EXCLUDES} | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (out) {
					for (const line of out.split("\n")) {
						const f = line.trim().replace(/^\.\//, "");
						if (!f) continue;
						if (!hits.has(f)) hits.set(f, new Set());
						hits.get(f)!.add(kw);
					}
				}
			} catch {}
		}

		// Verify explicit paths exist
		const verified: string[] = [];
		for (const p of explicitPaths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) verified.push(p);
			} catch {}
		}

		if (hits.size === 0 && verified.length === 0) return "";

		const ranked = [...hits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const out: string[] = [];

		if (verified.length > 0) {
			out.push("EXPLICITLY NAMED FILES (start here):");
			for (const p of verified) out.push(`  - ${p}`);
		}
		if (ranked.length > 0) {
			out.push("\nRANKED BY KEYWORD HITS:");
			for (const [f, kws] of ranked) out.push(`  - ${f} (${[...kws].slice(0, 4).join(", ")})`);
		}

		// Detect style of the top file
		const topFile = verified[0] || ranked[0]?.[0];
		if (topFile) {
			const style = detectStyle(cwd, topFile);
			if (style) {
				out.push(`\nSTYLE OF ${topFile}: ${style}`);
				out.push("Match this style character-for-character in all edits.");
			}
		}

		// Criteria count and mode signal
		const nCriteria = countCriteria(taskText);
		if (nCriteria > 0) {
			out.push(`\n${nCriteria} acceptance criteria detected.`);
			if (nCriteria <= 2) {
				out.push("SMALL-TASK: target one primary file; check for one sibling if needed.");
			} else {
				out.push("MULTI-FILE: map each criterion to a file. Cover all files breadth-first.");
			}
		}

		// Named files reminder
		const named = extractFilePaths(taskText);
		if (named.length > 0) {
			out.push(`\nFiles referenced in task: ${named.map(f => `\`${f}\``).join(", ")}`);
		}

		out.push("\nPriority: (1) acceptance criteria, (2) named files, (3) sibling wiring.");
		out.push("Literality: prefer the most boring, literal continuation of nearby code patterns.");

		return "\n\n" + out.join("\n") + "\n";
	} catch {}
	return "";
}

// ─── Scoring preamble ──────────────────────────────────────────────────

const SCORING_PREAMBLE = `# Precision Diff Aligner

Your diff is scored against a hidden oracle diff via positional line-matching.
Overlap scoring rewards matching changed lines in the same order. Surplus edits and misaligned lines score zero. No semantic bonus. No test credit.

## Constraints

- First response MUST be a tool call. No prose, no planning text.
- No tests, builds, linters, formatters, servers, git operations.
- Keep discovery brief: grep + find, then read/edit.
- Read every file before editing it.
- Implement only what the task explicitly requests.
- Choose the most boring, literal continuation of existing patterns.

## Mode Selection

### Mode A — Small Task
When: 1-2 criteria AND one obvious primary file.
Flow: read primary -> minimal edit -> check one sibling -> stop.

### Mode B — Multi-File
When: 3+ criteria OR multiple files named.
Flow: map criteria to files -> breadth-first (one edit per file) -> fill gaps only if criteria remain.

### Boundary
If exactly one Mode A condition fails: start Mode A with mandatory sibling check.
Switch to Mode B only if that check reveals a required second file.

## File Selection

- Named files are high-priority to inspect, not automatic edit targets.
- Edit extra files only with explicit signal: named in task, acceptance criterion, or required wiring.
- No speculative edits. If uncertain, make the highest-probability minimal edit and continue.

## Ordering

- Multi-file: breadth-first. One edit per file before returning to any file.
- Alphabetical path order to reduce diff variance.
- Within a file: top-to-bottom.

## Discovery

- Use grep/find with exact task keywords. Short keyword list.
- Sibling-directory checks only when a change likely needs wiring/types/config.
- Mode A: edit after 2 discovery steps. Mode B: edit after 3 discovery steps.

## Style and Edits

- Match local style exactly (indent, quotes, semicolons, commas, wrapping).
- Minimal, local changes. No reordering, no broad rewrites.
- \`edit\` for existing files; \`write\` only for explicitly requested new files.
- Short oldText anchors (3-5 lines). On failure, re-read then retry.
- Append new entries to the END of existing lists/arrays/enums.

## Final Check

Before stopping: each acceptance criterion has an edit. No required file is missed. No unnecessary changes. Then stop immediately.

## Anti-Stall

If no edit after discovery + one read: immediately apply the highest-probability minimal edit. Further exploration has diminishing returns.

---

`;

// ─── Exported builder ──────────────────────────────────────────────────

export interface BuildSystemPromptOptions {
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	cwd?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		const discovery = discoverFiles(customPrompt, resolvedCwd);
		let prompt = SCORING_PREAMBLE + discovery + customPrompt;

		if (appendSection) prompt += appendSection;

		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		const hasRead = !selectedTools || selectedTools.includes("read");
		if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);

		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		return prompt;
	}

	// Default mode (non-tau invocation)
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList = visibleTools.length > 0
		? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
		: "(none)";

	const guidelinesList: string[] = [];
	const seen = new Set<string>();
	const add = (g: string) => { if (!seen.has(g)) { seen.add(g); guidelinesList.push(g); } };

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) add("Use bash for file operations like ls, rg, find");
	else if (hasBash && (hasGrep || hasFind || hasLs)) add("Prefer grep/find/ls tools over bash for file exploration");

	for (const g of promptGuidelines ?? []) { const n = g.trim(); if (n) add(n); }
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = SCORING_PREAMBLE + `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
${toolsList}

Guidelines:
${guidelines}

Pi documentation (read only when asked about pi itself):
- Main: ${readmePath}
- Docs: ${docsPath}
- Examples: ${examplesPath}`;

	if (appendSection) prompt += appendSection;

	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	return prompt;
}
