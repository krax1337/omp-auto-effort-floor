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

/** Raises `holder[key]` to `floor` when it holds a known level below it. */
function raiseField(holder: unknown, key: string, floor: Level): EffortChange | undefined {
	if (!holder || typeof holder !== "object" || !(key in holder)) return undefined;
	const record = holder as Record<string, unknown>;
	const current = record[key];
	if (!isLevel(current) || rank(current) >= rank(floor)) return undefined;
	record[key] = floor;
	return { from: current, to: floor };
}

/**
 * Mutates the effort field in place for the wire shapes omp emits:
 * - Anthropic Messages: `output_config.effort` (adaptive / budget-effort Claude models)
 * - OpenAI Responses / Codex: `reasoning.effort`
 * - OpenAI-compatible chat: `reasoning_effort`
 * Only raises an effort already present, so the required betas/flags are already on the request.
 */
export function applyFloor(payload: unknown, floor: Level): EffortChange | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	// Anthropic has no `minimal`; its lowest wire effort is `low`.
	return (
		raiseField(p.output_config, "effort", floor === "minimal" ? "low" : floor) ??
		raiseField(p.reasoning, "effort", floor) ??
		raiseField(p, "reasoning_effort", floor)
	);
}

/** The effort a provider payload will actually send, across the supported wire shapes. */
export function sentEffort(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	for (const [holder, key] of [
		[p.output_config, "effort"],
		[p.reasoning, "effort"],
		[p, "reasoning_effort"],
	] as const) {
		if (holder && typeof holder === "object" && key in holder) {
			const value = (holder as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
	}
	return undefined;
}

/** Status-line text: the effort sent, plus the classifier's pick when the floor raised it. */
export function statusText(sent: string, change: EffortChange | undefined): string {
	return change ? `effort sent: ${sent} (auto picked ${change.from})` : `effort sent: ${sent}`;
}

const STATUS_KEY = "auto-effort-floor";

export default function autoEffortFloor(pi: ExtensionAPI): void {
	let floor = parseFloor(process.env.OMP_AUTO_EFFORT_FLOOR);

	pi.on("before_provider_request", (event, ctx) => {
		const change = floor && autoActive(ctx.sessionManager) ? applyFloor(event.payload, floor) : undefined;
		const sent = sentEffort(event.payload);
		// The built-in status shows the classifier's pick, which can differ from the wire; show the wire.
		if (sent && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusText(sent, change));
		if (!change) return undefined;
		pi.logger.debug("auto-effort-floor: raised effort", { ...change, model: ctx.model?.id });
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
