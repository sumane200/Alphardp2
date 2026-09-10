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
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespaceName}/start`, { GH_TOKEN: `ghp_${vps.token}` });
            res.json({ success: true, message: 'Starting VPS...' });
        } else if (action === 'stop') {
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespaceName}/stop`, { GH_TOKEN: `ghp_${vps.token}` });
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

        // Fire start API call (non-blocking)
        exec(`gh api -X POST /user/codespaces/${vps.codespaceName}/start`, {
            env: { ...process.env, GH_TOKEN: `ghp_${vps.token}` }
        });

        // Poll via gh cs list until state is Available (max 24 x 5s = 120s)
        res.write('data: [SYSTEM] Waiting for Codespace to boot...\n\n');
        let sshOk = false;
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const listOut = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.token}` });
                const list = JSON.parse(listOut);
                const cs = list.find(c => c.name === vps.codespaceName);
                const state = cs ? cs.state : 'Unknown';
                res.write(`data: [SYSTEM] Codespace state: ${state}\n\n`);

                if (state === 'Available') {
                    // Quick SSH test
                    try {
                        const test = await runCmd(`gh cs ssh -c "${vps.codespaceName}" -- "echo CONNECTION_OK"`, { GH_TOKEN: `ghp_${vps.token}` });
                        if (test.includes('CONNECTION_OK')) {
                            sshOk = true;
                            res.write('data: [SYSTEM] SSH connection established! Starting build...\n\n');
                            break;
                        }
                    } catch (sshErr) {
                        res.write('data: [SYSTEM] SSH not ready yet, retrying...\n\n');
                    }
                } else if (state === 'Shutdown' || state === 'Suspended') {
                    // Re-send start signal if it didn't take
                    exec(`gh api -X POST /user/codespaces/${vps.codespaceName}/start`, {
                        env: { ...process.env, GH_TOKEN: `ghp_${vps.token}` }
                    });
                }
            } catch (pollErr) {
                res.write(`data: [SYSTEM] Polling error: ${pollErr.message}\n\n`);
            }
        }

        if (!sshOk) {
            res.write('data: [ERROR] Could not establish SSH connection after 2 minutes. Aborting.\n\n');
            return res.end();
        }

        // Step 1: Restart xrdp (exactly like the bat file)
        res.write('data: [SYSTEM] Starting xrdp service...\n\n');
        try {
            await runCmd(`gh cs ssh -c "${vps.codespaceName}" -- "sudo service xrdp restart > /dev/null 2>&1; sleep 2; sudo service xrdp start > /dev/null 2>&1 || true"`, { GH_TOKEN: `ghp_${vps.token}` });
            res.write('data: [SYSTEM] xrdp is running!\n\n');
        } catch (e) {
            res.write('data: [SYSTEM] xrdp start attempted (may already be running).\n\n');
        }

        // Step 2: Launch Pinggy reverse tunnel using EXACT bat file two-step approach
        // Step 1 of 2: Write the tunnel command to a script file on the remote
        res.write('data: [SYSTEM] Preparing Pinggy tunnel...\n\n');
        await runCmd(
            `gh cs ssh -c "${vps.codespaceName}" -- "echo 'pkill -f pinggy 2>/dev/null; rm -f /tmp/vps-pinggy.log; setsid ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:localhost:3389 tcp@a.pinggy.io >/tmp/vps-pinggy.log 2>&1 </dev/null & sleep 2' > /tmp/start_tunnel.sh"`,
            { GH_TOKEN: `ghp_${vps.token}` }
        );

        // Step 2 of 2: Execute the script (exactly like the bat file)
        res.write('data: [SYSTEM] Launching Pinggy tunnel...\n\n');
        await runCmd(
            `gh cs ssh -c "${vps.codespaceName}" -- "bash /tmp/start_tunnel.sh"`,
            { GH_TOKEN: `ghp_${vps.token}` }
        );

        res.write('data: [SYSTEM] ✓ VPS is ACTIVE! Click [ GET RDP ] to get your connection address.\n\n');
        res.end();

        // Handle client disconnect (no spawned child anymore)
        req.on('close', () => {});

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
