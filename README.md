# Vera — Merchant Growth Decision Engine

A deterministic, context-aware decision engine built for the **Magicpin Vera AI Challenge**.

Vera combines merchant, category, customer, trigger, and conversation context to decide **when to engage, what to say, and what action to recommend next**.

## Features

- Context-aware merchant engagement
- Category and trigger-specific decisions
- Deterministic decision logic
- Personalized messaging and CTAs
- Conversation-state handling
- Duplicate and suppression handling
- Version-aware context updates
- Grounded responses without fabricated business claims

## Architecture

```text
Magicpin Judge
      ↓
Vera REST API
      ↓
Context + Trigger Analysis
      ↓
Deterministic Decision Engine
      ↓
Message + CTA + Action

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/v1/healthz` | Health check |
| GET | `/v1/metadata` | Bot metadata |
| POST | `/v1/context` | Store/update context |
| POST | `/v1/tick` | Generate proactive actions |
| POST | `/v1/reply` | Process replies |
| POST | `/v1/teardown` | Clear runtime state |


Tech Stack
- Node.js
- Express.js
- JavaScript
- REST / JSON
- Git & GitHub
- Render


Run Locally
npm install
npm start

Server:
http://localhost:8080

Health check:
http://localhost:8080/v1/healthz

Deployment
Production API:
https://vera-ai-challenge-rjii.onrender.com
Author
Ishita Soni
B.Tech Information Technology — NSUT, Delhi
