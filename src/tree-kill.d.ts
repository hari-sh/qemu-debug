declare module 'tree-kill' { const kill: (pid: number, signal?: string, callback?: (error?: Error) => void) => void; export = kill; }
