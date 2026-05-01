import { create } from "zustand";
import type { GlossaryEntry, Segment, TranscribeResult } from "../lib/ipc";

export type TaskStage =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "correcting"
  | "correcting_paused"
  | "corrected"
  | "polishing"
  | "polished"
  | "error"
  | "cancelled";

export type Task = {
  id: string;
  audio: string;
  filename: string;
  stage: TaskStage;
  progress: { current: number; total: number; preview?: string };
  error?: string;
  result?: TranscribeResult;
  corrected?: { segments: Segment[]; changed: number; total: number; model: string; glossary?: GlossaryEntry[] };
  polished?: {
    text: string;
    model: string;
    source: "corrected" | "raw";
    truncated?: boolean;
    finish_reason?: string;
    input_chars?: number;
  };
  createdAt: number;
};

type TasksStore = {
  tasks: Task[];
  activeId: string | null;
  add: (audio: string) => string;
  setStage: (id: string, stage: TaskStage) => void;
  setProgress: (id: string, progress: Task["progress"]) => void;
  setResult: (id: string, result: TranscribeResult) => void;
  setCorrected: (id: string, corrected: Task["corrected"]) => void;
  setPolished: (id: string, polished: Task["polished"]) => void;
  setError: (id: string, error: string) => void;
  setActive: (id: string | null) => void;
  remove: (id: string) => void;
  clearAll: () => void;
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export const useTasks = create<TasksStore>((set) => ({
  tasks: [],
  activeId: null,

  add: (audio) => {
    const id = crypto.randomUUID();
    const task: Task = {
      id,
      audio,
      filename: basename(audio),
      stage: "queued",
      progress: { current: 0, total: 0 },
      createdAt: Date.now(),
    };
    set((s) => ({ tasks: [...s.tasks, task], activeId: s.activeId ?? id }));
    return id;
  },

  setStage: (id, stage) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, stage } : t)) })),

  setProgress: (id, progress) =>
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, progress } : t)) })),

  setResult: (id, result) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, result, stage: "transcribed" } : t)),
    })),

  setCorrected: (id, corrected) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, corrected, stage: "corrected" } : t)),
    })),

  setPolished: (id, polished) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, polished, stage: "polished" } : t)),
    })),

  setError: (id, error) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, error, stage: "error" } : t)),
    })),

  setActive: (id) => set({ activeId: id }),

  remove: (id) =>
    set((s) => {
      const tasks = s.tasks.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? tasks[0]?.id ?? null : s.activeId;
      return { tasks, activeId };
    }),

  clearAll: () => set({ tasks: [], activeId: null }),
}));
