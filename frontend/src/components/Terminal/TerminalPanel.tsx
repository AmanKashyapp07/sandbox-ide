import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { 
  TerminalSquare, 
  WifiOff, 
  Loader2, 
  Terminal as TerminalIcon, 
  Trash2, 
  RefreshCw 
} from 'lucide-react';

interface TerminalPanelProps {
  workspaceId: string;
}

export default function TerminalPanel({ workspaceId }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [reconnectCounter, setReconnectCounter] = useState(0);

  // Trigger a manual reconnect by updating the counter dependency
  const handleReconnect = useCallback(() => {
    setConnectionStatus('connecting');
    setError(null);
    setReconnectCounter(prev => prev + 1);
  }, []);

  // Clear the terminal output
  const handleClear = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      rows: 30,
      cols: 80,
      theme: {
        background: 'transparent',  // Let the container background show through
        foreground: '#d4d4d8',      // zinc-300
        cursor: '#a855f7',          // violet-500
        cursorAccent: '#08070d',
        selectionBackground: 'rgba(168, 85, 247, 0.3)', // Violet with opacity
        black: '#18181b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#d4d4d8',
      },
      scrollback: 5000, // Increased for better history retention
      convertEol: true
    });

    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = terminal;

    const initFitTimeout = setTimeout(() => {
      if (xtermRef.current && fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    }, 100);

    const handleWindowResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };
    window.addEventListener('resize', handleWindowResize);

    // WebSocket Initialization
    const token = localStorage.getItem('token') || '';
    const forceNew = sessionStorage.getItem('resetTerminal') === 'true';
    if (forceNew) {
      sessionStorage.removeItem('resetTerminal');
    }
    
    const wsUrl = `ws://localhost:4000/terminal/${workspaceId}?token=${token}${forceNew ? '&forceNew=true' : ''}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setConnectionStatus('connected');
      setError(null);
    };

    ws.onmessage = (event) => {
      if (terminal && !terminal.element) return;
      const data = new Uint8Array(event.data);
      terminal.write(data);
    };

    ws.onerror = () => {
      setError('Connection error');
      setConnectionStatus('disconnected');
    };

    ws.onclose = (event) => {
      setConnectionStatus('disconnected');
      if (event.code === 4403) {
        setError('Access denied: Editor role required');
      } else if (event.code === 4404) {
        setError('Workspace not found');
      } else if (event.code === 1000) {
        terminal.write('\r\n\x1b[38;2;168;85;247m[Terminal session ended cleanly]\x1b[0m\r\n');
      } else {
        setError('Connection closed unexpectedly');
      }
    };

    const disposable = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    return () => {
      disposable.dispose();
      clearTimeout(initFitTimeout);
      window.removeEventListener('resize', handleWindowResize);
      
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [workspaceId, reconnectCounter]); // Re-run effect on manual reconnect

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#08070d] text-zinc-300 ring-1 ring-white/5">
      
      {/* Terminal Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-[#0c0a14] px-4 py-2">
        <div className="flex items-center gap-3">
          <TerminalIcon size={16} className="text-violet-400" />
          <span className="font-mono text-xs font-semibold tracking-wider text-zinc-300">
            BASH
          </span>
          
          {/* Status Dot */}
          <div className="flex items-center gap-1.5 ml-2 rounded-full bg-black/40 px-2 py-0.5 border border-white/5">
            <span className={`h-2 w-2 rounded-full ${
              connectionStatus === 'connected' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' :
              connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 
              'bg-red-500'
            }`} />
            <span className="text-[10px] uppercase tracking-widest text-zinc-400">
              {connectionStatus}
            </span>
          </div>
        </div>

        {/* Toolbar Actions */}
        <div className="flex items-center gap-1">
          <button 
            onClick={handleClear}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            title="Clear Terminal"
          >
            <Trash2 size={16} />
          </button>
          <button 
            onClick={handleReconnect}
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
            title="Reconnect Session: Restarts the socket connection (retains active container and files)"
          >
            <RefreshCw size={16} className={connectionStatus === 'connecting' ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Connection Status Overlay */}
      {connectionStatus !== 'connected' && (
        <div className="absolute inset-x-0 bottom-0 top-10 z-10 flex flex-col items-center justify-center gap-4 bg-[#08070d]/80 backdrop-blur-sm transition-all duration-300">
          {connectionStatus === 'connecting' && (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="animate-spin text-violet-500" />
              <span className="font-sans text-sm font-medium tracking-wide text-violet-200/80">
                Initializing container...
              </span>
            </div>
          )}
          {connectionStatus === 'disconnected' && (
            <div className="flex flex-col items-center gap-4 p-6 rounded-xl border border-white/5 bg-black/40 shadow-2xl">
              <div className="rounded-full bg-red-500/10 p-3">
                {error ? <WifiOff size={28} className="text-red-400" /> : <TerminalSquare size={28} className="text-zinc-500" />}
              </div>
              <div className="text-center space-y-1">
                <h3 className="font-sans text-base font-semibold text-zinc-200">
                  {error ? 'Connection Failed' : 'Session Terminated'}
                </h3>
                <p className="font-sans text-sm text-zinc-400 max-w-xs">
                  {error || 'Your terminal session has safely concluded.'}
                </p>
              </div>
              <button 
                onClick={handleReconnect}
                className="mt-2 flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-violet-500 active:scale-95"
              >
                <RefreshCw size={14} />
                Reconnect Now
              </button>
            </div>
          )}
        </div>
      )}

      {/* Terminal Container - added custom scrollbar styling class */}
      <div 
        ref={terminalRef} 
        className="flex-1 overflow-hidden p-3 pb-0 [&_.xterm-viewport]:scrollbar-thin [&_.xterm-viewport]:scrollbar-track-transparent [&_.xterm-viewport]:scrollbar-thumb-white/10 [&_.xterm-viewport]:hover:scrollbar-thumb-white/20" 
      />
    </div>
  );
}