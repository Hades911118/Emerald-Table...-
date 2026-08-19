// Emerald Table Blackjack — Multiplayer Server
// Plain WebSocket server (no framework). Run with: node server.js
// Protocol: JSON messages over ws. See README for message shapes.

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_SEATS = 5;
const LOBBY_WAIT_MS = 20000; // 20s countdown before empty seats fill with bots
const TURN_TIMEOUT_MS = 20000; // auto-stand a human who doesn't act in time
const BETTING_TIMEOUT_MS = 15000;
const STARTING_BANKROLL = 500;
const MIN_BET = 25;
const BOT_BANKROLL = 100000; // bots never run out

const SUITS = [
  { sym: '♠', color: 'black' }, { sym: '♥', color: 'red' },
  { sym: '♦', color: 'red' }, { sym: '♣', color: 'black' },
];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function freshShoe(decks = 6) {
  const deck = [];
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s.sym, color: s.color });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function cardValue(rank) {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}
function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) { total += cardValue(c.rank); if (c.rank === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function isSoft17(hand) {
  let total = 0, aces = 0;
  for (const c of hand) { total += cardValue(c.rank); if (c.rank === 'A') aces++; }
  let usable = aces;
  while (total > 21 && usable > 0) { total -= 10; usable--; }
  return total === 17 && usable > 0;
}
function isBlackjack(hand) { return hand.length === 2 && handValue(hand) === 21; }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (lobbies.has(code));
  return code;
}

/** @type {Map<string, Lobby>} */
const lobbies = new Map();

function makePlayer({ id, name, ws, isBot }) {
  return {
    id, name, ws, isBot,
    bankroll: STARTING_BANKROLL,
    bet: 0, hand: [], status: 'seated', // seated|betting|playing|stood|bust|blackjack|surrendered|eliminated|left
    connected: !isBot,
  };
}

class Lobby {
  constructor(code, host) {
    this.code = code;
    this.host = host.id;
    this.players = [host]; // seat order
    this.phase = 'waiting'; // waiting | countdown | betting | playing | round_over | game_over
    this.shoe = freshShoe();
    this.dealerHand = [];
    this.turnIndex = -1;
    this.roundMsg = '';
    this.timer = null;
    this.deadline = null;
  }

  broadcast() {
    for (const p of this.players) {
      if (!p.isBot && p.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({ type: 'state', state: this.publicState(p.id) }));
      }
    }
  }

  publicState(viewerId) {
    const dealerHidden = this.phase === 'playing';
    const revealAllHands = this.phase === 'dealer' || this.phase === 'round_over' || this.phase === 'game_over';
    return {
      code: this.code,
      phase: this.phase,
      host: this.host,
      deadline: this.deadline,
      turnPlayerId: this.turnIndex >= 0 ? (this.players[this.turnIndex] || {}).id : null,
      roundMsg: this.roundMsg,
      dealer: {
        hand: dealerHidden ? [this.dealerHand[0]] : this.dealerHand,
        value: dealerHidden ? cardValue((this.dealerHand[0] || {}).rank || '2') : handValue(this.dealerHand),
        hidden: dealerHidden,
      },
      players: this.players.map(p => {
        const reveal = revealAllHands || p.id === viewerId;
        return {
          id: p.id, name: p.name, isBot: p.isBot, bankroll: p.bankroll,
          bet: p.bet, status: p.status, connected: p.connected,
          hand: reveal ? p.hand : p.hand.map(() => ({ hidden: true })),
          value: reveal ? (p.hand.length ? handValue(p.hand) : 0) : null,
        };
      }),
    };
  }

  send(playerId, msg) {
    const p = this.players.find(p => p.id === playerId);
    if (p && !p.isBot && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  activePlayers() { return this.players.filter(p => p.status !== 'eliminated' && p.status !== 'left'); }

  clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.deadline = null; }

  // ---- lifecycle ----

  addPlayer(player) {
    if (this.players.length >= MAX_SEATS) return false;
    if (this.phase !== 'waiting' && this.phase !== 'countdown') return false;
    this.players.push(player);
    if (this.phase === 'waiting') this.startCountdown();
    this.broadcast();
    return true;
  }

  removePlayer(id) {
    const p = this.players.find(p => p.id === id);
    if (!p) return;
    if (this.phase === 'waiting' || this.phase === 'countdown') {
      this.players = this.players.filter(p => p.id !== id);
      if (this.players.length === 0) { this.destroy(); return; }
      if (this.host === id) this.host = this.players[0].id;
    } else {
      p.connected = false;
      p.status = 'left';
    }
    this.broadcast();
  }

  destroy() {
    this.clearTimer();
    lobbies.delete(this.code);
  }

  forceStart(playerId) {
    if (playerId !== this.host) return;
    if (this.phase !== 'waiting' && this.phase !== 'countdown') return;
    this.clearTimer();
    this.fillAndStart();
  }

  startCountdown() {
    if (this.phase !== 'waiting') return;
    this.phase = 'countdown';
    this.deadline = Date.now() + LOBBY_WAIT_MS;
    this.clearTimer();
    this.timer = setTimeout(() => this.fillAndStart(), LOBBY_WAIT_MS);
    if (this.players.length >= MAX_SEATS) {
      this.clearTimer();
      this.fillAndStart();
    } else {
      this.broadcast();
    }
  }

  fillAndStart() {
    if (this.players.length === 1) {
      let botNum = 1;
      while (this.players.length < MAX_SEATS) {
        this.players.push(makePlayer({ id: 'bot-' + (botNum++) + '-' + this.code, name: 'Bot ' + botNum, isBot: true }));
      }
    }
    this.startBettingRound();
  }

  startBettingRound() {
    this.clearTimer();
    this.dealerHand = [];
    for (const p of this.activePlayers()) {
      p.hand = []; p.bet = 0;
      p.status = p.bankroll >= MIN_BET ? 'betting' : 'eliminated';
    }
    const stillIn = this.activePlayers().filter(p => p.status === 'betting');
    if (stillIn.filter(p => !p.isBot).length === 0) { this.endGame(); return; }
    this.phase = 'betting';
    this.roundMsg = '';
    for (const p of stillIn) if (p.isBot) p.bet = [25, 50, 100][Math.floor(Math.random() * 3)];
    this.deadline = Date.now() + BETTING_TIMEOUT_MS;
    this.timer = setTimeout(() => this.dealRound(), BETTING_TIMEOUT_MS);
    this.broadcast();
    this.maybeDealEarly();
  }

  maybeDealEarly() {
    const humans = this.activePlayers().filter(p => !p.isBot && p.status === 'betting');
    if (humans.length && humans.every(p => p.bet > 0)) { this.clearTimer(); this.dealRound(); }
  }

  placeBet(playerId, amount) {
    if (this.phase !== 'betting') return;
    const p = this.players.find(p => p.id === playerId);
    if (!p || p.status !== 'betting') return;
    amount = Math.max(MIN_BET, Math.min(amount, p.bankroll));
    p.bet = amount;
    this.broadcast();
    this.maybeDealEarly();
  }

  draw() {
    if (this.shoe.length < 15) this.shoe = freshShoe();
    return this.shoe.pop();
  }

  dealRound() {
    this.clearTimer();
    const inHand = this.activePlayers().filter(p => p.status === 'betting');
    for (const p of inHand) if (p.bet <= 0) p.bet = MIN_BET;
    for (const p of inHand) { p.bankroll -= p.bet; p.hand = [this.draw(), this.draw()]; p.status = 'playing'; }
    this.dealerHand = [this.draw(), this.draw()];
    this.phase = 'playing';

    for (const p of inHand) if (isBlackjack(p.hand)) p.status = 'blackjack';

    this.turnIndex = -1;
    this.broadcast();
    this.advanceTurn();
  }

  seatOrder() { return this.players.filter(p => p.status === 'playing' || p.status === 'blackjack'); }

  advanceTurn() {
    this.clearTimer();
    const order = this.players; // fixed seat order
    let i = this.turnIndex + 1;
    while (i < order.length && order[i].status !== 'playing') i++;
    if (i >= order.length) { this.turnIndex = -1; this.dealerPlay(); return; }
    this.turnIndex = i;
    const p = order[i];
    this.broadcast();
    if (p.isBot) {
      setTimeout(() => this.botAct(p), 700 + Math.random() * 500);
    } else {
      this.deadline = Date.now() + TURN_TIMEOUT_MS;
      this.timer = setTimeout(() => this.playerAction(p.id, 'stand'), TURN_TIMEOUT_MS);
    }
  }

  botAct(p) {
    if (this.players[this.turnIndex] !== p || p.status !== 'playing') return;
    const v = handValue(p.hand);
    if (v < 17) this.playerAction(p.id, 'hit');
    else this.playerAction(p.id, 'stand');
  }

  playerAction(playerId, action) {
    const idx = this.turnIndex;
    const p = this.players[idx];
    if (!p || p.id !== playerId || p.status !== 'playing') return;
    this.clearTimer();

    if (action === 'hit') {
      p.hand.push(this.draw());
      if (handValue(p.hand) > 21) { p.status = 'bust'; this.broadcast(); this.advanceTurn(); }
      else { this.broadcast(); this.deadline = Date.now() + TURN_TIMEOUT_MS;
        this.timer = setTimeout(() => this.playerAction(p.id, 'stand'), TURN_TIMEOUT_MS);
        if (p.isBot) setTimeout(() => this.botAct(p), 700); }
    } else if (action === 'stand') {
      p.status = 'stood'; this.broadcast(); this.advanceTurn();
    } else if (action === 'double') {
      if (p.hand.length === 2 && p.bankroll >= p.bet) {
        p.bankroll -= p.bet; p.bet *= 2; p.hand.push(this.draw());
        p.status = handValue(p.hand) > 21 ? 'bust' : 'stood';
      }
      this.broadcast(); this.advanceTurn();
    } else if (action === 'surrender') {
      if (p.hand.length === 2) { p.bankroll += Math.floor(p.bet / 2); p.status = 'surrendered'; }
      this.broadcast(); this.advanceTurn();
    }
  }

  dealerPlay() {
    const anyoneLeft = this.activePlayers().some(p => p.status === 'stood' || p.status === 'blackjack');
    const reveal = () => {
      const dv = handValue(this.dealerHand);
      const shouldHit = anyoneLeft && (dv < 17 || (dv === 17 && isSoft17(this.dealerHand)));
      if (shouldHit) { this.dealerHand.push(this.draw()); this.broadcast(); setTimeout(reveal, 600); }
      else { this.resolveRound(); }
    };
    this.phase = 'dealer';
    this.broadcast();
    setTimeout(reveal, 500);
  }

  resolveRound() {
    const dVal = handValue(this.dealerHand);
    const dBJ = isBlackjack(this.dealerHand);
    for (const p of this.activePlayers()) {
      if (p.status === 'eliminated' || p.status === 'left') continue;
      if (p.status === 'surrendered') continue;
      const pVal = handValue(p.hand);
      let winnings = 0;
      if (p.status === 'bust') winnings = 0;
      else if (p.status === 'blackjack' && dBJ) winnings = p.bet;
      else if (p.status === 'blackjack') winnings = p.bet + Math.floor(p.bet * 1.5);
      else if (dBJ) winnings = 0;
      else if (dVal > 21) winnings = p.bet * 2;
      else if (pVal > dVal) winnings = p.bet * 2;
      else if (pVal < dVal) winnings = 0;
      else winnings = p.bet;
      p.bankroll += winnings;
    }
    this.phase = 'round_over';
    this.roundMsg = 'Round over';
    this.turnIndex = -1;
    this.broadcast();
    this.timer = setTimeout(() => {
      const humans = this.activePlayers().filter(p => !p.isBot);
      if (humans.length === 0 || humans.every(p => p.bankroll < MIN_BET && p.status !== 'betting')) {
        this.endGame();
      } else {
        this.startBettingRound();
      }
    }, 3500);
  }

  endGame() {
    this.clearTimer();
    this.phase = 'game_over';
    this.roundMsg = 'Game over';
    this.broadcast();
    setTimeout(() => this.destroy(), 5000);
  }
}

// ---- WebSocket wiring ----

const server = http.createServer((req, res) => { res.writeHead(200); res.end('Emerald Table Blackjack server OK'); });
const wss = new WebSocketServer({ server });

let nextId = 1;
function newId() { return 'p' + (nextId++) + '-' + Math.random().toString(36).slice(2, 7); }

wss.on('connection', (ws) => {
  let playerId = null;
  let lobbyCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const id = newId();
      const player = makePlayer({ id, name: (msg.name || 'Player').slice(0, 16), ws, isBot: false });
      const code = genCode();
      const lobby = new Lobby(code, player);
      lobbies.set(code, lobby);
      playerId = id; lobbyCode = code;
      ws.send(JSON.stringify({ type: 'joined', code, playerId: id }));
      lobby.startCountdown();
    } else if (msg.type === 'join') {
      const lobby = lobbies.get((msg.code || '').toUpperCase());
      if (!lobby) { ws.send(JSON.stringify({ type: 'error', message: 'No lobby with that code.' })); return; }
      const id = newId();
      const player = makePlayer({ id, name: (msg.name || 'Player').slice(0, 16), ws, isBot: false });
      if (!lobby.addPlayer(player)) { ws.send(JSON.stringify({ type: 'error', message: 'Lobby is full or already started.' })); return; }
      playerId = id; lobbyCode = lobby.code;
      ws.send(JSON.stringify({ type: 'joined', code: lobby.code, playerId: id }));
    } else if (msg.type === 'bet') {
      const lobby = lobbies.get(lobbyCode); if (lobby) lobby.placeBet(playerId, Number(msg.amount) || 0);
    } else if (msg.type === 'action') {
      const lobby = lobbies.get(lobbyCode); if (lobby) lobby.playerAction(playerId, msg.action);
    } else if (msg.type === 'start_now') {
      const lobby = lobbies.get(lobbyCode); if (lobby) lobby.forceStart(playerId);
    } else if (msg.type === 'leave') {
      const lobby = lobbies.get(lobbyCode); if (lobby) lobby.removePlayer(playerId);
      lobbyCode = null; playerId = null;
    }
  });

  ws.on('close', () => {
    const lobby = lobbies.get(lobbyCode);
    if (lobby) lobby.removePlayer(playerId);
  });
});

server.listen(PORT, () => console.log('Emerald Table Blackjack server listening on :' + PORT));
