const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Team colors for dynamic teams
const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'];

// Game state
let gameState = {
  round: 1,
  roundName: '',
  voteSession: Date.now(), // Unique ID for current voting session, changes on reset/new round
  teams: [
    { id: 0, name: 'Команда 1', votes: 0, color: TEAM_COLORS[0] },
    { id: 1, name: 'Команда 2', votes: 0, color: TEAM_COLORS[1] }
  ],
  votingOpen: true,
  // Multiple ways to track voters to prevent cheating
  votersByFingerprint: new Map(), // fingerprint -> { visitorId, visitorKey, teamId }
  votersBySocket: new Map(),      // socket.id -> teamId (backup)
  connectedUsers: new Set()       // visitorId of connected users (excluding admins)
};

// History of last 10 rounds
let roundHistory = [];

// Admin password (change this!)
const ADMIN_PASSWORD = 'admin123';

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Helper to send stats to admins
function broadcastAdminStats() {
  const totalVoters = gameState.votersByFingerprint.size || gameState.votersBySocket.size;
  const connectedUsers = gameState.connectedUsers.size;
  const votePercent = connectedUsers > 0 ? Math.round((totalVoters / connectedUsers) * 100) : 0;

  io.to('admins').emit('admin-stats', {
    totalVoters,
    connectedUsers,
    votePercent
  });
}

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Store fingerprint for this socket
  let socketFingerprint = null;

  // Quick state request (before fingerprint is ready)
  socket.on('get-state', () => {
    socket.emit('state', {
      round: gameState.round,
      roundName: gameState.roundName,
      voteSession: gameState.voteSession,
      teams: gameState.teams,
      votingOpen: gameState.votingOpen,
      votedFor: socketFingerprint ? (gameState.votersByFingerprint.get(socketFingerprint)?.teamId ?? null) : null
    });
  });

  // Register fingerprint
  socket.on('register-fingerprint', (data) => {
    socketFingerprint = data.visitorId;

    // Track connected user
    gameState.connectedUsers.add(data.visitorId);
    broadcastAdminStats();

    // Check if already voted
    const existingVote = gameState.votersByFingerprint.get(data.visitorId);

    socket.emit('state', {
      round: gameState.round,
      roundName: gameState.roundName,
      voteSession: gameState.voteSession,
      teams: gameState.teams,
      votingOpen: gameState.votingOpen,
      votedFor: existingVote ? existingVote.teamId : null
    });
  });

  // User votes
  socket.on('vote', ({ teamId, visitorId, visitorKey }) => {
    if (!gameState.votingOpen) {
      socket.emit('error', 'Голосование закрыто');
      return;
    }

    // Check by fingerprint (primary)
    if (visitorId && gameState.votersByFingerprint.has(visitorId)) {
      socket.emit('error', 'Вы уже голосовали');
      socket.emit('voted', gameState.votersByFingerprint.get(visitorId).teamId);
      return;
    }

    // Check by socket (backup)
    if (gameState.votersBySocket.has(socket.id)) {
      socket.emit('error', 'Вы уже голосовали');
      socket.emit('voted', gameState.votersBySocket.get(socket.id));
      return;
    }

    const team = gameState.teams.find(t => t.id === teamId);
    if (!team) {
      socket.emit('error', 'Команда не найдена');
      return;
    }

    team.votes++;

    // Store vote by fingerprint
    if (visitorId) {
      gameState.votersByFingerprint.set(visitorId, { visitorId, visitorKey, teamId });
    }

    // Store by socket as backup
    gameState.votersBySocket.set(socket.id, teamId);

    console.log(`Vote: team=${teamId}, visitorId=${visitorId?.substring(0, 8)}..., socket=${socket.id}`);

    // Notify the voter
    socket.emit('voted', teamId);

    // Broadcast updated results to all
    io.emit('results', {
      teams: gameState.teams,
      totalVoters: gameState.votersByFingerprint.size || gameState.votersBySocket.size
    });

    // Update admin stats
    broadcastAdminStats();
  });

  // Admin actions
  socket.on('admin-login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      socket.emit('admin-auth', true);
      const totalVoters = gameState.votersByFingerprint.size || gameState.votersBySocket.size;
      const connectedUsers = gameState.connectedUsers.size;
      const votePercent = connectedUsers > 0 ? Math.round((totalVoters / connectedUsers) * 100) : 0;
      socket.emit('admin-state', {
        round: gameState.round,
        roundName: gameState.roundName,
        teams: gameState.teams,
        votingOpen: gameState.votingOpen,
        totalVoters,
        connectedUsers,
        votePercent
      });
      // Send round history
      socket.emit('round-history', roundHistory);
    } else {
      socket.emit('admin-auth', false);
    }
  });

  socket.on('admin-reset', () => {
    if (socket.rooms.has('admins')) {
      gameState.teams.forEach(t => t.votes = 0);
      gameState.votersByFingerprint.clear();
      gameState.votersBySocket.clear();
      gameState.votingOpen = true;
      gameState.voteSession = Date.now(); // New session ID

      // Notify all users
      io.emit('reset', {
        round: gameState.round,
        roundName: gameState.roundName,
        voteSession: gameState.voteSession,
        teams: gameState.teams,
        votingOpen: gameState.votingOpen
      });
    }
  });

  socket.on('admin-next-round', () => {
    if (socket.rooms.has('admins')) {
      // Save current round to history before moving to next
      const totalVoters = gameState.votersByFingerprint.size || gameState.votersBySocket.size;
      if (totalVoters > 0) {
        roundHistory.unshift({
          round: gameState.round,
          roundName: gameState.roundName,
          teams: gameState.teams.map(t => ({ ...t })),
          totalVoters,
          timestamp: Date.now()
        });
        // Keep only last 10
        if (roundHistory.length > 10) {
          roundHistory.pop();
        }
        // Notify admins of updated history
        io.to('admins').emit('round-history', roundHistory);
      }

      gameState.round++;
      gameState.roundName = '';
      gameState.voteSession = Date.now(); // New session ID
      gameState.teams.forEach(t => t.votes = 0);
      gameState.votersByFingerprint.clear();
      gameState.votersBySocket.clear();
      gameState.votingOpen = true;

      io.emit('new-round', {
        round: gameState.round,
        roundName: gameState.roundName,
        voteSession: gameState.voteSession,
        teams: gameState.teams,
        votingOpen: gameState.votingOpen
      });
    }
  });

  socket.on('admin-toggle-voting', () => {
    if (socket.rooms.has('admins')) {
      gameState.votingOpen = !gameState.votingOpen;
      // When closing voting, send results to all clients
      io.emit('voting-status', {
        votingOpen: gameState.votingOpen,
        teams: gameState.teams,
        totalVoters: gameState.votersByFingerprint.size || gameState.votersBySocket.size
      });
    }
  });

  socket.on('admin-set-round-name', (roundName) => {
    if (socket.rooms.has('admins')) {
      gameState.roundName = roundName || '';
      io.emit('round-name-updated', { roundName: gameState.roundName });
    }
  });

  socket.on('admin-update-team', ({ id, name }) => {
    if (socket.rooms.has('admins')) {
      const team = gameState.teams.find(t => t.id === id);
      if (team) {
        team.name = name || `Команда ${id + 1}`;
        io.emit('teams-updated', { teams: gameState.teams });
      }
    }
  });

  socket.on('admin-add-team', () => {
    if (socket.rooms.has('admins')) {
      const newId = gameState.teams.length > 0
        ? Math.max(...gameState.teams.map(t => t.id)) + 1
        : 0;
      const colorIndex = newId % TEAM_COLORS.length;
      gameState.teams.push({
        id: newId,
        name: `Команда ${newId + 1}`,
        votes: 0,
        color: TEAM_COLORS[colorIndex]
      });
      io.emit('teams-updated', { teams: gameState.teams });
    }
  });

  socket.on('admin-remove-team', (teamId) => {
    if (socket.rooms.has('admins')) {
      if (gameState.teams.length <= 2) {
        socket.emit('error', 'Минимум 2 команды');
        return;
      }
      gameState.teams = gameState.teams.filter(t => t.id !== teamId);
      io.emit('teams-updated', { teams: gameState.teams });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Remove from connected users
    if (socketFingerprint) {
      gameState.connectedUsers.delete(socketFingerprint);
      broadcastAdminStats();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
