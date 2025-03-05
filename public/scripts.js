document.addEventListener('DOMContentLoaded', () => {
    let socket = io({
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        forceNew: true
    });
    let player;
    let room;
    let playerReady = false;
    let isSyncing = false;
    let usersInRoom = 0;
    let networkLatency = 0;
    let bufferingTimeout;

    // Command debouncing
    let lastCommandTime = 0;
    const COMMAND_DEBOUNCE_MS = 300;

    function canSendCommand() {
        const now = Date.now();
        if (now - lastCommandTime < COMMAND_DEBOUNCE_MS) {
            return false;
        }
        lastCommandTime = now;
        return true;
    }

    // Update UI status message
    function updateStatus(message, isError = false) {
        const statusElement = document.getElementById('status');
        statusElement.textContent = message;
        statusElement.className = isError ? 'text-danger' : 'text-success';
        setTimeout(() => { statusElement.textContent = ''; }, 3000);
    }

    // Show socket connection details for debugging
    function debugSocketStatus() {
        const statusArea = document.getElementById('status');
        const debugInfo = document.createElement('div');
        debugInfo.innerHTML = `
            <small>
            Socket ID: ${socket.id || 'Not connected'}<br>
            Connected: ${socket.connected ? 'Yes' : 'No'}<br>
            Transport: ${socket.io?.engine?.transport?.name || 'None'}
            </small>
        `;
        statusArea.appendChild(debugInfo);
    }
    setTimeout(debugSocketStatus, 2000);

    // Show/hide synchronization indicator
    function showSyncStatus(isSyncing, message = '⟳ Synchronizing...') {
        const syncIndicator = document.createElement('div');
        syncIndicator.id = 'sync-indicator';
        syncIndicator.textContent = message;
        syncIndicator.style = 'color: orange; font-weight: bold;';
        
        const statusEl = document.getElementById('status');
        if (isSyncing) {
            if (!document.getElementById('sync-indicator')) {
                statusEl.appendChild(syncIndicator);
            }
        } else {
            const indicator = document.getElementById('sync-indicator');
            if (indicator) statusEl.removeChild(indicator);
        }
    }

    // Update video timestamp display
    function updateTimestamp() {
        if (player && playerReady) {
            const currentTime = player.getCurrentTime();
            const duration = player.getDuration();
            if (currentTime && duration) {
                const currentMinutes = Math.floor(currentTime / 60);
                const currentSeconds = Math.floor(currentTime % 60);
                const totalMinutes = Math.floor(duration / 60);
                const totalSeconds = Math.floor(duration % 60);
                document.getElementById('timestamp').textContent = 
                    `${currentMinutes}:${currentSeconds < 10 ? '0' : ''}${currentSeconds} / ${totalMinutes}:${totalSeconds < 10 ? '0' : ''}${totalSeconds}`;
                
                document.getElementById('seek-slider').value = (currentTime / duration) * 100;
            }
        }
    }
    setInterval(updateTimestamp, 1000);

    // Measure network latency
    function updateLatency() {
        const start = Date.now();
        socket.emit('ping', () => {
            networkLatency = (Date.now() - start) / 2;
        });
    }
    setInterval(updateLatency, 10000);

    // Initialize YouTube API
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/player_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    // YouTube player initialization
    window.onYouTubeIframeAPIReady = function() {
        try {
            player = new YT.Player('youtube-player', {
                height: '315',
                width: '560',
                videoId: '',
                playerVars: {
                    'playsinline': 1
                },
                events: {
                    'onReady': (event) => {
                        playerReady = true;
                    },
                    'onStateChange': onPlayerStateChange,
                    'onError': (event) => {
                        console.error('YouTube Player error:', event.data);   
                    }
                }             
            });
        } catch (error) {
            console.error('YouTube Player Error:', error);
        }   
    };
    
    // Handle YouTube player state changes
    function onPlayerStateChange(event) {
        if (!room || !playerReady || isSyncing) return;
        if (!canSendCommand()) return;
        
        // Skip autoplay events
        if (event.data === YT.PlayerState.PLAYING && player.getCurrentTime() < 0.5) {
            return;
        }
        
        if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
            const action = event.data === YT.PlayerState.PLAYING ? 'play' : 'pause';
            socket.emit(action, {
                room: room,
                time: player.getCurrentTime(),
                videoId: player.getVideoData().video_id,
                userInitiated: true
            });
        }

        if (event.data === YT.PlayerState.BUFFERING && !isSyncing) {
            showSyncStatus(true, "Buffering video...");
            
            clearTimeout(bufferingTimeout);
            bufferingTimeout = setTimeout(() => {
                if (player.getPlayerState() === YT.PlayerState.BUFFERING) {
                    socket.emit('request-video-state', {room});
                }
            }, 5000);
        }
    }

    // Room creation handler
    document.getElementById('create-room').addEventListener('click', () => {
        room = document.getElementById('room-name').value.trim();
        const password = document.getElementById('room-password')?.value;
        
        if (!room) {
            return updateStatus('Please enter a room name.', true);
        }
        
        updateStatus('Creating room...');
        socket.emit('create-room', { room, password });
    });

    // Room joining handler
    document.getElementById('join-room').addEventListener('click', () => {
        room = document.getElementById('room-name').value.trim();
        const password = document.getElementById('room-password')?.value || '';
        
        if (!room) {
            return updateStatus('Please enter a room name.', true);
        }
        
        updateStatus('Joining room...');
        socket.emit('join-room', { room, password });
    });

    // Video loading handler
    document.getElementById('load-video').addEventListener('click', () => {
        if (!room) {
            return alert('Please join a room first.');
        }
        const url = document.getElementById('video-url').value;
        const videoId = extractVideoId(url);
        if (!videoId) {
            return alert('Invalid YouTube URL.');
        }
        if (!playerReady) {
            return alert('Player not ready. Please wait a moment.');
        }
        
        player.loadVideoById(videoId);
        socket.emit('load-video', { room, videoId });
    });

    // Play button handler
    document.getElementById('play').addEventListener('click', () => {
        if (!room || !playerReady || !canSendCommand()) return;
        
        socket.emit('play', {
            room: room,
            time: player.getCurrentTime(),
            videoId: player.getVideoData().video_id
        });
    });

    // Pause button handler
    document.getElementById('pause').addEventListener('click', () => {
        if (!room || !playerReady || !canSendCommand()) return;
        
        socket.emit('pause', {
            room: room,
            time: player.getCurrentTime(),
            videoId: player.getVideoData().video_id
        });
    });

    // Extract YouTube video ID from URL
    function extractVideoId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    // Room created handler
    socket.on('room-created', (data) => {
        document.getElementById('room-selection').style.display = 'none';
        document.getElementById('video-container').style.display = 'block';
        const protectedText = data.isProtected ? ' 🔒' : '';
        document.getElementById('room-info').textContent = `Room: ${room}${protectedText} (${data.users} users)`;
        updateStatus(`Room ${room} created`);
    });

    // Room joined handler
    socket.on('room-joined', (data) => {
        document.getElementById('room-selection').style.display = 'none';
        document.getElementById('video-container').style.display = 'block';
        usersInRoom = data.users;
        const protectedText = data.isProtected ? ' 🔒' : '';
        document.getElementById('room-info').textContent = `Room: ${room}${protectedText} (${data.users} users)`;
        updateStatus(`Joined room ${room}`);
        
        socket.emit('request-video-state', { room });
    });

    // User count update handler
    socket.on('user-count-update', (data) => {
        if (data.room === room) {
            usersInRoom = data.count;
            const roomInfoElement = document.getElementById('room-info');
            const protectedText = roomInfoElement.textContent.includes('🔒') ? ' 🔒' : '';
            roomInfoElement.textContent = `Room: ${room}${protectedText} (${usersInRoom} users)`;
        }
    });

    // Error handler
    socket.on('error', (message) => {
        updateStatus(message, true);
        
        if (message.includes('does not exist') || 
            message.includes('already exists') || 
            message.includes('password')) {
            document.getElementById('room-selection').style.display = 'block';
            document.getElementById('video-container').style.display = 'none';
            room = null;
        }
    });

    // Adaptive sync delay based on network conditions
    function getAdaptiveSyncDelay() {
        return Math.max(1000, Math.min(3000, networkLatency * 4));
    }

    // Play command handler
    socket.on('play', (data) => {
        if (!playerReady) return;
        
        isSyncing = true;
        showSyncStatus(true);
        
        const serverTimeElapsed = (Date.now() - data.serverTime) / 1000;
        const adjustedTime = data.time + serverTimeElapsed;
        
        player.seekTo(adjustedTime, true);
        player.playVideo();
        
        setTimeout(() => { 
            isSyncing = false; 
            showSyncStatus(false);
        }, getAdaptiveSyncDelay());
    });

    // Pause command handler
    socket.on('pause', (data) => {
        if (!playerReady) return;
        
        isSyncing = true;
        player.seekTo(data.time, true);
        player.pauseVideo();
        setTimeout(() => { isSyncing = false; }, 1000);
    });

    // Load video handler
    socket.on('load-video', (data) => {
        if (playerReady) {
            isSyncing = true;
            showSyncStatus(true);
            player.loadVideoById(data.videoId);
            setTimeout(() => { 
                isSyncing = false; 
                showSyncStatus(false);
            }, 1000);
        }
    });

    // Resynchronization handler
    socket.on('resync', (data) => {
        if (playerReady && !isSyncing) {
            isSyncing = true;
            showSyncStatus(true);
            player.seekTo(data.time, true);
            updateStatus('Re-synchronizing video...');
            setTimeout(() => { 
                isSyncing = false; 
                showSyncStatus(false);
            }, Math.max(1000, networkLatency * 2));
        }
    });
    
    // Video state update handler
    socket.on('video-state-update', (state) => {
        if (!playerReady) return;
        
        isSyncing = true;
        showSyncStatus(true);
        
        if (state.videoId) {
            player.loadVideoById(state.videoId);
            
            setTimeout(() => {
                const elapsedSecs = (Date.now() - state.serverTime) / 1000;
                const currentTime = state.action === 'play' 
                    ? state.clientTime + (elapsedSecs * (state.rate || 1))
                    : state.clientTime;
                
                player.seekTo(currentTime, true);
                
                if (state.action === 'play') {
                    player.playVideo();
                } else {
                    player.pauseVideo();
                }
                
                setTimeout(() => { 
                    isSyncing = false;
                    showSyncStatus(false);
                }, 1000);
            }, 500);
        } else {
            isSyncing = false;
            showSyncStatus(false);
        }
    });

    // Connection status handlers
    socket.on('disconnect', () => {
        updateStatus('Connection lost. Attempting to reconnect...', true);
    });

    socket.on('connect', () => {
        updateStatus('Connected to server');
        
        if (room) {
            updateStatus('Reconnected! Rejoining room...');
            socket.emit('join-room', { room, password: document.getElementById('room-password')?.value || '' });
            socket.emit('request-video-state', {room});
        }
    });

    // Periodic sync check
    function checkSyncStatus() {
        if (room && playerReady && !isSyncing && player.getPlayerState() === YT.PlayerState.PLAYING) {
            socket.emit('sync-check', {
                room: room,
                time: player.getCurrentTime(),
                state: player.getPlayerState(),
                latency: networkLatency
            });
        }
    }
    setInterval(checkSyncStatus, 5000); 

    // Seek slider handlers
    document.getElementById('seek-slider').addEventListener('input', (e) => {
        if (!playerReady || !player.getDuration()) return;
        const seekTime = (player.getDuration() * e.target.value) / 100;
        player.seekTo(seekTime, true);
    });

    document.getElementById('seek-slider').addEventListener('change', (e) => {
        if (!playerReady || !player.getDuration() || !room) return;
        
        const seekTime = (player.getDuration() * e.target.value) / 100;
        const currentState = player.getPlayerState();
        
        if (currentState === YT.PlayerState.PLAYING || currentState === YT.PlayerState.BUFFERING) {
            socket.emit('play', { room, time: seekTime, videoId: player.getVideoData().video_id });
        } else {
            socket.emit('pause', { room, time: seekTime, videoId: player.getVideoData().video_id });
        }
    });

    socket.on('connect_error', (error) => {
        updateStatus('Connection error: ' + error.message, true);
    });
});