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

const isAdmin = (user) => {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    return user && user.email && adminEmails.includes(user.email.toLowerCase());
};

const adminOnly = (req, res, next) => {
    if (!isAdmin(req.user)) {
        return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }
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
        let data = await getVPSList();
        
        // Filter out hidden servers for non-admins
        if (!isAdmin(req.user)) {
            data = data.filter(vps => !vps.name.startsWith('[HIDDEN] '));
        }
        
        // Free tier restriction
        if (req.user.is_anonymous) {
            data = data.slice(0, 2);
        }

        // Don't send the full token to frontend for security
        const safeData = data.map(vps => {
            const isLockedByOther = vps.user_id && vps.user_id !== req.user.id;
            return {
                id: vps.id,
                name: vps.name,
                codespaceName: vps.codespace_name,
                ram_gb: vps.ram_gb,
                cpu_cores: vps.cpu_cores,
                os: vps.os,
                status: vps.status,
                rdp_username: vps.rdp_username,
                rdp_password: isLockedByOther ? '*** (Locked by another user)' : vps.rdp_password,
                locked_by_other: isLockedByOther,
                locked_by_me: vps.user_id === req.user.id,
                locked_at: vps.locked_at
            };
        });
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

        // Admin override for Maintenance
        if (vps.status === 'Maintenance') {
            return res.json({ status: 'Maintenance' });
        }

        // Skip if token is still a placeholder
        if (!vps.github_token || vps.github_token === 'YOUR_TOKEN_WITHOUT_GHP_PREFIX') {
            return res.json({ status: 'Unconfigured' });
        }

        const stdout = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.github_token}` });
        const list = JSON.parse(stdout);
        const cs = list.find(c => c.name === vps.codespace_name);
        
        if (cs) {
            // Auto-unlock logic if server is genuinely suspended/shutdown
            if ((cs.state === 'Suspended' || cs.state === 'Shutdown') && vps.user_id) {
                // Check if grace period is over (59 minutes)
                if (vps.locked_at) {
                    const lockTime = new Date(vps.locked_at).getTime();
                    const now = Date.now();
                    const diffMins = (now - lockTime) / 60000;
                    if (diffMins >= 59) {
                        await supabase.from('vps_instances').update({ user_id: null, locked_at: null }).eq('id', vps.id);
                    }
                } else {
                    // No locked_at but suspended? Just release.
                    await supabase.from('vps_instances').update({ user_id: null, locked_at: null }).eq('id', vps.id);
                }
            }
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
            if (vps.user_id && vps.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Server is locked by another user' });
            }
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespace_name}/start`, { GH_TOKEN: `ghp_${vps.github_token}` });
            await supabase.from('vps_instances').update({ user_id: req.user.id, locked_at: new Date().toISOString() }).eq('id', vps.id);
            res.json({ success: true, message: 'Starting VPS...' });
        } else if (action === 'stop') {
            if (vps.user_id && vps.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Server is locked by another user' });
            }
            await runCmd(`gh api -X POST /user/codespaces/${vps.codespace_name}/stop`, { GH_TOKEN: `ghp_${vps.github_token}` });
            // Release lock immediately on manual stop
            await supabase.from('vps_instances').update({ user_id: null, locked_at: null }).eq('id', vps.id);
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

        const cfToken = req.query.cf_token;
        if (!cfToken) {
            res.write('data: [ERROR] Human verification missing.\n\n');
            return res.end();
        }

        // Verify Turnstile Token
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: process.env.TURNSTILE_SECRET_KEY,
                response: cfToken
            })
        });
        
        const outcome = await verifyRes.json();
        if (!outcome.success) {
            res.write('data: [ERROR] Human verification failed.\n\n');
            return res.end();
        }

        // Check if locked by someone else
        if (vps.user_id && vps.user_id !== req.user.id) {
            res.write('data: [ERROR] Server is currently in use by someone else. Please try another server.\n\n');
            return res.end();
        }

        // Lock the server
        await supabase.from('vps_instances').update({ 
            user_id: req.user.id, 
            locked_at: new Date().toISOString() 
        }).eq('id', vps.id);

        // Initial connection message
        res.write('data: [SYSTEM] SSE Connection Established.\n\n');
        res.write('data: [SYSTEM] Sending wake-up signal to Server Instance...\n\n');

        // Fire start API call (non-blocking)
        exec(`gh api -X POST /user/codespaces/${vps.codespace_name}/start`, {
            env: { ...process.env, GH_TOKEN: `ghp_${vps.github_token}` }
        });

        // Poll via gh cs list until state is Available (max 24 x 5s = 120s)
        res.write('data: [SYSTEM] Waiting for Server Instance to boot...\n\n');
        let sshOk = false;
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
                const listOut = await runCmd(`gh cs list --json name,state`, { GH_TOKEN: `ghp_${vps.github_token}` });
                const list = JSON.parse(listOut);
                const cs = list.find(c => c.name === vps.codespace_name);
                const state = cs ? cs.state : 'Unknown';
                res.write(`data: [SYSTEM] Server state: ${state}\n\n`);

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

        // Cleanup previous session data
        res.write('data: [SYSTEM] Cleaning up previous session data (Downloads, Browser History)...\n\n');
        try {
            const cleanupCmd = `rm -rf ~/Downloads/* ~/.cache/google-chrome ~/.config/google-chrome/Default/History ~/.config/google-chrome/Default/Sessions ~/.cache/mozilla ~/.mozilla/firefox/*.default-release/places.sqlite ~/.local/share/Trash/files/* /tmp/firefox* /tmp/chrome*`;
            await runCmd(`gh cs ssh -c "${vps.codespace_name}" -- "${cleanupCmd}"`, { GH_TOKEN: `ghp_${vps.github_token}` });
            res.write('data: [SYSTEM] Cleanup completed.\n\n');
        } catch (e) {
            res.write('data: [SYSTEM] Cleanup completed (or no previous data found).\n\n');
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

        if (vps.user_id && vps.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Access Denied: Server is locked by another user' });
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



// ==========================================
// ADMIN ROUTES
// ==========================================

// GET: All VPSs (including tokens for admin management)
app.get('/api/admin/vps/list', authenticate, adminOnly, async (req, res) => {
    try {
        const data = await getVPSList();
        res.json(data); // Send full data to admin
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch VPS list' });
    }
});

// POST: Add new VPS
app.post('/api/admin/vps', authenticate, adminOnly, async (req, res) => {
    try {
        const { name, codespace_name, github_token, ram_gb, cpu_cores, os, rdp_username, rdp_password } = req.body;
        const { data, error } = await supabase.from('vps_instances').insert([
            { name, codespace_name, github_token, ram_gb, cpu_cores, os, rdp_username, rdp_password, status: 'Shutdown' }
        ]).select().single();

        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to add VPS' });
    }
});

// DELETE: Remove VPS
app.delete('/api/admin/vps/:id', authenticate, adminOnly, async (req, res) => {
    try {
        const { error } = await supabase.from('vps_instances').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete VPS' });
    }
});

// PUT: Update VPS Status (Maintenance override)
app.put('/api/admin/vps/:id/status', authenticate, adminOnly, async (req, res) => {
    try {
        const { status } = req.body; // 'Maintenance' or 'Shutdown'
        const { data, error } = await supabase.from('vps_instances')
            .update({ status, user_id: null, locked_at: null }) // Unlocks if put in maintenance
            .eq('id', req.params.id)
            .select().single();

        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to update VPS status' });
    }
});

// PUT: Update VPS Visibility (Hide/Unhide)
app.put('/api/admin/vps/:id/visibility', authenticate, adminOnly, async (req, res) => {
    try {
        const vps = await getVPSById(req.params.id);
        const isHidden = vps.name.startsWith('[HIDDEN] ');
        let newName = vps.name;

        if (isHidden) {
            // Unhide
            newName = newName.replace('[HIDDEN] ', '');
        } else {
            // Hide
            newName = '[HIDDEN] ' + newName;
        }

        const { data, error } = await supabase.from('vps_instances')
            .update({ name: newName })
            .eq('id', req.params.id)
            .select().single();

        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to update VPS visibility' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    
    // Start Heartbeat monitor
    setInterval(async () => {
        try {
            const { data: servers, error } = await supabase.from('vps_instances').select('*').not('locked_at', 'is', null);
            if (error) return;

            const now = Date.now();
            for (const vps of servers) {
                const lockTime = new Date(vps.locked_at).getTime();
                const diffMins = (now - lockTime) / 60000;

                // Rule B: Fully release lock after 59 minutes
                if (diffMins >= 59) {
                    await supabase.from('vps_instances').update({ user_id: null, locked_at: null }).eq('id', vps.id);
                    console.log(`[Heartbeat] Released lock for VPS ${vps.id} (59 min grace period expired)`);
                } 
                // Rule A: Force stop server after 57 minutes (to prevent Pinggy drop), keep lock for grace period
                else if (diffMins >= 57 && diffMins < 58) {
                    // We only want to trigger this once, so we check if it's right around 57 minutes
                    try {
                        await runCmd(`gh api -X POST /user/codespaces/${vps.codespace_name}/stop`, { GH_TOKEN: `ghp_${vps.github_token}` });
                        console.log(`[Heartbeat] Auto-stopped VPS ${vps.id} (57 min limit reached)`);
                    } catch (e) {
                        // ignore errors, maybe it's already stopped
                    }
                }
            }
        } catch (e) {
            console.error('[Heartbeat] Error checking locks:', e);
        }
    }, 60000); // Check every 60 seconds
});
