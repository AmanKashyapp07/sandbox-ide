import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Plus, ArrowRight, FolderCode, LogOut, Loader2, ArrowUpRight, Trash2, Edit2, Check, X } from 'lucide-react';

interface Workspace {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  user_role?: string;
}

export default function DashboardPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [user, setUser] = useState<{ username: string, id: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [joinId, setJoinId] = useState('');
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const init = async () => {
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

        const wsRes = await fetch('http://localhost:4000/api/workspace', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const wsData = await wsRes.json();
        setWorkspaces(wsData);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setIsCreating(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('http://localhost:4000/api/workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ title: newTitle })
      });
      const data = await res.json();
      if (res.ok) {
        navigate(`/ide/${data.id}`);
      }
    } catch (err) {
      console.error(err);
      setIsCreating(false);
    }
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinId.trim()) return;
    // Just navigate to the IDE with that UUID. If it doesn't exist, IDE will handle 404.
    navigate(`/ide/${joinId.trim()}`);
  };

  const handleDelete = async (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    const isOwner = user?.id === ws.owner_id;
    if (!isOwner) {
      alert('You are not Admin of this workspace');
      return;
    }
    if (!confirm('Are you sure you want to delete this workspace?')) return;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`http://localhost:4000/api/workspace/${ws.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        setWorkspaces(prev => prev.filter(item => item.id !== ws.id));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleEditStart = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    const isOwner = user?.id === ws.owner_id;
    const isAdmin = isOwner || ws.user_role === 'admin';
    if (!isAdmin) {
      alert('You are not Admin of this workspace');
      return;
    }
    setEditingWorkspaceId(ws.id);
    setEditingTitle(ws.title);
  };

  const handleEditSave = async (e: React.MouseEvent | React.FormEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (!editingTitle.trim()) {
      setEditingWorkspaceId(null);
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('http://localhost:4000/api/workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ id, title: editingTitle })
      });
      if (res.ok) {
        setWorkspaces(prev => prev.map(ws => ws.id === id ? { ...ws, title: editingTitle } : ws));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setEditingWorkspaceId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="relative flex h-screen w-full items-center justify-center overflow-hidden bg-[#07060b] text-zinc-300">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="nx-orb nx-orb-1" />
          <div className="nx-orb nx-orb-2" />
        </div>
        <div className="relative flex flex-col items-center gap-4 rounded-[1.75rem] nx-glass-strong px-8 py-10 shadow-[0_24px_90px_rgba(0,0,0,0.5)]">
          <Loader2 className="h-8 w-8 animate-spin text-violet-300" />
          <p className="text-sm text-zinc-400">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#07060b] text-zinc-200 selection:bg-violet-400/25 font-sans">
      {/* Animated Aurora Orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="nx-orb nx-orb-1" />
        <div className="nx-orb nx-orb-2" />
        <div className="nx-orb nx-orb-3" />
      </div>

      {/* Grid Overlay */}
      <div className="absolute inset-0 nx-grid-overlay opacity-30" />

      <div className="relative mx-auto max-w-6xl px-6 py-12">
        <header className="flex items-center justify-between mb-12 border-b border-white/10 pb-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-400/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <Zap className="text-violet-300" size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-white tracking-tight">Welcome, {user?.username}</h1>
              <p className="text-sm text-zinc-400 mt-1">Manage your collaborative cloud workspaces</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-red-400/20 hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut size={16} />
            Logout
          </button>
        </header>

        <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
          <section>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-medium text-white flex items-center gap-2">
                <FolderCode size={18} className="text-violet-400" />
                Your Workspaces
              </h2>
            </div>

            {workspaces.length === 0 ? (
              <div className="rounded-[2rem] border border-white/5 bg-white/[0.02] p-12 text-center border-dashed backdrop-blur-sm">
                <FolderCode size={40} className="mx-auto text-zinc-600 mb-4 opacity-50" />
                <h3 className="text-lg font-medium text-zinc-300">No workspaces yet</h3>
                <p className="text-zinc-500 mt-2">Create your first sandbox to start coding.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {workspaces.map(ws => (
                  <div
                    key={ws.id}
                    onClick={() => {
                      if (editingWorkspaceId !== ws.id) navigate(`/ide/${ws.id}`);
                    }}
                    className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur-md transition-all duration-300 hover:border-violet-400/30 hover:bg-white/[0.07] hover:shadow-[0_8px_30px_rgba(139,92,246,0.12)] hover:scale-[1.02] ${editingWorkspaceId === ws.id ? 'cursor-default ring-1 ring-violet-500/50' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-start justify-between min-h-[2rem]">
                      {editingWorkspaceId === ws.id ? (
                        <form className="flex w-full items-center gap-2" onSubmit={(e) => handleEditSave(e, ws.id)}>
                          <input
                            autoFocus
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 rounded-lg border border-violet-500/30 bg-black/50 px-3 py-1 text-sm text-white outline-none focus:border-violet-400"
                          />
                          <button type="submit" className="rounded-lg p-1.5 text-emerald-400 hover:bg-emerald-500/20" onClick={(e) => handleEditSave(e, ws.id)}>
                            <Check size={16} />
                          </button>
                          <button type="button" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-500/20 hover:text-white" onClick={(e) => { e.stopPropagation(); setEditingWorkspaceId(null); }}>
                            <X size={16} />
                          </button>
                        </form>
                      ) : (
                        <>
                          <h3 className="text-lg font-medium text-zinc-100 group-hover:text-violet-100 transition-colors pr-16">{ws.title}</h3>

                          <div className="absolute right-4 top-4 flex opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                            <button
                              onClick={(e) => handleEditStart(e, ws)}
                              className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-violet-300"
                              title="Edit Title"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button
                              onClick={(e) => handleDelete(e, ws)}
                              className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-red-500/20 hover:text-red-400"
                              title="Delete Workspace"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <ArrowUpRight size={18} className="absolute right-4 top-5 text-zinc-500 opacity-0 group-hover:opacity-0 transition-opacity -translate-x-2 translate-y-2 group-hover:translate-x-0 group-hover:translate-y-0 duration-300" />
                        </>
                      )}
                    </div>
                    <div className="mt-4 flex items-center justify-between">
                      <div className="text-xs font-mono text-zinc-500 truncate mr-4">
                        ID: {ws.id.split('-')[0]}...
                      </div>
                      <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                        {new Date(ws.updated_at).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <div className="rounded-[1.5rem] nx-glass-strong p-6 shadow-[0_24px_40px_rgba(0,0,0,0.4)]">
              <h3 className="text-sm font-medium uppercase tracking-widest text-zinc-400 mb-4">Create New</h3>
              <form onSubmit={handleCreate} className="space-y-4">
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Workspace Name"
                  className="nx-input-glow block w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-zinc-600 shadow-inner outline-none transition duration-200 hover:border-white/20"
                />
                <button
                  type="submit"
                  disabled={isCreating}
                  className="nx-btn-shimmer nx-btn-gradient flex w-full items-center justify-center gap-2 rounded-xl border border-violet-300/20 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(139,92,246,0.2)] transition duration-200 hover:shadow-[0_12px_25px_rgba(99,102,241,0.3)] disabled:opacity-50"
                >
                  {isCreating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                  New Workspace
                </button>
              </form>
            </div>

            <div className="rounded-[1.5rem] nx-glass-strong p-6 shadow-[0_24px_40px_rgba(0,0,0,0.4)]">
              <h3 className="text-sm font-medium uppercase tracking-widest text-zinc-400 mb-4">Join Existing</h3>
              <form onSubmit={handleJoin} className="space-y-4">
                <input
                  type="text"
                  required
                  value={joinId}
                  onChange={(e) => setJoinId(e.target.value)}
                  placeholder="Paste UUID..."
                  className="nx-input-glow block w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm font-mono text-white placeholder:text-zinc-600 placeholder:font-sans shadow-inner outline-none transition duration-200 hover:border-white/20"
                />
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/20 bg-white/5 hover:bg-emerald-500/10 hover:text-emerald-300 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition duration-200"
                >
                  Join Workspace
                  <ArrowRight size={16} />
                </button>
              </form>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
