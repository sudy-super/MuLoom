import type { ModelProvider } from '../modules/GLSLGenerator';

export type LayerType = 'shader' | 'video';

export interface FallbackLayer {
  id: string;
  type: LayerType;
  name: string;
  opacity: number;
  blendMode?: 'normal' | 'screen' | 'add' | 'multiply' | 'overlay';
  order: number;
}

export interface MixDeck {
  type: LayerType | 'generative' | null;
  assetId: string | null;
  opacity: number;
  enabled: boolean;
}

export interface MixState {
  crossfaderAB: number;
  crossfaderAC: number;
  crossfaderBD: number;
  crossfaderCD: number;
  decks: Record<'a' | 'b' | 'c' | 'd', MixDeck>;
}

export interface FallbackAssets {
  glsl: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  videos: Array<{
    id: string;
    name: string;
    category: string;
    folder?: string;
    url: string;
  }>;
  overlays?: Array<{
    id: string;
    name: string;
    url: string;
    folder?: string;
  }>;
}

export interface ControlSettings {
  modelProvider: ModelProvider;
  audioInputMode: 'file' | 'microphone';
  prompt: string;
}

export interface ViewerStatus {
  isRunning: boolean;
  isGenerating: boolean;
  error: string;
  audioSensitivity?: number;
}

export interface StartVisualizationPayload {
  modelProvider: ModelProvider;
  geminiApiKey?: string;
  openaiApiKey?: string;
  audioInputMode: 'file' | 'microphone';
  prompt: string;
}

export type OutboundMessage =
  | { type: 'register'; role: 'viewer' | 'controller' }
  | { type: 'update-fallback-layers'; payload: FallbackLayer[] }
  | { type: 'update-control-settings'; payload: Partial<ControlSettings> }
  | { type: 'update-mix-deck'; payload: { deck: 'a' | 'b' | 'c' | 'd'; data: Partial<MixDeck> } }
  | { type: 'update-crossfader'; payload: { target: 'ab' | 'ac' | 'bd' | 'cd'; value: number } }
  | { type: 'start-visualization'; payload: StartVisualizationPayload }
  | { type: 'stop-visualization' }
  | { type: 'regenerate-shader' }
  | { type: 'set-audio-sensitivity'; payload: { value: number } }
  | { type: 'viewer-status'; payload: Partial<ViewerStatus> }
  | { type: 'code-progress'; payload: { code: string; isComplete: boolean } };

export type InboundMessage =
  | { type: 'init'; payload: { state: { fallbackLayers: FallbackLayer[]; controlSettings: ControlSettings; viewerStatus: ViewerStatus; mixState: MixState }; assets: FallbackAssets } }
  | { type: 'fallback-layers'; payload: FallbackLayer[] }
  | { type: 'control-settings'; payload: ControlSettings }
  | { type: 'mix-state'; payload: MixState }
  | { type: 'update-mix-deck'; payload: { deck: 'a' | 'b' | 'c' | 'd'; data: Partial<MixDeck> } }
  | { type: 'update-crossfader'; payload: { target: 'ab' | 'ac' | 'bd' | 'cd'; value: number } }
  | { type: 'viewer-status'; payload: ViewerStatus }
  | { type: 'code-progress'; payload: { code: string; isComplete: boolean } }
  | { type: 'start-visualization'; payload: StartVisualizationPayload }
  | { type: 'stop-visualization' }
  | { type: 'regenerate-shader' }
  | { type: 'set-audio-sensitivity'; payload: { value: number } };
