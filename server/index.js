#!/usr/bin/env node

/**
 * Lightweight control server providing shared state, asset discovery, and
 * realtime coordination between the viewer surface and remote control panel.
 */

import cors from 'cors';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import url from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const glslDir = path.resolve(__dirname, '../glsl');
const mp4Dir = path.resolve(__dirname, '../mp4');
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function readFallbackAssets() {
  const glsl = [];
  if (fs.existsSync(glslDir)) {
    for (const entry of fs.readdirSync(glslDir)) {
      if (entry.toLowerCase().endsWith('.glsl')) {
        const filePath = path.join(glslDir, entry);
        try {
          const code = fs.readFileSync(filePath, 'utf8');
          glsl.push({
            id: entry,
            name: entry.replace(/\.glsl$/i, ''),
            code,
          });
        } catch (err) {
          console.error(`Failed to read GLSL fallback ${entry}:`, err);
        }
      }
    }
  }

  const videos = [];
  if (fs.existsSync(mp4Dir)) {
    for (const category of fs.readdirSync(mp4Dir)) {
      const categoryDir = path.join(mp4Dir, category);
      try {
        const stats = fs.statSync(categoryDir);
        if (!stats.isDirectory()) {
          continue;
        }
      } catch (err) {
        console.error(`Failed to inspect mp4 category ${category}:`, err);
        continue;
      }

      let entries = [];
      try {
        entries = fs.readdirSync(categoryDir);
      } catch (err) {
        console.error(`Failed to read mp4 category ${category}:`, err);
        continue;
      }

      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith('.mp4')) {
          continue;
        }
        const filePath = path.join(category, entry);
        videos.push({
          id: filePath,
          name: entry.replace(/\.mp4$/i, ''),
          category,
          url: `/stream/mp4/${filePath}`,
        });
      }
    }
  }

  return { glsl, videos };
}

const defaultMixDeck = () => ({
  type: null,
  assetId: null,
  opacity: 1,
  enabled: false,
});

const defaultDeckMediaState = () => ({
  isPlaying: false,
  progress: 0,
  isLoading: false,
  error: false,
  src: null,
});

const state = {
  fallbackLayers: [],
  controlSettings: {
    modelProvider: 'gemini',
    audioInputMode: 'file',
    prompt: '',
  },
  viewerStatus: {
    isRunning: false,
    isGenerating: false,
    error: '',
  },
  mixState: {
    crossfaderAB: 0.5,
    crossfaderAC: 0.5,
    crossfaderBD: 0.5,
    crossfaderCD: 0.5,
    decks: {
      a: defaultMixDeck(),
      b: defaultMixDeck(),
      c: defaultMixDeck(),
      d: defaultMixDeck(),
    },
  },
  deckMediaStates: {
    a: defaultDeckMediaState(),
    b: defaultDeckMediaState(),
    c: defaultDeckMediaState(),
    d: defaultDeckMediaState(),
  },
};

const clients = new Set();

function broadcastMixState() {
  broadcast({
    type: 'mix-state',
    payload: state.mixState,
  });
}

function broadcast(message, options = {}) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (options.exclude && options.exclude === client.ws) {
      continue;
    }
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(payload);
    }
  }
}

const crossfaderFieldMap = {
  main: 'crossfaderAB',
  ab: 'crossfaderAB',
  ac: 'crossfaderAC',
  bd: 'crossfaderBD',
  cd: 'crossfaderCD',
};

function applyCrossfaderUpdate(payload) {
  if (!payload) return false;
  const target =
    typeof payload.target === 'string' ? payload.target.trim().toLowerCase() : undefined;
  const field = target ? crossfaderFieldMap[target] : undefined;
  if (!field || !(field in state.mixState)) {
    return false;
  }
  const value = Math.min(1, Math.max(0, Number(payload.value ?? 0)));
  state.mixState[field] = value;
  broadcastMixState();
  return true;
}

function handleRTCSignaling(message, ws) {
  if (!message || typeof message.rtc !== 'string') {
    return;
  }

  const rtcType = message.rtc.trim().toLowerCase();
  if (!['offer', 'answer', 'ice-candidate', 'request-offer'].includes(rtcType)) {
    return;
  }

  broadcast(
    {
      type: 'rtc-signal',
      rtc: rtcType,
      payload: message.payload ?? null,
    },
    { exclude: ws },
  );
}

app.get('/api/fallback-assets', (_req, res) => {
  res.json(readFallbackAssets());
});

app.get('/api/state', (_req, res) => {
  res.json({
    state,
    assets: readFallbackAssets(),
  });
});

app.get(/^\/stream\/mp4\/(.+)$/, async (req, res) => {
  const requestedPath = (req.params[0] || '').trim();
  if (!requestedPath) {
    res.sendStatus(404);
    return;
  }

  const normalizedPath = path.normalize(requestedPath).replace(/^([/\\])+/, '');
  if (normalizedPath.includes('..')) {
    res.status(400).send('Invalid video path');
    return;
  }

  const absolutePath = path.resolve(mp4Dir, normalizedPath);
  const isInsideMp4Dir =
    absolutePath === mp4Dir || absolutePath.startsWith(`${mp4Dir}${path.sep}`);
  if (!isInsideMp4Dir) {
    res.status(400).send('Invalid video path');
    return;
  }

  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`Failed to inspect video file ${absolutePath}:`, err);
    }
    res.sendStatus(404);
    return;
  }

  if (!stats.isFile()) {
    res.sendStatus(404);
    return;
  }

  const rangeHeader = req.headers.range;
  const contentType = 'video/mp4';

  if (!rangeHeader) {
    res.set({
      'Content-Length': `${stats.size}`,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', (err) => {
      console.error(`Error streaming video ${absolutePath}:`, err);
      if (!res.headersSent) {
        res.sendStatus(500);
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
    return;
  }

  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!matches) {
    res
      .status(416)
      .set('Content-Range', `bytes */${stats.size}`)
      .send('Malformed Range header');
    return;
  }

  const startString = matches[1];
  const endString = matches[2];
  let start;
  let end;

  if (startString === '' && endString) {
    const suffixLength = Number(endString);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      res
        .status(416)
        .set('Content-Range', `bytes */${stats.size}`)
        .send('Invalid Range');
      return;
    }
    end = stats.size - 1;
    start = Math.max(0, stats.size - suffixLength);
  } else {
    start = Number(startString);
    if (!Number.isFinite(start) || start < 0) {
      res
        .status(416)
        .set('Content-Range', `bytes */${stats.size}`)
        .send('Invalid Range');
      return;
    }
    end = endString ? Number(endString) : stats.size - 1;
    if (!Number.isFinite(end) || end < start) {
      res
        .status(416)
        .set('Content-Range', `bytes */${stats.size}`)
        .send('Invalid Range');
      return;
    }
    end = Math.min(end, stats.size - 1);
  }

  if (start >= stats.size) {
    res
      .status(416)
      .set('Content-Range', `bytes */${stats.size}`)
      .send('Range Not Satisfiable');
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206).set({
    'Content-Range': `bytes ${start}-${end}/${stats.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': `${chunkSize}`,
    'Content-Type': contentType,
  });

  const stream = fs.createReadStream(absolutePath, { start, end });
  stream.on('error', (err) => {
    console.error(`Error streaming video chunk ${absolutePath}:`, err);
    if (!res.headersSent) {
      res.sendStatus(500);
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

app.use('/assets/mp4', express.static(mp4Dir, { fallthrough: true }));

const distDir = path.resolve(__dirname, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (ws) => {
  const client = { ws, role: 'unknown' };
  clients.add(client);

  ws.send(
    JSON.stringify({
      type: 'init',
      payload: {
        state,
        assets: readFallbackAssets(),
      },
    }),
  );

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      console.error('Failed to parse incoming message:', err);
      return;
    }

    switch (message.type) {
      case 'register': {
        client.role = message.role || 'unknown';
        break;
      }
      case 'update-fallback-layers': {
        state.fallbackLayers = message.payload || [];
        broadcast(
          {
            type: 'fallback-layers',
            payload: state.fallbackLayers,
          },
          { exclude: ws },
        );
        break;
      }
      case 'update-control-settings': {
        state.controlSettings = {
          ...state.controlSettings,
          ...(message.payload || {}),
        };
        broadcast(
          {
            type: 'control-settings',
            payload: state.controlSettings,
          },
          { exclude: ws },
        );
        break;
      }
      case 'update-mix-deck': {
        const deck = message.payload?.deck;
        const data = message.payload?.data || {};
        if (deck && state.mixState.decks[deck]) {
          state.mixState.decks[deck] = {
            ...state.mixState.decks[deck],
            ...data,
          };
          const current = state.mixState.decks[deck];
          if (!['shader', 'video', 'generative'].includes(current.type)) {
            current.type = null;
          }
          if (current.type === 'generative') {
            current.assetId = null;
          } else if (!current.assetId || !current.type) {
            current.type = null;
            current.assetId = null;
          }
          current.opacity = Math.min(1, Math.max(0, Number(current.opacity ?? 1)));
          current.enabled = Boolean(current.enabled);
          broadcastMixState();
        }
        break;
      }
      case 'update-crossfader':
      case 'updateCrossfader': {
        if (!applyCrossfaderUpdate(message.payload)) {
          console.warn('Invalid crossfader payload:', message.payload);
        }
        break;
      }
      case 'start-visualization':
      case 'stop-visualization':
      case 'regenerate-shader':
      case 'set-audio-sensitivity': {
        broadcast(message, { exclude: ws });
        break;
      }
      case 'viewer-status': {
        state.viewerStatus = {
          ...state.viewerStatus,
          ...(message.payload || {}),
        };
        broadcast(
          {
            type: 'viewer-status',
            payload: state.viewerStatus,
          },
          { exclude: ws },
        );
        break;
      }
      case 'code-progress': {
        broadcast(message, { exclude: ws });
        break;
      }
      case 'deck-media-state': {
        const deck = message.payload?.deck;
        const deckState = message.payload?.state;
        if (deck && state.deckMediaStates[deck] && deckState) {
          state.deckMediaStates[deck] = {
            isPlaying: Boolean(deckState.isPlaying),
            progress: Math.max(0, Math.min(100, Number(deckState.progress ?? 0))),
            isLoading: Boolean(deckState.isLoading),
            error: Boolean(deckState.error),
            src:
              typeof deckState.src === 'string' && deckState.src.trim().length > 0
                ? deckState.src
                : null,
          };
          broadcast(
            {
              type: 'deck-media-state',
              payload: {
                deck,
                state: state.deckMediaStates[deck],
              },
            },
            { exclude: ws },
          );
        }
        break;
      }
      case 'rtc-signal': {
        handleRTCSignaling(message, ws);
        break;
      }
      default: {
        console.warn('Unhandled message type:', message.type);
      }
    }
  });

  ws.on('close', () => {
    clients.delete(client);
  });
});

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Control server running on http://localhost:${port}`);
});
