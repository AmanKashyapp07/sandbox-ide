import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import CodeEditor from '../components/Editor/CodeEditor';
import OutputPanel from '../components/Terminal/OutputPanel';
import Sidebar, { AppFile } from '../components/Sidebar/Sidebar';
import { Play, Cloud, Users, Book, LogOut } from 'lucide-react';

function IdePage() {
  const [isExecuting, setIsExecuting] = useState(false);
  const [output, setOutput] = useState('');
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
        // 1. Fetch User
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

        // 2. Fetch/Create Default Workspace
        const wsRes = await fetch('http://localhost:4000/api/workspace/default', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const wsData = await wsRes.json();
        setWorkspaceId(wsData.id);

        // 3. Fetch Files
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
    setOutput('');
    
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
      if (data.error) {
        setOutput(`Error: ${data.error}`);
      } else {
        setOutput(data.output);
      }
    } catch (error: any) {
      setOutput(`Failed to execute: ${error.message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  if (!user || !workspaceId) {
    return <div className="h-screen w-full bg-[#0d1117] flex items-center justify-center text-white">Loading IDE...</div>;
  }

  return (
    <div className="flex flex-col h-screen w-full bg-[#0d1117] text-[#c9d1d9] font-sans">
      {/* GitHub-style Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-[#161b22] text-[#c9d1d9] border-b border-[#30363d]">
        <div className="flex items-center gap-3">
          <Cloud className="text-white" size={32} />
          <div className="flex items-center text-sm font-semibold">
            <span className="text-[#8b949e] hover:text-blue-400 cursor-pointer transition-colors">{user.username}</span>
            <span className="mx-1 text-[#8b949e]">/</span>
            <span className="hover:text-blue-400 cursor-pointer transition-colors text-white">sandbox-ide</span>
            <span className="ml-2 px-2 py-0.5 text-xs font-medium border border-[#30363d] rounded-full text-[#8b949e]">Public</span>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1 bg-[#21262d] hover:bg-[#30363d] cursor-pointer rounded-md text-xs font-medium transition-colors border border-[#30363d]">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </span>
            <Users size={14} className="text-[#8b949e]" />
            Live Sync
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 px-3 py-1 hover:bg-[#30363d] cursor-pointer rounded-md text-xs font-medium transition-colors border border-transparent hover:border-[#30363d] text-[#f85149]">
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </header>

      {/* Main Layout (Sidebar + Editor + Terminal) */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar */}
        <Sidebar 
          files={files}
          activeFileId={activeFile?.id || null}
          onFileSelect={setActiveFile}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
        />

        {/* Workspace Area */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-6 py-3 bg-[#0d1117] border-b border-[#30363d]">
            <div className="flex items-center gap-2 text-sm">
              <Book size={16} className="text-[#8b949e]" />
              <span className="font-semibold text-[#c9d1d9]">{activeFile?.name || 'No file selected'}</span>
            </div>
            
            {activeFile && (
              <div className="flex items-center gap-3">
                <div className="px-3 py-1.5 text-sm font-medium text-[#8b949e] bg-[#21262d] border border-[#30363d] rounded-md">
                  {activeFile.language}
                </div>
                
                <button 
                  onClick={handleExecute}
                  disabled={isExecuting}
                  className="flex items-center gap-2 bg-[#238636] hover:bg-[#2ea043] border border-[rgba(240,246,252,0.1)] text-white px-3 py-1.5 rounded-md font-medium text-sm transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play size={14} fill="currentColor" />
                  {isExecuting ? 'Running...' : 'Run Code'}
                </button>
              </div>
            )}
          </div>

          <main className="flex-1 flex gap-4 p-6 overflow-hidden">
            <div className="flex-1 h-full bg-[#0d1117] border border-[#30363d] rounded-md shadow-sm overflow-hidden flex flex-col">
              <div className="bg-[#161b22] border-b border-[#30363d] px-4 py-2 text-xs font-semibold text-[#8b949e]">
                Code Editor
              </div>
              <div className="flex-1">
                {activeFile ? (
                  <CodeEditor 
                    key={activeFile.id} // Re-mount Yjs provider on file switch
                    workspaceId={workspaceId} 
                    fileId={activeFile.id}
                    language={activeFile.language}
                    onEditorReady={(editor) => editorRef.current = editor}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-[#8b949e] text-sm">
                    Select or create a file to start coding.
                  </div>
                )}
              </div>
            </div>
            
            <div className="w-[40%] h-full bg-[#0d1117] border border-[#30363d] rounded-md shadow-sm overflow-hidden flex flex-col">
              <div className="bg-[#161b22] border-b border-[#30363d] px-4 py-2 text-xs font-semibold text-[#8b949e]">
                Terminal
              </div>
              <div className="flex-1 bg-[#0d1117]">
                <OutputPanel output={output} isExecuting={isExecuting} />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export default IdePage;
