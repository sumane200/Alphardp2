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

const authenticate = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
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

        // Skip if token is still a placeholder
        if (!vps.token || vps.token === 'YOUR_TOKEN_WITHOUT_GHP_PREFIX') {
            return res.json({ status: 'Unconfigured' });
        }

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
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespaceName}/starts`, { GH_TOKEN: `ghp_${vps.token}` });
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
        res.write('data: [SYSTEM] Starting Codespace (this may take 30-60 seconds)...\n\n');
        
        // Use "gh cs start" - exactly like the .bat file does it.
        // This command blocks until the codespace is fully running and then exits.
        try {
            await runCmd(`gh cs start -c "${vps.codespaceName}"`, { GH_TOKEN: `ghp_${vps.token}` });
            res.write('data: [SYSTEM] Codespace started successfully!\n\n');
        } catch (startErr) {
            // gh cs start returns an error if it's already running - that's fine, continue anyway
            res.write('data: [SYSTEM] Codespace may already be running. Continuing...\n\n');
        }

        // Test SSH connectivity first (like the bat file does)
        res.write('data: [SYSTEM] Testing SSH connection...\n\n');
        let sshOk = false;
        for (let i = 0; i < 15; i++) {
            try {
                const test = await runCmd(`gh cs ssh -c "${vps.codespaceName}" -- "echo CONNECTION_OK"`, { GH_TOKEN: `ghp_${vps.token}` });
                if (test.includes('CONNECTION_OK')) {
                    sshOk = true;
                    res.write('data: [SYSTEM] SSH connection established!\n\n');
                    break;
                }
            } catch (e) {
                // keep trying
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!sshOk) {
            res.write('data: [ERROR] Could not establish SSH connection. Codespace may not be reachable.\n\n');
            return res.end();
        }

        // The actual installation command - same approach as the bat file
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
