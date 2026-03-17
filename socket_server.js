// socket_server.js — Entry point

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { logger } from './logger.js';

import { initHrof } from './games/hrof.js';
import { initFawazir } from './games/fawazir.js';
import { initMnAna } from './games/mn-ana.js';
import { initFamilyFeud } from './games/family-feud.js';

const app = express();
const server = http.createServer(app);

// === CORS ===
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:5173',
      'http://localhost:8888',
      'https://diggies.games',
      'https://www.diggies.games',
      'https://devdigg.netlify.app',
    ];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS },
});

// === Rate Limiting (shared across all namespaces) ===
const RATE_LIMIT_WINDOW = 1000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map();

function isRateLimited(socketId) {
  const now = Date.now();
  let entry = rateLimitMap.get(socketId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(socketId, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function applyRateLimit(nsp) {
  nsp.use((socket, next) => {
    const originalOn = socket.on.bind(socket);
    socket.on = (event, handler) => {
      if (['connect', 'disconnect', 'error'].includes(event)) {
        return originalOn(event, handler);
      }
      return originalOn(event, (...args) => {
        if (isRateLimited(socket.id)) return;
        handler(...args);
      });
    };
    originalOn('disconnect', () => {
      rateLimitMap.delete(socket.id);
    });
    next();
  });
}

applyRateLimit(io);
applyRateLimit(io.of('/fawazir'));
applyRateLimit(io.of('/mn-ana'));
applyRateLimit(io.of('/family-feud'));

// === Health endpoint ===
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    connections: io.engine.clientsCount,
  });
});

// === Initialize all games ===
initHrof(io);
initFawazir(io);
initMnAna(io);
initFamilyFeud(io);

// === Start server ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Socket.IO server running on port ${PORT}`);
  logger.info(`Namespaces: default (hrof+thdi), /fawazir, /mn-ana, /family-feud`);
  logger.info({ origins: ALLOWED_ORIGINS }, 'Allowed origins');
});

// === Process error handling (#7) ===
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection — shutting down');
  process.exit(1);
});

// === Graceful shutdown (#7) ===
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    io.close(() => {
      logger.info('Socket.IO closed');
      process.exit(0);
    });
  });
  // Force exit if still hanging after 10s
  setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
