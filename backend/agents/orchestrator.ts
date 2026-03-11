/**
 * GuardianEye ADK Orchestrator
 *
 * Implements the Specialist/Orchestrator pattern using Google's Agent Development Kit (ADK).
 * The orchestrator manages two specialists:
 *   1. VisionSpecialist  - Analyzes video frames for spatial reasoning
 *   2. ManualSpecialist  - Retrieves grounded steps from the knowledge base (RAG/Vertex AI Search)
 *
 * Safety principle: NEVER give a technical instruction without first consulting ManualSpecialist.
 */

import { VertexAI, GenerativeModel } from '@google-cloud/vertexai';
import { VisionTool } from '../tools/visionTool';
import { ManualLookupTool } from '../tools/manualLookupTool';
import { SessionStore } from '../utils/sessionStore';
import { logger } from '../utils/logger';

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
  position: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  boundingBox?: { x: number; y: number; w: number; h: number };
}

export interface FrameInput {
  imageData: string;        // base64 encoded JPEG
  mimeType: 'image/jpeg' | 'image/webp';
  timestamp: number;
  userQuery?: string;
}

// ── ADK Tool Declarations ────────────────────────────────────────────────────
const ADK_TOOL_DEFINITIONS = [
  {
    functionDeclarations: [
      {
        name: 'analyze_visual_scene',
        description: `Analyzes the current camera frame to identify objects, their spatial positions,
          component states, labels, and any safety hazards. Returns structured JSON with spatial annotations.
          ALWAYS call this first when the user asks about something physical.`,
        parameters: {
          type: 'OBJECT',
          properties: {
            imageData: {
              type: 'STRING',
              description: 'Base64-encoded JPEG image from the camera feed',
            },
            focusQuery: {
              type: 'STRING',
              description: 'What the user is trying to find or understand in the scene',
            },
            requireSpatial: {
              type: 'BOOLEAN',
              description: 'Whether to include precise position descriptions (top-right, bottom-left, etc.)',
            },
          },
          required: ['imageData', 'focusQuery'],
        },
      },
      {
        name: 'lookup_manual_instructions',
        description: `Retrieves verified, step-by-step instructions from the knowledge base using RAG.
          ALWAYS call this before giving any technical or medical instruction.
          Returns grounded steps with source citations. Never skip this for safety-critical tasks.`,
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Natural language description of what the user is trying to do',
            },
            context: {
              type: 'STRING',
              description: 'Visual context from the scene analysis to narrow the search',
            },
            domain: {
              type: 'STRING',
              enum: ['electronics', 'medical', 'automotive', 'plumbing', 'appliance', 'general'],
              description: 'Domain category to focus the knowledge base search',
            },
            stepNumber: {
              type: 'NUMBER',
              description: 'If the user is asking about a specific step number',
            },
          },
          required: ['query'],
        },
      },
    ],
  },
];

// ── Orchestrator System Prompt ────────────────────────────────────────────────
const ORCHESTRATOR_SYSTEM_PROMPT = `You are GuardianEye, an expert real-time assistant that helps users with hands-free technical and medical tasks using their camera.

## Core Operating Principles

**SAFETY FIRST**: You must ALWAYS call lookup_manual_instructions before providing any technical or medical guidance. Never improvise instructions from memory — grounded knowledge only.

**SPATIAL AWARENESS**: When describing object locations, always use precise positional language:
- Cardinal positions: "top-right corner", "bottom-left edge", "center of frame"
- Relative positions: "just above the blue capacitor", "3 inches to the left of the port"
- Clock positions: "at the 2 o'clock position from the chip"

**RESPONSE STYLE**:
- Be concise and actionable — the user has their hands full
- One instruction at a time, never overwhelm
- Confirm before critical/irreversible steps ("Before you proceed, this will permanently reset the device. Confirm by saying 'yes, proceed'")
- Use natural, calm speech — you are a trusted expert guide

## Specialist Workflow
1. User speaks or camera sees something noteworthy
2. Call analyze_visual_scene to understand what's in frame
3. Call lookup_manual_instructions to get grounded guidance
4. Synthesize both into a single, clear, actionable response
5. Describe spatial positions from step 2 to help the user locate components

## Interruption Handling
If the user says "stop", "wait", "pause", or "hold on" — immediately cease output.
If the user says "go back" — repeat the previous instruction.
If the user says "again" or "repeat" — re-read the current instruction clearly.

## Confidence Communication
- High confidence (manual match found): State instructions directly
- Medium confidence (partial match): "Based on what I can see, and standard practice for this type of device..."  
- Low confidence: "I want to be careful here. I don't have specific documentation for this exact model. I recommend..."

Never fabricate steps. If you cannot ground an instruction in the knowledge base, say so and suggest the user consult official documentation.`;

// ── GuardianEye Orchestrator Class ────────────────────────────────────────────
export class GuardianEyeOrchestrator {
  private model: GenerativeModel;
  private visionTool: VisionTool;
  private manualTool: ManualLookupTool;
  private sessionStore: SessionStore;
  private sessionId: string;
  private conversationHistory: Array<{ role: string; parts: Array<{ text?: string; functionCall?: object; functionResponse?: object }> }> = [];

  constructor(config: AgentConfig) {
    const vertexAI = new VertexAI({
      project: config.projectId,
      location: config.location,
    });

    this.model = vertexAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: ORCHESTRATOR_SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.2,         // Low temperature = more reliable, less hallucination
        maxOutputTokens: 512,     // Keep responses concise for real-time delivery
        topP: 0.8,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT' as any, threshold: 'BLOCK_MEDIUM_AND_ABOVE' as any },
        { category: 'HARM_CATEGORY_HARASSMENT' as any, threshold: 'BLOCK_MEDIUM_AND_ABOVE' as any },
      ],
    });

    this.visionTool = new VisionTool(config.projectId, config.location);
    this.manualTool = new ManualLookupTool(config.projectId);
    this.sessionStore = new SessionStore();
    this.sessionId = config.sessionId;
  }

  /**
   * Primary entry point: process a frame + optional user query
   * Returns structured response ready for TTS streaming
   */
  async processInput(input: FrameInput): Promise<OrchestratorResponse> {
    const startTime = Date.now();

    try {
      // Build the user message for this turn
      const userMessage = this.buildUserMessage(input);
      this.conversationHistory.push(userMessage);

      // Agentic loop — run until model stops calling tools
      let response = await this.callModel();
      let spatialAnnotations: SpatialAnnotation[] = [];
      let sourceDocuments: string[] = [];
      let iterations = 0;
      const MAX_ITERATIONS = 5;  // Safety cap on tool calls per turn

      while (response.toolCalls && response.toolCalls.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;
        const toolResults = await this.executeToolCalls(response.toolCalls, input);

        // Collect metadata from tool results
        spatialAnnotations.push(...(toolResults.spatialAnnotations || []));
        sourceDocuments.push(...(toolResults.sourceDocuments || []));

        // Add tool results to conversation and call model again
        this.conversationHistory.push({
          role: 'model',
          parts: response.toolCalls.map(tc => ({ functionCall: tc })),
        });
        this.conversationHistory.push({
          role: 'user',
          parts: toolResults.parts,
        });

        response = await this.callModel();
      }

      const finalText = response.text || "I'm analyzing the scene. One moment.";
      const latency = Date.now() - startTime;

      logger.info(`Orchestrator response in ${latency}ms (${iterations} tool calls)`);

      // Persist turn to Firestore
      await this.sessionStore.saveTurn(this.sessionId, {
        userQuery: input.userQuery,
        agentResponse: finalText,
        sourceDocuments,
        latencyMs: latency,
        timestamp: new Date(),
      });

      return {
        text: finalText,
        audioReady: true,
        spatialAnnotations: spatialAnnotations.length > 0 ? spatialAnnotations : undefined,
        sourceDocuments: sourceDocuments.length > 0 ? [...new Set(sourceDocuments)] : undefined,
        confidence: sourceDocuments.length > 0 ? 0.95 : 0.6,
      };

    } catch (error) {
      logger.error('Orchestrator error:', error);
      return {
        text: "I encountered an issue processing that. Please try again.",
        audioReady: true,
        confidence: 0,
      };
    }
  }

  private buildUserMessage(input: FrameInput) {
    const parts: Array<object> = [];

    // Always include the frame for visual grounding
    parts.push({
      inlineData: {
        mimeType: input.mimeType,
        data: input.imageData,
      },
    });

    // Add user query if present, or prompt scene analysis
    parts.push({
      text: input.userQuery
        ? input.userQuery
        : "What do you see? Describe any components or tasks I might be working on.",
    });

    return { role: 'user', parts };
  }

  private async callModel(): Promise<{ text?: string; toolCalls?: Array<{ name: string; args: object }> }> {
    const result = await this.model.generateContent({
      contents: this.conversationHistory as any,
      tools: ADK_TOOL_DEFINITIONS as any,
    });

    const candidate = result.response.candidates?.[0];
    if (!candidate?.content) return { text: '' };

    const textParts = candidate.content.parts
      ?.filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join('');

    const toolCallParts = candidate.content.parts
      ?.filter((p: any) => p.functionCall)
      .map((p: any) => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));

    return {
      text: textParts || undefined,
      toolCalls: toolCallParts && toolCallParts.length > 0 ? toolCallParts : undefined,
    };
  }

  private async executeToolCalls(
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
    input: FrameInput
  ): Promise<{ parts: Array<object>; spatialAnnotations: SpatialAnnotation[]; sourceDocuments: string[] }> {
    const parts: Array<object> = [];
    const spatialAnnotations: SpatialAnnotation[] = [];
    const sourceDocuments: string[] = [];

    for (const toolCall of toolCalls) {
      logger.debug(`Executing tool: ${toolCall.name}`, toolCall.args);

      let result: Record<string, unknown>;

      if (toolCall.name === 'analyze_visual_scene') {
        result = await this.visionTool.execute({
          imageData: input.imageData,
          mimeType: input.mimeType,
          focusQuery: toolCall.args.focusQuery as string,
          requireSpatial: toolCall.args.requireSpatial as boolean ?? true,
        });

        if (result.annotations) {
          spatialAnnotations.push(...(result.annotations as SpatialAnnotation[]));
        }

      } else if (toolCall.name === 'lookup_manual_instructions') {
        result = await this.manualTool.execute({
          query: toolCall.args.query as string,
          context: toolCall.args.context as string,
          domain: toolCall.args.domain as string,
          stepNumber: toolCall.args.stepNumber as number,
        });

        if (result.sources) {
          sourceDocuments.push(...(result.sources as string[]));
        }

      } else {
        result = { error: `Unknown tool: ${toolCall.name}` };
      }

      parts.push({
        functionResponse: {
          name: toolCall.name,
          response: result,
        },
      });
    }

    return { parts, spatialAnnotations, sourceDocuments };
  }

  /** Reset conversation for a new task context */
  resetContext(): void {
    this.conversationHistory = [];
    logger.info(`Context reset for session ${this.sessionId}`);
  }

  /** Get current conversation depth */
  get turnCount(): number {
    return this.conversationHistory.filter(m => m.role === 'user').length;
  }
}
