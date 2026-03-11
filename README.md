# 🛡️ GuardianEye Live

> **Real-time multimodal AI agent for hands-free technical and medical assistance**  
> Built for the **Gemini Live Agent Challenge** — Specialist/Orchestrator pattern with full-duplex audio.

[![Cloud Run](https://img.shields.io/badge/Deploy-Cloud%20Run-4285F4?logo=google-cloud)](https://cloud.run)
[![Gemini](https://img.shields.io/badge/Powered%20by-Gemini%202.0%20Flash-blue)](https://ai.google.dev)
[![ADK](https://img.shields.io/badge/Orchestrated%20by-Google%20ADK-orange)](https://google.github.io/adk-docs/)

---

## What Is GuardianEye?

GuardianEye Live combines the **Multimodal Live API** (real-time video + audio) with Google's **Agent Development Kit (ADK)** to create an agent that *sees what you see* and guides you through complex tasks — completely hands-free.

**Primary use cases:**
- 🔧 Electronics repair & circuit board work
- 🏥 First aid guidance with visual confirmation
- 🚗 Automotive diagnostics
- 🏠 Plumbing and appliance repair

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Client                           │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Live Camera  │  │  Audio (PCM 16k) │  │  Transcript Log  │  │
│  │  Viewfinder  │  │   + Barge-in     │  │  + Spatial UI    │  │
│  └──────┬───────┘  └────────┬─────────┘  └────────▲─────────┘  │
│         │                   │                      │            │
└─────────┼───────────────────┼──────────────────────┼────────────┘
          │ WebSocket /live   │                      │
┌─────────▼───────────────────▼──────────────────────┼────────────┐
│                  GuardianEye Backend (Cloud Run)    │            │
│                                                     │            │
│  ┌─────────────────────────────────────────────┐   │            │
│  │          WebSocket Proxy + VAD Engine        │   │            │
│  │  • Barge-in detection (interrupt keywords)   │   │            │
│  │  • Frame throttling (1fps ADK, 30fps Gemini) │   │            │
│  └──────────┬──────────────────────┬────────────┘   │            │
│             │                      │                 │            │
│  ┌──────────▼──────────┐  ┌───────▼──────────────┐  │            │
│  │  GuardianEye ADK    │  │  Gemini Live API      │  │            │
│  │    Orchestrator     │  │  (Multimodal Live WS) │  │            │
│  │                     │  │  gemini-2.0-flash-exp │──┘            │
│  │  ┌───────────────┐  │  └───────────────────────┘              │
│  │  │Vision Tool    │  │                                         │
│  │  │(Spatial RAG)  │  │                                         │
│  │  └───────────────┘  │  ┌─────────────────────┐               │
│  │  ┌───────────────┐  │  │  Firestore           │               │
│  │  │Manual Lookup  ├──┼──►  Session History     │               │
│  │  │(Vertex Search)│  │  └─────────────────────┘               │
│  │  └───────────────┘  │                                         │
│  └─────────────────────┘                                         │
└──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
guardianeye-live/
├── backend/
│   └── src/
│       ├── server.ts               # Express + WS server entry point
│       ├── agents/
│       │   └── orchestrator.ts     # ADK Orchestrator (main agent brain)
│       ├── tools/
│       │   ├── visionTool.ts       # Vision Specialist — spatial frame analysis
│       │   └── manualLookupTool.ts # Manual Specialist — RAG / Vertex AI Search
│       ├── routes/
│       │   ├── websocket.ts        # Multimodal Live API WebSocket handler
│       │   ├── session.ts          # REST: session management
│       │   ├── knowledge.ts        # REST: manual upload endpoint
│       │   └── health.ts           # Liveness probe
│       ├── middleware/
│       │   ├── errorHandler.ts
│       │   └── rateLimiter.ts
│       └── utils/
│           ├── sessionStore.ts     # Firestore persistence
│           └── logger.ts
│
├── frontend/
│   └── src/
│       ├── App.tsx                 # Root layout
│       ├── components/
│       │   ├── Viewfinder.tsx      # Live camera with status overlay
│       │   ├── TranscriptLog.tsx   # Real-time conversation log
│       │   ├── SpatialOverlay.tsx  # Component annotation UI
│       │   ├── EmergencyStop.tsx   # Big red stop button
│       │   ├── ControlBar.tsx      # Session controls + text input
│       │   └── StatusBar.tsx       # Connection status
│       ├── hooks/
│       │   ├── useWebSocket.ts     # WS client + message routing
│       │   ├── useCamera.ts        # Video capture + frame extraction
│       │   └── useAudio.ts         # Mic recording + PCM playback
│       ├── stores/
│       │   └── guardianStore.ts    # Zustand global state
│       └── styles/
│           └── globals.css         # Tactical dark UI design system
│
├── agent-logic/                    # ADK prompt engineering & evaluation
│   ├── specialists/
│   ├── orchestrator/
│   └── prompts/
│
├── docs/
├── infra/
│   └── deploy.sh                   # One-command Cloud Run deployment
│
├── Dockerfile
├── .env.example
└── README.md  ← you are here
```

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- Google Cloud SDK (`gcloud`)
- A [Gemini API key](https://aistudio.google.com/app/apikey)

### 1. Clone & Install

```bash
git clone https://github.com/your-org/guardianeye-live
cd guardianeye-live
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

```bash
# frontend/.env.local
VITE_WS_URL=ws://localhost:8080/live
```

### 3. Run Dev Servers

```bash
npm run dev
# Backend:  http://localhost:8080
# Frontend: http://localhost:5173
```

---

## Deployment to Google Cloud Run

### Automated (Recommended)

```bash
bash infra/deploy.sh YOUR_PROJECT_ID us-central1
```

This script will:
1. Enable all required GCP APIs
2. Create a service account with least-privilege IAM roles
3. Store your API keys in **Secret Manager**
4. Build the Docker image with **Cloud Build**
5. Deploy to **Cloud Run** with proper resource limits

### Manual Deployment

```bash
# Set project
gcloud config set project YOUR_PROJECT_ID

# Build image
gcloud builds submit . --tag=gcr.io/YOUR_PROJECT_ID/guardianeye-live

# Deploy
gcloud run deploy guardianeye-live \
  --image=gcr.io/YOUR_PROJECT_ID/guardianeye-live \
  --region=us-central1 \
  --min-instances=1 \
  --max-instances=10 \
  --memory=2Gi \
  --cpu=2 \
  --cpu-boost \
  --timeout=300 \
  --allow-unauthenticated \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID"
```

---

## Secret Manager Setup

**Never hardcode API keys.** GuardianEye uses Cloud Secret Manager:

```bash
# Store Gemini API key
echo -n "YOUR_GEMINI_KEY" | gcloud secrets create gemini-api-key \
  --data-file=- --replication-policy=automatic

# Store Vertex AI Search datastore ID  
echo -n "YOUR_DATASTORE_ID" | gcloud secrets create vertex-search-datastore-id \
  --data-file=- --replication-policy=automatic

# Grant Cloud Run service account access
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:guardianeye-sa@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Vertex AI Search (RAG Knowledge Base)

### 1. Create a Data Store

```bash
# Via Cloud Console:
# Navigation → AI Applications → Agent Builder → Data Stores
# → Create Data Store → Website / File Upload → Unstructured Documents

# Or via CLI:
gcloud discovery-engine datastores create guardianeye-manuals \
  --project=YOUR_PROJECT_ID \
  --location=global \
  --collection=default_collection \
  --display-name="GuardianEye Manuals" \
  --content-config=NO_CONTENT
```

### 2. Upload Technical Manuals

```bash
# Upload PDF manuals to GCS first
gsutil -m cp manuals/*.pdf gs://YOUR_PROJECT_ID-manuals/

# Import into data store
gcloud discovery-engine documents import \
  --project=YOUR_PROJECT_ID \
  --location=global \
  --collection=default_collection \
  --data-store=guardianeye-manuals \
  --gcs-source=gs://YOUR_PROJECT_ID-manuals/*.pdf
```

### 3. Or Use the Upload API

```bash
curl -X POST https://YOUR_SERVICE_URL/api/knowledge/upload \
  -F "manual=@repair_manual.pdf"
```

### 4. Configure Environment

```bash
# Get your datastore ID from the Cloud Console URL or:
gcloud discovery-engine datastores list --project=YOUR_PROJECT_ID --location=global

# Set the secret
echo -n "YOUR_DATASTORE_ID" | gcloud secrets versions add vertex-search-datastore-id --data-file=-
```

---

## Firestore Setup

```bash
# Create Firestore database (native mode)
gcloud firestore databases create \
  --location=us-central1 \
  --project=YOUR_PROJECT_ID

# GuardianEye creates collections automatically:
# - guardianeye_sessions/{sessionId}
# - guardianeye_sessions/{sessionId}/turns/{turnId}
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Primary model** | `gemini-2.0-flash-exp` | Lowest latency for real-time, strong vision |
| **Temperature** | 0.1–0.2 | Deterministic, safe outputs for technical tasks |
| **Frame rate** | 30fps to Gemini / 1fps to ADK | Balance context vs. cost |
| **Audio chunk size** | 100ms | Sub-200ms perceived latency |
| **Max tool iterations** | 5 per turn | Prevents runaway agent loops |
| **Interrupt detection** | Client-side + server-side | Belt and suspenders for reliability |
| **Session storage** | Firestore | Real-time, scalable, strong consistency |
| **Secrets** | Cloud Secret Manager | Never in env vars for production |

---

## Barge-In / Interrupt System

GuardianEye implements multi-layer interrupt detection:

1. **Client VAD**: Browser detects speech start → sends `INTERRUPT` message immediately
2. **Keyword Detection**: Server scans transcripts for interrupt phrases (`stop`, `wait`, `pause`, etc.)
3. **Gemini Signal**: Empty `clientContent` message triggers Gemini to stop generation
4. **Audio Buffer Flush**: Client audio context is reset to prevent stale audio playback

---

## Safety Architecture

```
User Request
     ↓
Vision Analysis (what is in frame?)
     ↓
Manual Lookup  ← MANDATORY before any technical instruction
     ↓
Confidence Check
     ├── High (>0.9):  State instruction directly
     ├── Medium (0.6-0.9): Add caveat about partial match
     └── Low (<0.6):   Decline, suggest official documentation
```

**The agent will never fabricate instructions.** If the knowledge base returns no results, GuardianEye explicitly says so.

---

## Monitoring & Logs

```bash
# Stream live logs
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="guardianeye-live"' \
  --project=YOUR_PROJECT_ID \
  --limit=50 \
  --format="table(timestamp, severity, textPayload)" \
  --freshness=5m

# Health check
curl https://YOUR_SERVICE_URL/health
```

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit with conventional commits: `git commit -m "feat: add thermal camera support"`
4. Open a PR

---

## License

MIT © GuardianEye Live — Built for the Gemini Live Agent Challenge
