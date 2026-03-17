// games/fawazir.js
// Fawazir (فوازير) game logic — namespace /fawazir

import { logger } from '../logger.js';

const FAWAZIR_QUESTIONS_PER_ROUND = 7;

const FAWAZIR_MYSTERY_POOL = [
  { id: 'card_swap',         name: 'تبادل النقاط',   description: 'تبادل النقاط مع الفريق المنافس',           image: 'cards/card_swap.avif' },
  { id: 'card_bonus',        name: 'نقاط مجانية',    description: 'احصل على ٥ نقاط مجانية',                   image: 'cards/card_bonus.avif' },
  { id: 'card_extra_points', name: 'نقطة مضافة',     description: 'أضف ١٠ نقاط مباشراً لرصيدك',              image: 'cards/card_extra_points.avif' },
  { id: 'card_explosion',    name: 'انفجار الرصيد',  description: 'خسارة ١٠ نقاط من رصيدك فوراً',            image: null },
  { id: 'card_tension',      name: 'توتر',            description: 'وقت إجابتك يتقلص إلى ٥ ثوانٍ فقط!',      image: null },
  { id: 'card_force_skip',   name: 'تخطي إجباري',    description: 'يروح عليك الدور وتنتقل الفرصة للمنافس',    image: null },
];

const fwSessions = {};
const FW_SESSION_TTL = 4 * 60 * 60 * 1000;

function getFwSession(sessionId) {
  if (!fwSessions[sessionId]) {
    fwSessions[sessionId] = {
      fw: makeFwState(),
      timerInterval: null,
      timerTimeout: null,  // #4: single timeout for accurate end detection
      timerEndAt: 0,       // #4: absolute end timestamp
      timerRemaining: 0,
      allQShuffled: [],
      lastActivity: Date.now(),
    };
  }
  fwSessions[sessionId].lastActivity = Date.now();
  return fwSessions[sessionId];
}

function makeFwState() {
  return {
    phase: 'setup',
    teams: [],
    currentQuestion: null,
    questionIndex: -1,
    answerRevealed: false,
    buzzer: {
      locked: false, winnerId: null, winnerName: null, winnerPlayerName: null,
      buzzedTeams: [], timerDuration: 7, timerRunning: false,
    },
    deck: [],
    buzzers: {},
    players: {},
    settings: { timerDuration: 7, secondTimerDuration: 15, roundsToWin: 3, gameHostName: '' },
    cardUsedThisRound: false,
    lastCardSnapshot: null,
    doublePoints: null,
    cardFrozenTeam: null,
    tensionPendingTeam: null,
    currentRound: 1,
    questionsInCurrentRound: 1,
    roundWins: {},
    deckPicksThisRound: {},
  };
}

function fwShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fwStartNewGame(teamNames, settings = {}, s, questions, allCards) {
  const timerDuration       = parseInt(settings.timerDuration)       || 7;
  const secondTimerDuration = parseInt(settings.secondTimerDuration) || 15;
  const roundsToWin         = parseInt(settings.roundsToWin)         || 3;
  const gameHostName        = (settings.gameHostName || '').trim();
  const cardDistribution    = settings.cardDistribution || 'random';

  const cardsPerTeam = 3;
  let teams;

  if (cardDistribution === 'pick' && settings.teamCardAssignments) {
    const assignments = settings.teamCardAssignments;
    teams = teamNames.map((name, i) => {
      const teamId    = `team_${i}`;
      const cardIds   = (assignments[teamId] || []).slice(0, cardsPerTeam);
      const teamCards = cardIds
        .map(cid => allCards.find(c => c.id === cid))
        .filter(Boolean)
        .map(c => ({ ...c }));
      return { id: teamId, name, score: 0, cards: teamCards };
    });
  } else {
    teams = teamNames.map((name, i) => ({
      id: `team_${i}`,
      name,
      score: 0,
      cards: fwShuffle(allCards).slice(0, cardsPerTeam).map(c => ({ ...c })),
    }));
  }

  s.allQShuffled = fwShuffle(questions);

  const roundWins          = {};
  const deckPicksThisRound = {};
  teams.forEach(t => {
    roundWins[t.id]          = 0;
    deckPicksThisRound[t.id] = false;
  });

  const prevBuzzers = s.fw.buzzers || {};
  const prevPlayers = s.fw.players || {};

  s.fw = {
    phase: 'playing',
    teams,
    currentQuestion: s.allQShuffled[0],
    questionIndex: 0,
    answerRevealed: false,
    buzzer: {
      locked: false, winnerId: null, winnerName: null, winnerPlayerName: null,
      buzzedTeams: [], timerDuration, timerRunning: false,
    },
    deck: FAWAZIR_MYSTERY_POOL,
    buzzers: prevBuzzers,
    players: prevPlayers,
    settings: { timerDuration, secondTimerDuration, roundsToWin, gameHostName, cardDistribution },
    cardUsedThisRound: false,
    lastCardSnapshot: null,
    doublePoints: null,
    cardFrozenTeam: null,
    tensionPendingTeam: null,
    currentRound: 1,
    questionsInCurrentRound: 1,
    roundWins,
    deckPicksThisRound,
  };

  s.timerRemaining = timerDuration;
  s.timerEndAt     = 0;
}

export function initFawazir(io) {
  const nsp = io.of('/fawazir');

  // #8: setInterval lives inside initFawazir
  setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of Object.entries(fwSessions)) {
      if (now - sess.lastActivity > FW_SESSION_TTL) {
        fwStopTimer(sess);
        delete fwSessions[id];
        logger.info({ sessionId: id }, '[fawazir] session expired');
      }
    }
  }, 30 * 60 * 1000);

  // #4: stop clears both interval (ticks) and timeout (end detection)
  function fwStopTimer(s) {
    if (s.timerInterval) { clearInterval(s.timerInterval); s.timerInterval = null; }
    if (s.timerTimeout)  { clearTimeout(s.timerTimeout);  s.timerTimeout  = null; }
    s.fw.buzzer.timerRunning = false;
  }

  // #4: re-arm end timeout from current timerEndAt (used after card_time / card_tension)
  function fwRearmTimeout(s, sessionId) {
    if (s.timerTimeout) clearTimeout(s.timerTimeout);
    const remaining = Math.max(0, s.timerEndAt - Date.now());
    s.timerTimeout = setTimeout(() => {
      s.timerTimeout = null;
      fwStopTimer(s);
      fwHandleTimerEnd(s, sessionId);
    }, remaining);
  }

  // #4: uses setTimeout for accurate end + setInterval only for tick emissions
  function fwStartTimer(duration, s, sessionId) {
    fwStopTimer(s);
    s.timerEndAt     = Date.now() + duration * 1000;
    s.timerRemaining = duration;
    s.fw.buzzer.timerRunning = true;

    // Single timeout — fires exactly when timer ends
    s.timerTimeout = setTimeout(() => {
      s.timerTimeout = null;
      fwStopTimer(s);
      fwHandleTimerEnd(s, sessionId);
    }, duration * 1000);

    // Interval — derives remaining from timerEndAt (no drift)
    s.timerInterval = setInterval(() => {
      s.timerRemaining = Math.max(0, Math.ceil((s.timerEndAt - Date.now()) / 1000));
      nsp.to(sessionId).emit('timer-tick', { remaining: s.timerRemaining });
    }, 1000);
  }

  function fwHandleTimerEnd(s, sessionId) {
    const { fw } = s;
    if (fw.phase !== 'playing') return;

    const currentWinnerId = fw.buzzer.winnerId;
    if (currentWinnerId && !fw.buzzer.buzzedTeams.includes(currentWinnerId)) {
      fw.buzzer.buzzedTeams.push(currentWinnerId);
    }

    const nextTeam = fw.teams.find(t => !fw.buzzer.buzzedTeams.includes(t.id));

    if (nextTeam) {
      fw.buzzer.locked           = true;
      fw.buzzer.winnerId         = nextTeam.id;
      fw.buzzer.winnerName       = nextTeam.name;
      fw.buzzer.winnerPlayerName = null;

      nsp.to(sessionId).emit('buzz-transferred', { teamId: nextTeam.id, teamName: nextTeam.name });
      fwStartTimer(fw.settings.secondTimerDuration, s, sessionId);
      fwEmitStateToAll(s, sessionId);
    } else {
      fw.buzzer.locked           = false;
      fw.buzzer.winnerId         = null;
      fw.buzzer.winnerName       = null;
      fw.buzzer.winnerPlayerName = null;
      nsp.to(sessionId).emit('timer-ended');
      fwEmitStateToAll(s, sessionId);
    }
  }

  function fwApplyCardEffect(teamId, card, s, sessionId) {
    const { fw } = s;
    const team      = fw.teams.find(t => t.id === teamId);
    const otherTeam = fw.teams.find(t => t.id !== teamId);
    if (!team) return;

    switch (card.id) {
      case 'card_hint':
        nsp.to(sessionId).emit('hint-revealed', {
          hint: fw.currentQuestion?.hint || '---',
          teamId, teamName: team.name,
        });
        break;

      case 'card_time':
        // #4: extend timerEndAt, re-arm the end timeout
        if (fw.buzzer.timerRunning) {
          s.timerEndAt     = Math.min(s.timerEndAt + 10_000, Date.now() + 120_000);
          s.timerRemaining = Math.ceil((s.timerEndAt - Date.now()) / 1000);
          fwRearmTimeout(s, sessionId);
          nsp.to(sessionId).emit('timer-tick', { remaining: s.timerRemaining });
        }
        break;

      case 'card_double':
        fw.doublePoints = teamId;
        break;

      case 'card_steal':
        if (fw.buzzer.locked && fw.buzzer.winnerId !== teamId) {
          if (!fw.buzzer.buzzedTeams.includes(fw.buzzer.winnerId)) {
            fw.buzzer.buzzedTeams.push(fw.buzzer.winnerId);
          }
          fw.buzzer.winnerId         = teamId;
          fw.buzzer.winnerName       = team.name;
          fw.buzzer.winnerPlayerName = null;
          nsp.to(sessionId).emit('buzz-transferred', { teamId, teamName: team.name });
          fwStartTimer(fw.settings.secondTimerDuration, s, sessionId);
        }
        break;

      case 'card_freeze':
        if (otherTeam) {
          fw.cardFrozenTeam = otherTeam.id;
          nsp.to(sessionId).emit('freeze-activated', {
            frozenTeamId: otherTeam.id, frozenTeamName: otherTeam.name, byTeamName: team.name,
          });
        }
        break;
    }

    fwEmitStateToAll(s, sessionId);
  }

  function fwApplyMysteryEffect(teamId, card, s, sessionId) {
    const { fw } = s;
    const team  = fw.teams.find(t => t.id === teamId);
    const other = fw.teams.find(t => t.id !== teamId);
    if (!team) return;

    switch (card.id) {
      case 'card_swap':
        if (other) {
          [team.score, other.score] = [other.score, team.score];
          nsp.to(sessionId).emit('score-updated', { teamId: team.id, score: team.score });
          nsp.to(sessionId).emit('score-updated', { teamId: other.id, score: other.score });
        }
        break;

      case 'card_bonus':
        team.score += 5;
        nsp.to(sessionId).emit('score-updated', { teamId, score: team.score });
        break;

      case 'card_extra_points':
        team.score += 10;
        nsp.to(sessionId).emit('score-updated', { teamId, score: team.score });
        break;

      case 'card_explosion':
        team.score = Math.max(0, team.score - 10);
        nsp.to(sessionId).emit('score-updated', { teamId, score: team.score });
        break;

      case 'card_tension':
        if (!other) break;
        // #4: shrink timerEndAt to 5s from now, re-arm timeout
        if (fw.buzzer.timerRunning && fw.buzzer.winnerId === other.id && s.timerEndAt - Date.now() > 5000) {
          s.timerEndAt     = Date.now() + 5000;
          s.timerRemaining = 5;
          fwRearmTimeout(s, sessionId);
          nsp.to(sessionId).emit('timer-tick', { remaining: 5 });
        } else {
          fw.tensionPendingTeam = other.id;
        }
        break;

      case 'card_force_skip':
        if (fw.buzzer.locked && fw.buzzer.winnerId === teamId && other) {
          if (!fw.buzzer.buzzedTeams.includes(teamId)) {
            fw.buzzer.buzzedTeams.push(teamId);
          }
          fw.buzzer.winnerId         = other.id;
          fw.buzzer.winnerName       = other.name;
          fw.buzzer.winnerPlayerName = null;
          nsp.to(sessionId).emit('buzz-transferred', { teamId: other.id, teamName: other.name });
          fwStartTimer(fw.settings.secondTimerDuration, s, sessionId);
        } else {
          fwStopTimer(s);
          fwAdvanceToNextQuestion(s, sessionId);
        }
        break;
    }

    fwEmitStateToAll(s, sessionId);
  }

  function fwResetBuzzerState(s) {
    const { fw } = s;
    fw.buzzer = {
      locked: false, winnerId: null, winnerName: null, winnerPlayerName: null,
      buzzedTeams: [], timerDuration: fw.settings.timerDuration, timerRunning: false,
    };
    s.timerRemaining = fw.settings.timerDuration;
    s.timerEndAt     = 0; // #4
  }

  function fwResetRoundEffects(s) {
    const { fw } = s;
    fw.answerRevealed    = false;
    fw.cardUsedThisRound = false;
    fw.doublePoints      = null;
    fw.cardFrozenTeam    = null;
    fwResetBuzzerState(s);
  }

  function fwHandleRoundEnd(s, sessionId) {
    const { fw } = s;
    const teams = fw.teams;

    let roundWinnerId   = null;
    let roundWinnerName = null;
    if (teams[0].score !== teams[1].score) {
      const winner    = teams[0].score > teams[1].score ? teams[0] : teams[1];
      roundWinnerId   = winner.id;
      roundWinnerName = winner.name;
      fw.roundWins[winner.id] = (fw.roundWins[winner.id] || 0) + 1;
    }

    const roundWinsSnapshot = { ...fw.roundWins };

    nsp.to(sessionId).emit('round-ended', {
      roundNumber: fw.currentRound,
      winnerId:    roundWinnerId,
      winnerName:  roundWinnerName,
      roundWins:   roundWinsSnapshot,
      teams: teams.map(t => ({
        id: t.id, name: t.name, score: t.score,
        roundWins: roundWinsSnapshot[t.id] || 0,
      })),
    });

    const { roundsToWin } = fw.settings;
    const champTeam = teams.find(t => (fw.roundWins[t.id] || 0) >= roundsToWin);

    if (champTeam) {
      fw.phase = 'finished';
      nsp.to(sessionId).emit('champion', { teamId: champTeam.id, teamName: champTeam.name, roundWins: roundWinsSnapshot });
      nsp.to(sessionId).emit('game-finished', { teams: fw.teams, champion: champTeam });
      fwEmitStateToAll(s, sessionId);
      return;
    }

    // #3: guard against stale session — check fwSessions[sessionId] === s
    setTimeout(() => {
      if (fwSessions[sessionId] !== s) return;
      fwStartNewRound(s, sessionId);
    }, 4500);
  }

  function fwStartNewRound(s, sessionId) {
    const { fw } = s;
    const nextRound  = fw.currentRound + 1;
    const nextQIndex = fw.questionIndex + 1;

    if (nextQIndex >= s.allQShuffled.length) {
      fw.phase = 'finished';
      nsp.to(sessionId).emit('game-finished', { teams: fw.teams });
      fwEmitStateToAll(s, sessionId);
      return;
    }

    fw.teams.forEach(t => { t.score = 0; });

    const freshDeckPicks = {};
    fw.teams.forEach(t => { freshDeckPicks[t.id] = false; });

    fw.currentRound            = nextRound;
    fw.questionsInCurrentRound = 1;
    fw.questionIndex           = nextQIndex;
    fw.currentQuestion         = s.allQShuffled[nextQIndex];
    fw.deckPicksThisRound      = freshDeckPicks;
    fwResetRoundEffects(s);

    nsp.to(sessionId).emit('round-started', {
      roundNumber: nextRound,
      roundsToWin: fw.settings.roundsToWin,
      roundWins:   fw.roundWins,
    });
    fwEmitStateToAll(s, sessionId);
  }

  function fwAdvanceToNextQuestion(s, sessionId) {
    const { fw } = s;
    if (fw.phase !== 'playing') return;

    const nextQInRound = fw.questionsInCurrentRound + 1;

    if (nextQInRound > FAWAZIR_QUESTIONS_PER_ROUND) {
      fwHandleRoundEnd(s, sessionId);
      return;
    }

    const nextIndex = fw.questionIndex + 1;
    if (nextIndex >= s.allQShuffled.length) {
      fw.phase = 'finished';
      nsp.to(sessionId).emit('game-finished', { teams: fw.teams });
      fwEmitStateToAll(s, sessionId);
      return;
    }

    fw.questionIndex            = nextIndex;
    fw.questionsInCurrentRound  = nextQInRound;
    fw.currentQuestion          = s.allQShuffled[nextIndex];
    fwResetRoundEffects(s);

    nsp.to(sessionId).emit('question-changed');
    fwEmitStateToAll(s, sessionId);
  }

  function fwGetPublicState(s) {
    const { fw } = s;
    return {
      phase: fw.phase,
      teams: fw.teams,
      currentQuestion: fw.currentQuestion
        ? {
            id:       fw.currentQuestion.id,
            question: fw.currentQuestion.question,
            points:   fw.currentQuestion.points,
            answer:   fw.answerRevealed ? fw.currentQuestion.answer : null,
          }
        : null,
      questionIndex:           fw.questionIndex,
      questionsInCurrentRound: fw.questionsInCurrentRound,
      questionsPerRound:       FAWAZIR_QUESTIONS_PER_ROUND,
      totalQuestions:          s.allQShuffled.length,
      answerRevealed:          fw.answerRevealed,
      buzzer:                  fw.buzzer,
      deck:                    fw.deck,
      timerRemaining:          s.timerRemaining,
      settings:                fw.settings,
      cardUsedThisRound:       fw.cardUsedThisRound,
      hasCardSnapshot:         fw.lastCardSnapshot !== null,
      doublePoints:            fw.doublePoints,
      cardFrozenTeam:          fw.cardFrozenTeam,
      tensionPendingTeam:      fw.tensionPendingTeam ?? null,
      currentRound:            fw.currentRound,
      roundWins:               fw.roundWins,
      roundsToWin:             fw.settings.roundsToWin,
      deckPicksThisRound:      fw.deckPicksThisRound,
    };
  }

  function fwGetHostState(s) {
    const { fw } = s;
    return {
      ...fwGetPublicState(s),
      currentQuestion: fw.currentQuestion ? { ...fw.currentQuestion } : null,
    };
  }

  function fwEmitStateToAll(s, sessionId) {
    nsp.to(sessionId).emit('game-state-update', fwGetPublicState(s));
    nsp.to(`${sessionId}-host`).emit('game-state-update', fwGetHostState(s));
  }

  nsp.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, '[fawazir] connected');

    socket.on('request-state', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      socket.fwSessionId = sessionId;
      socket.join(sessionId);
      const s = getFwSession(sessionId);
      const role = data?.role || 'public';
      socket.emit('game-state-update', role === 'host' ? fwGetHostState(s) : fwGetPublicState(s));
    });

    socket.on('start-game', (data) => {
      const sessionId = data?.sessionId;
      if (!sessionId) return;
      socket.fwSessionId = sessionId;
      socket.join(sessionId);
      const s = getFwSession(sessionId);
      const teamNames = (data.teamNames || []).filter(n => n && n.trim() !== '');
      if (teamNames.length < 2) return;
      fwStartNewGame(teamNames, data.settings || {}, s, data.questions || [], data.allCards || []);
      nsp.to(sessionId).emit('game-started');
      nsp.to(sessionId).emit('round-started', {
        roundNumber: 1,
        roundsToWin: s.fw.settings.roundsToWin,
        roundWins:   s.fw.roundWins,
      });
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('join-host', (data) => {
      const sessionId = data?.sessionId;
      if (!sessionId) return;
      const s = getFwSession(sessionId);
      socket.fwSessionId = sessionId;
      socket.join(sessionId);
      socket.join(`${sessionId}-host`);
      socket.emit('game-state-update', fwGetHostState(s));
    });

    socket.on('join-buzzer', (data) => {
      const { sessionId, teamId, playerName } = data || {};
      if (!sessionId) return;
      const s = getFwSession(sessionId);
      socket.fwSessionId = sessionId;
      s.fw.buzzers[socket.id] = teamId;
      s.fw.players[socket.id] = { name: playerName || '', teamId };
      socket.join(sessionId);
      socket.emit('buzzer-registered', { teamId });
      socket.emit('game-state-update', fwGetPublicState(s));
    });

    socket.on('join-display', (data) => {
      const sessionId = data?.sessionId;
      if (!sessionId) return;
      const s = getFwSession(sessionId);
      socket.fwSessionId = sessionId;
      socket.join(sessionId);
      socket.emit('game-state-update', fwGetPublicState(s));
    });

    socket.on('buzz-in', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.phase !== 'playing') return;
      if (fw.buzzer.locked) return;

      const teamId = fw.buzzers[socket.id];
      if (!teamId) return;

      const team = fw.teams.find(t => t.id === teamId);
      if (!team) return;
      const playerName = fw.players[socket.id]?.name || '';

      fw.buzzer.locked           = true;
      fw.buzzer.winnerId         = teamId;
      fw.buzzer.winnerName       = team.name;
      fw.buzzer.winnerPlayerName = playerName;

      if (!fw.buzzer.buzzedTeams.includes(teamId)) {
        fw.buzzer.buzzedTeams.push(teamId);
      }

      const actualDuration = (fw.tensionPendingTeam === teamId) ? 5 : fw.buzzer.timerDuration;
      if (fw.tensionPendingTeam === teamId) fw.tensionPendingTeam = null;

      nsp.to(sessionId).emit('buzz-winner', { teamId, teamName: team.name, playerName, timerDuration: actualDuration });
      fwStartTimer(actualDuration, s, sessionId);
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('correct-answer', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.phase !== 'playing') return;
      const { teamId } = data;
      const team = fw.teams.find(t => t.id === teamId);
      if (!team) return;

      const basePoints = fw.currentQuestion?.points ?? 0;
      const multiplier = fw.doublePoints === teamId ? 2 : 1;
      const earned     = basePoints * multiplier;
      team.score      += earned;

      if (fw.doublePoints === teamId) fw.doublePoints = null;

      fwStopTimer(s);
      fw.buzzer.locked  = false;
      fw.answerRevealed = true;

      nsp.to(sessionId).emit('score-updated', { teamId, score: team.score });
      nsp.to(sessionId).emit('answer-revealed', { answer: fw.currentQuestion?.answer });
      nsp.to(sessionId).emit('correct-answer-awarded', {
        teamId, teamName: team.name, points: earned, doubled: multiplier === 2,
      });
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('wrong-answer', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.phase !== 'playing') return;
      if (!fw.buzzer.locked) return;
      fwStopTimer(s);
      fwHandleTimerEnd(s, sessionId);
    });

    socket.on('reveal-answer', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.phase !== 'playing') return;
      fw.answerRevealed = true;
      fwStopTimer(s);
      nsp.to(sessionId).emit('answer-revealed', { answer: fw.currentQuestion?.answer });
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('next-question', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      if (s.fw.phase !== 'playing') return;
      fwStopTimer(s);
      fwAdvanceToNextQuestion(s, sessionId);
    });

    socket.on('adjust-score', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { teamId, delta } = data;
      const team = s.fw.teams.find(t => t.id === teamId);
      if (!team) return;
      team.score = Math.max(0, team.score + delta);
      nsp.to(sessionId).emit('score-updated', { teamId, score: team.score });
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('reset-buzzer', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      fwStopTimer(s);
      fwResetBuzzerState(s);
      nsp.to(sessionId).emit('buzzer-reset');
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('use-card', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.cardUsedThisRound) return;

      const { teamId, cardId } = data;

      const NEEDS_BUZZER_IDS = ['card_time', 'card_double', 'card_steal'];
      if (NEEDS_BUZZER_IDS.includes(cardId) && !fw.buzzer.locked) return;
      if (fw.cardFrozenTeam === teamId) return;

      const team = fw.teams.find(t => t.id === teamId);
      if (!team) return;

      const cardIndex = team.cards.findIndex(c => c.id === cardId && !c.used);
      if (cardIndex === -1) return;

      const usedCard = { ...team.cards[cardIndex] };

      fw.lastCardSnapshot = {
        teamId, cardId,
        card:           usedCard,
        teamScore:      team.score,
        otherTeamScore: fw.teams.find(t => t.id !== teamId)?.score,
        doublePoints:   fw.doublePoints,
        cardFrozenTeam: fw.cardFrozenTeam,
        timerRemaining: s.timerRemaining,
      };

      team.cards[cardIndex].used = true;
      fw.cardUsedThisRound = true;

      const playerName = fw.players[socket.id]?.name || '';

      nsp.to(sessionId).emit('card-used', {
        teamId, cardId,
        cardName:   usedCard.name,
        cardImage:  usedCard.image || null,
        playerName,
        teamName:   team.name,
      });

      fwApplyCardEffect(teamId, usedCard, s, sessionId);
    });

    socket.on('undo-card', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      const snap = fw.lastCardSnapshot;
      if (!snap) return;

      const team = fw.teams.find(t => t.id === snap.teamId);
      if (team) {
        const card = team.cards.find(c => c.id === snap.cardId);
        if (card) card.used = false;
        team.score = snap.teamScore;
      }
      const other = fw.teams.find(t => t.id !== snap.teamId);
      if (other && snap.otherTeamScore !== undefined) other.score = snap.otherTeamScore;

      fw.doublePoints      = snap.doublePoints;
      fw.cardFrozenTeam    = snap.cardFrozenTeam;
      fw.cardUsedThisRound = false;
      fw.lastCardSnapshot  = null;

      nsp.to(sessionId).emit('card-undo', { teamId: snap.teamId, cardId: snap.cardId });
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('pick-deck-card', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      const { fw } = s;
      if (fw.phase !== 'playing') return;
      const { teamId } = data;
      if (!fw.deckPicksThisRound) return;
      if (fw.deckPicksThisRound[teamId]) return;

      const team = fw.teams.find(t => t.id === teamId);
      if (!team) return;

      const randomIndex = Math.floor(Math.random() * FAWAZIR_MYSTERY_POOL.length);
      const pickedCard  = FAWAZIR_MYSTERY_POOL[randomIndex];
      fw.deckPicksThisRound[teamId] = true;

      nsp.to(sessionId).emit('deck-card-picked', {
        teamId, teamName: team.name,
        cardId: pickedCard.id, cardName: pickedCard.name,
      });

      nsp.to(sessionId).emit('card-used', {
        teamId, cardId: pickedCard.id,
        cardName:   pickedCard.name,
        cardImage:  pickedCard.image || null,
        playerName: '',
        teamName:   team.name,
      });

      fwApplyMysteryEffect(teamId, pickedCard, s, sessionId);
    });

    socket.on('restart-game', (data) => {
      const sessionId = data?.sessionId || socket.fwSessionId;
      if (!sessionId) return;
      const s = fwSessions[sessionId];
      if (!s) return;
      fwStopTimer(s);
      s.allQShuffled   = [];
      s.timerRemaining = 0;
      s.timerEndAt     = 0;
      s.fw = makeFwState();
      fwEmitStateToAll(s, sessionId);
    });

    socket.on('disconnect', () => {
      const sessionId = socket.fwSessionId;
      if (sessionId && fwSessions[sessionId]) {
        const { fw } = fwSessions[sessionId];
        delete fw.buzzers[socket.id];
        delete fw.players[socket.id];
      }
      logger.info({ socketId: socket.id }, '[fawazir] disconnected');
    });
  });
}
