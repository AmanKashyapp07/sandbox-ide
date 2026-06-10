import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs'; 
// @ts-ignore
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import { IndexeddbPersistence } from 'y-indexeddb';


interface CodeEditorProps {
  workspaceId: string;
  fileId: string;
  language: string;
  currentUser: { username: string; id: string };
  onCodeChange?: (code: string) => void;
  onEditorReady?: (editor: any) => void;
  onAwarenessChange?: (users: any[]) => void;
  onConnectionStatusChange?: (status: 'connected' | 'disconnected' | 'connecting') => void;
  readOnly?: boolean;
}

const COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899', // pink
];

const getUserColor = (username: string) => {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
};

export default function CodeEditor({ workspaceId, fileId, language, currentUser, onCodeChange, onEditorReady, onAwarenessChange, onConnectionStatusChange, readOnly = false }: CodeEditorProps) {
  const [editor, setEditor] = useState<any>(null);
  const [awarenessStates, setAwarenessStates] = useState<any[]>([]);

  useEffect(() => {
    if (!editor) return;

    const ydoc = new Y.Doc();
    const roomName = `${workspaceId}-${fileId}`;
    
    // Setup offline persistence
    const indexeddbProvider = new IndexeddbPersistence(roomName, ydoc);

    const token = localStorage.getItem('token') || '';
    const wsProvider = new WebsocketProvider(
      'ws://localhost:4000',
      roomName,
      ydoc,
      { params: { token } }
    );

    let isActive = true;

    const handleStatusChange = (event: { status: 'connected' | 'disconnected' | 'connecting' }) => {
      if (isActive && onConnectionStatusChange) {
        onConnectionStatusChange(event.status);
      }
      if (isActive && event.status === 'connected') {
        wsProvider.awareness.setLocalStateField('user', {
          name: currentUser.username,
          color: getUserColor(currentUser.username)
        });
      }
    };

    wsProvider.on('status', handleStatusChange);

    const handleAwarenessChange = () => {
      if (!isActive) return;
      const states = Array.from(wsProvider.awareness.getStates().entries());
      setAwarenessStates(states);
      
      if (onAwarenessChange) {
        const users = states.map(([, state]: any) => state.user).filter(Boolean);
        const uniqueUsers = Array.from(new Map(users.map(u => [u.name, u])).values());
        onAwarenessChange(uniqueUsers);
      }
    };
    
    wsProvider.awareness.on('change', handleAwarenessChange);
    handleAwarenessChange();

    const type = ydoc.getText('monaco');
    
    const binding = new MonacoBinding(
      type,
      editor.getModel(),
      new Set([editor]),
      wsProvider.awareness
    );

    return () => {
      isActive = false;
      wsProvider.off('status', handleStatusChange);
      wsProvider.awareness.off('change', handleAwarenessChange);
      binding.destroy();
      wsProvider.destroy();
      indexeddbProvider.destroy();
      ydoc.destroy();
    };
  }, [editor, workspaceId, fileId]);

  const handleEditorDidMount = (editorInstance: any) => {
    setEditor(editorInstance);
    if (onEditorReady) {
      onEditorReady(editorInstance);
    }
  };

  return (
    <div className="relative h-full w-full">
      <style>
        {awarenessStates.map(([clientId, state]) => {
          if (!state.user || !state.user.color) return '';
          
          const color = state.user.color;
          const name = state.user.name || 'Anonymous';
          
          return `
            .yRemoteSelection-${clientId} {
              background-color: ${color}25 !important;
            }
            .yRemoteSelectionHead-${clientId} {
              position: absolute;
              border-left: 2px solid ${color} !important;
              box-sizing: border-box;
              height: 100%;
              z-index: 10;
            }
            /* The little square top on the cursor (Caret Head) */
            .yRemoteSelectionHead-${clientId}::before {
              content: '';
              position: absolute;
              top: -2px;
              left: -2px;
              width: 4px;
              height: 4px;
              background-color: ${color};
              border-radius: 1px;
            }
            /* The Name Tag Flag */
            .yRemoteSelectionHead-${clientId}::after {
              position: absolute;
              content: "${name}";
              top: -24px;
              left: -2px;
              background-color: ${color} !important;
              color: #ffffff;
              font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
              font-size: 11px;
              font-weight: 600;
              line-height: 1;
              padding: 4px 6px;
              border-radius: 4px 4px 4px 0px;
              white-space: nowrap;
              pointer-events: none;
              opacity: 0;
              transform: translateY(4px);
              transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
              box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 2px 4px -1px rgba(0, 0, 0, 0.1);
              z-index: 20;
            }
            /* Show on hover */
            .yRemoteSelectionHead-${clientId}:hover::after {
              opacity: 1;
              transform: translateY(0);
            }
          `;
        }).join('\n')}
      </style>
      <Editor
        height="100%"
        language={language}
        theme="vs-dark"
        loading={<div className="h-full w-full bg-transparent" />}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
          wordWrap: 'on',
          padding: { top: 12 },
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          readOnly: readOnly,
        }}
        onMount={handleEditorDidMount}
        onChange={(value) => onCodeChange && onCodeChange(value || '')}
      />
    </div>
  );
}