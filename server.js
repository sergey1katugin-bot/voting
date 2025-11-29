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
  teams: [
    { id: 0, name: 'Команда 1', votes: 0, color: TEAM_COLORS[0] },
    { id: 1, name: 'Команда 2', votes: 0, color: TEAM_COLORS[1] }
  ],
  votingOpen: true,
  // Multiple ways to track voters to prevent cheating
  votersByFingerprint: new Map(), // fingerprint -> { visitorId, visitorKey, teamId }
  votersBySocket: new Map()       // socket.id -> teamId (backup)
};

// Admin password (change this!)
const ADMIN_PASSWORD = 'admin123';

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Store fingerprint for this socket
  let socketFingerprint = null;

  // Register fingerprint
  socket.on('register-fingerprint', (data) => {
    socketFingerprint = data.visitorId;

    // Check if already voted
    const existingVote = gameState.votersByFingerprint.get(data.visitorId);

    socket.emit('state', {
      round: gameState.round,
      roundName: gameState.roundName,
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
  });

  // Admin actions
  socket.on('admin-login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      socket.emit('admin-auth', true);
      socket.emit('admin-state', {
        round: gameState.round,
        roundName: gameState.roundName,
        teams: gameState.teams,
        votingOpen: gameState.votingOpen,
        totalVoters: gameState.votersByFingerprint.size || gameState.votersBySocket.size
      });
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

      // Notify all users
      io.emit('reset', {
        round: gameState.round,
        roundName: gameState.roundName,
        teams: gameState.teams,
        votingOpen: gameState.votingOpen
      });
    }
  });

  socket.on('admin-next-round', () => {
    if (socket.rooms.has('admins')) {
      gameState.round++;
      gameState.roundName = '';
      gameState.teams.forEach(t => t.votes = 0);
      gameState.votersByFingerprint.clear();
      gameState.votersBySocket.clear();
      gameState.votingOpen = true;

      io.emit('new-round', {
        round: gameState.round,
        roundName: gameState.roundName,
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
