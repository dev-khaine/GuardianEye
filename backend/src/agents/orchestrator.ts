/**
 * GuardianEye ADK Orchestrator — Real Google ADK Integration
 *
 * Uses the official @google/adk TypeScript SDK to implement the
 * Specialist/Orchestrator pattern with real ADK primitives:
 *
 *   LlmAgent      — the root agent with GuardianEye's system prompt
 *   FunctionTool  — wraps VisionTool and ManualLookupTool with Zod schemas
 *   Runner        — manages the agentic event loop (tool call → result → LLM)
 *   InMemorySessionService — maintains per-session conversation history
 *
 * The public interface (processInput, resetContext, turnCount) is unchanged
 * so websocket.ts requires no modifications.
 *
 * CJS/ESM note:
 *   @google/adk ships a CJS build that incorrectly imports 'lodash-es'.
 *   Run `npm run postinstall` (or `node scripts/patch-adk.js`) once after
 *   `npm install` to apply the lodash fix. See scripts/patch-adk.js.
 */

import {
  LlmAgent,
  FunctionTool,
  Runner,
  InMemorySessionService,
  isFinalResponse,
} from '@google/adk';
import type { Content } from '@google/genai';
import { z } from 'zod';
import { VisionTool } from '../tools/visionTool';
import { ManualLookupTool } from '../tools/manualLookupTool';
import { SessionStore } from '../utils/sessionStore';
import { logger } from '../utils/logger';

// ── Public Types (unchanged from original interface) ─────────────────────────

export interface AgentConfig {
  projectId: string;
  location: string;
  sessionId: string;
  userId?: string;
}

export interface OrchestratorResponse {
  text: string;
  audioReady: boolean;
  spatialAnnotations?: SpatialAnnotation[];
  sourceDocuments?: string[];
  confidence: number;
}

export interface SpatialAnnotation {
  label: string;
  position:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'center-left'
    | 'center'
    | 'center-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';
  boundingBox?: { x: number; y: number; w: number; h: number };
}

export interface FrameInput {
  imageData: string;       // base64-encoded JPEG
  mimeType: 'image/jpeg' | 'image/webp';
  timestamp: number;
  userQuery?: string;
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const GUARDIAN_SYSTEM_PROMPT = `You are GuardianEye, an expert real-time assistant that helps users with hands-free technical and medical tasks using their camera.

## Core Operating Principles

**SAFETY FIRST**: You must ALWAYS call lookup_manual_instructions before providing any technical or medical guidance. Never improvise instructions from memory — grounded knowledge only.

**SPATIAL AWARENESS**: When describing object locations, always use precise positional language:
- Cardinal positions: "top-right corner", "bottom-left edge", "center of frame"
- Relative positions: "just above the blue capacitor", "3 inches to the left of the port"
- Clock positions: "at the 2 o'clock position from the chip"

**RESPONSE STYLE**:
- Be concise and actionable — the user has their hands full
- One instruction at a time, never overwhelm
- Confirm before critical/irreversible steps
- Use natural, calm speech — you are a trusted expert guide

## Specialist Workflow
1. User speaks or the camera sees something noteworthy
2. Call analyze_visual_scene to understand what's in frame
3. Call lookup_manual_instructions to get grounded guidance
4. Synthesize both into a single, clear, actionable response

## Interruption Handling
If the user says "stop", "wait", "pause" — immediately cease output.
If the user says "go back" — repeat the previous instruction.
If the user says "again" or "repeat" — re-read the current instruction.

## Confidence Communication
- High confidence (manual match found): State instructions directly
- Medium confidence (partial match): "Based on what I can see, and standard practice..."
- Low confidence: "I don't have specific documentation for this. I recommend consulting official documentation."

Never fabricate steps. If the knowledge base returns no results, say so.`;

// ── GuardianEye ADK Orchestrator ──────────────────────────────────────────────

export class GuardianEyeOrchestrator {
  private runner: Runner;
  private sessionService: InMemorySessionService;
  private sessionStore: SessionStore;
  private sessionId: string;
  private userId: string | undefined;

  // Frame context — updated before every processInput() call.
  // FunctionTool.execute() reads from here since large base64 blobs
  // cannot be passed as LLM function-call parameters.
  private currentFrame: { imageData: string; mimeType: 'image/jpeg' | 'image/webp' } | null = null;

  // Metadata accumulated during a single processInput() turn
  private turnSpatialAnnotations: SpatialAnnotation[] = [];
  private turnSourceDocuments: string[] = [];

  // Track whether the ADK session has been created
  private adkSessionCreated = false;
  private adkTurnCount = 0;

  constructor(config: AgentConfig) {
    this.sessionId = config.sessionId;
    this.userId = config.userId;
    this.sessionStore = new SessionStore();

    const visionTool = new VisionTool(config.projectId, config.location);
    const manualTool = new ManualLookupTool(config.projectId);

    // ── Vision FunctionTool ────────────────────────────────────────────────
    const analyzeVisualScene = new FunctionTool({
      name: 'analyze_visual_scene',
      description: `Analyzes the current camera frame to identify objects, their spatial positions,
        component states, labels, and any safety hazards. Returns structured JSON with spatial
        annotations. ALWAYS call this first when the user asks about something physical.`,
      parameters: z.object({
        focusQuery: z
          .string()
          .describe('What the user is trying to find or understand in the scene'),
        requireSpatial: z
          .boolean()
          .optional()
          .describe('Whether to include precise position descriptions (top-right, bottom-left, etc.)'),
      }),
      execute: async ({ focusQuery, requireSpatial }) => {
        if (!this.currentFrame) {
          logger.warn('analyze_visual_scene called with no camera frame');
          return { error: 'No camera frame available. Ask the user to point their camera.' };
        }

        try {
          const result = await visionTool.execute({
            imageData: this.currentFrame.imageData,
            mimeType: this.currentFrame.mimeType,
            focusQuery,
            requireSpatial: requireSpatial ?? true,
          });

          // Accumulate spatial annotations for the UI overlay
          if (result.annotations?.length) {
            this.turnSpatialAnnotations.push(...result.annotations);
          }

          return result;
        } catch (err) {
          logger.error('analyze_visual_scene tool error:', err);
          return { error: 'Vision analysis failed. Please try again.' };
        }
      },
    });

    // ── Manual Lookup FunctionTool ─────────────────────────────────────────
    const lookupManualInstructions = new FunctionTool({
      name: 'lookup_manual_instructions',
      description: `Retrieves verified, step-by-step instructions from the knowledge base using RAG.
        ALWAYS call this before giving any technical or medical instruction.
        Returns grounded steps with source citations. Never skip this for safety-critical tasks.`,
      parameters: z.object({
        query: z
          .string()
          .describe('Natural language description of what the user is trying to do'),
        context: z
          .string()
          .optional()
          .describe('Visual context from the scene analysis to narrow the search'),
        domain: z
          .enum(['electronics', 'medical', 'automotive', 'plumbing', 'appliance', 'general'])
          .optional()
          .describe('Domain category to focus the knowledge base search'),
        stepNumber: z
          .number()
          .optional()
          .describe('If the user is asking about a specific step number'),
      }),
      execute: async ({ query, context, domain, stepNumber }) => {
        try {
          const result = await manualTool.execute({ query, context, domain, stepNumber });

          // Accumulate source documents for the UI transcript
          if (result.sources?.length) {
            this.turnSourceDocuments.push(...result.sources);
          }

          return result;
        } catch (err) {
          logger.error('lookup_manual_instructions tool error:', err);
          return {
            found: false,
            steps: [],
            warnings: ['Knowledge base temporarily unavailable. Exercise extra caution.'],
            sources: [],
            confidence: 0,
            relatedTopics: [],
          };
        }
      },
    });

    // ── LLM Agent (GuardianEye Root Agent) ────────────────────────────────
    const guardianAgent = new LlmAgent({
      name: 'guardian_eye_agent',
      model: 'gemini-2.0-flash',        // ADK uses short model names (no -exp suffix)
      description:
        'Real-time hands-free AI assistant for technical and medical tasks using live camera feed.',
      instruction: GUARDIAN_SYSTEM_PROMPT,
      tools: [analyzeVisualScene, lookupManualInstructions],
    });

    // ── Runner + Session Service ───────────────────────────────────────────
    this.sessionService = new InMemorySessionService();
    this.runner = new Runner({
      agent: guardianAgent,
      appName: 'guardianeye-live',
      sessionService: this.sessionService,
    });
  }

  // ── Ensure ADK session exists (idempotent) ────────────────────────────────

  private async ensureAdkSession(): Promise<void> {
    if (this.adkSessionCreated) return;

    await this.sessionService.createSession({
      appName: 'guardianeye-live',
      userId: this.userId ?? 'anonymous',
      sessionId: this.sessionId,
    });

    this.adkSessionCreated = true;
    logger.debug(`ADK session created: ${this.sessionId}`);
  }

  // ── Primary Entry Point ────────────────────────────────────────────────────

  /**
   * Process a camera frame + optional user query through the ADK agent.
   * The Runner manages the full agentic loop: LLM call → tool execution →
   * result injection → final LLM response.
   */
  async processInput(input: FrameInput): Promise<OrchestratorResponse> {
    const startTime = Date.now();

    // Reset per-turn accumulators
    this.turnSpatialAnnotations = [];
    this.turnSourceDocuments = [];

    // Update the frame context so FunctionTools can read it
    this.currentFrame = { imageData: input.imageData, mimeType: input.mimeType };

    try {
      await this.ensureAdkSession();

      // Build a multimodal Content message: image + text
      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: input.mimeType,
              data: input.imageData,
            },
          },
          {
            text: input.userQuery
              ?? 'What do you see? Describe any components or tasks I might be working on.',
          },
        ],
      };

      // Run the agent — ADK handles the full tool-calling loop internally
      let finalText = "I'm analyzing the scene. One moment.";

      const eventStream = this.runner.runAsync({
        userId: this.userId ?? 'anonymous',
        sessionId: this.sessionId,
        newMessage: userMessage,
      });

      for await (const event of eventStream) {
        if (isFinalResponse(event)) {
          finalText = event.content?.parts?.[0]?.text ?? finalText;
        }
      }

      this.adkTurnCount++;
      const latency = Date.now() - startTime;
      logger.info(`ADK orchestrator response in ${latency}ms | session: ${this.sessionId}`);

      // Persist turn to Firestore
      await this.sessionStore.saveTurn(this.sessionId, {
        userQuery: input.userQuery,
        agentResponse: finalText,
        sourceDocuments: this.turnSourceDocuments,
        latencyMs: latency,
        timestamp: new Date(),
      });

      const uniqueSources = [...new Set(this.turnSourceDocuments)];

      return {
        text: finalText,
        audioReady: true,
        spatialAnnotations:
          this.turnSpatialAnnotations.length > 0 ? this.turnSpatialAnnotations : undefined,
        sourceDocuments: uniqueSources.length > 0 ? uniqueSources : undefined,
        confidence: uniqueSources.length > 0 ? 0.95 : 0.6,
      };
    } catch (error) {
      logger.error('ADK orchestrator error:', error);
      return {
        text: 'I encountered an issue processing that. Please try again.',
        audioReady: true,
        confidence: 0,
      };
    }
  }

  // ── Context Reset ─────────────────────────────────────────────────────────

  /**
   * Reset conversation by creating a new ADK session with a fresh ID.
   * Called when the user wants to start a new task context.
   */
  resetContext(): void {
    this.adkSessionCreated = false;
    this.currentFrame = null;
    this.turnSpatialAnnotations = [];
    this.turnSourceDocuments = [];
    logger.info(`ADK context reset for session ${this.sessionId}`);
  }

  // ── Turn Count ────────────────────────────────────────────────────────────

  get turnCount(): number {
    return this.adkTurnCount;
  }
}
