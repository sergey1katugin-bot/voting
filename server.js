const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state
let gameState = {
  round: 1,
  roundName: '',
  teamLeft: { name: 'Команда 1', votes: 0 },
  teamRight: { name: 'Команда 2', votes: 0 },
  votingOpen: true,
  voters: new Set() // Track who voted (by socket id)
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

  // Send current state to new user
  socket.emit('state', {
    round: gameState.round,
    roundName: gameState.roundName,
    teamLeft: gameState.teamLeft,
    teamRight: gameState.teamRight,
    votingOpen: gameState.votingOpen,
    hasVoted: gameState.voters.has(socket.id)
  });

  // User votes
  socket.on('vote', (team) => {
    if (!gameState.votingOpen) {
      socket.emit('error', 'Голосование закрыто');
      return;
    }

    if (gameState.voters.has(socket.id)) {
      socket.emit('error', 'Вы уже голосовали');
      return;
    }

    if (team === 'left') {
      gameState.teamLeft.votes++;
    } else if (team === 'right') {
      gameState.teamRight.votes++;
    }

    gameState.voters.add(socket.id);

    // Notify the voter
    socket.emit('voted', team);

    // Broadcast updated results to all
    io.emit('results', {
      teamLeft: gameState.teamLeft,
      teamRight: gameState.teamRight,
      totalVoters: gameState.voters.size
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
        teamLeft: gameState.teamLeft,
        teamRight: gameState.teamRight,
        votingOpen: gameState.votingOpen,
        totalVoters: gameState.voters.size
      });
    } else {
      socket.emit('admin-auth', false);
    }
  });

  socket.on('admin-reset', () => {
    if (socket.rooms.has('admins')) {
      gameState.teamLeft.votes = 0;
      gameState.teamRight.votes = 0;
      gameState.voters.clear();
      gameState.votingOpen = true;

      // Notify all users
      io.emit('reset', {
        round: gameState.round,
        roundName: gameState.roundName,
        teamLeft: gameState.teamLeft,
        teamRight: gameState.teamRight,
        votingOpen: gameState.votingOpen
      });
    }
  });

  socket.on('admin-next-round', () => {
    if (socket.rooms.has('admins')) {
      gameState.round++;
      gameState.roundName = '';
      gameState.teamLeft.votes = 0;
      gameState.teamRight.votes = 0;
      gameState.voters.clear();
      gameState.votingOpen = true;

      io.emit('new-round', {
        round: gameState.round,
        roundName: gameState.roundName,
        teamLeft: gameState.teamLeft,
        teamRight: gameState.teamRight,
        votingOpen: gameState.votingOpen
      });
    }
  });

  socket.on('admin-toggle-voting', () => {
    if (socket.rooms.has('admins')) {
      gameState.votingOpen = !gameState.votingOpen;
      io.emit('voting-status', { votingOpen: gameState.votingOpen });
    }
  });

  socket.on('admin-set-names', ({ leftName, rightName, roundName }) => {
    if (socket.rooms.has('admins')) {
      if (leftName !== undefined) gameState.teamLeft.name = leftName || 'Команда 1';
      if (rightName !== undefined) gameState.teamRight.name = rightName || 'Команда 2';
      if (roundName !== undefined) gameState.roundName = roundName;

      io.emit('names-updated', {
        teamLeft: gameState.teamLeft,
        teamRight: gameState.teamRight,
        roundName: gameState.roundName
      });
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
