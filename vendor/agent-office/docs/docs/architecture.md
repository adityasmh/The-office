# Architecture Deep Dive

AgentOffice is built as a TypeScript monorepo with 5 packages. This document explains how everything fits together.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       BROWSER                                │
│                                                              │
│   ┌──────────────────┐    ┌─────────────────────────────┐   │
│   │   Phaser.js       │    │   React Overlay              │   │
│   │   OfficeScene     │    │   ChatPanel · TaskBoard      │   │
│   │   Agent Sprites   │    │   SystemLog · Inspector      │   │
│   │   Furniture       │    │   LayoutEditor               │   │
│   │   Camera/Focus    │    │                              │   │
│   └────────┬─────────┘    └──────────┬──────────────────┘   │
│            │ eventBus (custom events) │                       │
│            └──────────┬──────────────┘                       │
│                       │                                      │
└───────────────────────┼──────────────────────────────────────┘
                        │ WebSocket (Colyseus)
┌───────────────────────▼──────────────────────────────────────┐
│                       SERVER                                  │
│                                                               │
│   ┌──────────────────────────────────────────────────────┐   │
│   │  OfficeRoom (Colyseus Room)                           │   │
│   │                                                       │   │
│   │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │   │
│   │  │ Agent.think()│  │ ToolExecutor │  │ MemoryStore│  │   │
│   │  │ (AI Loop)    │  │ (code/search)│  │ (SQLite)   │  │   │
│   │  └──────┬──────┘  └──────────────┘  └────────────┘  │   │
│   │         │                                             │   │
│   └─────────┤─────────────────────────────────────────────┘   │
│             │                                                 │
└─────────────┼─────────────────────────────────────────────────┘
              │ HTTP API
┌─────────────▼─────────────────────────────────────────────────┐
│                       OLLAMA                                   │
│   Chat Completions (/api/chat)                                │
│   Embeddings (/api/embeddings)                                │
└───────────────────────────────────────────────────────────────┘
```

---

## Package Responsibilities

### `@agent-office/core`

The brain of the system. Contains:

- **`Agent`** — The agent state machine with perceive → think → act → remember lifecycle
- **`Office`** — Grid configuration (width, height, tile size, rooms, furniture, zones)
- **`AgentConfig`** — Personality traits (Big Five), communication style, work hours, capabilities
- **`MemoryEntry`** — Typed memories (thought, conversation, task_result, observation, achievement, relationship) with importance scoring
- **`ConversationMessage`** — Message format for agent-to-agent communication
- **`InferenceAdapter`** — Abstract interface for LLM providers

**No I/O or side effects.** Pure business logic only.

### `@agent-office/adapters`

Bridges between the core and specific LLM providers:

- **`OllamaAdapter`** — Calls Ollama's `/api/chat` endpoint
- **`OpenAICompatibleAdapter`** — Works with OpenAI, Gaia, OpenRouter, or any provider using the `/v1/chat/completions` format
- **`PromptBuilder`** — Constructs structured prompts from agent config and perception context

### `@agent-office/server`

The runtime engine:

- **`OfficeRoom`** — The Colyseus room that runs the simulation loop
  - Initializes agents, loads persistent memories
  - Runs the ~15s think cycle per agent
  - Routes agent-to-agent messages
  - Dispatches tool calls and agent hiring
  - Handles UI messages (task assignment, layout saving, chat)
- **`ToolExecutor`** — Sandboxed JavaScript execution, DuckDuckGo web search, notes, file I/O
- **`MemoryStore`** — SQLite persistence for memories (with embedding column), tasks, and office layouts
- **`OfficeState`** — Colyseus schema for real-time state synchronization

### `@agent-office/ui`

The visualization layer:

- **`OfficeScene`** (Phaser) — Renders the pixel-art tilemap, agent sprites with walk animations, thought/emote bubbles, focus mode camera tracking
- **React Components:**
  - `ChatPanel` — Send messages and view agent conversations
  - `TaskBoard` — Assign tasks to agents with status tracking
  - `SystemLog` — Real-time deduplicated event feed
  - `AgentInspector` — View agent details (name, role, status, current task)
  - `LayoutEditor` — Place furniture and save layouts to the server

Communication between Phaser and React uses a shared `EventTarget` bus.

### `@agent-office/cli`

Project scaffolding and management:
- `create-agent-office` — Generate a new project
- `add-agent` — Add an agent to an existing project

---

## The Agent Think Cycle

```
Every ~15 seconds per agent:

┌─────────┐     ┌──────────┐     ┌─────────┐     ┌──────────┐
│ PERCEIVE│────▶│  THINK   │────▶│   ACT   │────▶│ REMEMBER │
│         │     │ (Ollama) │     │         │     │          │
│ context │     │ returns  │     │ execute │     │ store in │
│ nearby  │     │ JSON     │     │ action  │     │ memory   │
│ messages│     │ decision │     │         │     │          │
│ memories│     │          │     │         │     │          │
└─────────┘     └──────────┘     └─────────┘     └──────────┘
```

**Perception includes:**
- Current time and location (grid coordinates)
- Nearby agents (name, role, distance)
- Unread messages from other agents
- Recent memories (importance-weighted)
- Current assigned task

**LLM returns:**
```json
{
  "thought": "Internal reasoning (shown as bubble)",
  "action": "move | talk | work | use_tool | idle",
  "target": "agent name or coordinates",
  "message": "What to say (if talking)",
  "toolCall": { "name": "tool_name", "params": {} }
}
```

---

## Memory Architecture

```
Short-Term Memory (in-process)
├── Last 50 MemoryEntry objects in the Agent's buffer
├── Importance-weighted (0.0 - 1.0)
└── Newest entries replace oldest when buffer is full

Long-Term Memory (SQLite)
├── All memories persisted with agent_id, type, timestamp
├── Important memories (≥ 0.5) get Ollama embeddings
├── Semantic search via cosine similarity
└── Survives server restarts
```

---

## State Synchronization

Colyseus handles real-time sync with delta compression:

1. Server updates `AgentState.x` — Colyseus detects the change
2. Only the changed bytes are sent to all connected browsers
3. Phaser's `agent.onChange()` callback fires
4. Sprite position is tweened smoothly to the new coordinates

This means 100 spectators can watch the same office with minimal bandwidth.

---

## Dynamic Agent Hiring

When an agent's LLM produces a `hire_agent` tool call:

1. Server creates a new `AgentState` in Colyseus (triggers `onAdd` in all browsers)
2. A new `Agent` instance is created with its own personality and LLM prompt
3. The agent spawns at the office door (tile 20, 2) and walks to an available desk
4. Its think loop starts immediately — it will introduce itself to colleagues
5. Maximum 7 agents (2 original + 5 hired) to prevent LLM overload
