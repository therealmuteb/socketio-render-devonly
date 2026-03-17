// games/family-feud.js
// Family Feud (فاميلي فيود) game logic — namespace /family-feud

import { logger } from '../logger.js';

// ─── Game constants ───────────────────────────────────────────────────────────

const MAX_STRIKES = 3;
const FIRST_FACE_OFF_SECONDS = 5;
const NEXT_FACE_OFF_SECONDS = 10;
const SESSION_TTL = 4 * 60 * 60 * 1000;

// ─── Question helpers (work on questions array provided by the client) ───────

function createQuestionOrder(questions) {
  const order = questions.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function getQuestionByOrder(questions, order, position) {
  if (!questions.length) return null;
  const idx = order?.[position];
  const fallback = Math.min(Math.max(position ?? 0, 0), questions.length - 1);
  return questions[idx ?? fallback] || questions[0];
}

function getQuestionCount(questions) {
  return questions.length;
}

function isFinalQuestion(order, position) {
  return Array.isArray(order) && order.length > 0 && position === order.length - 1;
}

function getRoundMultiplierForOrder(questions, order, position) {
  const question = getQuestionByOrder(questions, order, position);
  const base = question?.multiplier || 1;
  return isFinalQuestion(order, position) ? Math.max(2, base) : base;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const ffSessions = {};

function getOrCreateSession(sessionId) {
  if (!ffSessions[sessionId]) {
    ffSessions[sessionId] = createSessionState();
  }
  ffSessions[sessionId].lastActivity = Date.now();
  return ffSessions[sessionId];
}

// ─── State factories ──────────────────────────────────────────────────────────

function createFaceOffState(participants = { 1: null, 2: null }, participantIndexes = { 1: null, 2: null }) {
  return {
    participants, participantIndexes,
    firstBuzzTeam: null, activeTeam: null, activeResponder: null,
    countdown: null, turnDuration: null,
    winnerTeam: null, loserTeam: null, winningAnswerIndex: null,
    lastCorrectAnswer: null, needsDecision: false,
    attempts: [], correctResponses: [], comparisonPending: false,
  };
}

function createInitialGameState() {
  return {
    teams: { 1: { id: 1, name: "الفريق الأول", score: 0 }, 2: { id: 2, name: "الفريق الثاني", score: 0 } },
    players: [],
    questions: [],
    questionOrder: [],
    currentQuestionIndex: 0,
    currentQuestion: null,
    totalQuestions: 0,
    isFinalQuestion: false,
    showBuzzerQr: false,
    buzzerInviteUrl: '',
    revealedAnswers: [],
    roundPoints: 0,
    roundMultiplier: 1,
    strikes: 0,
    showStrikeOverlay: false,
    buzzedPlayer: null,
    buzzedPlayersList: [],
    controlTeam: null,
    decisionTeam: null,
    roundOwnerTeam: null,
    currentAnsweringTeam: null,
    stealTeam: null,
    activePlayer: null,
    activePlayerIndexByTeam: { 1: 0, 2: 0 },
    nextFaceOffIndexByTeam: { 1: 0, 2: 0 },
    currentFaceOffIndexByTeam: { 1: null, 2: null },
    faceOff: createFaceOffState(),
    roundResolved: null,
    gamePhase: 'SETUP',
    canUndo: false,
  };
}

function createSessionState() {
  return {
    gameState: createInitialGameState(),
    playerJoinSequence: 1,
    faceOffTimer: null,
    strikeOverlayTimeout: null,
    lastHostSnapshot: null,
    lastActivity: Date.now(),
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initFamilyFeud(io) {
  const nsp = io.of('/family-feud');

  setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of Object.entries(ffSessions)) {
      if (now - sess.lastActivity > SESSION_TTL) {
        clearFaceOffTimer(sess);
        clearStrikeOverlayTimeout(sess);
        delete ffSessions[id];
        logger.info({ sessionId: id }, '[family-feud] session expired');
      }
    }
  }, 30 * 60 * 1000);

  // ─── Per-session helpers ────────────────────────────────────────────────────

  function clonePlayer(player) {
    return player
      ? { socketId: player.socketId, name: player.name, team: player.team, joinOrder: player.joinOrder }
      : null;
  }

  function clearFaceOffTimer(sess) {
    if (sess.faceOffTimer) { clearInterval(sess.faceOffTimer); sess.faceOffTimer = null; }
  }

  function clearStrikeOverlayTimeout(sess) {
    if (sess.strikeOverlayTimeout) { clearTimeout(sess.strikeOverlayTimeout); sess.strikeOverlayTimeout = null; }
  }

  function getOtherTeam(teamId) { return teamId === 1 ? 2 : 1; }

  function getTeamPlayers(sess, teamId) {
    return sess.gameState.players
      .filter(p => p.team === teamId)
      .sort((a, b) => a.joinOrder - b.joinOrder);
  }

  function getCurrentQuestion(sess, index) {
    const gs = sess.gameState;
    const i = index !== undefined ? index : gs.currentQuestionIndex;
    return getQuestionByOrder(gs.questions, gs.questionOrder, i);
  }

  function getRoundMultiplier(sess, index) {
    const gs = sess.gameState;
    const i = index !== undefined ? index : gs.currentQuestionIndex;
    return getRoundMultiplierForOrder(gs.questions, gs.questionOrder, i);
  }

  function isCurrentQuestionFinal(sess, index) {
    const i = index !== undefined ? index : sess.gameState.currentQuestionIndex;
    return isFinalQuestion(sess.gameState.questionOrder, i);
  }

  function syncDerivedState(sess) {
    const gs = sess.gameState;
    gs.currentQuestion = getCurrentQuestion(sess);
    gs.totalQuestions = getQuestionCount(gs.questions);
    gs.isFinalQuestion = isCurrentQuestionFinal(sess);
    gs.roundMultiplier = getRoundMultiplier(sess);

    if (gs.gamePhase !== 'BOARD_PLAY' || !gs.currentAnsweringTeam) {
      gs.activePlayer = null;
      return;
    }

    const teamPlayers = getTeamPlayers(sess, gs.currentAnsweringTeam);
    if (!teamPlayers.length) {
      gs.activePlayer = null;
      gs.activePlayerIndexByTeam[gs.currentAnsweringTeam] = 0;
      return;
    }

    let activeIndex = gs.activePlayerIndexByTeam[gs.currentAnsweringTeam] || 0;
    if (activeIndex >= teamPlayers.length) {
      activeIndex = 0;
      gs.activePlayerIndexByTeam[gs.currentAnsweringTeam] = 0;
    }
    gs.activePlayer = clonePlayer(teamPlayers[activeIndex]);
  }

  function emitState(sess, sessionId) {
    syncDerivedState(sess);
    sess.gameState.canUndo = Boolean(sess.lastHostSnapshot);
    nsp.to(sessionId).emit('gameStateUpdate', sess.gameState);
  }

  function saveHostSnapshot(sess) {
    sess.lastHostSnapshot = { gameState: structuredClone(sess.gameState) };
  }

  function scheduleStrikeOverlayClear(sess, sessionId, delay = 1500) {
    clearStrikeOverlayTimeout(sess);
    sess.strikeOverlayTimeout = setTimeout(() => {
      sess.gameState.showStrikeOverlay = false;
      emitState(sess, sessionId);
    }, delay);
  }

  function startFaceOffCountdownTimer(sess, sessionId) {
    clearFaceOffTimer(sess);
    sess.faceOffTimer = setInterval(() => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'FACE_OFF' || !gs.faceOff.activeTeam) {
        clearFaceOffTimer(sess);
        return;
      }
      if (gs.faceOff.countdown <= 1) {
        clearFaceOffTimer(sess);
        gs.faceOff.countdown = 0;
        emitState(sess, sessionId);
        handOffFaceOffTurn(sess, sessionId, 'timeout');
        return;
      }
      gs.faceOff.countdown -= 1;
      emitState(sess, sessionId);
    }, 1000);
  }

  function restoreHostSnapshot(sess, sessionId) {
    if (!sess.lastHostSnapshot) return false;
    clearFaceOffTimer(sess);
    clearStrikeOverlayTimeout(sess);
    sess.gameState = structuredClone(sess.lastHostSnapshot.gameState);
    sess.lastHostSnapshot = null;
    const gs = sess.gameState;

    if (gs.showStrikeOverlay && gs.gamePhase === 'BOARD_PLAY' && gs.strikes > 0) {
      scheduleStrikeOverlayClear(sess, sessionId);
    }
    if (
      gs.gamePhase === 'FACE_OFF' &&
      gs.faceOff.activeTeam &&
      Number.isInteger(gs.faceOff.countdown) &&
      gs.faceOff.countdown > 0
    ) {
      startFaceOffCountdownTimer(sess, sessionId);
    }
    emitState(sess, sessionId);
    return true;
  }

  function runHostAction(sess, sessionId, action, opts = { emit: true }) {
    const previousSnapshot = sess.lastHostSnapshot;
    saveHostSnapshot(sess);
    const result = action();
    if (result === false) {
      sess.lastHostSnapshot = previousSnapshot;
      return false;
    }
    if (opts.emit) emitState(sess, sessionId);
    return true;
  }

  function prepareFaceOffParticipants(sess, opts) {
    const gs = sess.gameState;
    const participants = { 1: null, 2: null };
    const participantIndexes = { 1: null, 2: null };

    [1, 2].forEach(teamId => {
      const teamPlayers = getTeamPlayers(sess, teamId);
      if (!teamPlayers.length) { gs.currentFaceOffIndexByTeam[teamId] = null; return; }

      let index;
      if (opts.advance || gs.currentFaceOffIndexByTeam[teamId] == null) {
        index = gs.nextFaceOffIndexByTeam[teamId] % teamPlayers.length;
        gs.nextFaceOffIndexByTeam[teamId] = (index + 1) % teamPlayers.length;
      } else {
        index = gs.currentFaceOffIndexByTeam[teamId] % teamPlayers.length;
      }

      gs.currentFaceOffIndexByTeam[teamId] = index;
      participantIndexes[teamId] = index;
      participants[teamId] = clonePlayer(teamPlayers[index]);
    });

    gs.faceOff = createFaceOffState(participants, participantIndexes);
  }

  function resetRoundState(sess, questionIndex, opts) {
    clearFaceOffTimer(sess);
    clearStrikeOverlayTimeout(sess);
    const gs = sess.gameState;
    gs.currentQuestionIndex = questionIndex;
    gs.revealedAnswers = [];
    gs.roundPoints = 0;
    gs.roundMultiplier = getRoundMultiplier(sess, questionIndex);
    gs.strikes = 0;
    gs.showStrikeOverlay = false;
    gs.buzzedPlayer = null;
    gs.buzzedPlayersList = [];
    gs.controlTeam = null;
    gs.decisionTeam = null;
    gs.roundOwnerTeam = null;
    gs.currentAnsweringTeam = null;
    gs.stealTeam = null;
    gs.activePlayer = null;
    gs.activePlayerIndexByTeam = { 1: 0, 2: 0 };
    gs.roundResolved = null;
    prepareFaceOffParticipants(sess, { advance: opts.advanceParticipants });
    gs.gamePhase = 'FACE_OFF';
  }

  function setStartingPlayerForTeam(sess, teamId) {
    const gs = sess.gameState;
    const teamPlayers = getTeamPlayers(sess, teamId);
    if (!teamPlayers.length) { gs.activePlayerIndexByTeam[teamId] = 0; syncDerivedState(sess); return; }
    const faceOffPlayer = gs.faceOff.participants[teamId];
    const faceOffIndex = faceOffPlayer
      ? teamPlayers.findIndex(p => p.socketId === faceOffPlayer.socketId)
      : -1;
    gs.activePlayerIndexByTeam[teamId] = faceOffIndex === -1
      ? 0
      : (teamPlayers.length > 1 ? (faceOffIndex + 1) % teamPlayers.length : faceOffIndex);
    syncDerivedState(sess);
  }

  function moveTurnToNextPlayer(sess, teamId) {
    const gs = sess.gameState;
    const teamPlayers = getTeamPlayers(sess, teamId);
    if (!teamPlayers.length) { gs.activePlayer = null; return; }
    const current = gs.activePlayerIndexByTeam[teamId] ?? -1;
    gs.activePlayerIndexByTeam[teamId] = (current + 1 + teamPlayers.length) % teamPlayers.length;
    syncDerivedState(sess);
  }

  function getAnswerAward(sess, answerIndex) {
    const answer = getCurrentQuestion(sess)?.answers?.[answerIndex];
    return answer ? answer.points * sess.gameState.roundMultiplier : 0;
  }

  function revealAnswer(sess, answerIndex) {
    const gs = sess.gameState;
    if (gs.revealedAnswers.includes(answerIndex)) return false;
    const answer = getCurrentQuestion(sess)?.answers?.[answerIndex];
    if (!answer) return false;
    gs.revealedAnswers.push(answerIndex);
    gs.revealedAnswers.sort((a, b) => a - b);
    gs.roundPoints += getAnswerAward(sess, answerIndex);
    return true;
  }

  function unrevealAnswer(sess, answerIndex) {
    const gs = sess.gameState;
    if (!gs.revealedAnswers.includes(answerIndex)) return false;
    gs.revealedAnswers = gs.revealedAnswers.filter(i => i !== answerIndex);
    gs.roundPoints = Math.max(0, gs.roundPoints - getAnswerAward(sess, answerIndex));
    return true;
  }

  function allAnswersRevealed(sess) {
    return getCurrentQuestion(sess)?.answers?.every((_, i) => sess.gameState.revealedAnswers.includes(i));
  }

  function resolveRound(sess, winnerTeam, reason) {
    const gs = sess.gameState;
    if (!winnerTeam || gs.roundResolved) return;
    gs.teams[winnerTeam].score += gs.roundPoints;
    gs.roundResolved = { winnerTeam, reason, awardedPoints: gs.roundPoints };
    gs.gamePhase = 'ROUND_OVER';
    gs.controlTeam = winnerTeam;
    gs.currentAnsweringTeam = null;
    gs.activePlayer = null;
    gs.decisionTeam = null;
    gs.stealTeam = null;
    gs.faceOff.needsDecision = false;
    clearFaceOffTimer(sess);
  }

  function getFaceOffAnswer(sess, answerIndex) {
    const answer = getCurrentQuestion(sess)?.answers?.[answerIndex];
    if (!answer) return null;
    return { answerIndex, text: answer.text, points: answer.points };
  }

  function getFaceOffTurnSeconds(sess, teamId) {
    if (!sess.gameState.faceOff.firstBuzzTeam) return FIRST_FACE_OFF_SECONDS;
    return teamId === sess.gameState.faceOff.firstBuzzTeam ? FIRST_FACE_OFF_SECONDS : NEXT_FACE_OFF_SECONDS;
  }

  function finalizeFaceOffDecision(sess, winningResponse) {
    if (!winningResponse) return false;
    const gs = sess.gameState;
    gs.faceOff.winningAnswerIndex = winningResponse.answerIndex;
    gs.faceOff.winnerTeam = winningResponse.teamId;
    gs.faceOff.loserTeam = getOtherTeam(winningResponse.teamId);
    gs.faceOff.needsDecision = true;
    gs.faceOff.comparisonPending = false;
    gs.faceOff.activeResponder = null;
    gs.faceOff.countdown = null;
    gs.faceOff.turnDuration = null;
    gs.faceOff.activeTeam = null;
    gs.gamePhase = 'DECISION';
    gs.controlTeam = winningResponse.teamId;
    gs.decisionTeam = winningResponse.teamId;
    gs.faceOff.lastCorrectAnswer = {
      answerIndex: winningResponse.answerIndex,
      text: winningResponse.text,
      points: winningResponse.points,
    };
    return true;
  }

  function startFaceOffTurn(sess, sessionId, teamId, seconds) {
    clearFaceOffTimer(sess);
    const responder = sess.gameState.faceOff.participants[teamId];
    if (!responder) return;
    sess.gameState.faceOff.activeTeam = teamId;
    sess.gameState.faceOff.activeResponder = clonePlayer(responder);
    sess.gameState.faceOff.turnDuration = seconds;
    sess.gameState.faceOff.countdown = seconds;
    emitState(sess, sessionId);
    startFaceOffCountdownTimer(sess, sessionId);
  }

  function handOffFaceOffTurn(sess, sessionId, reason = 'miss') {
    const gs = sess.gameState;
    if (gs.gamePhase !== 'FACE_OFF' || !gs.faceOff.firstBuzzTeam) return;
    const activeTeam = gs.faceOff.activeTeam;
    if (activeTeam) gs.faceOff.attempts.push({ teamId: activeTeam, result: reason });

    if (
      gs.faceOff.comparisonPending &&
      gs.faceOff.correctResponses.length === 1 &&
      activeTeam &&
      activeTeam !== gs.faceOff.correctResponses[0].teamId
    ) {
      finalizeFaceOffDecision(sess, gs.faceOff.correctResponses[0]);
      emitState(sess, sessionId);
      return;
    }

    const nextTeam = activeTeam ? getOtherTeam(activeTeam) : getOtherTeam(gs.faceOff.firstBuzzTeam);
    if (!gs.faceOff.participants[nextTeam]) {
      gs.faceOff.activeTeam = null;
      gs.faceOff.activeResponder = null;
      gs.faceOff.countdown = null;
      emitState(sess, sessionId);
      return;
    }
    startFaceOffTurn(sess, sessionId, nextTeam, getFaceOffTurnSeconds(sess, nextTeam));
  }

  function resolveFaceOffCorrect(sess, sessionId, answerIndex) {
    const gs = sess.gameState;
    const answer = getFaceOffAnswer(sess, answerIndex);
    if (!answer || !gs.faceOff.activeTeam) return false;

    clearFaceOffTimer(sess);
    const activeTeam = gs.faceOff.activeTeam;
    const opponentTeam = getOtherTeam(activeTeam);
    const response = { teamId: activeTeam, answerIndex, text: answer.text, points: answer.points };
    const opponentHasAttempted = gs.faceOff.attempts.some(a => a.teamId === opponentTeam);

    gs.faceOff.lastCorrectAnswer = answer;
    gs.faceOff.correctResponses.push(response);
    revealAnswer(sess, answerIndex);

    const isFirstCorrectResponse = gs.faceOff.correctResponses.length === 1;
    const shouldStartComparison = (
      isFirstCorrectResponse &&
      activeTeam === gs.faceOff.firstBuzzTeam &&
      gs.faceOff.participants[opponentTeam] &&
      !opponentHasAttempted
    );

    if (shouldStartComparison) {
      gs.faceOff.comparisonPending = true;
      startFaceOffTurn(sess, sessionId, opponentTeam, getFaceOffTurnSeconds(sess, opponentTeam));
      return true;
    }

    if (gs.faceOff.comparisonPending && gs.faceOff.correctResponses.length > 1) {
      const first = gs.faceOff.correctResponses[0];
      const winning = response.points > first.points ? response : first;
      return finalizeFaceOffDecision(sess, winning);
    }

    return finalizeFaceOffDecision(sess, response);
  }

  function startBoardPlay(sess, teamId) {
    const gs = sess.gameState;
    gs.roundOwnerTeam = teamId;
    gs.currentAnsweringTeam = teamId;
    gs.controlTeam = teamId;
    gs.decisionTeam = null;
    gs.faceOff.needsDecision = false;
    gs.gamePhase = 'BOARD_PLAY';
    setStartingPlayerForTeam(sess, teamId);
  }

  function setStrikeOverlay(sess, sessionId) {
    clearStrikeOverlayTimeout(sess);
    sess.gameState.showStrikeOverlay = true;
    emitState(sess, sessionId);
    scheduleStrikeOverlayClear(sess, sessionId);
  }

  // ─── Connection handler ───────────────────────────────────────────────────

  nsp.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, '[family-feud] connected');

    socket.on('joinSession', (sessionId) => {
      if (!sessionId || typeof sessionId !== 'string') return;
      socket.join(sessionId);
      socket.ffSessionId = sessionId;
      const sess = getOrCreateSession(sessionId);
      socket.emit('gameStateUpdate', sess.gameState);
    });

    function withSession(fn) {
      return (...args) => {
        const sessionId = socket.ffSessionId;
        if (!sessionId) return;
        const sess = ffSessions[sessionId];
        if (!sess) return;
        sess.lastActivity = Date.now();
        fn(sess, sessionId, ...args);
      };
    }

    socket.on('joinGame', withSession((sess, sessionId, { name, team }) => {
      if (!name?.trim() || (team !== 1 && team !== 2)) return;
      const gs = sess.gameState;
      const existing = gs.players.find(p => p.socketId === socket.id);
      const joinOrder = existing?.joinOrder ?? sess.playerJoinSequence++;
      gs.players = gs.players.filter(p => p.socketId !== socket.id);
      gs.players.push({ socketId: socket.id, name: name.trim(), team, joinOrder });
      if (gs.gamePhase === 'SETUP') prepareFaceOffParticipants(sess, { advance: false });
      emitState(sess, sessionId);
    }));

    socket.on('buzz', withSession((sess, sessionId) => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'FACE_OFF' || gs.faceOff.firstBuzzTeam) return;
      const player = gs.players.find(p => p.socketId === socket.id);
      if (!player) return;
      const participant = gs.faceOff.participants[player.team];
      if (!participant || participant.socketId !== socket.id) return;
      gs.faceOff.firstBuzzTeam = player.team;
      gs.buzzedPlayer = clonePlayer(player);
      gs.buzzedPlayersList = [clonePlayer(player)];
      startFaceOffTurn(sess, sessionId, player.team, FIRST_FACE_OFF_SECONDS);
    }));

    socket.on('hostSetupGame', withSession((sess, sessionId, { team1, team2, questions }) => {
      if (!Array.isArray(questions) || !questions.length) return;
      runHostAction(sess, sessionId, () => {
        clearFaceOffTimer(sess);
        const gs = sess.gameState;
        gs.teams[1].name = team1 || "الفريق الأول";
        gs.teams[2].name = team2 || "الفريق الثاني";
        gs.teams[1].score = 0;
        gs.teams[2].score = 0;
        gs.showBuzzerQr = false;
        gs.buzzerInviteUrl = '';
        gs.questions = questions;
        gs.questionOrder = createQuestionOrder(questions);
        gs.nextFaceOffIndexByTeam = { 1: 0, 2: 0 };
        gs.currentFaceOffIndexByTeam = { 1: null, 2: null };
        resetRoundState(sess, 0, { advanceParticipants: true });
      });
    }));

    socket.on('hostResetRound', withSession((sess, sessionId) => {
      runHostAction(sess, sessionId, () => {
        resetRoundState(sess, sess.gameState.currentQuestionIndex, { advanceParticipants: false });
      });
    }));

    socket.on('hostResetFaceOff', withSession((sess, sessionId) => {
      runHostAction(sess, sessionId, () => {
        clearFaceOffTimer(sess);
        const gs = sess.gameState;
        gs.buzzedPlayer = null;
        gs.buzzedPlayersList = [];
        prepareFaceOffParticipants(sess, { advance: false });
        gs.controlTeam = null;
        gs.decisionTeam = null;
        gs.gamePhase = 'FACE_OFF';
      });
    }));

    socket.on('hostResolveFaceOffAnswer', withSession((sess, sessionId, { answerIndex }) => {
      if (sess.gameState.gamePhase !== 'FACE_OFF' || !Number.isInteger(answerIndex)) return;
      runHostAction(sess, sessionId, () => resolveFaceOffCorrect(sess, sessionId, answerIndex));
    }));

    socket.on('hostPassFaceOffTurn', withSession((sess, sessionId) => {
      if (sess.gameState.gamePhase !== 'FACE_OFF' || !sess.gameState.faceOff.activeTeam) return;
      runHostAction(sess, sessionId, () => {
        clearFaceOffTimer(sess);
        handOffFaceOffTurn(sess, sessionId, 'pass');
      }, { emit: false });
    }));

    socket.on('hostChooseRoundControl', withSession((sess, sessionId, { decision }) => {
      if (sess.gameState.gamePhase !== 'DECISION' || !sess.gameState.faceOff.winnerTeam) return;
      runHostAction(sess, sessionId, () => {
        const playTeam = decision === 'PASS'
          ? sess.gameState.faceOff.loserTeam
          : sess.gameState.faceOff.winnerTeam;
        startBoardPlay(sess, playTeam);
      });
    }));

    socket.on('hostRevealAnswer', withSession((sess, sessionId, { index }) => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'BOARD_PLAY' || gs.roundResolved || !Number.isInteger(index)) return;
      runHostAction(sess, sessionId, () => {
        if (!revealAnswer(sess, index)) return false;
        if (allAnswersRevealed(sess)) {
          resolveRound(sess, gs.roundOwnerTeam, 'all-answers');
        } else {
          moveTurnToNextPlayer(sess, gs.roundOwnerTeam);
        }
        return true;
      });
    }));

    socket.on('hostUnrevealAnswer', withSession((sess, sessionId, { index }) => {
      if (sess.gameState.roundResolved || !Number.isInteger(index)) return;
      runHostAction(sess, sessionId, () => unrevealAnswer(sess, index));
    }));

    socket.on('hostAdvanceTurn', withSession((sess, sessionId) => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'BOARD_PLAY' || !gs.roundOwnerTeam) return;
      runHostAction(sess, sessionId, () => moveTurnToNextPlayer(sess, gs.roundOwnerTeam));
    }));

    socket.on('hostStrike', withSession((sess, sessionId) => {
      const gs = sess.gameState;
      if (gs.gamePhase === 'FACE_OFF' && gs.faceOff.activeTeam) {
        runHostAction(sess, sessionId, () => {
          clearFaceOffTimer(sess);
          setStrikeOverlay(sess, sessionId);
          handOffFaceOffTurn(sess, sessionId, 'strike');
        }, { emit: false });
        return;
      }
      if (gs.gamePhase !== 'BOARD_PLAY' || gs.roundResolved) return;
      runHostAction(sess, sessionId, () => {
        if (gs.strikes < MAX_STRIKES) gs.strikes += 1;
        if (gs.strikes >= MAX_STRIKES) {
          gs.gamePhase = 'STEAL';
          gs.stealTeam = getOtherTeam(gs.roundOwnerTeam);
          gs.currentAnsweringTeam = gs.stealTeam;
          gs.activePlayer = null;
        } else {
          moveTurnToNextPlayer(sess, gs.roundOwnerTeam);
        }
        setStrikeOverlay(sess, sessionId);
      }, { emit: false });
    }));

    socket.on('hostClearStrikes', withSession((sess, sessionId) => {
      runHostAction(sess, sessionId, () => {
        clearStrikeOverlayTimeout(sess);
        sess.gameState.strikes = 0;
        sess.gameState.showStrikeOverlay = false;
      });
    }));

    socket.on('hostResolveSteal', withSession((sess, sessionId, { index }) => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'STEAL' || gs.roundResolved || !Number.isInteger(index)) return;
      runHostAction(sess, sessionId, () => {
        if (!revealAnswer(sess, index)) return false;
        resolveRound(sess, gs.stealTeam, 'steal-success');
        return true;
      });
    }));

    socket.on('hostFailSteal', withSession((sess, sessionId) => {
      const gs = sess.gameState;
      if (gs.gamePhase !== 'STEAL' || gs.roundResolved) return;
      runHostAction(sess, sessionId, () => resolveRound(sess, gs.roundOwnerTeam, 'steal-failed'));
    }));

    socket.on('hostNextQuestion', withSession((sess, sessionId) => {
      if (sess.gameState.currentQuestionIndex >= getQuestionCount(sess.gameState.questions) - 1) return;
      runHostAction(sess, sessionId, () => {
        resetRoundState(sess, sess.gameState.currentQuestionIndex + 1, { advanceParticipants: true });
      });
    }));

    socket.on('hostPrevQuestion', withSession((sess, sessionId) => {
      if (sess.gameState.currentQuestionIndex <= 0) return;
      runHostAction(sess, sessionId, () => {
        resetRoundState(sess, sess.gameState.currentQuestionIndex - 1, { advanceParticipants: true });
      });
    }));

    socket.on('hostUndo', withSession((sess, sessionId) => {
      restoreHostSnapshot(sess, sessionId);
    }));

    socket.on('hostToggleBuzzerQr', withSession((sess, sessionId, { visible, url }) => {
      if (typeof visible !== 'boolean') return;
      runHostAction(sess, sessionId, () => {
        sess.gameState.showBuzzerQr = visible;
        if (typeof url === 'string' && url.trim()) sess.gameState.buzzerInviteUrl = url.trim();
      });
    }));

    socket.on('disconnect', () => {
      const sessionId = socket.ffSessionId;
      if (sessionId && ffSessions[sessionId]) {
        const sess = ffSessions[sessionId];
        const gs = sess.gameState;
        const removedPlayer = gs.players.find(p => p.socketId === socket.id);
        gs.players = gs.players.filter(p => p.socketId !== socket.id);
        gs.buzzedPlayersList = gs.buzzedPlayersList.filter(p => p.socketId !== socket.id);

        if (removedPlayer && ['FACE_OFF', 'DECISION'].includes(gs.gamePhase)) {
          const wasParticipant = [1, 2].some(t => gs.faceOff.participants[t]?.socketId === removedPlayer.socketId);
          if (wasParticipant) {
            clearFaceOffTimer(sess);
            gs.buzzedPlayer = null;
            gs.buzzedPlayersList = [];
            prepareFaceOffParticipants(sess, { advance: false });
          }
        }
        emitState(sess, sessionId);
      }
      logger.info({ socketId: socket.id }, '[family-feud] disconnected');
    });
  });
}
