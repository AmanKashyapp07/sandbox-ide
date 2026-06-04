import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, FileCode, FolderCode, FilePlus, FolderPlus, Trash2 } from 'lucide-react';

export interface AppFile {
  id: string;
  name: string;
  type: 'file' | 'directory';
  parent_id: string | null;
  language: string | null;
}

interface SidebarProps {
  files: AppFile[];
  activeFileId: string | null;
  onFileSelect: (file: AppFile) => void;
  onFileCreate: (name: string, type: 'file' | 'directory', language: string | null, parentId: string | null) => void;
  onFileDelete: (id: string) => void;
}

export default function Sidebar({ files, activeFileId, onFileSelect, onFileCreate, onFileDelete }: SidebarProps) {
  // Consolidated creation state for better control over inline inputs
  const [createState, setCreateState] = useState<{
    isCreating: boolean;
    type: 'file' | 'directory';
    parentId: string | null;
  } | null>(null);
  
  const [newFileName, setNewFileName] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when creation state activates
  useEffect(() => {
    if (createState?.isCreating) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [createState]);

  const fileTree = useMemo(() => {
    const nodesByParent = new Map<string | null, AppFile[]>();

    for (const file of files) {
      const parentKey = file.parent_id ?? null;
      const current = nodesByParent.get(parentKey) ?? [];
      current.push(file);
      nodesByParent.set(parentKey, current);
    }

    const sortNodes = (nodes: AppFile[]) =>
      [...nodes].sort((left, right) => {
        // Directories first, then files
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    const buildTree = (parentId: string | null): AppFile[] => sortNodes(nodesByParent.get(parentId) ?? []);

    return {
      rootNodes: buildTree(null),
      childrenFor: (parentId: string) => buildTree(parentId),
    };
  }, [files]);

  const handleCreateSubmit = () => {
    if (!newFileName.trim() || !createState) {
      cancelCreate();
      return;
    }

    let lang: string | null = null;
    if (createState.type === 'file') {
      lang = 'javascript'; // Default
      const nameLower = newFileName.toLowerCase();
      if (nameLower.endsWith('.py')) lang = 'python';
      else if (nameLower.endsWith('.cpp')) lang = 'cpp';
      else if (nameLower.endsWith('.ts') || nameLower.endsWith('.tsx')) lang = 'typescript';
      else if (nameLower.endsWith('.sh')) lang = 'bash';
      else if (nameLower.endsWith('.css')) lang = 'css';
      else if (nameLower.endsWith('.html')) lang = 'html';
    }

    onFileCreate(newFileName, createState.type, lang, createState.parentId);
    cancelCreate();
  };

  const cancelCreate = () => {
    setCreateState(null);
    setNewFileName('');
  };

  const openCreateForm = (type: 'file' | 'directory', parentId: string | null = null) => {
    setCreateState({ isCreating: true, type, parentId });
    setNewFileName('');
    
    // Auto-expand the target folder so the user can see the input box
    if (parentId) {
      setExpandedFolders((prev) => ({ ...prev, [parentId]: true }));
    }
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((current) => ({
      ...current,
      [folderId]: !current[folderId],
    }));
  };

  // Helper function to render the inline input 
  // (Defined as a standard function to prevent React from unmounting it on every keystroke)
  const renderInlineInput = (depth: number) => {
    const isFolder = createState?.type === 'directory';
    return (
      <div 
        className="flex items-center gap-1.5 py-1 pr-2"
        style={{ paddingLeft: `${depth * 16 + 24}px` }}
      >
        {isFolder ? (
          <FolderCode size={15} className="text-cyan-400/70" />
        ) : (
          <FileCode size={15} className="text-zinc-400" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreateSubmit();
            if (e.key === 'Escape') cancelCreate();
          }}
          onBlur={cancelCreate} // Hides input if user clicks away
          className="h-6 flex-1 rounded-[4px] border border-cyan-500/50 bg-black/40 px-1.5 text-[13px] text-zinc-200 outline-none focus:border-cyan-400 focus:bg-black/60"
        />
      </div>
    );
  };

  const renderNodes = (nodes: AppFile[], depth = 0) =>
    nodes.map((file) => {
      const isFolder = file.type === 'directory';
      const isExpanded = expandedFolders[file.id] ?? false;
      const childNodes = isFolder ? fileTree.childrenFor(file.id) : [];
      const hasChildren = childNodes.length > 0;
      const isCreatingInsideThisFolder = createState?.parentId === file.id;

      return (
        <div key={file.id} className="select-none">
          <div
            onClick={() => {
              if (isFolder) {
                toggleFolder(file.id);
              } else {
                onFileSelect(file);
              }
            }}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            className={`group relative flex h-[28px] cursor-pointer items-center justify-between pr-2 transition-colors ${
              activeFileId === file.id
                ? 'bg-cyan-500/10 text-cyan-300'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            {/* Active Indicator Line */}
            {activeFileId === file.id && (
              <span className="absolute left-0 top-0 h-full w-[2px] bg-cyan-400" />
            )}

            <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
              {isFolder ? (
                <button
                  type="button"
                  className="flex h-4 w-4 items-center justify-center text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="h-4 w-4" /> // Spacer for file alignment
              )}

              {isFolder ? (
                <FolderCode size={15} className={isExpanded ? 'text-cyan-400/80' : 'text-zinc-500 group-hover:text-cyan-400/60'} />
              ) : (
                <FileCode size={15} className={activeFileId === file.id ? 'text-cyan-300' : 'text-zinc-500 group-hover:text-zinc-400'} />
              )}
              <span className="truncate text-[13px] tracking-wide">{file.name}</span>
            </div>

            {/* Hover Actions */}
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {isFolder && (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openCreateForm('file', file.id);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                    title="New File"
                  >
                    <FilePlus size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openCreateForm('directory', file.id);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                    title="New Folder"
                  >
                    <FolderPlus size={13} />
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onFileDelete(file.id);
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-red-500/20 hover:text-red-400"
                title={isFolder ? 'Delete Folder' : 'Delete File'}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Render nested children OR the inline creation input if targeted */}
          {isFolder && (isExpanded || isCreatingInsideThisFolder) && (
            <div className="relative">
              {/* Optional VS Code style vertical guide line for deep nesting */}
              {depth > 0 && (
                <div 
                  className="absolute bottom-0 top-0 border-l border-white/5" 
                  style={{ left: `${depth * 16 + 11}px` }} 
                />
              )}
              
              {/* Render the inline input form AT THE TOP of the folder contents if creating here */}
              {isCreatingInsideThisFolder && renderInlineInput(depth + 1)}
              
              {/* Render the rest of the children */}
              {hasChildren && <div className="space-y-[1px]">{renderNodes(childNodes, depth + 1)}</div>}
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="flex h-full w-64 flex-col border-r border-white/5 bg-transparent">
      {/* Sidebar Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-zinc-500">Explorer</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => openCreateForm('file')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-cyan-300"
            title="New File at Root"
          >
            <FilePlus size={14} />
          </button>
          <button
            onClick={() => openCreateForm('directory')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-cyan-300"
            title="New Folder at Root"
          >
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {/* File Tree Container */}
      <div className="flex-1 space-y-[1px] overflow-y-auto py-2 outline-none">
        {/* Render Root Level Creation Input */}
        {createState?.parentId === null && renderInlineInput(0)}
        
        {/* Render Root Nodes */}
        {renderNodes(fileTree.rootNodes)}
      </div>
    </div>
  );
}