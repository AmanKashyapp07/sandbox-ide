import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TerminalSquare, WifiOff, Loader2 } from 'lucide-react';

interface TerminalPanelProps {
  workspaceId: string;
}

export default function TerminalPanel({ workspaceId }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // -------------------------------------------------------------------------
    // Initialize xterm.js terminal instance with static dimensions
    // -------------------------------------------------------------------------
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      rows: 30, // Static rows
      cols: 80, // Static columns
      theme: {
        background: '#08070d',      // Match IDE dark background
        foreground: '#d4d4d8',      // zinc-300
        cursor: '#a855f7',          // violet-500
        cursorAccent: '#08070d',
        selectionBackground: '#a855f740',
        black: '#18181b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#d4d4d8',
        brightBlack: '#52525b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa'
      },
      scrollback: 1000,
      convertEol: true
    });

    terminal.open(terminalRef.current);

    xtermRef.current = terminal;



    // -------------------------------------------------------------------------
    // Open WebSocket connection to backend terminal handler
    // -------------------------------------------------------------------------
    const token = localStorage.getItem('token') || '';
    const wsUrl = `ws://localhost:4000/terminal/${workspaceId}?token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[Terminal] WebSocket connected');
      setConnectionStatus('connected');
      setError(null);
    };

    ws.onmessage = (event) => {
      if (terminal && !terminal.element) return; // Terminal destroyed

      // Convert ArrayBuffer to Uint8Array for xterm.js
      const data = new Uint8Array(event.data);
      terminal.write(data);
    };

    ws.onerror = (err) => {
      console.error('[Terminal] WebSocket error:', err);
      setError('Connection error');
      setConnectionStatus('disconnected');
    };

    ws.onclose = (event) => {
      console.log('[Terminal] WebSocket closed:', event.code, event.reason);
      setConnectionStatus('disconnected');
      
      if (event.code === 4403) {
        setError('Access denied: Editor role required');
      } else if (event.code === 4404) {
        setError('Workspace not found');
      } else if (event.code === 1000) {
        // Normal closure
        terminal.write('\r\n\x1b[33m[Terminal session ended]\x1b[0m\r\n');
      } else {
        setError('Connection closed unexpectedly');
      }
    };

    // -------------------------------------------------------------------------
    // Handle user input: keystrokes → WebSocket
    // -------------------------------------------------------------------------
    const disposable = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // -------------------------------------------------------------------------
    // Cleanup on unmount
    // -------------------------------------------------------------------------
    return () => {
      disposable.dispose();
      
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      
      terminal.dispose();
      xtermRef.current = null;
      wsRef.current = null;
    };
  }, [workspaceId]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08070d] text-zinc-300">
      {/* Connection Status Overlay */}
      {connectionStatus !== 'connected' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#08070d]/90 backdrop-blur-[2px]">
          {connectionStatus === 'connecting' && (
            <>
              <Loader2 size={36} className="animate-spin text-violet-400" />
              <span className="animate-pulse font-sans text-sm font-medium tracking-wide text-violet-300">
                Starting terminal session...
              </span>
            </>
          )}
          {connectionStatus === 'disconnected' && (
            <>
              {error ? (
                <>
                  <WifiOff size={36} className="text-red-400" />
                  <span className="font-sans text-sm font-medium text-red-300">{error}</span>
                </>
              ) : (
                <>
                  <TerminalSquare size={36} className="text-zinc-500" />
                  <span className="font-sans text-sm font-medium text-zinc-400">
                    Terminal disconnected
                  </span>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Terminal Container */}
      <div ref={terminalRef} className="flex-1 overflow-hidden p-2" />
    </div>
  );
}
