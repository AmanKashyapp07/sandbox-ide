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
  initialContent?: string;
  onCodeChange?: (code: string) => void;
  onEditorReady?: (editor: any) => void;
}

export default function CodeEditor({ workspaceId, fileId, language, initialContent, onCodeChange, onEditorReady }: CodeEditorProps) {
  const [editor, setEditor] = useState<any>(null);

  useEffect(() => {
    if (!editor) return;

    const ydoc = new Y.Doc();
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

    const type = ydoc.getText('monaco');
    
    const binding = new MonacoBinding(
      type,
      editor.getModel(),
      new Set([editor]),
      wsProvider.awareness
    );

    // The backend now handles loading the initial state from the database.
    // We no longer need to manually inject initialContent here, doing so 
    // causes duplication when the server loads state asynchronously.

    return () => {
      binding.destroy();
      wsProvider.destroy();
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
