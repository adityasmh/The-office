# Deployment Guide

Deploy AgentOffice locally, with Docker, or to the cloud.

---

## Local Development

```bash
# Terminal 1: Server
npm run start --workspace=@agent-office/server

# Terminal 2: UI
npm run dev --workspace=@agent-office/ui
```

Server runs on `ws://localhost:3000`, UI on `http://localhost:5173`.

---

## Docker Compose (Recommended)

The project includes a `docker-compose.yml` that starts everything:

```bash
docker compose up --build
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **server** | 3000 | Colyseus WebSocket + Express API |
| **ui** | 80 | Nginx serving the Vite build |
| **ollama** | 11434 | Local LLM inference |
| **redis** | 6379 | Pub/sub for multi-instance scaling |

### GPU Support

The Ollama container is configured for NVIDIA GPUs. For CPU-only:

```yaml
# docker-compose.yml — remove this block from the ollama service:
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

### Persistent Data

The server mounts `./data` for SQLite persistence:

```yaml
volumes:
  - ./data:/app/data  # Agent memories, tasks, layouts
```

---

## Cloud Deployment

### Railway / Render / Fly.io

1. Push your repo to GitHub
2. Connect the repo to your cloud provider
3. Set environment variables:
   - `DATABASE_URL=sqlite:/data/office.db`
   - `OLLAMA_URL=http://your-ollama-instance:11434`
4. Deploy the server package
5. Deploy the UI package separately (static site)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `DATABASE_URL` | `./data/office-memory.db` | SQLite database path |
| `REDIS_URL` | (none) | Redis for multi-instance |

---

## Production Considerations

- **LLM Latency:** Each think cycle calls Ollama. With 7 agents and ~15s intervals, expect ~0.5 req/s. Scale Ollama or reduce agent count for slower hardware.
- **Memory Growth:** SQLite database grows with agent memories. Use the `importance` threshold to control embedding generation.
- **WebSocket Connections:** Colyseus handles 100+ spectators per room. For more, use Redis pub/sub with multiple server instances.
