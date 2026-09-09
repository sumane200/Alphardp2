const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'vps_database.json');

app.use(cors());
app.use(express.json());

// API Key Middleware for security (since it's public on Railway)
const authenticate = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!process.env.API_SECRET) {
        return next(); // Skip if no secret configured
    }
    if (apiKey === process.env.API_SECRET) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized. Invalid API Key.' });
    }
};

// Helper: Run command
const runCmd = (cmd, envVars = {}) => {
    return new Promise((resolve, reject) => {
        exec(cmd, { env: { ...process.env, ...envVars } }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Command error: ${stderr}`);
                return reject({ error, stderr });
            }
            resolve(stdout);
        });
    });
};

// Helper: Read DB
const readDB = () => {
    if (!fs.existsSync(DB_PATH)) return [];
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
};

// GET: List all VPS servers
app.get('/api/vps/list', authenticate, (req, res) => {
    try {
        const data = readDB();
        // Don't send the full token to frontend for security
        const safeData = data.map(vps => ({
            id: vps.id,
            name: vps.name,
            codespaceName: vps.codespaceName
        }));
        res.json(safeData);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read database' });
    }
});

// GET: Check specific server status
app.get('/api/vps/status/:id', authenticate, async (req, res) => {
    try {
        const data = readDB();
        const vps = data.find(v => v.id === req.params.id);
        if (!vps) return res.status(404).json({ error: 'VPS not found' });

        const stdout = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.token}` });
        const list = JSON.parse(stdout);
        const cs = list.find(c => c.name === vps.codespaceName);
        
        if (cs) {
            res.json({ status: cs.state });
        } else {
            res.json({ status: 'Unknown' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// POST: Start/Stop server
app.post('/api/vps/action', authenticate, async (req, res) => {
    const { id, action } = req.body;
    try {
        const data = readDB();
        const vps = data.find(v => v.id === id);
        if (!vps) return res.status(404).json({ error: 'VPS not found' });

        if (action === 'start') {
            await runCmd(`gh cs code -c "${vps.codespaceName}" --web`, { GH_TOKEN: `ghp_${vps.token}` });
            res.json({ success: true, message: 'Starting VPS...' });
        } else if (action === 'stop') {
            await runCmd(`gh cs stop -c "${vps.codespaceName}"`, { GH_TOKEN: `ghp_${vps.token}` });
            res.json({ success: true, message: 'Stopping VPS...' });
        } else {
            res.status(400).json({ error: 'Invalid action' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Action failed' });
    }
});

// GET: Stream VPS Setup Logs (SSE)
app.get('/api/vps/setup/stream/:id', authenticate, async (req, res) => {
    try {
        const data = readDB();
        const vps = data.find(v => v.id === req.params.id);
        if (!vps) {
            return res.status(404).json({ error: 'VPS not found' });
        }

        // Set up Server-Sent Events headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Initial connection message
        res.write('data: [SYSTEM] SSE Connection Established.\n\n');
        res.write('data: [SYSTEM] Sending wake-up signal to Codespace...\n\n');
        
        // Wake up codespace first
        exec(`gh cs code -c "${vps.codespaceName}" --web`, { 
            env: { ...process.env, GH_TOKEN: `ghp_${vps.token}` } 
        });

        // Poll until the codespace is Available
        let isReady = false;
        let retryCount = 0;
        
        while (!isReady && retryCount < 20) { // max 100 seconds
            try {
                const stdout = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.token}` });
                const list = JSON.parse(stdout);
                const cs = list.find(c => c.name === vps.codespaceName);
                
                if (cs && cs.state === 'Available') {
                    isReady = true;
                    res.write(`data: [SYSTEM] Codespace is ONLINE! Initiating remote SSH build...\n\n`);
                    break;
                } else {
                    res.write(`data: [SYSTEM] Waiting for Codespace to boot... (Current state: ${cs ? cs.state : 'Unknown'})\n\n`);
                    await new Promise(r => setTimeout(r, 5000));
                    retryCount++;
                }
            } catch (err) {
                res.write(`data: [ERROR] Failed to check status: ${err.message}\n\n`);
                await new Promise(r => setTimeout(r, 5000));
                retryCount++;
            }
        }

        if (!isReady) {
            res.write(`data: [ERROR] Codespace took too long to start. Aborting.\n\n`);
            return res.end();
        }

        // The actual installation command
        const cmd = `gh cs ssh -c "${vps.codespaceName}" -- "cd /tmp && wget -q https://raw.githubusercontent.com/sumane200/Alphardp/main/vps.sh && chmod +x vps.sh && ./vps.sh"`;
        res.write(`data: [SYSTEM] Executing remote build script...\n\n`);

        const child = spawn(cmd, {
            shell: true,
            env: { ...process.env, GH_TOKEN: `ghp_${vps.token}` }
        });

        child.stdout.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    res.write(`data: ${line}\n\n`);
                }
            });
        });

        child.stderr.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    res.write(`data: [ERROR] ${line}\n\n`);
                }
            });
        });

        child.on('close', (code) => {
            res.write(`data: [SYSTEM] Process exited with code ${code}\n\n`);
            res.end();
        });

        // Handle client disconnect
        req.on('close', () => {
            child.kill();
        });

    } catch (e) {
        res.write(`data: [SYSTEM] Stream error: ${e.message}\n\n`);
        res.end();
    }
});

// GET: Get Pinggy Tunnel URL
app.get('/api/vps/tunnel/:id', authenticate, async (req, res) => {
    try {
        const data = readDB();
        const vps = data.find(v => v.id === req.params.id);
        if (!vps) return res.status(404).json({ error: 'VPS not found' });

        // We use gh cs ssh to run a command remotely that fetches the log
        const cmd = `gh cs ssh -c "${vps.codespaceName}" -- "grep -m 1 -o 'tcp://[^ ]*' /tmp/vps-pinggy.log 2>/dev/null"`;
        const stdout = await runCmd(cmd, { GH_TOKEN: `ghp_${vps.token}` });
        
        const url = stdout.trim();
        if (url) {
            res.json({ url: url.replace('tcp://', '') });
        } else {
            res.json({ error: 'Tunnel not ready yet. Please wait a moment.' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch tunnel URL' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
