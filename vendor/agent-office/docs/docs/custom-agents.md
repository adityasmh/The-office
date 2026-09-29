# Custom Agents Guide

Learn how to create agents with unique personalities, roles, and capabilities.

---

## Agent Configuration

Every agent is defined by an `AgentConfig` object:

```typescript
const alice = new Agent({
    id: 'alice',
    name: 'Alice',
    role: 'Engineer',
    avatar: 'sprite.png',
    inference: {
        provider: 'ollama',
        model: 'llama3.2:latest',
        systemPrompt: 'You are Alice, an engineer. Be technical and precise.',
    },
    personality: {
        traits: {
            openness: 0.8,          // Curiosity, creativity
            conscientiousness: 0.9,  // Organization, reliability
            extraversion: 0.6,      // Sociability, energy
            agreeableness: 0.7,     // Cooperation, empathy
            neuroticism: 0.1        // Emotional volatility
        },
        communicationStyle: 'technical',  // 'formal' | 'casual' | 'technical' | 'creative'
        workHours: { start: '09:00', end: '17:00' },
        breakFrequency: 120  // minutes between breaks
    },
    capabilities: [
        { name: 'code_execute', description: 'Execute JavaScript code' },
        { name: 'web_search', description: 'Search the web' },
        { name: 'write_note', description: 'Write a note' },
        { name: 'create_task', description: 'Create and assign tasks' },
        { name: 'hire_agent', description: 'Hire new team members' }
    ],
    memory: { shortTermLimit: 50 }
});
```

---

## Personality Traits (Big Five Model)

The personality traits influence how the LLM generates agent behavior:

| Trait | Low (0.0) | High (1.0) |
|-------|-----------|------------|
| **Openness** | Routine-oriented, practical | Curious, creative, experimental |
| **Conscientiousness** | Relaxed, flexible | Organized, detail-oriented, reliable |
| **Extraversion** | Quiet, reserved | Social, energetic, talkative |
| **Agreeableness** | Direct, competitive | Cooperative, empathetic, helpful |
| **Neuroticism** | Calm, stable | Anxious, reactive, emotional |

### Example Personality Profiles

**The Methodical Lead:**
```typescript
traits: { openness: 0.5, conscientiousness: 1.0, extraversion: 0.4, agreeableness: 0.6, neuroticism: 0.1 }
```

**The Creative Intern:**
```typescript
traits: { openness: 1.0, conscientiousness: 0.5, extraversion: 0.9, agreeableness: 0.9, neuroticism: 0.3 }
```

**The Anxious Perfectionist:**
```typescript
traits: { openness: 0.6, conscientiousness: 1.0, extraversion: 0.3, agreeableness: 0.8, neuroticism: 0.8 }
```

---

## Adding Agents to the Office

### Method 1: Hardcode in OfficeRoom.ts

Add a new `setupCoreAgent()` call in `packages/server/src/rooms/OfficeRoom.ts`:

```typescript
await setupCoreAgent('charlie', 'Charlie', 'Designer', 15, 15);
```

Don't forget to add a desk target:

```typescript
'charlie-desk': { x: 15, y: 15, type: 'desk' },
```

### Method 2: Dynamic Hiring via LLM

Existing agents can hire new team members through the `hire_agent` tool. The server automatically:
- Creates the agent with a random personality
- Spawns them at the office door
- Assigns them an available desk
- Starts their think loop

---

## System Prompts

The system prompt is the most impactful part of agent behavior. Tips:

1. **State the role clearly** — "You are Alice, a senior engineer"
2. **Set behavioral expectations** — "Be concise, technical, and helpful"
3. **Mention colleagues** — "Your teammate Bob is the Product Manager"
4. **Keep it short** — Long prompts slow down inference and reduce quality

```typescript
systemPrompt: `You are ${name}, a ${role} in a virtual startup office. 
You work with your colleagues on building great products. 
Be social, do your work, and keep thoughts SHORT (under 20 words).`
```

---

## Communication Styles

| Style | Effect on Agent |
|-------|----------------|
| `'formal'` | Professional language, structured responses |
| `'casual'` | Relaxed, uses contractions, friendly |
| `'technical'` | Precise, uses technical jargon, code-focused |
| `'creative'` | Expressive, uses metaphors, idea-oriented |
