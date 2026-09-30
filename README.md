# pi-advisor

> A [Pi](https://github.com/RimuruW/pi-advisor) extension that adds a strategic advisor tool for complex coding agent tasks.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm package](https://img.shields.io/npm/v/pi-advisor)](https://www.npmjs.com/package/pi-advisor)

## Overview

`pi-advisor` adds an `advisor` tool to the Pi coding agent, modeled after [Anthropic's advisor tool pattern](https://claude.com/blog/the-advisor-strategy): the executor model keeps doing the work and only consults a stronger "advisor" model when it needs strategic guidance — not for syntax-level questions or routine implementation steps.

The advisor sees a curated transcript, understands the current task stage, and returns a verdict plus numbered action items.

## Features

- **Stage-aware guidance** — automatically detects whether the executor is exploring, stuck, or ready for final verification, and tailors the advisor prompt accordingly
- **Curated context** — sends only relevant conversation history, bounded system prompt, and recent tool activity to keep token usage efficient
- **Ordered model fallback** — configure multiple provider/model candidates; unavailable or failed models are skipped in order
- **Configurable model & effort** — choose any provider/model and tune reasoning effort (`minimal`–`xhigh`), token budget, and context window
- **Slash commands** — `/advisor on`, `/advisor off`, `/advisor config`, `/advisor ask` with tab completion
- **Compact TUI rendering** — advisor output renders inline with token usage, stage label, and expand-to-read hint

## Install

### From npm

```bash
pi install npm:pi-advisor
```

### From git

```bash
pi install git:github.com/RimuruW/pi-advisor
```

This is a pi package — install via npm, git, or local path.

## Usage

Enable the advisor with the default model:

```
/advisor on
```

Enable with a specific model:

```
/advisor on anthropic/claude-fable-5
```

Enable with ordered fallback models (first is preferred):

```
/advisor on anthropic/claude-fable-5,openrouter/z-ai/glm-5
```

### Commands

| Command | Description |
|---|---|
| `/advisor` | Show current status |
| `/advisor on [provider/model,...]` | Enable advisor with ordered fallback models |
| `/advisor off` | Disable advisor |
| `/advisor config` | Show full configuration |
| `/advisor config key=value` | Set a config value |
| `/advisor ask` | Manually trigger advisor consultation |

### Configuration

```
/advisor config models=anthropic/claude-fable-5,openrouter/z-ai/glm-5
/advisor config maxContextMessages=24
/advisor config reasoning=xhigh
/advisor config maxTokens=16384
```

The canonical `~/.pi/agent/advisor.json` model setting is an ordered list:

```json
{
  "enabled": true,
  "models": [
    { "provider": "anthropic", "model": "claude-fable-5" },
    { "provider": "openrouter", "model": "z-ai/glm-5" }
  ]
}
```

The first model is preferred. If it is not registered, returns an error, or produces an empty response, the next model is tried. A cancelled request does not fall through to another model. Legacy `provider`/`model` fields remain readable and are treated as a one-item list.

| Key | Default | Description |
|---|---|---|
| `models` | `[{"provider":"anthropic","model":"claude-fable-5"}]` | Ordered fallback list; accepts object entries or `provider/model` strings |
| `provider` | — | Legacy single-model provider; updates the first entry |
| `model` | — | Legacy single-model identifier; updates the first entry |
| `maxUsesPerRun` | `3` | Max advisor calls per agent run |
| `maxTokens` | `16384` | Max output tokens per advisor call (thinking tokens count against this on adaptive-thinking models) |
| `reasoning` | `high` | Reasoning effort level (`minimal`, `low`, `medium`, `high`, `xhigh`) |
| `maxContextMessages` | `18` | Max transcript messages sent to advisor |

Configuration persists to `~/.pi/agent/advisor.json`.

## Architecture

```
┌─────────────────────────────────────────┐
│              Executor (LLM)              │
│  ┌───────────────────────────────────┐   │
│  │  Decides when to call advisor      │   │
│  │  Reads advisor output & acts       │   │
│  └──────────────┬────────────────────┘   │
└─────────────────┼───────────────────────┘
                  │ advisor(params)
                  ▼
┌─────────────────────────────────────────┐
│           Advisor Extension              │
│                                          │
│  1. Detect current stage                 │
│     (initial / recovery / final-check)   │
│  2. Build curated context:               │
│     - Bounded system prompt              │
│     - Active tools summary               │
│     - Recent tool activity               │
│     - Transcript (first + last N msgs)   │
│  3. Try configured advisor models in order│
│     via Pi's model registry              │
│  4. Return verdict + action items        │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│           Advisor Model (LLM)            │
│  Stronger model, returns:                │
│  - Verdict: "On track" /                 │
│             "Course-correct" /           │
│             "Not done yet"               │
│  - Numbered action items (≤ 5)          │
│  - References to files, commands,        │
│    or error signals from transcript      │
└─────────────────────────────────────────┘
```

### Stage Detection

The extension infers the executor's current stage from recent tool activity:

| Stage | Trigger |
|---|---|
| **initial** | Exploratory reads/commands, no file mutations yet |
| **recovery** | Recent failure, or off-track implementation |
| **final-check** | Changes exist and verification output is in transcript |

## Project Structure

```
.
├── index.ts              # Extension entrypoint (tool + command registration)
├── src/
│   ├── advisor-messages.ts   # Transcript curation for advisor context
│   ├── advisor-models.ts     # Model list parsing and fallback execution
│   └── advisor-signals.ts    # Pure stage/signal detection logic
├── tests/
│   ├── advisor-models.test.ts   # Model config and fallback tests
│   ├── advisor-signals.test.ts  # Signal logic unit tests
│   └── advisor-messages.test.ts # Context curation tests
├── package.json
├── package-lock.json
├── tsconfig.json
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## Development

```bash
# Run typecheck + tests
npm run check

# Run tests only
npm test

# Smoke-load as an extension
pi -e ./index.ts
```

## License

MIT. See [LICENSE](LICENSE).
