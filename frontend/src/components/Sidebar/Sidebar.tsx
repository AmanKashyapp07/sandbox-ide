import { useState } from 'react';
import { FileCode, Plus, Trash2 } from 'lucide-react';

export interface AppFile {
  id: string;
  name: string;
  type: 'file' | 'directory';
  parent_id: string | null;
  language: string;
}

interface SidebarProps {
  files: AppFile[];
  activeFileId: string | null;
  onFileSelect: (file: AppFile) => void;
  onFileCreate: (name: string, type: 'file' | 'directory', language: string) => void;
  onFileDelete: (id: string) => void;
}

export default function Sidebar({ files, activeFileId, onFileSelect, onFileCreate, onFileDelete }: SidebarProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim()) return;

    let lang = 'javascript';
    if (newFileName.endsWith('.py')) lang = 'python';
    else if (newFileName.endsWith('.cpp')) lang = 'cpp';
    else if (newFileName.endsWith('.sh')) lang = 'bash';

    onFileCreate(newFileName, 'file', lang);
    setNewFileName('');
    setIsCreating(false);
  };

  return (
    <div className="w-64 h-full bg-zinc-950 border-r border-zinc-800 flex flex-col">
      <div className="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-400 tracking-wider uppercase">Explorer</span>
        <button 
          onClick={() => setIsCreating(true)}
          className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          title="New File"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {isCreating && (
          <div className="px-2 pb-2">
            <form onSubmit={handleCreate}>
              <input
                autoFocus
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onBlur={() => setIsCreating(false)}
                placeholder="filename.js"
                className="w-full bg-zinc-900 border border-indigo-500/50 text-zinc-200 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 shadow-sm transition-all"
              />
            </form>
          </div>
        )}

        {files.map(file => (
          <div 
            key={file.id}
            onClick={() => onFileSelect(file)}
            className={`group flex items-center justify-between px-3 py-2 cursor-pointer text-sm rounded-lg transition-colors ${
              activeFileId === file.id 
                ? 'bg-indigo-500/10 text-indigo-400 font-medium' 
                : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <FileCode size={16} className={activeFileId === file.id ? 'text-indigo-400' : 'text-zinc-500 group-hover:text-zinc-400'} />
              <span className="truncate">{file.name}</span>
            </div>
            
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileDelete(file.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-colors p-1 rounded-md hover:bg-red-500/10"
              title="Delete File"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}