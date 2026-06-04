import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeEditor from '../components/Editor/CodeEditor';
import OutputPanel from '../components/Terminal/OutputPanel';
import Sidebar, { type AppFile } from '../components/Sidebar/Sidebar';
import VoiceChat from '../components/Voice/VoiceChat';
import { Play, Zap, Users, Book, LogOut, Loader2, Keyboard } from 'lucide-react';
import * as Y from 'yjs';
// @ts-ignore
import { WebsocketProvider } from 'y-websocket';

function IdePage() {
  const [isExecuting, setIsExecuting] = useState(false);
  const [fileOutputs, setFileOutputs] = useState<Record<string, string>>({});
  const [stdinInputs, setStdinInputs] = useState<Record<string, string>>({});
  const [user, setUser] = useState<{ username: string; id: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceTitle, setWorkspaceTitle] = useState<string>('Loading...');
  const [files, setFiles] = useState<AppFile[]>([]);
  const [activeFile, setActiveFile] = useState<AppFile | null>(null);
  const [activeCollaborators, setActiveCollaborators] = useState<any[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');

  const editorRef = useRef<any>(null);
  const workspaceWsProviderRef = useRef<any>(null);
  const navigate = useNavigate();
  const { workspaceId: urlWorkspaceId, fileId: urlFileId } = useParams<{ workspaceId: string, fileId: string }>();
  
  const fetchFiles = async (wsId: string) => {
    try {
      const token = localStorage.getItem('token');
      const filesRes = await fetch(`http://localhost:4000/api/workspace/${wsId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (filesRes.ok) {
        const filesData = await filesRes.json();
        setFiles(filesData);
      }
    } catch (err) {
      console.error('Failed to fetch files', err);
    }
  };

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

        await fetchFiles(wsData.id);
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

  // Workspace-level Yjs Sync for File Tree Updates
  useEffect(() => {
    if (!urlWorkspaceId) return;

    const ydoc = new Y.Doc();
    const wsProvider = new WebsocketProvider(
      'ws://localhost:4000',
      `workspace-${urlWorkspaceId}`,
      ydoc
    );
    workspaceWsProviderRef.current = wsProvider;

    const eventsMap = ydoc.getMap('workspace-events');
    eventsMap.observe(() => {
      // A file was created or deleted by someone else
      fetchFiles(urlWorkspaceId);
    });

    return () => {
      wsProvider.destroy();
      ydoc.destroy();
      workspaceWsProviderRef.current = null;
    };
  }, [urlWorkspaceId]);

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

      // Notify other clients in the workspace
      if (workspaceWsProviderRef.current) {
        workspaceWsProviderRef.current.doc.getMap('workspace-events').set('lastFileUpdate', Date.now());
      }

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

      // Notify other clients in the workspace
      if (workspaceWsProviderRef.current) {
        workspaceWsProviderRef.current.doc.getMap('workspace-events').set('lastFileUpdate', Date.now());
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
        body: JSON.stringify({ code, language: activeFile.language, input: stdinInputs[activeFile.id] || '' }),
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
      <div className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-[#07060b] text-zinc-300">
        <div className="absolute inset-0 overflow-hidden pointer-events-none nx-orb-dim">
          <div className="nx-orb nx-orb-1" />
          <div className="nx-orb nx-orb-2" />
        </div>
        <div className="relative flex flex-col items-center gap-4 rounded-[1.75rem] nx-glass-strong px-8 py-10 shadow-[0_24px_90px_rgba(0,0,0,0.5)]">
          <Loader2 className="h-8 w-8 animate-spin text-violet-300" />
          <p className="text-sm text-zinc-400">Initializing your workspace...</p>
        </div>
      </div>
    );
  }

  // Helper to generate the full path breadcrumbs for the active file
  const getFileBreadcrumbs = () => {
    if (!activeFile) return [];

    const path = [activeFile];
    let currentParentId = activeFile.parent_id;

    // Safety limit to prevent infinite loops in case of corrupted data
    let depth = 0;
    while (currentParentId && depth < 20) {
      const parent = files.find(f => f.id === currentParentId);
      if (parent) {
        path.unshift(parent);
        currentParentId = parent.parent_id;
        depth++;
      } else {
        break;
      }
    }

    return path;
  };

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#07060b] text-zinc-300 selection:bg-violet-400/25">
      {/* Very subtle ambient orbs for IDE (dimmed) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none nx-orb-dim">
        <div className="nx-orb nx-orb-1" />
        <div className="nx-orb nx-orb-2" />
      </div>
      
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* Added z-50 to header so Voice Chat floats over the code editor perfectly */}
       <header className="relative z-50 flex items-center justify-between border-b border-violet-500/10 bg-[rgba(13,12,20,0.75)] px-5 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.18),0_0_1px_rgba(139,92,246,0.1)] backdrop-blur-2xl sm:px-6">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-violet-400/15 bg-violet-400/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <Zap className="text-violet-300" size={18} />
            </div>
            <div className="flex items-center text-sm font-medium">
              <span className="cursor-pointer text-zinc-400 transition-colors hover:text-zinc-200">{user.username}</span>
              <span className="mx-2 text-zinc-700">/</span>
              <span className="cursor-pointer font-semibold text-white transition-colors hover:text-violet-200">{workspaceTitle}</span>
              <span className="ml-3 rounded-full border border-violet-400/15 bg-violet-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-violet-200">
                Public
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">

            {/* Voice Chat Component */}
            <VoiceChat workspaceId={workspaceId} user={user} />

            {/* Connection Indicator */}
            <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors mr-2 ${connectionStatus === 'connected'
              ? 'border-emerald-400/15 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/12'
              : connectionStatus === 'disconnected'
                ? 'border-red-400/15 bg-red-400/10 text-red-200 hover:bg-red-400/12'
                : 'border-amber-400/15 bg-amber-400/10 text-amber-200 hover:bg-amber-400/12'
              }`}>
              <span className="relative flex h-2 w-2">
                {connectionStatus === 'connected' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                )}
                {connectionStatus === 'connecting' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
                )}
                <span className={`relative inline-flex h-2 w-2 rounded-full ${connectionStatus === 'connected' ? 'bg-emerald-400' : connectionStatus === 'disconnected' ? 'bg-red-400' : 'bg-amber-400'
                  }`} />
              </span>
              {connectionStatus === 'connected' ? <Users size={14} className="text-emerald-200/80" /> : connectionStatus === 'disconnected' ? <Zap size={14} className="text-red-200/80" /> : <Loader2 size={14} className="animate-spin text-amber-200/80" />}
              <span>
                {connectionStatus === 'connected' ? 'Live Sync' : connectionStatus === 'disconnected' ? 'Offline' : 'Connecting...'}
              </span>
            </div>

            {/* Upgraded Collaborators Section */}
            {activeCollaborators.length > 0 && (
              <div className="flex items-center mr-2">
                <div className="flex -space-x-3 transition-all duration-300 hover:space-x-1">
                  {activeCollaborators.map((collaborator, index) => (
                    <div
                      key={collaborator.clientId || index}
                      className="group relative flex h-8 w-8 cursor-default items-center justify-center rounded-full border-2 border-[#07060b] text-xs font-bold text-white transition-transform hover:z-10 hover:-translate-y-1"
                      style={{
                        backgroundColor: collaborator.color || '#8b5cf6',
                        boxShadow: `0 0 12px ${collaborator.color || '#8b5cf6'}40`
                      }}
                    >
                      {/* Avatar Initials */}
                      {collaborator.name ? collaborator.name.substring(0, 2).toUpperCase() : '??'}

                      {/* Premium Tooltip */}
                      <div className="pointer-events-none absolute -bottom-10 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-medium tracking-wide text-zinc-200 opacity-0 shadow-xl transition-all duration-200 group-hover:-translate-y-1 group-hover:opacity-100">
                        {collaborator.name}
                        {/* Tooltip Arrow */}
                        <div className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-white/10 bg-zinc-900" />
                      </div>
                    </div>
                  ))}
                </div>
                <span className="ml-3 text-[11px] font-medium tracking-wide text-zinc-500">
                  {activeCollaborators.length} {activeCollaborators.length === 1 ? 'Online' : 'Online'}
                </span>
              </div>
            )}

            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/10"
            >
              Back to Dashboard
            </button>

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
          <div className="flex min-h-0 w-full overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-[rgba(13,12,20,0.6)] shadow-[0_24px_90px_rgba(0,0,0,0.45),0_0_1px_rgba(139,92,246,0.08)] backdrop-blur-2xl">
            <Sidebar
              files={files}
              activeFileId={activeFile?.id || null}
              onFileSelect={(file) => {
                navigate(`/ide/${urlWorkspaceId}/${file.id}`);
              }}
              onFileCreate={handleFileCreate}
              onFileDelete={handleFileDelete}
            />

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(13,12,20,0.95),rgba(7,6,11,0.98))]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3 sm:px-6">
                <div className="flex items-center gap-2.5 text-sm">
                  <Book size={16} className="text-violet-300/80" />

                  {activeFile ? (
                    <div className="flex items-center">
                      {getFileBreadcrumbs().map((crumb, index, arr) => {
                        const isLast = index === arr.length - 1;
                        return (
                          <div key={crumb.id} className="flex items-center">
                            <span
                              className={`transition-colors ${isLast
                                  ? 'font-medium text-zinc-100'
                                  : 'text-zinc-400 hover:text-zinc-300'
                                }`}
                            >
                              {crumb.name}
                            </span>
                            {!isLast && (
                              <span className="mx-2 text-zinc-600 font-light">/</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="font-medium text-zinc-100">No file selected</span>
                  )}
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
                      className="
                        nx-btn-shimmer nx-btn-gradient
                        flex items-center gap-2
                        rounded-full
                        border border-violet-300/20
                        px-4 py-2
                        text-sm font-semibold text-white
                        shadow-[0_16px_30px_rgba(139,92,246,0.2)]
                        transition-all duration-200
                        hover:scale-[1.02]
                        hover:shadow-[0_18px_36px_rgba(99,102,241,0.3)]
                        active:scale-[0.98]
                        cursor-pointer
                        disabled:cursor-not-allowed
                        disabled:opacity-60
                      "
                    >
                      {isExecuting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} fill="currentColor" />
                      )}
                      {isExecuting ? 'Running...' : 'Run Code'}
                    </button>
                  </div>
                )}
              </div>

              <main className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.42fr)] lg:p-5">
                <section className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[rgba(7,6,11,0.9)] shadow-[0_16px_50px_rgba(0,0,0,0.3)]">
                  <div className="border-b border-white/[0.06] bg-white/[0.03] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                    Editor
                  </div>
                  <div className="min-h-0 flex-1 bg-[rgba(7,6,11,0.95)]">
                    {activeFile ? (
                      <CodeEditor
                        workspaceId={workspaceId}
                        fileId={activeFile.id}
                        language={activeFile.language || 'javascript'}
                        currentUser={user}
                        onAwarenessChange={setActiveCollaborators}
                        onConnectionStatusChange={setConnectionStatus}
                        onEditorReady={(editor) => {
                          editorRef.current = editor;
                        }}
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-500">
                        <Zap className="h-12 w-12 opacity-20" />
                        <p>Select or create a file to start coding.</p>
                      </div>
                    )}
                  </div>
                </section>

                <section className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[rgba(7,6,11,0.9)] shadow-[0_16px_50px_rgba(0,0,0,0.3)]">
                  {/* Stdin Input Section */}
                  <div className="border-b border-white/[0.06]">
                    <div className="flex items-center gap-1.5 bg-white/[0.03] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                      <Keyboard size={12} className="text-violet-400/70" />
                      Input (stdin)
                    </div>
                    <textarea
                      value={stdinInputs[activeFile?.id || ''] || ''}
                      onChange={(e) => {
                        const fileId = activeFile?.id || '';
                        setStdinInputs((prev) => ({ ...prev, [fileId]: e.target.value }));
                      }}
                      placeholder="Enter input here (e.g. for scanf, input(), cin)..."
                      className="w-full resize-none border-0 bg-[rgba(7,6,11,0.95)] px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:bg-[rgba(13,12,20,0.95)]"
                      rows={3}
                    />
                    <div className="border-t border-white/[0.04] bg-white/[0.02] px-4 py-1.5 text-[10px] text-zinc-500">
                      If your code reads input, add it above before running.
                    </div>
                  </div>
                  {/* Terminal Output Section */}
                  <div className="border-b border-white/[0.06] bg-white/[0.03] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
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