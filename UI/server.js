const express = require('express');
const cors = require('cors');
const net = require('net');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const PRINTER_PORT = 8899;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// We'll attach a WebSocket server to the same HTTP server instance below

// Protocol messages (same as Python version)
const PROTOCOL_MESSAGES = {
    CONTROL: '~M601 S1\r\n',
    INFO: '~M115\r\n',
    HEAD_POSITION: '~M114\r\n',
    TEMP: '~M105\r\n',
    PROGRESS: '~M27\r\n',
    STATUS: '~M119\r\n',
    // Control commands
    LED_ON: '~M146 r255 g255 b255\r\n',
    LED_OFF: '~M146 r0 g0 b0\r\n',
    PAUSE: '~M25\r\n',
    RESUME: '~M24\r\n',
    CANCEL: '~M26\r\n',
    HOME: '~G28\r\n',
};

// Regex patterns (converted and extended)
const REGEX_PATTERNS = {
    field: (fieldName) => new RegExp(`${fieldName}: ?(.+?)\\r?\\n`),
    coordinates: (fieldName) => new RegExp(`${fieldName}:\s*([^\s]+)`),
    // Info/build volume within M115
    buildVolume: () => /X:\s*([\-\d.]+)\s+Y:\s*([\-\d.]+)\s+Z:\s*([\-\d.]+)/,
    macAddress: () => /Mac Address:\s*([0-9A-Fa-f:]+)/,
    // Temperatures from M105
    t0: () => /T0:([\-\d.]+)\/([\-\d.]+)/,
    t1: () => /T1:([\-\d.]+)\/([\-\d.]+)/,
    bed: () => /B:([\-\d.]+)\/([\-\d.]+)/,
    // Progress from M27
    progressBytes: () => /SD printing byte\s+(\d+)\/(\d+)/,
    progressLayers: () => /Layer:\s+(\d+)\/(\d+)/,
    // Status M119 extras
    led: () => /LED:\s*(\d+)/,
    currentFile: () => /CurrentFile:\s*(.+)\r?/,
    statusFlags: () => /Status:\s*([^\r\n]+)/,
};

// Helper function to send and receive data from printer
function sendAndReceive(ip, message) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.setTimeout(5000);

        client.connect(PRINTER_PORT, ip, () => {
            client.write(message);
        });

        client.on('data', (data) => {
            client.destroy();
            // console.log(data.toString());
            resolve(data.toString());
        });

        client.on('timeout', () => {
            client.destroy();
            reject(new Error('Connection timeout'));
        });

        client.on('error', (err) => {
            reject(err);
        });
    });
}

// Fetch a full snapshot for a given printer IP
async function fetchSnapshot(ip) {
    const errors = [];
    // Always unlock/control first
    try {
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
    } catch (e) {
        errors.push({ step: 'CONTROL', error: e.message });
    }

    let info = {};
    try {
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.INFO);
        // Map actual field names from device to UI-friendly keys
        const mappings = [
            { key: 'Type', src: 'Machine Type' },
            { key: 'Name', src: 'Machine Name' },
            { key: 'Firmware', src: 'Firmware' },
            { key: 'SN', src: 'SN' },
            { key: 'Tool Count', src: 'Tool Count' },
        ];
        for (const { key, src } of mappings) {
            const match = infoResult.match(REGEX_PATTERNS.field(src));
            if (match) info[key] = match[1];
        }
        const mac = infoResult.match(REGEX_PATTERNS.macAddress());
        if (mac) info['Mac Address'] = mac[1];
        const vol = infoResult.match(REGEX_PATTERNS.buildVolume());
        if (vol) {
            info['BuildVolumeX'] = vol[1];
            info['BuildVolumeY'] = vol[2];
            info['BuildVolumeZ'] = vol[3];
        }
    } catch (e) {
        errors.push({ step: 'INFO', error: e.message });
    }

    let headLocation = {};
    try {
        const headRes = await sendAndReceive(ip, PROTOCOL_MESSAGES.HEAD_POSITION);
        for (const field of ['X', 'Y', 'Z']) {
            const match = headRes.match(REGEX_PATTERNS.coordinates(field));
            if (match) headLocation[field] = match[1];
        }
    } catch (e) {
        errors.push({ step: 'HEAD_POSITION', error: e.message });
    }

    let temperatures = { Temperature: null, TargetTemperature: null };
    try {
        const tempRes = await sendAndReceive(ip, PROTOCOL_MESSAGES.TEMP);
        const t0 = tempRes.match(REGEX_PATTERNS.t0());
        const t1 = tempRes.match(REGEX_PATTERNS.t1());
        const bed = tempRes.match(REGEX_PATTERNS.bed());
        temperatures = {
            Temperature: t0 ? t0[1] : null,
            TargetTemperature: t0 ? t0[2] : null,
            T1Temperature: t1 ? t1[1] : null,
            T1TargetTemperature: t1 ? t1[2] : null,
            BedTemperature: bed ? bed[1] : null,
            BedTargetTemperature: bed ? bed[2] : null,
        };
    } catch (e) {
        errors.push({ step: 'TEMP', error: e.message });
    }

    let progress = { BytesPrinted: 0, BytesTotal: 0, PercentageCompleted: 0 };
    try {
        const progRes = await sendAndReceive(ip, PROTOCOL_MESSAGES.PROGRESS);
        const bytes = progRes.match(REGEX_PATTERNS.progressBytes());
        const layers = progRes.match(REGEX_PATTERNS.progressLayers());
        if (bytes) {
            const printed = parseInt(bytes[1]);
            const total = parseInt(bytes[2]);
            const percentage = total === 0 ? 0 : Math.floor((printed / total) * 100);
            progress = { BytesPrinted: printed, BytesTotal: total, PercentageCompleted: percentage };
        }
        if (layers) {
            progress.LayerCurrent = parseInt(layers[1]);
            progress.LayerTotal = parseInt(layers[2]);
            // If we didn't compute percentage from bytes, compute from layers
            if (progress.PercentageCompleted === 0 && progress.LayerTotal) {
                progress.PercentageCompleted = Math.floor((progress.LayerCurrent / progress.LayerTotal) * 100);
            }
        }
    } catch (e) {
        errors.push({ step: 'PROGRESS', error: e.message });
    }

    let status = {};
    try {
        const statusRes = await sendAndReceive(ip, PROTOCOL_MESSAGES.STATUS);
        for (const field of ['Status', 'MachineStatus', 'MoveMode', 'Endstop']) {
            const match = statusRes.match(REGEX_PATTERNS.field(field));
            if (match) status[field] = match[1];
        }
        const led = statusRes.match(REGEX_PATTERNS.led());
        if (led) status['LED'] = led[1];
        const cf = statusRes.match(REGEX_PATTERNS.currentFile());
        if (cf) status['CurrentFile'] = cf[1];
        const sf = statusRes.match(REGEX_PATTERNS.statusFlags());
        if (sf) status['StatusFlags'] = sf[1];
    } catch (e) {
        errors.push({ step: 'STATUS', error: e.message });
    }

    return {
        info,
        headLocation,
        temperatures,
        progress,
        status,
        errors,
        timestamp: new Date().toISOString(),
    };
}

// WebSocket subscription hub by printer IP
const subscriptions = new Map(); // ip -> { clients: Set<WebSocket>, timer: NodeJS.Timer, intervalMs: number }

function ensurePolling(ip, intervalMs = 2000) {
    const existing = subscriptions.get(ip);
    if (existing) {
        // If requested interval is shorter, tighten polling a bit
        if (intervalMs < existing.intervalMs) {
            clearInterval(existing.timer);
            existing.intervalMs = intervalMs;
            existing.timer = setInterval(async () => {
                try {
                    const data = await fetchSnapshot(ip);
                    for (const ws of existing.clients) {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: 'snapshot', ip, data }));
                        }
                    }
                } catch (e) {
                    for (const ws of existing.clients) {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: 'error', ip, error: e.message }));
                        }
                    }
                }
            }, existing.intervalMs);
        }
        return existing;
    }

    const entry = { clients: new Set(), intervalMs, timer: null };
    entry.timer = setInterval(async () => {
        try {
            const data = await fetchSnapshot(ip);
            for (const ws of entry.clients) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'snapshot', ip, data }));
                }
            }
        } catch (e) {
            for (const ws of entry.clients) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', ip, error: e.message }));
                }
            }
        }
    }, intervalMs);

    subscriptions.set(ip, entry);
    return entry;
}

function cleanupSubscription(ip) {
    const entry = subscriptions.get(ip);
    if (!entry) return;
    if (entry.clients.size === 0) {
        clearInterval(entry.timer);
        subscriptions.delete(ip);
    }
}

// API Routes
app.get('/:ip/info', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.INFO);
        
        const printerInfo = {};
        const mappings = [
            { key: 'Type', src: 'Machine Type' },
            { key: 'Name', src: 'Machine Name' },
            { key: 'Firmware', src: 'Firmware' },
            { key: 'SN', src: 'SN' },
            { key: 'Tool Count', src: 'Tool Count' },
        ];
        for (const { key, src } of mappings) {
            const match = infoResult.match(REGEX_PATTERNS.field(src));
            if (match) printerInfo[key] = match[1];
        }
        const mac = infoResult.match(REGEX_PATTERNS.macAddress());
        if (mac) printerInfo['Mac Address'] = mac[1];
        const vol = infoResult.match(REGEX_PATTERNS.buildVolume());
        if (vol) {
            printerInfo['BuildVolumeX'] = vol[1];
            printerInfo['BuildVolumeY'] = vol[2];
            printerInfo['BuildVolumeZ'] = vol[3];
        }
        
        res.json(printerInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/:ip/head-location', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.HEAD_POSITION);
        
        const printerInfo = {};
        const fields = ['X', 'Y', 'Z'];
        
        for (const field of fields) {
            const match = infoResult.match(REGEX_PATTERNS.coordinates(field));
            if (match) {
                printerInfo[field] = match[1];
            }
        }
        
        res.json(printerInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/:ip/temp', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.TEMP);
        const t0 = infoResult.match(REGEX_PATTERNS.t0());
        const t1 = infoResult.match(REGEX_PATTERNS.t1());
        const bed = infoResult.match(REGEX_PATTERNS.bed());
        res.json({
            Temperature: t0 ? t0[1] : null,
            TargetTemperature: t0 ? t0[2] : null,
            T1Temperature: t1 ? t1[1] : null,
            T1TargetTemperature: t1 ? t1[2] : null,
            BedTemperature: bed ? bed[1] : null,
            BedTargetTemperature: bed ? bed[2] : null,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/:ip/progress', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.PROGRESS);
        console.log(infoResult);
        const bytes = infoResult.match(REGEX_PATTERNS.progressBytes());
        const layers = infoResult.match(REGEX_PATTERNS.progressLayers());
        let printed = 0, total = 0, percentage = 0, layerCurrent = null, layerTotal = null;
        if (bytes) {
            printed = parseInt(bytes[1]);
            total = parseInt(bytes[2]);
            percentage = total === 0 ? 0 : Math.floor((printed / total) * 100);
        }
        if (layers) {
            layerCurrent = parseInt(layers[1]);
            layerTotal = parseInt(layers[2]);
            if (!percentage && layerTotal) {
                percentage = Math.floor((layerCurrent / layerTotal) * 100);
            }
        }
        res.json({
            BytesPrinted: printed,
            BytesTotal: total,
            PercentageCompleted: percentage,
            LayerCurrent: layerCurrent,
            LayerTotal: layerTotal,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/:ip/status', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const infoResult = await sendAndReceive(ip, PROTOCOL_MESSAGES.STATUS);
        console.log(infoResult);
        const printerInfo = {};
        const fields = ['Status', 'MachineStatus', 'MoveMode', 'Endstop'];
        for (const field of fields) {
            const match = infoResult.match(REGEX_PATTERNS.field(field));
            if (match) printerInfo[field] = match[1];
        }
        const led = infoResult.match(REGEX_PATTERNS.led());
        if (led) printerInfo['LED'] = led[1];
        const cf = infoResult.match(REGEX_PATTERNS.currentFile());
        if (cf) printerInfo['CurrentFile'] = cf[1];
        const sf = infoResult.match(REGEX_PATTERNS.statusFlags());
        if (sf) printerInfo['StatusFlags'] = sf[1];
        res.json(printerInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Control endpoints
app.post('/:ip/led', async (req, res) => {
    try {
        const { ip } = req.params;
        const { state, r, g, b } = req.body;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        
        let command;
        if (state === 'off') {
            command = PROTOCOL_MESSAGES.LED_OFF;
        } else if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
            // Custom RGB values (0-255)
            command = `~M146 r${Math.min(255, Math.max(0, r))} g${Math.min(255, Math.max(0, g))} b${Math.min(255, Math.max(0, b))}\r\n`;
        } else {
            command = PROTOCOL_MESSAGES.LED_ON;
        }
        
        const result = await sendAndReceive(ip, command);
        res.json({ success: true, response: result.trim() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/:ip/pause', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const result = await sendAndReceive(ip, PROTOCOL_MESSAGES.PAUSE);
        res.json({ success: true, response: result.trim() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/:ip/resume', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const result = await sendAndReceive(ip, PROTOCOL_MESSAGES.RESUME);
        res.json({ success: true, response: result.trim() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/:ip/cancel', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const result = await sendAndReceive(ip, PROTOCOL_MESSAGES.CANCEL);
        res.json({ success: true, response: result.trim() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/:ip/home', async (req, res) => {
    try {
        const { ip } = req.params;
        
        await sendAndReceive(ip, PROTOCOL_MESSAGES.CONTROL);
        const result = await sendAndReceive(ip, PROTOCOL_MESSAGES.HOME);
        res.json({ success: true, response: result.trim() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create HTTP server and bind WebSocket server to it
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
    console.log('WS client connected');

    // Parse query params for immediate subscription: /ws?ip=192.168.0.50&interval=2000
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const ip = url.searchParams.get('ip');
        const interval = parseInt(url.searchParams.get('interval') || '2000', 10);
        if (ip) {
            const entry = ensurePolling(ip, isNaN(interval) ? 2000 : Math.max(500, interval));
            entry.clients.add(ws);
            // Send an immediate snapshot on connect
            fetchSnapshot(ip)
                .then((data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'snapshot', ip, data })))
                .catch((e) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'error', ip, error: e.message })));
        }
    } catch (e) {
        // Ignore URL parse errors
    }

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'subscribe' && msg.ip) {
                const interval = typeof msg.intervalMs === 'number' ? Math.max(500, msg.intervalMs) : 2000;
                const entry = ensurePolling(msg.ip, interval);
                entry.clients.add(ws);
                ws.send(JSON.stringify({ type: 'subscribed', ip: msg.ip, intervalMs: entry.intervalMs }));
            } else if (msg.type === 'unsubscribe' && msg.ip) {
                const entry = subscriptions.get(msg.ip);
                if (entry) {
                    entry.clients.delete(ws);
                    cleanupSubscription(msg.ip);
                }
                ws.send(JSON.stringify({ type: 'unsubscribed', ip: msg.ip }));
            } else if (msg.type === 'snapshot' && msg.ip) {
                // One-off snapshot request
                fetchSnapshot(msg.ip)
                    .then((data) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'snapshot', ip: msg.ip, data })))
                    .catch((e) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'error', ip: msg.ip, error: e.message })));
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid message format' }));
        }
    });

    ws.on('close', () => {
        // Remove ws from all subscriptions
        for (const [ip, entry] of subscriptions.entries()) {
            entry.clients.delete(ws);
            cleanupSubscription(ip);
        }
        console.log('WS client disconnected');
    });
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

httpServer.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`WebSocket endpoint available at ws://localhost:${PORT}/ws`);
});