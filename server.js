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
    maxHttpBufferSize: 1e8
});
app.use(express.static(path.join(__dirname, 'public')));

// Root route handler
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint for monitoring
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Data structures for room management
const rooms = new Map(); 
const roomStates = new Map();
const roomPasswords = new Map();
const roomCommandTimestamps = new Map();
const roomCommandSequence = new Map();

// Get the number of users in a room
function getRoomUserCount(roomName) {
    if (!io.sockets.adapter.rooms.has(roomName)) return 0;
    return io.sockets.adapter.rooms.get(roomName).size;
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let currentRoom = null;

    // Create new room with optional password protection
    socket.on('create-room', (data) => {
        const roomName = typeof data === 'object' ? data.room : data;
        const password = typeof data === 'object' ? data.password : null;
        
        if (io.sockets.adapter.rooms.has(roomName) && 
            io.sockets.adapter.rooms.get(roomName).size > 0) {
            return socket.emit('error', 'Room already exists. Please join it or choose a different name.');
        }
        
        if (currentRoom) {
            socket.leave(currentRoom);
        }
        
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

    // Join existing room with password verification
    socket.on('join-room', (data) => {
        const roomName = typeof data === 'object' ? data.room : data;
        const password = typeof data === 'object' ? data.password : null;
        
        if (!io.sockets.adapter.rooms.has(roomName) || 
            io.sockets.adapter.rooms.get(roomName).size === 0) {
            return socket.emit('error', 'Room does not exist. Please create it first.');
        }
        
        const roomHasPassword = roomPasswords.has(roomName);
        const providedPassword = password || '';
        const requiredPassword = roomHasPassword ? roomPasswords.get(roomName) : '';
        
        if (roomHasPassword && providedPassword !== requiredPassword) {
            return socket.emit('error', 'Incorrect password for this room');
        }
        
        if (currentRoom) {
            socket.leave(currentRoom);
        }
        
        socket.join(roomName);
        currentRoom = roomName;
        
        if (!rooms.has(roomName)) {
            rooms.set(roomName, new Set());
        }
        rooms.get(roomName).add(socket.id);
        
        const userCount = getRoomUserCount(roomName);
        
        io.to(roomName).emit('user-count-update', { 
            room: roomName, 
            count: userCount 
        });
        
        socket.emit('room-joined', { 
            room: roomName, 
            users: userCount,
            isProtected: roomPasswords.has(roomName)
        });
        
        // Sync new user with current video state
        const state = roomStates.get(roomName);
        if (state) {
            socket.emit('video-state-update', state);
        }
    });

    // Clean up user data on disconnect
    socket.on('disconnect', () => {
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

    // Load a new video for everyone in the room
    socket.on('load-video', (data) => {
        const currentState = roomStates.get(data.room) || {};
        roomStates.set(data.room, {
            ...currentState,
            videoId: data.videoId,
            action: 'pause',
            clientTime: 0,
            serverTime: Date.now()
        });
        
        io.to(data.room).emit('load-video', data);
    });

    // Play video for everyone in the room
    socket.on('play', (data) => {
        // Implement command debouncing
        const currentSeq = roomCommandSequence.get(data.room) || 0;
        const nextSeq = currentSeq + 1;
        roomCommandSequence.set(data.room, nextSeq);
        
        const lastCommandTime = roomCommandTimestamps.get(data.room) || 0;
        const now = Date.now();
        
        if (now - lastCommandTime < 300) {
            return;
        }
        
        roomCommandTimestamps.set(data.room, now);
        
        // Update room state with video info
        const currentState = roomStates.get(data.room) || {};
        const videoId = data.videoId || currentState.videoId;
        
        roomStates.set(data.room, {
            action: 'play',
            videoId: videoId,
            clientTime: data.time,
            serverTime: now,
            rate: data.rate || 1,
            seq: nextSeq
        });
        
        data.serverTime = now;
        data.seq = nextSeq;
        
        io.to(data.room).emit('play', data);
    });

    // Pause video for everyone in the room
    socket.on('pause', (data) => {
        // Implement command debouncing
        const currentSeq = roomCommandSequence.get(data.room) || 0;
        const nextSeq = currentSeq + 1;
        roomCommandSequence.set(data.room, nextSeq);
        
        const lastCommandTime = roomCommandTimestamps.get(data.room) || 0;
        const now = Date.now();
        
        if (now - lastCommandTime < 300) {
            return;
        }
        
        roomCommandTimestamps.set(data.room, now);
        
        const currentState = roomStates.get(data.room) || {};
        const videoId = data.videoId || currentState.videoId;
        
        roomStates.set(data.room, {
            action: 'pause',
            videoId: videoId,
            clientTime: data.time,
            serverTime: now,
            seq: nextSeq
        });
        
        data.serverTime = now;
        data.seq = nextSeq;
        
        io.to(data.room).emit('pause', data);
    });

    // Check if clients are synchronized and issue corrections if needed
    socket.on('sync-check', (data) => {
        const roomState = roomStates.get(data.room);
        if (roomState && roomState.action === 'play') {
            const elapsedSecs = (Date.now() - roomState.serverTime) / 1000;
            const expectedTime = roomState.clientTime + (elapsedSecs * roomState.rate);
            
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
    
    // Send current video state to requesting client
    socket.on('request-video-state', (data) => {
        const state = roomStates.get(data.room);
        if (state) {
            socket.emit('video-state-update', state);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});