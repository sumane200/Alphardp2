import { useState, useEffect } from 'react';

export default function ServerCard({ server, apiUrl, apiKey }) {
  const [status, setStatus] = useState('Checking...');
  const [loadingAction, setLoadingAction] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [tunnelLoading, setTunnelLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/vps/status/${server.id}`, {
        headers: { 'x-api-key': apiKey }
      });
      const data = await res.json();
      setStatus(data.status || 'Unknown');
    } catch (err) {
      setStatus('Error');
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (action) => {
    setLoadingAction(true);
    try {
      const res = await fetch(`${apiUrl}/api/vps/action`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-api-key': apiKey 
        },
        body: JSON.stringify({ id: server.id, action })
      });
      await res.json();
      setStatus(action === 'start' ? 'Starting...' : 'Shutting down...');
      setTimeout(fetchStatus, 5000);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingAction(false);
    }
  };

  const getTunnel = async () => {
    setTunnelLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/vps/tunnel/${server.id}`, {
        headers: { 'x-api-key': apiKey }
      });
      const data = await res.json();
      if (data.url) {
        setTunnelUrl(data.url);
      } else if (data.error) {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setTunnelLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(tunnelUrl);
    alert('Copied RDP Address to clipboard!');
  };

  const getStatusColor = () => {
    if (status === 'Available') return 'bg-neon-green shadow-[0_0_10px_#39ff14]';
    if (status === 'Shutdown') return 'bg-neon-red shadow-[0_0_10px_#ff003c]';
    return 'bg-yellow-400 shadow-[0_0_10px_#facc15] animate-pulse';
  };

  return (
    <div className="glass-panel p-6 rounded-xl border border-cyber-border transition-all duration-300 neon-border-hover relative overflow-hidden group">
      {/* Decorative lines */}
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-neon-blue/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
      
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">{server.name}</h2>
          <div className="text-xs font-mono text-gray-400 bg-black/40 px-2 py-1 rounded inline-block border border-gray-800">
            {server.codespaceName}
          </div>
        </div>
        <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded-full border border-gray-800">
          <div className={`w-3 h-3 rounded-full ${getStatusColor()}`}></div>
          <span className="text-xs font-mono text-gray-300 uppercase">{status}</span>
        </div>
      </div>

      <div className="flex flex-col gap-3 mt-6 border-t border-cyber-border/30 pt-6">
        {status === 'Shutdown' || status === 'Unknown' ? (
          <button 
            onClick={() => handleAction('start')}
            disabled={loadingAction}
            className="w-full bg-neon-blue/10 border border-neon-blue/50 hover:bg-neon-blue/20 hover:border-neon-blue text-neon-blue font-mono py-2 rounded transition-all cursor-pointer disabled:opacity-50"
          >
            [ WAKE_SERVER ]
          </button>
        ) : (
          <div className="flex gap-2">
            <button 
              onClick={getTunnel}
              disabled={tunnelLoading || status !== 'Available'}
              className="flex-1 bg-neon-green/10 border border-neon-green/50 hover:bg-neon-green/20 hover:border-neon-green text-neon-green font-mono py-2 rounded transition-all cursor-pointer disabled:opacity-50"
            >
              {tunnelLoading ? 'FETCHING...' : '[ GET_RDP ]'}
            </button>
            <button 
              onClick={() => handleAction('stop')}
              disabled={loadingAction}
              className="px-4 bg-neon-red/10 border border-neon-red/50 hover:bg-neon-red/20 hover:border-neon-red text-neon-red font-mono py-2 rounded transition-all cursor-pointer disabled:opacity-50"
            >
              STOP
            </button>
          </div>
        )}

        {tunnelUrl && (
          <div className="mt-3 bg-black/60 p-3 rounded border border-cyber-border/50 flex justify-between items-center group/url">
            <code className="text-sm text-neon-blue select-all">{tunnelUrl}</code>
            <button 
              onClick={copyToClipboard}
              className="text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Copy to clipboard"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
