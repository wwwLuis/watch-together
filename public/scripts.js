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
    let isSyncing = false; // New flag to avoid event loops
    let usersInRoom = 0;
    let networkLatency = 0;

    let lastCommandTime = 0;
    let lastReceivedSequence = 0;
    const COMMAND_DEBOUNCE_MS = 300; // Minimum time between commands

    function canSendCommand() {
        const now = Date.now();
        if (now - lastCommandTime < COMMAND_DEBOUNCE_MS) {
            console.log("Command debounced - too soon after previous command");
            return false;
        }
        lastCommandTime = now;
        return true;
    }

    // Status updates function
    function updateStatus(message, isError = false) {
        const statusElement = document.getElementById('status');
        statusElement.textContent = message;
        statusElement.className = isError ? 'text-danger' : 'text-success';
        setTimeout(() => { statusElement.textContent = ''; }, 3000);
    }

    // Add after your existing updateStatus function:
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

    // Call this on page load
    setTimeout(debugSocketStatus, 2000);

    // Add to scripts.js functions
    function showSyncStatus(isSyncing) {
        const syncIndicator = document.createElement('div');
        syncIndicator.id = 'sync-indicator';
        syncIndicator.textContent = '⟳ Synchronizing...';
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

    // Update timestamp display
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
                
                // Update slider position
                const sliderValue = (currentTime / duration) * 100;
                document.getElementById('seek-slider').value = sliderValue;
            }
        }
    }

    // Update timestamp every second
    setInterval(updateTimestamp, 1000);

    // Measure latency periodically
    function updateLatency() {
        const start = Date.now();
        socket.emit('ping', () => {
            networkLatency = (Date.now() - start) / 2; // RTT/2
            console.log(`Network latency: ${networkLatency}ms`);
        });
    }
    setInterval(updateLatency, 10000);

    // Load the IFrame Player API code asynchronously.
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/player_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = function() {
        console.log("YouTube IFrame API ist bereit");
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
                    console.log("Player is ready");
                    playerReady = true;
                },
                'onStateChange': onPlayerStateChange,
                'onError': (event) => {
                    console.error('YT Player initialisierungs fehler', event.data);   
                }
            }             
        });
        } catch (error) {
            console.error('YouTube Player Error:', error);
        }   
    };
    

    function onPlayerStateChange(event) {
        if (!room || !playerReady || isSyncing) return;
        if (!canSendCommand()) return;
        
        // Only emit for user-initiated state changes
        if (event.data === YT.PlayerState.PLAYING && player.getCurrentTime() < 0.5) {
            // Don't synchronize autoplay events at the start of videos
            return;
        }
        
        // For all other states
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
            // Show buffer state to user
            showSyncStatus(true, "Buffering video...");
            
            // If buffering takes too long, request a resync
            clearTimeout(bufferingTimeout);
            bufferingTimeout = setTimeout(() => {
                if (player.getPlayerState() === YT.PlayerState.BUFFERING) {
                    socket.emit('request-video-state', {room});
                }
            }, 5000);
        }
    }

    document.getElementById('create-room').addEventListener('click', () => {
        room = document.getElementById('room-name').value.trim();
        const password = document.getElementById('room-password')?.value;
        
        if (!room) {
            updateStatus('Bitte einen Raumnamen eingeben.', true);
            return;
        }
        
        updateStatus('Versuche Raum zu erstellen...', false);
        console.log(`Attempting to create room: ${room}`);
        socket.emit('create-room', { room, password });
    });

    document.getElementById('join-room').addEventListener('click', () => {
        room = document.getElementById('room-name').value.trim();
        const password = document.getElementById('room-password')?.value || '';
        
        if (!room) {
            updateStatus('Bitte einen Raumnamen eingeben.', true);
            return;
        }
        
        updateStatus('Versuche dem Raum beizutreten...', false);
        console.log(`Attempting to join room: ${room}`);
        socket.emit('join-room', { room, password });
    });

    
    document.getElementById('load-video').addEventListener('click', () => {
        if (!room) {
            alert('Bitte erst einem Raum beitreten.');
            return;
        }
        const url = document.getElementById('video-url').value;
        const videoId = extractVideoId(url);
        if (!videoId) {
            alert('Ungültige YouTube-URL. Bitte eine gültige Video-URL eingeben.');
            return;
        }
        if (!playerReady) {
            alert('Der Player ist noch nicht bereit. Bitte warten Sie einen Moment.');
            return;
        }
        player.loadVideoById(videoId);
        socket.emit('load-video', { room, videoId });
    });

    document.getElementById('play').addEventListener('click', () => {
        if (!room || !playerReady) return;
        if (!canSendCommand()) return; // Prevent rapid fire commands
        
        // Send play event to server first, don't play locally yet
        socket.emit('play', {
            room: room,
            time: player.getCurrentTime(),
            videoId: player.getVideoData().video_id
        });
    });

    document.getElementById('pause').addEventListener('click', () => {
        if (!room || !playerReady) return;
        if (!canSendCommand()) return; // Prevent rapid fire commands
        
        // Send pause event to server first, don't pause locally yet
        socket.emit('pause', {
            room: room,
            time: player.getCurrentTime(),
            videoId: player.getVideoData().video_id
        });
    });

    function extractVideoId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    socket.on('room-created', (data) => {
        document.getElementById('room-selection').style.display = 'none';
        document.getElementById('video-container').style.display = 'block';
        const protectedText = data.isProtected ? ' 🔒' : '';
        document.getElementById('room-info').textContent = `Raum: ${room}${protectedText} (${data.users} Nutzer)`;
        updateStatus(`Raum ${room} erstellt`, false);
    });

    socket.on('room-joined', (data) => {
        document.getElementById('room-selection').style.display = 'none';
        document.getElementById('video-container').style.display = 'block';
        usersInRoom = data.users; // Make sure to update the local user count
        const protectedText = data.isProtected ? ' 🔒' : '';
        document.getElementById('room-info').textContent = `Raum: ${room}${protectedText} (${data.users} Nutzer)`;
        updateStatus(`Raum ${room} beigetreten`, false);
        
        console.log(`Joined room ${room} with ${data.users}`);
        
        // Request current video state
        socket.emit('request-video-state', { room });
    });

    socket.on('user-count-update', (data) => {
        if (data.room === room) {
            console.log(`User count update for room ${room}: ${data.count} users`);
            usersInRoom = data.count;
            // Get the protection status if available
            const roomInfoElement = document.getElementById('room-info');
            const protectedText = roomInfoElement.textContent.includes('🔒') ? ' 🔒' : '';
            roomInfoElement.textContent = `Raum: ${room}${protectedText} (${usersInRoom} Nutzer)`;
        }
    });

    socket.on('error', (message) => {
        console.error(`Server error: ${message}`);
        updateStatus(message, true);
        
        // If there was an error joining, make sure the room selection stays visible
        if (message.includes('does not exist') || 
            message.includes('already exists') || 
            message.includes('password')) {
            document.getElementById('room-selection').style.display = 'block';
            document.getElementById('video-container').style.display = 'none';
            // Clear room variable since we're not in a room
            room = null;
        }
    });

    // Replace fixed timeouts with adaptive ones
    function getAdaptiveSyncDelay() {
        // Base on network latency, with reasonable min/max limits
        return Math.max(1000, Math.min(3000, networkLatency * 4));
    }

    socket.on('play', (data) => {
        if (!playerReady) return;
        
        console.log('Received play command:', data);
        isSyncing = true;
        showSyncStatus(true);
        
        // Account for network delay
        const serverTimeElapsed = (Date.now() - data.serverTime) / 1000;
        const adjustedTime = data.time + serverTimeElapsed;
        
        player.seekTo(adjustedTime, true);
        player.playVideo();
        
        setTimeout(() => { 
            isSyncing = false; 
            showSyncStatus(false);
        }, getAdaptiveSyncDelay());
    });

    socket.on('pause', (data) => {
        if (!playerReady) return;
        
        console.log('Received pause command:', data);
        isSyncing = true;
        player.seekTo(data.time, true);
        player.pauseVideo();
        setTimeout(() => { isSyncing = false; }, 1000);
    });

    socket.on('load-video', (data) => {
        if (playerReady) {
            isSyncing = true;
            showSyncStatus(isSyncing);
            player.loadVideoById(data.videoId);
            setTimeout(() => { 
                isSyncing = false; 
                showSyncStatus(isSyncing);
            }, 1000);
        }
    });

    socket.on('resync', (data) => {
        if (playerReady && !isSyncing) {
            isSyncing = true;
            showSyncStatus(isSyncing);
            player.seekTo(data.time, true);
            updateStatus('Re-synchronizing video...');
            setTimeout(() => { 
                isSyncing = false; 
                showSyncStatus(isSyncing);
            }, Math.max(1000, networkLatency * 2));
        }
    });
    
    socket.on('video-state-update', (state) => {
        if (!playerReady) {
            console.log("Player not ready to receive video state");
            return;
        }
        
        console.log(`Received video state update:`, state);
        isSyncing = true;
        showSyncStatus(true);
        
        if (state.videoId) {
            console.log(`Loading video ID: ${state.videoId}`);
            player.loadVideoById(state.videoId);
            
            // Short delay to ensure video loads before seeking
            setTimeout(() => {
                const elapsedSecs = (Date.now() - state.serverTime) / 1000;
                const currentTime = state.action === 'play' 
                    ? state.clientTime + (elapsedSecs * (state.rate || 1))
                    : state.clientTime;
                
                console.log(`Seeking to ${currentTime}s (elapsed: ${elapsedSecs}s)`);
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
            console.log("No videoId in state update");
            isSyncing = false;
            showSyncStatus(false);
        }
    });

    // Add to scripts.js
    socket.on('disconnect', () => {
        updateStatus('Connection lost. Attempting to reconnect...', true);
    });

    // In scripts.js - merge the two connect event handlers
    socket.on('connect', () => {
        console.log('Socket connected successfully', socket.id);
        updateStatus('Connected to server');
        
        if (room) {
            updateStatus('Reconnected! Rejoining room...');
            socket.emit('join-room', { room, password: document.getElementById('room-password')?.value || '' });
            socket.emit('request-video-state', {room});
        }
    });

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

    document.getElementById('seek-slider').addEventListener('input', (e) => {
        if (!playerReady || !player.getDuration()) return;
        const seekTime = (player.getDuration() * e.target.value) / 100;
        player.seekTo(seekTime, true);
    });

    // Preserve video state when seeking
    document.getElementById('seek-slider').addEventListener('change', (e) => {
        if (!playerReady || !player.getDuration() || !room) return;
        
        const seekTime = (player.getDuration() * e.target.value) / 100;
        const currentState = player.getPlayerState();
        
        // Use different commands based on current state
        if (currentState === YT.PlayerState.PLAYING || currentState === YT.PlayerState.BUFFERING) {
            socket.emit('play', { room, time: seekTime, videoId: player.getVideoData().video_id });
        } else {
            socket.emit('pause', { room, time: seekTime, videoId: player.getVideoData().video_id });
        }
    });

    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        updateStatus('Connection error: ' + error.message, true);
    });
});