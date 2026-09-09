import { useState, useEffect } from 'react'
import ServerCard from './components/ServerCard'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const API_KEY = import.meta.env.VITE_API_KEY || 'alpha-secret-key-123';

function App() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchServers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/vps/list`, {
        headers: { 'x-api-key': API_KEY }
      });
      if (!res.ok) throw new Error('Failed to fetch servers. Check API key.');
      const data = await res.json();
      setServers(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServers();
  }, []);

  return (
    <div className="min-h-screen p-6 md:p-12 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-neon-blue/10 rounded-full blur-[100px] pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-neon-purple/10 rounded-full blur-[100px] pointer-events-none"></div>

      <header className="mb-12 relative z-10 border-b border-cyber-border/50 pb-6 flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-white mb-2">
            ALPHA<span className="text-neon-blue neon-text-blue">RDP</span>
          </h1>
          <p className="text-gray-400 font-mono text-sm tracking-widest uppercase">Global Server Command Center</p>
        </div>
        <div className="flex gap-4">
          <div className="glass-panel px-4 py-2 rounded font-mono text-xs text-neon-green flex items-center gap-2 border-neon-green/30">
            <span className="w-2 h-2 rounded-full bg-neon-green animate-pulse"></span>
            SYSTEM ONLINE
          </div>
        </div>
      </header>

      <main className="relative z-10">
        {loading ? (
          <div className="text-center py-20 font-mono text-neon-blue animate-pulse">
            INITIALIZING NEURAL LINK...
          </div>
        ) : error ? (
          <div className="glass-panel border-neon-red/50 text-neon-red p-6 rounded font-mono">
            [ERROR] {error}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {servers.map((server) => (
              <ServerCard 
                key={server.id} 
                server={server} 
                apiUrl={API_URL} 
                apiKey={API_KEY} 
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
