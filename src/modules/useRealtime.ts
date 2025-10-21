import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ControlSettings,
  FallbackAssets,
  FallbackLayer,
  InboundMessage,
  MixDeck,
  MixState,
  OutboundMessage,
  StartVisualizationPayload,
  ViewerStatus,
} from '../types/realtime';

const MIX_DECK_KEYS = ['a', 'b', 'c', 'd'] as const;
const EMPTY_DECK: MixDeck = { type: null, assetId: null, opacity: 0, enabled: false };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const buildBackendOrigin = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:4000`;
  }

  return window.location.origin;
};

const normaliseAssetUrls = (assets: FallbackAssets): FallbackAssets => {
  const origin = buildBackendOrigin();
  const normaliseUrl = (url: string) => {
    if (!url || !origin) {
      return url;
    }
    try {
      return new URL(url, origin).toString();
    } catch {
      if (url.startsWith('/')) {
        return `${origin}${url}`;
      }
      return url;
    }
  };

  return {
    glsl: assets.glsl ?? [],
    videos: (assets.videos ?? []).map((video) => ({
      ...video,
      url: normaliseUrl(video.url),
    })),
    overlays: (assets.overlays ?? []).map((overlay) => ({
      ...overlay,
      url: normaliseUrl(overlay.url),
    })),
  };
};

type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RealtimeHandlers {
  onStartVisualization?: (payload: StartVisualizationPayload) => void;
  onStopVisualization?: () => void;
  onRegenerateShader?: () => void;
  onSetAudioSensitivity?: (value: number) => void;
  onCodeProgress?: (payload: { code: string; isComplete: boolean }) => void;
}

export function useRealtime(role: 'viewer' | 'controller', handlers: RealtimeHandlers = {}) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [fallbackLayers, setFallbackLayers] = useState<FallbackLayer[]>([]);
  const [controlSettings, setControlSettings] = useState<ControlSettings>({
    modelProvider: 'gemini',
    audioInputMode: 'file',
    prompt: '',
  });
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>({
    isRunning: false,
    isGenerating: false,
    error: '',
  });
  const [assets, setAssets] = useState<FallbackAssets>(() =>
    normaliseAssetUrls({
      glsl: [],
      videos: [],
      overlays: [],
    }),
  );
  const normaliseMixState = useCallback((incoming?: Partial<MixState> | null): MixState => {
    const source = incoming ?? {};
    const decks = (source.decks ?? {}) as Partial<Record<typeof MIX_DECK_KEYS[number], MixDeck>>;
    const normalisedDecks = {} as Record<typeof MIX_DECK_KEYS[number], MixDeck>;
    MIX_DECK_KEYS.forEach((key) => {
      normalisedDecks[key] = { ...EMPTY_DECK, ...(decks[key] ?? {}) };
    });

    return {
      crossfaderAB: clamp01((source as any).crossfaderAB ?? (source as any).crossfader ?? 0.5),
      crossfaderAC: clamp01((source as any).crossfaderAC ?? 0.5),
      crossfaderBD: clamp01((source as any).crossfaderBD ?? 0.5),
      crossfaderCD: clamp01((source as any).crossfaderCD ?? 0.5),
      decks: normalisedDecks,
    };
  }, []);

  const [mixState, setMixState] = useState<MixState>(() => normaliseMixState());

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);

  handlersRef.current = handlers;

  const send = useCallback(
    (message: OutboundMessage) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    [],
  );

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const isDev = import.meta.env.DEV;
    const host = isDev
      ? `${window.location.hostname}:4000`
      : window.location.host;
    const wsUrl = `${protocol}://${host}/realtime`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setConnectionState('connecting');

    ws.onopen = () => {
      setConnectionState('open');
      ws.send(
        JSON.stringify({
          type: 'register',
          role,
        }),
      );
    };

    ws.onclose = () => {
      setConnectionState('closed');
    };

    ws.onmessage = (event) => {
      try {
        const message: InboundMessage = JSON.parse(event.data);
        switch (message.type) {
          case 'init': {
            setFallbackLayers(message.payload.state.fallbackLayers);
            setControlSettings(message.payload.state.controlSettings);
            setViewerStatus(message.payload.state.viewerStatus);
            setAssets(normaliseAssetUrls(message.payload.assets));
            if (message.payload.state.mixState) {
              setMixState(normaliseMixState(message.payload.state.mixState));
            }
            break;
          }
          case 'fallback-layers': {
            setFallbackLayers(message.payload);
            break;
          }
          case 'control-settings': {
            setControlSettings(message.payload);
            break;
          }
          case 'mix-state': {
            setMixState(normaliseMixState(message.payload));
            break;
          }
          case 'update-mix-deck': {
            setMixState((prev) => {
              const targetKey = message.payload.deck;
              const prevDeck = prev.decks[targetKey];
              if (!prevDeck) return prev;
              const updatedDeck: MixDeck = {
                ...prevDeck,
                ...message.payload.data,
              };
              if (!['shader', 'video', 'generative'].includes((updatedDeck.type as string) || '')) {
                updatedDeck.type = null;
              }
              if (updatedDeck.type === 'generative') {
                updatedDeck.assetId = null;
              }
              return normaliseMixState({
                crossfaderAB: prev.crossfaderAB,
                crossfaderAC: prev.crossfaderAC,
                crossfaderBD: prev.crossfaderBD,
                crossfaderCD: prev.crossfaderCD,
                decks: {
                  ...prev.decks,
                  [targetKey]: updatedDeck,
                },
              });
            });
            break;
          }
          case 'update-crossfader': {
            setMixState((prev) =>
              normaliseMixState({
                decks: prev.decks,
                crossfaderAB:
                  message.payload.target === 'ab' ? message.payload.value : prev.crossfaderAB,
                crossfaderAC:
                  message.payload.target === 'ac' ? message.payload.value : prev.crossfaderAC,
                crossfaderBD:
                  message.payload.target === 'bd' ? message.payload.value : prev.crossfaderBD,
                crossfaderCD:
                  message.payload.target === 'cd' ? message.payload.value : prev.crossfaderCD,
              }),
            );
            break;
          }
          case 'viewer-status': {
            setViewerStatus(message.payload);
            break;
          }
          case 'code-progress': {
            handlersRef.current.onCodeProgress?.(message.payload);
            break;
          }
          case 'start-visualization': {
            handlersRef.current.onStartVisualization?.(message.payload);
            break;
          }
          case 'stop-visualization': {
            handlersRef.current.onStopVisualization?.();
            break;
          }
          case 'regenerate-shader': {
            handlersRef.current.onRegenerateShader?.();
            break;
          }
          case 'set-audio-sensitivity': {
            handlersRef.current.onSetAudioSensitivity?.(message.payload.value);
            break;
          }
          default: {
            break;
          }
        }
      } catch (err) {
        console.error('Failed to handle realtime message:', err);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
      setConnectionState('closed');
    };
  }, [role, normaliseMixState]);

  return {
    connectionState,
    fallbackLayers,
    controlSettings,
    viewerStatus,
    assets,
    mixState,
    send,
  };
}
