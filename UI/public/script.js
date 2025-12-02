class FlashForgeFinder {
    constructor() {
        this.printerIP = '';
        this.isConnected = false;
        this.autoRefreshInterval = null;
        this.tempHistory = [];
        this.maxTempHistory = 50;
        this.cssVars = null;
        this.ws = null;
        this.wsConnected = false;
        this.wsReconnectTimer = null;
        
        this.initializeEventListeners();
        this.initializeTheme();
    }
    getCssVar(name) {
        if (!this.cssVars) {
            this.cssVars = getComputedStyle(document.documentElement);
        }
        return this.cssVars.getPropertyValue(name).trim();
    }

    refreshCssVars() {
        // Invalidate cached vars (used after theme change)
        this.cssVars = null;
    }


    initializeEventListeners() {
        // Connect button
        document.getElementById('connect-btn').addEventListener('click', () => {
            this.connectToPrinter();
        });

        // Refresh buttons
        document.querySelectorAll('.refresh-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const endpoint = e.target.closest('.refresh-btn').dataset.endpoint;
                this.refreshData(endpoint);
            });
        });

        // Auto-refresh controls
        document.getElementById('auto-refresh-checkbox').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        });

        document.getElementById('refresh-interval').addEventListener('change', () => {
            if (document.getElementById('auto-refresh-checkbox').checked) {
                this.stopAutoRefresh();
                this.startAutoRefresh();
            }
        });

        // Enter key on IP input
        document.getElementById('printer-ip').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.connectToPrinter();
            }
        });

        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                const current = this.getThemePreference();
                const next = current === 'dark' ? 'light' : 'dark';
                this.setThemePreference(next);
            });
        }

        // Control buttons
        document.getElementById('led-on-btn')?.addEventListener('click', () => this.sendControlCommand('led', { state: 'on' }));
        document.getElementById('led-off-btn')?.addEventListener('click', () => this.sendControlCommand('led', { state: 'off' }));
        document.getElementById('led-custom-btn')?.addEventListener('click', () => {
            const color = document.getElementById('led-color').value;
            const r = parseInt(color.substr(1, 2), 16);
            const g = parseInt(color.substr(3, 2), 16);
            const b = parseInt(color.substr(5, 2), 16);
            this.sendControlCommand('led', { r, g, b });
        });
        document.getElementById('pause-btn')?.addEventListener('click', () => this.sendControlCommand('pause'));
        document.getElementById('resume-btn')?.addEventListener('click', () => this.sendControlCommand('resume'));
        document.getElementById('cancel-btn')?.addEventListener('click', () => {
            if (confirm('Are you sure you want to cancel the current print?')) {
                this.sendControlCommand('cancel');
            }
        });
        document.getElementById('home-btn')?.addEventListener('click', () => this.sendControlCommand('home'));
    }

    // Theme handling
    initializeTheme() {
        const pref = this.getThemePreference();
        if (pref) {
            document.documentElement.setAttribute('data-theme', pref);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        this.updateThemeToggleIcon();
    }

    getThemePreference() {
        try {
            return localStorage.getItem('ff-theme') || null;
        } catch (_) {
            return null;
        }
    }

    setThemePreference(theme) {
        try {
            localStorage.setItem('ff-theme', theme);
        } catch (_) { /* ignore */ }
        document.documentElement.setAttribute('data-theme', theme);
        this.updateThemeToggleIcon();
        this.refreshCssVars();
        // Redraw chart with new colors
        this.updateTempChart();
    }

    updateThemeToggleIcon() {
        const themeToggle = document.getElementById('theme-toggle');
        if (!themeToggle) return;
        const pref = this.getThemePreference();
        const icon = themeToggle.querySelector('i');
        if (!icon) return;
        // If explicit dark -> show sun, else show moon
        if (pref === 'dark' || (!pref && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            icon.className = 'fas fa-sun';
            themeToggle.title = 'Switch to light mode';
        } else {
            icon.className = 'fas fa-moon';
            themeToggle.title = 'Switch to dark mode';
        }
    }

    // --- WebSocket (live updates) ---
    buildWsUrl(ip, intervalMs) {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.host; // includes port
        const params = new URLSearchParams();
        if (ip) params.set('ip', ip);
        if (intervalMs) params.set('interval', String(intervalMs));
        return `${proto}://${host}/ws?${params.toString()}`;
    }

    startWebSocket(ip) {
        // If already connected to this IP, do nothing
        const desiredInterval = this.getSelectedInterval();
        const url = this.buildWsUrl(ip, desiredInterval);
        try {
            this.stopWebSocket();
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.wsConnected = true;
                this.updateConnectionStatus();
                // Stop HTTP polling when WS is live
                this.stopAutoRefresh();
                // Announce
                console.log('WebSocket connected');
                this.showNotification('Live updates enabled via WebSocket', 'success');
            };

            this.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'snapshot' && msg.data) {
                        // Apply snapshot to UI
                        this.applySnapshot(msg.data);
                    } else if (msg.type === 'error') {
                        console.warn('WS error:', msg.error);
                    }
                } catch (e) {
                    console.warn('Invalid WS message', e);
                }
            };

            this.ws.onclose = () => {
                this.wsConnected = false;
                this.updateConnectionStatus();
                console.log('WebSocket disconnected');
                // Fall back to HTTP auto refresh if user enabled it
                if (document.getElementById('auto-refresh-checkbox').checked) {
                    this.startAutoRefresh();
                }
            };

            this.ws.onerror = () => {
                // Error will be followed by close
            };
        } catch (error) {
            console.log('Failed to start WebSocket:', error);
            this.ws = null;
            this.wsConnected = false;
        }
    }

    stopWebSocket() {
        if (this.ws) {
            try { this.ws.close(); } catch (_) { /* ignore */ }
        }
        this.ws = null;
        this.wsConnected = false;
    }

    wsSend(obj) {
        if (this.ws && this.wsConnected) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    applySnapshot(snapshot) {
        // snapshot: { info, headLocation, temperatures, progress, status, errors, timestamp }
        if (snapshot.info) this.updatePrinterInfo(snapshot.info);
        if (snapshot.temperatures) this.updateTemperature(snapshot.temperatures);
        if (snapshot.headLocation) this.updateHeadPosition(snapshot.headLocation);
        if (snapshot.progress) this.updateProgress(snapshot.progress);
        if (snapshot.status) this.updateStatus(snapshot.status);
    }

    async connectToPrinter() {
        const ipInput = document.getElementById('printer-ip');
        const connectBtn = document.getElementById('connect-btn');
        const loadingOverlay = document.getElementById('loading-overlay');
        
        this.printerIP = ipInput.value.trim();
        
        if (!this.printerIP) {
            this.showNotification('Please enter a printer IP address', 'error');
            return;
        }

        // Validate IP format (basic)
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        if (!ipRegex.test(this.printerIP)) {
            this.showNotification('Please enter a valid IP address', 'error');
            return;
        }

        loadingOverlay.style.display = 'flex';
        connectBtn.disabled = true;
        connectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';

        try {
            // Test connection by getting printer info (HTTP)
            const response = await fetch(`/${this.printerIP}/info`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }

            this.isConnected = true;
            this.updateConnectionStatus();
            this.showDashboard();
            this.loadAllData();
            // Start WebSocket live updates
            this.startWebSocket(this.printerIP);
            this.showNotification('Successfully connected to printer!', 'success');

        } catch (error) {
            console.error('Connection error:', error);
            this.isConnected = false;
            this.updateConnectionStatus();
            this.showNotification(`Failed to connect: ${error.message}`, 'error');
        } finally {
            loadingOverlay.style.display = 'none';
            connectBtn.disabled = false;
            connectBtn.innerHTML = '<i class="fas fa-plug"></i> Connect';
        }
    }

    updateConnectionStatus() {
        const statusElement = document.getElementById('connection-status');
        
        if (this.isConnected) {
            statusElement.className = 'connection-status connected';
            const mode = this.wsConnected ? 'Live' : 'Polling';
            statusElement.innerHTML = `<i class="fas fa-circle"></i> Connected to ${this.printerIP} <span style="font-weight:600;color:#6b7280;">(${mode})</span>`;
        } else {
            statusElement.className = 'connection-status disconnected';
            statusElement.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
        }
    }

    showDashboard() {
        document.getElementById('dashboard').style.display = 'grid';
    }

    async loadAllData() {
        const endpoints = ['info', 'temp', 'head-location', 'progress', 'status'];
        
        for (const endpoint of endpoints) {
            await this.refreshData(endpoint);
        }
    }

    async refreshData(endpoint) {
        if (!this.isConnected) return;

        const btn = document.querySelector(`[data-endpoint="${endpoint}"]`);
        if (btn) {
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }

        // If WebSocket is live, request a one-off snapshot and rely on onmessage to update UI
        if (this.wsConnected) {
            this.wsSend({ type: 'snapshot', ip: this.printerIP });
            // revert icon shortly, UI will update on snapshot
            setTimeout(() => { if (btn) btn.innerHTML = '<i class="fas fa-refresh"></i>'; }, 500);
            return;
        }

        // Fallback to HTTP
        try {
            const response = await fetch(`/${this.printerIP}/${endpoint}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            this.updateUI(endpoint, data);
        } catch (error) {
            console.error(`Error refreshing ${endpoint}:`, error);
            this.showNotification(`Failed to refresh ${endpoint}: ${error.message}`, 'error');
        } finally {
            if (btn) btn.innerHTML = '<i class="fas fa-refresh"></i>';
        }
    }

    updateUI(endpoint, data) {
        switch (endpoint) {
            case 'info':
                this.updatePrinterInfo(data);
                break;
            case 'temp':
                this.updateTemperature(data);
                break;
            case 'head-location':
                this.updateHeadPosition(data);
                break;
            case 'progress':
                this.updateProgress(data);
                break;
            case 'status':
                this.updateStatus(data);
                break;
        }
    }

    updatePrinterInfo(data) {
        document.getElementById('printer-type').textContent = data.Type || '-';
        document.getElementById('printer-name').textContent = data.Name || '-';
        document.getElementById('printer-firmware').textContent = data.Firmware || '-';
        document.getElementById('printer-sn').textContent = data.SN || '-';
        const macEl = document.getElementById('printer-mac');
        if (macEl) macEl.textContent = data['Mac Address'] || '-';
        const bvEl = document.getElementById('printer-build-volume');
        if (bvEl) {
            const x = data.BuildVolumeX, y = data.BuildVolumeY, z = data.BuildVolumeZ;
            bvEl.textContent = (x && y && z) ? `${x} × ${y} × ${z}` : '-';
        }
    }

    updateTemperature(data) {
        const currentTemp = parseFloat(data.Temperature) || 0;
        const targetTemp = parseFloat(data.TargetTemperature) || 0;
        
        document.getElementById('current-temp').textContent = `${currentTemp}°C`;
        document.getElementById('target-temp').textContent = `${targetTemp}°C`;
        // Bed temps (optional)
        const bedCurEl = document.getElementById('bed-current-temp');
        const bedTgtEl = document.getElementById('bed-target-temp');
        if (bedCurEl && bedTgtEl) {
            const bedCur = data.BedTemperature != null ? parseFloat(data.BedTemperature) : null;
            const bedTgt = data.BedTargetTemperature != null ? parseFloat(data.BedTargetTemperature) : null;
            bedCurEl.textContent = (bedCur != null && !Number.isNaN(bedCur)) ? `${bedCur}°C` : '0°C';
            bedTgtEl.textContent = (bedTgt != null && !Number.isNaN(bedTgt)) ? `${bedTgt}°C` : '0°C';
        }
        
        // Add to temperature history for chart
        this.tempHistory.push({
            time: new Date(),
            current: currentTemp,
            target: targetTemp
        });
        
        if (this.tempHistory.length > this.maxTempHistory) {
            this.tempHistory.shift();
        }
        
        this.updateTempChart();
    }

    updateTempChart() {
        const canvas = document.getElementById('temp-chart');
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        if (this.tempHistory.length < 2) return;
        
        // Find min/max temps for scaling
        const allTemps = this.tempHistory.flatMap(h => [h.current, h.target]);
        const minTemp = Math.min(...allTemps) - 5;
        const maxTemp = Math.max(...allTemps) + 5;
        
        const scaleY = (temp) => height - ((temp - minTemp) / (maxTemp - minTemp)) * height;
        const scaleX = (index) => (index / (this.tempHistory.length - 1)) * width;
        
        // Resolve theme-aware colors
        const currentColor = this.getCssVar('--primary') || '#3b82f6';
        const targetColor = this.getCssVar('--progress') || '#22c55e';

        // Draw current temperature line
        ctx.beginPath();
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = 2;
        this.tempHistory.forEach((point, index) => {
            const x = scaleX(index);
            const y = scaleY(point.current);
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
        
        // Draw target temperature line
        ctx.beginPath();
        ctx.strokeStyle = targetColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        this.tempHistory.forEach((point, index) => {
            const x = scaleX(index);
            const y = scaleY(point.target);
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
        ctx.setLineDash([]);
    }

    updateHeadPosition(data) {
        document.getElementById('pos-x').textContent = parseFloat(data.X || 0).toFixed(2);
        document.getElementById('pos-y').textContent = parseFloat(data.Y || 0).toFixed(2);
        document.getElementById('pos-z').textContent = parseFloat(data.Z || 0).toFixed(2);
    }

    updateProgress(data) {
        const percentage = data.PercentageCompleted || 0;
        const printed = data.BytesPrinted || 0;
        const total = data.BytesTotal || 0;
        
        document.getElementById('progress-fill').style.width = `${percentage}%`;
        document.getElementById('progress-percentage').textContent = `${percentage}%`;
        document.getElementById('progress-bytes').textContent = `${this.formatBytes(printed)} / ${this.formatBytes(total)} bytes`;
        const layersEl = document.getElementById('progress-layers');
        if (layersEl) {
            const lc = data.LayerCurrent;
            const lt = data.LayerTotal;
            layersEl.textContent = (lc != null && lt != null) ? `${lc} / ${lt}` : '- / -';
        }
    }

    updateStatus(data) {
        const statusValue = document.getElementById('printer-status-value');
        const status = data.Status || '-';
        
        statusValue.textContent = status;
        
        // Update status badge color based on status
        statusValue.className = 'value status-badge';
        if (status.toLowerCase().includes('ready')) {
            statusValue.classList.add('ready');
        } else if (status.toLowerCase().includes('busy') || status.toLowerCase().includes('printing')) {
            statusValue.classList.add('busy');
        } else if (status.toLowerCase().includes('error')) {
            statusValue.classList.add('error');
        }
        
        document.getElementById('machine-status').textContent = data.MachineStatus || '-';
        document.getElementById('move-mode').textContent = data.MoveMode || '-';
        document.getElementById('endstop-status').textContent = data.Endstop || '-';
        const fileEl = document.getElementById('current-file');
        if (fileEl) fileEl.textContent = data.CurrentFile || '-';
        const ledEl = document.getElementById('led-state');
        if (ledEl) ledEl.textContent = (data.LED != null ? String(data.LED) : '-')
    }

    startAutoRefresh() {
        const interval = this.getSelectedInterval();

        // If WebSocket is connected, adjust subscription interval instead of HTTP polling
        if (this.wsConnected) {
            this.wsSend({ type: 'subscribe', ip: this.printerIP, intervalMs: interval });
            return;
        }

        this.autoRefreshInterval = setInterval(() => {
            if (this.isConnected) this.loadAllData();
        }, interval);
    }

    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    }

    getSelectedInterval() {
        return parseInt(document.getElementById('refresh-interval').value, 10) || 10000;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    async sendControlCommand(command, body = {}) {
        if (!this.isConnected) {
            this.showNotification('Please connect to a printer first', 'error');
            return;
        }

        const btn = document.querySelector(`#${command}-btn, #led-on-btn, #led-off-btn, #led-custom-btn`);
        const originalContent = btn?.innerHTML;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }

        try {
            const response = await fetch(`/${this.printerIP}/${command}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            const commandNames = {
                'led': 'LED',
                'pause': 'Pause',
                'resume': 'Resume',
                'cancel': 'Cancel',
                'home': 'Home'
            };
            this.showNotification(`${commandNames[command] || command} command sent successfully`, 'success');

            // Refresh status after control command
            setTimeout(() => this.refreshData('status'), 500);

        } catch (error) {
            console.error(`Control command ${command} failed:`, error);
            this.showNotification(`Failed to send ${command}: ${error.message}`, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalContent;
            }
        }
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <i class="fas ${this.getNotificationIcon(type)}"></i>
            <span>${message}</span>
        `;
        
        // Style the notification
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '15px 20px',
            borderRadius: '8px',
            color: 'white',
            fontWeight: '600',
            zIndex: '10000',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minWidth: '300px',
            boxShadow: '0 8px 16px rgba(0,0,0,0.12)',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s ease'
        });
        
        // Set background color based on type
        switch (type) {
            case 'success':
                notification.style.background = '#16a34a';
                break;
            case 'error':
                notification.style.background = '#dc2626';
                break;
            default:
                notification.style.background = '#2563eb';
        }
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 100);
        
        // Remove after 4 seconds
        setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 4000);
    }

    getNotificationIcon(type) {
        switch (type) {
            case 'success':
                return 'fa-check-circle';
            case 'error':
                return 'fa-exclamation-circle';
            default:
                return 'fa-info-circle';
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.flashForgeFinder = new FlashForgeFinder();
    // Clean up WS on unload
    window.addEventListener('beforeunload', () => {
        if (window.flashForgeFinder) {
            window.flashForgeFinder.stopWebSocket();
        }
    });
});