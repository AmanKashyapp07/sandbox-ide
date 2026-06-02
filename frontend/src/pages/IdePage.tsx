import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeEditor from '../components/Editor/CodeEditor';
import OutputPanel from '../components/Terminal/OutputPanel';
import Sidebar, { type AppFile } from '../components/Sidebar/Sidebar';
import { Play, Cloud, Users, Book, LogOut, Loader2 } from 'lucide-react';

function IdePage() {
  const [isExecuting, setIsExecuting] = useState(false);
  const [fileOutputs, setFileOutputs] = useState<Record<string, string>>({});
  const [user, setUser] = useState<{ username: string; id: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceTitle, setWorkspaceTitle] = useState<string>('Loading...');
  const [files, setFiles] = useState<AppFile[]>([]);
  const [activeFile, setActiveFile] = useState<AppFile | null>(null);

  const editorRef = useRef<any>(null);
  const navigate = useNavigate();
  const { workspaceId: urlWorkspaceId, fileId: urlFileId } = useParams<{workspaceId: string, fileId: string}>();

  useEffect(() => {
    const initWorkspace = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        navigate('/login');
        return;
      }

      try {
        const userRes = await fetch('http://localhost:4000/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!userRes.ok) {
          localStorage.removeItem('token');
          navigate('/login');
          return;
        }

        const userData = await userRes.json();
        setUser(userData.user);

        const wsRes = await fetch(`http://localhost:4000/api/workspace/${urlWorkspaceId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        
        if (!wsRes.ok) {
          navigate('/dashboard');
          return;
        }
        
        const wsData = await wsRes.json();
        setWorkspaceId(wsData.id);
        setWorkspaceTitle(wsData.title);

        const filesRes = await fetch(`http://localhost:4000/api/workspace/${wsData.id}/files`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const filesData = await filesRes.json();
        setFiles(filesData);
      } catch (err) {
        console.error(err);
        navigate('/login');
      }
    };

    if (urlWorkspaceId) {
      initWorkspace();
    } else {
      navigate('/dashboard');
    }
  }, [navigate, urlWorkspaceId]);

  useEffect(() => {
    if (files.length === 0) return;
    
    if (!urlFileId) {
      const firstFile = files.find((file) => file.type === 'file');
      if (firstFile) {
        navigate(`/ide/${urlWorkspaceId}/${firstFile.id}`, { replace: true });
      }
      return;
    }

    const fileToSelect = files.find((file) => file.id === urlFileId && file.type === 'file') || files.find((file) => file.type === 'file') || null;
    if (fileToSelect && activeFile?.id !== fileToSelect.id) {
      setActiveFile(fileToSelect);
      if (fileToSelect.id !== urlFileId) {
        navigate(`/ide/${urlWorkspaceId}/${fileToSelect.id}`, { replace: true });
      }
    }
  }, [urlFileId, files, urlWorkspaceId, navigate, activeFile]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const handleFileCreate = async (name: string, type: 'file' | 'directory', language: string | null, parentId: string | null) => {
    if (!workspaceId) return;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`http://localhost:4000/api/workspace/${workspaceId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, type, parent_id: parentId, language }),
      });

      const newFile = await res.json();
      if (!res.ok) throw new Error(newFile.error);

      setFiles((prev) => [...prev, newFile].sort((a, b) => a.name.localeCompare(b.name)));
      if (type === 'file') {
        navigate(`/ide/${urlWorkspaceId}/${newFile.id}`);
      }
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
        headers: { Authorization: `Bearer ${token}` },
      });

      setFiles((prev) => prev.filter((f) => f.id !== id));
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

    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:4000/api/workspace/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code, language: activeFile.language }),
      });

      const data = await response.json();
      const result = data.error ? `Error: ${data.error}` : data.output;
      setFileOutputs((prev) => ({ ...prev, [activeFile.id]: result }));
    } catch (error: any) {
      setFileOutputs((prev) => ({ ...prev, [activeFile.id]: `Failed to execute: ${error.message}` }));
    } finally {
      setIsExecuting(false);
    }
  };

  if (!user || !workspaceId) {
    return (
      <div className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-[#050608] text-zinc-300">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.16),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.14),transparent_28%)]" />
        <div className="relative flex flex-col items-center gap-4 rounded-[1.75rem] border border-white/10 bg-white/5 px-8 py-10 shadow-[0_24px_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-300" />
          <p className="text-sm text-zinc-400">Initializing your workspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#050608] text-zinc-300 selection:bg-cyan-400/25">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.08),transparent_28%),radial-gradient(circle_at_85%_15%,rgba(59,130,246,0.08),transparent_24%)]" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-white/10 bg-white/5 px-5 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.18)] backdrop-blur-2xl sm:px-6">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-400/15 bg-cyan-400/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <Cloud className="text-cyan-300" size={18} />
            </div>
            <div className="flex items-center text-sm font-medium">
              <span className="cursor-pointer text-zinc-400 transition-colors hover:text-zinc-200">{user.username}</span>
              <span className="mx-2 text-zinc-700">/</span>
              <span className="cursor-pointer font-semibold text-white transition-colors hover:text-cyan-200">{workspaceTitle}</span>
              <span className="ml-3 rounded-full border border-cyan-400/15 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200">
                Public
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10"
            >
              Back to Dashboard
            </button>
            <div className="flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-400/12">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <Users size={14} className="text-emerald-200/80" />
              <span>Live Sync</span>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-red-400/20 hover:bg-red-500/10 hover:text-red-300"
            >
              <LogOut size={14} />
              Logout
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden p-4 sm:p-5">
          <div className="flex min-h-0 w-full overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/5 shadow-[0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <Sidebar
              files={files}
              activeFileId={activeFile?.id || null}
              onFileSelect={(file) => {
                navigate(`/ide/${urlWorkspaceId}/${file.id}`);
              }}
              onFileCreate={handleFileCreate}
              onFileDelete={handleFileDelete}
            />

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(9,9,11,0.92),rgba(4,4,5,0.98))]">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3 sm:px-6">
                <div className="flex items-center gap-2.5 text-sm">
                  <Book size={16} className="text-cyan-300/80" />
                  <span className="font-medium text-zinc-100">{activeFile?.name || 'No file selected'}</span>
                </div>

                {activeFile && (
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
                      <div className="h-2 w-2 rounded-full bg-zinc-500" />
                      <span className="text-xs font-medium uppercase tracking-[0.22em] text-zinc-400">{activeFile.language}</span>
                    </div>

                    <button
                      onClick={handleExecute}
                      disabled={isExecuting}
                      className="flex items-center gap-2 rounded-full border border-cyan-300/20 bg-[linear-gradient(135deg,#06b6d4,#2563eb)] px-4 py-2 text-sm font-semibold text-white shadow-[0_16px_30px_rgba(8,145,178,0.22)] transition duration-200 hover:shadow-[0_18px_36px_rgba(37,99,235,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="currentColor" />}
                      {isExecuting ? 'Running...' : 'Run Code'}
                    </button>
                  </div>
                )}
              </div>

              <main className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.42fr)] lg:p-5">
                <section className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-zinc-950/80 shadow-[0_16px_50px_rgba(0,0,0,0.3)]">
                  <div className="border-b border-white/10 bg-white/5 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                    Editor
                  </div>
                  <div className="min-h-0 flex-1 bg-zinc-950/90">
                    {activeFile ? (
                      <CodeEditor
                        workspaceId={workspaceId}
                        fileId={activeFile.id}
                        language={activeFile.language || 'javascript'}
                        onEditorReady={(editor) => {
                          editorRef.current = editor;
                        }}
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-500">
                        <Cloud className="h-12 w-12 opacity-20" />
                        <p>Select or create a file to start coding.</p>
                      </div>
                    )}
                  </div>
                </section>

                <section className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-zinc-950/80 shadow-[0_16px_50px_rgba(0,0,0,0.3)]">
                  <div className="border-b border-white/10 bg-white/5 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                    Terminal
                  </div>
                  <div className="min-h-0 flex-1">
                    <OutputPanel output={fileOutputs[activeFile?.id || ''] || ''} isExecuting={isExecuting} />
                  </div>
                </section>
              </main>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IdePage;