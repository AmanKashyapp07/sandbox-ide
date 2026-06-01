import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
// @ts-ignore
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';

interface CodeEditorProps {
  workspaceId: string;
  fileId: string;
  language: string;
  onCodeChange?: (code: string) => void;
  onEditorReady?: (editor: any) => void;
}

export default function CodeEditor({ workspaceId, fileId, language, onCodeChange, onEditorReady }: CodeEditorProps) {
  const editorRef = useRef<any>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const ydocRef = useRef(new Y.Doc());

  useEffect(() => {
    const ydoc = ydocRef.current;
    
    // Connect to Yjs WebSocket server
    const roomName = `${workspaceId}-${fileId}`;
    const wsProvider = new WebsocketProvider(
      'ws://localhost:4000',
      roomName,
      ydoc
    );

    wsProvider.awareness.setLocalStateField('user', {
      name: `User ${Math.floor(Math.random() * 1000)}`,
      color: '#' + Math.floor(Math.random()*16777215).toString(16)
    });

    setProvider(wsProvider);

    return () => {
      wsProvider.destroy();
      ydoc.destroy();
    };
  }, [workspaceId, fileId]);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
    
    if (provider) {
      const type = ydocRef.current.getText('monaco');
      
      new MonacoBinding(
        type,
        editor.getModel(),
        new Set([editor]),
        provider.awareness
      );
    }
    
    if (onEditorReady) {
      onEditorReady(editor);
    }
  };

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
          wordWrap: 'on',
          padding: { top: 12 },
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
        }}
        onMount={handleEditorDidMount}
        onChange={(value) => onCodeChange && onCodeChange(value || '')}
      />
    </div>
  );
}
