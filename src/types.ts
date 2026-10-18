export type Mode = 'idle' | 'study' | 'paused' | 'break';
export interface StudySnapshot { mode: Mode; topic: string; elapsedMs: number; segment: number; rounds: number; chatReminderSent: boolean; taskElapsedMs: number }
export interface Settings {
  userName: string; deepseekUrl: string; deepseekModel: string; deepseekKey: string;
  mimoUrl: string; mimoModel: string; mimoKey: string; voice: string; voiceStyle: string;
  ttsEnabled: boolean; keepAwake: boolean; windowObservationEnabled: boolean; chatAlwaysOnTop: boolean;
}
export interface PublicSettings extends Omit<Settings, 'deepseekKey' | 'mimoKey'> { deepseekKey: string; mimoKey: string; hasDeepseekKey: boolean; hasMimoKey: boolean }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'notice'; text: string; createdAt?: number; pending?: boolean; failed?: boolean; cancelled?: boolean }
export interface MessageChange { action: 'edit' | 'delete' | 'regenerate'; id: string; expectedText: string; text?: string }
export interface ChatReference { avatar: string; fileName: string }
export interface ArchivedSegment { id: string; number: number; topic: string; startedAt: number; endedAt?: number; durationMs: number; chat: ChatReference }
export interface ArchivedTask { id: string; title: string; kind: 'study' | 'free' | 'legacy'; imported?: boolean; startedAt: number; endedAt?: number; segments: ArchivedSegment[] }
export interface TaskSummary extends Omit<ArchivedTask, 'segments'> { segmentCount: number; durationMs: number }
export interface SegmentHistory { taskId: string; taskTitle: string; segment: ArchivedSegment; messages: ChatMessage[] }
export interface ArchiveSummary { revision: number; taskCount: number; activeTaskId?: string; activeSegmentId?: string }
export interface WindowInfo { processId: number; windowHandle: string; observedAt: number; processName: string | null; executablePath: string | null; appName: string | null; title: string; isOwnApp: boolean }
export interface ForegroundObservation { status: 'inactive' | 'disabled' | 'locked' | 'starting' | 'active' | 'unavailable' | 'error' | 'unsupported'; current: WindowInfo | null; lastExternal: WindowInfo | null }
export interface AppState { study: StudySnapshot; settings: PublicSettings; messages: ChatMessage[]; busy: boolean; configuring: boolean; speaking: boolean; connection: string; tavernReady: boolean; character: string; bookEntries: number; foreground: ForegroundObservation; persistence: import('./persistence').SaveStatus; view: 'chat' | 'dashboard'; archive: ArchiveSummary; exitWarning?: string; error?: string }
export interface FriendAPI {
  getState(): Promise<AppState>;
  send(text: string): Promise<void>;
  pinChat(pinned: boolean): Promise<void>;
  changeMessage(change: MessageChange): Promise<void>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(id: string): Promise<ArchivedTask>;
  getSegment(taskId: string, segmentId: string): Promise<SegmentHistory>;
  control(action: 'start' | 'end' | 'pause' | 'resume' | 'finish', topic?: string): Promise<void>;
  saveSettings(settings: Partial<Settings>): Promise<void>;
  action(action: 'hide' | 'quit' | 'tavern' | 'chat' | 'dashboard' | 'compact' | 'stop-audio' | 'stop-generation' | 'restart-tavern' | 'retry-save' | 'force-quit'): Promise<void>;
  movePet(x: number, y: number): void;
  audioStatus(id: string, playing: boolean): void;
  onState(callback: (state: AppState) => void): () => void;
  onAudio(callback: (audio: { id: string; data: string } | null) => void): () => void;
}
declare global { interface Window { friend: FriendAPI } }
