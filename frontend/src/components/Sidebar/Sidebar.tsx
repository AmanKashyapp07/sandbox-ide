import { useState } from 'react';
import { FileCode, Folder, Plus, Trash2, ChevronRight, ChevronDown } from 'lucide-react';

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

    // determine language from extension
    let lang = 'javascript';
    if (newFileName.endsWith('.py')) lang = 'python';
    else if (newFileName.endsWith('.cpp')) lang = 'cpp';
    else if (newFileName.endsWith('.sh')) lang = 'bash';

    onFileCreate(newFileName, 'file', lang);
    setNewFileName('');
    setIsCreating(false);
  };

  return (
    <div className="w-64 h-full bg-[#0d1117] border-r border-[#30363d] flex flex-col text-[#c9d1d9]">
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center justify-between">
        <span className="text-sm font-semibold text-[#c9d1d9]">EXPLORER</span>
        <button 
          onClick={() => setIsCreating(true)}
          className="text-[#8b949e] hover:text-white transition-colors"
          title="New File"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {isCreating && (
          <div className="px-4 py-1">
            <form onSubmit={handleCreate}>
              <input
                autoFocus
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onBlur={() => setIsCreating(false)}
                placeholder="filename.js"
                className="w-full bg-[#21262d] border border-[#30363d] text-[#c9d1d9] text-sm rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
              />
            </form>
          </div>
        )}

        {files.map(file => (
          <div 
            key={file.id}
            onClick={() => onFileSelect(file)}
            className={`group flex items-center justify-between px-4 py-1.5 cursor-pointer text-sm ${
              activeFileId === file.id ? 'bg-[#21262d] text-white' : 'text-[#8b949e] hover:bg-[#161b22] hover:text-[#c9d1d9]'
            }`}
          >
            <div className="flex items-center gap-2">
              <FileCode size={16} className={activeFileId === file.id ? 'text-[#58a6ff]' : 'text-[#8b949e]'} />
              <span>{file.name}</span>
            </div>
            
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFileDelete(file.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-[#8b949e] hover:text-[#ff7b72] transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
