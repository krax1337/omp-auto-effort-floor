/**
 * omp-auto-effort-floor — minimum reasoning effort for `auto` thinking mode.
 *
 * omp's `auto` classifier picks an effort per prompt, capped above by
 * `providers.autoThinkingMaxEffort`, but has no lower bound. This extension
 * raises the effort on outgoing provider requests to a floor, only while the
 * session's configured thinking selector is `auto`. Pinned levels (e.g. an
 * explicit `/thinking low`) are left alone.
 *
 * Floor source, highest precedence first: `/auto-floor <level>` (session),
 * `OMP_AUTO_EFFORT_FLOOR` env, default `medium`. `/auto-floor off` disables.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

const isLevel = (value: unknown): value is Level => typeof value === "string" && LEVELS.includes(value as Level);
const rank = (level: Level): number => LEVELS.indexOf(level);

export function parseFloor(raw: string | undefined): Level | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return "medium";
	if (value === "off") return undefined;
	return isLevel(value) ? value : "medium";
}

/** True when the latest thinking change on the active branch was made in auto mode. */
export function autoActive(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">): boolean {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "thinking_level_change") return entry.configured === "auto";
	}
	return false;
}

type EffortChange = { from: Level; to: Level };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

/**
 * Mutates the effort fields in place for the wire shapes omp emits:
 * - Anthropic Messages: `output_config.effort`, top-level and on `messages[]` entries
 * - OpenAI Responses / Codex: `reasoning.effort`, top-level and on `configuration_update` items in `input[]`
 * - OpenAI-compatible chat: `reasoning_effort`
 *
 * Models with in-conversation effort control (Claude 5.x, GPT-6.x) keep the top-level field at the
 * conversation's first effort and send every later change as a history entry, so the last field in
 * request order is the one in force. Every field is raised, not only that one: history rewritten
 * differently from the previous request would change the prompt cache prefix.
 *
 * Only raises efforts already present, so the required betas/flags are already on the request.
 * Returns the change to the effort in force, if the floor raised it.
 */
export function applyFloor(payload: unknown, floor: Level): EffortChange | undefined {
	const p = asRecord(payload);
	if (!p) return undefined;
	// Anthropic has no `minimal`; its lowest wire effort is `low`.
	const anthropicFloor = floor === "minimal" ? "low" : floor;
	let inForce: EffortChange | undefined;
	/** Raises `holder[key]` when it holds a known level below `level`. The last field present is the one in force. */
	const raise = (holder: unknown, key: string, level: Level): void => {
		const record = asRecord(holder);
		if (!record || !(key in record)) return;
		const current = record[key];
		inForce = undefined;
		if (!isLevel(current) || rank(current) >= rank(level)) return;
		record[key] = level;
		inForce = { from: current, to: level };
	};

	raise(p.output_config, "effort", anthropicFloor);
	if (Array.isArray(p.messages)) {
		for (const message of p.messages) raise(asRecord(message)?.output_config, "effort", anthropicFloor);
	}
	raise(p.reasoning, "effort", floor);
	if (Array.isArray(p.input)) {
		for (const item of p.input) {
			const update = asRecord(item);
			if (update?.type === "configuration_update") raise(update.reasoning, "effort", floor);
		}
	}
	raise(p, "reasoning_effort", floor);
	return inForce;
}

export default function autoEffortFloor(pi: ExtensionAPI): void {
	let floor = parseFloor(process.env.OMP_AUTO_EFFORT_FLOOR);

	pi.on("before_provider_request", (event, ctx) => {
		if (!floor || !autoActive(ctx.sessionManager)) return undefined;
		const change = applyFloor(event.payload, floor);
		if (change) pi.logger.debug("auto-effort-floor: raised effort", { ...change, model: ctx.model?.id });
		return event.payload;
	});

	pi.registerCommand("auto-floor", {
		description: `Minimum effort for auto thinking: ${LEVELS.join("|")}|off (no arg shows current)`,
		getArgumentCompletions: prefix =>
			[...LEVELS, "off"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "off") floor = undefined;
			else if (isLevel(value)) floor = value;
			else if (value) {
				ctx.ui.notify(`auto-floor: unknown level "${value}" (${LEVELS.join("|")}|off)`, "error");
				return;
			}
			const state = autoActive(ctx.sessionManager) ? "auto active" : "auto not active, floor idle";
			ctx.ui.notify(`auto-floor: ${floor ?? "off"} (${state})`, "info");
		},
	});
}
