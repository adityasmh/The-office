# Data-layer regression fixture

Captured after integration to verify `loadProjects` -> `updateProjectStatus` behavior is unchanged.

```
loaded 4
alpha before: on-track
alpha after: complete
updatedAt: 2026-09-29T12:18:53.891Z
```

The adapter delegates directly to `window.Data.updateProjectStatus`, so the in-session persistence and `updatedAt` timestamp behavior are identical to the legacy UI.
