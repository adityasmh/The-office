# API Reference

AgentOffice uses WebSocket (Colyseus) for real-time state sync and message passing.

---

## WebSocket Events

### Client → Server

| Message Type | Payload | Description |
|-------------|---------|-------------|
| `chat` | `{ text: string }` | Send a chat message to the office |
| `assign-task` | `{ title: string, agentId?: string }` | Assign a task (auto-assign if no agentId) |
| `save-layout` | `{ name: string, layout: object[] }` | Save a custom office layout |

### Server → Client

| Message Type | Payload | Description |
|-------------|---------|-------------|
| `chat` | `{ sender: string, text: string }` | Chat message (from agent or system) |
| `task-update` | `{ agentId, agentName, task, status }` | Task status change |
| `tasks-sync` | `TaskItem[]` | Full task list on client join |

### Colyseus State Schema

```typescript
class OfficeState {
    agents: Map<string, AgentState>   // All agents
    officeTime: string                // ISO timestamp
    timeScale: number                 // Simulation speed (default: 1)
}

class AgentState {
    id: string
    name: string
    x: number                         // Grid tile X
    y: number                         // Grid tile Y
    direction: 'up' | 'down' | 'left' | 'right'
    action: string                    // Current action
    currentTask: string               // Assigned task title
    thought: string                   // Latest thought bubble
}
```

### State Change Listeners

```typescript
// Listen for new agents
state.agents.onAdd((agent, id) => { /* new agent spawned */ });

// Listen for agent removal
state.agents.onRemove((agent, id) => { /* agent left */ });

// Listen for property changes on a specific agent
agent.onChange(() => {
    console.log(agent.x, agent.y, agent.action, agent.thought);
});
```

---

## Client-Side Event Bus

The Phaser game and React components communicate via `eventBus`:

| Event | Detail | Source → Target |
|-------|--------|----------------|
| `chat-message` | `{ sender, text }` | Colyseus → ChatPanel |
| `activity-log` | `{ agent, action, thought, time }` | Phaser → SystemLog |
| `agent-focus` | `{ name, id } \| null` | Phaser → React (focus mode) |

---

## Database Schema (SQLite)

```sql
-- Agent memories with optional embeddings
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL,        -- thought|conversation|task_result|observation|achievement
    timestamp TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    embedding TEXT,            -- JSON array of floats (Ollama)
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Tasks assigned from UI or created by agents
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT DEFAULT 'pending',  -- pending|in_progress|completed
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Saved office layouts
CREATE TABLE office_layout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_json TEXT NOT NULL,
    name TEXT DEFAULT 'default',
    updated_at TEXT DEFAULT (datetime('now'))
);
```
