import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import CodeEditor from '../components/Editor/CodeEditor';
import OutputPanel from '../components/Terminal/OutputPanel';
import Sidebar, { type AppFile } from '../components/Sidebar/Sidebar';
import { Play, Cloud, Users, Book, LogOut, Loader2 } from 'lucide-react';

function IdePage() {
  const [isExecuting, setIsExecuting] = useState(false);
  const [fileOutputs, setFileOutputs] = useState<Record<string, string>>({});
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [user, setUser] = useState<{username: string, id: string} | null>(null);
  
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [files, setFiles] = useState<AppFile[]>([]);
  const [activeFile, setActiveFile] = useState<AppFile | null>(null);
  
  const editorRef = useRef<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const initWorkspace = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login');
        return;
      }
      
      try {
        const userRes = await fetch('http://localhost:4000/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!userRes.ok) {
          localStorage.removeItem('token');
          navigate('/login');
          return;
        }
        
        const userData = await userRes.json();
        setUser(userData.user);

        const wsRes = await fetch('http://localhost:4000/api/workspace/default', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const wsData = await wsRes.json();
        setWorkspaceId(wsData.id);

        const filesRes = await fetch(`http://localhost:4000/api/workspace/${wsData.id}/files`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const filesData = await filesRes.json();
        setFiles(filesData);
        if (filesData.length > 0) {
          setActiveFile(filesData[0]);
        }
        
      } catch (err) {
        console.error(err);
        navigate('/login');
      }
    };
    
    initWorkspace();
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const handleFileCreate = async (name: string, type: 'file' | 'directory', language: string) => {
    if (!workspaceId) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`http://localhost:4000/api/workspace/${workspaceId}/files`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name, type, language })
      });
      const newFile = await res.json();
      if (!res.ok) throw new Error(newFile.error);
      
      setFiles(prev => [...prev, newFile].sort((a, b) => a.name.localeCompare(b.name)));
      if (type === 'file') setActiveFile(newFile);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleFileDelete = async (id: string) => {
    if (!workspaceId) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`http://localhost:4000/api/workspace/${workspaceId}/files/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      setFiles(prev => prev.filter(f => f.id !== id));
      if (activeFile?.id === id) {
        setActiveFile(null);
        editorRef.current?.setValue('');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleExecute = async () => {
    if (!editorRef.current || !activeFile) return;
    const code = editorRef.current.getValue();
    
    setIsExecuting(true);
    setFileOutputs(prev => ({ ...prev, [activeFile.id]: 'Running...' }));
    
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:4000/api/workspace/execute', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ code, language: activeFile.language }),
      });
      
      const data = await response.json();
      const result = data.error ? `Error: ${data.error}` : data.output;
      setFileOutputs(prev => ({ ...prev, [activeFile.id]: result }));
    } catch (error: any) {
      setFileOutputs(prev => ({ ...prev, [activeFile.id]: `Failed to execute: ${error.message}` }));
    } finally {
      setIsExecuting(false);
    }
  };

  if (!user || !workspaceId) {
    return (
      <div className="h-screen w-full bg-zinc-950 flex flex-col items-center justify-center text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-4" />
        <p>Initializing your workspace...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-zinc-950 text-zinc-300 font-sans selection:bg-indigo-500/30">
      {/* Top Navbar */}
      <header className="flex items-center justify-between px-5 py-3 bg-zinc-950 border-b border-zinc-800 z-10">
        <div className="flex items-center gap-4">
          <div className="h-8 w-8 bg-indigo-500/10 rounded-lg border border-indigo-500/20 flex items-center justify-center">
            <Cloud className="text-indigo-400" size={18} />
          </div>
          <div className="flex items-center text-sm font-medium">
            <span className="text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors">{user.username}</span>
            <span className="mx-2 text-zinc-600">/</span>
            <span className="hover:text-white cursor-pointer transition-colors text-zinc-100 font-semibold">sandbox-ide</span>
            <span className="ml-3 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase bg-zinc-900 border border-zinc-800 rounded-full text-zinc-400">
              Public
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 cursor-pointer rounded-lg text-xs font-medium transition-colors border border-zinc-800">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <Users size={14} className="text-zinc-400" />
            <span className="text-zinc-300">Live Sync</span>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 px-3 py-1.5 hover:bg-red-500/10 cursor-pointer rounded-lg text-xs font-medium transition-colors text-zinc-400 hover:text-red-400">
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          files={files}
          activeFileId={activeFile?.id || null}
          onFileSelect={setActiveFile}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
        />

        {/* Editor & Terminal Section */}
        <div className="flex flex-col flex-1 overflow-hidden bg-[#09090b]">
          
          {/* File Toolbar */}
          <div className="flex items-center justify-between px-6 py-3 bg-zinc-950 border-b border-zinc-800/80">
            <div className="flex items-center gap-2.5 text-sm">
              <Book size={16} className="text-zinc-500" />
              <span className="font-medium text-zinc-200">{activeFile?.name || 'No file selected'}</span>
            </div>
            
            {activeFile && (
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                   <div className="w-2 h-2 rounded-full bg-zinc-600"></div>
                   <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{activeFile.language}</span>
                </div>
                
                <button 
                  onClick={handleExecute}
                  disabled={isExecuting}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg font-medium text-sm transition-all shadow-[0_0_15px_rgba(99,102,241,0.15)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
                  {isExecuting ? 'Running...' : 'Run Code'}
                </button>
              </div>
            )}
          </div>

          <main className="flex-1 flex gap-4 p-4 overflow-hidden">
            {/* Editor Panel */}
            <div className="flex-1 h-full bg-zinc-950 border border-zinc-800/80 rounded-xl overflow-hidden flex flex-col shadow-sm">
              <div className="bg-zinc-900/50 border-b border-zinc-800/80 px-4 py-2.5 text-[11px] font-semibold text-zinc-400 uppercase tracking-widest">
                Editor
              </div>
              <div className="flex-1 bg-zinc-950">
                {activeFile ? (
                  <CodeEditor 
                    key={activeFile.id}
                    workspaceId={workspaceId} 
                    fileId={activeFile.id}
                    language={activeFile.language}
                    initialContent={fileContents[activeFile.id] || ''}
                    onCodeChange={(code) => setFileContents(prev => ({ ...prev, [activeFile.id]: code }))}
                    onEditorReady={(editor) => editorRef.current = editor}
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-sm gap-3">
                    <Cloud className="w-12 h-12 opacity-20" />
                    <p>Select or create a file to start coding.</p>
                  </div>
                )}
              </div>
            </div>
            
            {/* Terminal Panel */}
            <div className="w-[40%] h-full bg-[#0a0a0a] border border-zinc-800/80 rounded-xl overflow-hidden flex flex-col shadow-sm">
              <div className="bg-zinc-900/50 border-b border-zinc-800/80 px-4 py-2.5 text-[11px] font-semibold text-zinc-400 uppercase tracking-widest">
                Terminal
              </div>
              <div className="flex-1">
                <OutputPanel output={fileOutputs[activeFile?.id || ''] || ''} isExecuting={isExecuting} />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export default IdePage;