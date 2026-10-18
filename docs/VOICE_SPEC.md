# Voice Integration Spec

## Overview
This document defines the contract between the VoiceStudio voice backend and the company assistant/runtime.

## Voice Session Contract


interface VoiceSession {
  id: string;                  // UUID for the session
  assistantId: string;         // assistant/user id from sessions.ts
  state: 'idle' | 'listening' | 'processing' | 'speaking' | 'error';
  createdAt: number;
  lastActivityAt: number;
  error?: string;
}


## Voice Message Contract


interface VoiceMessage {
  sessionId: string;
  role: 'user' | 'assistant';
  type: 'audio' | 'text';
  payload: Buffer | string;    // audio bytes or text transcript
  transcript?: string;         // required when role === 'user' and type === 'audio'
  timestamp: number;
}


## Voice Backend Adapter API

The adapter (`src/company/voice.ts`) MUST expose:


// Start a new voice session for an assistant/user.
function startVoiceSession(assistantId: string): Promise<VoiceSession>;

// Stop a session and release resources.
function stopVoiceSession(sessionId: string): Promise<void>;

// Send user audio (or text transcript) and receive assistant audio + text.
// Returns the assistant text transcript and a path/URL to generated audio.
function exchangeAudio(
  sessionId: string,
  input: { type: 'audio'; data: Buffer } | { type: 'text'; text: string }
): Promise<{ transcript: string; audioPath: string; session: VoiceSession }>;

// List active sessions.
function listVoiceSessions(): VoiceSession[];


## Configuration

Voice configuration lives in `src/config.ts` under a `voice` key:


interface VoiceConfig {
  enabled: boolean;
  voiceStudioPath: string;    // absolute or repo-relative path to cloned VoiceStudio
  model?: string;             // optional model override
  defaultVoice?: string;      // voice name/id
  maxSessionAgeMs: number;    // auto-close idle sessions
}


## HTTP Endpoints (owned by server.ts)

- `POST /voice/session` → `{ sessionId, state }`
- `DELETE /voice/session/:id` → `204`
- `POST /voice/exchange/:id` → `{ transcript, audioUrl, state }`
- `GET /voice/sessions` → `VoiceSession[]`

## Audio Files

Generated audio files are written under `public/voice/` and served statically via `/voice/:id/last.mp3`. The directory is owned by the voice adapter.

## Error Handling

Any adapter error sets `session.state = 'error'` and fills `session.error`. Callers must stop and restart the session.
