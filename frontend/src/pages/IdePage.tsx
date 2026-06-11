import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeEditor from '../components/Editor/CodeEditor';
import OutputPanel from '../components/Terminal/OutputPanel';
import TerminalPanel from '../components/Terminal/TerminalPanel';
import Sidebar, { type AppFile } from '../components/Sidebar/Sidebar';
import VoiceChat from '../components/Voice/VoiceChat';
import CollaboratorsModal from '../components/Collaborators/CollaboratorsModal';
import PerformanceModal from '../components/Terminal/PerformanceModal';
import { Play, Zap, Users, Book, LogOut, Loader2, Keyboard, Activity, TerminalSquare, RotateCcw } from 'lucide-react';
import * as Y from 'yjs';
// @ts-ignore
import { WebsocketProvider } from 'y-websocket';
import { io, Socket } from 'socket.io-client';

// =============================================================================
// MAIN COLLABORATIVE IDE CANVAS (IdePage.tsx)
// =============================================================================
//
// INTERVIEW PREP & CENTRAL ARCHITECTURAL PATTERNS:
//
// 1. COLLABORATION CORE ARCHITECTURE (Yjs CRDTs + Socket.IO Presence):
//    - Real-time multiplayer document synchronization is achieved using Yjs (Conflict-free
//      Replicated Data Types) paired with `WebsocketProvider` to resolve text edit conflict trees.
//    - A hybrid connection strategy is used: Yjs over WebSockets handle character sync,
//      while a separate Socket.IO client handles cursor presence, username listings, and user role updates.
//
// 2. CLIENT-SIDE RBAC (Role-Based Access Control) ENFORCEMENT:
//    - Users are assigned roles ('admin', 'editor', 'viewer').
//    - The frontend mirrors the backend security rules: if `userRole === 'viewer'`, mutation
//      inputs, folder creations, and code run triggers (`isExecuting`) are locked to prevent
//      wasted host cycles.
//
// 3. STATE SPLITTING FOR MULTI-FILE CODE RUNS:
//    - Instead of a single output/metrics state, we maintain `fileOutputs` and `fileMetrics`
//      mapped dynamically by `fileId`. This isolates execution states so the user can switch
//      between scripts without losing console data or metrics pills of other documents.
//

function IdePage() {
  const [isExecuting, setIsExecuting] = useState(false);
  const [fileOutputs, setFileOutputs] = useState<Record<string, string>>({});
  const [fileMetrics, setFileMetrics] = useState<Record<string, { durationMs: number; exitCode: number; oomKilled: boolean; cpuUsagePercent?: number; memoryUsageBytes?: number } | null>>({});
  const [stdinInputs, setStdinInputs] = useState<Record<string, string>>({});
  const [user, setUser] = useState<{ username: string; id: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceTitle, setWorkspaceTitle] = useState<string>('Loading...');
  const [files, setFiles] = useState<AppFile[]>([]);
  const [activeFile, setActiveFile] = useState<AppFile | null>(null);
  const [userRole, setUserRole] = useState<'admin' | 'editor' | 'viewer' | null>(null);
  const [activeCollaborators, setActiveCollaborators] = useState<any[]>([]);
  const [isCollabModalOpen, setIsCollabModalOpen] = useState(false);
  const [isActiveMembersOpen, setIsActiveMembersOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [isPerformanceModalOpen, setIsPerformanceModalOpen] = useState(false);
  
  // Terminal state
  const [activeTab, setActiveTab] = useState<'output' | 'terminal'>('output');
  const [terminalKey, setTerminalKey] = useState(0); // Used to remount terminal

  // Fixed widths for UI panels (KISS principle)
  const sidebarWidth = 256;
  const editorWidth = 60;
  const mainSplitRef = useRef<HTMLDivElement>(null);

  const editorRef = useRef<any>(null);
  const workspaceWsProviderRef = useRef<any>(null);
  const presenceSocketRef = useRef<Socket | null>(null);
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
        setUserRole(wsData.userRole || 'viewer');

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
    if (!urlWorkspaceId || !user) return;

    const ydoc = new Y.Doc();
    const token = localStorage.getItem('token') || '';
    const wsProvider = new WebsocketProvider(
      'ws://localhost:4000',
      `workspace-${urlWorkspaceId}`,
      ydoc,
      { params: { token } }
    );
    workspaceWsProviderRef.current = wsProvider;

    const eventsMap = ydoc.getMap('workspace-events');
    eventsMap.observe(() => {
      // A file was created or deleted by someone else
      fetchFiles(urlWorkspaceId);
    });


    wsProvider.on('status', (event: { status: 'connected' | 'disconnected' | 'connecting' }) => {
      setConnectionStatus(event.status);
    });

    return () => {
      wsProvider.destroy();
      ydoc.destroy();
      workspaceWsProviderRef.current = null;
    };
  }, [urlWorkspaceId, user]);

  // Socket.IO-based Workspace Presence — instant, no Yjs auth delay
  useEffect(() => {
    if (!urlWorkspaceId || !user) return;

    const token = localStorage.getItem('token') || '';
    const socket = io('http://localhost:4000', {
      auth: { token },
    });
    presenceSocketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-workspace', { workspaceId: urlWorkspaceId });
    });

    socket.on('workspace-presence-update', (users: { username: string; color: string }[]) => {
      setActiveCollaborators(users);
    });

    return () => {
      socket.emit('leave-workspace');
      socket.disconnect();
      presenceSocketRef.current = null;
    };
  }, [urlWorkspaceId, user]);

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
      const response = await fetch(`http://localhost:4000/api/workspace/${workspaceId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          code,
          language: activeFile.language,
          input: stdinInputs[activeFile.id] || '',
          fileName: activeFile.name,
          fileId: activeFile.id
        }),
      });

      const data = await response.json();
      if (data.error) {
        setFileOutputs((prev) => ({ ...prev, [activeFile.id]: `Error: ${data.error}` }));
        setFileMetrics((prev) => ({ ...prev, [activeFile.id]: null }));
      } else {
        setFileOutputs((prev) => ({ ...prev, [activeFile.id]: data.output }));
        setFileMetrics((prev) => ({ ...prev, [activeFile.id]: data.metrics || null }));
      }
    } catch (error: any) {
      setFileOutputs((prev) => ({ ...prev, [activeFile.id]: `Failed to execute: ${error.message}` }));
      setFileMetrics((prev) => ({ ...prev, [activeFile.id]: null }));
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
              {userRole && (
                <span className={`ml-3 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.22em] ${
                  userRole === 'admin' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' :
                  userRole === 'editor' ? 'border-blue-400/20 bg-blue-400/10 text-blue-300' :
                  'border-orange-400/20 bg-orange-400/10 text-orange-300'
                }`}>
                  {userRole}
                </span>
              )}
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

            {/* Upgraded Collaborators Section: Button & Dropdown */}
            {activeCollaborators.length > 0 && (
              <div className="relative mr-2">
                <button
                  onClick={() => setIsActiveMembersOpen(!isActiveMembersOpen)}
                  className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
                >
                  <div className="relative flex h-2 w-2 items-center justify-center">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                  </div>
                  {activeCollaborators.length} Online
                </button>
                
                {isActiveMembersOpen && (
                  <div className="absolute right-0 top-full mt-2 w-48 rounded-xl border border-white/10 bg-[#0d0c14] p-2 shadow-2xl z-50">
                    <div className="mb-2 px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 border-b border-white/5">
                      Active Members
                    </div>
                    <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
                      {activeCollaborators.map((c, i) => (
                        <div key={c.username || i} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors cursor-default">
                          <div 
                            className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white border border-white/10"
                            style={{ backgroundColor: c.color || '#8b5cf6' }}
                          >
                            {c.username ? c.username.substring(0, 2).toUpperCase() : '??'}
                          </div>
                          <span className="text-xs text-zinc-300 truncate">{c.username || 'Unknown'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => setIsCollabModalOpen(true)}
              className="flex items-center gap-2 rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-500/20"
            >
              <Users size={14} />
              Share
            </button>

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
            {/* Sidebar Width Wrapper */}
            <div style={{ width: `${sidebarWidth}px` }} className="flex-shrink-0 flex h-full min-w-[160px] max-w-[480px]">
              <Sidebar
                files={files}
                activeFileId={activeFile?.id || null}
                readOnly={userRole === 'viewer'}
                onFileSelect={(file) => {
                  navigate(`/ide/${urlWorkspaceId}/${file.id}`);
                }}
                onFileCreate={handleFileCreate}
                onFileDelete={handleFileDelete}
              />
            </div>

            {/* Sidebar Divider */}
            <div className="w-[1px] bg-white/[0.06] h-full flex-shrink-0" />

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
                      disabled={isExecuting || userRole === 'viewer'}
                      title={userRole === 'viewer' ? 'Viewers cannot run code' : ''}
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

                    <button
                      onClick={() => setIsPerformanceModalOpen(true)}
                      className="
                        flex items-center gap-2
                        rounded-full
                        border border-white/10
                        bg-white/5
                        px-4 py-2
                        text-sm font-semibold text-zinc-300
                        transition-all duration-200
                        hover:bg-white/10
                        hover:text-white
                        active:scale-[0.98]
                        cursor-pointer
                      "
                    >
                      <Activity size={14} className="text-violet-400" />
                      Diagnostics
                    </button>
                  </div>
                )}
              </div>

              <main ref={mainSplitRef} className="flex min-h-0 flex-1 flex-col lg:flex-row gap-0 overflow-hidden p-4 lg:p-5 relative select-none">
                <section 
                  style={{ width: `${editorWidth}%` }}
                  className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[rgba(7,6,11,0.9)] shadow-[0_16px_50px_rgba(0,0,0,0.3)] flex-shrink-0"
                >
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
                        readOnly={userRole === 'viewer'}
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

                {/* Static Space between Editor and Output panel */}
                <div className="w-3 flex-shrink-0" />

                <section 
                  style={{ width: `calc(${100 - editorWidth}% - 12px)` }}
                  className="flex min-h-0 flex-col overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[rgba(7,6,11,0.9)] shadow-[0_16px_50px_rgba(0,0,0,0.3)] flex-shrink-0"
                >
                  {/* Tab Switcher */}
                  <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setActiveTab('output')}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all ${
                          activeTab === 'output'
                            ? 'bg-violet-500/20 text-violet-300 shadow-[inset_0_0_8px_rgba(139,92,246,0.15)]'
                            : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                        }`}
                      >
                        <Play size={11} fill={activeTab === 'output' ? 'currentColor' : 'none'} />
                        Run Output
                      </button>
                      <button
                        onClick={() => setActiveTab('terminal')}
                        disabled={userRole === 'viewer'}
                        title={userRole === 'viewer' ? 'Viewers cannot access terminal' : ''}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                          activeTab === 'terminal'
                            ? 'bg-violet-500/20 text-violet-300 shadow-[inset_0_0_8px_rgba(139,92,246,0.15)]'
                            : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                        }`}
                      >
                        <TerminalSquare size={11} />
                        Terminal
                      </button>
                    </div>
                    {activeTab === 'terminal' && userRole !== 'viewer' && (
                      <button
                        onClick={() => {
                          sessionStorage.setItem('resetTerminal', 'true');
                          setTerminalKey(prev => prev + 1);
                        }}
                        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                        title="Restart terminal with latest workspace files"
                      >
                        <RotateCcw size={10} />
                        New Terminal
                      </button>
                    )}
                  </div>

                  {/* Tab Content */}
                  <div className={`flex flex-col min-h-0 flex-1 ${activeTab === 'output' ? '' : 'hidden'}`}>
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
                        disabled={userRole === 'viewer'}
                        placeholder={userRole === 'viewer' ? "Viewers cannot enter input..." : "Enter input here (e.g. for scanf, input(), cin)..."}
                        className="w-full resize-none border-0 bg-[rgba(7,6,11,0.95)] px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:bg-[rgba(13,12,20,0.95)] disabled:opacity-50"
                        rows={3}
                      />
                      <div className="border-t border-white/[0.04] bg-white/[0.02] px-4 py-1.5 text-[10px] text-zinc-500">
                        If your code reads input, add it above before running.
                      </div>
                    </div>
                    {/* Output Display */}
                    <div className="min-h-0 flex-1">
                      <OutputPanel
                        output={fileOutputs[activeFile?.id || ''] || ''}
                        isExecuting={isExecuting}
                        metrics={fileMetrics[activeFile?.id || '']}
                      />
                    </div>
                  </div>

                  <div className={`min-h-0 flex-1 flex flex-col ${activeTab === 'terminal' ? '' : 'hidden'}`}>
                    {workspaceId && (
                      <TerminalPanel key={terminalKey} workspaceId={workspaceId} />
                    )}
                  </div>
                </section>
              </main>
            </div>
          </div>
        </div>
      </div>
      
      {workspaceId && userRole && (
        <CollaboratorsModal
          workspaceId={workspaceId}
          userRole={userRole}
          isOpen={isCollabModalOpen}
          onClose={() => setIsCollabModalOpen(false)}
        />
      )}

      {workspaceId && (
        <PerformanceModal
          isOpen={isPerformanceModalOpen}
          onClose={() => setIsPerformanceModalOpen(false)}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}

export default IdePage;