const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());
app.use(express.json());

const authenticate = async (req, res, next) => {
    let token = req.headers['authorization']?.replace('Bearer ', '');
    // Fallback for SSE connections which pass token in query
    if (!token && req.query.api_key) {
        token = req.query.api_key;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized. No token provided.' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized. Invalid token.' });
    }

    req.user = user;
    next();
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

// Helper: Fetch all VPS for any authenticated user
const getVPSList = async () => {
    const { data, error } = await supabase.from('vps_instances').select('*').order('name');
    if (error) throw error;
    return data;
};

// Helper: Fetch single VPS for any authenticated user
const getVPSById = async (id) => {
    const { data, error } = await supabase.from('vps_instances').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
};

// GET: List all VPS servers
app.get('/api/vps/list', authenticate, async (req, res) => {
    try {
        const data = await getVPSList();
        // Don't send the full token to frontend for security
        const safeData = data.map(vps => ({
            id: vps.id,
            name: vps.name,
            codespaceName: vps.codespace_name,
            ram_gb: vps.ram_gb,
            cpu_cores: vps.cpu_cores,
            os: vps.os,
            status: vps.status,
            rdp_username: vps.rdp_username,
            rdp_password: vps.rdp_password
        }));
        res.json(safeData);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to read database' });
    }
});

// GET: Check specific server status
app.get('/api/vps/status/:id', authenticate, async (req, res) => {
    try {
        let vps;
        try {
            vps = await getVPSById(req.params.id);
        } catch(e) {
            return res.status(404).json({ error: 'VPS not found' });
        }

        // Skip if token is still a placeholder
        if (!vps.github_token || vps.github_token === 'YOUR_TOKEN_WITHOUT_GHP_PREFIX') {
            return res.json({ status: 'Unconfigured' });
        }

        const stdout = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.github_token}` });
        const list = JSON.parse(stdout);
        const cs = list.find(c => c.name === vps.codespace_name);
        
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
        let vps;
        try {
            vps = await getVPSById(id);
        } catch(e) {
            return res.status(404).json({ error: 'VPS not found' });
        }

        if (action === 'start') {
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespace_name}/start`, { GH_TOKEN: `ghp_${vps.github_token}` });
            res.json({ success: true, message: 'Starting VPS...' });
        } else if (action === 'stop') {
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespace_name}/stop`, { GH_TOKEN: `ghp_${vps.github_token}` });
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
        let vps;
        try {
            vps = await getVPSById(req.params.id);
        } catch(e) {
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
        exec(`gh api -X POST /user/codespaces/${vps.codespace_name}/start`, {
            env: { ...process.env, GH_TOKEN: `ghp_${vps.github_token}` }
        });

        // Poll via gh cs list until state is Available (max 24 x 5s = 120s)
        res.write('data: [SYSTEM] Waiting for Codespace to boot...\n\n');
        let sshOk = false;
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const listOut = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.github_token}` });
                const list = JSON.parse(listOut);
                const cs = list.find(c => c.name === vps.codespace_name);
                const state = cs ? cs.state : 'Unknown';
                res.write(`data: [SYSTEM] Codespace state: ${state}\n\n`);

                if (state === 'Available') {
                    // Quick SSH test
                    try {
                        const test = await runCmd(`gh cs ssh -c "${vps.codespace_name}" -- "echo CONNECTION_OK"`, { GH_TOKEN: `ghp_${vps.github_token}` });
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
                    exec(`gh api -X POST /user/codespaces/${vps.codespace_name}/start`, {
                        env: { ...process.env, GH_TOKEN: `ghp_${vps.github_token}` }
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
            await runCmd(`gh cs ssh -c "${vps.codespace_name}" -- "sudo service xrdp restart > /dev/null 2>&1; sleep 2; sudo service xrdp start > /dev/null 2>&1 || true"`, { GH_TOKEN: `ghp_${vps.github_token}` });
            res.write('data: [SYSTEM] xrdp is running!\n\n');
        } catch (e) {
            res.write('data: [SYSTEM] xrdp start attempted (may already be running).\n\n');
        }

        // Step 2: Launch Pinggy reverse tunnel using EXACT bat file two-step approach
        // Step 1 of 2: Write the tunnel command to a script file on the remote
        res.write('data: [SYSTEM] Preparing Pinggy tunnel...\n\n');
        await runCmd(
            `gh cs ssh -c "${vps.codespace_name}" -- "echo 'pkill -f pinggy 2>/dev/null; rm -f /tmp/vps-pinggy.log; setsid ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:localhost:3389 tcp@a.pinggy.io >/tmp/vps-pinggy.log 2>&1 </dev/null & sleep 2' > /tmp/start_tunnel.sh"`,
            { GH_TOKEN: `ghp_${vps.github_token}` }
        );

        // Step 2 of 2: Execute the script (exactly like the bat file)
        res.write('data: [SYSTEM] Launching Pinggy tunnel...\n\n');
        await runCmd(
            `gh cs ssh -c "${vps.codespace_name}" -- "bash /tmp/start_tunnel.sh"`,
            { GH_TOKEN: `ghp_${vps.github_token}` }
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
        let vps;
        try {
            vps = await getVPSById(req.params.id);
        } catch(e) {
            return res.status(404).json({ error: 'VPS not found' });
        }

        // We use gh cs ssh to run a command remotely that fetches the log
        const cmd = `gh cs ssh -c "${vps.codespace_name}" -- "grep -m 1 -o 'tcp://[^ ]*' /tmp/vps-pinggy.log 2>/dev/null"`;
        const stdout = await runCmd(cmd, { GH_TOKEN: `ghp_${vps.github_token}` });
        
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
