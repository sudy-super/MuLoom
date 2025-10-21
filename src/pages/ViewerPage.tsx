import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../components/CodeEditor';
import { ShaderFallbackLayer, VideoFallbackLayer } from '../components/FallbackLayers';
import { AudioInput, type AudioAnalysis } from '../modules/AudioInput';
import { GLSLGenerator, type ModelProvider } from '../modules/GLSLGenerator';
import { GLSLRenderer } from '../modules/GLSLRenderer';
import { useRealtime } from '../modules/useRealtime';
import type { StartVisualizationPayload } from '../types/realtime';
import { computeDeckMix, type DeckKey, MIX_DECK_KEYS } from '../utils/mix';
import '../App.css';

const MAX_RETRIES = 5;

const ViewerPage = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioInputRef = useRef<AudioInput | null>(null);
  const glslGeneratorRef = useRef<GLSLGenerator | null>(null);
  const rendererRef = useRef<GLSLRenderer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const retryCountRef = useRef(0);
  const generativeShaderRef = useRef<string>('');

  const geminiApiKeyRef = useRef('');
  const openaiApiKeyRef = useRef('');
  const modelProviderRef = useRef<ModelProvider>('gemini');
  const audioModeRef = useRef<'file' | 'microphone'>('file');
  const promptRef = useRef('');

  const audioSensitivityRef = useRef<number>(1.0);
  const audioFileRef = useRef<File | null>(null);
  const audioUnsubscribeRef = useRef<(() => void) | null>(null);
  const fallbackAudioHandlersRef = useRef<
    Map<string, (data: AudioAnalysis, sensitivity: number) => void>
  >(new Map());

  const [isRunning, setIsRunning] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [audioSensitivity, setAudioSensitivityState] = useState(1.0);

  const startVisualizationRef = useRef<(payload: StartVisualizationPayload) => void>(() => {});
  const stopVisualizationRef = useRef<() => void>(() => {});
  const regenerateShaderRef = useRef<() => void>(() => {});
  const setSensitivityRef = useRef<(value: number) => void>(() => {});

  const { assets, mixState, send } = useRealtime('viewer', {
    onStartVisualization: (payload) => startVisualizationRef.current(payload),
    onStopVisualization: () => stopVisualizationRef.current(),
    onRegenerateShader: () => regenerateShaderRef.current(),
    onSetAudioSensitivity: (value) => setSensitivityRef.current(value),
  });

  const registerFallbackAudioHandler = useCallback(
    (key: string, handler: (data: AudioAnalysis, sensitivity: number) => void) => {
      fallbackAudioHandlersRef.current.set(key, handler);
      return () => {
        fallbackAudioHandlersRef.current.delete(key);
      };
    },
    [],
  );

  useEffect(() => {
    if (canvasRef.current && !rendererRef.current) {
      rendererRef.current = new GLSLRenderer(canvasRef.current);
    }

    return () => {
      if (glslGeneratorRef.current) {
        glslGeneratorRef.current.destroy();
        glslGeneratorRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
      if (audioInputRef.current) {
        audioInputRef.current.stop();
        audioInputRef.current = null;
      }
      if (audioUnsubscribeRef.current) {
        audioUnsubscribeRef.current();
        audioUnsubscribeRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    send({
      type: 'viewer-status',
      payload: {
        isRunning,
        isGenerating,
        error,
        audioSensitivity,
      },
    });
  }, [send, isRunning, isGenerating, error, audioSensitivity]);

  const updateAudioSensitivity = useCallback(
    (value: number) => {
      audioSensitivityRef.current = value;
      setAudioSensitivityState(value);
      send({
        type: 'viewer-status',
        payload: { audioSensitivity: value },
      });
    },
    [send],
  );

  setSensitivityRef.current = updateAudioSensitivity;

  const attachAudioInput = useCallback(async () => {
    if (audioInputRef.current) {
      audioInputRef.current.stop();
      audioInputRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }

    if (audioModeRef.current === 'file') {
      const file = audioFileRef.current;
      if (!file) {
        throw new Error('Viewer: audio file not selected. Please choose a file locally.');
      }

      const audio = new Audio(URL.createObjectURL(file));
      audio.loop = true;
      audioElementRef.current = audio;

      audioInputRef.current = new AudioInput();
      audioInputRef.current.initAudioElement(audio);
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioInputRef.current = new AudioInput();
      audioInputRef.current.initMicrophone(stream);
    }
  }, []);

  const attachGenerator = useCallback((apiKey: string) => {
    if (glslGeneratorRef.current) {
      glslGeneratorRef.current.destroy();
      glslGeneratorRef.current = null;
    }

    glslGeneratorRef.current = new GLSLGenerator({
      apiKey,
      audioFile: audioModeRef.current === 'file' ? audioFileRef.current ?? undefined : undefined,
      prompt: audioModeRef.current === 'microphone' ? promptRef.current : undefined,
      modelProvider: modelProviderRef.current,
      model: modelProviderRef.current === 'openai' ? 'gpt-4o' : 'gemini-2.5-flash',
    });

    glslGeneratorRef.current.subscribeProgress((progress) => {
      setGeneratedCode(progress.code);
      setIsGenerating(!progress.isComplete);
      send({
        type: 'code-progress',
        payload: progress,
      });
    });

    glslGeneratorRef.current.subscribe(async (glslCode) => {
      if (!rendererRef.current) {
        return;
      }

      const success = await rendererRef.current.updateShader(glslCode);

      if (!success) {
        retryCountRef.current += 1;
        if (retryCountRef.current < MAX_RETRIES && glslGeneratorRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await glslGeneratorRef.current.generateGLSL();
        } else {
          setError(`Shader compilation failed after ${MAX_RETRIES} attempts.`);
          setIsGenerating(false);
          if (glslGeneratorRef.current) {
            await glslGeneratorRef.current.rollbackToPreviousShader();
          }
        }
      } else {
        retryCountRef.current = 0;
        generativeShaderRef.current = glslCode;
        if (audioElementRef.current) {
          audioElementRef.current.play().catch(() => {});
        }
      }
    });
  }, [send]);

  const startVisualization = useCallback(
    async (payload: StartVisualizationPayload) => {
      modelProviderRef.current = payload.modelProvider;
      audioModeRef.current = payload.audioInputMode;
      promptRef.current = payload.prompt || '';

      if (payload.geminiApiKey) {
        geminiApiKeyRef.current = payload.geminiApiKey;
      }
      if (payload.openaiApiKey) {
        openaiApiKeyRef.current = payload.openaiApiKey;
      }

      const activeApiKey =
        modelProviderRef.current === 'gemini' ? geminiApiKeyRef.current : openaiApiKeyRef.current;

      if (!activeApiKey) {
        setError('Missing API key on viewer. Please provide it via the control panel.');
        return;
      }

      if (audioModeRef.current === 'microphone' && !promptRef.current.trim()) {
        setError('Prompt not provided. Please configure it from the control panel.');
        return;
      }

      try {
        setError('');
        await attachAudioInput();

        if (!rendererRef.current) {
          throw new Error('Renderer not initialised.');
        }

        attachGenerator(activeApiKey);

        if (audioInputRef.current) {
          if (audioUnsubscribeRef.current) {
            audioUnsubscribeRef.current();
          }
          audioUnsubscribeRef.current = audioInputRef.current.subscribe((audioData) => {
            if (rendererRef.current) {
              rendererRef.current.updateAudioData(audioData, audioSensitivityRef.current);
            }
            fallbackAudioHandlersRef.current.forEach((handler) =>
              handler(audioData, audioSensitivityRef.current),
            );
          });
        }

        setIsRunning(true);
        await glslGeneratorRef.current?.generateGLSL();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start visualisation.');
      }
    },
    [attachAudioInput, attachGenerator],
  );

  startVisualizationRef.current = startVisualization;

  const stopVisualization = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current = null;
    }

    if (glslGeneratorRef.current) {
      glslGeneratorRef.current.destroy();
      glslGeneratorRef.current = null;
    }

    if (audioInputRef.current) {
      audioInputRef.current.stop();
      audioInputRef.current = null;
    }

    if (audioUnsubscribeRef.current) {
      audioUnsubscribeRef.current();
      audioUnsubscribeRef.current = null;
    }

    setIsRunning(false);
    setIsGenerating(false);
    setError('');
    send({
      type: 'viewer-status',
      payload: {
        isRunning: false,
        isGenerating: false,
        error: '',
      },
    });
  }, [send]);

  stopVisualizationRef.current = stopVisualization;

  const regenerateShader = useCallback(async () => {
    if (glslGeneratorRef.current && !isGenerating) {
      await glslGeneratorRef.current.generateGLSL();
    }
  }, [isGenerating]);

  regenerateShaderRef.current = regenerateShader;

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  }, []);

  const { outputs: deckOutputs } = computeDeckMix(mixState);

  const renderDeckLayer = (deckKey: DeckKey) => {
    const deck = mixState?.decks?.[deckKey];
    const effectiveOpacity = deckOutputs[deckKey] ?? 0;
    if (!deck || !deck.type || effectiveOpacity <= 0) {
      return null;
    }

    const blendMode = deckKey === 'b' || deckKey === 'd' ? 'add' : 'screen';

    if (deck.type === 'generative') {
      if (!generativeShaderRef.current) return null;
      return (
        <ShaderFallbackLayer
          key={`deck-${deckKey}-generative`}
          layerKey={`mix-deck-${deckKey}`}
          shaderCode={generativeShaderRef.current}
          opacity={effectiveOpacity}
          blendMode={blendMode}
          registerAudioHandler={registerFallbackAudioHandler}
        />
      );
    }

    if (deck.type === 'shader' && deck.assetId) {
      const shader = assets.glsl.find((item) => item.id === deck.assetId);
      if (!shader) return null;
      return (
        <ShaderFallbackLayer
          key={`deck-${deckKey}-${deck.assetId}`}
          layerKey={`mix-deck-${deckKey}`}
          shaderCode={shader.code}
          opacity={effectiveOpacity}
          blendMode={blendMode}
          registerAudioHandler={registerFallbackAudioHandler}
        />
      );
    }

    if (deck.type === 'video' && deck.assetId) {
      const video = assets.videos.find((item) => item.id === deck.assetId);
      if (!video) return null;
      return (
        <VideoFallbackLayer
          key={`deck-${deckKey}-${deck.assetId}`}
          id={`mix-video-${deckKey}`}
          src={video.url}
          opacity={effectiveOpacity}
          blendMode={blendMode}
        />
      );
    }

    return null;
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFullscreen().catch(() => {});
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleFullscreen]);

  return (
    <div className="app viewer-app">
      <canvas ref={canvasRef} className="glsl-canvas" />
      <CodeEditor code={generatedCode} isVisible={isGenerating} />
      <div className="mix-layer-stack">
        {MIX_DECK_KEYS.map((key) => renderDeckLayer(key))}
      </div>

    </div>
  );
};

export default ViewerPage;
