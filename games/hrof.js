// games/hrof.js
// HROF (حروف) + THDI (تحدي الصور) — default namespace

import { logger } from '../logger.js';

const sessions = {};
const SESSION_TTL = 1 * 60 * 60 * 1000;

// #5: centralized session factory — replaces 10x repeated inline init
function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { _lastActivity: Date.now() };
  }
  return sessions[sessionId];
}

function touchSession(sessionId) {
  if (sessions[sessionId]) {
    sessions[sessionId]._lastActivity = Date.now();
  }
}

function isValidBuzzerState(stateObj) {
  return stateObj && ['IDLE', 'LOCKED'].includes(stateObj.state);
}

function isValidChangeQuestion(val) {
  return typeof val === 'number' || val === null;
}

function isValidSelectLetter(obj) {
  return obj && typeof obj.letter === 'string' && typeof obj.timestamp === 'number';
}

export function getHrofSessionCount() { return Object.keys(sessions).length; }

export function initHrof(io) {
  // #8: setInterval lives inside initHrof — safe to call initHrof once
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const id of Object.keys(sessions)) {
      const lastActivity = sessions[id]._lastActivity || 0;
      if (now - lastActivity > SESSION_TTL) {
        delete sessions[id];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned, remaining: Object.keys(sessions).length }, '[hrof] cleaned expired sessions');
    }
  }, 30 * 60 * 1000);

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, '[hrof] connected');

    // --- HROF events ---

    socket.on('join_session', (sessionId) => {
      if (!sessionId || typeof sessionId !== 'string') return;
      socket.join(sessionId);
      const session = getOrCreateSession(sessionId);
      touchSession(sessionId);
      if (session.teamConfig) socket.emit('team_config_updated', session.teamConfig);
      if (session.gridState) socket.emit('grid_updated', session.gridState);
      socket.emit('current_question_updated', session.currentQuestionData ?? null);
      socket.emit('buzzer_state', session.buzzerState || { state: 'IDLE' });
    });

    socket.on('get_buzzer_state', (sessionId) => {
      const state = sessions[sessionId]?.buzzerState || { state: 'IDLE' };
      socket.emit('buzzer_state', state);
    });

    socket.on('buzzer_pressed', ({ sessionId, playerName, playerTeam }) => {
      if (!sessionId || !playerName) return;
      const session = getOrCreateSession(sessionId);
      if (session.buzzerState?.state === 'LOCKED') return;
      const buzzerState = { state: 'LOCKED', pressedBy: playerName, team: playerTeam };
      session.buzzerState = buzzerState;
      touchSession(sessionId);
      io.to(sessionId).emit('buzzer_state', buzzerState);
    });

    socket.on('update_buzzer_state', ({ sessionId, data }) => {
      if (!isValidBuzzerState(data)) return;
      const session = getOrCreateSession(sessionId);
      session.buzzerState = data;
      touchSession(sessionId);
      io.to(sessionId).emit('buzzer_state', data);
    });

    socket.on('change_question', ({ sessionId, questionNumber }) => {
      if (!isValidChangeQuestion(questionNumber)) return;
      const session = getOrCreateSession(sessionId);
      session.currentQuestion = questionNumber;
      touchSession(sessionId);
      io.to(sessionId).emit('question_changed', questionNumber);
    });

    socket.on('select_letter', ({ sessionId, data }) => {
      if (!isValidSelectLetter(data)) return;
      const session = getOrCreateSession(sessionId);
      if (!session.actions) session.actions = {};
      session.actions.selectLetter = data;
      touchSession(sessionId);
      io.to(sessionId).emit('letter_selected', data);
    });

    socket.on('update_grid', ({ sessionId, grid }) => {
      if (!sessionId) return;
      const session = getOrCreateSession(sessionId);
      session.gridState = grid;
      touchSession(sessionId);
      io.to(sessionId).emit('grid_updated', grid);
    });

    socket.on('update_current_question', ({ sessionId, questionData }) => {
      if (!sessionId) return;
      const session = getOrCreateSession(sessionId);
      session.currentQuestionData = questionData ?? null;
      touchSession(sessionId);
      io.to(sessionId).emit('current_question_updated', questionData ?? null);
    });

    socket.on('request_grid_state', (sessionId) => {
      if (!sessionId) return;
      const grid = sessions[sessionId]?.gridState;
      if (grid) socket.emit('grid_updated', grid);
      socket.to(sessionId).emit('request_grid_state');
    });

    socket.on('request_team_config', (sessionId) => {
      if (!sessionId) return;
      const config = sessions[sessionId]?.teamConfig;
      if (config) socket.emit('team_config_updated', config);
      socket.to(sessionId).emit('request_team_config');
    });

    socket.on('request_current_question', (sessionId) => {
      if (!sessionId) return;
      socket.emit('current_question_updated', sessions[sessionId]?.currentQuestionData ?? null);
      socket.to(sessionId).emit('request_current_question');
    });

    socket.on('update_team_config', ({ sessionId, teamConfig }) => {
      if (!sessionId || !teamConfig) return;
      const session = getOrCreateSession(sessionId);
      session.teamConfig = teamConfig;
      touchSession(sessionId);
      io.to(sessionId).emit('team_config_updated', teamConfig);
    });

    // --- THDI / Photo Challenge events ---

    socket.on('photo_game_request', (sessionId) => {
      const rawState = sessions[sessionId]?.photoGameState || null;
      socket.emit('photo_game_updated', rawState);
    });

    socket.on('photo_game_update', ({ sessionId, gameState }) => {
      if (!sessionId) return;
      const session = getOrCreateSession(sessionId);
      session.photoGameState = gameState;
      touchSession(sessionId);
      io.to(sessionId).emit('photo_game_updated', gameState);
    });

    socket.on('photo_buzzer_pressed', ({ sessionId, playerName, playerTeam }) => {
      if (!sessionId || !playerName) return;
      const session = getOrCreateSession(sessionId);
      if (session.photoBuzzerState?.state !== 'LOCKED') {
        const newState = { state: 'LOCKED', pressedBy: playerName, team: playerTeam };
        session.photoBuzzerState = newState;
        touchSession(sessionId);
        io.to(sessionId).emit('photo_buzzer_state', newState);
      }
    });

    socket.on('update_photo_buzzer_state', ({ sessionId, data }) => {
      if (!sessionId) return;
      const session = getOrCreateSession(sessionId);
      session.photoBuzzerState = data;
      touchSession(sessionId);
      io.to(sessionId).emit('photo_buzzer_state', data);
    });

    socket.on('update_photo_team_config', ({ sessionId, teamConfig }) => {
      if (!sessionId) return;
      const session = getOrCreateSession(sessionId);
      session.photoTeamConfig = teamConfig;
      touchSession(sessionId);
      io.to(sessionId).emit('photo_team_config_updated', teamConfig);
    });

    socket.on('request_photo_team_config', (sessionId) => {
      const config = sessions[sessionId]?.photoTeamConfig || null;
      if (config) {
        socket.emit('photo_team_config_updated', config);
      }
    });

    // --- Shared disconnect/cleanup ---

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room !== socket.id && sessions[room]) {
          const roomSockets = io.sockets.adapter.rooms.get(room);
          if (roomSockets && roomSockets.size <= 1) {
            const session = sessions[room];
            if (session.photoGameState || session.gridState || session.currentQuestionData) {
              continue;
            }
            delete sessions[room];
          }
        }
      }
    });

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, '[hrof] disconnected');
    });
  });
}
