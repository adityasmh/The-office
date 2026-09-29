# Quick Start Guide

Welcome to **AgentOffice**! Get your own AI-powered virtual office running in under 5 minutes.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | ≥ 18 | [nodejs.org](https://nodejs.org) |
| **npm** | ≥ 9 | Comes with Node.js |
| **Ollama** | Latest | [ollama.ai](https://ollama.ai) |

---

## Step 1: Clone & Install

```bash
git clone https://github.com/AjStraworern/agent-office.git
cd agent-office
npm install
```

This installs all 5 workspace packages (`core`, `adapters`, `server`, `ui`, `cli`).

## Step 2: Pull an LLM Model

Make sure Ollama is running, then pull a model:

```bash
ollama pull llama3.2
```

> **Tip:** `llama3.2` (3B) is fast and works well for agent thoughts. For richer conversations, try `llama3.1:8b`.

## Step 3: Build All Packages

```bash
npm run build
```

This compiles TypeScript across all packages in dependency order.

## Step 4: Start the Server

```bash
npm run start --workspace=@agent-office/server
```

You should see:
```
[Server] AgentOffice Engine listening on ws://localhost:3000
```

## Step 5: Start the UI

Open a **new terminal** and run:

```bash
npm run dev --workspace=@agent-office/ui
```

## Step 6: Open Your Browser

Navigate to **http://localhost:5173**

You'll see:
- 🏢 A pixel-art office with desks, monitors, plants, and a coffee area
- 👤 **Alice** (Engineer) and **Bob** (Product Manager) walking to their desks
- 💭 Thought bubbles appearing as agents think via Ollama
- 💬 The Chat panel showing agent conversations
- 📋 The TaskBoard where you can assign tasks
- 📊 The System Activity Log tracking all events

---

## What's Happening Under the Hood?

Every ~15 seconds, each agent:

1. **Perceives** — Gathers nearby agents, unread messages, memories, and current task
2. **Thinks** — Sends context to Ollama, gets back a JSON decision
3. **Acts** — Moves, talks, uses tools, or hires a new team member
4. **Remembers** — Stores the thought in SQLite with importance scoring

The Colyseus server syncs all state changes to your browser via WebSocket.

---

## Try These Things

### Assign a Task
Type a task in the TaskBoard (e.g., "Build the login page"), select Alice, and click **Assign**.

### Chat with Agents
Type a message in the Chat panel — agents will see it as part of their perception context.

### Follow an Agent
Click on any agent sprite — the camera will smoothly follow them. Click again to unfollow.

### Watch Agents Hire
If the team gets busy, Alice or Bob may decide to hire an intern. You'll see a 🎉 announcement in the chat and a new sprite spawn at the office door!

---

## Next Steps

- [Architecture Deep Dive](./architecture.md) — Understand the system design
- [Custom Agents Guide](./custom-agents.md) — Create agents with unique personalities
- [Tools Reference](./tools.md) — Add custom tools agents can use
- [Deployment Guide](./deployment.md) — Docker and cloud deployment
- [API Reference](./api-reference.md) — WebSocket events and REST endpoints
