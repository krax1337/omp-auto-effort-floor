# omp-auto-effort-floor

Minimum reasoning effort for [omp](https://omp.sh)'s `auto` thinking mode.

omp's `auto` picks an effort per prompt. `providers.autoThinkingMaxEffort` caps it from above, but there is no lower bound. This extension adds one: while the session's thinking selector is `auto`, any outgoing request whose effort is below the floor is raised to the floor. Levels you pin yourself (for example `/thinking low`) are never touched.

## Install

```sh
omp plugin install github:krax1337/omp-auto-effort-floor
```

Restart the session afterwards.

## Configure

| Source | Example | Scope |
| --- | --- | --- |
| `/auto-floor <level>` | `/auto-floor high` | current session |
| `OMP_AUTO_EFFORT_FLOOR` env | `export OMP_AUTO_EFFORT_FLOOR=high` | every session |
| default | `medium` | |

Levels: `minimal` `low` `medium` `high` `xhigh` `max`, or `off` to disable. Running `/auto-floor` with no argument shows the current floor and whether auto is active.

## How it works

The extension hooks `before_provider_request` and rewrites the effort field on these wire formats:

- Anthropic Messages: `output_config.effort`. Anthropic has no `minimal`, so its effective floor is `low`.
- OpenAI Responses / Codex: `reasoning.effort`
- OpenAI-compatible chat: `reasoning_effort`

It only raises an effort that is already on the request, so it never adds a field the provider would reject.

To tell whether auto is active, it reads the latest `thinking_level_change` entry on the session branch and checks for `configured: "auto"`.

## Limits

- Google/Gemini `thinkingConfig` and budget-only providers are left unchanged.
- The status line still shows the level the classifier chose. The floor applies on the wire.
- `ultrathink` and the `autoThinkingMaxEffort` ceiling behave as before.
