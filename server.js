const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 30000,
    pingInterval: 5000,
    transports: ['websocket', 'polling'],
    upgradeTimeout: 10000,
    maxHttpBufferSize: 1e8,
    // Add these for Vercel:
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    allowEIO3: true
});
app.use(express.static(path.join(__dirname, 'public')));

// Ensure you have a route handler for the root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add this below your other routes
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Track rooms, users and passwords
const rooms = new Map(); // Enhance to track video state
const roomStates = new Map();
const roomPasswords = new Map();

// Add a map to track the last command timestamp and sequence number per room
const roomCommandTimestamps = new Map();
const roomCommandSequence = new Map();

function getRoomUserCount(roomName) {
    if (!io.sockets.adapter.rooms.has(roomName)) return 0;
    return io.sockets.adapter.rooms.get(roomName).size;
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let currentRoom = null;

    socket.on('create-room', (data) => {
        // Support both old string format and new object format with password
        const roomName = typeof data === 'object' ? data.room : data;
        const password = typeof data === 'object' ? data.password : null;
        
        // Check if room already exists
        if (io.sockets.adapter.rooms.has(roomName) && 
            io.sockets.adapter.rooms.get(roomName).size > 0) {
            console.log(`Room ${roomName} already exists, cannot create`);
            return socket.emit('error', 'Room already exists. Please join it or choose a different name.');
        }
        
        if (currentRoom) {
            socket.leave(currentRoom);
            console.log(`User ${socket.id} left room ${currentRoom}`);
        }
        
        console.log(`Creating new room: ${roomName}, Password protected: ${password ? 'yes' : 'no'}`);
        
        // Store password if provided
        if (password && password.trim() !== '') {
            roomPasswords.set(roomName, password);
        } else {
            roomPasswords.delete(roomName);
        }
        
        socket.join(roomName);
        currentRoom = roomName;
        
        if (!rooms.has(roomName)) {
            rooms.set(roomName, new Set());
        }
        rooms.get(roomName).add(socket.id);
        
        const userCount = getRoomUserCount(roomName);
        socket.emit('room-created', { 
            room: roomName, 
            users: userCount,
            isProtected: !!password
        });
        io.to(roomName).emit('user-count-update', { room: roomName, count: userCount });
    });

    socket.on('join-room', (data) => {
        // Support both old string format and new object format with password
        const roomName = typeof data === 'object' ? data.room : data;
        const password = typeof data === 'object' ? data.password : null;
        
        console.log(`User ${socket.id} requesting to join room: ${roomName}`);
        
        // Check if room exists
        if (!io.sockets.adapter.rooms.has(roomName) || 
            io.sockets.adapter.rooms.get(roomName).size === 0) {
            console.log(`Room ${roomName} does not exist`);
            return socket.emit('error', 'Room does not exist. Please create it first.');
        }
        
        // Check if password is required and matches
        const roomHasPassword = roomPasswords.has(roomName);
        const providedPassword = password || '';
        const requiredPassword = roomHasPassword ? roomPasswords.get(roomName) : '';
        
        console.log(`Room ${roomName} has password: ${roomHasPassword}`);
        
        if (roomHasPassword && providedPassword !== requiredPassword) {
            return socket.emit('error', 'Incorrect password for this room');
        }
        
        if (currentRoom) {
            socket.leave(currentRoom);
            console.log(`User ${socket.id} left room ${currentRoom}`);
        }
        
        console.log(`User ${socket.id} joining existing room: ${roomName}`);
        socket.join(roomName);
        currentRoom = roomName;
        
        if (!rooms.has(roomName)) {
            rooms.set(roomName, new Set());
        }
        rooms.get(roomName).add(socket.id);
        
        const userCount = getRoomUserCount(roomName);
        console.log(`Room ${roomName} now has ${userCount} users`);
        
        // Important: Send updated user count to ALL users in the room
        io.to(roomName).emit('user-count-update', { 
            room: roomName, 
            count: userCount 
        });
        
        // Send specific join confirmation to the new user
        socket.emit('room-joined', { 
            room: roomName, 
            users: userCount,
            isProtected: roomPasswords.has(roomName)
        });
        
        // Send the current video state to the new user
        const state = roomStates.get(roomName);
        if (state) {
            console.log(`Sending current video state to new user: ${JSON.stringify(state)}`);
            socket.emit('video-state-update', state);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (currentRoom) {
            if (rooms.has(currentRoom)) {
                const roomUsers = rooms.get(currentRoom);
                roomUsers.delete(socket.id);
                
                if (roomUsers.size === 0) {
                    rooms.delete(currentRoom);
                } else {
                    const userCount = getRoomUserCount(currentRoom);
                    io.to(currentRoom).emit('user-count-update', { room: currentRoom, count: userCount });
                }
            }
        }
    });

    socket.on('load-video', (data) => {
        console.log(`Loading video in room ${data.room}: ${data.videoId}`);
        
        // Store video state for later sync
        const currentState = roomStates.get(data.room) || {};
        roomStates.set(data.room, {
            ...currentState,
            videoId: data.videoId,
            action: 'pause',  // Default to paused when loading a new video
            clientTime: 0,
            serverTime: Date.now()
        });
        
        io.to(data.room).emit('load-video', data);
    });

    socket.on('play', (data) => {
        console.log(`Playing video in room ${data.room} at ${data.time}`);
        
        // Get current sequence number or initialize
        const currentSeq = roomCommandSequence.get(data.room) || 0;
        const nextSeq = currentSeq + 1;
        roomCommandSequence.set(data.room, nextSeq);
        
        // Get last command time or use 0
        const lastCommandTime = roomCommandTimestamps.get(data.room) || 0;
        const now = Date.now();
        
        // Debounce rapid commands (minimum 300ms between commands)
        if (now - lastCommandTime < 300) {
            console.log(`Ignoring rapid play command in room ${data.room}, too soon after last command`);
            return;
        }
        
        // Update last command time
        roomCommandTimestamps.set(data.room, now);
        
        // Preserve the videoId when updating state
        const currentState = roomStates.get(data.room) || {};
        const videoId = data.videoId || currentState.videoId;
        
        // Store state with server timestamp and sequence number
        roomStates.set(data.room, {
            action: 'play',
            videoId: videoId,
            clientTime: data.time,
            serverTime: now,
            rate: data.rate || 1,
            seq: nextSeq
        });
        
        // Add server timestamp and sequence to the data
        data.serverTime = now;
        data.seq = nextSeq;
        
        io.to(data.room).emit('play', data);
    });

    socket.on('pause', (data) => {
        console.log(`Pausing video in room ${data.room} at ${data.time}`);
        
        // Get current sequence number or initialize
        const currentSeq = roomCommandSequence.get(data.room) || 0;
        const nextSeq = currentSeq + 1;
        roomCommandSequence.set(data.room, nextSeq);
        
        // Get last command time or use 0
        const lastCommandTime = roomCommandTimestamps.get(data.room) || 0;
        const now = Date.now();
        
        // Debounce rapid commands
        if (now - lastCommandTime < 300) {
            console.log(`Ignoring rapid pause command in room ${data.room}, too soon after last command`);
            return;
        }
        
        // Update last command time
        roomCommandTimestamps.set(data.room, now);
        
        // Preserve the videoId when updating state
        const currentState = roomStates.get(data.room) || {};
        const videoId = data.videoId || currentState.videoId;
        
        roomStates.set(data.room, {
            action: 'pause',
            videoId: videoId,
            clientTime: data.time,
            serverTime: now,
            seq: nextSeq
        });
        
        // Add sequence and timestamp
        data.serverTime = now;
        data.seq = nextSeq;
        
        io.to(data.room).emit('pause', data);
    });

    socket.on('sync-check', (data) => {
        const roomState = roomStates.get(data.room);
        if (roomState && roomState.action === 'play') {
            // Calculate expected position
            const elapsedSecs = (Date.now() - roomState.serverTime) / 1000;
            const expectedTime = roomState.clientTime + (elapsedSecs * roomState.rate);
            
            // Use client-reported latency with fallback
            const clientLatency = data.latency || 0;
            const syncThreshold = Math.max(1, Math.min(5, clientLatency / 500)) || 3;
            
            if (Math.abs(data.time - expectedTime) > syncThreshold) {
                socket.emit('resync', {
                    time: expectedTime,
                    serverTime: Date.now()
                });
            }
        }
    });
    
    socket.on('request-video-state', (data) => {
        const state = roomStates.get(data.room);
        if (state) {
            console.log(`Sending video state to user ${socket.id}: ${JSON.stringify(state)}`);
            socket.emit('video-state-update', state);
        } else {
            console.log(`No video state found for room ${data.room}`);
        }
    });
});

server.listen(3000, () => {
    console.log('Server läuft auf Port 3000');
});