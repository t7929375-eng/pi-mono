/**
 * Agent loop with SN66-optimized runtime steering.
 * Combines time pressure, breadth-first enforcement, and edit-failure recovery.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	void runAgentLoop(prompts, context, config, async (event) => { stream.push(event); }, signal, streamFn)
		.then((messages) => { stream.end(messages); });
	return stream;
}

export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
	if (context.messages[context.messages.length - 1].role === "assistant")
		throw new Error("Cannot continue from message role: assistant");

	const stream = createAgentStream();
	void runAgentLoopContinue(context, config, async (event) => { stream.push(event); }, signal, streamFn)
		.then((messages) => { stream.end(messages); });
	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMsgs: AgentMessage[] = [...prompts];
	const ctx: AgentContext = { ...context, messages: [...context.messages, ...prompts] };
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const p of prompts) {
		await emit({ type: "message_start", message: p });
		await emit({ type: "message_end", message: p });
	}
	await runLoop(ctx, newMsgs, config, signal, emit, streamFn);
	return newMsgs;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
	if (context.messages[context.messages.length - 1].role === "assistant")
		throw new Error("Cannot continue from message role: assistant");

	const newMsgs: AgentMessage[] = [];
	const ctx: AgentContext = { ...context };
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	await runLoop(ctx, newMsgs, config, signal, emit, streamFn);
	return newMsgs;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

// ─── Helpers ───────────────────────────────────────────────────────────

function steer(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function normPath(p: string): string { return p.replace(/^\.\//, ""); }

function extractTargetFiles(text: string): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	const patterns = [
		/EXPLICITLY NAMED FILES[^\n]*\n((?:\s+-\s+\S[^\n]*\n)+)/,
		/RANKED BY KEYWORD[^\n]*\n((?:\s+-\s+\S[^\n]*\n)+)/,
	];
	for (const re of patterns) {
		const match = text.match(re);
		if (!match) continue;
		const lineRe = /^\s+-\s+(\S[^(]*?)(?:\s+\(|\s*$)/gm;
		let m: RegExpExecArray | null;
		while ((m = lineRe.exec(match[1])) !== null) {
			const f = m[1].trim();
			if (f && !seen.has(f)) { seen.add(f); files.push(f); }
		}
	}
	return files;
}

// ─── Main loop ─────────────────────────────────────────────────────────

// Tunable constants
const MAX_RETRIES = 100;       // upstream error retries
const EDIT_FAIL_MAX = 2;       // per-file edit failure ceiling
const EMPTY_TURN_MAX = 2;      // retries when model outputs no tool calls
const MAX_COVERAGE_NUDGES = 2; // forced coverage re-prompts

// Time thresholds (ms) — data-driven from 305 duels analysis
// Winners avg 5.2s/round, losers 8.7s. Speed > quality.
const T_WARN    = 6_000;       // P75 of round time — nudge early
const T_URGENT  = 12_000;      // P85 — most duels done by now
const T_LATE    = 25_000;      // 99.6% of duels avg under 30s/round
const T_EXIT    = 120_000;     // save partial diff, don't burn 170s on nothing

async function runLoop(
	ctx: AgentContext,
	newMsgs: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let pending: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// ── State tracking ──
	let retries = 0;
	const editFails = new Map<string, number>();
	const failAnchors = new Map<string, string>();
	const failNotified = new Set<string>();

	let explorations = 0;           // reads/bashes before first edit
	let madeEdit = false;
	let emptyTurns = 0;

	const t0 = Date.now();
	let warnSent = false;
	let urgentSent = false;
	let lateSent = false;

	const readPaths = new Set<string>();
	const readCounts = new Map<string, number>();
	const editedPaths = new Set<string>();
	let lastEditFile = "";
	let consecutiveSameFile = 0;

	// Phase: discover → absorb → apply
	let phase: "discover" | "absorb" | "apply" = "discover";
	let targets: string[] = [];
	const absorbed = new Set<string>();

	// Extract expected files from system prompt
	const sysText = (ctx as any).systemPrompt || "";
	const expectedFiles = extractTargetFiles(sysText);
	if (expectedFiles.length === 0) {
		for (const msg of ctx.messages) {
			if (!("content" in msg) || !Array.isArray(msg.content)) continue;
			for (const blk of msg.content as any[]) {
				if (blk?.type === "text" && typeof blk.text === "string") {
					const found = extractTargetFiles(blk.text);
					if (found.length > 0) { expectedFiles.push(...found); break; }
				}
			}
			if (expectedFiles.length > 0) break;
		}
	}
	if (expectedFiles.length > 0) {
		targets = [...expectedFiles];
		phase = "absorb";
	}
	let coverageNudges = 0;
	let multiFileHint = false;
	let reviewDone = false;
	let lastRereadNudge = 0;

	const uneditedTargets = (): string[] => {
		return targets.filter(f => {
			const n = normPath(f);
			return !editedPaths.has(f) && !editedPaths.has(n) && !editedPaths.has("./" + n);
		});
	};

	// ── Outer loop ──
	while (true) {
		let hasTools = true;

		while (hasTools || pending.length > 0) {
			if (!firstTurn) await emit({ type: "turn_start" });
			else firstTurn = false;

			if (pending.length > 0) {
				for (const m of pending) {
					await emit({ type: "message_start", message: m });
					await emit({ type: "message_end", message: m });
					ctx.messages.push(m);
					newMsgs.push(m);
				}
				pending = [];
			}

			const msg = await streamAssistantResponse(ctx, config, signal, emit, streamFn);
			newMsgs.push(msg);

			if (msg.stopReason === "aborted") {
				await emit({ type: "turn_end", message: msg, toolResults: [] });
				await emit({ type: "agent_end", messages: newMsgs });
				return;
			}

			// Upstream error retry
			if (msg.stopReason === "error") {
				if (retries < MAX_RETRIES) {
					retries++;
					await emit({ type: "turn_end", message: msg, toolResults: [] });
					pending.push(steer("Upstream failure. Resume by calling a tool — only diffs count."));
					hasTools = false;
					continue;
				}
				await emit({ type: "turn_end", message: msg, toolResults: [] });
				await emit({ type: "agent_end", messages: newMsgs });
				return;
			}

			const calls = msg.content.filter((c) => c.type === "toolCall");
			// Fix Gemini hallucinated tool names
			for (const tc of calls) {
				if (tc.name === "EditEdits" || tc.name === "editEdits") (tc as { name: string }).name = "edit";
			}
			hasTools = calls.length > 0;

			// ── Empty turn handling ──
			if (!hasTools && emptyTurns < EMPTY_TURN_MAX) {
				const capped = msg.stopReason === "length";
				const idle = msg.stopReason === "stop" && !madeEdit;
				if (capped || idle) {
					emptyTurns++;
					await emit({ type: "turn_end", message: msg, toolResults: [] });
					pending.push(steer(
						capped
							? "Output budget hit with no tool call. Call `read` or `edit` now. Text scores nothing."
							: "No edits detected. Empty diff = zero score. Read the primary file, then edit it."
					));
					continue;
				}
			}

			// ── Forced coverage ──
			if (!hasTools && madeEdit && coverageNudges < MAX_COVERAGE_NUDGES) {
				const missing = uneditedTargets();
				if (missing.length > 0) {
					coverageNudges++;
					await emit({ type: "turn_end", message: msg, toolResults: [] });
					const list = missing.slice(0, 5).map(f => `\`${f}\``).join(", ");
					pending.push(steer(`Target files NOT yet edited: ${list}. Read each and apply changes. Missing a file forfeits its matched lines.`));
					hasTools = false;
					continue;
				}
			}

			// ── Execute tools ──
			const results: ToolResultMessage[] = [];
			if (hasTools) {
				results.push(...(await executeToolCalls(ctx, msg, config, signal, emit)));
				for (const r of results) { ctx.messages.push(r); newMsgs.push(r); }

				// ── Process edit results ──
				for (let i = 0; i < results.length; i++) {
					const tr = results[i];
					const tc = calls[i];
					if (!tc || tc.type !== "toolCall" || tc.name !== "edit") continue;
					const path = (tc.arguments as any)?.path;
					if (!path || typeof path !== "string") continue;

					if (tr.isError) {
						const cnt = (editFails.get(path) ?? 0) + 1;
						editFails.set(path, cnt);
						const anchor = (tc.arguments as any)?.old_string ?? (tc.arguments as any)?.oldText ?? "";
						if (anchor && failAnchors.get(path) === anchor && pending.length === 0) {
							pending.push(steer(`Same oldText failed twice on \`${path}\`. Call \`read\` to get fresh content.`));
						}
						failAnchors.set(path, anchor);
						if (cnt >= EDIT_FAIL_MAX && !failNotified.has(path)) {
							failNotified.add(path);
							pending.push(steer(`\`${path}\` failed ${cnt} edits. Re-read it, then use a short anchor (3-5 lines). Or switch to another file.`));
						}
					} else {
						editFails.set(path, 0);
						failAnchors.delete(path);
						const wasFirst = !madeEdit;
						madeEdit = true;
						explorations = 0;
						const np = normPath(path);
						editedPaths.add(path); editedPaths.add(np); editedPaths.add("./" + np);

						// Breadth tracking
						if (np === lastEditFile) consecutiveSameFile++;
						else { consecutiveSameFile = 1; lastEditFile = np; }

						const remaining = uneditedTargets();
						let hint = "";
						if (consecutiveSameFile >= 3 && remaining.length > 0) {
							hint = ` STOP editing \`${np}\` (${consecutiveSameFile} consecutive). ${remaining.length} file(s) need edits: ${remaining.slice(0, 5).map(f => `\`${f}\``).join(", ")}. Move NOW.`;
						} else if (remaining.length > 0) {
							hint = ` ${remaining.length} file(s) remain: ${remaining.slice(0, 5).map(f => `\`${f}\``).join(", ")}. Breadth > depth.`;
						}
						pending.push(steer(`\`${path}\` updated.${hint}`));

						if (wasFirst && !multiFileHint && (targets.length >= 4 || readPaths.size >= 4)) {
							multiFileHint = true;
							pending.push(steer("Multiple target paths detected. If any criterion still maps to an unedited file, continue there before stopping."));
						}
					}
				}

				// ── Connection error detection ──
				for (const tr of results) {
					if (tr.toolName === "bash" && !tr.isError) {
						const out = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
						if (out.includes("ConnectionRefusedError") || out.includes("ECONNREFUSED")) {
							pending.push(steer("No network in this environment. Use `read` and `edit` only."));
							break;
						}
					}
				}

				// ── Phase transitions ──
				if (phase === "discover") {
					for (const tr of results) {
						if (tr.toolName === "bash" && !tr.isError) {
							const out = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
							const found = out.split("\n").filter(l => l.trim().match(/\.\w+$/)).map(l => l.trim());
							if (found.length > 0) {
								targets = found.slice(0, 20);
								phase = "absorb";
								pending.push(steer(`Found ${targets.length} candidate files. Read each target before editing:\n${targets.slice(0, 10).map(p => `- ${p}`).join("\n")}`));
							}
						}
					}
				} else if (phase === "absorb") {
					for (let j = 0; j < results.length; j++) {
						const tr = results[j];
						const tc2 = calls[j];
						if (tr.toolName === "read" && !tr.isError && tc2?.type === "toolCall" && tc2.name === "read") {
							const rp = (tc2.arguments as any)?.path;
							if (rp) absorbed.add(rp);
						}
						if (tr.toolName === "edit" && !tr.isError) phase = "apply";
					}
					const absorbCap = Math.min(Math.max(3, targets.length > 10 ? 6 : 3), 8);
					if (absorbed.size >= absorbCap && phase === "absorb" && pending.length === 0) {
						phase = "apply";
						pending.push(steer(`${absorbed.size} files read. Start editing now — one edit per file, breadth-first.`));
					}
				}

				// ── Track exploration and reads ──
				for (let i = 0; i < results.length; i++) {
					const tr = results[i];
					const tc = calls[i];
					if ((tr.toolName === "read" || tr.toolName === "bash") && !tr.isError && !madeEdit) explorations++;
					if (tr.toolName === "read" && !tr.isError && tc?.type === "toolCall") {
						const rp = (tc.arguments as any)?.path;
						if (rp && typeof rp === "string") {
							readPaths.add(rp);
							readCounts.set(rp, (readCounts.get(rp) ?? 0) + 1);
						}
					}
				}

				// ── Re-read nudge ──
				const now = Date.now();
				if (now - lastRereadNudge >= 5_000 && pending.length === 0) {
					for (const [rp, cnt] of readCounts) {
						if (cnt >= 3) {
							lastRereadNudge = now;
							const others = uneditedTargets().filter(f => normPath(f) !== normPath(rp));
							pending.push(steer(`\`${rp}\` read ${cnt} times — stop. ${others.length > 0 ? `Move to: ${others.slice(0, 4).map(f => `\`${f}\``).join(", ")}.` : "Apply edit or stop."}`));
							break;
						}
					}
				}

				// ── Exploration ceiling ──
				const expCeiling = Math.max(3, Math.min(targets.length + 1, 6));
				if (!madeEdit && explorations >= expCeiling && pending.length === 0) {
					pending.push(steer(`${explorations} discovery steps done. Apply first edit to the highest-priority file now. Partial patch > empty diff.`));
					explorations = 0;
				}

				// ── Time pressure (no edit yet) ──
				if (!madeEdit && pending.length === 0) {
					const elapsed = Date.now() - t0;
					const readInfo = readPaths.size > 0 ? `Read so far: ${[...readPaths].slice(0, 4).join(", ")}. ` : "";
					if (!warnSent && elapsed >= T_WARN) {
						warnSent = true;
						pending.push(steer(`${Math.round(elapsed / 1000)}s without edits. Empty diff = zero. ${readInfo}Apply \`edit\` now.`));
					} else if (warnSent && !urgentSent && elapsed >= T_URGENT) {
						urgentSent = true;
						pending.push(steer(`${Math.round(elapsed / 1000)}s, still no edits. Time running out. ${readInfo}Edit immediately.`));
					} else if (urgentSent && !lateSent && elapsed >= T_LATE) {
						lateSent = true;
						pending.push(steer("50s+ without edits. Pick the clearest target and apply `edit` — further exploration won't help."));
					}
				}

				// ── Time pressure (has edits, but few files covered) ──
				if (madeEdit && pending.length === 0) {
					const elapsed = Date.now() - t0;
					const edited = new Set([...editedPaths].map(normPath));
					const remaining = uneditedTargets();
					if (remaining.length > 0 && elapsed > 30_000 && edited.size <= 2) {
						pending.push(steer(`30s+ and only ${edited.size} file(s) edited. ${remaining.length} targets remain: ${remaining.slice(0, 6).map(f => `\`${f}\``).join(", ")}. Edit them before revisiting.`));
					}
				}

				// ── Hard exit ──
				if ((Date.now() - t0) >= T_EXIT) {
					await emit({ type: "turn_end", message: msg, toolResults: results });
					await emit({ type: "agent_end", messages: newMsgs });
					return;
				}
			}

			await emit({ type: "turn_end", message: msg, toolResults: results });
			pending = (await config.getSteeringMessages?.()) || [];
		}

		// ── Follow-up check ──
		const followUp = (await config.getFollowUpMessages?.()) || [];
		if (followUp.length > 0) { pending = followUp; continue; }

		// ── Review pass ──
		const elapsed = Date.now() - t0;
		if (!reviewDone && madeEdit && elapsed < 60_000) {
			reviewDone = true;
			phase = "discover";
			const remaining = uneditedTargets();
			const hint = remaining.length > 0
				? `Unedited targets: ${remaining.slice(0, 5).map(f => `\`${f}\``).join(", ")}. Read and edit them.`
				: `Re-check acceptance criteria. Any missed file? If all covered, reply "done".`;
			pending = [steer(`REVIEW: edited ${editedPaths.size} file(s). ${hint}`)];
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMsgs });
}

// ─── LLM streaming (unchanged from stock) ──────────────────────────────

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	let messages = context.messages;
	if (config.transformContext) messages = await config.transformContext(messages, signal);
	const llmMessages = await config.convertToLlm(messages);
	const llmContext: Context = { systemPrompt: context.systemPrompt, messages: llmMessages, tools: context.tools };
	const streamFunction = streamFn || streamSimple;
	const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });

	let partial: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partial = event.partial;
				context.messages.push(partial);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partial } });
				break;
			case "text_start": case "text_delta": case "text_end":
			case "thinking_start": case "thinking_delta": case "thinking_end":
			case "toolcall_start": case "toolcall_delta": case "toolcall_end":
				if (partial) {
					partial = event.partial;
					context.messages[context.messages.length - 1] = partial;
					await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partial } });
				}
				break;
			case "done": case "error": {
				const final = await response.result();
				if (addedPartial) context.messages[context.messages.length - 1] = final;
				else context.messages.push(final);
				if (!addedPartial) await emit({ type: "message_start", message: { ...final } });
				await emit({ type: "message_end", message: final });
				return final;
			}
		}
	}

	const final = await response.result();
	if (addedPartial) context.messages[context.messages.length - 1] = final;
	else { context.messages.push(final); await emit({ type: "message_start", message: { ...final } }); }
	await emit({ type: "message_end", message: final });
	return final;
}

// ─── Tool execution (unchanged from stock) ──────────────────────────────

async function executeToolCalls(
	ctx: AgentContext, msg: AssistantMessage, config: AgentLoopConfig,
	signal: AbortSignal | undefined, emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const calls = msg.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") return execSeq(ctx, msg, calls, config, signal, emit);
	return execPar(ctx, msg, calls, config, signal, emit);
}

async function execSeq(
	ctx: AgentContext, msg: AssistantMessage, calls: AgentToolCall[],
	config: AgentLoopConfig, signal: AbortSignal | undefined, emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const tc of calls) {
		await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
		const prep = await prepareTC(ctx, msg, tc, config, signal);
		if (prep.kind === "immediate") {
			results.push(await emitResult(tc, prep.result, prep.isError, emit));
		} else {
			const exec = await runTC(prep, signal, emit);
			results.push(await finalizeTC(ctx, msg, prep, exec, config, signal, emit));
		}
	}
	return results;
}

async function execPar(
	ctx: AgentContext, msg: AssistantMessage, calls: AgentToolCall[],
	config: AgentLoopConfig, signal: AbortSignal | undefined, emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnable: PrepTC[] = [];
	for (const tc of calls) {
		await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
		const prep = await prepareTC(ctx, msg, tc, config, signal);
		if (prep.kind === "immediate") results.push(await emitResult(tc, prep.result, prep.isError, emit));
		else runnable.push(prep);
	}
	const running = runnable.map(p => ({ p, ex: runTC(p, signal, emit) }));
	for (const r of running) {
		const exec = await r.ex;
		results.push(await finalizeTC(ctx, msg, r.p, exec, config, signal, emit));
	}
	return results;
}

type PrepTC = { kind: "prepared"; toolCall: AgentToolCall; tool: AgentTool<any>; args: unknown };
type ImmTC = { kind: "immediate"; result: AgentToolResult<any>; isError: boolean };
type ExecResult = { result: AgentToolResult<any>; isError: boolean };

function prepArgs(tool: AgentTool<any>, tc: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) return tc;
	const pa = tool.prepareArguments(tc.arguments);
	return pa === tc.arguments ? tc : { ...tc, arguments: pa as Record<string, any> };
}

async function prepareTC(
	ctx: AgentContext, msg: AssistantMessage, tc: AgentToolCall,
	config: AgentLoopConfig, signal: AbortSignal | undefined,
): Promise<PrepTC | ImmTC> {
	const tool = ctx.tools?.find(t => t.name === tc.name);
	if (!tool) return { kind: "immediate", result: errResult(`Tool ${tc.name} not found`), isError: true };
	try {
		const prepared = prepArgs(tool, tc);
		const args = validateToolArguments(tool, prepared);
		if (config.beforeToolCall) {
			const before = await config.beforeToolCall({ assistantMessage: msg, toolCall: tc, args, context: ctx }, signal);
			if (before?.block) return { kind: "immediate", result: errResult(before.reason || "Blocked"), isError: true };
		}
		return { kind: "prepared", toolCall: tc, tool, args };
	} catch (e) {
		return { kind: "immediate", result: errResult(e instanceof Error ? e.message : String(e)), isError: true };
	}
}

async function runTC(prep: PrepTC, signal: AbortSignal | undefined, emit: AgentEventSink): Promise<ExecResult> {
	const updates: Promise<void>[] = [];
	try {
		const result = await prep.tool.execute(prep.toolCall.id, prep.args as never, signal, (partial) => {
			updates.push(Promise.resolve(emit({
				type: "tool_execution_update", toolCallId: prep.toolCall.id,
				toolName: prep.toolCall.name, args: prep.toolCall.arguments, partialResult: partial,
			})));
		});
		await Promise.all(updates);
		return { result, isError: false };
	} catch (e) {
		await Promise.all(updates);
		return { result: errResult(e instanceof Error ? e.message : String(e)), isError: true };
	}
}

async function finalizeTC(
	ctx: AgentContext, msg: AssistantMessage, prep: PrepTC, exec: ExecResult,
	config: AgentLoopConfig, signal: AbortSignal | undefined, emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let { result, isError } = exec;
	if (config.afterToolCall) {
		const after = await config.afterToolCall(
			{ assistantMessage: msg, toolCall: prep.toolCall, args: prep.args, result, isError, context: ctx }, signal,
		);
		if (after) {
			result = { content: after.content ?? result.content, details: after.details ?? result.details };
			isError = after.isError ?? isError;
		}
	}
	return emitResult(prep.toolCall, result, isError, emit);
}

function errResult(msg: string): AgentToolResult<any> {
	return { content: [{ type: "text", text: msg }], details: {} };
}

async function emitResult(
	tc: AgentToolCall, result: AgentToolResult<any>, isError: boolean, emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
	const trm: ToolResultMessage = {
		role: "toolResult", toolCallId: tc.id, toolName: tc.name,
		content: result.content, details: result.details, isError, timestamp: Date.now(),
	};
	await emit({ type: "message_start", message: trm });
	await emit({ type: "message_end", message: trm });
	return trm;
}
