// games/mn-ana.js
// Mn-Ana (من أنا؟) game logic — namespace /mn-ana

import { logger } from '../logger.js';

function removeArabicDots(text) {
  const dotMap = { 'ب': 'ٮ', 'ت': 'ٮ', 'ث': 'ٮ', 'ج': 'ح', 'خ': 'ح', 'ذ': 'د', 'ز': 'ر', 'ش': 'س', 'ض': 'ص', 'ظ': 'ط', 'غ': 'ع', 'ف': 'ڡ', 'ق': 'ٯ', 'ن': 'ں', 'ي': 'ى', 'ئ': 'ى', 'ؤ': 'و' };
  return text.split('').map(c => dotMap[c] || c).join('');
}

const mnaSessions = {};
const MNA_SESSION_TTL = 4 * 60 * 60 * 1000;

function mnaCreateSession() {
  return {
    status: 'setup',
    teams: [],
    round: 1,
    questionIndex: 0,
    questionsToAsk: { 1: [], 2: [], 3: [] },
    questionData: { readWithoutDots: [], whoAmI: [], whoSaidIt: [] },
    buzzerLocked: false,
    currentBuzzer: null,
    doubleCardActive: false,
    doubleCardTeamId: null,
    doubleCardContestant: null,
    hostSocketId: null,
    revealAnswer: false,
    revealOptions: false,
    customQuestion: null,
    buzzerTimeoutObj: null,
    initialTimer: 15,
    secondTimer: 15,
    _lastActivity: Date.now(),
  };
}

// #6: single helper replaces 7+ duplicated state-reset blocks
function mnaResetRoundState(session) {
  session.buzzerLocked  = false;
  session.currentBuzzer = null;
  if (session.buzzerTimeoutObj) {
    clearTimeout(session.buzzerTimeoutObj);
    session.buzzerTimeoutObj = null;
  }
  session.doubleCardActive    = false;
  session.doubleCardTeamId    = null;
  session.doubleCardContestant = null;
  session.revealAnswer  = false;
  session.revealOptions = false;
}

function mnaGetRandomIndices(max, count) {
  const indices = Array.from({ length: max }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, Math.min(count, max));
}

function mnaGetCurrentQuestion(session) {
  const { round, questionIndex, questionsToAsk } = session;
  const arr = round === 1 ? session.questionData.readWithoutDots
            : round === 2 ? session.questionData.whoAmI
            : session.questionData.whoSaidIt;
  if (!questionsToAsk[round] || questionIndex >= questionsToAsk[round].length) return null;
  const realIdx = questionsToAsk[round][questionIndex];
  return arr[realIdx] || null;
}

function mnaGetPublicQuestion(session) {
  if (session.customQuestion) return session.customQuestion;
  const q = mnaGetCurrentQuestion(session);
  if (!q) return null;
  const { round } = session;
  if (round === 1) return { type: 'read-without-dots', text: q.withoutDots, id: q.id };
  if (round === 2) return {
    type: 'who-am-i', id: q.id, revealAnswer: session.revealAnswer,
    answer: session.revealAnswer ? q.answer : null,
    image: session.revealAnswer ? (q.image || '') : null,
  };
  if (round === 3) return { type: 'who-said-it', quote: q.quote, id: q.id, options: (session.revealOptions || session.revealAnswer) ? (q.options || []) : null, answer: session.revealAnswer ? q.answer : null };
}

function mnaGetHostQuestion(session) {
  if (session.customQuestion && session.round === 1) {
    return {
      type: 'read-without-dots',
      original: session.customQuestion.original,
      withoutDots: session.customQuestion.text,
      answer: session.customQuestion.original,
      id: session.customQuestion.id,
    };
  }
  const q = mnaGetCurrentQuestion(session);
  if (!q) return null;
  const { round } = session;
  if (round === 1) return { type: 'read-without-dots', original: q.original, withoutDots: q.withoutDots, answer: q.answer, id: q.id };
  if (round === 2) return { type: 'who-am-i', clues: q.clues, info: q.info || '', answer: q.answer, image: q.image || '', id: q.id };
  if (round === 3) return { type: 'who-said-it', quote: q.quote, answer: q.answer, id: q.id, options: q.options || [] };
}

export function initMnAna(io) {
  const nsp = io.of('/mn-ana');

  // #8: setInterval lives inside initMnAna
  setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of Object.entries(mnaSessions)) {
      if (now - sess._lastActivity > MNA_SESSION_TTL) {
        if (sess.buzzerTimeoutObj) clearTimeout(sess.buzzerTimeoutObj);
        delete mnaSessions[id];
        logger.info({ sessionId: id }, '[mn-ana] session expired');
      }
    }
  }, 30 * 60 * 1000);

  function mnaBroadcastScores(sessionId, session) {
    const scores = session.teams.map(t => ({ id: t.id, name: t.name, score: t.score, doubleCard: t.doubleCard }));
    nsp.to(sessionId).emit('score-update', scores);
  }

  function mnaGetWinnerName(session) {
    if (session.status !== 'ended' || session.teams.length === 0) return null;
    const sorted = [...session.teams].sort((a, b) => b.score - a.score);
    if (sorted.length > 1 && sorted[0].score === sorted[1].score) return 'تعادل!';
    return sorted[0].name;
  }

  function mnaBroadcastGameState(sessionId, session) {
    nsp.to(sessionId).emit('game-state', {
      status: session.status,
      round: session.round,
      questionIndex: session.questionIndex,
      buzzerLocked: session.buzzerLocked,
      currentBuzzer: session.currentBuzzer,
      doubleCardActive: session.doubleCardActive,
      doubleCardTeamId: session.doubleCardTeamId,
      doubleCardContestant: session.doubleCardContestant,
      question: mnaGetPublicQuestion(session),
      winnerName: mnaGetWinnerName(session),
    });
  }

  function mnaEmitHostQuestion(sessionId, session) {
    if (session.hostSocketId) {
      nsp.to(session.hostSocketId).emit('host-question', mnaGetHostQuestion(session));
    }
  }

  nsp.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, '[mn-ana] connected');

    socket.on('join-session', ({ sessionId } = {}) => {
      if (!sessionId) return;
      if (!mnaSessions[sessionId]) mnaSessions[sessionId] = mnaCreateSession();
      const session = mnaSessions[sessionId];
      socket.join(sessionId);
      session._lastActivity = Date.now();
      socket.emit('game-state', {
        status: session.status,
        round: session.round,
        questionIndex: session.questionIndex,
        buzzerLocked: session.buzzerLocked,
        currentBuzzer: session.currentBuzzer,
        doubleCardActive: session.doubleCardActive,
        doubleCardTeamId: session.doubleCardTeamId,
        doubleCardContestant: session.doubleCardContestant,
        question: mnaGetPublicQuestion(session),
        winnerName: mnaGetWinnerName(session),
      });
      socket.emit('score-update', session.teams.map(t => ({ id: t.id, name: t.name, score: t.score, doubleCard: t.doubleCard })));
    });

    socket.on('join-host', ({ sessionId } = {}) => {
      if (!sessionId) return;
      if (!mnaSessions[sessionId]) mnaSessions[sessionId] = mnaCreateSession();
      const session = mnaSessions[sessionId];
      socket.join(sessionId);
      session.hostSocketId = socket.id;
      session._lastActivity = Date.now();
      // Send full game state so host can restore UI after refresh
      socket.emit('game-state', {
        status: session.status,
        round: session.round,
        questionIndex: session.questionIndex,
        buzzerLocked: session.buzzerLocked,
        currentBuzzer: session.currentBuzzer,
        doubleCardActive: session.doubleCardActive,
        doubleCardTeamId: session.doubleCardTeamId,
        doubleCardContestant: session.doubleCardContestant,
        question: mnaGetPublicQuestion(session),
        winnerName: mnaGetWinnerName(session),
      });
      socket.emit('host-question', mnaGetHostQuestion(session));
      const scores = session.teams.map(t => ({ id: t.id, name: t.name, score: t.score, doubleCard: t.doubleCard }));
      socket.emit('score-update', scores);
      logger.info({ sessionId }, '[mn-ana] host joined');
    });

    socket.on('setup-game', ({ sessionId, teams, initialTimer, secondTimer, questionData } = {}) => {
      if (!sessionId) return;
      socket.join(sessionId);
      const session = mnaCreateSession();
      mnaSessions[sessionId] = session;
      session.status = 'waiting_for_host';
      session.teams = (teams || []).map((teamName, i) => ({
        id: i + 1,
        name: teamName || (i === 0 ? 'الفريق الأول' : 'الفريق الثاني'),
        score: 0,
        doubleCard: true,
        socketId: null,
      }));
      session.initialTimer = initialTimer || 15;
      session.secondTimer = secondTimer || 15;
      const rawData = questionData || { readWithoutDots: [], whoAmI: [], whoSaidIt: [] };
      // Shuffle options for who-said-it questions so correct answer isn't always first
      session.questionData = {
        ...rawData,
        whoSaidIt: (rawData.whoSaidIt || []).map(q => {
          if (!q.options || q.options.length <= 1) return q;
          const shuffled = [...q.options];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          return { ...q, options: shuffled };
        }),
      };
      session.questionsToAsk = {
        1: mnaGetRandomIndices(session.questionData.readWithoutDots.length, 5),
        2: mnaGetRandomIndices(session.questionData.whoAmI.length, 5),
        3: mnaGetRandomIndices(session.questionData.whoSaidIt.length, 5),
      };
      logger.info({ sessionId, teams: session.teams.map(t => t.name) }, '[mn-ana] setup game');
      mnaBroadcastGameState(sessionId, session);
      mnaBroadcastScores(sessionId, session);
    });

    socket.on('host-start-game', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.status === 'waiting_for_host' || session.status === 'setup') {
        session.status = 'transition';
        mnaBroadcastGameState(sessionId, session);
        mnaEmitHostQuestion(sessionId, session);
        // #3: guard — bail if session was replaced or deleted during delay
        setTimeout(() => {
          if (mnaSessions[sessionId] !== session) return;
          session.status = 'playing';
          mnaBroadcastGameState(sessionId, session);
        }, 3500);
      }
    });

    socket.on('return-to-setup', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      mnaSessions[sessionId].status = 'setup';
      mnaSessions[sessionId]._lastActivity = Date.now();
      nsp.to(sessionId).emit('go-to-setup');
    });

    socket.on('join-buzzer', ({ sessionId, teamId, contestantName } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      socket.join(sessionId);
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      const team = session.teams.find(t => t.id === teamId);
      if (team) {
        team.socketId = socket.id;
        socket.emit('buzzer-status', {
          locked: session.buzzerLocked, score: team.score,
          doubleCard: team.doubleCard, teamName: team.name, teamId: team.id,
        });
        logger.info({ sessionId, team: team.name }, '[mn-ana] joined buzzer');
      }
    });

    socket.on('buzz-in', ({ sessionId, teamId, contestantName } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.buzzerLocked) return;
      const team = session.teams.find(t => t.id === teamId);
      if (!team) return;
      session.buzzerLocked = true;
      session.currentBuzzer = { teamId: team.id, teamName: team.name, contestantName: contestantName || '' };
      const duration = session.initialTimer || 15;
      nsp.to(sessionId).emit('buzzer-pressed', {
        teamId: team.id, teamName: team.name,
        contestantName: contestantName || '',
        doubleCardActive: session.doubleCardActive,
        doubleCardTeamId: session.doubleCardTeamId,
        buzzerEndTime: Date.now() + (duration * 1000),
      });
      logger.info({ sessionId, team: team.name }, '[mn-ana] buzzed in');
      if (session.buzzerTimeoutObj) clearTimeout(session.buzzerTimeoutObj);
      session.buzzerTimeoutObj = setTimeout(() => {
        const otherTeam = session.teams.find(t => t.id !== teamId);
        if (!otherTeam || session.currentBuzzer?.teamId !== teamId) return;
        session.currentBuzzer = { teamId: otherTeam.id, teamName: otherTeam.name, contestantName: '' };
        const duration2 = session.secondTimer || 15;
        nsp.to(sessionId).emit('buzzer-pressed', {
          teamId: otherTeam.id, teamName: otherTeam.name,
          contestantName: 'انتقل الدور',
          doubleCardActive: false, doubleCardTeamId: null,
          buzzerEndTime: Date.now() + (duration2 * 1000), isAutoPass: true,
        });
        logger.info({ sessionId, team: otherTeam.name }, '[mn-ana] buzzer passed');
        session.buzzerTimeoutObj = setTimeout(() => {
          if (session.currentBuzzer?.teamId === otherTeam.id) {
            session.buzzerLocked = false;
            session.currentBuzzer = null;
            nsp.to(sessionId).emit('buzzer-reset');
          }
        }, duration2 * 1000);
      }, duration * 1000);
    });

    socket.on('use-double-card', ({ sessionId, teamId, contestantName } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.doubleCardActive || session.buzzerLocked) return;
      const team = session.teams.find(t => t.id === teamId);
      if (!team || !team.doubleCard) return;
      team.doubleCard = false;
      session.doubleCardActive = true;
      session.doubleCardTeamId = teamId;
      session.doubleCardContestant = contestantName || 'مجهول';
      // Lock buzzer and start timer — shows countdown like a normal buzz-in
      session.buzzerLocked = true;
      session.currentBuzzer = { teamId: team.id, teamName: team.name, contestantName: contestantName || '' };
      const duration = session.initialTimer || 15;
      nsp.to(sessionId).emit('double-card-active', { teamId, teamName: team.name, contestantName });
      nsp.to(sessionId).emit('buzzer-pressed', {
        teamId: team.id,
        teamName: team.name,
        contestantName: contestantName || '',
        doubleCardActive: true,
        buzzerEndTime: Date.now() + (duration * 1000),
      });
      if (session.buzzerTimeoutObj) clearTimeout(session.buzzerTimeoutObj);
      session.buzzerTimeoutObj = setTimeout(() => {
        const otherTeam = session.teams.find(t => t.id !== teamId);
        if (!otherTeam || session.currentBuzzer?.teamId !== teamId) return;
        session.currentBuzzer = { teamId: otherTeam.id, teamName: otherTeam.name, contestantName: '' };
        const duration2 = session.secondTimer || 15;
        nsp.to(sessionId).emit('buzzer-pressed', {
          teamId: otherTeam.id, teamName: otherTeam.name,
          contestantName: 'انتقل الدور',
          doubleCardActive: false,
          buzzerEndTime: Date.now() + (duration2 * 1000), isAutoPass: true,
        });
        logger.info({ sessionId, team: otherTeam.name }, '[mn-ana] double card timer — buzzer passed');
        session.buzzerTimeoutObj = setTimeout(() => {
          if (session.currentBuzzer?.teamId === otherTeam.id) {
            session.buzzerLocked = false;
            session.currentBuzzer = null;
            // Double card expires with the question — cancel it cleanly
            session.doubleCardActive = false;
            session.doubleCardTeamId = null;
            session.doubleCardContestant = null;
            nsp.to(sessionId).emit('buzzer-reset');
          }
        }, duration2 * 1000);
      }, duration * 1000);
      mnaBroadcastScores(sessionId, session);
      logger.info({ sessionId, team: team.name }, '[mn-ana] double card used');
    });

    socket.on('reset-buzzer', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      mnaResetRoundState(session); // #6
      nsp.to(sessionId).emit('buzzer-reset');
      logger.info({ sessionId }, '[mn-ana] buzzer reset');
    });

    socket.on('adjust-score', ({ sessionId, teamId, delta } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      const team = session.teams.find(t => t.id === teamId);
      if (!team) return;
      if (delta > 0 && session.buzzerTimeoutObj) clearTimeout(session.buzzerTimeoutObj);
      let actualDelta = delta;
      if (session.doubleCardActive && delta > 0) actualDelta = delta * 2;
      team.score = Math.max(0, team.score + actualDelta);
      session.doubleCardActive = false;
      session.doubleCardTeamId = null;
      mnaBroadcastScores(sessionId, session);
    });

    socket.on('custom-text', ({ sessionId, text } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.round !== 1) return;
      session.customQuestion = {
        type: 'read-without-dots', text: removeArabicDots(text),
        original: text, id: 'custom-' + Date.now(),
      };
      mnaResetRoundState(session); // #6
      session.revealAnswer = false; // already set by helper but explicit for clarity
      mnaBroadcastGameState(sessionId, session);
      mnaEmitHostQuestion(sessionId, session);
    });

    socket.on('reveal-answer', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      const q = mnaGetCurrentQuestion(session);
      if (!q || (session.round !== 2 && session.round !== 3)) return;
      session.revealAnswer = true;
      mnaBroadcastGameState(sessionId, session);
      mnaEmitHostQuestion(sessionId, session);
    });

    socket.on('reveal-options', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.round !== 3) return;
      session.revealOptions = true;
      mnaBroadcastGameState(sessionId, session);
    });

    socket.on('next-question', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.status !== 'playing') return;
      session.customQuestion = null;
      const maxQ = (session.questionsToAsk[session.round]?.length || 1) - 1;
      if (session.questionIndex < maxQ) {
        session.questionIndex++;
        mnaResetRoundState(session); // #6
        mnaBroadcastGameState(sessionId, session);
        mnaBroadcastScores(sessionId, session);
        mnaEmitHostQuestion(sessionId, session);
      } else {
        if (session.round < 3) {
          session.round++;
          session.questionIndex = 0;
          mnaResetRoundState(session); // #6
          session.status = 'transition';
          mnaBroadcastGameState(sessionId, session);
          // #3: guard — bail if session was replaced or deleted during delay
          setTimeout(() => {
            if (mnaSessions[sessionId] !== session) return;
            session.status = 'playing';
            mnaBroadcastGameState(sessionId, session);
            mnaBroadcastScores(sessionId, session);
            mnaEmitHostQuestion(sessionId, session);
          }, 3500);
        } else {
          session.status = 'ended';
          mnaBroadcastGameState(sessionId, session);
        }
      }
    });

    socket.on('prev-question', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (session.status !== 'playing') return;
      session.customQuestion = null;
      session.questionIndex = Math.max(0, session.questionIndex - 1);
      mnaResetRoundState(session); // #6
      mnaBroadcastGameState(sessionId, session);
      mnaEmitHostQuestion(sessionId, session);
    });

    socket.on('set-round', ({ sessionId, round } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      if (round < 1 || round > 3) return;
      session.customQuestion = null;
      session.round = round;
      session.questionIndex = 0;
      mnaResetRoundState(session); // #6
      session.status = 'transition';
      mnaBroadcastGameState(sessionId, session);
      mnaEmitHostQuestion(sessionId, session);
      // #3: guard — bail if session was replaced or deleted during delay
      setTimeout(() => {
        if (mnaSessions[sessionId] !== session) return;
        session.status = 'playing';
        mnaBroadcastGameState(sessionId, session);
      }, 3500);
    });

    socket.on('restart-game', ({ sessionId } = {}) => {
      if (!sessionId || !mnaSessions[sessionId]) return;
      const session = mnaSessions[sessionId];
      session._lastActivity = Date.now();
      session.status = 'waiting_for_host';
      session.round = 1;
      session.questionIndex = 0;
      mnaResetRoundState(session);
      session.teams.forEach(t => { t.score = 0; t.doubleCard = true; });
      // Re-randomize questions and re-shuffle who-said-it options
      session.questionData.whoSaidIt = session.questionData.whoSaidIt.map(q => {
        if (!q.options || q.options.length <= 1) return q;
        const shuffled = [...q.options];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return { ...q, options: shuffled };
      });
      session.questionsToAsk = {
        1: mnaGetRandomIndices(session.questionData.readWithoutDots.length, 5),
        2: mnaGetRandomIndices(session.questionData.whoAmI.length, 5),
        3: mnaGetRandomIndices(session.questionData.whoSaidIt.length, 5),
      };
      nsp.to(sessionId).emit('game-restarted');
      mnaBroadcastGameState(sessionId, session);
      mnaBroadcastScores(sessionId, session);
    });

    socket.on('disconnect', () => {
      for (const sess of Object.values(mnaSessions)) {
        if (sess.hostSocketId === socket.id) sess.hostSocketId = null;
      }
      logger.info({ socketId: socket.id }, '[mn-ana] disconnected');
    });
  });
}
