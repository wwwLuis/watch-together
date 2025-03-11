# Watch-Together Documentation

## Overview

Watch-Together is a real-time application that enables synchronized video watching in shared rooms. Users can create or join rooms and watch videos together with playback synchronized across all participants.

## Architecture

The application uses a client-server architecture with the following components:

- **Backend**: Node.js with Express
- **Real-time Communication**: Socket.IO
- **Frontend**: Static HTML/CSS/JS served from the public directory

## Server Components

### Express Server Setup

```javascript
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
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the main application interface |
| `/api/health` | GET | Health check endpoint for monitoring |

## Room Management

The server manages rooms using several data structures:

```javascript
const rooms = new Map();           // Maps room names to sets of socket IDs
const roomStates = new Map();      // Stores current video state for each room
const roomPasswords = new Map();   // Stores passwords for protected rooms
const roomCommandTimestamps = new Map(); // Tracks command timing for debouncing
const roomCommandSequence = new Map();   // Tracks command sequence numbers
```

### Room Features

- **Room Creation**: Users can create rooms with optional password protection
- **Room Joining**: Users can join existing rooms with password verification
- **User Tracking**: The server tracks users in each room
- **Auto-Cleanup**: Empty rooms are automatically removed

## Socket.IO Events

### Client → Server Events

| Event | Parameters | Description |
|-------|------------|-------------|
| `create-room` | `{room: string, password?: string}` | Creates a new room with optional password |
| `join-room` | `{room: string, password?: string}` | Joins an existing room |
| `load-video` | `{room: string, videoId: string}` | Loads a new video for everyone in the room |
| `play` | `{room: string, time: number, rate?: number}` | Plays video at specified time |
| `pause` | `{room: string, time: number}` | Pauses video at specified time |
| `sync-check` | `{room: string, time: number, latency?: number}` | Requests sync verification |
| `request-video-state` | `{room: string}` | Requests current video state |

### Server → Client Events

| Event | Data | Description |
|-------|------|-------------|
| `error` | `string` | Error message |
| `room-created` | `{room: string, users: number, isProtected: boolean}` | Room creation confirmation |
| `room-joined` | `{room: string, users: number, isProtected: boolean}` | Room join confirmation |
| `user-count-update` | `{room: string, count: number}` | Updates when user count changes |
| `user-joined` | `{room: string, userId: string, count: number}` | Notification when a new user joins |
| `load-video` | `{room: string, videoId: string}` | Instructs client to load a video |
| `play` | `{time: number, serverTime: number, seq: number}` | Instructs client to play video |
| `pause` | `{time: number, serverTime: number, seq: number}` | Instructs client to pause video |
| `resync` | `{time: number, serverTime: number}` | Corrects client playback position |
| `video-state-update` | `{action, videoId, clientTime, serverTime}` | Current video state |

## Video Synchronization

The application ensures synchronized playback through several mechanisms:

1. **State Tracking**: Server maintains the current video state for each room
2. **Command Sequencing**: Each command has a sequence number to prevent out-of-order execution
3. **Command Debouncing**: Prevents rapid-fire commands (300ms minimum between commands)
4. **Client Sync Checking**: Clients periodically verify their playback position
5. **Adaptive Sync Threshold**: Adjusts sync tolerance based on client latency

## Running the Server

The server runs on port 3000 by default or uses the PORT environment variable:

```javascript
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

## Security Considerations

- Room passwords are stored in memory (not persisted)
- No user authentication beyond room passwords
- Consider implementing HTTPS in production
